import { state } from '../core/state.js';
import { on, emit } from '../core/events.js';

const FAV_KEY    = 'slate.v1.fav';
const RECENT_KEY = 'slate.v1.recent';
const RECENT_MAX = 5;

let sidebar;
let recentTools = [];
let favouriteTools = [];

const TOOL_META = {
  crop:       { icon: 'crop',       label: 'Crop' },
  redact:     { icon: 'redact',     label: 'Redact' },
  blur:       { icon: 'blur',       label: 'Blur' },
  pixelate:   { icon: 'pixelate',   label: 'Pixelate' },
  text:       { icon: 'text',       label: 'Text' },
  arrow:      { icon: 'arrow',      label: 'Arrow' },
  pencil:     { icon: 'pencil',     label: 'Freehand' },
  shape:      { icon: 'shape',      label: 'Shape' },
  eyedropper: { icon: 'eyedropper', label: 'Eyedropper' },
};

export function initRightSidebar() {
  sidebar = document.getElementById('right-sidebar');
  if (!sidebar) return;

  loadFavs();
  loadRecent();

  on('tool:changed', ({ tool }) => {
    if (tool && TOOL_META[tool]) {
      recentTools = [tool, ...recentTools.filter(t => t !== tool)].slice(0, RECENT_MAX);
      saveRecent();
      render();
    }
  });

  render();
}

function render() {
  if (!sidebar) return;

  const hasFavs = favouriteTools.length > 0;
  const hasRecent = recentTools.length > 0;

  const guideFooter = `<a class="rs-foot-link" href="guide/" target="_blank" rel="noopener" title="Open full guide" aria-label="Open full guide">📖</a>`;

  if (!hasFavs && !hasRecent) {
    sidebar.innerHTML = `<div class="rs-empty-hint">Use a tool to see it here</div>${guideFooter}`;
    return;
  }

  let html = '';

  if (hasFavs) {
    html += `<div class="rs-section-label">Favs</div><div class="rs-group">`;
    for (const tool of favouriteTools) html += renderBtn(tool, true);
    html += `</div>`;
  }

  if (hasRecent) {
    html += `<div class="rs-section-label">Recent</div><div class="rs-group">`;
    for (const tool of recentTools) html += renderBtn(tool, false);
    html += `</div>`;
  }

  html += guideFooter;
  sidebar.innerHTML = html;

  sidebar.querySelectorAll('[data-rs-tool]').forEach(btn => {
    const tool = btn.dataset.rsTool;
    btn.addEventListener('click', () => emit('tool:activate', { tool }));
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleFav(tool); });

    let pressTimer = null;
    btn.addEventListener('pointerdown', () => { pressTimer = setTimeout(() => toggleFav(tool), 450); });
    btn.addEventListener('pointerup', () => clearTimeout(pressTimer));
    btn.addEventListener('pointermove', () => clearTimeout(pressTimer));
  });
}

function renderBtn(tool, _isFavSection) {
  const meta = TOOL_META[tool];
  if (!meta) return '';
  const starred = favouriteTools.includes(tool);
  const active = state.activeTool === tool;
  return `
    <div class="rs-btn-wrap">
      <button class="btn-icon rs-btn${active ? ' active' : ''}"
              data-rs-tool="${tool}"
              data-tip="${meta.label}"
              title="${meta.label}${starred ? ' ★' : ''}"
              aria-label="${meta.label}"
              aria-pressed="${active}">
        <svg class="icon" aria-hidden="true"><use href="#icon-${meta.icon}"/></svg>
      </button>
      ${starred ? '<span class="rs-star">★</span>' : ''}
    </div>`;
}

function toggleFav(tool) {
  const idx = favouriteTools.indexOf(tool);
  if (idx >= 0) {
    favouriteTools.splice(idx, 1);
    emit('toast', { message: `${TOOL_META[tool]?.label ?? tool} removed from favourites`, level: 'ok', duration: 1500 });
  } else {
    favouriteTools.push(tool);
    emit('toast', { message: `${TOOL_META[tool]?.label ?? tool} added to favourites`, level: 'ok', duration: 1500 });
  }
  saveFavs();
  render();
}

function loadFavs() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (raw) favouriteTools = sanitizeToolList(JSON.parse(raw));
  } catch {}
}

function saveFavs() {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(favouriteTools));
  } catch {}
}

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw) recentTools = sanitizeToolList(JSON.parse(raw));
  } catch {}
}

function sanitizeToolList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(t => typeof t === 'string' && Object.prototype.hasOwnProperty.call(TOOL_META, t));
}

function saveRecent() {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentTools));
  } catch {}
}
