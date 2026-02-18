// synchronizer.js — Incremental Update Logic

// ═══════════════════════════════════════════════════════════════
//  ProjectSynchronizer (Incremental Updates)
// ═══════════════════════════════════════════════════════════════

class ProjectSynchronizer {
    constructor(projectId) {
        this.projectId = projectId;
        this.storageKey = `olc_hashes_${projectId}`;
        this.lastHashes = this._loadHashes();
    }

    _loadHashes() {
        try {
            return JSON.parse(localStorage.getItem(this.storageKey) || '{}');
        } catch (e) {
            return {};
        }
    }

    _saveHashes(hashes) {
        localStorage.setItem(this.storageKey, JSON.stringify(hashes));
        this.lastHashes = hashes;
    }

    async createDeltaUpdate(fullZipBlob) {
        const newHashes = {};
        const changedFiles = [];
        const deletedFiles = [];
        const deltaZip = new JSZip();
        let hasChanges = false;

        // 1. Load full ZIP
        const zip = await JSZip.loadAsync(fullZipBlob);

        // 2. Iterate files to find changes
        for (const [filename, fileObj] of Object.entries(zip.files)) {
            if (fileObj.dir) continue;

            const content = await fileObj.async('uint8array');
            const hash = await this._computeHash(content);
            newHashes[filename] = hash;

            // Check if changed
            if (this.lastHashes[filename] !== hash) {
                deltaZip.file(filename, content);
                changedFiles.push(filename);
                hasChanges = true;
            }
        }

        // 3. Identify deletions
        for (const oldFile of Object.keys(this.lastHashes)) {
            if (!newHashes[oldFile]) {
                deletedFiles.push(oldFile);
                hasChanges = true;
            }
        }

        // 4. Save new state
        if (hasChanges) {
            this._saveHashes(newHashes);
            const deltaBlob = await deltaZip.generateAsync({ type: 'blob' });
            return {
                hasChanges: true,
                deltaBlob: deltaBlob,
                deletedFiles: deletedFiles,
                isFull: false // It's a delta
            };
        }

        return { hasChanges: false };
    }

    async _computeHash(buffer) {
        // Simple fast hash (utilizing crypto.subtle)
        const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    reset() {
        localStorage.removeItem(this.storageKey);
        this.lastHashes = {};
    }
}
