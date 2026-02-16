// content.js - Integração com Overleaf e Firebase

// Initialize Firebase (Compat)
// Note: Config should ideally be fetched from a central place or injected, but for content script we define it here or rely on popup to have initialized it?
// Actually content scripts operate in their own context. We need to initialize app here too.
const firebaseConfig = {
    apiKey: "AIzaSyChPjBPB22ozjA5X9CYn7gkprLHM68TT7g",
    authDomain: "extensao-asdsadas1q.firebaseapp.com",
    projectId: "extensao-asdsadas1q",
    storageBucket: "extensao-asdsadas1q.firebasestorage.app",
    messagingSenderId: "1034240483206",
    appId: "1:1034240483206:web:97da5c893f6c646b18d607",
    measurementId: "G-8MEMV5HNM6"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.firestore();

class OverleafCloudCompiler {
    constructor() {
        this.defaultApiUrl = 'http://localhost:8765/api';
        this.apiUrl = this.defaultApiUrl;
        this.init();
        console.log('[OLC] Cloud Compiler initialized');
    }

    async init() {
        // Sync auth state and settings
        chrome.storage.local.get(['authToken', 'apiUrl'], async (result) => {
            this.authToken = result.authToken;
            if (result.apiUrl) this.apiUrl = result.apiUrl;

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
                location.reload(); // Simple reload to refresh state
            }
        });
    }

    async checkSubscription() {
        try {
            const response = await fetch(`${this.apiUrl}/user/me`, {
                headers: { 'Authorization': `Bearer ${this.authToken}` }
            });

            if (!response.ok) return false;

            const data = await response.json();
            return data.subscription && data.subscription.dailyRemaining > 0;
        } catch (error) {
            console.error('[OLC] Check subscription failed', error);
            return false;
        }
    }

    injectCompilerUI(locked = false) {
        const toolbar = document.querySelector('.toolbar-pdf');
        if (!toolbar) return;

        if (document.getElementById('olc-cloud-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'olc-cloud-btn';
        btn.className = 'btn btn-primary';
        btn.style.marginLeft = '10px';
        btn.innerHTML = locked ? '🔒 Login/Upgrade necessário' : '⚡ Compilar na Nuvem';

        if (locked) {
            btn.onclick = () => {
                alert('Por favor, faça login na extensão e verifique se possui créditos de compilação.');
            };
            btn.style.opacity = '0.7';
        } else {
            btn.onclick = () => this.compile();
        }

        toolbar.appendChild(btn);
    }

    async extractFiles() {
        // Mock extraction - in prod, use Overleaf's API or zip download
        return {
            "main.tex": "% Mock file content\n\\documentclass{article}\\begin{document}Hello Cloud!\\end{document}"
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
                const error = await response.json();
                throw new Error(error.error || 'Server error');
            }

            const data = await response.json();

            if (data.mock) {
                alert(`Sucesso! (Simulação)\nRestantes: ${data.remaining}`);
            } else {
                // Handle blob response if real
                const blob = await response.blob();
                this.showPdf(blob);
            }

        } catch (error) {
            alert('Erro: ' + error.message);
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
// Wait for DOM
setTimeout(() => {
    new OverleafCloudCompiler();
}, 2000);
