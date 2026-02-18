document.addEventListener('DOMContentLoaded', () => {
    // Elementos
    const localDot = document.getElementById('local-dot');
    const localText = document.getElementById('local-status');
    const cloudDot = document.getElementById('cloud-dot');
    const cloudText = document.getElementById('cloud-status');
    const inputs = {
        localUrl: document.getElementById('local-url'),
        cloudUrl: document.getElementById('cloud-url'),
        authToken: document.getElementById('auth-token'),
        engine: document.getElementById('engine')
    };
    const toggles = {
        cloud: document.getElementById('toggle-cloud'),
        fallback: document.getElementById('toggle-fallback')
    };

    // Carrega configurações
    chrome.runtime.sendMessage({ action: 'GET_SETTINGS' }, (s) => {
        if (chrome.runtime.lastError) return;

        inputs.localUrl.value = s.localUrl || 'http://localhost:8765';
        inputs.cloudUrl.value = s.cloudUrl || '';
        inputs.authToken.value = s.authToken || '';
        inputs.engine.value = s.engine || 'pdflatex';

        toggles.cloud.classList.toggle('active', s.useCloud);
        toggles.fallback.classList.toggle('active', s.autoFallback !== false);
    });

    // Verifica status
    function checkStatus() {
        chrome.runtime.sendMessage({ action: 'CHECK_SERVERS' }, (res) => {
            if (!res) return;

            // Local
            if (res.local?.online) {
                localDot.className = 'status-dot online';
                localText.textContent = '🖥️ Local online';
            } else {
                localDot.className = 'status-dot offline';
                localText.textContent = '❌ Local offline';
            }

            // Cloud
            if (res.cloud?.online) {
                cloudDot.className = 'status-dot online';
                cloudText.textContent = `☁️ Cloud online (${res.cloud.engines?.[0] || '?'})`;
            } else {
                cloudDot.className = res.cloudUrl ? 'status-dot offline' : 'status-dot checking';
                cloudText.textContent = res.cloudUrl ? '❌ Cloud offline' : '☁️ Cloud não configurado';
            }
        });
    }

    checkStatus();

    // Toggles
    Object.entries(toggles).forEach(([key, el]) => {
        el.addEventListener('click', () => el.classList.toggle('active'));
    });

    // Salvar
    document.getElementById('btn-save').addEventListener('click', () => {
        const settings = {
            serverUrl: inputs.localUrl.value.trim(),
            cloudUrl: inputs.cloudUrl.value.trim(),
            authToken: inputs.authToken.value.trim(),
            latexEngine: inputs.engine.value,
            useCloud: toggles.cloud.classList.contains('active'),
            autoFallback: toggles.fallback.classList.contains('active')
        };

        chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings }, () => {
            const btn = document.getElementById('btn-save');
            const original = btn.textContent;
            btn.textContent = '✅ Salvo!';
            btn.style.background = '#16a34a';
            setTimeout(() => {
                btn.textContent = original;
                btn.style.background = '';
                checkStatus();
            }, 1500);
        });
    });
});
