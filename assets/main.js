import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
import markdownItGithubAlerts from 'https://unpkg.com/markdown-it-github-alerts@1.0.1/dist/index.mjs';

const BOTTOM_PADDING = parseFloat(document.documentElement.dataset.bottomPadding) || 0.5;

/* ----- DOM ----- */
const $ = (id) => document.getElementById(id);
const contentEl = $('content');
const statusEl = $('status');
const themeBtn = $('themeBtn');
const statusDot = $('statusDot');
const loadingSkeleton = $('loadingSkeleton');

// Overlay refs
const overlay = $('overlay');
const overlayPanzoom = $('overlay-panzoom');
const overlayPanzoomInner = $('overlay-panzoom-inner');
const ovZoomIn = $('ovZoomIn');
const ovZoomOut = $('ovZoomOut');
const ovZoomReset = $('ovZoomReset');
const ovFitWidth = $('ovFitWidth');
const ovFitHeight = $('ovFitHeight');
const ovExport = $('ovExport');
const ovClose = $('ovClose');

// SVG paths for theme icons
const MOON_SVG = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
const SUN_SVG = '<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';

// SVG icons for copy button
const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg>';
const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ----- State ----- */
let lastContent = null;
let currentTheme = document.documentElement.dataset.theme || 'dark';
let mermaidIdCounter = 0;
let wsConnected = false;
let sock = null;
const loadedPacks = new Set();

// Live-reload auth token. Either substituted into the document by
// markdown-preview.nvim at file-write time, or passed via ?t=<token>
// in the URL on first load (then stashed in sessionStorage so it
// survives refreshes). Empty string when the server has no auth.
const LIVE_TOKEN = (() => {
    const fromAttr = document.documentElement.dataset.liveToken || '';
    // Split literal: a whole '__LIVE_TOKEN__' here would itself be
    // rewritten by write_index's substitution, turning this guard
    // into token !== token and breaking auth on tab reuse (issue #31).
    if (fromAttr && fromAttr !== '__LIVE' + '_TOKEN__') {
        try { sessionStorage.setItem('mdp-token', fromAttr); } catch (_) {}
        return fromAttr;
    }
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
        try { sessionStorage.setItem('mdp-token', fromUrl); } catch (_) {}
        return fromUrl;
    }
    try { return sessionStorage.getItem('mdp-token') || ''; } catch (_) { return ''; }
})();


const withToken = (url) => {
    if (!LIVE_TOKEN) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(LIVE_TOKEN);
};

// Scroll sync state
let scrollSyncPaused = false;
let scrollSyncPauseTimer = null;
let lastScrollData = null;

// Pause scroll sync briefly when user scrolls the browser manually
window.addEventListener('wheel', () => {
    scrollSyncPaused = true;
    clearTimeout(scrollSyncPauseTimer);
    scrollSyncPauseTimer = setTimeout(() => { scrollSyncPaused = false; }, 3000);
}, { passive: true });
window.addEventListener('touchmove', () => {
    scrollSyncPaused = true;
    clearTimeout(scrollSyncPauseTimer);
    scrollSyncPauseTimer = setTimeout(() => { scrollSyncPaused = false; }, 3000);
}, { passive: true });

// Overlay state
let ovSvgSource = '';
let ovBaseW = 0, ovBaseH = 0;
let ovZoom = 1;
let ovFitMode = 'width';
let ovDragging = false, ovStartX = 0, ovStartY = 0, ovStartL = 0, ovStartT = 0;

const setStatus = (t) => { if (statusEl) statusEl.textContent = t || ''; };
const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function setConnectionState(state) {
    statusDot.className = 'status-dot' + (state === 'connected' ? ' connected' : state === 'error' ? ' error' : '');
    statusDot.title = state === 'connected' ? 'Connected' : state === 'error' ? 'Disconnected' : 'Connecting...';
}

function showContent() {
    if (loadingSkeleton) loadingSkeleton.style.display = 'none';
    contentEl.style.display = '';
}

/* ----- Theme ----- */
function applyTheme(theme) {
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
    mermaid.initialize({
        startOnLoad: false,
        theme: theme === 'dark' ? 'dark' : 'default',
        securityLevel: 'strict',
    });
}

themeBtn.addEventListener('click', () => {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
    renderAllMermaidBlocks();
});

