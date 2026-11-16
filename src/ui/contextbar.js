import { state, savePrefs } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { clearSelection } from './selection.js';
import { esc } from '../core/html.js';
import { getRecentColors, pushRecentColor } from '../core/colors.js';

// Tools that need a selection rectangle then commit via the bar
const COMMIT_TOOLS = { crop: 'Crop', redact: 'Redact', blur: 'Blur', pixelate: 'Pixelate' };
// Tools that show their settings inline whenever active (no commit button)
const SETTINGS_TOOLS = new Set(['pencil', 'arrow', 'shape']);

let bar;

export function initContextBar() {
  bar = document.getElementById('context-bar');
  if (!bar) return;
  on('tool:changed', updateBar);
  on('selection:changed', updateBar);
  on('image:loaded', () => bar.classList.add('hidden'));
}

function updateBar() {
  const tool = state.activeTool;
  const hasSelection = !!state.selection.shape;

  if (COMMIT_TOOLS[tool] && hasSelection) {
    renderCommit(tool);
  } else if (SETTINGS_TOOLS.has(tool)) {
    renderSettings(tool);
  } else {
    bar.classList.add('hidden');
    bar.innerHTML = '';
  }
}

// ── Commit-mode bar (selection-based ops) ────────────────────────────────────

function renderCommit(tool) {
  const label = COMMIT_TOOLS[tool];

  let strengthSlider = '';
  if (tool === 'blur') {
    strengthSlider = sliderHTML('blur', 'Blur', 2, 40, 1, state.toolSettings.blurStrength, 'px');
  } else if (tool === 'pixelate') {
    strengthSlider = sliderHTML('pixsize', 'Pixel size', 2, 60, 1, state.toolSettings.pixelateSize, 'px');
  }

  bar.innerHTML = `
    ${strengthSlider}${strengthSlider ? '<div class="ctx-divider"></div>' : ''}
    <button class="btn btn-primary" id="ctx-apply">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-check"/></svg>
      ${esc(label)}
    </button>
    <button class="btn" id="ctx-cancel">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-x"/></svg>
      Cancel
    </button>
    <div class="ctx-divider"></div>
    <span class="ctx-hint">Enter to apply · Esc to cancel</span>
  `;
  bar.classList.remove('hidden');

  bindSlider('blur',    'blurStrength', 'px');
  bindSlider('pixsize', 'pixelateSize', 'px');
  bar.querySelector('#ctx-apply').addEventListener('click', applyOp);
  bar.querySelector('#ctx-cancel').addEventListener('click', cancelOp);
}

// ── Settings-mode bar (drawing tools) ─────────────────────────────────────────

