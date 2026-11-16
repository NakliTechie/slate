// Import from Google Takeout zips (spec row I3): read the takeout-*.zip parts one at a time,
// one entry at a time, write the photos, videos and their JSON into a folder the person picks,
// keeping the album folders, then add that folder to the library (scan.js reads the JSON).
//
//   initImport(lib, ui)        call once; the view then shows a control that calls openImportDialog()
//   openImportDialog()         the dialog: zip parts, destination folder, progress, final count
//   importTakeoutZips(opts)    the work, without DOM; tests drive it with a fake zip module
//
// zip.js loads from esm.sh at a pinned version on first use (SECURITY.md). Memory stays near
// one entry's size: each entry streams into its file, and nothing is held for the whole zip.

import { kindOf, extOf } from '../../library/schema.js';
import { esc } from '../../core/html.js';

export const ZIP_URL = 'https://esm.sh/@zip.js/zip.js@2.24.0';
export const IMPORT_LABEL = 'Import Google Takeout…';

let zipPromise = null;
function loadZip() {
  zipPromise ??= import(ZIP_URL).then((z) => { z.configure?.({ useWebWorkers: false }); return z; })
    .catch((e) => { zipPromise = null; throw new Error(`Could not load zip.js from esm.sh: ${e.message}`); });
  return zipPromise;
}

let _lib = null, _ui = null;
export function initImport(lib, ui) { _lib = lib; _ui = ui; return { openImportDialog, label: IMPORT_LABEL }; }

