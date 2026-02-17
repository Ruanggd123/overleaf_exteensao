// content.js - Integração com Overleaf e Firebase

(() => {
    // Prevent double injection
    if (window.OLC_INITIALIZED) return;
    window.OLC_INITIALIZED = true;

    // Initialize Firebase (Compat)
    const firebaseConfig = {
        apiKey: "AIzaSyChPjBPB22ozjA5X9CYn7gkprLHM68TT7g",
        authDomain: "extensao-asdsadas1q.firebaseapp.com",
        projectId: "extensao-asdsadas1q",
        storageBucket: "extensao-asdsadas1q.firebasestorage.app",
        messagingSenderId: "1034240483206",
        appId: "1:1034240483206:web:97da5c893f6c646b18d607",
        measurementId: "G-8MEMV5HNM6"
    };

    try {
        if (typeof firebase !== 'undefined' && !firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
            console.log('[OLC] Firebase initialized in content script');
        } else if (typeof firebase === 'undefined') {
            console.warn('[OLC] Firebase SDK not loaded in content script. Check manifest.');
        }
    } catch (e) {
        console.error('[OLC] Firebase init error:', e);
    }

    // Check if firebase loaded
    if (typeof firebase === 'undefined') {
        console.error('[OLC] Firebase SDK not loaded');
        return;
    }

    const auth = firebase.auth();
    // const db = firebase.firestore(); // valid if needed

    class OverleafCloudCompiler {
        constructor() {
            this.defaultApiUrl = 'https://meu-latex-server.onrender.com/api';
            this.apiUrl = this.defaultApiUrl;
            this.init();
            console.log('[OLC] Cloud Compiler initialized');
        }

        async init() {
            // Sync auth state and settings
            chrome.storage.local.get(['authToken', 'apiUrl'], async (result) => {
                this.authToken = result.authToken;
                if (result.apiUrl && !result.apiUrl.includes('localhost')) {
                    this.apiUrl = result.apiUrl;
                } else if (result.apiUrl && result.apiUrl.includes('localhost')) {
                    console.warn('[OLC] Ignoring localhost config from storage, using default cloud URL.');
                    // Optional: clear it
                    chrome.storage.local.remove('apiUrl');
                }

                console.log('[OLC] Using API:', this.apiUrl);

                if (this.authToken) {
                    // Check subscription
                    const hasAccess = await this.checkSubscription();
                    if (hasAccess) {
                        this.injectCompilerUI();
                    } else {
                        console.log('[OLC] Subscription required or expired');
                        this.injectCompilerUI(true); // Inject with lock
                    }
                } else {
                    console.log('[OLC] Not logged in');
                    this.injectCompilerUI(true);
                }
            });

            // Listen for storage changes (login/logout in popup)
            chrome.storage.onChanged.addListener((changes, namespace) => {
                if (namespace === 'local' && changes.authToken) {
                    console.log('[OLC] Auth token changed, reloading page...');
                    location.reload();
                }
            });
        }

        async checkSubscription() {
            try {
                // We use the LOCAL SERVER to proxy the check or check directly if we had custom claims
                // But since we have a python server, let's hit it.

                console.log('[OLC] Checking subscription via:', `${this.apiUrl}/user/me`);

                const response = await fetch(`${this.apiUrl}/user/me`, {
                    headers: { 'Authorization': `Bearer ${this.authToken}` }
                });

                if (!response.ok) {
                    console.error('[OLC] Subscription check failed with status:', response.status);
                    if (response.status === 401) console.error('[OLC] Token invalid or expired');
                    if (response.status === 403) console.error('[OLC] Forbidden access');
                    return false;
                }

                const data = await response.json();
                console.log('[OLC] Subscription data:', data);

                if (data.subscription && data.subscription.dailyRemaining > 0) {
                    return true;
                } else {
                    console.warn('[OLC] Subscription valid but daily limit reached or plan expired', data);
                    return false;
                }
            } catch (error) {
                console.error('[OLC] Check subscription failed (Network/Catch):', error);
                return false;
            }
        }

        injectCompilerUI(locked = false) {
            // Find toolbar - Overleaf structure changes, so we need robust selector
            const toolbar = document.querySelector('.toolbar-pdf') || document.querySelector('.toolbar-header-right');
            if (!toolbar) return;

            // Remove existing button if any to avoid duplicates/stale state
            const existingBtn = document.getElementById('olc-cloud-btn');
            if (existingBtn) existingBtn.remove();

            const btn = document.createElement('button');
            btn.id = 'olc-cloud-btn';
            btn.className = 'btn btn-primary';
            btn.style.marginLeft = '10px';
            btn.style.height = '100%';
            btn.innerHTML = locked ? '🔒 Login Extensão' : '⚡ Cloud Compile';

            btn.onclick = async () => {
                if (locked) {
                    btn.innerHTML = '🔄 Verificando...';
                    btn.disabled = true;

                    // Force refresh auth token from storage
                    const result = await new Promise(r => chrome.storage.local.get(['authToken'], r));
                    this.authToken = result.authToken;

                    if (!this.authToken) {
                        alert('Você não está logado na extensão.\n\n1. Abra a extensão (clique no ícone 📄).\n2. Faça login.\n3. Tente novamente.');
                        btn.innerHTML = '🔒 Login Extensão';
                        btn.disabled = false;
                        return;
                    }

                    const hasAccess = await this.checkSubscription();
                    if (hasAccess) {
                        // Unlock and compile!
                        btn.innerHTML = '⚡ Cloud Compile';
                        btn.disabled = false;
                        locked = false; // Persistent unlock for this session
                        this.compile();
                    } else {
                        alert('Assinatura não encontrada ou expirada.\nVerifique seu status na extensão.');
                        btn.innerHTML = '🔒 Login Extensão';
                        btn.disabled = false;
                    }
                } else {
                    this.compile();
                }
            };

            // Insert at beginning or end
            toolbar.insertBefore(btn, toolbar.firstChild);
        }

        async extractFiles() {
            // Simple extraction for now - relying on user to zip or sending main file text
            // In a real scenario, we might need to use Overleaf's internal API or just scrape the editor content
            // Capturing the current editor content:
            let content = "";

            // Try ACE editor (old)
            if (window.ace) {
                const editor = window.ace.edit("editor");
                content = editor.getValue();
            }
            // Try CodeMirror (new/source)
            else if (document.querySelector('.cm-content')) {
                content = document.querySelector('.cm-content').innerText;
            }
            // Fallback: just a mock if we can't grab it easily without more permissions
            else {
                content = "% Could not grab editor content automatically.\n% Please ensure you are in the Source editor.";
            }

            return {
                "main.tex": content
            };
        }

        async compile() {
            const btn = document.getElementById('olc-cloud-btn');
            const originalText = btn.innerHTML;
            btn.innerHTML = '⏳ Enviando...';
            btn.disabled = true;

            try {
                const files = await this.extractFiles();

                const response = await fetch(`${this.apiUrl}/compile`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.authToken}`
                    },
                    body: JSON.stringify({
                        files,
                        mainFile: 'main.tex',
                        engine: 'pdflatex'
                    })
                });

                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    throw new Error(error.error || error.logs || 'Server error');
                }

                // const data = await response.json(); // It returns a PDF blob, not JSON unless error
                // The server returns raw PDF bytes usually
                const blob = await response.blob();

                // Check if it's actually a JSON error hidden as blob
                if (blob.type === 'application/json') {
                    const text = await blob.text();
                    const json = JSON.parse(text);
                    throw new Error(json.error || 'Unknown error');
                }

                this.showPdf(blob);

            } catch (error) {
                console.error(error);
                alert('Erro na compilação:\n' + error.message.slice(0, 500));
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        }

        showPdf(blob) {
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
        }
    }

    // Start
    setTimeout(() => {
        new OverleafCloudCompiler();
    }, 2000);

})();