/* ----- Markdown-it setup ----- */
if (!window.markdownit) {
    console.error('[markdown-preview] markdown-it not loaded from CDN');
    showContent();
    contentEl.innerHTML = '<p style="color:var(--err-fg)">Failed to load markdown-it from CDN. Check your internet connection.</p>';
}
const md = (window.markdownit || function () { return { render: (t) => '<pre>' + t + '</pre>', utils: { escapeHtml: (s) => s } }; })({
    // Raw HTML passthrough is configurable: untrusted markdown can
    // otherwise inject handlers/scripts into this page. Defaults to
    // enabled (GitHub-like) when the attribute is absent.
    html: document.documentElement.dataset.allowHtml !== 'false',
    linkify: true,
    typographer: true,
    highlight: function (str, lang) {
        if (lang && lang.toLowerCase() === 'mermaid') {
            const encoded = encodeURIComponent(str);
            return `<div class="mermaid-block" data-mermaid-source="${encoded}"><div class="mermaid-svg-wrap"><p style="color:var(--fg-muted);font-size:.85rem">Rendering diagram&hellip;</p></div></div>`;
        }
        if (lang && window.hljs && window.hljs.getLanguage(lang)) {
            try {
                return '<pre class="hljs" data-lang="' + md.utils.escapeHtml(lang) + '"><code>' +
                    window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
                    '</code></pre>';
            } catch (_) { }
        }
        const langAttr = lang ? ' data-lang="' + md.utils.escapeHtml(lang) + '"' : '';
        return '<pre class="hljs"' + langAttr + '><code>' + md.utils.escapeHtml(str) + '</code></pre>';
    }
});

/* ----- Front matter -----
 * Inline block rule; the CDN build of markdown-it-front-matter is
 * CJS-only and never registered in a browser. Captured YAML goes to
 * the #fm-panel <details> (mode "panel") or is dropped ("hide");
 * mode "raw" skips the rule so the text renders as ordinary markdown.
 */
const YAML_MODE = document.documentElement.dataset.yamlMode || 'panel';
let capturedFrontMatter = null;
if (YAML_MODE !== 'raw') {
    md.block.ruler.before('table', 'front_matter', function (state, startLine, endLine, silent) {
        if (startLine !== 0 || state.blkIndent !== 0) return false;
        if (state.src.slice(state.bMarks[0], state.eMarks[0]) !== '---') return false;
        let closed = -1;
        for (let next = startLine + 1; next < endLine; next++) {
            if (state.tShift[next] > 0) continue;
            const line = state.src.slice(state.bMarks[next], state.eMarks[next]);
            if (/^-{3,}\s*$/.test(line)) { closed = next; break; }
        }
        // Unlike upstream, bail out when unclosed: while the fence is
        // still being typed, consuming to EOF would blank the preview.
        if (closed < 0) return false;
        if (silent) return true;
        capturedFrontMatter = state.src.slice(state.bMarks[1], state.bMarks[closed]);
        state.line = closed + 1;
        return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
}

function updateFrontMatterPanel() {
    const panel = $('fm-panel');
    if (!panel) return;
    if (YAML_MODE === 'panel' && capturedFrontMatter !== null) {
        const pre = $('fm-content');
        if (pre && pre.textContent !== capturedFrontMatter) pre.textContent = capturedFrontMatter;
        panel.style.display = '';
    } else {
        panel.style.display = 'none';
    }
}

// Register plugins
md.use(markdownItGithubAlerts);
if (window.markdownitEmoji) md.use(window.markdownitEmoji);
if (window.markdownitFootnote) md.use(window.markdownitFootnote);
if (window.markdownitTaskLists) md.use(window.markdownitTaskLists, { enabled: false });
if (window.markdownItAnchor) {
    md.use(window.markdownItAnchor, {
        permalink: false,
        slugify: (s) => s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, ''),
    });
}

// LaTeX math via KaTeX + texmath
if (window.texmath && window.katex) {
    md.use(window.texmath, {
        engine: window.katex,
        delimiters: ['dollars', 'beg_end'],
    });
}

// Line number injection for scroll sync (à la peek.nvim / iamcco)
function injectLineNumbers(tokens, idx, options, env, slf) {
    if (tokens[idx].map) {
        tokens[idx].attrJoin('class', 'source-line');
        tokens[idx].attrSet('data-source-line', String(tokens[idx].map[0]));
    }
    return slf.renderToken(tokens, idx, options, env, slf);
}
md.renderer.rules.paragraph_open = injectLineNumbers;
md.renderer.rules.heading_open = injectLineNumbers;
md.renderer.rules.list_item_open = injectLineNumbers;
md.renderer.rules.table_open = injectLineNumbers;
md.renderer.rules.blockquote_open = injectLineNumbers;

// Override fence renderer to handle mermaid specially
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const info = token.info ? token.info.trim().toLowerCase() : '';
    const lineAttr = token.map ? ` data-source-line="${token.map[0]}"` : '';
    if (info === 'mermaid') {
        const encoded = encodeURIComponent(token.content);
        const stableId = 'mmd-' + idx;
        return `<div class="mermaid-block source-line"${lineAttr} id="${stableId}" data-mermaid-source="${encoded}" data-graph="mermaid">` +
            `<button class="mermaid-expand-btn" title="Expand diagram" data-expand="${stableId}">` +
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
            `</button>` +
            `<div class="mermaid-svg-wrap"><p style="color:var(--fg-muted);font-size:.85rem">Rendering&hellip;</p></div>` +
            `</div>`;
    }
    let html;
    if (defaultFence) {
        html = defaultFence(tokens, idx, options, env, self);
    } else {
        html = self.renderToken(tokens, idx, options);
    }
    if (lineAttr) html = html.replace(/^<pre\b/, `<pre${lineAttr}`);
    // Wrap in a non-scrolling container so the language badge and the
    // copy button stay pinned while the <pre> scrolls horizontally.
    // Emitted here rather than in a DOM pass so morphdom's virtual
    // tree matches the live tree and code blocks patch in place.
    const langMatch = html.match(/^<pre[^>]*\bdata-lang="([^"]*)"/);
    const badge = langMatch ? `<span class="code-lang">${langMatch[1]}</span>` : '';
    return `<div class="code-wrap">${badge}${html}</div>`;
};


