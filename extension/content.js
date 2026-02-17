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
                if (result.apiUrl) {
                    this.apiUrl = result.apiUrl;
                    console.log('[OLC] Using configured API:', this.apiUrl);
                } else {
                    console.log('[OLC] Using default cloud API:', this.apiUrl);
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
                console.log('[OLC] Checking subscription via:', `${this.apiUrl}/user/me`);

                const response = await fetch(`${this.apiUrl}/user/me`, {
                    headers: { 'Authorization': `Bearer ${this.authToken}` }
                });

                if (!response.ok) {
                    console.error('[OLC] Subscription check failed with status:', response.status);
                    return false;
                }

                const data = await response.json();
                console.log('[OLC] Subscription data:', data);

                if (data.subscription && (data.subscription.credits > 0 || data.subscription.dailyRemaining > 0)) {
                    const credits = data.subscription.credits !== undefined ? data.subscription.credits : data.subscription.dailyRemaining;
                    console.log(`[OLC] Subscription valid. Credits: ${credits}`);
                    return true;
                } else {
                    console.warn('[OLC] Subscription valid but NO CREDITS remaining.', data);
                    alert('Seus créditos de compilação acabaram. Por favor, recarregue seus créditos.');
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

            // Legacy cleanup
            const existingBtn = document.getElementById('olc-cloud-btn');
            if (existingBtn) existingBtn.remove();

            // Create Container
            const container = document.createElement('div');
            container.id = 'olc-btn-group';
            container.style.display = 'flex';
            container.style.alignItems = 'center';
            container.style.height = '100%';
            container.style.marginLeft = '10px';
            container.style.gap = '5px';

            // Environment Toggle (New)
            const toggleContainer = document.createElement('div');
            toggleContainer.style.display = 'flex';
            toggleContainer.style.alignItems = 'center';
            toggleContainer.style.marginRight = '10px';
            toggleContainer.style.fontSize = '12px';
            toggleContainer.style.backgroundColor = '#f1f1f1';
            toggleContainer.style.padding = '2px 6px';
            toggleContainer.style.borderRadius = '4px';
            toggleContainer.style.cursor = 'pointer';
            toggleContainer.title = 'Clique para alternar entre Cloud (Padrão) e Local (8765)';

            const isLocal = this.apiUrl.includes('localhost');
            toggleContainer.innerHTML = isLocal ? '🏠 Local' : '☁️ Cloud';
            toggleContainer.style.border = isLocal ? '1px solid #ff9800' : '1px solid #ddd';
            toggleContainer.style.color = '#333';

            toggleContainer.onclick = () => {
                if (isLocal) {
                    if (confirm('Mudar para servidor CLOUD?')) {
                        chrome.storage.local.remove('apiUrl', () => location.reload());
                    }
                } else {
                    if (confirm('Mudar para servidor LOCAL (localhost:8765)?')) {
                        chrome.storage.local.set({ apiUrl: 'http://localhost:8765/api' }, () => location.reload());
                    }
                }
            };

            // 1. Cloud Compile Button
            const btnCompile = document.createElement('button');
            btnCompile.id = 'olc-cloud-btn';
            btnCompile.className = 'btn btn-primary';
            btnCompile.style.height = '100%';
            btnCompile.innerHTML = locked ? '🔒 Login Extensão' : '⚡ Cloud Compile';

            // 2. Download Button
            const btnDownload = document.createElement('button');
            btnDownload.id = 'olc-download-btn';
            btnDownload.className = 'btn btn-default';
            btnDownload.style.height = '100%';
            btnDownload.innerHTML = '⬇️ PDF';
            btnDownload.title = 'Compilar e Baixar PDF';
            if (locked) btnDownload.style.display = 'none';

            // 3. Sync Button
            const btnSync = document.createElement('button');
            btnSync.id = 'olc-sync-btn';
            btnSync.className = 'btn btn-default';
            btnSync.style.height = '100%';
            btnSync.innerHTML = '📂 Sync Zip';
            btnSync.title = 'Sincronizar via ZIP';
            if (locked) btnSync.style.display = 'none';

            // 4. Credits Label
            const lblCredits = document.createElement('span');
            lblCredits.id = 'olc-credits-lbl';
            lblCredits.style.marginLeft = '10px';
            lblCredits.style.fontSize = '12px';
            lblCredits.style.color = '#555';
            lblCredits.innerText = '';
            if (locked) lblCredits.style.display = 'none';

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

                    try {
                        const response = await fetch(`${this.apiUrl}/user/me`, {
                            headers: { 'Authorization': `Bearer ${this.authToken}` }
                        });
                        const data = await response.json();

                        if (response.ok && data.subscription) {
                            const credits = data.subscription.credits !== undefined ? data.subscription.credits : 0;
                            if (credits > 0) {
                                btnCompile.innerHTML = '⚡ Cloud Compile';
                                btnCompile.disabled = false;
                                btnDownload.style.display = 'block';
                                btnSync.style.display = 'block';
                                lblCredits.style.display = 'inline';
                                lblCredits.innerText = `Créditos: ${credits}`;
                                locked = false;
                                this.compile(actionType);
                            } else {
                                alert('Seus créditos de compilação acabaram.');
                                btnCompile.innerHTML = '🔒 Sem Créditos';
                                btnCompile.disabled = false;
                            }
                        } else {
                            alert('Erro ao verificar assinatura.');
                            btnCompile.innerHTML = '🔒 Erro Auth';
                            btnCompile.disabled = false;
                        }
                    } catch (e) {
                        console.error(e);
                        alert('Erro de conexão com servidor.');
                        btnCompile.innerHTML = '🔒 Erro Conexão';
                        btnCompile.disabled = false;
                    }
                } else {
                    this.compile(actionType);
                }
            };

            btnCompile.onclick = () => handleAction('view');
            btnDownload.onclick = () => handleAction('download');
            btnSync.onclick = () => this.syncProject();

            container.appendChild(toggleContainer);
            container.appendChild(btnCompile);
            container.appendChild(btnDownload);
            container.appendChild(btnSync);
            container.appendChild(lblCredits);

            toolbar.insertBefore(container, toolbar.firstChild);
        }

        getProjectId() {
            const match = window.location.pathname.match(/\/project\/([a-f0-9]+)/);
            return match ? match[1] : null;
        }

        // --- CORE FUNCTION: Fetch Project via ZIP ---
        async fetchAndExtractZip(projectId) {
            // 1. Download ZIP
            // Using /download/zip usually works reliably
            const response = await fetch(`https://www.overleaf.com/project/${projectId}/download/zip`, {
                credentials: 'include'
            });

            if (!response.ok) {
                if (response.status === 404) throw new Error('Projeto não encontrado ou acesso negado (404).');
                throw new Error(`Falha ao baixar ZIP do projeto: ${response.status}`);
            }

            const zipBlob = await response.blob();

            // 2. Load JSZip
            // Assumes known global JSZip
            if (typeof JSZip === 'undefined') {
                throw new Error('Biblioteca JSZip não carregada. Recarregue a extensão.');
            }

            const zip = await JSZip.loadAsync(zipBlob);
            const files = {};
            const binaryFiles = {};

            // 3. Iterate
            for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
                if (zipEntry.dir) continue;
                if (relativePath.startsWith('__MACOSX')) continue; // Ignore mac junk

                // Simple check for binaries
                // We treat everything as binary unless it screams text, 
                // BUT extracting as string is safer for encoding if we know it is text.
                const isImages = /\.(png|jpg|jpeg|gif|ico|bmp|webp)$/i.test(relativePath);
                const isPdf = /\.pdf$/i.test(relativePath);
                const isZip = /\.zip$/i.test(relativePath);
                const isFont = /\.(ttf|otf|eot|woff|woff2)$/i.test(relativePath);

                if (isImages || isPdf || isZip || isFont) {
                    const b64 = await zipEntry.async('base64');
                    binaryFiles[relativePath] = b64;
                } else {
                    // Default to text (tex, sty, cls, bib, txt, md, etc)
                    const text = await zipEntry.async('string');
                    files[relativePath] = text;
                }
            }

            return { files, binaryFiles };
        }

        async compile(actionType = 'view') {
            const btnCompile = document.getElementById('olc-cloud-btn');
            const btnDownload = document.getElementById('olc-download-btn');
            const originalText = btnCompile.innerHTML;

            btnCompile.innerHTML = '⏳ Baixando ZIP...';
            btnCompile.disabled = true;
            if (btnDownload) btnDownload.disabled = true;

            try {
                const projectId = this.getProjectId();
                if (!projectId) throw new Error('ID do projeto não encontrado na URL');

                // NEW: Use Zip Strategy
                const { files, binaryFiles } = await this.fetchAndExtractZip(projectId);

                btnCompile.innerHTML = '⚙️ Compilando...';

                // Send Payload
                const payload = {
                    projectId: projectId,
                    files: files,
                    binaryFiles: binaryFiles,
                    engine: 'pdflatex',
                    mainFile: 'main.tex' // Server auto-detects if missing
                };

                const response = await fetch(`${this.apiUrl}/compile`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.authToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    const logContent = error.logs || error.error || 'Erro desconhecido no servidor';
                    throw new Error(logContent);
                }

                const blob = await response.blob();

                if (blob.type === 'application/json') {
                    const text = await blob.text();
                    const error = JSON.parse(text);
                    throw new Error(error.logs || error.error);
                }

                if (actionType === 'download') {
                    this.downloadPdf(blob);
                } else {
                    this.showPdf(blob);
                }

            } catch (error) {
                console.error(error);
                this.showErrorModal('Erro na Compilação', error.message);
            } finally {
                btnCompile.innerHTML = originalText;
                btnCompile.disabled = false;
                if (btnDownload) btnDownload.disabled = false;
            }
        }

        async syncProject() {
            const btnSync = document.getElementById('olc-sync-btn');
            const originalText = btnSync.innerHTML;
            btnSync.innerHTML = '⏳ Baixando ZIP...';
            btnSync.disabled = true;

            try {
                const projectId = this.getProjectId();
                const { files, binaryFiles } = await this.fetchAndExtractZip(projectId);

                btnSync.innerHTML = '📤 Enviando...';

                const response = await fetch(`${this.apiUrl}/sync`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId, files, binaryFiles })
                });

                if (!response.ok) throw new Error(await response.text());

                const result = await response.json();
                alert(`✅ Projeto Sincronizado!\n${result.message}`);

            } catch (error) {
                this.showErrorModal('Erro Sync', error.message);
            } finally {
                btnSync.innerHTML = originalText;
                btnSync.disabled = false;
            }
        }

        showErrorModal(title, message) {
            const existing = document.getElementById('olc-error-modal');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'olc-error-modal';
            overlay.style.position = 'fixed';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.width = '100%';
            overlay.style.height = '100%';
            overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
            overlay.style.zIndex = '9999';
            overlay.style.display = 'flex';
            overlay.style.justifyContent = 'center';
            overlay.style.alignItems = 'center';

            const modal = document.createElement('div');
            modal.style.backgroundColor = '#fff';
            modal.style.padding = '20px';
            modal.style.borderRadius = '8px';
            modal.style.width = '600px';
            modal.style.maxWidth = '90%';
            modal.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
            modal.style.display = 'flex';
            modal.style.flexDirection = 'column';
            modal.style.maxHeight = '80vh';

            const header = document.createElement('h3');
            header.innerText = title;
            header.style.marginTop = '0';
            header.style.color = '#d32f2f';
            modal.appendChild(header);

            const logArea = document.createElement('pre');
            logArea.innerText = message;
            logArea.style.backgroundColor = '#f5f5f5';
            logArea.style.padding = '10px';
            logArea.style.borderRadius = '4px';
            logArea.style.overflow = 'auto';
            logArea.style.flex = '1';
            logArea.style.fontSize = '12px';
            logArea.style.border = '1px solid #ddd';
            modal.appendChild(logArea);

            const btnGroup = document.createElement('div');
            btnGroup.style.marginTop = '15px';
            btnGroup.style.display = 'flex';
            btnGroup.style.justifyContent = 'flex-end';
            btnGroup.style.gap = '10px';

            const btnCopy = document.createElement('button');
            btnCopy.className = 'btn btn-default';
            btnCopy.innerText = '📋 Copiar Erro';
            btnCopy.onclick = () => {
                navigator.clipboard.writeText(message);
                btnCopy.innerText = '✅ Copiado!';
                setTimeout(() => btnCopy.innerText = '📋 Copiar Erro', 2000);
            };

            const btnClose = document.createElement('button');
            btnClose.className = 'btn btn-primary';
            btnClose.innerText = 'Fechar';
            btnClose.onclick = () => overlay.remove();

            btnGroup.appendChild(btnCopy);
            btnGroup.appendChild(btnClose);
            modal.appendChild(btnGroup);

            overlay.appendChild(modal);
            document.body.appendChild(overlay);
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
