import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.esm.min.mjs';
export { mermaid };

let mermaidIdCounter = 0;
const loadedPacks = new Set();
const lastGoodSvg = {};

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

export async function renderMermaidBlock(block) {
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

export async function renderAllMermaidBlocks() {
    const blocks = contentEl.querySelectorAll('.mermaid-block[data-mermaid-source]:not([data-prerendered])');
    for (const block of blocks) {
        await renderMermaidBlock(block);
    }
}