/* ----- Iconify auto-detection ---- */
function detectPacks(src) {
    const re = /\b([a-z0-9-]+):[a-z0-9-]+\b/gi;
    const s = new Set();
    let m;
    while ((m = re.exec(src))) s.add(m[1].toLowerCase());
    return [...s];
}


async function ensurePack(name) {
    if (loadedPacks.has(name)) return;
    try {
        const loader = () => fetch(`https://unpkg.com/@iconify-json/${name}@1/icons.json`).then(r => r.json());
        await mermaid.registerIconPacks([{ name, loader }]);
        loadedPacks.add(name);
    } catch (_) { }
}


/* ----- Mermaid rendering ----- */
const lastGoodSvg = {};


async function renderMermaidBlock(block) {
    const source = decodeURIComponent(block.dataset.mermaidSource || '');
    if (!source.trim()) return;

    const wrap = block.querySelector('.mermaid-svg-wrap');
    if (!wrap) return;

    const packs = detectPacks(source);
    for (const p of packs) await ensurePack(p);

    try {
        mermaidIdCounter++;
        const id = 'mmd-render-' + mermaidIdCounter;
        const { svg } = await mermaid.render(id, source);

        wrap.innerHTML = svg;
        block.classList.add('mermaid-rendered');
        block.classList.remove('mermaid-errored');
        lastGoodSvg[block.id] = svg;

        block.querySelectorAll('.error,.error-icon,.error-text,.errorText').forEach(n => n.remove());
    } catch (e) {
        block.classList.add('mermaid-errored');
        const fallback = lastGoodSvg[block.id];
        if (fallback) {
            wrap.innerHTML = fallback;
        }
        let errEl = block.querySelector('.mermaid-error');
        if (!errEl) {
            errEl = document.createElement('div');
            errEl.className = 'mermaid-error';
            block.appendChild(errEl);
        }
        const msg = String(e?.message || e || 'Invalid diagram')
            .split('\n').find(Boolean) || 'Invalid diagram';
        errEl.textContent = msg.replace(/\s*mermaid version\s*\d+(?:\.\d+)*\s*$/i, '').trim();

        block.querySelectorAll('.error,.error-icon,.error-text,.errorText').forEach(n => n.remove());
    }
}

async function renderAllMermaidBlocks() {
    const blocks = contentEl.querySelectorAll('.mermaid-block[data-mermaid-source]:not([data-prerendered])');
    for (const block of blocks) {
        await renderMermaidBlock(block);
    }
}

/* ----- Copy button on code blocks -----
 * Relative image paths resolve against the served workspace, which
 * only contains the rendered content — rewrite them to the token-
 * gated asset route, which resolves against the source file's dir.
 * Runs on the detached render tree BEFORE morphdom applies it, so
 * raw-HTML <img> tags never fire an unrewritten (404) request.
 */
