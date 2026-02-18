// content.js — Main Entry Point & UI Logic

// ═══════════════════════════════════════════════════════════════
//  OverleafHybridCompiler
// ═══════════════════════════════════════════════════════════════

class OverleafHybridCompiler {
    constructor() {
        this.extractor = new OverleafExtractor();
        this.synchronizer = new ProjectSynchronizer(this.extractor.projectId);
        this.compiling = false;
        this.serverMode = 'checking'; // 'local', 'cloud', 'offline'
        this.lastPdfUrl = null;
        this.lastPdfBlob = null;
        this.autoCompileTimer = null;
        this.autoCompileEnabled = false;
        this.observer = null;
        this.contextInvalidated = false;

        this._init();
    }

    async _init() {
        await this._loadSettings();

        // Start observing immediately
        this._startUIObserver();
        this._tryInjectUI();

        // Periodic status check (with context validation)
        this._safeCheckServers();
        this.serverCheckInterval = setInterval(() => this._safeCheckServers(), 30000);

        // Listen for toggle (with error handling)
        try {
            if (isExtensionContextValid()) {
                chrome.storage.onChanged.addListener((changes) => {
                    if (this.contextInvalidated) return;
                    if (changes.showExtension) {
                        this._updateVisibility(changes.showExtension.newValue);
                    }
                });

                // Check initial visibility
                chrome.storage.local.get('showExtension', (d) => {
                    if (chrome.runtime.lastError) {
                        this._handleContextInvalidated();
                        return;
                    }
                    this._updateVisibility(d.showExtension !== false);
                });
            }
        } catch (e) {
            console.warn('[OLC] Error setting up storage listeners:', e);
        }

        console.log('[OLC] Hybrid Compiler initialized.');
    }

    // ─── Safe Server Check ─────────────────────────────────────

    _safeCheckServers() {
        if (this.contextInvalidated) return;

        try {
            if (!isExtensionContextValid()) {
                this._handleContextInvalidated();
                return;
            }
            this._checkServers();
        } catch (e) {
            if (e.message && e.message.includes('invalidated')) {
                this._handleContextInvalidated();
            }
        }
    }

    // ─── Settings ──────────────────────────────────────────────

