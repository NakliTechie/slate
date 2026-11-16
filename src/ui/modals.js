import { parseCube } from '../ops/lut.js';
import { extractText } from '../ops/ocr.js';
import { canDescribe, destination, describeImage } from '../ops/describe.js';
import { state, savePrefs } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { hasDirPicker } from '../core/fs.js';
import { esc } from '../core/html.js';

export function initModals() {
  on('modal:resize',    showResize);
  on('modal:adjust',    showAdjust);
  on('modal:ocr',       showOcr);
  on('modal:describe',  showDescribe);
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
      ${slider('adj-br', 'Exposure', -100, 100, 1, 0)}
      ${slider('adj-co', 'Contrast',   -100, 100, 1, 0)}
      ${slider('adj-sa', 'Saturation', -100, 200, 1, 0)}
      <p class="help-p" style="margin:4px 0 0">Exposure is in stops (±2 at the ends); all three work in linear light.</p>
      <div class="modal-field-row">
        <label for="adj-lut">Look (LUT)</label>
        <div class="modal-slider-wrap">
          <button class="btn" id="adj-lut-pick" type="button">Load .cube file…</button>
          <span id="adj-lut-name" class="help-p" style="margin:0 0 0 8px">None</span>
          <input type="file" id="adj-lut" accept=".cube" hidden>
        </div>
      </div>
      ${slider('adj-lut-s', 'Look strength', 0, 100, 1, 100, '%')}
    </div>
    ${modalFooter()}
  `;
  let lut = null;
  const lutInput = dlg.querySelector('#adj-lut');
  dlg.querySelector('#adj-lut-pick').addEventListener('click', () => lutInput.click());
  lutInput.addEventListener('change', async () => {
    const f = lutInput.files?.[0];
    if (!f) return;
    try {
      lut = { ...parseCube(await f.text()), name: f.name };
      dlg.querySelector('#adj-lut-name').textContent = `${lut.title || f.name} (${lut.size}³)`;
    } catch (err) {
      lut = null;
      dlg.querySelector('#adj-lut-name').textContent = 'None';
      emit('error', { message: `Could not read ${f.name}: ${err.message}` });
    }
  });
  bindSlider(dlg, 'adj-lut-s', '%');

  bindSlider(dlg, 'adj-br');
  bindSlider(dlg, 'adj-co');
  bindSlider(dlg, 'adj-sa');

  bindFooter(dlg, () => {
    const br = +dlg.querySelector('#adj-br').value;
    const co = +dlg.querySelector('#adj-co').value;
    const sa = +dlg.querySelector('#adj-sa').value;
    if (br !== 0 || co !== 0 || sa !== 0) emit('op:adjust', { brightness: br, contrast: co, saturation: sa });
    if (lut) emit('op:lut', { name: lut.name, title: lut.title, size: lut.size, min: lut.min, max: lut.max, data: lut.data, strength: +dlg.querySelector('#adj-lut-s').value });
  });

  dlg.showModal();
}

// ── Extract text ──────────────────────────────────────────────────────────────

async function showOcr() {
  if (!state.image.working) return;
  const dlg = getOrCreate('modal-ocr');
  dlg.setAttribute('aria-label', 'Extract text');
  dlg.innerHTML = `
    <div class="modal-header"><h2>Extract text</h2></div>
    <div class="modal-fields">
      <p class="modal-info" id="ocr-status" role="status">Reading text in this image…</p>
      <textarea id="ocr-text" rows="12" style="width:100%;min-width:420px;font:13px/1.45 ui-monospace,monospace;resize:vertical" aria-label="Extracted text" readonly></textarea>
      <p class="modal-info" style="font-size:11px;color:var(--fg-2)">English text recognition runs on this device. The recogniser (about 5 MB) downloads the first time and is then cached.</p>
    </div>
    <div class="modal-footer">
      <button class="btn" data-cancel>Close</button>
      <button class="btn" id="ocr-save" disabled>Save as .txt</button>
      <button class="btn btn-primary" id="ocr-copy" disabled>${icon('clipboard')} Copy</button>
    </div>`;
  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  const status = dlg.querySelector('#ocr-status'), area = dlg.querySelector('#ocr-text');
  dlg.showModal();
  try {
    const r = await extractText(state.image.working, {
      onProgress: (m) => { if (dlg.open && m?.status) status.textContent = `${m.status[0].toUpperCase()}${m.status.slice(1)}${m.progress ? ` (${Math.round(m.progress * 100)}%)` : ''}…`; },
    });
    if (!dlg.open) return;
    area.value = r.text;
    area.readOnly = false;
    status.textContent = r.text ? `Found ${r.text.split(/\s+/).filter(Boolean).length} words (confidence ${r.confidence}%). You can edit before copying.` : 'No text found in this image.';
    for (const b of dlg.querySelectorAll('#ocr-copy, #ocr-save')) b.disabled = !r.text;
  } catch (err) {
    status.textContent = `Could not read text: ${err.message}. The recogniser needs a connection the first time.`;
  }
  dlg.querySelector('#ocr-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(area.value); emit('toast', { message: 'Text copied.', level: 'ok' }); }
    catch { area.select(); emit('toast', { message: 'Select the text and press Ctrl+C to copy it.', level: 'warn' }); }
  });
  dlg.querySelector('#ocr-save').addEventListener('click', () => {
    const name = (state.session.files[state.session.currentIndex]?.name ?? 'image').replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([area.value], { type: 'text/plain' }));
    a.download = `${name}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
}

