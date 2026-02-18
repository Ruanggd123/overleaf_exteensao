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
            try {
                chrome.notifications.create({
                    type: 'basic',
                    iconUrl: 'icons/icon48.png',
                    title: 'Overleaf Hybrid Compiler',
                    message: 'Servidor local offline. Usando modo cloud ☁️'
                });
            } catch (e) {
                console.warn('[OLC Background] Notification error:', e);
            }
            return { ...cloudCheck, mode: 'cloud', fallback: true };
        }
    }

    return {
        online: false,
        error: 'Nenhum servidor disponível. Inicie o servidor local ou configure um cloud.'
    };
}

// ═════════════════════════════════════════════════════════════════
//  Chunk Management
// ═════════════════════════════════════════════════════════════════

const chunkBuffers = {};

async function handleChunkUpload(data) {
    const { transferId, chunk, index } = data;
    if (!chunkBuffers[transferId]) chunkBuffers[transferId] = [];
    // chunk is Array<number> from content script
    chunkBuffers[transferId][index] = new Uint8Array(chunk);
}

async function handleChunkFinalize(data) {
    const { transferId, originalAction, metaData } = data;
    if (!chunkBuffers[transferId]) throw new Error('Transfer ID not found in background');

    const chunks = chunkBuffers[transferId];
    // Reassemble
    let totalSize = 0;
    chunks.forEach(c => totalSize += c.length);

    const combined = new Uint8Array(totalSize);
    let offset = 0;
    chunks.forEach(c => {
        combined.set(c, offset);
        offset += c.length;
    });

    // Clean up
    delete chunkBuffers[transferId];

    // Reconstruct payload with the full blob as Array<number> (expected by handlers)
    const payload = { ...metaData, blob: Array.from(combined) };

    if (originalAction === 'COMPILE_LATEX') {
        return handleCompilation(payload);
    } else if (originalAction === 'COMPILE_LATEX_DELTA') {
        return handleDeltaCompilation(payload);
    } else {
        throw new Error('Unknown original action: ' + originalAction);
    }
}

// ═════════════════════════════════════════════════════════════════
//  Compilation Handlers
// ═════════════════════════════════════════════════════════════════

async function handleDeltaCompilation(data) {
    const server = await getBestServer();
    if (!server.online) throw new Error(server.error || 'Nenhum servidor disponível');

    const config = await getServerConfig();
    const headers = {};
    if (config.authToken && server.mode === 'cloud') {
        headers['Authorization'] = `Bearer ${config.authToken}`;
    }

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(data.blob)], { type: 'application/zip' });
    formData.append('delta_zip', blob, 'delta.zip');
    formData.append('deleted_files', JSON.stringify(data.deletedFiles || []));
    formData.append('projectId', data.projectId || '');
    formData.append('engine', config.engine);

    // IMPORTANTE: Verificar se o servidor suporta /compile-delta
    // Se não suportar, fazer fallback para compilação completa
    let response;
    let usedFallback = false;

    try {
        response = await fetch(`${server.url}/compile-delta`, {
            method: 'POST',
            headers,
            body: formData
        });

        // Se 404, o endpoint não existe - usar compilação completa como fallback
        if (response.status === 404) {
            console.warn('[OLC Background] /compile-delta not found, falling back to full compile');
            usedFallback = true;
            // Resetar o sincronizador no content script via erro especial
            throw new Error('DELTA_NOT_SUPPORTED');
        }
    } catch (e) {
        if (e.message === 'DELTA_NOT_SUPPORTED') throw e;
        // Erro de rede ou outro
        throw new Error(`Erro na requisição: ${e.message}`);
    }

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        // Pass specific error codes (like CACHE_MISS) through
        if (err.error === 'CACHE_MISS' || response.status === 410) {
            throw new Error('CACHE_MISS');
        }
        throw new Error(err.error || `Erro ${response.status}`);
    }

    const pdfBuffer = await response.arrayBuffer();
    return {
        pdfData: Array.from(new Uint8Array(pdfBuffer)),
        mode: server.mode,
        fallback: server.fallback || usedFallback || false
    };
}

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

