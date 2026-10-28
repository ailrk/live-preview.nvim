import g, { $ } from "./global.js";
import markdownItGithubAlerts from 'https://unpkg.com/markdown-it-github-alerts@1.0.1/dist/index.mjs';

const YAML_MODE = document.documentElement.dataset.yamlMode || 'panel';
export let md = null;
export let capturedFrontMatter = null;

export function updateFrontMatterPanel() {
    const panel = $('fm-panel');
    if (!panel) return;
    if (YAML_MODE === 'panel' && capturedFrontMatter !== null) {
        const pre = $('fm-content');
        if (pre && pre.textContent !== capturedFrontMatter)  {
            pre.textContent = capturedFrontMatter;
        }
        panel.style.display = '';
    } else {
        panel.style.display = 'none';
    }
}

export function setupMarkdown() {
    if (!window.markdownit) {
        throw new Error('markdown-it failed to load from the CDN. Check your internet connection.');
    }
    md = window.markdownit({
        // Raw HTML passthrough is configurable: untrusted markdown can
        // otherwise inject handlers/scripts into this page. Defaults to
        // enabled (GitHub-like) when the attribute is absent.
        html: document.documentElement.dataset.allowHtml !== 'false',
        linkify: true,
        typographer: true,
        highlight: function (str, lang) {
            if (lang && lang.toLowerCase() === 'mermaid') {
                const encoded = encodeURIComponent(str);
                return `<div class="mermaid-block" data-mermaid-source="${encoded}">
                            <div class="mermaid-svg-wrap">
                                <p style="color:var(--fg-muted);font-size:.85rem">Rendering diagram&hellip;</p>
                            </div>
                        </div>`;
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

    // Display math has no source range of its own: wrap it so cursor sync
    // can find it. Generated HTML, so a wrapper is safe here.
    for (const name of ['math_block', 'math_block_eqno']) {
        const inner = md.renderer.rules[name];
        if (!inner) continue;
        md.renderer.rules[name] = (tokens, idx, ...rest) => {
            const t = tokens[idx];
            const html = inner(tokens, idx, ...rest);
            if (!t.map) return html;
            return `<div class="math-block"
                         data-kind="math"
                         data-source-line="${t.map[0]}"
                         data-source-end="${mathBlockEnd(t)}">
                        ${html}
                    </div>`;
        };
    }

    md.renderer.rules.paragraph_open = injectLineNumbers;
    md.renderer.rules.heading_open = injectLineNumbers;
    md.renderer.rules.list_item_open = injectLineNumbers;
    md.renderer.rules.table_open = injectLineNumbers;
    md.renderer.rules.tr_open = injectLineNumbers;
    md.renderer.rules.blockquote_open = injectLineNumbers;

    // Raw HTML blocks carry no source range. Emit an empty marker before them
    // instead of wrapping them: raw HTML may be unbalanced (an opening <div>
    // closed by a later block), and a wrapper would swallow the difference.
    md.renderer.rules.html_block = (tokens, idx) => {
        const t = tokens[idx];
        const mark = t.map
            ? `<span hidden data-kind="html" data-source-line="${t.map[0]}" data-source-end="${t.map[1]}"></span>`
            : '';
        return mark + t.content;
    };

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
            return `<div class="mermaid-block source-line"${lineAttr} id="${stableId}" data-mermaid-source="${encoded}" data-graph="mermaid">
                        <button class="mermaid-expand-btn" title="Expand diagram" data-expand="${stableId}">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke="currentColor" stroke-width="2"
                                    stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    <div class="mermaid-svg-wrap"><p style="color:var(--fg-muted);font-size:.85rem">Rendering&hellip;</p></div>
                    </div>`;
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

// Exclusive end line of a display-math block. Found by looking for the closing
// delimiter instead of trusting token.map, which can stop a line short.
function mathBlockEnd(t) {
    const s = t.map[0];
    const L = (l) => g.srcLines[l] || '';
    if (t.tag === 'beg_end') {
        let depth = 0;
        for (let l = s; l < g.srcLines.length; l++) {
            depth += (L(l).match(/\\begin\{/g) || []).length;
            depth -= (L(l).match(/\\end\{/g) || []).length;
            if (depth <= 0) return l + 1;
        }
    } else if (t.tag === '$$') {
        const open = L(s).indexOf('$$');
        if (open >= 0 && L(s).indexOf('$$', open + 2) >= 0) return s + 1;   // one-liner
        for (let l = s + 1; l < g.srcLines.length; l++) if (L(l).includes('$$')) return l + 1;
    }
    return Math.max(t.map[1], s + 1);
}
