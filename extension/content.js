// content.js — Overleaf Hybrid Compiler (Embedded)
// Versão 2.2 - Fix UI Injection & Fallback

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
            this.observer = null;
            this._warnedFallback = false; // Para evitar spam de toast

            this._init();
        }

        async _init() {
            await this._loadSettings();
            this._injectStyles();
            this._startObserver();
            this._setupAutoCompile(); // Setup auto-compile once
            console.log('[OLC] Hybrid Compiler v2.2 initialized');
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

        _startObserver() {
            // Observa mudanças no DOM para injetar a UI quando possível
            this.observer = new MutationObserver(() => {
                this._tryInjectUI();
            });

            this.observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            // Tenta injetar imediatamente também
            this._tryInjectUI();
        }

        _tryInjectUI() {
            if (document.getElementById('olc-status-banner')) return;

            // Seletores possíveis para a área do PDF
            const targets = [
                '.pdf-preview-messages', // Ideal (acima do PDF)
                '.pdf .toolbar',         // Alternativa
                '.pdf-viewer',           // Fallback
                '.pdf',                  // Genérico
                'main'                   // Último caso
            ];

            let targetEl = null;
            let insertMethod = 'prepend';

            for (const selector of targets) {
                const el = document.querySelector(selector);
                if (el) {
                    targetEl = el;
                    // Se for .pdf-preview-messages, queremos append (ou replace)
                    if (selector === '.pdf-preview-messages') insertMethod = 'append';
                    break;
                }
            }

            if (targetEl) {
                this._injectBanner(targetEl, insertMethod);
                this._checkServers(); // Check inicial
                // Inicia o check de servidores a cada 30s após a UI ser injetada
                setInterval(() => this._checkServers(), 30000);
            }
        }

        _injectBanner(target, method) {
            console.log('[OLC] Injecting banner into:', target);

            const banner = document.createElement('div');
            banner.id = 'olc-status-banner';
            banner.innerHTML = `
                <div class="olc-banner-content">
                    <span class="olc-banner-dot checking" id="olc-banner-dot"></span>
                    <span id="olc-banner-text">Verificando...</span>
                </div>
                <div class="olc-banner-actions">
                    <button id="olc-btn-compile" class="olc-banner-btn olc-btn-primary">▶ Compilar</button>
                    <button id="olc-btn-download" class="olc-banner-btn" disabled>⬇ PDF</button>
                    <button id="olc-btn-auto" class="olc-banner-btn" title="Auto-compilar">⚡ Auto</button>
                    <button id="olc-btn-settings" class="olc-banner-btn" title="Configurações">⚙️</button>
                </div>
            `;

            if (method === 'prepend') target.prepend(banner);
            else target.appendChild(banner);

            // Re-bind events
            document.getElementById('olc-btn-compile').addEventListener('click', () => this._compile());
            document.getElementById('olc-btn-download').addEventListener('click', () => this._downloadPdf());
            document.getElementById('olc-btn-auto').addEventListener('click', () => this._toggleAutoCompile());
            document.getElementById('olc-btn-settings').addEventListener('click', () => {
                chrome.runtime.openOptionsPage?.() || window.open(chrome.runtime.getURL('popup.html'));
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
                    text.textContent = '❌ Offline';
                    return;
                }

                if (server.online) {
                    this.serverMode = server.mode;
                    dot.className = `olc-banner-dot ${server.mode}`;

                    const modeLabel = server.mode === 'cloud' ? '☁️ Cloud' : '🖥️ Local';
                    const fallbackLabel = server.fallback ? ' (fallback)' : '';
                    text.textContent = `${modeLabel}${fallbackLabel}`;

                    if (server.fallback && !this._warnedFallback) {
                        this._toast('Usando servidor cloud (local offline)', 'warning');
                        this._warnedFallback = true;
                    }
                } else {
                    this.serverMode = 'offline';
                    dot.className = 'olc-banner-dot offline';
                    text.textContent = '❌ Offline';
                }
            });
        }

        async _compile() {
            if (this.compiling) return;

            // Força recheck
            if (this.serverMode === 'offline') {
                this._toast('Verificando conexão...', 'info');
                await new Promise(r => setTimeout(r, 1000));
                await this._checkServers();
                if (this.serverMode === 'offline') {
                    return this._toast('Nenhum servidor disponível!', 'error');
                }
            }

            this.compiling = true;
            const btn = document.getElementById('olc-btn-compile');
            const dot = document.getElementById('olc-banner-dot');

            if (btn) {
                btn.disabled = true;
                btn.textContent = '⏳ ...';
            }
            if (dot) dot.className = 'olc-banner-dot compiling';

            try {
                const data = await this.extractor.extractViaZIP();

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

                const pdfBlob = new Blob([new Uint8Array(result.pdfData)], { type: 'application/pdf' });
                this._displayPdf(pdfBlob);

                const modeIcon = result.mode === 'cloud' ? '☁️' : '🖥️';
                this._toast(`${modeIcon} Sucesso!`, 'success');

            } catch (err) {
                console.error('[OLC] Erro:', err);
                this._toast(`❌ ${err.message}`, 'error');
            } finally {
                this.compiling = false;
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '▶ Compilar';
                }
                this._checkServers();
            }
        }

        _displayPdf(blob) {
            if (this.lastPdfUrl) URL.revokeObjectURL(this.lastPdfUrl);
            this.lastPdfUrl = URL.createObjectURL(blob);

            // Tenta encontrar container existente ou cria um novo
            let container = document.getElementById('olc-pdf-container');
            if (!container) {
                // Tenta injetar na área do visualizador nativo
                const pdfViewer = document.querySelector('.pdf-viewer');
                const pdfArea = document.querySelector('.pdf');

                if (pdfViewer) {
                    pdfViewer.style.display = 'none'; // Esconde nativo
                    container = document.createElement('div');
                    container.id = 'olc-pdf-container';
                    container.style.cssText = 'flex:1;height:100%;display:flex;flex-direction:column;';
                    pdfViewer.parentNode.insertBefore(container, pdfViewer);
                } else if (pdfArea) {
                    container = document.createElement('div');
                    container.id = 'olc-pdf-container';
                    container.style.cssText = 'flex:1;height:100%;display:flex;flex-direction:column;';
                    pdfArea.appendChild(container);
                } else {
                    // Fallback extremo
                    window.open(this.lastPdfUrl, '_blank');
                    return;
                }
            }

            container.innerHTML = `<iframe src="${this.lastPdfUrl}" style="width:100%;height:100%;border:none;background:#525659;"></iframe>`;
            document.getElementById('olc-btn-download')?.removeAttribute('disabled');
        }

        _downloadPdf() {
            if (!this.lastPdfUrl) return this._toast('Compile primeiro!', 'warning');
            const a = document.createElement('a');
            a.href = this.lastPdfUrl;
            a.download = `overleaf-hybrid-${Date.now()}.pdf`;
            a.click();
        }

        _toggleAutoCompile() {
            this.autoCompileEnabled = !this.autoCompileEnabled;
            const btn = document.getElementById('olc-btn-auto');
            btn?.classList.toggle('active', this.autoCompileEnabled);
            this._toast(`Auto-compilação: ${this.autoCompileEnabled ? 'ON' : 'OFF'}`, 'info');
        }

        _setupAutoCompile() {
            let timeout;
            document.addEventListener('keydown', (e) => {
                if (!this.autoCompileEnabled) return;
                // Detecta digitação em qualquer lugar (editores podem capturar eventos)
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    if (!this.compiling) this._compile();
                }, CONFIG.autoCompileDelay);
            });
        }

        _injectStyles() {
            if (document.getElementById('olc-styles')) return;
            const style = document.createElement('style');
            style.id = 'olc-styles';
            style.textContent = `
                #olc-status-banner {
                    display: flex; align-items: center; justify-content: space-between;
                    padding: 8px 12px;
                    background: #1e293b; border-bottom: 1px solid #334155;
                    font-family: system-ui, sans-serif; font-size: 13px; color: #e2e8f0;
                    margin-bottom: 0; z-index: 100;
                }
                .olc-banner-dot {
                    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
                    margin-right: 6px; background: #94a3b8;
                }
                .olc-banner-dot.local { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
                .olc-banner-dot.cloud { background: #3b82f6; box-shadow: 0 0 6px #3b82f6; }
                .olc-banner-dot.offline { background: #ef4444; }
                .olc-banner-dot.checking { background: #f59e0b; animation: pulse 1s infinite; }
                .olc-banner-dot.compiling { background: #8b5cf6; animation: pulse 0.5s infinite; }

                .olc-banner-actions { display: flex; gap: 8px; }

                .olc-banner-btn {
                    padding: 4px 10px; border: 1px solid #475569; border-radius: 4px;
                    background: #334155; color: #f1f5f9; cursor: pointer;
                    font-size: 11px; transition: all 0.2s;
                }
                .olc-banner-btn:hover:not(:disabled) { background: #475569; }
                .olc-banner-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .olc-btn-primary { background: #22c55e; border-color: #22c55e; font-weight: 600; }
                .olc-btn-primary:hover:not(:disabled) { background: #16a34a; }
                .olc-btn-auto.active { background: #3b82f6; border-color: #3b82f6; }

                .olc-toast {
                    position: fixed; bottom: 20px; right: 20px;
                    padding: 10px 16px; border-radius: 6px;
                    color: white; font-family: system-ui; font-size: 13px;
                    z-index: 99999; box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    animation: slideIn 0.3s ease;
                }
                @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
                @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
            `;
            document.head.appendChild(style);
        }

        _toast(msg, type = 'info') {
            const t = document.createElement('div');
            t.className = `olc-toast ${type}`;
            t.textContent = msg;
            t.style.background = type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#3b82f6';
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 3000);
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
            if (!res.ok) throw new Error(`Status ${res.status}`);
            return {
                type: 'zip',
                blob: await res.blob(),
                projectId: this.projectId
            };
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new OverleafHybridCompiler());
    } else {
        new OverleafHybridCompiler();
    }
})();
