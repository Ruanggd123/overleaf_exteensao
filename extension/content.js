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
            // Find toolbar
            const toolbar = document.querySelector('.toolbar-pdf') || document.querySelector('.toolbar-header-right');
            if (!toolbar) return;

            // Remove existing buttons/container
            const existingContainer = document.getElementById('olc-btn-group');
            if (existingContainer) existingContainer.remove();
            const existingBtn = document.getElementById('olc-cloud-btn'); // Legacy cleanup
            if (existingBtn) existingBtn.remove();

            // Create Container
            const container = document.createElement('div');
            container.id = 'olc-btn-group';
            container.style.display = 'flex';
            container.style.alignItems = 'center';
            container.style.height = '100%';
            container.style.marginLeft = '10px';
            container.style.gap = '5px';

            // 1. Cloud Compile Button
            const btnCompile = document.createElement('button');
            btnCompile.id = 'olc-cloud-btn';
            btnCompile.className = 'btn btn-primary';
            btnCompile.style.height = '100%';
            btnCompile.innerHTML = locked ? '🔒 Login Extensão' : '⚡ Cloud Compile';

            // 2. Download Button
            const btnDownload = document.createElement('button');
            btnDownload.id = 'olc-download-btn';
            btnDownload.className = 'btn btn-default'; // Slightly different style
            btnDownload.style.height = '100%';
            btnDownload.innerHTML = '⬇️ PDF';
            btnDownload.title = 'Compilar e Baixar PDF';
            if (locked) btnDownload.style.display = 'none'; // Hide if locked

            // Actions
            const handleAction = async (actionType) => {
                if (locked) {
                    btnCompile.innerHTML = '🔄 Verificando...';
                    btnCompile.disabled = true;

                    const result = await new Promise(r => chrome.storage.local.get(['authToken'], r));
                    this.authToken = result.authToken;

                    if (!this.authToken) {
                        alert('Você não está logado na extensão.\n\n1. Abra a extensão (clique no ícone 📄).\n2. Faça login.\n3. Tente novamente.');
                        btnCompile.innerHTML = '🔒 Login Extensão';
                        btnCompile.disabled = false;
                        return;
                    }

                    const hasAccess = await this.checkSubscription();
                    if (hasAccess) {
                        // Unlock
                        btnCompile.innerHTML = '⚡ Cloud Compile';
                        btnCompile.disabled = false;
                        btnDownload.style.display = 'block';
                        locked = false;

                        // Proceed with action
                        this.compile(actionType);
                    } else {
                        alert('Assinatura não encontrada ou expirada.');
                        btnCompile.innerHTML = '🔒 Login Extensão';
                        btnCompile.disabled = false;
                    }
                } else {
                    this.compile(actionType);
                }
            };

            btnCompile.onclick = () => handleAction('view');
            btnDownload.onclick = () => handleAction('download');

            container.appendChild(btnCompile);
            container.appendChild(btnDownload);

            // Insert
            toolbar.insertBefore(container, toolbar.firstChild);
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
                // Better scraping for CM6
                const lines = document.querySelectorAll('.cm-content .cm-line');
                if (lines.length > 0) {
                    content = Array.from(lines).map(line => line.textContent).join('\n');
                } else {
                    content = document.querySelector('.cm-content').innerText;
                }
            }
            // Fallback: just a mock if we can't grab it easily without more permissions
            else {
                content = "% Could not grab editor content automatically.\n% Please ensure you are in the Source editor.";
            }

            console.log('[OLC] Extracted content length:', content.length);
            // console.log('[OLC] Preview:', content.substring(0, 100));

            return {
                "main.tex": content
            };
        }

        async compile(actionType = 'view') {
            const btnCompile = document.getElementById('olc-cloud-btn');
            const btnDownload = document.getElementById('olc-download-btn');

            const originalText = btnCompile.innerHTML;
            btnCompile.innerHTML = '⏳ Enviando...';
            btnCompile.disabled = true;
            if (btnDownload) btnDownload.disabled = true;

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
                    const msg = error.error || 'Server error';
                    const logs = error.logs ? '\n\nLogs:\n' + error.logs : '';
                    throw new Error(msg + logs);
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

                if (actionType === 'download') {
                    this.downloadPdf(blob);
                } else {
                    this.showPdf(blob);
                }

            } catch (error) {
                console.error(error);
                alert('Erro na compilação:\n' + error.message.slice(0, 1000));
            } finally {
                btnCompile.innerHTML = originalText;
                btnCompile.disabled = false;
                if (btnDownload) btnDownload.disabled = false;
            }
        }

        showPdf(blob) {
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
        }

        downloadPdf(blob) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'document.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }

    // Start
    setTimeout(() => {
        new OverleafCloudCompiler();
    }, 2000);

})();