// ── Describe (NakliOS host model) ─────────────────────────────────────────────

function showDescribe() {
  if (!state.image.working || !canDescribe()) return;
  const dlg = getOrCreate('modal-describe');
  dlg.setAttribute('aria-label', 'Describe image');
  dlg.innerHTML = `
    <div class="modal-header"><h2>Describe image</h2></div>
    <div class="modal-fields">
      <p class="modal-info" id="desc-where">This sends a copy of the image (at most ${1536} px) to <strong>${esc(destination())}</strong>.</p>
      <p class="modal-info" id="desc-status" role="status"></p>
      <textarea id="desc-text" rows="6" style="width:100%;min-width:420px;resize:vertical" aria-label="Description" hidden></textarea>
      <p class="modal-info" id="desc-keys" hidden></p>
    </div>
    <div class="modal-footer">
      <button class="btn" data-cancel>Close</button>
      <button class="btn btn-primary" id="desc-go">Describe</button>
      <button class="btn btn-primary" id="desc-copy" hidden>${icon('clipboard')} Copy</button>
    </div>`;
  const status = dlg.querySelector('#desc-status'), area = dlg.querySelector('#desc-text');
  let ctl = null;
  dlg.querySelector('[data-cancel]').addEventListener('click', () => { ctl?.abort(); dlg.close(); });
  dlg.querySelector('#desc-go').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    status.textContent = 'Asking the model…';
    ctl = new AbortController();
    try {
      const r = await describeImage(state.image.working, { signal: ctl.signal });
      area.value = r.description; area.hidden = false;
      const keys = dlg.querySelector('#desc-keys');
      if (r.keywords.length) { keys.textContent = `Keywords: ${r.keywords.join(', ')}`; keys.hidden = false; }
      status.textContent = 'You can edit the text before copying it.';
      dlg.querySelector('#desc-go').hidden = true;
      dlg.querySelector('#desc-copy').hidden = false;
    } catch (err) {
      status.textContent = `The model could not describe it: ${err.message}`;
      e.currentTarget.disabled = false;
    }
  });
  dlg.querySelector('#desc-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(area.value); emit('toast', { message: 'Description copied.', level: 'ok' }); }
    catch { area.select(); }
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
      <div class="modal-field-row">
        <label>
          <input type="checkbox" id="exp-embed"${exp.embedEdits ? ' checked' : ''}>
          Embed the edit list
        </label>
        <span class="modal-info" style="margin:0;padding-left:4px;font-size:10px;color:var(--fg-2)">PNG and JPEG: Slate can show and reuse these edits when the file is opened again</span>
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
    exp.embedEdits = dlg.querySelector('#exp-embed').checked;
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
