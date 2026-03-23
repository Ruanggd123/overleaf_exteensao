// synchronizer.js — Incremental Update Logic

// ═══════════════════════════════════════════════════════════════
//  ProjectSynchronizer (Incremental Updates)
// ═══════════════════════════════════════════════════════════════

class ProjectSynchronizer {
    constructor(projectId) {
        this.projectId = projectId;
        this.storageKey = `olc_hashes_${projectId}`;
        this.lastHashes = {};
        this.ready = this._loadHashes();
    }

    async _loadHashes() {
        return new Promise((resolve) => {
            chrome.storage.local.get(this.storageKey, (data) => {
                this.lastHashes = data[this.storageKey] || {};
                resolve(this.lastHashes);
            });
        });
    }

    async _saveHashes(hashes) {
        return new Promise((resolve) => {
            const data = {};
            data[this.storageKey] = hashes;
            chrome.storage.local.set(data, () => {
                this.lastHashes = hashes;
                resolve();
            });
        });
    }

    async createDeltaUpdate(fullZipBlob) {
        await this.ready; // Ensure hashes are loaded
        
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
            await this._saveHashes(newHashes);
            const deltaBlob = await deltaZip.generateAsync({ type: 'blob' });
            return {
                hasChanges: true,
                deltaBlob: deltaBlob,
                deletedFiles: deletedFiles,
                isFull: false 
            };
        }

        return { hasChanges: false };
    }

    async createSingleFileDelta(filename, content) {
        await this.ready;

        // Compute hash of the new content
        const encoder = new TextEncoder();
        const buffer = encoder.encode(content);
        const hash = await this._computeHash(buffer);

        // Check if changed
        if (this.lastHashes[filename] === hash) {
            return { hasChanges: false };
        }

        // Create a delta ZIP with just this one file
        const deltaZip = new JSZip();
        deltaZip.file(filename, buffer);

        // Update local hash
        const newHashes = { ...this.lastHashes };
        newHashes[filename] = hash;
        await this._saveHashes(newHashes);

        const deltaBlob = await deltaZip.generateAsync({ type: 'blob' });
        return {
            hasChanges: true,
            deltaBlob: deltaBlob,
            deletedFiles: [],
            isFull: false
        };
    }

    async _computeHash(buffer) {
        const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    reset() {
        chrome.storage.local.remove(this.storageKey);
        this.lastHashes = {};
        this.ready = Promise.resolve({});
    }
}
