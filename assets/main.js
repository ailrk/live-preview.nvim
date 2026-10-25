import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
import markdownItGithubAlerts from 'https://unpkg.com/markdown-it-github-alerts@1.0.1/dist/index.mjs';

/************************************************************
 * Constants
 ************************************************************/

const BOTTOM_PADDING = parseFloat(document.documentElement.dataset.bottomPadding) || 0.5;

// SVG paths for theme icons
const MOON_SVG = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
const SUN_SVG = '<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';

// SVG icons for copy button
const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg>';
const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Live-reload auth token. Either substituted into the document by
// live-preview.nvim at file-write time, or passed via ?t=<token>
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

const YAML_MODE = document.documentElement.dataset.yamlMode || 'panel';

/************************************************************
 * DOM Elements
 ************************************************************/
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

/************************************************************
 * Global States
 ************************************************************/
let lastContent = null;
let currentTheme = document.documentElement.dataset.theme || 'dark';
let mermaidIdCounter = 0;
let wsConnected = false;
let sock = null;
let srcLines = [];
const loadedPacks = new Set();

const withToken = (url) => {
    if (!LIVE_TOKEN) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(LIVE_TOKEN);
};

// Scroll sync state
let scrollSyncPaused = false;
let scrollSyncPauseTimer = null;
let lastScrollData = null;

// Overlay state
let ovSvgSource = '';
let ovBaseW = 0, ovBaseH = 0;
let ovZoom = 1;
let ovFitMode = 'width';
let ovDragging = false, ovStartX = 0, ovStartY = 0, ovStartL = 0, ovStartT = 0;

// Markdownit
let md = null;
let capturedFrontMatter = null;

// Utfc codec
const utf8enc = new TextEncoder(), utf8dec = new TextDecoder();

/************************************************************
 * Utils
 ************************************************************/

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

/************************************************************
 * Theme
 ************************************************************/

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

/************************************************************
 * Markdown-it
 ************************************************************/

