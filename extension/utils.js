// utils.js — Shared Utilities and Configuration

// ═══════════════════════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
    serverUrl: 'http://localhost:8765', // Default, will update from settings
    cloudUrl: null,
    latexEngine: 'pdflatex',
    autoCompileDelay: 1000, // Reduced to 1s for "Instant" feel
    maxRetries: 2,
};

// ═══════════════════════════════════════════════════════════════
//  Context Validation Helper
// ═══════════════════════════════════════════════════════════════

function isExtensionContextValid() {
    try {
        return chrome.runtime && chrome.runtime.id !== undefined;
    } catch (e) {
        return false;
    }
}
