// background.js — Overleaf Local Compiler Service Worker
// Orchestrates compilation requests between content script and local server.

const DEFAULT_SERVER = 'https://meu-latex-server.onrender.com';

/**
 * Get the configured server URL from storage.
 */
async function getServerUrl() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['serverUrl'], (result) => {
            resolve(result.serverUrl || DEFAULT_SERVER);
        });
    });
}

// ─── Message Router ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    switch (request.action) {
        case 'COMPILE_LATEX':
            chrome.storage.local.get(['isActive'], (result) => {
                if (result.isActive === false) { // Default is true if undefined
                    sendResponse({ success: false, error: 'Extensão desativada pelo usuário.' });
                } else {
                    handleCompilation(request.data)
                        .then((result) => sendResponse({ success: true, ...result }))
                        .catch((error) => sendResponse({ success: false, error: error.message }));
                }
            });
            return true; // keep channel open for async response

        case 'CHECK_SERVER':
            checkServer()
                .then((result) => sendResponse(result))
                .catch(() => sendResponse({ online: false }));
            return true;

        case 'GET_SERVER_URL':
            getServerUrl().then((url) => sendResponse({ url }));
            return true;

        case 'SET_SERVER_URL':
            chrome.storage.local.set({ serverUrl: request.url }, () => {
                sendResponse({ saved: true });
            });
            return true;

        case 'SET_LATEX_ENGINE':
            chrome.storage.local.set({ latexEngine: request.engine }, () => {
                sendResponse({ saved: true });
            });
            return true;

        case 'SET_AUTH_TOKEN':
            chrome.storage.local.set({ authToken: request.token }, () => {
                sendResponse({ saved: true });
            });
            return true;

        case 'GET_SETTINGS':
            chrome.storage.local.get(['serverUrl', 'latexEngine', 'authToken'], (result) => {
                sendResponse({
                    serverUrl: result.serverUrl || DEFAULT_SERVER,
                    latexEngine: result.latexEngine || 'pdflatex',
                    authToken: result.authToken || '',
                });
            });
            return true;

        default:
            sendResponse({ error: 'Unknown action' });
            return false;
    }
});

// ─── Server Health Check ─────────────────────────────────────────

async function checkServer() {
    const serverUrl = await getServerUrl();
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(`${serverUrl}/status`, {
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
            const data = await response.json();
            return { online: true, ...data };
        }
        return { online: false };
    } catch {
        return { online: false };
    }
}

// ─── Compilation Handler ─────────────────────────────────────────

async function handleCompilation(projectData) {
    if (projectData.type === 'zip') {
        return compileFromZip(projectData.blob);
    }
    return compileFromFiles(projectData.files, projectData.mainFile);
}

/**
 * Compile from individual files sent as JSON.
 */
async function compileFromFiles(files, mainFile) {
    const serverUrl = await getServerUrl();

    // Get the configured engine
    const settings = await new Promise((resolve) => {
        chrome.storage.local.get(['latexEngine'], (r) => resolve(r));
    });
    const engine = settings.latexEngine || 'pdflatex';

    const response = await fetch(`${serverUrl}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, mainFile, engine }),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
            errorData.error || `Servidor retornou status ${response.status}`
        );
    }

    const pdfBuffer = await response.arrayBuffer();
    return { pdfData: Array.from(new Uint8Array(pdfBuffer)) };
}

/**
 * Compile from a ZIP blob.
 */
async function compileFromZip(zipBlobData) {
    const serverUrl = await getServerUrl();

    const settings = await new Promise((resolve) => {
        chrome.storage.local.get(['latexEngine'], (r) => resolve(r));
    });
    const engine = settings.latexEngine || 'pdflatex';

    // Reconstruct blob from array data
    const uint8 = new Uint8Array(zipBlobData);
    const blob = new Blob([uint8], { type: 'application/zip' });

    const formData = new FormData();
    formData.append('project', blob, 'project.zip');
    formData.append('engine', engine);

    const response = await fetch(`${serverUrl}/compile-zip`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
            errorData.error || `Servidor retornou status ${response.status}`
        );
    }

    const pdfBuffer = await response.arrayBuffer();
    return { pdfData: Array.from(new Uint8Array(pdfBuffer)) };
}