function rewriteRelativeImages(rootEl) {
    rootEl.querySelectorAll('img[src]').forEach(img => {
        const src = img.getAttribute('src');
        if (!src || /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/|\/|#)/.test(src)) return;
        img.setAttribute('src', withToken('/__live/asset?p=' + encodeURIComponent(src)));
    });
}


function attachCopyButtons() {
    contentEl.querySelectorAll('.code-wrap').forEach(wrap => {
        if (wrap.querySelector('.copy-btn')) return;
        const pre = wrap.querySelector('pre');
        if (!pre) return;
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.title = 'Copy code';
        btn.innerHTML = COPY_ICON;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const code = pre.querySelector('code');
            if (!code) return;
            try {
                await navigator.clipboard.writeText(code.textContent);
                btn.innerHTML = CHECK_ICON;
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.innerHTML = COPY_ICON;
                    btn.classList.remove('copied');
                }, 1500);
            } catch (_) { }
        });
        wrap.appendChild(btn);
    });
}


/* ----- Content sync ----- */
async function fetchContent() {
    try {
        const resp = await fetch(withToken('content.md?ts=' + Date.now()), { cache: 'no-store' });
        if (!resp.ok) {
            console.warn('[markdown-preview] content.md fetch failed:', resp.status);
            if (resp.status === 401) {
                // Stale token (server restarted since this tab loaded).
                // Evict it so the next load bootstraps fresh.
                try { sessionStorage.removeItem('mdp-token'); } catch (_) {}
            }
            return null;
        }
        return (await resp.text()).replace(/\r\n?/g, '\n');
    } catch (e) {
        console.warn('[markdown-preview] content.md fetch error:', e);
        return null;
    }
}


async function sync(initial = false) {
    const text = await fetchContent();
    if (text == null) {
        if (initial) setStatus('Waiting for content...');
        return;
    }
    if (!initial && text === lastContent) return;
    lastContent = text;

    try {
        capturedFrontMatter = null;
        const html = md.render(text);
        updateFrontMatterPanel();

        showContent();

        if (window.morphdom) {
            const wrapper = document.createElement('div');
            wrapper.id = 'content';
            wrapper.innerHTML = html;
            rewriteRelativeImages(wrapper);

            window.morphdom(contentEl, wrapper, {
                childrenOnly: false,
                getNodeKey: function (node) {
                    if (node.nodeType === 1) {
                        if (node.getAttribute && node.getAttribute('data-graph') === 'mermaid') {
                            return node.id;
                        }
                        return node.id || null;
                    }
                    return null;
                },
                onBeforeElUpdated: function (fromEl, toEl) {
                    if (fromEl.classList && fromEl.classList.contains('mermaid-rendered') &&
                        fromEl.dataset.mermaidSource === toEl.dataset.mermaidSource) {
                        return false;
                    }
                    if (fromEl.tagName === 'DETAILS' && fromEl.hasAttribute('open')) {
                        toEl.setAttribute('open', '');
                    }
                    return true;
                },
            });
        } else {
            contentEl.innerHTML = html;
            rewriteRelativeImages(contentEl);
        }
        applyBottomPadding();

        const blocks = contentEl.querySelectorAll('.mermaid-block[data-mermaid-source]:not(.mermaid-rendered)');
        for (const block of blocks) {
            await renderMermaidBlock(block);
        }

        attachCopyButtons();

        setStatus('Updated ' + nowTime());
    } catch (e) {
        console.error('[markdown-preview] render error:', e);
        contentEl.innerHTML = '<pre style="white-space:pre-wrap;padding:1rem">' +
            text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
        setStatus('Render error: ' + e.message);
    }
}


/* ----- Scroll sync (line-based interpolation) ----- */
function getElementOffset(el) {
    let current = el;
    let top = 0;
    while (top === 0 && current) {
        top = current.getBoundingClientRect().top;
        current = current.parentElement;
    }
    return top + window.scrollY;
}