// ═════════════════════════════════════════════════════════════════
//  Message Router
// ═════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        try {
            switch (request.action) {
                case 'COMPILE_LATEX':
                    try {
                        const result = await handleCompilation(request.data);
                        sendResponse({ success: true, ...result });
                    } catch (error) {
                        console.error('[OLC Background] COMPILE_LATEX error:', error);
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                case 'COMPILE_LATEX_DELTA':
                    try {
                        const result = await handleDeltaCompilation(request.data);
                        sendResponse({ success: true, ...result });
                    } catch (error) {
                        console.error('[OLC Background] COMPILE_LATEX_DELTA error:', error);
                        // Se o servidor não suporta delta, informar para fazer full compile
                        if (error.message === 'DELTA_NOT_SUPPORTED') {
                            sendResponse({ success: false, error: 'DELTA_NOT_SUPPORTED', retryWithFull: true });
                        } else {
                            sendResponse({ success: false, error: error.message });
                        }
                    }
                    break;

                case 'CHECK_SERVERS':
                    try {
                        const config = await getServerConfig();
                        const [local, cloud] = await Promise.all([
                            checkServer(config.localUrl),
                            config.cloudUrl ? checkServer(config.cloudUrl, config.authToken) : Promise.resolve({ online: false })
                        ]);
                        sendResponse({ local, cloud, config });
                    } catch (error) {
                        console.error('[OLC Background] CHECK_SERVERS error:', error);
                        sendResponse({ local: { online: false }, cloud: { online: false }, error: error.message });
                    }
                    break;

                case 'GET_BEST_SERVER':
                    try {
                        const best = await getBestServer();
                        sendResponse(best);
                    } catch (error) {
                        console.error('[OLC Background] GET_BEST_SERVER error:', error);
                        sendResponse({ online: false, error: error.message });
                    }
                    break;

                case 'SAVE_SETTINGS':
                    try {
                        await chrome.storage.local.set(request.settings);
                        sendResponse({ saved: true });
                    } catch (error) {
                        console.error('[OLC Background] SAVE_SETTINGS error:', error);
                        sendResponse({ saved: false, error: error.message });
                    }
                    break;

                case 'GET_SETTINGS':
                    try {
                        const settings = await getServerConfig();
                        sendResponse(settings);
                    } catch (error) {
                        console.error('[OLC Background] GET_SETTINGS error:', error);
                        sendResponse({ error: error.message });
                    }
                    break;

                case 'CHUNK_UPLOAD':
                    try {
                        await handleChunkUpload(request.data);
                        sendResponse({ success: true });
                    } catch (error) {
                        console.error('[OLC Background] CHUNK_UPLOAD error:', error);
                        sendResponse({ success: false, error: 'Chunk upload failed: ' + error.message });
                    }
                    break;

                case 'CHUNK_FINALIZE':
                    try {
                        const result = await handleChunkFinalize(request.data);
                        sendResponse({ success: true, ...result });
                    } catch (error) {
                        console.error('[OLC Background] CHUNK_FINALIZE error:', error);
                        sendResponse({ success: false, error: 'Chunk finalize failed: ' + error.message });
                    }
                    break;

                default:
                    console.warn('[OLC Background] Unknown action:', request.action);
                    sendResponse({ error: 'Ação desconhecida' });
            }
        } catch (globalError) {
            console.error('[OLC Background] Global handler error:', globalError);
            sendResponse({ success: false, error: 'Erro interno do background: ' + globalError.message });
        }
    })();
    return true; // Async response
});

// ═════════════════════════════════════════════════════════════════
//  Service Worker Lifecycle Management
// ═════════════════════════════════════════════════════════════════

// Keep alive para MV3 (enviar ping a cada 20 segundos para evitar suspensão)
setInterval(() => {
    // Operação simples para manter o SW ativo
    chrome.storage.local.get('lastPing', (data) => {
        chrome.storage.local.set({ lastPing: Date.now() });
    });
}, 20000);

console.log('[OLC Background] Service Worker iniciado');