function setupMarkdownit() {
    if (!window.markdownit) {
        console.error('[live-preview] markdown-it not loaded from CDN');
        showContent();
        contentEl.innerHTML = '<p style="color:var(--err-fg)">Failed to load markdown-it from CDN. Check your internet connection.</p>';
    }
    md = (window.markdownit || function () { return { render: (t) => '<pre>' + t + '</pre>', utils: { escapeHtml: (s) => s } }; })({
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

    // Inline block rule; the CDN build of markdown-it-front-matter is
    // CJS-only and never registered in a browser. Captured YAML goes to
    // the #fm-panel <details> (mode "panel") or is dropped ("hide");
    // mode "raw" skips the rule so the text renders as ordinary markdown.
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

    md.renderer.rules.paragraph_open = injectLineNumbers;
    md.renderer.rules.heading_open = injectLineNumbers;
    md.renderer.rules.list_item_open = injectLineNumbers;
    md.renderer.rules.table_open = injectLineNumbers;
    md.renderer.rules.tr_open = injectLineNumbers;
    md.renderer.rules.blockquote_open = injectLineNumbers;

    // Override fence renderer to handle mermaid specially
    const defaultFence = md.renderer.rules.fence;
    md.renderer.rules.fence = function (tokens, idx, options, env, self) {
        const token = tokens[idx];
        const info = token.info ? token.info.trim().toLowerCase() : '';
        const lineAttr = token.map
            ? ` data-source-line="${token.map[0]}" data-source-end="${token.map[1]}"`
            : '';
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
        if (lineAttr) html = html.replace(/^<pre\b/, `<pre${lineAttr} data-kind="code"`);
        // Wrap in a non-scrolling container so the language badge and the
        // copy button stay pinned while the <pre> scrolls horizontally.
        // Emitted here rather than in a DOM pass so morphdom's virtual
        // tree matches the live tree and code blocks patch in place.
        const langMatch = html.match(/^<pre[^>]*\bdata-lang="([^"]*)"/);
        const badge = langMatch ? `<span class="code-lang">${langMatch[1]}</span>` : '';
        return `<div class="code-wrap">${badge}${html}</div>`;
    };
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

// Line number injection for cursor sync. Records the full source range.
function injectLineNumbers(tokens, idx, options, env, slf) {
    const t = tokens[idx];
    if (t.map) {
        t.attrJoin('class', 'source-line');
        t.attrSet('data-source-line', String(t.map[0]));
        t.attrSet('data-source-end', String(t.map[1]));
    }
    return slf.renderToken(tokens, idx, options, env, slf);
}


/************************************************************
 * Iconify auto-detection
 ************************************************************/
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


/************************************************************
 * Mermaid Rendering
 ************************************************************/
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

/************************************************************
 * Copy button on code blocks
 * Relative image paths resolve against the served workspace, which
 * only contains the rendered content — rewrite them to the token-
 * gated asset route, which resolves against the source file's dir.
 * Runs on the detached render tree BEFORE morphdom applies it, so
 * raw-HTML <img> tags never fire an unrewritten (404) request.
 *************************************************************/

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

/************************************************************
 * Sync content.md
 ************************************************************/
async function fetchContent() {
    try {
        const resp = await fetch(withToken('content.md?ts=' + Date.now()), { cache: 'no-store' });
        if (!resp.ok) {
            console.warn('[live-preview] content.md fetch failed:', resp.status);
            if (resp.status === 401) {
                // Stale token (server restarted since this tab loaded).
                // Evict it so the next load bootstraps fresh.
                try { sessionStorage.removeItem('mdp-token'); } catch (_) {}
            }
            return null;
        }
        return (await resp.text()).replace(/\r\n?/g, '\n');
    } catch (e) {
        console.warn('[live-preview] content.md fetch error:', e);
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
    srcLines = text.split('\n');

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
                        // Keep the rendered SVG, but refresh the source range
                        // so cursor sync stays correct after edits above it.
                        if (toEl.dataset.sourceLine != null) fromEl.dataset.sourceLine = toEl.dataset.sourceLine;
                        if (toEl.dataset.sourceEnd != null) fromEl.dataset.sourceEnd = toEl.dataset.sourceEnd;
                        return false;
                    }
                    if (fromEl.tagName === 'DETAILS' && fromEl.hasAttribute('open')) {
                        toEl.setAttribute('open', '');
                    }
                    return true;
                },
            });
        } else {
            // Fallback to full page update
            contentEl.innerHTML = html;
            rewriteRelativeImages(contentEl);
        }

        applyBottomPadding();

        const blocks = contentEl.querySelectorAll('.mermaid-block[data-mermaid-source]:not(.mermaid-rendered)');
        for (const block of blocks) {
            await renderMermaidBlock(block);
        }

        attachCopyButtons();

        if (lastScrollData) placeCursor(lastScrollData, { scroll: false });

        setStatus('Updated ' + nowTime());
    } catch (e) {
        console.error('[live-preview] render error:', e);
        contentEl.innerHTML = '<pre style="white-space:pre-wrap;padding:1rem">' +
            text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
        setStatus('Render error: ' + e.message);
    }
}

/************************************************************
 * Sync cursor (nvim <-> browser)
 ************************************************************/

// nvim sends a byte column; JS strings are UTF-16.
function byteColToUtf16(text, byteCol) {
    const bytes = utf8enc.encode(text);
    return utf8dec.decode(bytes.subarray(0, Math.min(byteCol, bytes.length))).length;
}