function scrollToSourceLine(line, total) {
    const elements = contentEl.querySelectorAll('[data-source-line]');
    if (!elements.length) return;

    // Edge: first or last line
    if (line <= 0) { window.scrollTo({ top: 0 }); return; }
    if (line >= total - 1) { window.scrollTo({ top: document.documentElement.scrollHeight }); return; }

    // Find element at/before cursor line and the one after
    let prev = null, next = null;
    for (const el of elements) {
        const elLine = Number(el.dataset.sourceLine);
        if (elLine <= line) {
            prev = { el, line: elLine };
        } else {
            next = { el, line: elLine };
            break;
        }
    }

    if (!prev) { window.scrollTo({ top: 0 }); return; }

    const prevTop = getElementOffset(prev.el);
    let offsetTop;

    if (next) {
        const nextTop = getElementOffset(next.el);
        const ratio = (line - prev.line) / (next.line - prev.line);
        offsetTop = prevTop + (nextTop - prevTop) * ratio;
    } else {
        // Last element — extrapolate using its height
        const h = prev.el.getBoundingClientRect().height;
        const linesLeft = Math.max(1, total - prev.line);
        offsetTop = prevTop + (line - prev.line) * (h / linesLeft);
    }

    // Center the target line in the viewport
    window.scrollTo({ top: Math.max(0, offsetTop - window.innerHeight / 2) });
    drawCursorOverlay(20, offsetTop, 16);
}


function drawCursorOverlay(x, y, height) {
    let cursorEl = document.getElementById('cursor');
    if (!cursorEl) {
        cursorEl = document.createElement('div');
        cursorEl.id = 'cursor';
        document.body.appendChild(cursorEl);
    }
    cursorEl.style.left = `${x}px`;
    cursorEl.style.top = `${y}px`;
    cursorEl.style.height = `${height}px`;
    cursorEl.style.display = 'block';
}


/* ----- Websocket ----- */
function connectWS() {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = withToken(`${wsProtocol}//${location.host}/__live/ws`);

    sock = new WebSocket(wsUrl);

    sock.addEventListener('open', () => {
        console.log('[markdown-preview] WebSocket connected');
        wsConnected = true;
        setConnectionState('connected');
    });

    sock.addEventListener('message', async (event) => {
        console.log('[markdown-preview] websocket message arrived')
        try {
            const data = JSON.parse(event.data);
            switch (data.type) {
                case "reload":
                    await sync(false);
                    break;
                case "cursor":
                    if (scrollSyncPaused) return;
                    try {
                        const data = JSON.parse(event.data);
                        console.log(data)
                        if (data.line == null) return;
                        lastScrollData = data;
                        scrollToSourceLine(data.line, data.total || 1);
                    } catch (_) {}
                    break;
                default:
                    break;
            }

        } catch (err) {
            console.log('[markdown-preview] WebSocket error: ', err);
        }
    });

    sock.addEventListener('close', () => {
        setConnectionState('error');
        console.log('[markdown-preview] WebSocket disconnected. Reconnecting in 2s...');
        setTimeout(connectWS, 2000); // Auto-reconnect safety net
    });

    sock.addEventListener('error', () => {
        console.log('[markdown-preview] websocket error')
        setConnectionState('error');
    });
}



/* ----- Expand overlay (fullscreen diagram zoom/pan) ----- */
function openOverlay(svgHtml) {
    ovSvgSource = svgHtml;
    overlayPanzoomInner.innerHTML = svgHtml;
    overlay.classList.add('active');

    const svg = overlayPanzoomInner.querySelector('svg');
    if (svg) {
        const vb = svg.getAttribute('viewBox');
        if (vb) {
            const parts = vb.trim().split(/\s+/).map(Number);
            if (parts.length === 4) { ovBaseW = parts[2]; ovBaseH = parts[3]; }
        } else {
            ovBaseW = parseFloat(svg.getAttribute('width')) || 800;
            ovBaseH = parseFloat(svg.getAttribute('height')) || 600;
        }
    }

    ovZoom = 1;
    ovFitMode = 'width';
    updateOverlayFit();
    updateOverlayFitBtns();
}


function closeOverlay() {
    overlay.classList.remove('active');
    overlayPanzoomInner.innerHTML = '';
}


function applyOverlayZoom() {
    const svg = overlayPanzoomInner.querySelector('svg');
    if (!svg || !ovBaseW || !ovBaseH) return;
    svg.removeAttribute('style');
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('width', String(Math.max(1, Math.round(ovBaseW * ovZoom))));
    svg.setAttribute('height', String(Math.max(1, Math.round(ovBaseH * ovZoom))));
    ovZoomReset.textContent = Math.round(ovZoom * 100) + '%';
}


function updateOverlayFit() {
    if (!ovBaseW || !ovBaseH) return;
    const cw = overlayPanzoom.clientWidth || ovBaseW;
    const ch = overlayPanzoom.clientHeight || ovBaseH;
    if (ovFitMode === 'width') ovZoom = cw / ovBaseW;
    else if (ovFitMode === 'height') ovZoom = ch / ovBaseH;
    ovZoom = Math.min(8, Math.max(0.1, ovZoom));
    applyOverlayZoom();
}


