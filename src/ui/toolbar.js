import { state, FLAGS } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { openFileFSA, openFolderFSA, openFileFallback, openFromClipboard } from '../core/fs.js';
import { fitToWindow, fitToWidth, fitToHeight, fit1to1, fitFill, zoomStep, toggleFullscreen } from './viewer.js';
import { showHelp } from './help.js';
import { toggleThumbstrip } from './thumbstrip.js';
import { setRulersVisible } from './rulers.js';
import { savePrefs } from '../core/state.js';
import { esc } from '../core/html.js';
import { canDescribe } from '../ops/describe.js';

function icon(id, cls = '') {
  return `<svg class="icon${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#icon-${id}"/></svg>`;
}

function btn(id, iconId, label, attrs = '') {
  return `<button id="${id}" class="btn-icon" title="${label}" aria-label="${label}" ${attrs}>${icon(iconId)}</button>`;
}

export function initToolbar() {
  const toolbar = document.getElementById('toolbar');
  if (!toolbar) return;

  toolbar.innerHTML = `
    <div class="toolbar-brand" aria-hidden="true">Slate</div>
    <div class="toolbar-group" aria-label="File">
      ${btn('tb-open', 'file', 'Open file (Ctrl+O)')}
      ${btn('tb-open-folder', 'folder', 'Open folder (Ctrl+Shift+O)')}
      ${btn('tb-paste', 'clipboard', 'Paste from clipboard (Ctrl+V)')}
      ${btn('tb-save', 'save', 'Save (Ctrl+S)')}
    </div>
    <div class="toolbar-group" aria-label="Edit">
      ${btn('tb-undo', 'undo', 'Undo (Ctrl+Z)', 'disabled')}
      ${btn('tb-redo', 'redo', 'Redo (Ctrl+Shift+Z)', 'disabled')}
    </div>
    <div class="toolbar-group" aria-label="Tools">
      ${btn('tb-crop', 'crop', 'Crop (C)', 'aria-pressed="false"')}
      ${btn('tb-text', 'text', 'Text tool (Shift+T)', 'aria-pressed="false"')}
      ${btn('tb-redact', 'redact', 'Redact (R)', 'aria-pressed="false"')}
      ${btn('tb-blur', 'blur', 'Blur (B)', 'aria-pressed="false"')}
      ${btn('tb-pencil', 'pencil', 'Freehand (P)', 'aria-pressed="false"')}
      ${btn('tb-arrow', 'arrow', 'Arrow tool (A)', 'aria-pressed="false"')}
      ${btn('tb-shape', 'shape', 'Shapes (S)', 'aria-pressed="false"')}
      ${btn('tb-pixelate', 'pixelate', 'Pixelate (X)', 'aria-pressed="false"')}
      ${btn('tb-eyedropper', 'eyedropper', 'Pick colour (I)', 'aria-pressed="false"')}
      ${btn('tb-rotate-cw', 'rotate-cw', 'Rotate 90° CW')}
      ${btn('tb-rotate-ccw', 'rotate-ccw', 'Rotate 90° CCW')}
      ${btn('tb-flip-h', 'flip-h', 'Flip horizontal')}
      ${btn('tb-flip-v', 'flip-v', 'Flip vertical')}
      ${btn('tb-straighten', 'straighten', 'Straighten')}
      ${btn('tb-adjust', 'adjust', 'Brightness / Contrast')}
      ${btn('tb-sharpen', 'sharpen', 'Sharpen')}
      ${btn('tb-resize', 'resize', 'Resize image')}
      ${btn('tb-ocr', 'scan-text', 'Extract text')}
      ${btn('tb-lensblur', 'lens-blur', 'Background blur')}
    </div>
    <div class="toolbar-group" aria-label="View">
      ${btn('tb-zoom-in', 'zoom-in', 'Zoom in (Ctrl++)')}
      ${btn('tb-zoom-out', 'zoom-out', 'Zoom out (Ctrl+-)')}
      ${btn('tb-fullscreen', 'maximize', 'Fullscreen (F)')}
      ${btn('tb-rulers', 'ruler', 'Toggle rulers (Ctrl+R)', 'aria-pressed="true"')}
      ${btn('tb-thumbstrip', 'thumbstrip', 'Toggle thumbnails (T)', 'aria-pressed="true"')}
      ${btn('tb-info', 'info', 'Image info')}
    </div>
    <div class="toolbar-group" aria-label="Tools menu" style="margin-top:auto">
      ${btn('tb-fit', 'minimize', 'Fit to window')}
      ${btn('tb-batch', 'batch', 'Batch operations…')}
      ${btn('tb-gallery', 'grid', 'Contact sheet / gallery…')}
      ${btn('tb-jpeg-rotate', 'rotate-cw', 'Lossless JPEG rotate…')}
      ${FLAGS.slideshow ? btn('tb-slideshow', 'play', 'Slideshow') : ''}
      ${btn('tb-theme', 'moon', 'Toggle theme')}
      ${btn('tb-help', 'help', 'Help (?)')}
    </div>
  `;

  bindButton('tb-open', () => openFileFSA());
  bindButton('tb-open-folder', () => openFolderFSA());
  bindButton('tb-paste', () => openFromClipboard());
  bindButton('tb-save', () => emit('modal:export', null));

  bindButton('tb-undo', () => emit('history:undo', null));
  bindButton('tb-redo', () => emit('history:redo', null));

  // Tool buttons
  const tools = ['crop', 'redact', 'blur', 'text', 'arrow', 'pencil', 'shape', 'pixelate', 'eyedropper'];
  for (const tool of tools) {
    bindButton(`tb-${tool}`, () => setActiveTool(tool === state.activeTool ? null : tool));
  }

  bindButton('tb-rotate-cw', () => emit('op:rotate', { deg: 90 }));
  bindButton('tb-rotate-ccw', () => emit('op:rotate', { deg: -90 }));
  bindButton('tb-flip-h', () => emit('op:flip', { axis: 'h' }));
  bindButton('tb-flip-v', () => emit('op:flip', { axis: 'v' }));
  bindButton('tb-straighten', () => emit('modal:straighten', null));
  bindButton('tb-adjust', () => emit('modal:adjust', null));
  bindButton('tb-ocr', () => emit('modal:ocr', null));
  bindButton('tb-lensblur', () => emit('modal:lensblur', null));
  bindButton('tb-sharpen', () => emit('modal:sharpen', null));
  bindButton('tb-resize', () => emit('modal:resize', null));

  bindButton('tb-zoom-in', () => zoomStep(1));
  bindButton('tb-zoom-out', () => zoomStep(-1));
  bindButton('tb-fit', () => fitToWindow());
  bindButton('tb-fullscreen', () => toggleFullscreen());
  bindButton('tb-rulers', () => {
    const newVal = !state.view.rulers;
    setRulersVisible(newVal);
    document.getElementById('tb-rulers')?.setAttribute('aria-pressed', String(newVal));
    savePrefs();
  });
  bindButton('tb-thumbstrip', () => {
    toggleThumbstrip();
    const vis = !document.getElementById('thumbstrip-bar')?.classList.contains('hidden');
    document.getElementById('tb-thumbstrip')?.setAttribute('aria-pressed', String(vis));
    savePrefs();
  });
  bindButton('tb-info', () => toggleInfoPanel());
  bindButton('tb-batch', () => emit('modal:batch', null));
  bindButton('tb-gallery', () => emit('modal:gallery', null));
  bindButton('tb-jpeg-rotate', () => emit('modal:jpeg-rotate', null));
  if (FLAGS.slideshow) bindButton('tb-slideshow', () => emit('slideshow:start', null));

  bindButton('tb-help', () => showHelp());

  bindButton('tb-theme', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    const icon = document.querySelector('#tb-theme .icon use');
    if (icon) icon.setAttribute('href', `#icon-${next === 'light' ? 'moon' : 'sun'}`);
    savePrefs();
  });

  on('tool:activate', ({ tool }) => setActiveTool(tool === state.activeTool ? null : tool));

  on('history:changed', ({ canUndo, canRedo }) => {
    const u = document.getElementById('tb-undo');
    const r = document.getElementById('tb-redo');
    if (u) u.disabled = !canUndo;
    if (r) r.disabled = !canRedo;
  });

  on('image:loaded', () => {
    setToolsEnabled(true);
    updateDirtyDot(false);
  });

  on('history:changed', ({ canUndo }) => {
    updateDirtyDot(canUndo);
  });

  on('save:complete', () => updateDirtyDot(false));

  if (state.activeTool) setActiveTool(state.activeTool);
}

