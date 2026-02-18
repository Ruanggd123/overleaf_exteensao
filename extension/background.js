// background.js — Overleaf Hybrid Compiler
// Gerencia fallback automático: Local → Cloud

const DEFAULT_LOCAL = 'http://localhost:8765';
const DEFAULT_CLOUD = ''; // Usuário configura URL do Railway/Render

/**
 * Get server configuration with fallback logic
 */
async function getServerConfig() {
    const result = await chrome.storage.local.get([
        'serverUrl',
        'cloudUrl',
        'useCloud',
        'authToken',
        'latexEngine',
        'autoFallback'
    ]);

    return {
        localUrl: result.serverUrl || DEFAULT_LOCAL,
        cloudUrl: result.cloudUrl || '',
        useCloud: result.useCloud || false,
        authToken: result.authToken || '',
        engine: result.latexEngine || 'pdflatex',
        autoFallback: result.autoFallback !== false // default true
    };
}

/**
 * Check if server is online
 */
async function checkServer(url, authToken = '') {
    try {
        const headers = {};
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(`${url}/status`, {
            signal: controller.signal,
            headers
        });
        clearTimeout(timeout);

        if (response.ok) {
            const data = await response.json();
            return { online: true, ...data, url };
        }
        return { online: false, url };
    } catch (e) {
        return { online: false, url, error: e.message };
    }
}

/**
 * Determine best available server (local first, then cloud)
 */
async function getBestServer() {
    const config = await getServerConfig();

    // Se usuário forçou modo cloud
    if (config.useCloud && config.cloudUrl) {
        const cloudCheck = await checkServer(config.cloudUrl, config.authToken);
        if (cloudCheck.online) return { ...cloudCheck, mode: 'cloud' };
        return { online: false, error: 'Servidor cloud indisponível' };
    }

    // Tenta local primeiro
    const localCheck = await checkServer(config.localUrl);
    if (localCheck.online) return { ...localCheck, mode: 'local' };

    // Fallback para cloud se habilitado
    if (config.autoFallback && config.cloudUrl) {
        const cloudCheck = await checkServer(config.cloudUrl, config.authToken);
        if (cloudCheck.online) {
            // Notifica usuário sobre fallback
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon48.png',
                title: 'Overleaf Hybrid Compiler',
                message: 'Servidor local offline. Usando modo cloud ☁️'
            });
            return { ...cloudCheck, mode: 'cloud', fallback: true };
        }
    }

    return {
        online: false,
        error: 'Nenhum servidor disponível. Inicie o servidor local ou configure um cloud.'
    };
}

// ─── Message Router ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        switch (request.action) {
            case 'COMPILE_LATEX':
                try {
                    const result = await handleCompilation(request.data);
                    sendResponse({ success: true, ...result });
                } catch (error) {
                    sendResponse({ success: false, error: error.message });
                }
                break;

            case 'CHECK_SERVERS':
                const config = await getServerConfig();
                const [local, cloud] = await Promise.all([
                    checkServer(config.localUrl),
                    config.cloudUrl ? checkServer(config.cloudUrl, config.authToken) : Promise.resolve({ online: false })
                ]);
                sendResponse({ local, cloud, config });
                break;

            case 'GET_BEST_SERVER':
                const best = await getBestServer();
                sendResponse(best);
                break;

            case 'SAVE_SETTINGS':
                await chrome.storage.local.set(request.settings);
                sendResponse({ saved: true });
                break;

            case 'GET_SETTINGS':
                const settings = await getServerConfig();
                sendResponse(settings);
                break;

            default:
                sendResponse({ error: 'Ação desconhecida' });
        }
    })();
    return true; // Async response
});

// ─── Compilation Handler ─────────────────────────────────────────

async function handleCompilation(projectData) {
    const server = await getBestServer();

    if (!server.online) {
        throw new Error(server.error || 'Nenhum servidor disponível');
    }

    const config = await getServerConfig();
    const headers = {};
    if (config.authToken && server.mode === 'cloud') {
        headers['Authorization'] = `Bearer ${config.authToken}`;
    }

    // Compilação via ZIP (mais confiável)
    if (projectData.type === 'zip' || projectData.blob) {
        const formData = new FormData();
        const blob = new Blob([new Uint8Array(projectData.blob)], { type: 'application/zip' });
        formData.append('project', blob, 'project.zip');
        formData.append('engine', config.engine);
        if (projectData.projectId) formData.append('projectId', projectData.projectId);

        const response = await fetch(`${server.url}/compile-zip`, {
            method: 'POST',
            headers,
            body: formData
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Erro ${response.status}`);
        }

        const pdfBuffer = await response.arrayBuffer();
        return {
            pdfData: Array.from(new Uint8Array(pdfBuffer)),
            mode: server.mode,
            fallback: server.fallback || false
        };
    }

    // Compilação via JSON (arquivos individuais)
    const response = await fetch(`${server.url}/compile`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers
        },
        body: JSON.stringify({
            files: projectData.files,
            mainFile: projectData.mainFile,
            engine: config.engine,
            projectId: projectData.projectId
        })
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Erro ${response.status}`);
    }

    const pdfBuffer = await response.arrayBuffer();
    return {
        pdfData: Array.from(new Uint8Array(pdfBuffer)),
        mode: server.mode,
        fallback: server.fallback || false
    };
}
