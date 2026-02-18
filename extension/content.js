// content.js — Overleaf Hybrid Compiler (Embedded)
// Versão 2.1 - Suporte a fallback automático local/cloud

(function () {
    'use strict';
    if (window.__olcInjected) return;
    window.__olcInjected = true;

    const CONFIG = {
        autoCompileDelay: 5000,
        maxRetries: 2
    };

    class OverleafHybridCompiler {
        constructor() {
            this.extractor = new OverleafExtractor();
            this.compiling = false;
            this.serverMode = 'checking'; // 'local', 'cloud', 'offline'
            this.lastPdfUrl = null;
            this.autoCompileEnabled = false;

            this._init();
        }

        async _init() {
            await this._loadSettings();
            await this._waitForOverleafUI();
            this._setupUI();
            this._setupAutoCompile();
            this._checkServers();

            // Verifica status a cada 30s
            setInterval(() => this._checkServers(), 30000);

            console.log('[OLC] Hybrid Compiler initialized');
        }

        async _loadSettings() {
            return new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'GET_SETTINGS' }, (s) => {
                    if (!chrome.runtime.lastError && s) {
                        CONFIG.serverUrl = s.localUrl;
                        CONFIG.cloudUrl = s.cloudUrl;
                        CONFIG.engine = s.engine;
                        CONFIG.authToken = s.authToken;
                    }
                    resolve();
                });
            });
        }

        async _checkServers() {
            const dot = document.getElementById('olc-banner-dot');
            const text = document.getElementById('olc-banner-text');

            if (!dot || !text) return;

            dot.className = 'olc-banner-dot checking';
            text.textContent = 'Verificando servidores...';

            chrome.runtime.sendMessage({ action: 'GET_BEST_SERVER' }, (server) => {
                if (chrome.runtime.lastError || !server) {
                    this.serverMode = 'offline';
                    dot.className = 'olc-banner-dot offline';
                    text.textContent = '⚠️ Offline - Configure um servidor';
                    return;
                }

                if (server.online) {
                    this.serverMode = server.mode;
                    dot.className = `olc-banner-dot ${server.mode}`;

                    const modeLabel = server.mode === 'cloud' ? '☁️ Cloud' : '🖥️ Local';
                    const fallbackLabel = server.fallback ? ' (fallback)' : '';
                    text.textContent = `${modeLabel} online${fallbackLabel} • ${server.engines?.[0] || CONFIG.engine}`;

                    if (server.fallback) {
                        this._toast('Usando servidor cloud (local offline)', 'warning');
                    }
                } else {
                    this.serverMode = 'offline';
                    dot.className = 'olc-banner-dot offline';
                    text.textContent = '❌ Offline - Inicie o servidor local';
                }
            });
        }

        // ... (restante do content.js similar ao original, mas usando handleCompilation híbrido)

        async _compile() {
            if (this.compiling) return;

            // Força recheck se estiver offline
            if (this.serverMode === 'offline') {
                await this._checkServers();
                if (this.serverMode === 'offline') {
                    this._toast('Nenhum servidor disponível', 'error');
                    return;
                }
            }

            this.compiling = true;
            const btn = document.getElementById('olc-btn-compile');
            const dot = document.getElementById('olc-banner-dot');

            if (btn) {
                btn.disabled = true;
                btn.textContent = '⏳ Compilando...';
            }
            if (dot) dot.className = 'olc-banner-dot compiling';

            try {
                // Extrai projeto
                const data = await this.extractor.extractViaZIP();

                // Envia para background (que gerencia local/cloud)
                const result = await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({
                        action: 'COMPILE_LATEX',
                        data: {
                            type: 'zip',
                            blob: Array.from(new Uint8Array(await data.blob.arrayBuffer())),
                            projectId: data.projectId
                        }
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else if (!response.success) {
                            reject(new Error(response.error));
                        } else {
                            resolve(response);
                        }
                    });
                });

                // Mostra PDF
                const pdfBlob = new Blob([new Uint8Array(result.pdfData)], { type: 'application/pdf' });
                this._displayPdf(pdfBlob);

                const modeIcon = result.mode === 'cloud' ? '☁️' : '🖥️';
                this._toast(`${modeIcon} PDF compilado com sucesso!`, 'success');

            } catch (err) {
                console.error('[OLC] Erro:', err);
                this._toast(`❌ ${err.message}`, 'error');
            } finally {
                this.compiling = false;
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '▶ Compilar';
                }
                this._checkServers(); // Atualiza status
            }
        }

        // ... (resto dos métodos: _displayPdf, _downloadPdf, _toast, etc. - similares ao original)

        _setupUI() {
            // Mesma injeção de banner do original, mas com indicador de modo
            const pdfPanel = document.querySelector('.pdf, .pdf-viewer')?.closest('.pdf');
            if (!pdfPanel) return;

            // Remove anterior se existir
            document.getElementById('olc-status-banner')?.remove();

            const banner = document.createElement('div');
            banner.id = 'olc-status-banner';
            banner.innerHTML = `
                <div class="olc-banner-content">
                    <span class="olc-banner-dot checking" id="olc-banner-dot"></span>
                    <span id="olc-banner-text">Inicializando...</span>
                </div>
                <div class="olc-banner-actions">
                    <button id="olc-btn-compile" class="olc-banner-btn olc-btn-primary">▶ Compilar</button>
                    <button id="olc-btn-download" class="olc-banner-btn" disabled>⬇ PDF</button>
                    <button id="olc-btn-auto" class="olc-banner-btn olc-btn-auto" title="Auto-compilar">⚡ Auto</button>
                    <button id="olc-btn-settings" class="olc-banner-btn" title="Configurações">⚙️</button>
                </div>
            `;

            const messagesDiv = pdfPanel.querySelector('.pdf-preview-messages');
            if (messagesDiv) {
                pdfPanel.insertBefore(banner, messagesDiv);
            } else {
                pdfPanel.prepend(banner);
            }

            this._injectStyles();

            // Event listeners
            document.getElementById('olc-btn-compile')?.addEventListener('click', () => this._compile());
            document.getElementById('olc-btn-download')?.addEventListener('click', () => this._downloadPdf());
            document.getElementById('olc-btn-auto')?.addEventListener('click', () => this._toggleAutoCompile());
            document.getElementById('olc-btn-settings')?.addEventListener('click', () => {
                chrome.runtime.openOptionsPage?.() || window.open(chrome.runtime.getURL('popup.html'));
            });
        }

        _injectStyles() {
            if (document.getElementById('olc-styles')) return;

            const style = document.createElement('style');
            style.id = 'olc-styles';
            style.textContent = `
                /* Estilos base do original + indicadores de modo */
                #olc-status-banner {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 8px 16px;
                    background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
                    border-bottom: 1px solid #334155;
                    font-family: system-ui, sans-serif;
                    font-size: 13px;
                    color: #e2e8f0;
                }
                .olc-banner-dot {
                    width: 10px; height: 10px;
                    border-radius: 50%;
                    margin-right: 8px;
                    transition: all 0.3s;
                }
                .olc-banner-dot.local { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
                .olc-banner-dot.cloud { background: #3b82f6; box-shadow: 0 0 8px #3b82f6; }
                .olc-banner-dot.offline { background: #ef4444; }
                .olc-banner-dot.checking { background: #f59e0b; animation: pulse 1s infinite; }
                .olc-banner-dot.compiling { background: #8b5cf6; animation: pulse 0.5s infinite; }
                @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
                
                .olc-banner-btn {
                    padding: 6px 12px;
                    margin-left: 8px;
                    border: 1px solid #475569;
                    border-radius: 6px;
                    background: #334155;
                    color: #f1f5f9;
                    cursor: pointer;
                    font-size: 12px;
                    transition: all 0.2s;
                }
                .olc-banner-btn:hover:not(:disabled) { background: #475569; }
                .olc-banner-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .olc-btn-primary { background: #22c55e; border-color: #22c55e; }
                .olc-btn-primary:hover:not(:disabled) { background: #16a34a; }
                .olc-btn-auto.active { background: #3b82f6; border-color: #3b82f6; }
            `;
            document.head.appendChild(style);
        }

        _toggleAutoCompile() {
            this.autoCompileEnabled = !this.autoCompileEnabled;
            const btn = document.getElementById('olc-btn-auto');
            btn?.classList.toggle('active', this.autoCompileEnabled);
            this._toast(this.autoCompileEnabled ? 'Auto-compilação ativada' : 'Auto-compilação desativada', 'info');
        }

        _setupAutoCompile() {
            let timeout;
            document.addEventListener('keydown', (e) => {
                if (!this.autoCompileEnabled) return;
                const isEditor = e.target.closest('.cm-editor, .CodeMirror');
                if (!isEditor) return;

                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    if (!this.compiling) this._compile();
                }, CONFIG.autoCompileDelay);
            });
        }

        _displayPdf(blob) {
            if (this.lastPdfUrl) URL.revokeObjectURL(this.lastPdfUrl);
            this.lastPdfUrl = URL.createObjectURL(blob);

            const container = document.getElementById('olc-pdf-container') || this._createPdfContainer();
            container.innerHTML = `<iframe src="${this.lastPdfUrl}" style="width:100%;height:100%;border:none;"></iframe>`;

            document.getElementById('olc-btn-download')?.removeAttribute('disabled');
        }

        _createPdfContainer() {
            const panel = document.querySelector('.pdf') || document.querySelector('.pdf-viewer')?.closest('.pdf');
            const container = document.createElement('div');
            container.id = 'olc-pdf-container';
            container.style.cssText = 'flex:1;min-height:0;display:flex;';

            const viewer = panel?.querySelector('.pdf-viewer');
            if (viewer) viewer.style.display = 'none';

            panel?.appendChild(container);
            return container;
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
            t.className = `olc-toast ${type}`;
            t.textContent = msg;
            t.style.cssText = `
                position: fixed; bottom: 20px; right: 20px;
                padding: 12px 20px; border-radius: 8px;
                color: white; font-family: system-ui; z-index: 10000;
                animation: slideIn 0.3s ease;
                ${type === 'success' ? 'background: #22c55e;' :
                    type === 'error' ? 'background: #ef4444;' :
                        type === 'warning' ? 'background: #f59e0b;' : 'background: #3b82f6;'}
            `;
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 3000);
        }

        async _waitForOverleafUI() {
            return new Promise(resolve => {
                const check = () => {
                    if (document.querySelector('.pdf, .pdf-viewer')) resolve();
                    else setTimeout(check, 500);
                };
                check();
            });
        }
    }

    class OverleafExtractor {
        constructor() {
            this.projectId = window.location.pathname.match(/\/project\/([a-f0-9]{24})/)?.[1];
        }

        async extractViaZIP() {
            if (!this.projectId) throw new Error('ID do projeto não encontrado');

            const res = await fetch(`https://www.overleaf.com/project/${this.projectId}/download/zip`, {
                credentials: 'include'
            });

            if (!res.ok) throw new Error(`Falha ao baixar ZIP: ${res.status}`);

            return {
                type: 'zip',
                blob: await res.blob(),
                projectId: this.projectId
            };
        }
    }

    // Inicializa
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new OverleafHybridCompiler());
    } else {
        new OverleafHybridCompiler();
    }
})();
