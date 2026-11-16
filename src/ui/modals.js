import { state, savePrefs } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { hasDirPicker } from '../core/fs.js';
import { esc } from '../core/html.js';

export function initModals() {
  on('modal:resize',    showResize);
  on('modal:adjust',    showAdjust);
  on('modal:sharpen',   showSharpen);
  on('modal:straighten', showStraighten);
  on('modal:export',    showExport);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function icon(id) {
  return `<svg class="icon icon-sm" aria-hidden="true"><use href="#icon-${id}"/></svg>`;
}

function getOrCreate(id) {
  let dlg = document.getElementById(id);
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = id;
    document.body.appendChild(dlg);
  }
  return dlg;
}

function slider(id, label, min, max, step, value, unit = '') {
  return `
    <div class="modal-field-row">
      <label for="${id}">${label}</label>
      <div class="modal-slider-wrap">
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
        <output id="${id}-out" for="${id}">${value}${unit}</output>
      </div>
    </div>`;
}

function bindSlider(dlg, id, unit = '', onChange) {
  const inp = dlg.querySelector(`#${id}`);
  const out = dlg.querySelector(`#${id}-out`);
  if (!inp) return;
  inp.addEventListener('input', () => {
    out.textContent = inp.value + unit;
    onChange?.();
  });
}

function modalFooter() {
  return `
    <div class="modal-footer">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-apply>${icon('check')} Apply</button>
    </div>`;
}

function bindFooter(dlg, onApply) {
  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-apply]').addEventListener('click', () => { onApply(); dlg.close(); });
}

// ── Resize ────────────────────────────────────────────────────────────────────

function showResize() {
  if (!state.image.working) return;
  const W = state.image.width, H = state.image.height;
  const dlg = getOrCreate('modal-resize');

  dlg.innerHTML = `
    <div class="modal-header"><h2>Resize Image</h2></div>
    <div class="modal-fields">
      <div class="modal-field-row">
        <label for="rs-w">Width</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="rs-w" min="1" max="99999" value="${W}" style="width:90px">
          <span class="modal-unit">px</span>
        </div>
      </div>
      <div class="modal-field-row">
        <label for="rs-h">Height</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="rs-h" min="1" max="99999" value="${H}" style="width:90px">
          <span class="modal-unit">px</span>
        </div>
      </div>
      <div class="modal-field-row">
        <label>
          <input type="checkbox" id="rs-lock" checked>
          Lock aspect ratio
        </label>
      </div>
      <p class="modal-info">Original: ${W} × ${H} px</p>
    </div>
    ${modalFooter()}
  `;

  const ar = W / H;
  const wIn = dlg.querySelector('#rs-w');
  const hIn = dlg.querySelector('#rs-h');
  const lock = dlg.querySelector('#rs-lock');

  wIn.addEventListener('input', () => { if (lock.checked) hIn.value = Math.round(wIn.value / ar); });
  hIn.addEventListener('input', () => { if (lock.checked) wIn.value = Math.round(hIn.value * ar); });

  bindFooter(dlg, () => {
    const w = parseInt(wIn.value, 10);
    const h = parseInt(hIn.value, 10);
    if (w > 0 && h > 0) emit('op:resize', { w, h });
  });

  dlg.showModal();
}

// ── Adjust ────────────────────────────────────────────────────────────────────

function showAdjust() {
  if (!state.image.working) return;
  const dlg = getOrCreate('modal-adjust');

  dlg.innerHTML = `
    <div class="modal-header"><h2>Adjust</h2></div>
    <div class="modal-fields">
      ${slider('adj-br', 'Brightness', -100, 100, 1, 0)}
      ${slider('adj-co', 'Contrast',   -100, 100, 1, 0)}
      ${slider('adj-sa', 'Saturation', -100, 200, 1, 0)}
    </div>
    ${modalFooter()}
  `;

  bindSlider(dlg, 'adj-br');
  bindSlider(dlg, 'adj-co');
  bindSlider(dlg, 'adj-sa');

  bindFooter(dlg, () => {
    const br = +dlg.querySelector('#adj-br').value;
    const co = +dlg.querySelector('#adj-co').value;
    const sa = +dlg.querySelector('#adj-sa').value;
    if (br !== 0 || co !== 0 || sa !== 0) emit('op:adjust', { brightness: br, contrast: co, saturation: sa });
  });

  dlg.showModal();
}

// ── Sharpen ───────────────────────────────────────────────────────────────────

function showSharpen() {
  if (!state.image.working) return;
  const dlg = getOrCreate('modal-sharpen');

  dlg.innerHTML = `
    <div class="modal-header"><h2>Sharpen</h2></div>
    <div class="modal-fields">
      ${slider('sh-amt', 'Amount', 0.1, 5, 0.1, 1.0)}
    </div>
    ${modalFooter()}
  `;

  bindSlider(dlg, 'sh-amt');

  bindFooter(dlg, () => {
    const amount = +dlg.querySelector('#sh-amt').value;
    emit('op:sharpen', { amount });
  });

  dlg.showModal();
}

// ── Straighten ────────────────────────────────────────────────────────────────

function showStraighten() {
  if (!state.image.working) return;
  const dlg = getOrCreate('modal-straighten');

  dlg.innerHTML = `
    <div class="modal-header"><h2>Straighten</h2></div>
    <div class="modal-fields">
      ${slider('str-deg', 'Angle', -45, 45, 0.5, 0, '°')}
      <p class="modal-info">Canvas will expand to fit the rotated image.</p>
    </div>
    ${modalFooter()}
  `;

  bindSlider(dlg, 'str-deg', '°');

  bindFooter(dlg, () => {
    const deg = +dlg.querySelector('#str-deg').value;
    if (deg !== 0) emit('op:straighten', { deg });
  });

  dlg.showModal();
}

