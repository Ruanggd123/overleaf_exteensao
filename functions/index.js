const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

admin.initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '50mb' }));

// Planos disponíveis
const PLANS = {
    free: { compilationsPerDay: 5, name: 'Gratuito', price: 0 },
    basic: { compilationsPerDay: 50, name: 'Básico', price: 9.90 },
    pro: { compilationsPerDay: 500, name: 'Profissional', price: 29.90 },
    unlimited: { compilationsPerDay: 999999, name: 'Ilimitado', price: 99.90 }
};

// Middleware de autenticação
const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token não fornecido' });
        }

        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Token inválido' });
    }
};

// ═════════════════════════════════════════════════════════════════
//  ENDPOINTS DE AUTENTICAÇÃO E USUÁRIO
// ═════════════════════════════════════════════════════════════════

// Verificar/criar usuário no Firestore após registro no Auth
app.post('/auth/sync', authenticate, async (req, res) => {
    try {
        const { uid, email } = req.user;
        const { hardwareId, deviceInfo } = req.body;

        const userRef = admin.firestore().collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            // Criar novo usuário
            await userRef.set({
                email,
                plan: 'free',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastLogin: admin.firestore.FieldValue.serverTimestamp(),
                isActive: true,
                hardwareFingerprint: hardwareId || null
            });

            // Criar assinatura gratuita inicial (1 dia apenas)
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 1); // 1 dia grátis

            await admin.firestore().collection('subscriptions').add({
                userId: uid,
                plan: 'free',
                status: 'active',
                startedAt: admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
                isTrial: true,
                autoRenew: false
            });

            // Registrar dispositivo
            if (hardwareId) {
                await userRef.collection('devices').doc(hardwareId).set({
                    deviceInfo,
                    firstSeen: admin.firestore.FieldValue.serverTimestamp(),
                    lastSeen: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            res.json({
                message: 'Usuário criado',
                isNew: true,
                trialEndsAt: expiresAt.toISOString()
            });
        } else {
            // Atualizar login e dispositivo
            await userRef.update({
                lastLogin: admin.firestore.FieldValue.serverTimestamp()
            });

            if (hardwareId) {
                await userRef.collection('devices').doc(hardwareId).set({
                    deviceInfo,
                    lastSeen: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            }

            // Verificar assinatura atual
            const subSnapshot = await admin.firestore()
                .collection('subscriptions')
                .where('userId', '==', uid)
                .where('status', '==', 'active')
                .orderBy('expiresAt', 'desc')
                .limit(1)
                .get();

            let subscription = null;
            if (!subSnapshot.empty) {
                const sub = subSnapshot.docs[0].data();
                subscription = {
                    plan: sub.plan,
                    expiresAt: sub.expiresAt?.toDate()?.toISOString(),
                    status: sub.status
                };
            }

            res.json({
                message: 'Usuário atualizado',
                isNew: false,
                subscription
            });
        }
    } catch (error) {
        console.error('Auth sync error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Obter dados do usuário atual
app.get('/user/me', authenticate, async (req, res) => {
    try {
        const { uid } = req.user;

        const userDoc = await admin.firestore().collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const userData = userDoc.data();

        // Buscar assinatura ativa
        const subSnapshot = await admin.firestore()
            .collection('subscriptions')
            .where('userId', '==', uid)
            .where('status', '==', 'active')
            .orderBy('expiresAt', 'desc')
            .limit(1)
            .get();

        let subscription = { plan: 'free', status: 'expired' };
        if (!subSnapshot.empty) {
            const sub = subSnapshot.docs[0].data();
            subscription = {
                id: subSnapshot.docs[0].id,
                plan: sub.plan,
                planName: PLANS[sub.plan]?.name || 'Gratuito',
                status: sub.status,
                expiresAt: sub.expiresAt?.toDate()?.toISOString(),
                isTrial: sub.isTrial || false
            };
        }

        // Verificar uso de hoje
        const today = new Date().toISOString().split('T')[0];
        const usageDoc = await admin.firestore()
            .collection('dailyUsage')
            .doc(`${uid}_${today}`)
            .get();

        const usage = usageDoc.exists ? usageDoc.data() : { count: 0 };
        const limit = PLANS[subscription.plan]?.compilationsPerDay || 5;

        res.json({
            user: {
                id: uid,
                email: userData.email,
                createdAt: userData.createdAt?.toDate()?.toISOString()
            },
            subscription: {
                ...subscription,
                dailyLimit: limit,
                dailyUsed: usage.count || 0,
                dailyRemaining: Math.max(0, limit - (usage.count || 0))
            }
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═════════════════════════════════════════════════════════════════
//  SISTEMA DE "COMPRA" SIMULADA (1 CLIQUE = UPGRADE)
//  Em produção, substituir por integração real com Stripe/PayPal
// ═════════════════════════════════════════════════════════════════

app.post('/subscription/purchase', authenticate, async (req, res) => {
    try {
        const { uid } = req.user;
        const { plan = 'pro', durationDays = 30 } = req.body;

        if (!PLANS[plan]) {
            return res.status(400).json({ error: 'Plano inválido' });
        }

        // SIMULAÇÃO: Em produção, em vez de ativar direto, integraria com Stripe

        // Desativar assinaturas anteriores
        const existingSubs = await admin.firestore()
            .collection('subscriptions')
            .where('userId', '==', uid)
            .where('status', '==', 'active')
            .get();

        const batch = admin.firestore().batch();
        existingSubs.forEach(doc => {
            batch.update(doc.ref, { status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
        });

        // Criar nova assinatura
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + durationDays);

        const newSubRef = admin.firestore().collection('subscriptions').doc();
        batch.set(newSubRef, {
            userId: uid,
            plan: plan,
            status: 'active',
            startedAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
            isTrial: false,
            autoRenew: false,
            paymentMethod: 'simulated',
            simulatedPurchase: true
        });

        // Atualizar usuário
        const userRef = admin.firestore().collection('users').doc(uid);
        batch.update(userRef, { plan: plan });

        await batch.commit();

        res.json({
            success: true,
            message: `Plano ${PLANS[plan].name} ativado!`,
            subscription: {
                plan: plan,
                planName: PLANS[plan].name,
                expiresAt: expiresAt.toISOString(),
                dailyLimit: PLANS[plan].compilationsPerDay
            }
        });
    } catch (error) {
        console.error('Purchase error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═════════════════════════════════════════════════════════════════
//  COMPILAÇÃO LATEX (Protegido por Assinatura)
// ═════════════════════════════════════════════════════════════════

app.post('/compile', authenticate, async (req, res) => {
    try {
        const { uid } = req.user;
        const { files, mainFile, engine = 'pdflatex' } = req.body;

        // Verificar assinatura e limites
        const checkResult = await checkCompilationPermission(uid);
        if (!checkResult.allowed) {
            return res.status(403).json({
                error: checkResult.error,
                code: checkResult.code,
                subscription: checkResult.subscription
            });
        }

        // Registrar uso
        await incrementDailyUsage(uid);

        // Aqui você teria duas opções:
        // 1. Compilar localmente se tiver servidor LaTeX instalado na function (difícil no Firebase)
        // 2. Encaminhar para um servidor externo (VPS ou API)

        res.json({
            success: true,
            message: 'Compilação autorizada - MOCK',
            mock: true,
            remaining: checkResult.remaining - 1
        });

    } catch (error) {
        console.error('Compile error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Verificar permissão de compilação
async function checkCompilationPermission(uid) {
    const today = new Date().toISOString().split('T')[0];

    // Buscar assinatura ativa
    const subSnapshot = await admin.firestore()
        .collection('subscriptions')
        .where('userId', '==', uid)
        .where('status', '==', 'active')
        .where('expiresAt', '>', admin.firestore.Timestamp.now())
        .orderBy('expiresAt', 'desc')
        .limit(1)
        .get();

    if (subSnapshot.empty) {
        return {
            allowed: false,
            code: 'NO_SUBSCRIPTION',
            error: 'Assinatura expirada ou inexistente. Renove sua assinatura.'
        };
    }

    const sub = subSnapshot.docs[0].data();
    const plan = PLANS[sub.plan] || PLANS.free;

    // Verificar uso diário
    const usageDoc = await admin.firestore()
        .collection('dailyUsage')
        .doc(`${uid}_${today}`)
        .get();

    const used = usageDoc.exists ? usageDoc.data().count : 0;

    if (used >= plan.compilationsPerDay) {
        return {
            allowed: false,
            code: 'DAILY_LIMIT',
            error: `Limite diário de ${plan.compilationsPerDay} compilações atingido.`,
            subscription: {
                plan: sub.plan,
                dailyLimit: plan.compilationsPerDay,
                dailyUsed: used
            }
        };
    }

    return {
        allowed: true,
        plan: sub.plan,
        remaining: plan.compilationsPerDay - used
    };
}

async function incrementDailyUsage(uid) {
    const today = new Date().toISOString().split('T')[0];
    const docRef = admin.firestore().collection('dailyUsage').doc(`${uid}_${today}`);

    await docRef.set({
        userId: uid,
        date: today,
        count: admin.firestore.FieldValue.increment(1),
        lastUsed: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

// ═════════════════════════════════════════════════════════════════
//  SISTEMA ANTI-BURLA (Hardware Fingerprint)
// ═════════════════════════════════════════════════════════════════

app.post('/security/verify-device', authenticate, async (req, res) => {
    try {
        const { uid } = req.user;
        const { hardwareId, deviceInfo } = req.body;

        if (!hardwareId) {
            return res.status(400).json({ error: 'Hardware ID necessário' });
        }

        // Verificar se este hardware já está associado a outro usuário
        const devicesSnapshot = await admin.firestore()
            .collectionGroup('devices')
            .where(admin.firestore.FieldPath.documentId(), '==', hardwareId)
            .get();

        let isNewDevice = true;
        let associatedUser = null;

        devicesSnapshot.forEach(doc => {
            const userId = doc.ref.parent.parent.id;
            if (userId !== uid) {
                associatedUser = userId;
            } else {
                isNewDevice = false;
                // Se for o mesmo usuário, ok
            }
        });

        if (associatedUser) {
            return res.status(403).json({
                error: 'Dispositivo já associado a outra conta',
                code: 'DEVICE_BLOCKED',
                message: 'Este dispositivo já foi usado em outra conta. Contate suporte se necessário.'
            });
        }

        // Registrar/atualizar dispositivo
        const deviceRef = admin.firestore()
            .collection('users')
            .doc(uid)
            .collection('devices')
            .doc(hardwareId);

        await deviceRef.set({
            ...deviceInfo,
            lastSeen: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.json({
            verified: true,
            isNewDevice,
            message: isNewDevice ? 'Novo dispositivo registrado' : 'Dispositivo reconhecido'
        });

    } catch (error) {
        console.error('Device verification error:', error);
        res.status(500).json({ error: error.message });
    }
});

exports.api = functions.https.onRequest(app);

exports.onUserCreated = functions.auth.user().onCreate(async (user) => {
    console.log('Novo usuário criado:', user.uid);
});