function renderSettings(tool) {
  let body = '';
  if (tool === 'pencil') {
    const s = state.toolSettings.pencil;
    body = `
      ${labelHTML('Pencil')}
      ${colorHTML('pencil-color', s.color)}
      ${sliderHTML('pencil-th', 'Size', 1, 30, 1, s.thickness, 'px')}
    `;
  } else if (tool === 'arrow') {
    const s = state.toolSettings.arrow;
    body = `
      ${labelHTML('Arrow')}
      ${colorHTML('arrow-color', s.color)}
      ${sliderHTML('arrow-th', 'Size', 1, 20, 1, s.thickness, 'px')}
      ${sliderHTML('arrow-head', 'Head', 6, 40, 1, s.headSize, 'px')}
    `;
  } else if (tool === 'shape') {
    const s = state.toolSettings.shape;
    body = `
      ${shapeModeHTML(s.mode)}
      ${colorHTML('shape-color', s.color)}
      ${sliderHTML('shape-th', 'Size', 1, 30, 1, s.thickness, 'px')}
      <label class="ctx-check"><input type="checkbox" id="shape-fill"${s.fill ? ' checked' : ''}> Fill</label>
    `;
  }

  bar.innerHTML = body;
  bar.classList.remove('hidden');

  // Wire common controls
  if (tool === 'pencil') {
    bindColor('pencil-color', state.toolSettings.pencil, 'color');
    bindSlider('pencil-th',  'pencil', 'px', 'thickness');
  } else if (tool === 'arrow') {
    bindColor('arrow-color', state.toolSettings.arrow, 'color');
    bindSlider('arrow-th',   'arrow', 'px', 'thickness');
    bindSlider('arrow-head', 'arrow', 'px', 'headSize');
  } else if (tool === 'shape') {
    bar.querySelectorAll('[data-shape-mode]').forEach(b => b.addEventListener('click', () => {
      state.toolSettings.shape.mode = b.dataset.shapeMode;
      bar.querySelectorAll('[data-shape-mode]').forEach(x => x.classList.toggle('active', x === b));
    }));
    bindColor('shape-color', state.toolSettings.shape, 'color');
    bindSlider('shape-th',   'shape', 'px', 'thickness');
    bar.querySelector('#shape-fill')?.addEventListener('change', (e) => { state.toolSettings.shape.fill = e.target.checked; });
  }
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

function labelHTML(text) {
  return `<span class="ctx-label">${esc(text)}</span><div class="ctx-divider"></div>`;
}
function colorHTML(id, value) {
  const recent = getRecentColors();
  const swatches = recent.length
    ? `<div class="ctx-swatches" data-target="${id}">${recent.map(c =>
        `<button class="ctx-swatch" type="button" data-swatch="${c}" style="background:${c}" title="${c}" aria-label="Use ${c}"></button>`
      ).join('')}</div>`
    : '';
  return `<label class="ctx-color"><input type="color" id="${id}" value="${esc(value)}"><span class="ctx-color-label">colour</span></label>${swatches}`;
}
function sliderHTML(id, label, min, max, step, value, unit) {
  return `<div class="ctx-slider-wrap">
    <span>${esc(label)}</span>
    <input type="range" id="ctx-${id}" min="${min}" max="${max}" step="${step}" value="${value}">
    <output id="ctx-${id}-out">${value}${unit}</output>
  </div>`;
}
function shapeModeHTML(current) {
  const modes = [['rect','▭ Rect'],['circle','○ Oval'],['line','╱ Line']];
  return `<div class="ctx-modes">
    ${modes.map(([v, l]) => `<button class="ctx-mode-btn${v===current?' active':''}" data-shape-mode="${v}">${l}</button>`).join('')}
  </div><div class="ctx-divider"></div>`;
}

// ── Wire helpers ─────────────────────────────────────────────────────────────

// For commit-mode sliders that store a top-level toolSettings field
function bindSlider(idStem, settingsKey, unit = 'px', subKey = null) {
  const inp = bar.querySelector('#ctx-' + idStem);
  const out = bar.querySelector('#ctx-' + idStem + '-out');
  if (!inp) return;
  inp.addEventListener('input', () => {
    if (subKey) state.toolSettings[settingsKey][subKey] = +inp.value;
    else state.toolSettings[settingsKey] = +inp.value;
    out.textContent = inp.value + unit;
    savePrefs();
  });
}

function bindColor(idStem, settingsObj, key) {
  const inp = bar.querySelector('#' + idStem);
  if (!inp) return;
  inp.addEventListener('change', () => {
    settingsObj[key] = inp.value;
    pushRecentColor(inp.value);
    savePrefs();
    updateBar();          // re-render so the new colour appears in the swatch row
  });
  // Wire any swatches associated with this picker
  const wrap = bar.querySelector(`.ctx-swatches[data-target="${idStem}"]`);
  wrap?.querySelectorAll('[data-swatch]').forEach(btn => {
    btn.addEventListener('click', () => {
      const hex = btn.dataset.swatch;
      settingsObj[key] = hex;
      inp.value = hex;
      pushRecentColor(hex);
      savePrefs();
      updateBar();
    });
  });
}

// ── Commit / Cancel ──────────────────────────────────────────────────────────

function applyOp() {
  const tool = state.activeTool;
  if (tool === 'crop')     emit('op:crop',     null);
  else if (tool === 'redact')   emit('op:redact',   null);
  else if (tool === 'blur')     emit('op:blur',     null);
  else if (tool === 'pixelate') emit('op:pixelate', null);
}

function cancelOp() {
  clearSelection();
  emit('tool:activate', { tool: state.activeTool });
}
