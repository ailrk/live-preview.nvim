import { setupMarkdown} from "./markdown.js";
import { setupOverlay } from "./overlay.js";
import { setupTheme } from "./theme.js";
import g, { showContent, applyBottomPadding } from "./global.js";
import { sync, connectWS, setupScrollSync } from "./sync.js";


(async function main() {
    connectWS();
    try {
        setupScrollSync();
        setupTheme();
        setupOverlay();
        setupMarkdown();

        // Bottom padding
        window.addEventListener('resize', applyBottomPadding);

        // On an image the cursor becomes an outline around it. Restyle #cursor.on-image
        // in your custom_css if you want something else.
        document.head.appendChild(Object.assign(document.createElement('style'), {
            textContent:
                `#cursor.on-image { background: transparent !important;
                 outline: 2px solid var(--accent, #4c8bf5);
                 outline-offset: 2px; border-radius: 4px; }`,
        }));

        await sync(true);
    } catch (e) {
        console.error('[live-preview] boot error:', e);
        showContent();
        g.contentEl.innerHTML = '<p style="color:var(--err-fg)">Error: ' + (e.message || e) + '</p>';
    }
})();
