import g, { $ } from "./global.js";

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

// Overlay state
let ovSvgSource = '';
let ovBaseW = 0, ovBaseH = 0;
let ovZoom = 1;
let ovFitMode = 'width';
let ovDragging = false, ovStartX = 0, ovStartY = 0, ovStartL = 0, ovStartT = 0;

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


export function setupOverlay() {
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
    g.contentEl.addEventListener('click', (e) => {
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
}