// ── Export / Save ─────────────────────────────────────────────────────────────

function showExport() {
  if (!state.image.working) return;
  const { export: exp, session, image } = state;
  const entry = session.files[session.currentIndex];
  const baseName = entry?.name?.replace(/\.[^.]+$/, '') ?? 'image';
  const hasFSAHandle = !!(entry?.handle);
  const hasFolderHandle = !!(session.folderHandle);

  const dlg = getOrCreate('modal-export');

  const fmts = ['png', 'jpeg', 'webp', 'tiff'];
  const formatRows = fmts.map(f => `
    <label class="export-fmt-option">
      <input type="radio" name="exp-fmt" value="${f}"${exp.format === f ? ' checked' : ''}>
      ${f.toUpperCase()}
    </label>`).join('');

  const saveModes = [
    { value: 'download',    label: 'Download to device',          available: true },
    { value: 'overwrite',   label: 'Overwrite original file',     available: hasFSAHandle },
    { value: 'sidecar',     label: 'Save to workspace folder',    available: hasFolderHandle },
    { value: 'pick-folder', label: 'Choose a folder…',            available: hasDirPicker && !hasFolderHandle },
  ].filter(m => m.available);

  const modeRows = saveModes.map(m => `
    <label class="export-fmt-option">
      <input type="radio" name="exp-mode" value="${m.value}"${exp.saveMode === m.value ? ' checked' : ''}>
      ${m.label}
    </label>`).join('');

  dlg.innerHTML = `
    <div class="modal-header"><h2>Export</h2></div>
    <div class="modal-fields">
      <div class="modal-field-row">
        <label>Format</label>
        <div class="export-fmt-group">${formatRows}</div>
      </div>
      <div class="modal-field-row" id="exp-quality-row">
        <label>Quality</label>
        <div class="modal-slider-wrap">
          <input type="range" id="exp-quality" min="10" max="100" step="1" value="${exp.quality}">
          <output id="exp-quality-out" for="exp-quality">${exp.quality}%</output>
        </div>
      </div>
      <div class="modal-field-row">
        <label>Save to</label>
        <div class="export-fmt-group">${modeRows}</div>
      </div>
      <div class="modal-field-row">
        <label>
          <input type="checkbox" id="exp-strip"${exp.stripExif ? ' checked' : ''}>
          Strip EXIF metadata
        </label>
        <span class="modal-info" style="margin:0;padding-left:4px;font-size:10px;color:var(--fg-2)">JPEG only — PNG/WebP always stripped</span>
      </div>
      <p class="modal-info" id="exp-filename-preview">
        ${image.width} × ${image.height} px — <em>${esc(baseName)}-<span id="exp-ts">yymmddhhmmss</span>.${exp.format === 'jpeg' ? 'jpg' : exp.format === 'tiff' ? 'tif' : exp.format}</em>
      </p>
    </div>
    <div class="modal-footer">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-apply>
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-download"/></svg>
        Save
      </button>
    </div>
  `;

  // Quality row only shown for lossy formats
  function updateQualityRow() {
    const fmt = dlg.querySelector('input[name="exp-fmt"]:checked')?.value ?? 'png';
    // Quality slider is only meaningful for lossy formats
    dlg.querySelector('#exp-quality-row').style.display = (fmt === 'png' || fmt === 'tiff') ? 'none' : '';
    updateFilenamePreview();
  }

  function updateFilenamePreview() {
    const fmt = dlg.querySelector('input[name="exp-fmt"]:checked')?.value ?? 'png';
    const ext = fmt === 'jpeg' ? 'jpg' : fmt === 'tiff' ? 'tif' : fmt;
    dlg.querySelector('#exp-filename-preview').innerHTML =
      `${image.width} × ${image.height} px — <em>${esc(baseName)}-<span id="exp-ts">yymmddhhmmss</span>.${ext}</em>`;
  }

  dlg.querySelectorAll('input[name="exp-fmt"]').forEach(r => r.addEventListener('change', updateQualityRow));
  const qualityInp = dlg.querySelector('#exp-quality');
  const qualityOut = dlg.querySelector('#exp-quality-out');
  qualityInp.addEventListener('input', () => { qualityOut.textContent = qualityInp.value + '%'; });

  updateQualityRow();

  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-apply]').addEventListener('click', async () => {
    exp.format    = dlg.querySelector('input[name="exp-fmt"]:checked')?.value ?? 'png';
    exp.quality   = +qualityInp.value;
    exp.stripExif = dlg.querySelector('#exp-strip').checked;
    const chosenMode = dlg.querySelector('input[name="exp-mode"]:checked')?.value ?? 'download';
    savePrefs();
    dlg.close();

    if (chosenMode === 'pick-folder') {
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        state.session.folderHandle = dirHandle;
        exp.saveMode = 'sidecar';
        document.getElementById('workspace-nudge')?.remove();
        emit('toast', { message: 'Workspace folder set.', level: 'ok', duration: 2000 });
      } catch (err) {
        if (err.name !== 'AbortError') emit('error', { message: `Could not open folder: ${err.message}` });
        return;
      }
    } else {
      exp.saveMode = chosenMode;
    }

    emit('save:request', {});
  });

  dlg.showModal();
}
