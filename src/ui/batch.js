import { state } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { hasDirPicker } from '../core/fs.js';
import { formatOf, isSupportedFile, decode } from '../decode/registry.js';
import { parseExif } from '../exif.js';
import { esc } from '../core/html.js';
import { getLibrary } from '../library/boot.js';

// Formats a batch worker can decode by itself with createImageBitmap. Everything
// else (HEIC, TIFF, JXL, PSD, RAW, TGA, DDS) needs the decode registry, whose
// lazy WASM decoders and <img> based SVG rasteriser only exist on the main
// thread — so those get decoded here and the bitmap is transferred in.
const WORKER_DECODABLE = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']);

// Formats the encoder can actually write. When "convert" is off we keep the
// source format, but only if it is one of these — otherwise the encoder would
// silently fall through to JPEG bytes under the source's extension.
const ENCODABLE = new Set(['png', 'jpeg', 'webp']);

function outputFormatFor(file, convert) {
  if (convert.enabled) return convert.format;
  const srcFmt = formatOf(file);
  return ENCODABLE.has(srcFmt) ? srcFmt : 'png';
}

// Runtime state
let _sources  = [];      // [{ name, size, file, handle? }]
let _sourceFolderHandle = null;
let _destFolderHandle   = null;
let _destMode = 'subfolder'; // 'subfolder' | 'picked' | 'overwrite'
let _cancelled = false;
let _sourceLabel = '';

// Operation config — toggled by checkboxes in the modal
const ops = {
  convert: { enabled: false, format: 'jpeg', quality: 85, stripExif: true },
  resize:  { enabled: false, mode: 'px', w: 1920, h: 1080, lockAspect: true },
  rotate:  { enabled: false, deg: 90 },
  flip:    { enabled: false, axis: 'h' },
  rename:  { enabled: false, template: '{original}' },
};

// ── Init ─────────────────────────────────────────────────────────────────────

export function initBatch() {
  on('modal:batch', showBatchModal);
  // Row O8: the library sends { ids } for the selected photos.
  on('library:batch', async ({ ids } = {}) => {
    const { files, skipped } = await libraryFiles(ids);
    if (!files.length) { emit('toast', { message: 'None of the selected items can be batch processed.', level: 'warn' }); return; }
    if (skipped) emit('toast', { message: `${skipped} selected item${skipped === 1 ? '' : 's'} skipped (videos, or files that could not be read).`, level: 'warn' });
    openBatch(files, null, 'from the library selection');
  });
}

// Resolve library ids to batch sources ({ name, size, file, handle: null }). Videos and
// files that cannot be read are skipped and counted. Shared with gallery.js.
export async function libraryFiles(ids) {
  const lib = getLibrary();
  const files = [];
  let skipped = 0;
  for (const id of ids || []) {
    try {
      const file = await lib.getFile(id);
      if (isSupportedFile(file)) files.push({ name: file.name, size: file.size, file, handle: null });
      else skipped++;
    } catch { skipped++; }
  }
  return { files, skipped };
}

// ── Main modal ───────────────────────────────────────────────────────────────

function showBatchModal() {
  const folder = state.session.folderHandle || null;
  openBatch(
    state.session.files.map(f => ({ name: f.name, size: f.size, file: f.file, handle: f.handle })),
    folder,
    folder ? 'from current folder' : 'currently open',
  );
}

function openBatch(sources, folderHandle, label) {
  // Reset per-invocation state
  _sources = sources;
  _sourceFolderHandle = folderHandle;
  _sourceLabel = label;
  _destFolderHandle = null;
  _destMode = _sourceFolderHandle ? 'subfolder' : 'picked';

  let dlg = document.getElementById('dialog-batch');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dialog-batch';
    dlg.className = 'batch-dialog';
    document.body.appendChild(dlg);
  }
  render(dlg);
  dlg.showModal();
}