function bindButton(id, handler) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', handler);
}

function setToolsEnabled(enabled) {
  const ids = ['tb-save','tb-crop','tb-redact','tb-blur','tb-pixelate','tb-rotate-cw','tb-rotate-ccw',
    'tb-flip-h','tb-flip-v','tb-straighten','tb-adjust','tb-sharpen','tb-text','tb-arrow','tb-pencil',
    'tb-shape','tb-eyedropper','tb-resize','tb-ocr','tb-lensblur','tb-zoom-in','tb-zoom-out','tb-fullscreen','tb-rulers','tb-thumbstrip','tb-info'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
}

function setActiveTool(tool) {
  state.activeTool = tool;
  const tools = ['crop', 'redact', 'blur', 'text', 'arrow', 'pencil', 'shape', 'pixelate', 'eyedropper'];
  for (const t of tools) {
    document.getElementById(`tb-${t}`)?.setAttribute('aria-pressed', String(t === tool));
  }
  emit('tool:changed', { tool });
}

function toggleInfoPanel() {
  const panel = document.getElementById('info-panel');
  if (panel) { panel.classList.toggle('hidden'); updateInfoPanel(); }
}

function updateInfoPanel() {
  const panel = document.getElementById('info-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  const { image, session } = state;
  if (!image.original) return;

  const entry = session.files[session.currentIndex];
  const rows = [
    ['Dimensions', `${image.width} × ${image.height} px`],
    ['Format', image.format?.toUpperCase() ?? '—'],
    entry?.size ? ['File size', formatBytes(entry.size)] : null,
  ];

  if (image.exif) {
    const e = image.exif;
    if (e.make || e.model) rows.push(['Camera', [e.make, e.model].filter(Boolean).join(' ')]);
    if (e.dateTimeOriginal) rows.push(['Date', e.dateTimeOriginal]);
    if (e.isoSpeedRatings) rows.push(['ISO', e.isoSpeedRatings]);
  }

  const hasGPS = image.exif?.hasGPS;
  const recipe = image.recipe;
  const recipeNames = recipe ? [...new Set(recipe.ops.map(o => o.op))].join(', ') : '';

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <strong style="font-size:12px">Image Info</strong>
      <button class="btn-icon" onclick="this.closest('#info-panel').classList.add('hidden')" aria-label="Close">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-x"/></svg>
      </button>
    </div>
    ${rows.filter(Boolean).map(([k, v]) => `
      <div class="info-row"><span class="info-label">${esc(k)}</span><span class="info-value">${esc(v)}</span></div>
    `).join('')}
    ${hasGPS ? `<div class="info-gps-warn">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-warn"/></svg>
      This image contains GPS location data.
    </div>` : ''}
    ${canDescribe() ? `<button class="btn" id="info-describe" type="button">Describe with AI…</button>` : ''}
    ${recipe ? `<div class="info-recipe">
      <div class="info-row"><span class="info-label">Edited in Slate</span><span class="info-value">${recipe.ops.length} edit${recipe.ops.length === 1 ? '' : 's'}: ${esc(recipeNames)}</span></div>
      <button class="btn" id="info-apply-recipe" type="button" title="Apply the same edits to the image that is open now">Apply these edits to an image…</button>
    </div>` : ''}
  `;
  panel.querySelector('#info-describe')?.addEventListener('click', () => emit('modal:describe', null));
  panel.querySelector('#info-apply-recipe')?.addEventListener('click', () => {
    // Keep the list, then apply it to whatever image is open when the person clicks "Apply edits" in the toast.
    state._copiedRecipe = recipe;
    emit('toast', { message: `Copied ${recipe.ops.length} edits. Open another image, then press Ctrl+Shift+V to apply them.`, level: 'ok', duration: 6000 });
  });
}

function updateDirtyDot(dirty) {
  const btn = document.getElementById('tb-save');
  if (!btn) return;
  let dot = btn.querySelector('.dirty-dot');
  if (dirty && !dot) {
    dot = document.createElement('span');
    dot.className = 'dirty-dot';
    btn.appendChild(dot);
  } else if (!dirty && dot) {
    dot.remove();
  }
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

on('image:loaded', updateInfoPanel);
