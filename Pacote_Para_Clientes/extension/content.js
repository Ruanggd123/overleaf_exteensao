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

            // 3. Sync Button
            const btnSync = document.createElement('button');
            btnSync.id = 'olc-sync-btn';
            btnSync.className = 'btn btn-default';
            btnSync.style.height = '100%';
            btnSync.innerHTML = '📂 Sync Local';
            btnSync.title = 'Sincronizar arquivos com pasta local';
            if (locked) btnSync.style.display = 'none';

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
                        btnCompile.disabled = false;
                        btnDownload.style.display = 'block';
                        document.getElementById('olc-sync-btn').style.display = 'block';
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
            btnSync.onclick = () => this.syncProject();

            container.appendChild(btnCompile);
            container.appendChild(btnDownload);
            container.appendChild(btnSync);

            // Insert
            toolbar.insertBefore(container, toolbar.firstChild);
        }

        getProjectId() {
            const match = window.location.pathname.match(/\/project\/([a-f0-9]+)/);
            return match ? match[1] : null;
        }

        async fetchProjectZip(projectId) {
            try {
                const response = await fetch(`https://www.overleaf.com/project/${projectId}/download/zip`, {
                    method: 'GET'
                });
                if (!response.ok) throw new Error('Failed to download project ZIP from Overleaf');
                return await response.blob();
            } catch (e) {
                console.error('[OLC] Error fetching ZIP:', e);
                throw e;
            }
        }

        async compile(actionType = 'view') {
            const btnCompile = document.getElementById('olc-cloud-btn');
            const btnDownload = document.getElementById('olc-download-btn');

            const originalText = btnCompile.innerHTML;
            btnCompile.innerHTML = '⏳ Preparando...';
            btnCompile.disabled = true;
            if (btnDownload) btnDownload.disabled = true;

            try {
                const projectId = this.getProjectId();
                if (!projectId) throw new Error('Project ID not found in URL');

                // 1. Parse File Tree (Reuse logic)
                const fileMap = this.parseFileTree();
                if (Object.keys(fileMap).length === 0) {
                    // Try one more time with a delay? Or just warn.
                    console.warn('[OLC] No files found in tree. Compilation might fail if files are hidden.');
                }

                btnCompile.innerHTML = '📥 Baixando...';

                // 2. Fetch all files
                const files = {};
                const binaryFiles = {};

                const fileIds = Object.keys(fileMap);
                // We need to fetch ALL files for compilation to work
                // Concurrency limits to avoid ratelimit
                const concurrency = 5;
                let completed = 0;

                // Helper to update progress
                const updateProgress = () => {
                    btnCompile.innerHTML = `📥 ${completed}/${fileIds.length}`;
                };

                for (let i = 0; i < fileIds.length; i += concurrency) {
                    const chunk = fileIds.slice(i, i + concurrency);
                    await Promise.all(chunk.map(async (fileId) => {
                        try {
                            const result = await this.fetchFileContent(projectId, fileId);
                            if (result.isBinary) {
                                binaryFiles[fileMap[fileId]] = result.content;
                            } else {
                                files[fileMap[fileId]] = result.content;
                            }
                        } catch (e) {
                            console.error(`Error fetching ${fileMap[fileId]} for compile:`, e);
                            // We continue, maybe it's not critical? Or should we fail?
                            // Let's log but continue.
                        } finally {
                            completed++;
                            updateProgress();
                        }
                    }));
                }

                btnCompile.innerHTML = '⚙️ Compilando...';

                // 3. Send Payload
                const payload = {
                    projectId: projectId,
                    files: files,
                    binaryFiles: binaryFiles,
                    engine: 'pdflatex', // Could be dynamic if we parsed settings
                    mainFile: 'main.tex' // Server will auto-detect if missing, or we could try to guess
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

        showErrorModal(title, message) {
            // Remove existing modal
            const existing = document.getElementById('olc-error-modal');
            if (existing) existing.remove();

            // Overlay
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

            // Modal
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

            // Header
            const header = document.createElement('h3');
            header.innerText = title;
            header.style.marginTop = '0';
            header.style.color = '#d32f2f';
            modal.appendChild(header);

            // Log Area
            const logArea = document.createElement('pre');
            logArea.innerText = message;
            logArea.style.backgroundColor = '#f5f5f5';
            logArea.style.padding = '10px';
            logArea.style.borderRadius = '4px';
            logArea.style.overflow = 'auto'; // SCROLLABLE!
            logArea.style.flex = '1';
            logArea.style.fontSize = '12px';
            logArea.style.border = '1px solid #ddd';
            modal.appendChild(logArea);

            // Buttons
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

        // =========================================================================
        // SMART SYNC FEATURE
        // =========================================================================

        async syncProject() {
            const btnSync = document.getElementById('olc-sync-btn');
            const originalText = btnSync.innerHTML;
            btnSync.innerHTML = '⏳ Lendo arquivos...';
            btnSync.disabled = true;

            try {
                const projectId = this.getProjectId();
                if (!projectId) throw new Error('Project ID not found in URL');

                // 1. Parse File Tree
                const fileMap = this.parseFileTree();
                console.log('[OLC] Files found:', fileMap);

                if (Object.keys(fileMap).length === 0) {
                    throw new Error('Nenhum arquivo encontrado na árvore de arquivos. Abra as pastas para garantir que estão visíveis.');
                }

                btnSync.innerHTML = `0/${Object.keys(fileMap).length} Baixando...`;

                // 2. Fetch all files (concurrency limited)
                const files = {};
                const binaryFiles = {};
                const errors = [];

                const fileIds = Object.keys(fileMap);
                const total = fileIds.length;
                let completed = 0;

                // Simple concurrency queue of 5
                const concurrency = 5;
                for (let i = 0; i < total; i += concurrency) {
                    const chunk = fileIds.slice(i, i + concurrency);
                    await Promise.all(chunk.map(async (fileId) => {
                        try {
                            const result = await this.fetchFileContent(projectId, fileId);
                            if (result.isBinary) {
                                binaryFiles[fileMap[fileId]] = result.content;
                            } else {
                                files[fileMap[fileId]] = result.content;
                            }
                        } catch (err) {
                            console.error(`Error fetching ${fileMap[fileId]}:`, err);
                            errors.push(`${fileMap[fileId]}: ${err.message}`);
                        } finally {
                            completed++;
                            btnSync.innerHTML = `${completed}/${total} Baixando...`;
                        }
                    }));
                }

                // 3. Send to Local Server
                btnSync.innerHTML = '📤 Enviando...';

                const payload = {
                    projectId: projectId,
                    files: files,
                    binaryFiles: binaryFiles
                };

                const response = await fetch(`${this.apiUrl}/sync`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`Server error: ${errText}`);
                }

                const result = await response.json();
                console.log('[OLC] Sync result:', result);

                if (errors.length > 0) {
                    alert(`Sincronização concluída com ${errors.length} erros:\n${errors.join('\n')}`);
                } else {
                    alert(`✅ Projeto Sincronizado com Sucesso!\nBackend: ${result.message}`);
                }

            } catch (error) {
                console.error('[OLC] Sync Error:', error);
                this.showErrorModal('Erro na Sincronização', error.message);
            } finally {
                btnSync.innerHTML = originalText;
                btnSync.disabled = false;
            }
        }

        parseFileTree() {
            const files = {};

            // Helper recursive function
            const traverse = (element, currentPath) => {
                // Find all immediate children that are items
                const items = Array.from(element.children).filter(c =>
                    c.tagName === 'LI' || c.classList.contains('file-tree-folder-list-inner')
                );

                // Handle the inner list wrapper if present
                if (element.classList.contains('file-tree-folder-list') || element.classList.contains('file-tree-list')) {
                    // Dig deeper into the list structure
                    const innerList = element.querySelector('.file-tree-folder-list-inner');
                    if (innerList) {
                        Array.from(innerList.children).forEach(li => processLi(li, currentPath));
                        return;
                    }
                }

                // Fallback for direct traversal if structure varies
                items.forEach(li => processLi(li, currentPath));
            };

            const processLi = (li, currentPath) => {
                const entity = li.querySelector('.entity');
                if (!entity) return;

                const nameEl = entity.querySelector('.item-name-button span');
                const name = nameEl ? nameEl.innerText : 'unknown';
                const fileId = entity.getAttribute('data-file-id');
                const type = entity.getAttribute('data-file-type'); // folder, doc, file

                if (type === 'folder') {
                    // It's a folder, find its UL child to recurse
                    // The UL is usually a sibling of the entity div or inside the li
                    const ul = li.nextElementSibling; // in some tree versions, UL is next sibling of LI? No, usually nested or sibling.
                    // Based on user dump: 
                    // <li ... role="treeitem">...<div class="entity">...</div></li>
                    // <ul ... role="tree">...</ul> -- Wait, the dump shows UL as a SIBLING of the LI for the folder contents?
                    // Let's look closely at the dump:
                    // <li ... aria-label="1-pre-textuais">...</li>
                    // <li ... aria-label="2-textuais">...</li>
                    // <ul ...> ... children of 2-textuais ... </ul>
                    // It seems recursive structure is flat list of LI followed by UL?
                    // Or maybe standard nested. 

                    // Actually looking at the dump:
                    // <li ... aria-label="2-textuais">...</li>
                    // <ul ...> ... </ul>
                    // The UL seems to be the Next Sibling of the LI for that folder.
                    // Let's verify by checking expanding logic.

                    if (ul && ul.tagName === 'UL') {
                        traverse(ul, currentPath ? `${currentPath}/${name}` : name);
                    }
                } else if (fileId) {
                    // It's a file
                    files[fileId] = currentPath ? `${currentPath}/${name}` : name;
                }
            };

            // Start from root
            // The root is usually .file-tree-list-root or .file-tree-list
            const root = document.querySelector('.file-tree-list');
            if (root) {
                traverse(root, '');
            } else {
                console.error('[OLC] File tree root not found');
            }

            return files;
        }

        async fetchFileContent(projectId, fileId) {
            const url = `https://www.overleaf.com/project/${projectId}/file/${fileId}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

            const blob = await response.blob();

            // Check if binary (image, pdf, etc) or text
            // Simple heuristic: if type starts with image/ or application/pdf -> binary
            // else text. 
            // Better: read first few bytes or just treat everything as binary if we could, 
            // but for editable text files we want them as text.

            const isText = blob.type.startsWith('text/') ||
                blob.type === 'application/x-tex' ||
                blob.type === 'application/javascript' ||
                blob.type === 'application/json' ||
                blob.size < 1024 * 1024; // Small files assume text? Risk of corruption.

            // Actually, let's try to read as text. If it contains null bytes, it's binary.
            // But we need to deciding BEFORE reading fully if we want to optimize.
            // Let's allow the server to handle encoding.
            // But for transporting JSON, we need base64 for binaries.

            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const res = reader.result;
                    // res is string if readAsText, buffer if readAsArrayBuffer, dataUrl if readAsDataURL
                    // Let's use readAsDataURL for everything to be safe? 
                    // No, text is better for text files to edit locally.

                    if (res.includes('base64,')) {
                        resolve({ isBinary: true, content: res }); // Data URL
                    } else {
                        resolve({ isBinary: false, content: res }); // Text
                    }
                };
                reader.onerror = reject;

                // Heuristic:
                if (blob.type.includes('image') || blob.type.includes('pdf') || blob.type.includes('zip')) {
                    reader.readAsDataURL(blob);
                } else {
                    // Try text, if it fails fallback?
                    // Let's default to Text for .tex, .bib, .cls, .sty, .txt, .md
                    // And DataURL for everything else.
                    reader.readAsText(blob);
                }
            });
        }
    }

    // Start
    setTimeout(() => {
        new OverleafCloudCompiler();
    }, 2000);

})();
