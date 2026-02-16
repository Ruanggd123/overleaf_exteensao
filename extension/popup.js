// popup.js - Firebase Auth e Sistema de Assinaturas (Compat Version)

// ═════════════════════════════════════════════════════════════════
//  CONFIGURAÇÃO FIREBASE (PLACEHOLDERS)
// ═════════════════════════════════════════════════════════════════

const firebaseConfig = {
    apiKey: "AIzaSyChPjBPB22ozjA5X9CYn7gkprLHM68TT7g",
    authDomain: "extensao-asdsadas1q.firebaseapp.com",
    projectId: "extensao-asdsadas1q",
    storageBucket: "extensao-asdsadas1q.firebasestorage.app",
    messagingSenderId: "1034240483206",
    appId: "1:1034240483206:web:97da5c893f6c646b18d607",
    measurementId: "G-8MEMV5HNM6"
};

const DEFAULT_API_URL = 'http://localhost:8765/api';
let API_BASE_URL = DEFAULT_API_URL;

// Load config
chrome.storage.local.get(['apiUrl'], (result) => {
    if (result.apiUrl) API_BASE_URL = result.apiUrl;
});

// ═════════════════════════════════════════════════════════════════
//  INICIALIZAÇÃO
// ═════════════════════════════════════════════════════════════════

// Initialize Firebase using global Compat namespace
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let currentUser = null;
let hardwareId = null;

// ═════════════════════════════════════════════════════════════════
//  HARDWARE FINGERPRINT (Anti-burla)
// ═════════════════════════════════════════════════════════════════

async function generateHardwareId() {
    const components = [
        navigator.userAgent,
        navigator.language,
        navigator.platform,
        screen.width + 'x' + screen.height,
        screen.colorDepth,
        new Date().getTimezoneOffset(),
        !!window.sessionStorage,
        !!window.localStorage,
        navigator.hardwareConcurrency || 'unknown',
        navigator.deviceMemory || 'unknown'
    ];

    const str = components.join('|||');
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ═════════════════════════════════════════════════════════════════
//  UI HELPERS
// ═════════════════════════════════════════════════════════════════

function showState(stateName) {
    document.querySelectorAll('.state').forEach(s => s.classList.remove('active'));
    document.getElementById(`state-${stateName}`).classList.add('active');
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ═════════════════════════════════════════════════════════════════
//  AUTENTICAÇÃO
// ═════════════════════════════════════════════════════════════════

async function signInWithGoogle() {
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        const result = await auth.signInWithPopup(provider);
        await syncUserWithBackend(result.user);
    } catch (error) {
        console.error('Google sign in error:', error);
        showToast('Erro ao fazer login com Google: ' + error.message, 'error');
    }
}

async function signInAnonymous() {
    try {
        const result = await auth.signInAnonymously();
        await syncUserWithBackend(result.user);
    } catch (error) {
        console.error('Anonymous sign in error:', error);
        showToast('Erro ao criar conta anônima: ' + error.message, 'error');
    }
}

async function syncUserWithBackend(firebaseUser) {
    try {
        const token = await firebaseUser.getIdToken();
        // Save token to chrome storage for content script use
        chrome.storage.local.set({ authToken: token });

        hardwareId = await generateHardwareId();

        try {
            const response = await fetch(`${API_BASE_URL}/auth/sync`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    hardwareId,
                    deviceInfo: {
                        userAgent: navigator.userAgent,
                        platform: navigator.platform,
                        screen: `${screen.width}x${screen.height}`
                    }
                })
            });

            if (!response.ok) {
                // If 404/500, maybe functions not deployed yet? proceed carefully
                console.warn('Backend sync failed, possibly not deployed');
            } else {
                const data = await response.json();
                if (data.isNew) {
                    showToast(`Bem-vindo! Trial de 24h ativado.`, 'success');
                }
            }
        } catch (e) {
            console.error("Backend unreachable", e);
        }

        await loadUserData();

    } catch (error) {
        console.error('Sync error:', error);
        showToast(error.message, 'error');
    }
}

async function handleLogout() {
    try {
        await auth.signOut();
        chrome.storage.local.remove('authToken');
        currentUser = null;
        showState('login');
        showToast('Você saiu da conta', 'info');
    } catch (error) {
        showToast('Erro ao sair', 'error');
    }
}

