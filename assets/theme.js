import { mermaid } from "./mermaid.js";
import { $ } from './global.js';

// SVG paths for theme icons
const MOON_SVG = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
const SUN_SVG = '<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';

const themeBtn = $('themeBtn');

export let currentTheme = document.documentElement.dataset.theme || 'dark';

export function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    const themeIcon = $('themeIcon');
    if (themeIcon) themeIcon.innerHTML = theme === 'dark' ? MOON_SVG : SUN_SVG;
    const hljsLink = $('hljs-theme');
    if (hljsLink) {
        hljsLink.href = theme === 'dark'
            ? 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css'
            : 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css';
    }
    if (mermaid) {
        mermaid.initialize({
            startOnLoad: false,
            theme: theme === 'dark' ? 'dark' : 'default',
            securityLevel: 'strict',
        });
    }
}

export function setupTheme() {
    // Theme toggle
    themeBtn.addEventListener('click', () => {
        applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
        renderAllMermaidBlocks();
    });

    applyTheme(currentTheme);
}
