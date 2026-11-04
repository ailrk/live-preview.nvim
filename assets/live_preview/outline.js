import g, { $ } from "./global.js";

const sidebarOutlineEl = $("sidebarOutline");
const outlineDotEl = $('outlineDot');

export function setupOutlineToggle() {
    // Load initial preference from localStorage if desired
    let isOpen = localStorage.getItem('outline_open') === 'true';

    function updateOutlineState() {
        if (isOpen) {
            sidebarOutlineEl.style.display = 'block';
            document.body.classList.add('has-outline');
            outlineDotEl.classList.add('open');
            generateSidebarOutline();
        } else {
            sidebarOutlineEl.style.display = 'none';
            document.body.classList.remove('has-outline');
            outlineDotEl.classList.remove('open');
        }
        localStorage.setItem('outline_open', isOpen);
    }

    outlineDotEl.addEventListener('click', () => {
        isOpen = !isOpen;
        updateOutlineState();
    });

    // Run once on load
    updateOutlineState();
}

function generateSidebarOutline() {
    // Clear previous outline
    sidebarOutlineEl.innerHTML = '';

    const headers = g.contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headers.length === 0) {
        sidebarOutlineEl.innerHTML = '<p class="outline-empty">No outline available</p>';
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

        link.addEventListener('click', (e) => {
            e.preventDefault();
            // Push the url state
            header.scrollIntoView({ behavior: 'smooth' });
            history.pushState(null, null, `#${id}`);
        });

        listItem.appendChild(link);
        navList.appendChild(listItem);
    });

    sidebarOutlineEl.appendChild(navList);
}