// ═════════════════════════════════════════════════════════════════
//  DADOS DO USUÁRIO E DASHBOARD
// ═════════════════════════════════════════════════════════════════

async function loadUserData() {
    if (!currentUser) return;

    try {
        const token = await currentUser.getIdToken();
        // re-save token
        chrome.storage.local.set({ authToken: token });

        const response = await fetch(`${API_BASE_URL}/user/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        let data;
        if (!response.ok) {
            // Mock data if backend fails (dev mode)
            data = {
                user: { email: currentUser.email || 'anonimo@user' },
                subscription: {
                    plan: 'free',
                    dailyLimit: 5,
                    dailyUsed: 0,
                    status: 'active'
                }
            };
        } else {
            data = await response.json();
        }

        updateDashboard(data);
        showState('dashboard');

    } catch (error) {
        console.error('Load user data error:', error);
        showToast('Erro ao carregar dados', 'error');
    }
}

function updateDashboard(data) {
    const { user, subscription } = data;

    // User info
    const email = user.email || 'anônimo';
    document.getElementById('user-name').textContent = email.split('@')[0];
    document.getElementById('user-email').textContent = email;
    document.getElementById('user-avatar').textContent = email[0].toUpperCase();

    // Plan badge
    const badge = document.getElementById('plan-badge');
    badge.textContent = subscription.plan;
    badge.className = `plan-badge plan-${subscription.plan}`;

    // Usage
    const percent = (subscription.dailyUsed / subscription.dailyLimit) * 100;
    document.getElementById('usage-text').textContent =
        `${subscription.dailyUsed} / ${subscription.dailyLimit}`;
    document.getElementById('usage-bar').style.width = `${Math.min(percent, 100)}%`;

    if (percent > 90) document.getElementById('usage-bar').classList.add('danger');
    else if (percent > 70) document.getElementById('usage-bar').classList.add('warning');

    // Plans visibility
    if (['pro', 'unlimited'].includes(subscription.plan)) {
        document.getElementById('plans-section').style.display = 'none';
    }
}

// ═════════════════════════════════════════════════════════════════
//  SISTEMA DE "COMPRA"
// ═════════════════════════════════════════════════════════════════

async function purchasePlan(plan) {
    if (!currentUser) return;

    try {
        const token = await currentUser.getIdToken();
        showToast(`Ativando plano ${plan}...`, 'info');

        const response = await fetch(`${API_BASE_URL}/subscription/purchase`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                plan: plan,
                durationDays: 30
            })
        });

        if (!response.ok) throw new Error('Falha na compra');

        const data = await response.json();
        showToast(`🎉 ${data.message}`, 'success');
        await loadUserData();

    } catch (error) {
        console.error('Purchase error:', error);
        showToast(error.message, 'error');
    }
}

// ═════════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // Auth observer
    auth.onAuthStateChanged((user) => {
        if (user) {
            currentUser = user;
            loadUserData();
        } else {
            showState('login');
        }
    });

    document.getElementById('btn-google').addEventListener('click', signInWithGoogle);
    document.getElementById('btn-email-anon').addEventListener('click', signInAnonymous);
    document.getElementById('btn-logout').addEventListener('click', handleLogout);

    document.querySelectorAll('.plan-card').forEach(card => {
        card.addEventListener('click', () => {
            const plan = card.dataset.plan;
            const price = card.dataset.price;
            if (confirm(`Ativar plano ${plan.toUpperCase()} por R$${price}?`)) {
                purchasePlan(plan);
            }
        });
    });

    // Settings Handler
    const btnSettings = document.getElementById('btn-settings-toggle');
    const settingsPanel = document.getElementById('settings-panel');
    const inputUrl = document.getElementById('input-api-url');
    const btnSave = document.getElementById('btn-save-settings');

    if (btnSettings) {
        btnSettings.addEventListener('click', () => {
            settingsPanel.classList.toggle('hidden');
            inputUrl.value = API_BASE_URL;
        });

        btnSave.addEventListener('click', () => {
            const url = inputUrl.value.trim().replace(/\/$/, ''); // Remove trailing slash
            if (url) {
                API_BASE_URL = url;
                chrome.storage.local.set({ apiUrl: url }, () => {
                    showToast('URL salva! Recarregue a extensão.', 'success');
                    setTimeout(() => location.reload(), 1000);
                });
            }
        });
    }
});