function updateOverlayFitBtns() {
    ovFitWidth.style.borderColor = ovFitMode === 'width' ? 'var(--accent)' : '';
    ovFitHeight.style.borderColor = ovFitMode === 'height' ? 'var(--accent)' : '';
}


ovZoomIn.addEventListener('click', () => { ovFitMode = 'none'; ovZoom *= 1.2; applyOverlayZoom(); updateOverlayFitBtns(); });
ovZoomOut.addEventListener('click', () => { ovFitMode = 'none'; ovZoom /= 1.2; applyOverlayZoom(); updateOverlayFitBtns(); });
ovZoomReset.addEventListener('click', () => { ovFitMode = 'none'; ovZoom = 1; applyOverlayZoom(); updateOverlayFitBtns(); });
ovFitWidth.addEventListener('click', () => { ovFitMode = ovFitMode === 'width' ? 'none' : 'width'; updateOverlayFit(); updateOverlayFitBtns(); });
ovFitHeight.addEventListener('click', () => { ovFitMode = ovFitMode === 'height' ? 'none' : 'height'; updateOverlayFit(); updateOverlayFitBtns(); });


// Overlay pan (drag)
overlayPanzoom.addEventListener('mousedown', (e) => {
    ovDragging = true; overlayPanzoom.classList.add('dragging');
    ovStartX = e.clientX; ovStartY = e.clientY;
    ovStartL = overlayPanzoom.scrollLeft; ovStartT = overlayPanzoom.scrollTop;
});
window.addEventListener('mousemove', (e) => {
    if (!ovDragging) return;
    overlayPanzoom.scrollLeft = ovStartL - (e.clientX - ovStartX);
    overlayPanzoom.scrollTop = ovStartT - (e.clientY - ovStartY);
});
window.addEventListener('mouseup', () => { ovDragging = false; overlayPanzoom.classList.remove('dragging'); });


// Overlay wheel zoom
overlayPanzoom.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        ovFitMode = 'none';
        ovZoom *= e.deltaY > 0 ? (1 / 1.1) : 1.1;
        applyOverlayZoom();
        updateOverlayFitBtns();
    }
}, { passive: false });


// Export SVG from overlay
ovExport.addEventListener('click', () => {
    if (!ovSvgSource) return;
    const blob = new Blob([ovSvgSource], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'diagram.svg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});


// Close overlay
ovClose.addEventListener('click', closeOverlay);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) {
        closeOverlay();
    }
});


// Resize handler for overlay fit
let ovResizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(ovResizeTimer);
    ovResizeTimer = setTimeout(() => {
        if (overlay.classList.contains('active') && ovFitMode !== 'none') {
            updateOverlayFit();
        }
    }, 80);
});

/* ----- Event delegation for expand buttons ----- */
contentEl.addEventListener('click', (e) => {
    const expandBtn = e.target.closest('[data-expand]');
    if (!expandBtn) return;
    const blockId = expandBtn.dataset.expand;
    const block = document.getElementById(blockId);
    if (!block) return;
    const wrap = block.querySelector('.mermaid-svg-wrap');
    if (!wrap) return;
    const svg = wrap.innerHTML;
    if (svg) openOverlay(svg);
});


// Re-apply scroll when layout shifts (images loading, etc.)
new ResizeObserver(() => {
    if (lastScrollData && !scrollSyncPaused) {
        scrollToSourceLine(lastScrollData.line, lastScrollData.total || 1);
    }
}).observe(contentEl);


// ── Bottom padding ────────────────────────────────────────────
function applyBottomPadding() {
    contentEl.style.paddingBottom = `${(1 - BOTTOM_PADDING) * window.innerHeight}px`;
}
window.addEventListener('resize', applyBottomPadding);


/* ----- Main ----- */
(async function main() {
    try {
        if (document.documentElement.dataset.mermaidElk === 'true') {
            const elkLayouts = await import('https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.2.1/dist/mermaid-layout-elk.esm.min.mjs');
            mermaid.registerLayoutLoaders(elkLayouts.default || elkLayouts);
        }
        applyTheme(currentTheme);
        await sync(true);
    } catch (e) {
        console.error('[markdown-preview] boot error:', e);
        showContent();
        contentEl.innerHTML = '<p style="color:var(--err-fg)">Error: ' + (e.message || e) + '</p>';
    }
    connectWS();
})();