    async _loadSettings() {
        if (!isExtensionContextValid()) {
            console.warn('[OLC] Extension context not available for loading settings');
            return;
        }

        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ action: 'GET_SETTINGS' }, (s) => {
                    if (chrome.runtime.lastError) {
                        console.warn('[OLC] Error loading settings:', chrome.runtime.lastError);
                        resolve();
                        return;
                    }
                    if (s) {
                        CONFIG.serverUrl = s.localUrl || CONFIG.serverUrl;
                        CONFIG.cloudUrl = s.cloudUrl;
                        CONFIG.latexEngine = s.engine || CONFIG.latexEngine;
                    }
                    resolve();
                });
            } catch (e) {
                console.warn('[OLC] Exception loading settings:', e);
                resolve();
            }
        });
    }

    // ─── UI Injection Strategy ─────────────────────────────────

    _startUIObserver() {
        this.observer = new MutationObserver(() => {
            if (this.contextInvalidated) return;
            this._tryInjectUI();
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    _tryInjectUI() {
        // Check if already injected
        if (document.getElementById('olc-status-banner')) return;

        // Strategy 1: Standard PDF Panels
        const selectors = [
            '.pdf-viewer',
            '.pdf',
            '.ide-react-pdf-panel',
            'div[aria-label="PDF Preview"]',
            '.ui-layout-pane-east', // Common splitter pane
            '.pdf-preview-pane'     // Legacy
        ];

        let pdfPanel = null;
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                // Try to get the semantic container (often the pane itself)
                pdfPanel = el.closest('.ui-layout-pane') || el.closest('.pdf') || el;
                console.log(`[OLC] Found panel via selector: ${sel}`);
                break;
            }
        }

        if (pdfPanel) {
            this._setupUI(pdfPanel);
        } else {
            // Strategy 2: Fallback to Floating Mode if not found after some time
            // We check if document is fully loaded
            if (document.readyState === 'complete') {
                setTimeout(() => {
                    if (!document.getElementById('olc-status-banner') && !this.contextInvalidated) {
                        this._setupFloatingUI();
                    }
                }, 2000);
            }
        }
    }

    _setupUI(pdfPanel) {
        console.log('[OLC] Injecting Embed UI into:', pdfPanel);

        // 1. Inject Styles
        this._injectBannerStyles();

        // 2. Inject Banner
        this._injectStatusBanner(pdfPanel);

        // 3. Inject PDF Container (replacing native)
        this._injectPdfContainer(pdfPanel);

        // 4. Hook Buttons
        this._overrideRecompileButton();
        this._overrideDownloadButton();

        // 5. Setup Auto Compile triggers
        this._setupAutoCompileTriggers();
    }

    _setupFloatingUI() {
        if (document.getElementById('olc-floating-controls')) return;
        if (this.contextInvalidated) return;

        console.log('[OLC] PDF Panel not found. Injecting Floating UI.');

        this._injectBannerStyles();

        const floatContainer = document.createElement('div');
        floatContainer.id = 'olc-floating-controls';
        floatContainer.innerHTML = `
            <div class="olc-float-header">
                <span>Overleaf Hybrid</span>
                <span class="olc-banner-dot checking" id="olc-banner-dot"></span>
            </div>
            <div class="olc-float-actions">
                <button id="olc-btn-compile" class="olc-banner-btn olc-btn-primary">▶ Compilar</button>
                <button id="olc-btn-download" class="olc-banner-btn" disabled>⬇ PDF</button>
                <button id="olc-btn-word" class="olc-banner-btn" disabled>📝 Word</button>
            </div>
            <button id="olc-btn-expand" class="olc-banner-btn" style="width: 100%; margin-top:5px;">📅 Ver PDF</button>
        `;

        document.body.appendChild(floatContainer);

        // Events
        floatContainer.querySelector('#olc-btn-compile').addEventListener('click', () => this._compile());
        floatContainer.querySelector('#olc-btn-download').addEventListener('click', () => this._downloadPdf());
        floatContainer.querySelector('#olc-btn-word').addEventListener('click', () => this._convertToWord());
        floatContainer.querySelector('#olc-btn-expand').addEventListener('click', () => this._toggleFloatingPdf());

        // Also check servers
        this._safeCheckServers();
    }

    _toggleFloatingPdf() {
        let container = document.getElementById('olc-pdf-container');
        if (!container) {
            // Create modal container
            container = document.createElement('div');
            container.id = 'olc-pdf-container';
            container.className = 'olc-floating-pdf-modal';
            container.innerHTML = `
                <div class="olc-modal-header">
                    <h3>Visualização PDF</h3>
                    <button id="olc-close-modal">✖</button>
                </div>
                <div class="olc-modal-body">
                     <div class="olc-empty-state">
                        <div class="olc-empty-icon">📄</div>
                        <p>Compile para visualizar.</p>
                    </div>
                </div>
            `;
            document.body.appendChild(container);
            container.querySelector('#olc-close-modal').addEventListener('click', () => {
                container.style.display = 'none';
            });

        } else {
            container.style.display = container.style.display === 'none' ? 'flex' : 'none';
        }
    }

    _injectStatusBanner(pdfPanel) {
        const banner = document.createElement('div');
        banner.id = 'olc-status-banner';
        banner.innerHTML = `
            <div class="olc-banner-content">
                <span class="olc-banner-dot checking" id="olc-banner-dot"></span>
                <span id="olc-banner-text">Verificando...</span>
            </div>
            <div class="olc-banner-actions">
                <button id="olc-btn-compile" class="olc-banner-btn olc-btn-primary" title="Compilar">
                    ▶ Compilar
                </button>
                <button id="olc-btn-download" class="olc-banner-btn" title="Baixar PDF" disabled>
                    ⬇ PDF
                </button>
                <button id="olc-btn-word" class="olc-banner-btn" title="Converter para Word" disabled>
                    📝 Word
                </button>
                <button id="olc-btn-auto" class="olc-banner-btn olc-btn-auto" title="Auto-compilar ao editar">
                    ⚡ Auto
                </button>
                <button id="olc-btn-settings" class="olc-banner-btn" title="Configurações">
                    ⚙️
                </button>
            </div>
        `;

        // Insert logic
        const messagesDiv = pdfPanel.querySelector('.pdf-preview-messages');
        const toolbar = pdfPanel.querySelector('.toolbar-pdf');

        if (toolbar) {
            pdfPanel.insertBefore(banner, toolbar.nextSibling);
        } else if (messagesDiv) {
            pdfPanel.insertBefore(banner, messagesDiv);
        } else {
            pdfPanel.prepend(banner);
        }

        // Events
        banner.querySelector('#olc-btn-compile').addEventListener('click', () => this._compile());
        banner.querySelector('#olc-btn-download').addEventListener('click', () => this._downloadPdf());
        banner.querySelector('#olc-btn-word').addEventListener('click', () => this._convertToWord());
        banner.querySelector('#olc-btn-auto').addEventListener('click', () => this._toggleAutoCompile());
        banner.querySelector('#olc-btn-settings').addEventListener('click', () => {
            if (isExtensionContextValid()) {
                chrome.runtime.openOptionsPage?.() || window.open(chrome.runtime.getURL('popup.html'));
            } else {
                this._toast('Extensão desatualizada. Recarregue a página.', 'error');
            }
        });

        // Check status now that UI is there
        this._safeCheckServers();
    }

    _injectPdfContainer(pdfPanel) {
        // Hide native elements
        const originalViewer = pdfPanel.querySelector('.pdf-viewer');
        const logsPane = pdfPanel.querySelector('.new-logs-pane');
        const messagesDiv = pdfPanel.querySelector('.pdf-preview-messages');

        if (originalViewer) originalViewer.style.display = 'none';
        if (logsPane) logsPane.style.display = 'none';
        if (messagesDiv) messagesDiv.style.display = 'none';

        // Create container if not exists
        let container = document.getElementById('olc-pdf-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'olc-pdf-container';
            container.innerHTML = `
                <div class="olc-empty-state">
                    <div class="olc-empty-icon">📄</div>
                    <h3>Compilador Híbrido Ativo</h3>
                    <p>Use o botão <strong>"▶ Compilar"</strong> ou ative "⚡ Auto".<br/>O PDF aparecerá aqui.</p>
                </div>
            `;

            // Positioning
            // Try to put it where the original viewer was
            if (originalViewer) {
                originalViewer.parentNode.insertBefore(container, originalViewer);
            } else {
                pdfPanel.appendChild(container);
            }

            // Force layout
            container.style.flex = '1';
            container.style.overflow = 'hidden';
        }
    }



    async _convertToWord() {
        if (!this.lastPdfBlob) {
            this._showToast('Nenhum PDF compilado disponível.', 'error');
            return;
        }

        this._showToast('Convertendo para Word...', 'info');

        try {
            const formData = new FormData();
            formData.append('pdf', this.lastPdfBlob, 'documento.pdf');

            // Get URL dynamically if possible, or use default
            // Assuming we can get it from storage or hardcoded for now
            const stored = await chrome.storage.local.get(['serverUrl']);
            const serverUrl = stored.serverUrl || 'http://localhost:8765';

            const response = await fetch(`${serverUrl}/convert/word`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) throw new Error('Falha na conversão');

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'documento.docx';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);

            this._showToast('Conversão concluída!', 'success');
        } catch (err) {
            console.error(err);
            this._showToast('Erro ao converter para Word.', 'error');
        }
    }

    _injectBannerStyles() {
        if (document.getElementById('olc-embedded-styles')) return;

        const style = document.createElement('style');
        style.id = 'olc-embedded-styles';
        style.textContent = `
            #olc-status-banner {
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px 12px;
                background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
                border-bottom: 1px solid #334155;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px; color: #e2e8f0;
                flex-shrink: 0; z-index: 100;
            }
            .olc-banner-content { display: flex; align-items: center; gap: 8px; }
            .olc-banner-dot {
                width: 8px; height: 8px; border-radius: 50%;
                background: #94a3b8; transition: all 0.3s;
            }
            .olc-banner-dot.local { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
            .olc-banner-dot.cloud { background: #3b82f6; box-shadow: 0 0 6px #3b82f6; }
            .olc-banner-dot.offline { background: #ef4444; }
            .olc-banner-dot.checking { background: #f59e0b; animation: pulse 1s infinite; }
            .olc-banner-dot.compiling { background: #8b5cf6; animation: pulse 0.8s infinite; }

            .olc-banner-actions { display: flex; gap: 6px; }
            .olc-banner-btn {
                padding: 4px 10px; border: 1px solid #475569; border-radius: 4px;
                background: #334155; color: #f1f5f9; cursor: pointer;
                font-size: 11px; transition: all 0.2s;
            }
            .olc-banner-btn:hover:not(:disabled) { background: #475569; }
            .olc-banner-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            .olc-btn-primary { background: #22c55e; border-color: #22c55e; font-weight: 600; }
            .olc-btn-primary:hover:not(:disabled) { background: #16a34a; }
            .olc-btn-auto.active { background: #3b82f6; border-color: #3b82f6; color: white; }

            #olc-pdf-container {
                flex: 1; display: flex; flex-direction: column; 
                height: 100%; min-height: 0; overflow: hidden;
                position: relative; background: #1a1a2e;
            }
            #olc-pdf-container iframe { width: 100%; height: 100%; border: none; display: block; }

            /* Class to hide native elements when extension is active */
            .olc-hidden-native { display: none !important; }

            .olc-empty-state {
                flex: 1; display: flex; flex-direction: column;
                align-items: center; justify-content: center;
                color: #64748b; padding: 40px; text-align: center;
            }
            .olc-empty-icon { font-size: 40px; margin-bottom: 16px; opacity: 0.5; }

            .olc-compiling-overlay {
                position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(15, 23, 42, 0.85);
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                z-index: 50; gap: 16px; color: #e2e8f0;
            }
            .olc-compiling-spinner {
                width: 32px; height: 32px;
                border: 3px solid #334155; border-top-color: #3b82f6;
                border-radius: 50%; animation: spin 1s linear infinite;
            }

            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
            @keyframes spin { to { transform: rotate(360deg); } }

            .olc-toast {
                position: fixed; bottom: 20px; right: 20px;
                padding: 10px 16px; border-radius: 6px;
                color: white; font-size: 13px; z-index: 99999;
                box-shadow: 0 4px 10px rgba(0,0,0,0.3);
                animation: slideIn 0.3s ease;
            }
            @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

            /* Floating UI Fallback */
            #olc-floating-controls {
                position: fixed; bottom: 20px; right: 20px;
                width: 220px;
                background: #1e293b; border: 1px solid #334155;
                border-radius: 8px; padding: 12px;
                box-shadow: 0 4px 15px rgba(0,0,0,0.4);
                z-index: 99999;
                font-family: sans-serif;
            }
            .olc-float-header {
                display: flex; justify-content: space-between; align-items: center;
                margin-bottom: 10px; color: white; font-weight: bold; font-size: 13px;
            }
            .olc-float-actions { display: flex; gap: 8px; }
            .olc-float-actions button { flex: 1; justify-content: center; }

            /* Modal for Float Review */
            .olc-floating-pdf-modal {
                position: fixed; top: 40px; right: 260px; bottom: 40px; left: 40px;
                background: #0f172a; z-index: 99999;
                border: 1px solid #334155; border-radius: 8px;
                display: flex; flex-direction: column;
                box-shadow: 0 0 50px rgba(0,0,0,0.5);
            }
            .olc-modal-header {
                padding: 10px 15px; border-bottom: 1px solid #334155;
                display: flex; justify-content: space-between; color: white;
            }
            .olc-modal-header button {
                background: transparent; border: none; color: #94a3b8; cursor: pointer; font-size: 16px;
            }
            .olc-modal-body { flex: 1; position: relative; }
            .olc-modal-body iframe { width: 100%; height: 100%; border: none; }
        `;
        document.head.appendChild(style);
    }

    // ─── Overrides ─────────────────────────────────────────────

    _overrideRecompileButton() {
        // Find existing recompile buttons
        const btns = document.querySelectorAll('.compile-button-group .compile-button, .compile-button-group button');

        btns.forEach(btn => {
            // SKIP if we already handled this button or it's our own custom button
            if (btn.classList.contains('olc-custom-btn') || btn.dataset.olcHandled) return;

            // Mark native as handled
            btn.dataset.olcHandled = 'true';
            btn.classList.add('olc-native-btn');

            // Create OUR button
            const newBtn = btn.cloneNode(true);
            newBtn.classList.add('olc-custom-btn');
            newBtn.classList.remove('olc-native-btn');
            delete newBtn.dataset.olcHandled;

            // Update text/icon
            const textSpan = newBtn.querySelector('span') || newBtn;
            if (textSpan) textSpan.innerText = '⚡';
            newBtn.title = 'Compilar com Extensão Híbrida';
            newBtn.style.minWidth = '40px';

            // Add listener
            newBtn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                this._compile();
            });

            // Insert AFTER the native button
            if (btn.parentNode) {
                btn.parentNode.insertBefore(newBtn, btn.nextSibling);
            }
        });
    }

    _overrideDownloadButton() {
        const dlBtns = document.querySelectorAll('a[aria-label="Download PDF"], a[download]');

        dlBtns.forEach(btn => {
            if (btn.classList.contains('olc-custom-btn') || btn.dataset.olcHandled) return;

            btn.dataset.olcHandled = 'true';
            btn.classList.add('olc-native-btn');

            const newBtn = btn.cloneNode(true);
            newBtn.classList.add('olc-custom-btn');
            newBtn.classList.remove('olc-native-btn');
            delete newBtn.dataset.olcHandled;

            // Reset potential disabled states
            newBtn.removeAttribute('disabled');
            newBtn.style.pointerEvents = 'auto';

            newBtn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                this._downloadPdf();
            });

            if (btn.parentNode) {
                btn.parentNode.insertBefore(newBtn, btn.nextSibling);
            }
        });
    }

    // ─── Auto Compile ──────────────────────────────────────────

    _setupAutoCompileTriggers() {
        document.addEventListener('keydown', (e) => {
            if (this.contextInvalidated) return;

            // Check if inside editor
            const editor = e.target.closest('.cm-editor, .cm-content, .CodeMirror');
            if (!editor) return;

            // Ctrl+S -> Force compile
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this._compile();
                return;
            }

            // If auto compile enabled, debounce trigger
            if (this.autoCompileEnabled && !e.ctrlKey && !e.altKey && e.key.length === 1) {
                clearTimeout(this.autoCompileTimer);
                this.autoCompileTimer = setTimeout(() => {
                    if (!this.compiling && !this.contextInvalidated) this._compile();
                }, CONFIG.autoCompileDelay);
            }
        }, true);
    }

    _toggleAutoCompile() {
        this.autoCompileEnabled = !this.autoCompileEnabled;
        const btn = document.getElementById('olc-btn-auto');
        if (btn) btn.classList.toggle('active', this.autoCompileEnabled);
        this._toast(this.autoCompileEnabled ? 'Auto-compilação: ON' : 'Auto-compilação: OFF', 'info');
    }

    // ─── Server Check (Hybrid) ─────────────────────────────────

    async _checkServers() {
        const dot = document.getElementById('olc-banner-dot');
        const text = document.getElementById('olc-banner-text');
        if (!dot || !text) return; // UI not ready

        if (!isExtensionContextValid()) {
            this._handleContextInvalidated();
            return;
        }

        try {
            // Ask background to find best server
            chrome.runtime.sendMessage({ action: 'GET_BEST_SERVER' }, (server) => {
                if (chrome.runtime.lastError) {
                    const msg = chrome.runtime.lastError.message;
                    if (msg && (msg.includes('invalidated') || msg.includes('shutting down'))) {
                        this._handleContextInvalidated();
                        return;
                    }
                    this._setServerStatus('offline', 'Offline');
                    return;
                }

                if (server && server.online) {
                    this.serverMode = server.mode;
                    const modeLabel = server.mode === 'cloud' ? '☁ Cloud' : '🖥 Local';
                    this._setServerStatus(server.mode, `${modeLabel} Online`);
                } else {
                    this._setServerStatus('offline', 'Offline');
                }
            });
        } catch (e) {
            if (e.message && e.message.includes('invalidated')) {
                this._handleContextInvalidated();
            }
        }
    }

    _handleContextInvalidated() {
        if (this.contextInvalidated) return; // Already handled

        console.warn('[OLC] Extension context invalidated. Cleanup.');
        this.contextInvalidated = true;

        if (this.serverCheckInterval) clearInterval(this.serverCheckInterval);
        if (this.autoCompileTimer) clearTimeout(this.autoCompileTimer);
        if (this.observer) this.observer.disconnect();

        const text = document.getElementById('olc-banner-text');
        const dot = document.getElementById('olc-banner-dot');

        if (text) text.textContent = '❌ Recarregue a página';
        if (dot) {
            dot.className = 'olc-banner-dot offline';
            dot.style.background = '#ef4444';
        }

        // Disable buttons
        const compileBtn = document.getElementById('olc-btn-compile');
        if (compileBtn) {
            compileBtn.disabled = true;
            compileBtn.title = 'Extensão atualizada - Recarregue a página';
        }

        this._toast('Extensão atualizada. Por favor, recarregue a página.', 'error');
    }

    _setServerStatus(mode, label) {
        const dot = document.getElementById('olc-banner-dot');
        const text = document.getElementById('olc-banner-text');
        if (dot) dot.className = `olc-banner-dot ${mode}`;
        if (text) text.textContent = label;
    }

    // ─── Compilation ───────────────────────────────────────────

    async _compile() {
        if (this.compiling) return;
        if (this.contextInvalidated) {
            this._toast('Extensão desatualizada. Recarregue a página.', 'error');
            return;
        }

        // Re-check server before starting
        if (this.serverMode === 'offline') {
            this._toast('Verificando servidores...', 'info');
            await new Promise(r => setTimeout(r, 500)); // Brief pause
            await this._checkServers();
            if (this.serverMode === 'offline') {
                return this._toast('Nenhum servidor disponível (Local ou Cloud).', 'error');
            }
        }

        this.compiling = true;
        this._updateUICompiling(true);
        this._showCompilingOverlay();

        try {
            // 1. Extract Full ZIP (Always do this as baseline for now)
            const data = await this.extractor.extractViaZIP();

            // 2. Incremental Check
            const delta = await this.synchronizer.createDeltaUpdate(data.blob);

            let action = 'COMPILE_LATEX';
            let payloadData = null;

            if (delta.hasChanges) {
                console.log(`[OLC] Delta Update: ${delta.deletedFiles.length} deleted, sending delta ZIP.`);
                // Convert delta blob to array buffer
                const deltaArray = Array.from(new Uint8Array(await delta.deltaBlob.arrayBuffer()));

                payloadData = {
                    type: 'delta_zip',
                    blob: deltaArray, // Will be chunked if large
                    projectId: data.projectId,
                    deletedFiles: delta.deletedFiles
                };
                action = 'COMPILE_LATEX_DELTA';
            } else {
                console.log('[OLC] No changes detected. Sending empty delta.');
                const emptyZip = new JSZip();
                const emptyBlob = await emptyZip.generateAsync({ type: 'blob' });
                const emptyArray = Array.from(new Uint8Array(await emptyBlob.arrayBuffer()));

                payloadData = {
                    type: 'delta_zip',
                    blob: emptyArray,
                    projectId: data.projectId,
                    deletedFiles: []
                };
                action = 'COMPILE_LATEX_DELTA';
            }

            // 3. Send to background (Chunked)
            let result;
            try {
                result = await this._sendChunkedMessage(action, payloadData);
            } catch (err) {
                // Se o servidor não suporta delta, fazer full compile
                if (err.message && (err.message.includes('DELTA_NOT_SUPPORTED') || err.message.includes('404'))) {
                    console.warn('[OLC] Delta not supported, falling back to full compile');
                    this._toast('Servidor não suporta compilação incremental. Fazendo compilação completa...', 'info');
                    this.synchronizer.reset(); // Reset para forçar full compile
                    result = await this._compileFull(data);
                } else {
                    throw err;
                }
            }

            // 4. Display
            const pdfBlob = new Blob([new Uint8Array(result.pdfData)], { type: 'application/pdf' });
            this._displayPdf(pdfBlob);

            const modeIcon = result.mode === 'cloud' ? '☁' : '🖥';
            this._toast(`${modeIcon} Compilado com sucesso!`, 'success');
            this._safeCheckServers();

        } catch (err) {
            console.error('[OLC] Compile error:', err);

            // SPECIAL RETRY LOGIC:
            // If delta compilation failed (generic error or explicit), try full compile once.
            // This fixes "Server has directory but it's empty/corrupt" or "Sync mismatch".
            if (action === 'COMPILE_LATEX_DELTA' && !this._isRetrying) {
                console.warn('[OLC] Delta failed. Retrying with Full Compile...', err);
                this._toast('Sincronização falhou. Tentando compilação completa...', 'info');

                this._isRetrying = true;
                this.synchronizer.reset(); // Clear local hashes to force full sync next time too

                try {
                    const fullData = await this.extractor.extractViaZIP();
                    const result = await this._compileFull(fullData);

                    // Success handling for retry
                    const pdfBlob = new Blob([new Uint8Array(result.pdfData)], { type: 'application/pdf' });
                    this._displayPdf(pdfBlob);

                    const modeIcon = result.mode === 'cloud' ? '☁' : '🖥';
                    this._toast(`${modeIcon} Recuperado com sucesso!`, 'success');
                    this._safeCheckServers();
                    return; // Exit function
                } catch (retryErr) {
                    console.error('[OLC] Retry failed:', retryErr);
                    this._toast(`Erro fatal: ${retryErr.message}`, 'error');
                } finally {
                    this._isRetrying = false;
                }
            } else {
                // Determine user-friendly error message
                let msg = err.message;
                if (msg === 'CACHE_MISS') msg = 'Projeto não encontrado no servidor.';
                if (msg === 'DELTA_NOT_SUPPORTED') msg = 'Servidor antigo (sem suporte a delta).';

                this._toast(`Erro: ${msg}`, 'error');
            }

            // Still reset synchronizer on critical errors to avoid getting stuck
            if (err.message && (err.message.includes('CACHE_MISS') || err.message.includes('ZIP'))) {
                this.synchronizer.reset();
            }
        } finally {
            this.compiling = false;
            this._updateUICompiling(false);
            this._hideCompilingOverlay();
        }
    }

    async _compileFull(data) {
        const arrayBuffer = await data.blob.arrayBuffer();
        const byteArray = Array.from(new Uint8Array(arrayBuffer));

        return this._sendChunkedMessage('COMPILE_LATEX', {
            type: 'zip',
            blob: byteArray,
            projectId: data.projectId
        });
    }

    async _sendChunkedMessage(action, data) {
        if (this.contextInvalidated || !isExtensionContextValid()) {
            throw new Error('Extension context invalidated');
        }

        const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB safety

        let size = 0;
        if (data.blob && Array.isArray(data.blob)) size += data.blob.length;
        else size = 100000; // Guess small

        if (size < CHUNK_SIZE) {
            // Send directly
            return new Promise((resolve, reject) => {
                try {
                    chrome.runtime.sendMessage({ action, data }, response => {
                        if (chrome.runtime.lastError) {
                            const msg = chrome.runtime.lastError.message;
                            if (msg && msg.includes('invalidated')) {
                                this._handleContextInvalidated();
                            }
                            reject(new Error(chrome.runtime.lastError.message));
                        }
                        else if (!response || !response.success) {
                            // Verificar se é erro de delta não suportado
                            if (response && response.error === 'DELTA_NOT_SUPPORTED') {
                                reject(new Error('DELTA_NOT_SUPPORTED'));
                            } else {
                                reject(new Error(response ? response.error : 'Unknown error'));
                            }
                        }
                        else resolve(response);
                    });
                } catch (e) {
                    if (e.message && e.message.includes('invalidated')) {
                        this._handleContextInvalidated();
                    }
                    reject(e);
                }
            });
        }

        console.log(`[OLC] Payload blob size ~${Math.round(size / 1024 / 1024)}MB. Chunking...`);

        if (!data.blob || !Array.isArray(data.blob)) {
            // Fallback direct
            return new Promise((resolve, reject) => {
                try {
                    chrome.runtime.sendMessage({ action, data }, response => {
                        if (chrome.runtime.lastError) {
                            const msg = chrome.runtime.lastError.message;
                            if (msg && msg.includes('invalidated')) {
                                this._handleContextInvalidated();
                            }
                            reject(new Error(chrome.runtime.lastError.message));
                        }
                        else if (!response.success) reject(new Error(response.error));
                        else resolve(response);
                    });
                } catch (e) {
                    if (e.message && e.message.includes('invalidated')) {
                        this._handleContextInvalidated();
                    }
                    reject(e);
                }
            });
        }

        const fullBlob = data.blob;
        const totalChunks = Math.ceil(fullBlob.length / CHUNK_SIZE);
        const transferId = Math.random().toString(36).substring(7);

        // Send chunks
        for (let i = 0; i < totalChunks; i++) {
            if (this.contextInvalidated) throw new Error('Extension context invalidated during upload');

            const chunk = fullBlob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            await new Promise((resolve, reject) => {
                try {
                    chrome.runtime.sendMessage({
                        action: 'CHUNK_UPLOAD',
                        data: {
                            transferId,
                            chunk, // Array of bytes
                            index: i,
                            total: totalChunks
                        }
                    }, res => {
                        if (chrome.runtime.lastError) {
                            const msg = chrome.runtime.lastError.message;
                            if (msg && msg.includes('invalidated')) {
                                this._handleContextInvalidated();
                            }
                            reject(new Error('Chunk transfer failed'));
                        }
                        else resolve();
                    });
                } catch (e) {
                    if (e.message && e.message.includes('invalidated')) {
                        this._handleContextInvalidated();
                    }
                    reject(e);
                }
            });
        }

        // Send finalize
        return new Promise((resolve, reject) => {
            if (this.contextInvalidated) {
                reject(new Error('Extension context invalidated'));
                return;
            }

            // Remove blob from original data, replace with ref
            const metaData = { ...data };
            delete metaData.blob;

            try {
                chrome.runtime.sendMessage({
                    action: 'CHUNK_FINALIZE',
                    data: {
                        transferId,
                        originalAction: action,
                        metaData
                    }
                }, response => {
                    if (chrome.runtime.lastError) {
                        const msg = chrome.runtime.lastError.message;
                        if (msg && msg.includes('invalidated')) {
                            this._handleContextInvalidated();
                        }
                        reject(new Error(chrome.runtime.lastError.message));
                    }
                    else if (!response || !response.success) {
                        if (response && response.error === 'DELTA_NOT_SUPPORTED') {
                            reject(new Error('DELTA_NOT_SUPPORTED'));
                        } else {
                            reject(new Error(response ? response.error : 'Unknown error'));
                        }
                    }
                    else resolve(response);
                });
            } catch (e) {
                if (e.message && e.message.includes('invalidated')) {
                    this._handleContextInvalidated();
                }
                reject(e);
            }
        });
    }

    _updateUICompiling(isCompiling) {
        const btn = document.getElementById('olc-btn-compile');
        const dot = document.getElementById('olc-banner-dot');
        const text = document.getElementById('olc-banner-text');

        if (btn) {
            btn.disabled = isCompiling || this.contextInvalidated;
            btn.textContent = isCompiling ? '⏳ ...' : '▶ Compilar';
        }
        if (dot) dot.className = isCompiling ? 'olc-banner-dot compiling' : `olc-banner-dot ${this.serverMode}`;
        if (text && isCompiling) text.textContent = 'Compilando...';
    }

    _showCompilingOverlay() {
        const container = document.getElementById('olc-pdf-container');
        if (!container) return;
        if (container.querySelector('.olc-compiling-overlay')) return;

        const overlay = document.createElement('div');
        overlay.className = 'olc-compiling-overlay';
        overlay.innerHTML = `
            <div class="olc-compiling-spinner"></div>
            <div>Compilando...</div>
        `;
        container.appendChild(overlay);
    }

    _hideCompilingOverlay() {
        document.querySelector('.olc-compiling-overlay')?.remove();
    }

    // ─── PDF Display ───────────────────────────────────────────

    _displayPdf(blob) {
        if (this.lastPdfUrl) URL.revokeObjectURL(this.lastPdfUrl);
        this.lastPdfBlob = blob;
        const url = URL.createObjectURL(blob);

        // #toolbar=0 hides the native chrome PDF toolbar
        // We also hide navpanes and scrollbar if desired, but focus is toolbar
        this.lastPdfUrl = `${url}#toolbar=0&navpanes=0`;

        let container = document.getElementById('olc-pdf-container');
        // If in floating mode, we might need to find the body inside
        const modalBody = container?.querySelector('.olc-modal-body');
        const target = modalBody || container;

        if (target) {
            target.innerHTML = `<iframe src="${this.lastPdfUrl}" style="width:100%; height:100%; border:none;"></iframe>`;
            this._updateVisibility(true);
        }

        // Enable buttons
        const dlBtns = document.querySelectorAll('#olc-btn-download');
        dlBtns.forEach(b => b.removeAttribute('disabled'));

        const wordBtns = document.querySelectorAll('#olc-btn-word');
        wordBtns.forEach(b => b.removeAttribute('disabled'));
    }

    _downloadPdf() {
        if (!this.lastPdfUrl) return this._toast('Compile primeiro!', 'warning');
        const a = document.createElement('a');
        a.href = this.lastPdfUrl;
        a.download = `overleaf-${Date.now()}.pdf`;
        a.click();
    }

    _toast(msg, type = 'info') {
        const t = document.createElement('div');
        t.className = 'olc-toast';
        t.textContent = msg;
        t.style.background = type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#3b82f6';
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    }

    _updateVisibility(visible) {
        const banner = document.getElementById('olc-status-banner');
        const float = document.getElementById('olc-floating-controls');
        const container = document.getElementById('olc-pdf-container');

        // Toggle Extension UI
        if (banner) banner.style.display = visible ? 'flex' : 'none';
        if (float) float.style.display = visible ? 'block' : 'none';
        if (container) container.style.display = visible ? 'flex' : 'none';

        // Toggle Native UI (Reverse logic)
        const pdfPanels = document.querySelectorAll('.ui-layout-pane, .pdf');
        let foundPanel = null;

        // Try to find the panel we injected into
        if (banner && banner.parentElement) {
            foundPanel = banner.parentElement;
        }

        if (foundPanel) {
            const originalViewer = foundPanel.querySelector('.pdf-viewer');
            const logsPane = foundPanel.querySelector('.new-logs-pane');
            const messagesDiv = foundPanel.querySelector('.pdf-preview-messages');

            if (originalViewer) originalViewer.style.display = visible ? 'none' : '';
            if (logsPane) logsPane.style.display = visible ? 'none' : '';
            if (messagesDiv) messagesDiv.style.display = visible ? 'none' : '';
        } else {
            // Fallback global search if banner removed or not found
            const originalViewer = document.querySelector('.pdf-viewer');
            if (originalViewer) originalViewer.style.display = visible ? 'none' : '';
        }
    }
}

// Initialize Loop
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new OverleafHybridCompiler());
} else {
    new OverleafHybridCompiler();
}