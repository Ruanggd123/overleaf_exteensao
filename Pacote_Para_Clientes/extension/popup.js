// popup.js - Firebase Auth e Sistema de Assinaturas (Compat Version)
(() => {
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

    // Initial Connection Check with Timeout
    function checkServerConnection() {
        const statusDot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');

        statusText.textContent = 'Verificando...';
        statusDot.className = 'status-dot checking';

        // Timeout logic - increased to 5s for Render cold start
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        // Use /status endpoint which we need to ensure exists, or just root if it returns 200 OK
        fetch(`${API_BASE_URL}/status`, { signal: controller.signal })
            .then(response => {
                clearTimeout(timeoutId);
                if (response.ok) {
                    return response.json().catch(() => ({})); // Handle if not json
                } else {
                    throw new Error('Server error: ' + response.status);
                }
            })
            .then(data => {
                statusDot.className = 'status-dot online';
                statusText.textContent = 'Online';
                // Enable login checks
                // Ensure auth is initialized before using it
                if (firebase.auth().currentUser) loadUserData();
            })
            .catch(error => {
                console.warn('Connection failed:', error);
                clearTimeout(timeoutId);
                statusDot.className = 'status-dot'; // Red by default css
                statusText.innerHTML = 'Offline <button id="btn-retry" style="margin-left:5px; padding:2px 6px; font-size:10px; cursor:pointer;">↻</button>';
                document.getElementById('btn-retry')?.addEventListener('click', () => {
                    statusText.textContent = 'Reconectando...';
                    checkServerConnection();
                });
            });
    }

    // ═════════════════════════════════════════════════════════════════
    //  INICIALIZAÇÃO
    // ═════════════════════════════════════════════════════════════════

    // Initialize Firebase using global Compat namespace
    // Check if initialized
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }
    const auth = firebase.auth();
    const db = firebase.database();

    let currentUser = null;
    let hardwareId = null;

    // Remaining logic...
    // (I will selectively replace the top part to wrap in IIFE and include the rest)
    // Wait, replacing the WHOLE file is safer to ensure closure.
    // Specifying the whole content here...

    // ... [Copying the rest of the file logic properly] ...

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
    //  AUTENTICAÇÃO (EMAIL/SENHA)
    // ═════════════════════════════════════════════════════════════════

    async function signInWithEmail() {
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const btnLogin = document.getElementById('btn-login');

        if (!email || !password) {
            showToast('Preencha email e senha', 'error');
            return;
        }

        try {
            btnLogin.textContent = 'Entrando...';
            btnLogin.disabled = true;

            const result = await auth.signInWithEmailAndPassword(email, password);
            await syncUserWithBackend(result.user);

            showToast('Login realizado!', 'success');
        } catch (error) {
            console.error('Login error:', error);
            let msg = 'Erro ao entrar.';
            if (error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found') msg = 'Email ou senha incorretos.';
            if (error.code === 'auth/invalid-email') msg = 'Email inválido.';
            showToast(msg, 'error');
        } finally {
            btnLogin.textContent = 'Entrar';
            btnLogin.disabled = false;
        }
    }

    function openRegisterPage() {
        // Opens the server hosted registration page
        chrome.tabs.create({ url: `${API_BASE_URL.replace('/api', '')}/register` });
    }


    async function syncUserWithBackend(firebaseUser) {
        try {
            const token = await firebaseUser.getIdToken();
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
            chrome.storage.local.set({ authToken: token });

            const userRef = db.ref(`users/${currentUser.uid}`);

            userRef.on('value', (snapshot) => {
                const data = snapshot.val();
                if (data && data.subscription) {
                    updateDashboardFromRealtime(data);
                }
            });

            chrome.storage.local.get(['isActive'], (result) => {
                const toggle = document.getElementById('ext-toggle');
                if (toggle) toggle.checked = result.isActive !== false;
            });

            showState('dashboard');

        } catch (error) {
            console.error('Load user data error:', error);
            showToast('Erro ao carregar dados', 'error');
        }
    }

    function updateDashboardFromRealtime(data) {
        const { subscription } = data;
        const email = currentUser.email;

        document.getElementById('user-name').textContent = email.split('@')[0];
        document.getElementById('user-email').textContent = email;
        document.getElementById('user-avatar').textContent = email[0].toUpperCase();

        const badge = document.getElementById('plan-badge');
        badge.textContent = subscription.plan;
        badge.className = `plan-badge plan-${subscription.plan}`;

        if (subscription.expiresAt) {
            const expires = new Date(subscription.expiresAt);
            const now = new Date();
            const diffTime = Math.abs(expires - now);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            document.getElementById('usage-text').textContent = `${diffDays} dias restantes`;
            document.getElementById('usage-bar').style.width = '100%';
        }

        if (['pro', 'unlimited'].includes(subscription.plan)) {
            document.getElementById('plans-section').style.display = 'none';
        } else {
            document.getElementById('plans-section').style.display = 'block';
        }
    }

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
        checkServerConnection();

        auth.onAuthStateChanged((user) => {
            if (user) {
                currentUser = user;
                loadUserData();
            } else {
                showState('login');
            }
        });

        document.getElementById('btn-login').addEventListener('click', signInWithEmail);
        document.getElementById('link-register').addEventListener('click', (e) => {
            e.preventDefault();
            openRegisterPage();
        });

        const toggle = document.getElementById('ext-toggle');
        if (toggle) {
            toggle.addEventListener('change', (e) => {
                const isActive = e.target.checked;
                chrome.storage.local.set({ isActive: isActive }, () => {
                    showToast(isActive ? 'Extensão Ativada' : 'Extensão Desativada', isActive ? 'success' : 'info');
                });
            });
        }
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
                const url = inputUrl.value.trim().replace(/\/$/, '');
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

})(); // End IIFE