function render(dlg) {
  const canSubfolder = !!_sourceFolderHandle;

  dlg.innerHTML = `
    <div class="modal-header">
      <h2>Batch Operations</h2>
      <button class="btn-icon" data-batch="close" aria-label="Close">
        <svg class="icon" aria-hidden="true"><use href="#icon-x"/></svg>
      </button>
    </div>
    <div class="batch-body">
      <section class="batch-section">
        <h3>Source</h3>
        <div class="batch-source-line">
          <strong>${_sources.length}</strong> image${_sources.length === 1 ? '' : 's'} ${_sourceLabel}
          ${hasDirPicker ? `<button class="btn btn-sm" data-batch="pick-src">Pick different folder…</button>` : ''}
        </div>
      </section>

      <section class="batch-section">
        <h3>Operations</h3>

        <div class="batch-op">
          <label class="batch-op-toggle"><input type="checkbox" id="op-convert"${ops.convert.enabled ? ' checked' : ''}> Convert format</label>
          <div class="batch-op-config">
            <select id="conv-format">
              ${['png','jpeg','webp'].map(f => `<option value="${f}"${ops.convert.format===f?' selected':''}>${f.toUpperCase()}</option>`).join('')}
            </select>
            <label class="batch-inline">Quality <input type="number" id="conv-quality" min="10" max="100" value="${ops.convert.quality}" style="width:60px"></label>
            <label class="batch-inline"><input type="checkbox" id="conv-strip"${ops.convert.stripExif?' checked':''}> Strip EXIF</label>
          </div>
        </div>

        <div class="batch-op">
          <label class="batch-op-toggle"><input type="checkbox" id="op-resize"${ops.resize.enabled ? ' checked' : ''}> Resize</label>
          <div class="batch-op-config">
            <select id="rs-mode">
              <option value="px"${ops.resize.mode==='px'?' selected':''}>pixels</option>
              <option value="pct"${ops.resize.mode==='pct'?' selected':''}>percent</option>
            </select>
            <label class="batch-inline">W <input type="number" id="rs-w" value="${ops.resize.w}" min="1" style="width:80px"></label>
            <label class="batch-inline">H <input type="number" id="rs-h" value="${ops.resize.h}" min="1" style="width:80px"></label>
            <label class="batch-inline"><input type="checkbox" id="rs-lock"${ops.resize.lockAspect?' checked':''}> Lock aspect</label>
          </div>
        </div>

        <div class="batch-op">
          <label class="batch-op-toggle"><input type="checkbox" id="op-rotate"${ops.rotate.enabled ? ' checked' : ''}> Rotate</label>
          <div class="batch-op-config">
            <select id="rot-deg">
              <option value="90"${ops.rotate.deg===90?' selected':''}>90° CW</option>
              <option value="-90"${ops.rotate.deg===-90?' selected':''}>90° CCW</option>
              <option value="180"${ops.rotate.deg===180?' selected':''}>180°</option>
            </select>
          </div>
        </div>

        <div class="batch-op">
          <label class="batch-op-toggle"><input type="checkbox" id="op-flip"${ops.flip.enabled ? ' checked' : ''}> Flip</label>
          <div class="batch-op-config">
            <select id="flip-axis">
              <option value="h"${ops.flip.axis==='h'?' selected':''}>Horizontal</option>
              <option value="v"${ops.flip.axis==='v'?' selected':''}>Vertical</option>
            </select>
          </div>
        </div>

        <div class="batch-op">
          <label class="batch-op-toggle"><input type="checkbox" id="op-rename"${ops.rename.enabled ? ' checked' : ''}> Rename</label>
          <div class="batch-op-config">
            <input type="text" id="rn-template" value="${esc(ops.rename.template)}" placeholder="{original}-{counter:04}" style="flex:1;min-width:200px">
            <span class="batch-tokens" aria-hidden="true">
              <span>{original}</span>
              <span>{index}</span>
              <span>{counter:04}</span>
              <span>{date}</span>
              <span>{camera}</span>
              <span>{w}</span>
              <span>{h}</span>
            </span>
          </div>
        </div>
      </section>

      <section class="batch-section">
        <h3>Destination</h3>
        <label class="batch-dest-opt ${canSubfolder ? '' : 'disabled'}">
          <input type="radio" name="dest" value="subfolder"${_destMode==='subfolder'&&canSubfolder?' checked':''} ${canSubfolder?'':'disabled'}>
          New subfolder in source: <code>batch-output/</code>
        </label>
        <label class="batch-dest-opt ${hasDirPicker ? '' : 'disabled'}">
          <input type="radio" name="dest" value="picked"${_destMode==='picked'?' checked':''} ${hasDirPicker?'':'disabled'}>
          Different folder…
          <button class="btn btn-sm" id="dest-pick-btn" ${hasDirPicker?'':'disabled'} style="margin-left:8px">${_destFolderHandle ? esc(_destFolderHandle.name) : 'Choose…'}</button>
        </label>
        ${_sources.some(s => s.handle) ? `
        <label class="batch-dest-opt">
          <input type="radio" name="dest" value="overwrite"${_destMode==='overwrite'?' checked':''}>
          Overwrite in place <span class="batch-warn">(irreversible — originals replaced)</span>
        </label>` : ''}
      </section>
    </div>
    <div class="modal-footer batch-footer">
      <span class="batch-status" id="batch-status"></span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn" data-batch="close">Cancel</button>
        <button class="btn" data-batch="dry-run">Dry run</button>
        <button class="btn btn-primary" data-batch="run">Run (${_sources.length})</button>
      </div>
    </div>
  `;

  bind(dlg);
}

