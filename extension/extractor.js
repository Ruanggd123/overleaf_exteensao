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
}
