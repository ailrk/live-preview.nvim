export const $ = (id) => document.getElementById(id);

const contentEl = $('content');
const loadingSkeleton = $('loadingSkeleton');

const BOTTOM_PADDING = parseFloat(document.documentElement.dataset.bottomPadding) || 0.5;

export function showContent() {
    if (loadingSkeleton) loadingSkeleton.style.display = 'none';
    contentEl.style.display = '';
}

export function applyBottomPadding() {
    contentEl.style.paddingBottom = `${(1 - BOTTOM_PADDING) * window.innerHeight}px`;
}

export default {
    srcLines: [],
    contentEl,
}