function bind(dlg) {
  dlg.querySelectorAll('[data-batch]').forEach(el => {
    el.addEventListener('click', () => {
      const a = el.dataset.batch;
      if (a === 'close')       dlg.close();
      else if (a === 'pick-src')  pickSourceFolder(dlg);
      else if (a === 'dry-run')   doDryRun(dlg);
      else if (a === 'run')       doRun(dlg);
    });
  });

  // Op enable/disable
  ['convert','resize','rotate','flip','rename'].forEach(k => {
    dlg.querySelector(`#op-${k}`)?.addEventListener('change', e => { ops[k].enabled = e.target.checked; });
  });

  // Convert options
  dlg.querySelector('#conv-format')?.addEventListener('change', e => { ops.convert.format = e.target.value; });
  dlg.querySelector('#conv-quality')?.addEventListener('change', e => { ops.convert.quality = clamp(+e.target.value, 10, 100); });
  dlg.querySelector('#conv-strip')?.addEventListener('change', e => { ops.convert.stripExif = e.target.checked; });

  // Resize options
  dlg.querySelector('#rs-mode')?.addEventListener('change', e => { ops.resize.mode = e.target.value; });
  dlg.querySelector('#rs-w')?.addEventListener('change', e => { ops.resize.w = +e.target.value; });
  dlg.querySelector('#rs-h')?.addEventListener('change', e => { ops.resize.h = +e.target.value; });
  dlg.querySelector('#rs-lock')?.addEventListener('change', e => { ops.resize.lockAspect = e.target.checked; });

  // Rotate / flip
  dlg.querySelector('#rot-deg')?.addEventListener('change', e => { ops.rotate.deg = +e.target.value; });
  dlg.querySelector('#flip-axis')?.addEventListener('change', e => { ops.flip.axis = e.target.value; });

  // Rename template
  dlg.querySelector('#rn-template')?.addEventListener('input', e => { ops.rename.template = e.target.value; });
  dlg.querySelectorAll('.batch-tokens span').forEach(span => {
    span.addEventListener('click', () => {
      const inp = dlg.querySelector('#rn-template');
      const pos = inp.selectionStart ?? inp.value.length;
      inp.value = inp.value.slice(0, pos) + span.textContent + inp.value.slice(pos);
      inp.focus();
      ops.rename.template = inp.value;
    });
  });

  // Destination radios
  dlg.querySelectorAll('input[name="dest"]').forEach(r => r.addEventListener('change', e => { _destMode = e.target.value; }));
  dlg.querySelector('#dest-pick-btn')?.addEventListener('click', () => pickDestFolder(dlg));
}

// ── Source / destination folder pickers ──────────────────────────────────────

async function pickSourceFolder(dlg) {
  try {
    const dir = await window.showDirectoryPicker({ mode: 'read' });
    _sources = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      const file = await handle.getFile();
      if (isSupportedFile(file)) _sources.push({ name, size: file.size, file, handle });
    }
    _sources.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    _sourceFolderHandle = dir;
    _sourceLabel = 'from current folder';
    _destMode = 'subfolder';
    render(dlg);
  } catch (err) {
    if (err.name !== 'AbortError') emit('error', { message: `Could not open folder: ${err.message}` });
  }
}

