import g, { $ } from "./global.js";

const sidebarOutlineEl = $("sidebarOutline");
const outlineDotEl = $('outlineDot');

let isOpen = localStorage.getItem('outline_open') === 'true';
let contentObserver = null;

export function setupOutlineToggle() {
    if (!outlineDotEl || !sidebarOutlineEl) return;

    outlineDotEl.addEventListener('click', () => {
        isOpen = !isOpen;
        updateOutlineState();
    });

    updateOutlineState();

    // Start watching content changes immediately
    initContentObserver();
}

function updateOutlineState() {
    if (isOpen) {
        sidebarOutlineEl.style.display = 'block';
        document.body.classList.add('has-outline');
        outlineDotEl.classList.add('open');
        refreshOutline();
    } else {
        sidebarOutlineEl.style.display = 'none';
        document.body.classList.remove('has-outline');
        outlineDotEl.classList.remove('open');
    }
    localStorage.setItem('outline_open', isOpen);
}

// Automatically watch #content for changes
function initContentObserver() {
    if (!g.contentEl) return;

    contentObserver = new MutationObserver((mutations) => {
        if (isOpen) {
            refreshOutline();
        }
    });

    contentObserver.observe(g.contentEl, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

function refreshOutline() {
    if (!isOpen || !sidebarOutlineEl || !g.contentEl) return;

    sidebarOutlineEl.innerHTML = '';

    const headers = g.contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headers.length === 0) {
        sidebarOutlineEl.innerHTML = '<p class="outline-empty" style="padding: 1rem; color: var(--fg-muted);">No outline available</p>';
        return;
    }

    const navList = document.createElement('ul');
    navList.className = 'outline-list';

    headers.forEach((header) => {
        const level = parseInt(header.tagName.substring(1), 10);
        const text = header.textContent;
        const id = header.id;

        const listItem = document.createElement('li');
        listItem.className = `outline-item level-${level}`;

        const link = document.createElement('a');
        link.href = `#${id}`;
        link.textContent = text;

        // Smooth scroling
        link.addEventListener('click', (e) => {
            e.preventDefault();
            header.scrollIntoView({ behavior: 'smooth' });
            history.pushState(null, null, `#${id}`);
        });

        listItem.appendChild(link);
        navList.appendChild(listItem);
    });

    sidebarOutlineEl.appendChild(navList);
}