// "Takeout/Google Photos/Trip 2024/IMG_1.jpg" -> ['Trip 2024', 'IMG_1.jpg']. The product folder
// name is localised (Google Fotos, Google Photos), so the segment after "Takeout" is dropped
// whatever it says. Returns null for entries Slate does not import, or unsafe paths.
export function destPath(entryName) {
  let segs = String(entryName).replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
  if (segs.some(s => s === '..')) return null;
  if (segs[0]?.toLowerCase() === 'takeout') segs = segs.slice(2);
  if (!segs.length) return null;
  const name = segs[segs.length - 1];
  if (name.startsWith('.') || segs.slice(0, -1).some(s => s.startsWith('.'))) return null;
  if (!kindOf(name) && extOf(name) !== 'json') return null;
  return segs.map(s => s.replace(/[\\:*?"<>|\u0000-\u001f]/g, '_'));
}

async function sizeIfExists(dir, name) {
  try { return (await (await dir.getFileHandle(name)).getFile()).size; } catch { return -1; }
}

// zips: File[]; dest: FileSystemDirectoryHandle (readwrite); zipLib: the zip.js module.
// onProgress({ part, parts, entry, entries, name, written, skipped, failed }).
// Returns { written, skipped, failed, bytes }.
export async function importTakeoutZips({ zips, dest, zipLib, onProgress = () => {}, signal } = {}) {
  const res = { written: 0, skipped: 0, failed: 0, bytes: 0 };
  const dirs = new Map([['', dest]]);
  const dirFor = async (segs) => {
    let path = '', dir = dest;
    for (const s of segs) {
      path = path ? `${path}/${s}` : s;
      if (!dirs.has(path)) dirs.set(path, await dir.getDirectoryHandle(s, { create: true }));
      dir = dirs.get(path);
    }
    return dir;
  };

  for (let p = 0; p < zips.length; p++) {
    if (signal?.aborted) break;
    const reader = new zipLib.ZipReader(new zipLib.BlobReader(zips[p]));
    try {
      const entries = await reader.getEntries();
      for (let i = 0; i < entries.length; i++) {
        if (signal?.aborted) break;
        const e = entries[i];
        const segs = e.directory ? null : destPath(e.filename);
        onProgress({ part: p + 1, parts: zips.length, entry: i + 1, entries: entries.length, name: e.filename, ...res });
        if (!segs) continue;
        const name = segs[segs.length - 1];
        let w = null;
        try {
          const dir = await dirFor(segs.slice(0, -1));
          if (await sizeIfExists(dir, name) === e.uncompressedSize) { res.skipped++; continue; }
          w = await (await dir.getFileHandle(name, { create: true })).createWritable();
          await e.getData(w, { signal, preventClose: true });
          await w.close();
          w = null;
          res.written++;
          res.bytes += e.uncompressedSize || 0;
        } catch (err) {
          if (w) await w.abort?.().catch(() => {});
          if (signal?.aborted) break;
          console.warn('[slate library] could not import', e.filename, err);
          res.failed++;
        }
      }
    } finally {
      await reader.close?.();
    }
  }
  return res;
}

// ── dialog ──────────────────────────────────────────────────────────────────
export function openImportDialog() {
  if (typeof document === 'undefined') return;
  const canWrite = typeof window.showDirectoryPicker === 'function';
  const prev = document.activeElement;
  const dlg = document.createElement('dialog');
  dlg.className = 'imp-dialog';
  dlg.setAttribute('aria-labelledby', 'imp-title');
  dlg.innerHTML = `<div class="modal-header"><h2 id="imp-title">${esc('Import Google Takeout')}</h2></div>
    <div class="imp-body">
      <p class="imp-text">Choose the takeout zip parts and an empty folder. Slate copies the photos, videos and their Google JSON into the folder, keeping the album folders, then adds it to the library. The zips stay as they are.</p>
      ${canWrite ? '' : '<p class="imp-warn">Importing needs a browser that can write to folders, such as Chrome or Edge.</p>'}
      <label class="imp-label">Takeout zip parts
        <input type="file" class="imp-zips" accept=".zip,application/zip" multiple${canWrite ? '' : ' disabled'}></label>
      <div class="imp-row"><button type="button" class="btn imp-dest"${canWrite ? '' : ' disabled'}>Choose folder…</button>
        <span class="imp-dest-name">No folder chosen</span></div>
      <div class="imp-progress" hidden><progress class="imp-bar" max="1" value="0"></progress>
        <p class="imp-status" role="status" aria-live="polite"></p></div>
      <div class="modal-footer"><button type="button" class="btn imp-cancel">Cancel</button>
        <button type="button" class="btn btn-primary imp-go" disabled>Import</button></div>
    </div>`;
  document.body.appendChild(dlg);

  const $ = s => dlg.querySelector(s);
  const zipsEl = $('.imp-zips'), goEl = $('.imp-go'), cancelEl = $('.imp-cancel'), statusEl = $('.imp-status'), barEl = $('.imp-bar');
  let dest = null, ctl = null, running = false;
  const ready = () => { goEl.disabled = running || !dest || !zipsEl.files.length; };
  const say = (m, level = 'info') => (_ui?.toast ? _ui.toast(m, level) : console.log(m));

  zipsEl.addEventListener('change', ready);
  $('.imp-dest').addEventListener('click', async () => {
    try { dest = await window.showDirectoryPicker({ mode: 'readwrite', id: 'slate-takeout' }); }
    catch (e) { if (e?.name !== 'AbortError') say(`Could not open that folder: ${e.message}`, 'error'); return; }
    $('.imp-dest-name').textContent = dest.name;
    ready();
  });
  cancelEl.addEventListener('click', () => { if (running) ctl?.abort(); else dlg.close(); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (running) ctl?.abort(); else dlg.close(); });
  dlg.addEventListener('keydown', e => e.stopPropagation()); // keys typed here never reach the grid
  dlg.addEventListener('close', () => { dlg.remove(); prev?.focus?.(); });

  goEl.addEventListener('click', async () => {
    const zips = [...zipsEl.files].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    running = true; ready(); zipsEl.disabled = true; $('.imp-dest').disabled = true;
    cancelEl.textContent = 'Stop';
    $('.imp-progress').hidden = false;
    statusEl.textContent = 'Loading zip.js…';
    ctl = new AbortController();
    let res = null;
    try {
      const zipLib = await loadZip();
      res = await importTakeoutZips({
        zips, dest, zipLib, signal: ctl.signal,
        onProgress: (p) => {
          barEl.value = ((p.part - 1) + p.entry / Math.max(1, p.entries)) / p.parts;
          statusEl.textContent = `Part ${p.part} of ${p.parts}: ${p.written.toLocaleString('en-GB')} copied, ${p.skipped.toLocaleString('en-GB')} already there`;
        },
      });
    } catch (e) {
      statusEl.textContent = e.message;
      say(e.message, 'error');
    }
    running = false;
    cancelEl.textContent = 'Close';
    if (!res) return;
    const stopped = ctl.signal.aborted ? 'Stopped. ' : '';
    const msg = `${stopped}Copied ${res.written.toLocaleString('en-GB')} files, skipped ${res.skipped.toLocaleString('en-GB')} already there${res.failed ? `, ${res.failed.toLocaleString('en-GB')} could not be copied` : ''}.`;
    barEl.value = 1;
    statusEl.textContent = `${msg} Adding the folder to the library…`;
    try {
      if (_lib) await addOrRescan(_lib, dest);
      statusEl.textContent = msg;
      say(msg, res.failed ? 'warn' : 'ok');
    } catch (e) {
      statusEl.textContent = `${msg} Could not add the folder: ${e.message}`;
    }
  });

  dlg.showModal();
  zipsEl.focus();
}

// addRoot returns an existing root without scanning it, so a second import into the
// same folder rescans that root instead.
async function addOrRescan(lib, handle) {
  for (const r of lib.roots.values()) {
    if (r.handle && await r.handle.isSameEntry?.(handle)) return lib.rescan(r.id);
  }
  return lib.addRoot({ handle });
}