// How many *rendered* characters does s[0..end) produce? Skips markdown syntax.
function visibleLen(s, end = s.length, blockMarkers = true) {
    let i = blockMarkers
        ? s.match(/^\s*(?:(?:>\s?)+|#{1,6}\s+|(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)*/)[0].length
        : s.length - s.trimStart().length;
    let n = 0;
    if (end <= i) return 0;
    while (i < end) {
        const c = s[i];
        if (c === '\\' && /[!-\/:-@\[-`{-~]/.test(s[i + 1] || '')) {
            if (i + 1 < end) n++;
            i += 2; continue;
        }
        if (c === '`' || c === '*' || c === '~') { i++; continue; }
        if (c === '_') {
            if (/\w/.test(s[i - 1] || '') && /\w/.test(s[i + 1] || '')) n++;
            i++; continue;
        }
        if (c === '[' || (c === '!' && s[i + 1] === '[')) { i++; continue; }
        if (c === ']') {
            if (s[i + 1] === '(') { const j = s.indexOf(')', i); i = j < 0 ? s.length : j + 1; }
            else if (s[i + 1] === '[') { const j = s.indexOf(']', i + 2); i = j < 0 ? s.length : j + 1; }
            else i++;
            continue;
        }
        if (c === '<') {
            const m = s.slice(i).match(/^<\/?[A-Za-z][^>]*>/);
            if (m) { i += m[0].length; continue; }
        }
        if (c === '&') {
            const m = s.slice(i).match(/^&(?:#\d+|#x[0-9a-f]+|\w+);/i);
            if (m) { if (i + m[0].length <= end) n++; i += m[0].length; continue; }
        }
        n++; i++;
    }
    return n;
}

// Text nodes that belong to `el` itself (not to nested blocks).
function textNodesOf(el) {
    const root = el.tagName === 'PRE' ? (el.querySelector('code') || el) : el;
    const skip = new Set(['UL', 'OL', 'TABLE', 'BLOCKQUOTE']);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            for (let p = n.parentElement; p && p !== root; p = p.parentElement) {
                if (p.hasAttribute('data-source-line') || skip.has(p.tagName) ||
                    p.classList.contains('katex-mathml')) return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const out = [];
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
}

// Client-space caret rect at a character offset across a list of text nodes.
function caretRectAt(nodes, offset, wantWidth) {
    if (!nodes.length) return null;
    let acc = 0, node = null, o = 0;
    for (const n of nodes) {
        const len = n.nodeValue.length;
        if (offset <= acc + len) { node = n; o = offset - acc; break; }
        acc += len;
    }
    if (!node) { node = nodes[nodes.length - 1]; o = node.nodeValue.length; }

    const r = document.createRange();
    const rectOf = (a, b) => {
        r.setStart(node, a); r.setEnd(node, b);
        const rs = r.getClientRects();
        return rs.length ? rs : null;
    };
    const len = node.nodeValue.length;
    let x = null, y, h, w = 0;

    const caret = rectOf(o, o);
    if (caret) { const c = caret[0]; x = c.left; y = c.top; h = c.height; }
    else if (o > 0 && rectOf(o - 1, o)) { const rs = rectOf(o - 1, o); const c = rs[rs.length - 1]; x = c.right; y = c.top; h = c.height; }
    else if (o < len && rectOf(o, o + 1)) { const c = rectOf(o, o + 1)[0]; x = c.left; y = c.top; h = c.height; }
    if (x == null) return null;

    if (wantWidth && o < len) {
        const rs = rectOf(o, o + 1);
        if (rs && rs[0].width > 0 && Math.abs(rs[0].top - y) < 2) w = rs[0].width;
    }
    return { x, y, h, w };
}

// [start, end) source ranges of each cell in a table row line.
function tableSegs(s) {
    const pipes = [];
    for (let i = 0; i < s.length; i++) if (s[i] === '|' && s[i - 1] !== '\\') pipes.push(i);
    const segs = [];
    let prev = -1;
    for (const p of pipes) { segs.push([prev + 1, p]); prev = p; }
    segs.push([prev + 1, s.length]);
    if (pipes.length && s.slice(0, pipes[0]).trim() === '') segs.shift();
    if (s.trimEnd().endsWith('|')) segs.pop();
    return segs;
}

// Table row: pick the cell by pipe position.
function rowTarget(tr, s, col) {
    const segs = tableSegs(s);
    let idx = segs.findIndex(sg => col <= sg[1]);
    if (idx < 0) idx = segs.length - 1;
    idx = Math.max(0, Math.min(idx, tr.children.length - 1));
    const [a, b] = segs[idx] || [0, s.length];
    const raw = s.slice(a, b);
    const lead = raw.length - raw.trimStart().length;
    const within = raw.trimStart();
    return {
        cell: tr.children[idx],
        offset: visibleLen(within, Math.max(0, Math.min(within.length, col - a - lead)), false),
    };
}

// (line, utf16 col) -> client-space rect, or null
function locateCursor(line, col, wantWidth) {
    let hit = null;
    for (const el of contentEl.querySelectorAll('[data-source-line]')) {
        const s = +el.dataset.sourceLine, e = +el.dataset.sourceEnd;
        if (s <= line && line < e) hit = el;
        else if (s > line) break;
    }
    if (!hit) return null;
    const s = +hit.dataset.sourceLine, e = +hit.dataset.sourceEnd;
    const box = () => { const b = hit.getBoundingClientRect(); return { x: b.left, y: b.top, h: 18, w: 0 }; };

    if (hit.classList.contains('mermaid-block')) return box();
    if (hit.tagName === 'TABLE') {
        const tr = hit.querySelector('tr');
        if (!tr) return box();
        const b = tr.getBoundingClientRect();
        return { x: b.left, y: b.top, h: b.height, w: 0 };
    }

    let nodes, offset;
    const cur = srcLines[line] ?? '';

    if (hit.tagName === 'TR') {
        const t = rowTarget(hit, cur, col);
        if (!t.cell) return box();
        nodes = textNodesOf(t.cell); offset = t.offset;
    } else if (hit.dataset.kind === 'code') {
        nodes = textNodesOf(hit);
        const closing = e - 1 > s && /^\s*(`{3,}|~{3,})\s*$/.test(srcLines[e - 1] || '');
        const total = nodes.reduce((a, n) => a + n.nodeValue.length, 0);
        if (line <= s) offset = 0;
        else if (closing && line >= e - 1) offset = total;
        else {
            const indent = (srcLines[s].match(/^\s*/) || [''])[0].length;
            const strip = (l) => Math.min(indent, (srcLines[l].match(/^\s*/) || [''])[0].length);
            offset = 0;
            for (let l = s + 1; l < line; l++) offset += srcLines[l].length - strip(l) + 1;
            offset += Math.max(0, col - strip(line));
        }
    } else {
        nodes = textNodesOf(hit);
        offset = 0;
        for (let l = s; l < line; l++) offset += visibleLen((srcLines[l] || '').trimEnd()) + 1;
        offset += visibleLen(cur, col);
    }

    return caretRectAt(nodes, offset, wantWidth) || box();
}

function drawCursor(x, y, h, w, block) {
    let el = document.getElementById('cursor');
    if (!el) {
        el = document.createElement('div');
        el.id = 'cursor';
        document.body.appendChild(el);
    }
    el.classList.toggle('block', !!block);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.height = `${h}px`;
    el.style.width = block && w ? `${w}px` : '2px';
    el.style.display = 'block';
}

function placeCursor(data, { scroll = true } = {}) {
    const line = data.line;
    if (data.text != null) srcLines[line] = data.text;   // fresher than last rendered content
    const col = byteColToUtf16(srcLines[line] ?? '', data.col || 0);
    const block = !!data.mode && !/^[iRc]/.test(data.mode);

    let pos = null;
    try {
        pos = locateCursor(line, col, block);
    } catch (e) {
        console.warn('[live-preview] locateCursor failed:', e);
    }
    let px, py, h = 18, w = 0;
    if (pos) {
        px = pos.x + window.scrollX; py = pos.y + window.scrollY; h = pos.h; w = pos.w;
    }
    drawCursor(px, py, h, w, block);
    if (scroll) window.scrollTo({ top: Math.max(0, py - window.innerHeight / 2) });
}

function sendToNvim(obj) {
    if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify(obj));
    }
}

function caretAt(x, y) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
}

// A caret lands between characters, but nvim's cursor sits ON a character.
// If the pointer is over the character just before the caret (right half
// of it), use that one so the cursor lands where the user clicked.
function charUnderPoint(x, y) {
    const c = caretAt(x, y);
    if (!c || c.node.nodeType !== Node.TEXT_NODE || c.offset === 0) return c;
    const r = document.createRange();
    r.setStart(c.node, c.offset - 1);
    r.setEnd(c.node, c.offset);
    for (const b of r.getClientRects()) {
        if (x >= b.left && x < b.right && y >= b.top && y <= b.bottom) {
            return { node: c.node, offset: c.offset - 1 };
        }
    }
    return c;
}

// Rendered characters before (node, offset) within a block's own text nodes.
// null = the caret isn't inside one of them.
function renderedOffsetIn(nodes, node, offset) {
    let acc = 0;
    for (const n of nodes) {
        if (n === node) return acc + Math.min(offset, n.nodeValue.length);
        acc += n.nodeValue.length;
    }
    return null;
}

// Inverse of visibleLen: the source column of the (target+1)th rendered
// character. visibleLen never decreases as `end` grows, so the largest k
// with visibleLen(s, k) <= target is the character itself, not the markup
// (`**`, `[`...) in front of it.
function sourceColFor(s, target, blockMarkers = true) {
    for (let k = s.length; k > 0; k--) {
        if (visibleLen(s, k, blockMarkers) <= target) return k;
    }
    return 0;
}

// (block element, caret) -> { line, col } in content.md; col is UTF-16.
function sourcePosFor(hit, node, offset) {
    const s = +hit.dataset.sourceLine, e = +hit.dataset.sourceEnd;
    const L = (l) => srcLines[l] || '';
    const none = { line: s, col: 0 };

    // Diagrams and whole tables: jump to the first line.
    if (hit.classList.contains('mermaid-block') || hit.tagName === 'TABLE') return none;

    if (hit.tagName === 'TR') {
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        const cell = el && el.closest('td, th');
        if (!cell || !hit.contains(cell)) return none;
        const off = renderedOffsetIn(textNodesOf(cell), node, offset) ?? 0;
        const cur = L(s);
        const segs = tableSegs(cur);
        const idx = Math.max(0, Math.min([...hit.children].indexOf(cell), segs.length - 1));
        const [a, b] = segs[idx] || [0, cur.length];
        const raw = cur.slice(a, b);
        const lead = raw.length - raw.trimStart().length;
        return { line: s, col: a + lead + sourceColFor(raw.trimStart(), off, false) };
    }

    const off = renderedOffsetIn(textNodesOf(hit), node, offset) ?? 0;

    if (hit.dataset.kind === 'code') {
        // Mirrors the code branch of locateCursor: content lines sit between
        // the fences, minus the fence's indentation.
        const closing = e - 1 > s && /^\s*(`{3,}|~{3,})\s*$/.test(L(e - 1));
        const lastContent = closing ? e - 2 : e - 1;
        const indent = (L(s).match(/^\s*/) || [''])[0].length;
        const strip = (l) => Math.min(indent, (L(l).match(/^\s*/) || [''])[0].length);
        let remaining = off;
        for (let l = s + 1; l <= lastContent; l++) {
            const len = L(l).length - strip(l);
            if (remaining <= len || l === lastContent) {
                return { line: l, col: strip(l) + Math.min(remaining, len) };
            }
            remaining -= len + 1; // +1 for the newline
        }
        return none;
    }

    // Paragraphs, headings, list items, blockquotes: walk the source lines,
    // subtracting each line's rendered length (+1 for the line break).
    let remaining = off;
    for (let l = s; l < e; l++) {
        const vl = visibleLen(L(l).trimEnd());
        if (remaining <= vl || l === e - 1) {
            return { line: l, col: sourceColFor(L(l), Math.min(remaining, vl)) };
        }
        remaining -= vl + 1;
    }
    return none;
}

// Tell nvim, and draw the cursor locally. nvim does not echo this move back
// (the echo would re-centre the page under the mouse), so the browser has to
// move its own cursor.
function jumpNvimTo(line, col) {
    const text = srcLines[line] ?? '';
    const byteCol = utf8enc.encode(text.slice(0, col)).length; // nvim wants bytes
    sendToNvim({ type: 'goto', line, col: byteCol });
    lastScrollData = {
        line,
        col: byteCol,
        mode: lastScrollData?.mode ?? 'n',
        text,
        total: lastScrollData?.total ?? srcLines.length,
    };
    placeCursor(lastScrollData, { scroll: false });
}

/************************************************************
 * Websocket
 ************************************************************/
function connectWS() {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = withToken(`${wsProtocol}//${location.host}/__live/ws`);

    sock = new WebSocket(wsUrl);

    sock.addEventListener('open', () => {
        console.log('[live-preview] WebSocket connected');
        wsConnected = true;
        setConnectionState('connected');
        sendToNvim({ type: 'hello' });
    });

    sock.addEventListener('message', async (event) => {
        try {
            const data = JSON.parse(event.data);
            switch (data.type) {
                case "reload":
                    await sync(false);
                    break;
                case "cursor":
                    if (data.line == null) return;
                    lastScrollData = data;
                    placeCursor(data, { scroll: !scrollSyncPaused });
                    break;
                default:
                    break;
            }
        } catch (err) {
            console.log('[live-preview] WebSocket error: ', err);
        }
    });

    sock.addEventListener('close', () => {
        wsConnected = false;
        setConnectionState('error');
        console.log('[live-preview] WebSocket disconnected. Reconnecting in 0.2s...');
        setTimeout(connectWS, 200); // Auto-reconnect safety net
    });

    sock.addEventListener('error', () => {
        console.log('[live-preview] websocket error')
        setConnectionState('error');
    });
}

/************************************************************
 * Expand Overlay (fullscreen diagram zoom/pan)
 ************************************************************/
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

function applyBottomPadding() {
    contentEl.style.paddingBottom = `${(1 - BOTTOM_PADDING) * window.innerHeight}px`;
}

/************************************************************
 * Main
 ************************************************************/


(async function main() {
    try {
        // Apply theme
        themeBtn.addEventListener('click', () => {
            applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
            renderAllMermaidBlocks();
        });

        // Setup markdown-it
        setupMarkdownit()

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

        // Sync cursor (browser -> nvim)
        contentEl.addEventListener('click', (e) => {
            // No cursor message from nvim yet (or scroll_sync is off): stay inert.
            if (e.button !== 0 || !lastScrollData) return;
            if (!window.getSelection().isCollapsed) return; // user is selecting text
            if (e.target.closest('a, button, summary, input, textarea, select, [data-expand]')) return;

            const caret = charUnderPoint(e.clientX, e.clientY);
            const useCaret = !!caret && contentEl.contains(caret.node);
            const node = useCaret ? caret.node : e.target;
            const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            const hit = el && el.closest('[data-source-line]');

            let pos;
            if (hit) {
                pos = sourcePosFor(hit, node, useCaret ? caret.offset : 0);
            } else {
                // Raw HTML blocks and pre-rendered mermaid carry no source range:
                // fall back to the nearest tagged block above the click.
                let above = null;
                for (const b of contentEl.querySelectorAll('[data-source-line]')) {
                    if (b.getBoundingClientRect().top > e.clientY) break;
                    above = b;
                }
                if (!above) return;
                pos = { line: +above.dataset.sourceLine, col: 0 };
            }
            jumpNvimTo(pos.line, pos.col);
        });

        // Overlay click events
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

        // Event delegation for expand buttons
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

        // Re-place the cursor when layout shifts (images loading, window resize, etc.)
        new ResizeObserver(() => {
            if (lastScrollData) placeCursor(lastScrollData, { scroll: !scrollSyncPaused });
        }).observe(contentEl);

        // Bottom padding
        window.addEventListener('resize', applyBottomPadding);

        if (document.documentElement.dataset.mermaidElk === 'true') {
            const elkLayouts = await import('https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.2.1/dist/mermaid-layout-elk.esm.min.mjs');
            mermaid.registerLayoutLoaders(elkLayouts.default || elkLayouts);
        }
        applyTheme(currentTheme);
        await sync(true);
    } catch (e) {
        console.error('[live-preview] boot error:', e);
        showContent();
        contentEl.innerHTML = '<p style="color:var(--err-fg)">Error: ' + (e.message || e) + '</p>';
    }
    connectWS();
})();