async function pickDestFolder(dlg) {
  try {
    _destFolderHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    _destMode = 'picked';
    render(dlg);
  } catch (err) {
    if (err.name !== 'AbortError') emit('error', { message: `Could not open folder: ${err.message}` });
  }
}

// ── Dry run ──────────────────────────────────────────────────────────────────

async function doDryRun(dlg) {
  if (!validateOpsEnabled(dlg)) return;
  const status = dlg.querySelector('#batch-status');
  status.textContent = 'Analysing…';

  const sample = _sources.slice(0, Math.min(20, _sources.length));
  const rows = [];
  const warnings = [];
  let missingDate = 0;
  let reformatted = 0;

  for (let i = 0; i < sample.length; i++) {
    const src = sample[i];
    const exif = await parseExif(src.file);
    if (ops.rename.enabled && ops.rename.template.includes('{date}') && !exif?.dateTimeOriginal) missingDate++;

    const outFmt = outputFormatFor(src.file, ops.convert);
    if (!ops.convert.enabled && outFmt !== formatOf(src.file)) reformatted++;

    const outName = await computeOutputName(src, i, exif, outFmt);
    rows.push({
      from: src.name,
      to: outName,
      fromSize: src.size,
      // rough estimate; not run through a full decode for speed
      estSize: estimateOutSize(src.size),
    });
  }
  if (missingDate > 0) warnings.push(`${missingDate} of ${sample.length} sampled files have no EXIF DateTimeOriginal — {date} will fall back to file mtime.`);
  if (reformatted > 0) warnings.push(`${reformatted} of ${sample.length} sampled files are in a format Slate can read but not write (HEIC, TIFF, RAW…) — they will be saved as lossless PNG. Enable Convert to choose JPEG or WebP instead.`);

  status.textContent = '';
  showDryRunResults(dlg, rows, warnings);
}

