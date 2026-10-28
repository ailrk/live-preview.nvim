import g, { showContent, applyBottomPadding, $ } from "./global.js";
import { md, updateFrontMatterPanel} from "./markdown.js";
import { renderMermaidBlock } from "./mermaid.js";

// Live-reload auth token, stashed in sessionStorage to survive refresh.
const LIVE_TOKEN = new URLSearchParams(location.search).get('t') || '';
const HTML_TAG = /<(\/?)([A-Za-z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/y;
const HTML_ENTITY = /&(?:#\d+|#x[0-9a-f]+|[A-Za-z][A-Za-z0-9]*);/iy;
const PENDING_CURSOR_MS = 100;    // safety net: never hold a cursor longer
const CURSOR_ANIM_MS = 80;        // 0 = no animation
const CURSOR_ANIM_MAX_PX = 500;   // farther than this, cursor and page just jump
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// SVG icons for copy button
const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg>';
const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const statusDot = $('statusDot');
const statusEl = $('status');

// Scroll sync state
let scrollSyncPaused = false;
let scrollSyncPauseTimer = null;
let lastScrollData = null;

let lastContent = null;
let wsConnected = false;
let sock = null;

// Cursor/content ordering. In insert mode nvim's cursor message arrives before
// the content it belongs to (the content is pushed right after). Drawing the
// cursor against the old DOM puts it in the wrong place, so a cursor message
// whose edit hasn't rendered yet is held back until it has.
let renderedTick = -1;      // changedtick of the content on screen
export let pendingCursor = null;   // cursor message waiting for its content
let pendingTimer = null;

// Cursor animation. The cursor and the page scroll are tweened together in one
// requestAnimationFrame loop, so a recentring scroll and the cursor move as one
// (a CSS transition on the cursor alone would trail behind an instant scroll).
let cursorShown = null;   // {x, y}: where the cursor is drawn right now
let cursorTween = null;   // {raf, x, y, scrollTop} of the running animation

const utf8enc = new TextEncoder(), utf8dec = new TextDecoder();

const setStatus = (t) => { if (statusEl) statusEl.textContent = t || ''; };
const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const withToken = (url) => {
    if (!LIVE_TOKEN) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(LIVE_TOKEN);
};

/************************************************************
 * Websocket
 ************************************************************/
export function connectWS() {
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
                    await sync(false, data.tick ?? null);
                    break;
                case "tick":
                    // nvim saw an edit that left the rendered content unchanged
                    await enqueue(() => settleCursor(data.tick ?? null));
                    break;
                case "cursor":
                    if (data.line == null) return;
                    onCursorMessage(data);
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
        console.log('[live-preview] WebSocket disconnected. Reconnecting in 2s...');
        setTimeout(connectWS, 2000); // Auto-reconnect safety net
    });

    sock.addEventListener('error', () => {
        console.log('[live-preview] websocket error')
        setConnectionState('error');
    });
}

function setConnectionState(state) {
    statusDot.className = 'status-dot' + (state === 'connected' ? ' connected' : state === 'error' ? ' error' : '');
    statusDot.title = state === 'connected' ? 'Connected' : state === 'error' ? 'Disconnected' : 'Connecting...';
}

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

async function syncImpl(initial = false, tick = null) {
    // markdown-it isn't set up yet. A reload that arrives this early is safe
    // to drop: the initial sync fetches the latest content anyway.
    if (!md) return;

    const text = await fetchContent();
    if (text == null) {
        if (initial) setStatus('Waiting for content...');
        return;
    }
    if (!initial && text === lastContent) { settleCursor(tick); return; }
    lastContent = text;
    g.srcLines = text.split('\n');

    try {
        const html = md.render(text);
        updateFrontMatterPanel();

        showContent();

        if (window.morphdom) {
            const wrapper = document.createElement('div');
            wrapper.id = 'content';
            wrapper.innerHTML = html;
            rewriteRelativeImages(wrapper);

            window.morphdom(g.contentEl, wrapper, {
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
            g.contentEl.innerHTML = html;
            rewriteRelativeImages(g.contentEl);
        }

        applyBottomPadding();
        attachCopyButtons();

        // Place the cursor before the diagrams render: they can be slow (the
        // mermaid module may still be downloading) and the ResizeObserver
        // re-places the cursor when they change the layout. Scroll on the
        // first render so the cursor starts in view.
        settleCursor(tick, initial);

        const blocks = g.contentEl.querySelectorAll('.mermaid-block[data-mermaid-source]:not(.mermaid-rendered)');
        for (const block of blocks) {
            await renderMermaidBlock(block);
        }

        setStatus('Updated ' + nowTime());
    } catch (e) {
        console.error('[live-preview] render error:', e);
        g.contentEl.innerHTML = '<pre style="white-space:pre-wrap;padding:1rem">' +
            text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
        setStatus('Render error: ' + e.message);
    }
}

// Serialize renders: a "reload" can arrive while the previous render is still
// awaiting mermaid, and two overlapping renders would fight over the DOM.
let syncChain = Promise.resolve();
function enqueue(fn) {
    syncChain = syncChain
        .then(fn)
        .catch((e) => console.error('[live-preview] sync failed:', e));
    return syncChain;
}

export function sync(initial = false, tick = null) {
    return enqueue(() => syncImpl(initial, tick));
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
        if (c === '`') {
            // code span: characters are literal, nothing inside is markup.
            // e.g `$HOME` is not math.
            let run = 1;
            while (s[i + run] === '`') run++;
            const close = s.indexOf('`'.repeat(run), i + run);
            if (close < 0) { i += run; continue; }   // stray backticks: markup only
            const from = i + run;
            if (end <= from) break;
            if (end <= close) return n + (end - from);
            n += close - from;
            i = close + run;
            continue;
        }
        if (c === '*' || c === '~') { i++; continue; }
        if (c === '!' || c === '$') {
            // Images and inline math have no text nodes: they count as nothing.
            const ae = atomEnd(s, i);
            if (ae > 0) { i = ae; continue; }
        }
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
                if (p.hasAttribute('data-source-line')
                    || skip.has(p.tagName)
                    || p.tagName === 'EQ'
                    || p.classList.contains('katex'))
                    return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const out = [];
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
}

// End (exclusive) of the image or inline math that starts at s[i], or -1.
function atomEnd(s, i) {
    const c = s[i];
    if (c === '!' && s[i + 1] === '[') {
        // ![alt](url) or ![alt][ref]
        let depth = 0, j = i + 1;
        for (; j < s.length; j++) {
            if (s[j] === '\\') { j++; continue; }
            if (s[j] === '[') depth++;
            else if (s[j] === ']' && --depth === 0) break;
        }
        if (j >= s.length) return -1;
        if (s[j + 1] === '(') { const k = s.indexOf(')', j + 2); return k < 0 ? -1 : k + 1; }
        if (s[j + 1] === '[') { const k = s.indexOf(']', j + 2); return k < 0 ? -1 : k + 1; }
        return -1;
    }
    if (c === '$') {
        // $...$ and $$...$$, with texmath's rules: no space after the opening $,
        // none before the closing one, no digit right after a closing single $.
        const n = s[i + 1] === '$' ? 2 : 1;
        if (/\s/.test(s[i + n] || ' ')) return -1;
        for (let j = i + n; j < s.length; j++) {
            if (s[j] === '\\') { j++; continue; }
            if (s[j] !== '$') continue;
            if (n === 2 && s[j + 1] !== '$') continue;
            if (/\s/.test(s[j - 1])) return -1;
            if (n === 1 && /\d/.test(s[j + 1] || '')) return -1;
            return j + n;
        }
    }
    return -1;
}

// Images and inline math in a block's source, in order, up to position `upto`.
function scanAtoms(src, upto) {
    const atoms = [];
    let i = 0;
    while (i < src.length && i <= upto) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`') {
            let run = 1;
            while (src[i + run] === '`') run++;
            const close = src.indexOf('`'.repeat(run), i + run);
            i = close < 0 ? i + run : close + run;
            continue;
        }
        if (c === '!' || c === '$') {
            const end = atomEnd(src, i);
            if (end > 0) {
                atoms.push({ kind: c === '!' ? 'img' : 'math', start: i, end });
                i = end;
                continue;
            }
        }
        if (c === '<') {
            const m = /^<img\b[^>]*>/i.exec(src.slice(i, i + 1000));
            if (m) { atoms.push({ kind: 'img', start: i, end: i + m[0].length }); i += m[0].length; continue; }
        }
        i++;
    }
    return atoms;
}

// Cursor on an image or inline math inside a paragraph, heading, list item...
// Images get the cursor drawn over them; math gets a bar placed in proportion
// to the position inside the formula (KaTeX has no source map).
function atomUnderCursor(hit, line, col) {
    const s = +hit.dataset.sourceLine, e = +hit.dataset.sourceEnd;
    const lines = [];
    for (let l = s; l < e; l++) lines.push(g.srcLines[l] ?? '');
    let idx = col;
    for (let l = s; l < line; l++) idx += lines[l - s].length + 1;

    const atoms = scanAtoms(lines.join('\n'), idx);
    const a = atoms.find((x) => idx >= x.start && idx < x.end);
    if (!a) return null;
    const k = atoms.filter((x) => x.kind === a.kind && x.start < a.start).length;
    const els = [...hit.querySelectorAll(a.kind === 'img' ? 'img' : 'eq, eqn')]
        .filter((n) => n.closest('[data-source-line]') === hit);
    const el = els[k];
    if (!el) return null;

    const b = el.getBoundingClientRect();
    if (a.kind === 'img') return { x: b.left, y: b.top, h: b.height, w: b.width, image: true };
    const span = a.end - a.start;
    return { x: b.left + ((idx - a.start) / span) * b.width, y: b.top, h: b.height, w: Math.max(2, b.width / span) };
}

// Display math: no way to ask KaTeX where a source column lands, so place the
// cursor proportionally: the row from the source line, the x from the column.
function locateInMathBlock(hit, line, col) {
    const s = +hit.dataset.sourceLine, e = +hit.dataset.sourceEnd;
    const b = (hit.querySelector('.katex') || hit).getBoundingClientRect();
    const rows = [];
    for (let l = s; l < e; l++) {
        const t = (g.srcLines[l] || '').trim();
        if (t && t !== '$$') rows.push(l);
    }
    if (!rows.length) return { x: b.left, y: b.top, h: b.height, w: 2 };
    let r = rows.findIndex((l) => l >= line);
    if (r < 0) r = rows.length - 1;
    const maxLen = Math.max(1, ...rows.map((l) => g.srcLines[l].trim().length));
    const text = g.srcLines[rows[r]] || '';
    const lead = text.length - text.trimStart().length;
    const f = rows[r] === line
        ? Math.min(1, Math.max(0, (col - lead) / maxLen))
        : (line > rows[r] ? 1 : 0);
    const rowH = b.height / rows.length;
    return { x: b.left + f * b.width, y: b.top + r * rowH, h: rowH, w: Math.max(2, b.width / maxLen) };
}

// Raw HTML blocks. The visible text of the block is its source minus tags,
// comments and script/style bodies, with entities as one character. The DOM
// keeps the same text in its text nodes, so a position can be carried across by
// counting non-whitespace characters (whitespace is collapsed, dropped or
// re-created by the HTML parser in too many ways to count).
const isWs = (ch) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';

// count: visible non-whitespace characters before source index `idx`.
// img: the <img> (by order) the cursor is on or about to reach, else null.
// imgsBefore: how many <img> tags start before `idx`.
function scanHtml(src, idx) {
    let i = 0, count = 0, seen = 0, imgs = 0, imgsBefore = 0, img = null, nextGap = null;
    while (i < src.length) {
        const c = src[i];
        if (c === '<') {
            if (src.startsWith('<!--', i)) {
                const e = src.indexOf('-->', i + 4);
                i = e < 0 ? src.length : e + 3;
                continue;
            }
            HTML_TAG.lastIndex = i;
            const m = HTML_TAG.exec(src);
            if (m) {
                const end = i + m[0].length, name = m[2].toLowerCase();
                if (name === 'img' && !m[1]) {
                    if (i < idx) imgsBefore++;
                    if (idx >= i && idx < end) img = imgs;                       // on the tag
                    else if (i >= idx && img === null && nextGap === null) {      // next thing visible?
                        nextGap = seen - count;
                        if (nextGap === 0) img = imgs;
                    }
                    imgs++;
                }
                i = end;
                if ((name === 'script' || name === 'style') && !m[1]) {
                    const close = src.toLowerCase().indexOf('</' + name, i);
                    i = close < 0 ? src.length : close;
                }
                continue;
            }
        }
        if (isWs(c)) { i++; continue; }
        let len = 1;
        if (c === '&') {
            HTML_ENTITY.lastIndex = i;
            const m = HTML_ENTITY.exec(src);
            if (m) len = m[0].length;
        }
        if (i < idx) count++;
        seen++;
        i += len;
    }
    return { count, img, imgsBefore };
}

// Text nodes and images of an HTML block: everything between its marker and
// the next marked block, in document order. No wrapper element is used because
// raw HTML may be unbalanced (an opening <div> closed by a later block).
function htmlRegion(marker, next) {
    const texts = [], imgs = [];
    const walker = document.createTreeWalker(g.contentEl, NodeFilter.SHOW_ALL);
    walker.currentNode = marker;
    for (let n = walker.nextNode(); n && n !== next; n = walker.nextNode()) {
        if (n.nodeType === Node.TEXT_NODE) {
            const p = n.parentElement;
            if (p && p.tagName !== 'SCRIPT' && p.tagName !== 'STYLE') texts.push(n);
        } else if (n.tagName === 'IMG') {
            imgs.push(n);
        }
    }
    return { texts, imgs };
}

// Offset, in the concatenated text, of the (target+1)th non-whitespace
// character; -1 when there are fewer characters than that.
function offsetOfNonWs(nodes, target) {
    let seen = 0, base = 0;
    for (const n of nodes) {
        const t = n.nodeValue;
        for (let k = 0; k < t.length; k++) {
            if (isWs(t[k])) continue;
            if (seen === target) return base + k;
            seen++;
        }
        base += t.length;
    }
    return -1;
}

function locateInHtml(marker, next, line, col, wantWidth) {
    const s = +marker.dataset.sourceLine, e = +marker.dataset.sourceEnd;
    const lines = [];
    for (let l = s; l < e; l++) lines.push(g.srcLines[l] ?? '');
    let idx = col;
    for (let l = s; l < line; l++) idx += lines[l - s].length + 1;

    const { count, img, imgsBefore } = scanHtml(lines.join('\n'), idx);
    const { texts, imgs } = htmlRegion(marker, next);
    const imgRect = (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.left, y: b.top, h: b.height, w: b.width, image: true };
    };

    // On an <img> tag, or right before one: the image.
    if (img != null && imgs[img]) return imgRect(imgs[img]);

    // Otherwise the visible character at or after the cursor.
    const off = offsetOfNonWs(texts, count);
    if (off >= 0) {
        const r = caretRectAt(texts, off, wantWidth);
        if (r) return r;
    }
    // Nothing visible after the cursor: the next image, else the end of the text.
    if (imgs.length) return imgRect(imgs[Math.min(imgsBefore, imgs.length - 1)]);
    if (texts.length) {
        return caretRectAt(texts, texts.reduce((a, n) => a + n.nodeValue.length, 0), wantWidth);
    }
    return null;
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
    const els = g.contentEl.querySelectorAll('[data-source-line]');
    let hit = null, hitIdx = -1;
    for (let k = 0; k < els.length; k++) {
        const s = +els[k].dataset.sourceLine, e = +els[k].dataset.sourceEnd;
        if (s <= line && line < e) { hit = els[k]; hitIdx = k; }
        else if (s > line) break;
    }
    if (!hit) return null;
    // A blank line points at nothing. Blocks can still span one (loose list
    // items swallow the blank lines after them), so check the text itself.
    // Code blocks are the exception: blank lines there are real content.
    if (hit.dataset.kind !== 'code' && !(g.srcLines[line] ?? '').trim()) return null;
    const s = +hit.dataset.sourceLine, e = +hit.dataset.sourceEnd;
    const box = () => { const b = hit.getBoundingClientRect(); return { x: b.left, y: b.top, h: 18, w: 0 }; };

    if (hit.classList.contains('mermaid-block')) return box();
    if (hit.tagName === 'TABLE') {
        const tr = hit.querySelector('tr');
        if (!tr) return box();
        const b = tr.getBoundingClientRect();
        return { x: b.left, y: b.top, h: b.height, w: 0 };
    }

    if (hit.dataset.kind === 'html') return locateInHtml(hit, els[hitIdx + 1] || null, line, col, wantWidth);
    if (hit.dataset.kind === 'math') return locateInMathBlock(hit, line, col);

    let nodes, offset;
    const cur = g.srcLines[line] ?? '';

    if (hit.tagName === 'TR') {
        const t = rowTarget(hit, cur, col);
        if (!t.cell) return box();
        nodes = textNodesOf(t.cell); offset = t.offset;
    } else if (hit.dataset.kind === 'code') {
        nodes = textNodesOf(hit);
        const closing = e - 1 > s && /^\s*(`{3,}|~{3,})\s*$/.test(g.srcLines[e - 1] || '');
        const total = nodes.reduce((a, n) => a + n.nodeValue.length, 0);
        if (line <= s) offset = 0;
        else if (closing && line >= e - 1) offset = total;
        else {
            const indent = (g.srcLines[s].match(/^\s*/) || [''])[0].length;
            const strip = (l) => Math.min(indent, (g.srcLines[l].match(/^\s*/) || [''])[0].length);
            offset = 0;
            for (let l = s + 1; l < line; l++) offset += g.srcLines[l].length - strip(l) + 1;
            offset += Math.max(0, col - strip(line));
        }
    } else {
        const atom = atomUnderCursor(hit, line, col);
        if (atom) return atom;
        nodes = textNodesOf(hit);
        offset = 0;
        for (let l = s; l < line; l++) offset += visibleLen((g.srcLines[l] || '').trimEnd()) + 1;
        offset += visibleLen(cur, col);
    }

    return caretRectAt(nodes, offset, wantWidth) || box();
}

function hideCursor() {
    if (cursorTween) cancelAnimationFrame(cursorTween.raf);
    cursorTween = null;
    cursorShown = null;     // the next draw appears in place instead of sliding in
    const el = $('cursor');
    if (el) el.style.display = 'none';
}

// x, y: target in document coordinates. scrollTop: page scroll to end at
// (null = leave the scroll alone). animate=false snaps.
function drawCursor(x, y, h, w, block, scrollTop = null, animate = true, image = false) {
    let el = $('cursor');
    if (!el) {
        el = document.createElement('div');
        el.id = 'cursor';
        document.body.appendChild(el);
    }
    el.classList.toggle('block', !!block);
    el.classList.toggle('on-image', image);
    el.style.height = `${h}px`;
    el.style.width = image || (block && w) ? `${w}px` : '2px';

    // Already heading to this spot: let the running animation finish.
    if (cursorTween && Math.abs(cursorTween.x - x) < 0.5 && Math.abs(cursorTween.y - y) < 0.5 &&
        cursorTween.scrollTop === scrollTop) return;
    if (cursorTween) { cancelAnimationFrame(cursorTween.raf); cursorTween = null; }

    const from = cursorShown;
    const wasVisible = el.style.display === 'block';
    const dist = from ? Math.hypot(x - from.x, y - from.y) : Infinity;
    const scrollDist = scrollTop != null ? Math.abs(scrollTop - window.scrollY) : 0;
    const animated = animate && CURSOR_ANIM_MS > 0 && !REDUCED_MOTION && wasVisible &&
        (dist >= 0.5 || scrollDist >= 1) &&
        dist < CURSOR_ANIM_MAX_PX && scrollDist < CURSOR_ANIM_MAX_PX;

    el.style.display = 'block';

    if (!animated) {
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        cursorShown = { x, y };
        if (scrollTop != null) window.scrollTo({ top: scrollTop, behavior: 'instant' });
        return;
    }

    const x0 = from.x, y0 = from.y, s0 = window.scrollY;
    const t0 = performance.now();
    const tw = { raf: 0, x, y, scrollTop };
    const step = (now) => {
        const t = Math.min(1, (now - t0) / CURSOR_ANIM_MS);
        const e = 1 - Math.pow(1 - t, 3);   // ease-out
        const cx = x0 + (x - x0) * e;
        const cy = y0 + (y - y0) * e;
        el.style.left = `${cx}px`;
        el.style.top = `${cy}px`;
        cursorShown = { x: cx, y: cy };
        if (scrollTop != null) window.scrollTo({ top: s0 + (scrollTop - s0) * e, behavior: 'instant' });
        if (t < 1) tw.raf = requestAnimationFrame(step);
        else cursorTween = null;
    };
    cursorTween = tw;
    tw.raf = requestAnimationFrame(step);
}

function placeCursor(data, { scroll = true, animate = true } = {}) {
    const line = data.line;
    if (data.text != null) g.srcLines[line] = data.text;   // fresher than last rendered content
    const col = byteColToUtf16(g.srcLines[line] ?? '', data.col || 0);
    const block = !!data.mode && !/^[iRc]/.test(data.mode);

    let pos = null;
    try {
        pos = locateCursor(line, col, block);
    } catch (e) {
        console.warn('[live-preview] locateCursor failed:', e);
    }
    if (!pos) {
        // Blank lines (and anything outside the rendered blocks) point at
        // nothing: remove the cursor completely and leave the scroll alone.
        hideCursor();
        return;
    }
    const px = pos.x + window.scrollX, py = pos.y + window.scrollY;
    // centre on the middle of an image, not its top edge
    const focusY = pos.image ? py + pos.h / 2 : py;
    const scrollTop = scroll ? Math.max(0, focusY - window.innerHeight / 2) : null;
    drawCursor(px, py, pos.h, pos.w, block, scrollTop, animate, !!pos.image);
}

// Content up to `tick` is now on screen: release the cursor held back for it.
function settleCursor(tick, initial = false) {
    if (tick != null) renderedTick = tick;
    let released = false;
    if (pendingCursor && (pendingCursor.tick == null || pendingCursor.tick <= renderedTick)) {
        pendingCursor = null;
        clearTimeout(pendingTimer);
        pendingTimer = null;
        released = true;
    }
    if (lastScrollData && !pendingCursor) {
        placeCursor(lastScrollData, { scroll: (initial || released) && !scrollSyncPaused });
    }
}

export function onCursorMessage(data) {
    lastScrollData = data;
    // fresh === false: nvim has an edit the browser hasn't been sent yet.
    if (data.fresh === false && data.tick != null && data.tick > renderedTick) {
        pendingCursor = data; // the newest cursor wins
        // Bounded hold. The timer starts with the FIRST held cursor and is not
        // restarted by later ones: while you type faster than the page renders,
        // every new cursor is "ahead" of the content, and a timer that restarted
        // each time would never fire until you stopped typing.
        if (!pendingTimer) {
            pendingTimer = setTimeout(() => {
                pendingTimer = null;
                const d = pendingCursor;
                pendingCursor = null;
                if (d) placeCursor(d, { scroll: !scrollSyncPaused });
            }, PENDING_CURSOR_MS);
        }
        return;
    }
    pendingCursor = null;
    clearTimeout(pendingTimer);
    pendingTimer = null;
    placeCursor(data, { scroll: !scrollSyncPaused });
}

export function sendToNvim(obj) {
    if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify(obj));
    }
}

// Tell nvim, and draw the cursor locally. nvim does not echo this move back
// (the echo would re-centre the page under the mouse), so the browser has to
// move its own cursor.
export function jumpNvimTo(line, col) {
    const text = g.srcLines[line] ?? '';
    const byteCol = utf8enc.encode(text.slice(0, col)).length; // nvim wants bytes
    sendToNvim({ type: 'goto', line, col: byteCol });
    lastScrollData = {
        line,
        col: byteCol,
        mode: lastScrollData?.mode ?? 'n',
        text,
        total: lastScrollData?.total ?? g.srcLines.length,
    };
    placeCursor(lastScrollData, { scroll: false, animate: false });
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
    g.contentEl.querySelectorAll('.code-wrap').forEach(wrap => {
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

function caretAt(x, y) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
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
    const L = (l) => g.srcLines[l] || '';
    const none = { line: s, col: 0 };

    // Diagrams and whole tables: jump to the first line.
    if (hit.classList.contains('mermaid-block') || hit.tagName === 'TABLE' || hit.dataset.kind === 'math') return none;

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
export function setupScrollSync() {
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
    g.contentEl.addEventListener('click', (e) => {
        // No cursor message from nvim yet (or scroll_sync is off): stay inert.
            if (e.button !== 0 || !lastScrollData) return;
        if (!window.getSelection().isCollapsed) return; // user is selecting text
        if (e.target.closest('a, button, summary, input, textarea, select, [data-expand]')) return;

        const caret = charUnderPoint(e.clientX, e.clientY);
        const useCaret = !!caret && g.contentEl.contains(caret.node);
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
            for (const b of g.contentEl.querySelectorAll('[data-source-line]')) {
                if (b.getBoundingClientRect().top > e.clientY) break;
                above = b;
            }
            if (!above) return;
            pos = { line: +above.dataset.sourceLine, col: 0 };
        }
        jumpNvimTo(pos.line, pos.col);
    });

    // Re-place the cursor when layout shifts (images loading, window resize, etc.)
    new ResizeObserver(() => {
        if (lastScrollData && !pendingCursor) placeCursor(lastScrollData, { scroll: !scrollSyncPaused });
    }).observe(g.contentEl);
}
