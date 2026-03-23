// extractor.js — Overleaf Project Extractor

// ═══════════════════════════════════════════════════════════════
//  OverleafExtractor
// ═══════════════════════════════════════════════════════════════

class OverleafExtractor {
    constructor() {
        this.projectId = this._extractProjectId();
    }

    _extractProjectId() {
        const m = window.location.pathname.match(/\/project\/([a-f0-9]{24})/);
        return m ? m[1] : null;
    }

    async extractViaZIP() {
        if (!this.projectId) throw new Error('Project ID não encontrado na URL.');
        const url = `https://www.overleaf.com/project/${this.projectId}/download/zip`;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`Falha ao baixar ZIP (status ${res.status})`);
        const blob = await res.blob();
        return { type: 'zip', blob, projectId: this.projectId };
    }

    /**
     * Tenta extrair apenas o arquivo ativo do editor (Muito mais rápido que ZIP)
     */
    extractActiveFile() {
        try {
            // 1. Encontrar nome do arquivo ativo na barra lateral
            const activeItem = document.querySelector('.file-tree-item.active');
            if (!activeItem) return null;

            const nameEl = activeItem.querySelector('.file-name');
            if (!nameEl) return null;

            // Para caminhos complexos (pastas), Overleaf costuma achatar ou usar labels
            // Vamos tentar pegar o label ou o texto
            const filename = nameEl.textContent.trim();

            // 2. Pegar conteúdo do CodeMirror 6
            const editorEl = document.querySelector('.cm-content');
            if (!editorEl) return null;

            // No CodeMirror 6 (usado pelo Overleaf novo), o texto fica em cm-content
            // mas pode estar fragmentado. O melhor é tentar acessar o estado se possível,
            // ou pegar innerText/textContent
            const content = editorEl.innerText || editorEl.textContent;

            // 3. Pegar posição do cursor (para SyncTeX)
            const selection = window.getSelection();
            let line = 1;
            if (selection.rangeCount > 0) {
                // Estimativa simples de linha baseada em elementos .cm-line
                const range = selection.getRangeAt(0);
                const lineEl = range.startContainer.parentElement?.closest('.cm-line');
                if (lineEl) {
                    const lines = Array.from(document.querySelectorAll('.cm-line'));
                    line = lines.indexOf(lineEl) + 1;
                }
            }

            return {
                filename,
                content,
                line: line > 0 ? line : 1,
                projectId: this.projectId
            };
        } catch (e) {
            console.warn('[OLC] Erro ao extrair arquivo ativo via DOM:', e);
            return null;
        }
    }
}
