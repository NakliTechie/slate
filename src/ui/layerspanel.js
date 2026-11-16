import { state } from '../core/state.js';
import { on } from '../core/events.js';
import { removeLayer, toggleLayer, moveLayer } from '../core/layers.js';
import { esc } from '../core/html.js';

let _panel = null;

export function initLayersPanel() {
  on('layers:changed', render);
  on('image:loaded',   render);
  render();
}

function ensurePanel() {
  if (_panel) return _panel;
  _panel = document.createElement('div');
  _panel.id = 'layers-panel';
  _panel.setAttribute('role', 'complementary');
  _panel.setAttribute('aria-label', 'Layers');
  document.getElementById('app')?.appendChild(_panel);
  return _panel;
}

function layerLabel(l) {
  if (l.type === 'text') {
    const content = (l.params.content ?? '').slice(0, 24);
    return content || 'Text';
  }
  if (l.type === 'arrow')  return 'Arrow';
  if (l.type === 'pencil') {
    const n = l.params.points?.length ?? 0;
    return `Freehand · ${n} pt`;
  }
  if (l.type === 'shape') {
    const m = l.params.mode ?? 'rect';
    return m === 'rect' ? 'Rectangle' : m === 'circle' ? 'Oval' : m === 'line' ? 'Line' : 'Shape';
  }
  return l.type;
}

function layerGlyph(l) {
  if (l.type === 'text')   return 'T';
  if (l.type === 'arrow')  return '↗';
  if (l.type === 'pencil') return '✎';
  if (l.type === 'shape') {
    const m = l.params.mode ?? 'rect';
    return m === 'rect' ? '▭' : m === 'circle' ? '○' : m === 'line' ? '╱' : '◆';
  }
  return '◆';
}

function render() {
  const panel = ensurePanel();
  const layers = state.layers;

  if (!state.image.working || layers.length === 0) {
    panel.classList.remove('visible');
    panel.innerHTML = '';
    return;
  }

  // Top layer renders last (on top visually). Show newest-on-top in the list too
  // to match mental model.
  const rows = [...layers].reverse().map(l => `
    <div class="lp-row" data-id="${l.id}">
      <span class="lp-glyph" aria-hidden="true">${layerGlyph(l)}</span>
      <span class="lp-label">${esc(layerLabel(l))}</span>
      <button class="lp-btn" data-act="up" title="Move up" aria-label="Move up">↑</button>
      <button class="lp-btn" data-act="down" title="Move down" aria-label="Move down">↓</button>
      <button class="lp-btn" data-act="vis" title="${l.visible ? 'Hide' : 'Show'}" aria-label="Toggle visibility">${l.visible ? '👁' : '∅'}</button>
      <button class="lp-btn lp-del" data-act="del" title="Delete layer" aria-label="Delete layer">✕</button>
    </div>
  `).join('');

  panel.innerHTML = `
    <div class="lp-header">
      <span class="lp-title">Layers</span>
      <span class="lp-count">${layers.length}</span>
    </div>
    <div class="lp-body">${rows}</div>
    <div class="lp-foot">Layers flatten into the image on Save or any transform.</div>
  `;
  panel.classList.add('visible');

  panel.querySelectorAll('.lp-row').forEach(row => {
    const id = +row.dataset.id;
    row.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'del') removeLayer(id);
        else if (act === 'vis') toggleLayer(id);
        else if (act === 'up')  moveLayer(id, +1);
        else if (act === 'down') moveLayer(id, -1);
      });
    });
  });
}
