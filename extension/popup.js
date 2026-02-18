// popup.js
document.addEventListener('DOMContentLoaded', () => {
    // Elements
    const els = {
        extensionToggle: document.getElementById('extension-toggle'),
        localUrl: document.getElementById('local-url'),
        cloudUrl: document.getElementById('cloud-url'),
        authToken: document.getElementById('auth-token'),
        autoFallback: document.getElementById('auto-fallback'),
        btnSave: document.getElementById('btn-save'),
        localDot: document.getElementById('local-dot'),
        localStatus: document.getElementById('local-status'),
        cloudDot: document.getElementById('cloud-dot'),
        cloudStatus: document.getElementById('cloud-status'),
        toast: document.getElementById('toast')
    };

    // Load Settings
    chrome.storage.local.get(['showExtension', 'localUrl', 'cloudUrl', 'authToken', 'autoFallback'], (data) => {
        els.extensionToggle.checked = data.showExtension !== false; // Default true
        els.localUrl.value = data.localUrl || 'http://localhost:8765';
        els.cloudUrl.value = data.cloudUrl || '';
        els.authToken.value = data.authToken || '';
        els.autoFallback.checked = data.autoFallback !== false; // Default true

        checkStatus();
    });

    // Save
    els.btnSave.addEventListener('click', () => {
        saveSettings();
    });

    els.extensionToggle.addEventListener('change', () => {
        saveSettings(); // Save immediately on toggle
    });

    function saveSettings() {
        chrome.storage.local.set({
            showExtension: els.extensionToggle.checked,
            localUrl: els.localUrl.value.trim(),
            cloudUrl: els.cloudUrl.value.trim(),
            authToken: els.authToken.value.trim(),
            autoFallback: els.autoFallback.checked
        }, () => {
            showToast('Salvo com sucesso!');
            checkStatus();
        });
    }

    // Check Status via Background
    function checkStatus() {
        chrome.runtime.sendMessage({ action: 'CHECK_SERVERS' }, (res) => {
            if (chrome.runtime.lastError || !res) return;

            updateStatus(els.localDot, els.localStatus, res.local);
            updateStatus(els.cloudDot, els.cloudStatus, res.cloud);
        });
    }

    function updateStatus(dot, text, online) {
        if (online) {
            dot.className = 'status-dot local'; // Reusing 'local' class for green color
            text.textContent = 'Online';
        } else {
            dot.className = 'status-dot offline';
            text.textContent = 'Offline';
        }
    }

    function showToast(msg) {
        els.toast.textContent = msg;
        setTimeout(() => els.toast.textContent = '', 2000);
    }
});