function showDryRunResults(dlg, rows, warnings) {
  const area = document.createElement('div');
  area.className = 'batch-dry-preview';
  area.innerHTML = `
    <h4>Dry run preview <span class="batch-muted">(first ${rows.length} of ${_sources.length})</span></h4>
    ${warnings.map(w => `<div class="batch-warning">⚠ ${esc(w)}</div>`).join('')}
    <table class="batch-table">
      <thead><tr><th>From</th><th>To</th><th>Size</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td class="batch-cell-trunc">${esc(r.from)}</td>
            <td class="batch-cell-trunc">${esc(r.to)}</td>
            <td>${fmtBytes(r.fromSize)} → ~${fmtBytes(r.estSize)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
  // Remove previous preview if any
  dlg.querySelector('.batch-dry-preview')?.remove();
  dlg.querySelector('.batch-body').appendChild(area);
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function doRun(dlg) {
  if (!validateOpsEnabled(dlg)) return;
  if (_destMode === 'overwrite' && !await confirmAction({
    title: 'Overwrite source files?',
    message: 'Every selected original will be replaced. This cannot be undone.',
    confirmLabel: 'Overwrite files',
  })) return;

  _cancelled = false;

  let dest;
  try {
    dest = await resolveDestination();
  } catch (err) { emit('error', { message: `Destination error: ${err.message}` }); return; }

  showProgressView(dlg);
  const progressBar = dlg.querySelector('.batch-progress-bar-fill');
  const progressText = dlg.querySelector('.batch-progress-text');
  const cancelBtn = dlg.querySelector('[data-batch="cancel-run"]');
  cancelBtn?.addEventListener('click', () => { _cancelled = true; });

  // Worker pool: hardwareConcurrency − 1, clamped 2..8
  const poolSize = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const pool = makeWorkerPool(poolSize);

  const results = { ok: 0, errors: [] };
  let done = 0;
  const snapshot = { ...ops, convert: { ...ops.convert }, resize: { ...ops.resize }, rotate: { ...ops.rotate }, flip: { ...ops.flip } };
  const queue = _sources.map((src, index) => ({ src, index }));

  const updateProgress = (src) => {
    const pct = Math.round((done / _sources.length) * 100);
    progressBar.style.width = pct + '%';
    progressText.textContent = `Processing ${done} / ${_sources.length} — ${src.name}`;
  };

  async function worker(w) {
    while (queue.length && !_cancelled) {
      const job = queue.shift();
      if (!job) break;
      updateProgress(job.src);
      try {
        // Parse EXIF + compute output name on main thread
        const exif = await parseExif(job.src.file);
        const outFmt = outputFormatFor(job.src.file, snapshot.convert);

        // Overwriting keeps the original filename, so the bytes have to match
        // the container that name claims. Refuse rather than write PNG data
        // into a .heic (or .tif, .cr2, .psd…) file.
        if (dest.mode === 'overwrite' && outFmt !== formatOf(job.src.file)) {
          throw new Error(`cannot overwrite a .${formatOf(job.src.file)} file with ${outFmt.toUpperCase()} data — write to a folder instead`);
        }

        const exifRaw = (!snapshot.convert.enabled || !snapshot.convert.stripExif) && outFmt === 'jpeg' ? exif?.raw : null;
        const outName = await computeOutputName(job.src, job.index, exif, outFmt);

        // Formats the worker cannot open are decoded here and transferred in.
        const needsMainThreadDecode = !WORKER_DECODABLE.has(formatOf(job.src.file));
        const bitmap = needsMainThreadDecode ? await decode(job.src.file) : null;

        // Send work to worker
        const blob = await dispatchWorker(w, {
          file:    bitmap ? null : job.src.file,
          bitmap,
          ops:     snapshot,
          outFmt,
          quality: snapshot.convert.enabled ? snapshot.convert.quality : 90,
          exifRaw,
        }, bitmap ? [bitmap] : []);
        await writeToDestination(dest, outName, blob, job.src);
        results.ok++;
      } catch (err) {
        results.errors.push({ name: job.src.name, message: err.message });
      } finally {
        done++;
        updateProgress(job.src);
      }
    }
  }

  await Promise.all(pool.map(w => worker(w)));
  pool.forEach(w => w.terminate());

  progressBar.style.width = '100%';
  showSummary(dlg, results);
}

// ── Worker pool ──────────────────────────────────────────────────────────────

function makeWorkerPool(size) {
  const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const workers = Array.from({ length: size }, () => {
    const w = new Worker(url);
    w._pending = new Map();
    w.addEventListener('message', (e) => {
      const { id, blob, error } = e.data;
      const pending = w._pending.get(id);
      if (!pending) return;
      w._pending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve(blob);
    });
    return w;
  });
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return workers;
}

function dispatchWorker(w, payload, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    w._pending.set(id, { resolve, reject });
    w.postMessage({ id, ...payload }, transfer);
  });
}

// Worker script — inlined as a string so the single-file build stays single-file.
// Uses createImageBitmap + OffscreenCanvas + convertToBlob, all available in workers.
const WORKER_SRC = `
function rotateCanvas(src, deg) {
  const r = (deg % 360 + 360) % 360;
  const rad = r * Math.PI / 180;
  const sin = Math.abs(Math.sin(rad)), cos = Math.abs(Math.cos(rad));
  const w = Math.round(src.width * cos + src.height * sin);
  const h = Math.round(src.width * sin + src.height * cos);
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

function flipCanvas(src, axis) {
  const out = new OffscreenCanvas(src.width, src.height);
  const ctx = out.getContext('2d');
  if (axis === 'h') { ctx.translate(src.width, 0); ctx.scale(-1, 1); }
  else              { ctx.translate(0, src.height); ctx.scale(1, -1); }
  ctx.drawImage(src, 0, 0);
  return out;
}

function resizeCanvas(src, w, h) {
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return out;
}

async function encode(canvas, outFmt, quality, exifRaw) {
  if (outFmt === 'png')  return canvas.convertToBlob({ type: 'image/png' });
  if (outFmt === 'webp') return canvas.convertToBlob({ type: 'image/webp', quality: quality / 100 });
  // JPEG — flatten onto white first, then optionally re-inject raw EXIF
  const flat = new OffscreenCanvas(canvas.width, canvas.height);
  const fctx = flat.getContext('2d');
  fctx.fillStyle = '#ffffff';
  fctx.fillRect(0, 0, flat.width, flat.height);
  fctx.drawImage(canvas, 0, 0);
  const blob = await flat.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
  if (!exifRaw) return blob;
  const jpegBuf = await blob.arrayBuffer();
  const app1 = new Uint8Array(exifRaw);
  const rest = new Uint8Array(jpegBuf, 2);
  const merged = new Uint8Array(2 + app1.byteLength + rest.byteLength);
  merged[0] = 0xFF; merged[1] = 0xD8;
  merged.set(app1, 2);
  merged.set(rest, 2 + app1.byteLength);
  return new Blob([merged], { type: 'image/jpeg' });
}

self.onmessage = async (e) => {
  const { id, file, bitmap: preDecoded, ops, outFmt, quality, exifRaw } = e.data;
  try {
    // Exotic formats (HEIC, TIFF, JXL, PSD, RAW, TGA, DDS, SVG) arrive already
    // decoded from the main thread; everything else we open here.
    const bitmap = preDecoded ?? await createImageBitmap(file);
    let canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();

    if (ops.resize.enabled) {
      let tw, th;
      if (ops.resize.mode === 'pct') {
        tw = Math.max(1, Math.round(canvas.width  * ops.resize.w / 100));
        th = Math.max(1, Math.round(canvas.height * ops.resize.h / 100));
      } else {
        tw = ops.resize.w; th = ops.resize.h;
        if (ops.resize.lockAspect) {
          const ar = canvas.width / canvas.height;
          if (tw / th > ar) tw = Math.round(th * ar);
          else th = Math.round(tw / ar);
        }
      }
      canvas = resizeCanvas(canvas, tw, th);
    }
    if (ops.rotate.enabled) canvas = rotateCanvas(canvas, ops.rotate.deg);
    if (ops.flip.enabled)   canvas = flipCanvas(canvas, ops.flip.axis);

    const blob = await encode(canvas, outFmt, quality, exifRaw);
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
`;

async function writeToDestination(dest, name, blob, src) {
  if (dest.mode === 'overwrite') {
    if (!src.handle) throw new Error('No file handle for overwrite');
    const w = await src.handle.createWritable();
    await w.write(blob); await w.close();
    return;
  }
  // Resolve a unique name within dest.folder
  let unique = name;
  let counter = 1;
  while (true) {
    try {
      await dest.folder.getFileHandle(unique);
      const dot = name.lastIndexOf('.');
      const base = dot >= 0 ? name.slice(0, dot) : name;
      const ext = dot >= 0 ? name.slice(dot) : '';
      unique = `${base}-${counter}${ext}`;
      counter++;
    } catch { break; }
  }
  const h = await dest.folder.getFileHandle(unique, { create: true });
  const w = await h.createWritable();
  await w.write(blob); await w.close();
}

async function resolveDestination() {
  if (_destMode === 'overwrite') return { mode: 'overwrite' };
  if (_destMode === 'subfolder') {
    if (!_sourceFolderHandle) throw new Error('No source folder to create subfolder in');
    const sub = await _sourceFolderHandle.getDirectoryHandle('batch-output', { create: true });
    return { mode: 'folder', folder: sub };
  }
  if (!_destFolderHandle) throw new Error('Pick a destination folder');
  return { mode: 'folder', folder: _destFolderHandle };
}

// ── Rename template ──────────────────────────────────────────────────────────

async function computeOutputName(src, index, exif, outFmt) {
  const ext = outFmt ? (outFmt === 'jpeg' ? 'jpg' : outFmt)
                     : src.name.slice((src.name.lastIndexOf('.') + 1) || src.name.length);
  const baseOriginal = src.name.replace(/\.[^.]+$/, '');

  // If rename disabled: keep original base, but use new ext if converting
  if (!ops.rename.enabled) return `${baseOriginal}.${ext}`;

  const templ = ops.rename.template || '{original}';
  const dateStr = (() => {
    const d = exif?.dateTimeOriginal;
    if (d && typeof d === 'string') {
      const m = d.match(/^(\d{4}).(\d{2}).(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    }
    // fallback: file.lastModified
    try {
      const ts = src.file?.lastModified ?? Date.now();
      const dt = new Date(ts);
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
    } catch { return ''; }
  })();
  const cam = [exif?.make, exif?.model].filter(Boolean).join(' ').trim();

  const safe = (s) => String(s ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');

  const name = templ
    .replace(/\{original\}/g, safe(baseOriginal))
    .replace(/\{index\}/g, String(index + 1))
    .replace(/\{counter:(\d+)\}/g, (_, n) => String(index + 1).padStart(+n, '0'))
    .replace(/\{date\}/g, safe(dateStr))
    .replace(/\{camera\}/g, safe(cam))
    .replace(/\{w\}/g, '')  // filled during processOne if needed — skipped for dry-run simplicity
    .replace(/\{h\}/g, '');

  return `${name || baseOriginal}.${ext}`;
}

// ── Progress view & summary ──────────────────────────────────────────────────

function showProgressView(dlg) {
  dlg.innerHTML = `
    <div class="modal-header">
      <h2>Running batch</h2>
    </div>
    <div class="batch-body">
      <div class="batch-progress">
        <div class="batch-progress-bar"><div class="batch-progress-bar-fill"></div></div>
        <div class="batch-progress-text">Starting…</div>
      </div>
    </div>
    <div class="modal-footer batch-footer" style="justify-content:flex-end">
      <button class="btn" data-batch="cancel-run">Cancel</button>
    </div>
  `;
}

function showSummary(dlg, results) {
  const errHtml = results.errors.length
    ? `<details class="batch-errors"><summary>${results.errors.length} error${results.errors.length===1?'':'s'}</summary>${results.errors.map(e => `<div class="batch-error-row"><strong>${esc(e.name)}</strong>: ${esc(e.message)}</div>`).join('')}</details>`
    : '';
  dlg.innerHTML = `
    <div class="modal-header"><h2>Done</h2></div>
    <div class="batch-body">
      <p class="batch-summary">
        <strong>${results.ok}</strong> succeeded${results.errors.length ? `, <strong>${results.errors.length}</strong> failed` : ''}.
      </p>
      ${errHtml}
    </div>
    <div class="modal-footer batch-footer" style="justify-content:flex-end">
      <button class="btn btn-primary" data-batch="close-summary">Close</button>
    </div>
  `;
  dlg.querySelector('[data-batch="close-summary"]').addEventListener('click', () => dlg.close());
  if (results.ok > 0) emit('toast', { message: `Batch complete: ${results.ok} file${results.ok===1?'':'s'} saved.`, level: 'ok' });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function validateOpsEnabled(dlg) {
  const any = Object.values(ops).some(o => o.enabled);
  if (!any && !ops.convert.enabled) {
    dlg.querySelector('#batch-status').textContent = 'Enable at least one operation first.';
    return false;
  }
  if (_sources.length === 0) {
    dlg.querySelector('#batch-status').textContent = 'No images in source.';
    return false;
  }
  return true;
}

function confirmAction({ title, message, confirmLabel = 'Continue' }) {
  let dlg = document.getElementById('dialog-confirm-action');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dialog-confirm-action';
    dlg.setAttribute('aria-labelledby', 'dialog-confirm-action-title');
    dlg.setAttribute('aria-describedby', 'dialog-confirm-action-message');
    dlg.innerHTML = `
      <form method="dialog">
        <div class="modal-header">
          <h2 id="dialog-confirm-action-title"></h2>
        </div>
        <p class="modal-info" id="dialog-confirm-action-message"></p>
        <div class="modal-footer">
          <button class="btn" value="cancel" autofocus>Cancel</button>
          <button class="btn btn-primary" id="dialog-confirm-action-ok" value="confirm"></button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
  }
  dlg.querySelector('#dialog-confirm-action-title').textContent = title;
  dlg.querySelector('#dialog-confirm-action-message').textContent = message;
  dlg.querySelector('#dialog-confirm-action-ok').textContent = confirmLabel;
  dlg.returnValue = '';
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true });
    dlg.showModal();
  });
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
function estimateOutSize(srcSize) {
  // Rough: if converting to JPEG at 85%, ~50% of source; PNG typically bigger; WebP ~30%.
  if (ops.convert.enabled) {
    if (ops.convert.format === 'jpeg') return Math.round(srcSize * 0.55);
    if (ops.convert.format === 'webp') return Math.round(srcSize * 0.35);
    return Math.round(srcSize * 1.3);
  }
  return srcSize;
}
