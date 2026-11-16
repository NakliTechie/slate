import { state, savePrefs } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { markDirty } from './viewer.js';

let panel, fields = {}, readout;
let dragging = false, dragOff = { x: 0, y: 0 };

export function initPanels() {
  panel = document.getElementById('numeric-panel');
  if (!panel) return;

  panel.innerHTML = `
    <div class="panel-title">Selection</div>
    <div class="panel-fields">
      <label for="pf-x">X</label><input id="pf-x" type="number" min="0" step="1">
      <label for="pf-y">Y</label><input id="pf-y" type="number" min="0" step="1">
      <label for="pf-w">W</label><input id="pf-w" type="number" min="1" step="1">
      <label for="pf-h">H</label><input id="pf-h" type="number" min="1" step="1">
    </div>
    <div class="panel-readout" id="panel-readout"></div>
  `;

  fields.x = panel.querySelector('#pf-x');
  fields.y = panel.querySelector('#pf-y');
  fields.w = panel.querySelector('#pf-w');
  fields.h = panel.querySelector('#pf-h');
  readout = panel.querySelector('#panel-readout');

  // Inputs → state
  for (const [key, input] of Object.entries(fields)) {
    input.addEventListener('change', () => applyField(key, parseInt(input.value, 10)));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { applyField(key, parseInt(input.value, 10)); e.preventDefault(); }
      if (e.key === 'Tab') return; // allow normal tab
    });
  }

  // Tab cycle x→y→w→h→x
  const order = [fields.x, fields.y, fields.w, fields.h];
  order.forEach((inp, i) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        order[(i + (e.shiftKey ? -1 + order.length : 1)) % order.length].focus();
      }
    });
  });

  // Draggable (desktop only)
  if (window.matchMedia('(min-width: 768px)').matches) {
    panel.addEventListener('mousedown', startDrag);
  }

  // Restore saved position
  if (state._numericPanelPos) {
    panel.style.left = state._numericPanelPos.x + 'px';
    panel.style.top  = state._numericPanelPos.y + 'px';
  } else {
    panel.style.right = '16px';
    panel.style.top = '48px';
  }

  on('selection:changed', updateFromState);
  on('image:loaded', updateFromState);
  on('image:loaded', () => showPanel(state.activeTool === 'crop'));
}

function applyField(key, val) {
  if (isNaN(val)) return;
  const { selection, image } = state;
  if (!selection.shape) return;
  if (key === 'x') selection.x = Math.max(0, Math.min(image.width - selection.w, val));
  if (key === 'y') selection.y = Math.max(0, Math.min(image.height - selection.h, val));
  if (key === 'w') selection.w = Math.max(1, Math.min(image.width - selection.x, val));
  if (key === 'h') selection.h = Math.max(1, Math.min(image.height - selection.y, val));
  updateFromState();
  emit('selection:changed', selection);
  markDirty();
}

function updateFromState() {
  if (!panel) return;
  const { selection, image } = state;
  if (!selection.shape) {
    fields.x.value = ''; fields.y.value = '';
    fields.w.value = ''; fields.h.value = '';
    if (readout) readout.textContent = image.original ? `${image.width} × ${image.height} px` : '';
    return;
  }

  fields.x.value = Math.round(selection.x);
  fields.y.value = Math.round(selection.y);
  fields.w.value = Math.round(selection.w);
  fields.h.value = Math.round(selection.h);

  if (readout && image.original) {
    const pct = Math.round(Math.max(selection.w, selection.h) / Math.max(image.original.width, image.original.height) * 100);
    const ar = simplifyRatio(selection.w, selection.h);
    readout.textContent = `${selection.w} × ${selection.h} px · ${pct}% · ${ar}`;
  }
}

function simplifyRatio(w, h) {
  if (!w || !h) return '';
  const g = gcd(w, h);
  const rw = w / g, rh = h / g;
  if (rw > 20 || rh > 20) return (w / h).toFixed(2) + ':1';
  return `${rw}:${rh}`;
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

export function showPanel(visible) {
  panel?.classList.toggle('hidden', !visible);
}

// ── Draggable panel ────────────────────────────────────────────────────────────

function startDrag(e) {
  if (e.target.tagName === 'INPUT') return;
  dragging = true;
  dragOff.x = e.clientX - panel.getBoundingClientRect().left;
  dragOff.y = e.clientY - panel.getBoundingClientRect().top;
  window.addEventListener('mousemove', doDrag);
  window.addEventListener('mouseup', endDrag);
  e.preventDefault();
}

function doDrag(e) {
  if (!dragging) return;
  const x = e.clientX - dragOff.x;
  const y = e.clientY - dragOff.y;
  panel.style.left = x + 'px';
  panel.style.top  = y + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

function endDrag() {
  dragging = false;
  window.removeEventListener('mousemove', doDrag);
  window.removeEventListener('mouseup', endDrag);
  const rect = panel.getBoundingClientRect();
  state._numericPanelPos = { x: rect.left, y: rect.top };
  savePrefs();
}
