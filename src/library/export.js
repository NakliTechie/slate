// Export (spec row I4): copy the original files of a selection or an album into
// a folder the person picks. Originals only, byte for byte; nothing is re-encoded.
// A name that is already taken in the destination gets " (2)", " (3)" and so on.
// A Live Photo's paired MOV (record field `liveVideo`) is exported with its still and
// named after the still's export name (IMG_1 (2).HEIC goes with IMG_1 (2).MOV).
// Progress runs on lib.jobs as kind 'export', so the status line counts it.
//
// exportFiles(lib, ids, destDir) -> Promise<{ copied, failed, total }>
//   destDir is a FileSystemDirectoryHandle with write permission.
// albumExportIds(lib, albumId) -> ids of the album's photos that are not trashed or missing
// pickExportFolder() -> FileSystemDirectoryHandle, or null when cancelled
//   Call it straight from a click: the browser needs the user gesture.
//
// The .zip path (the other half of I4) writes the same originals into one zip file:
// exportZip(lib, ids, { zipLib, writer }) -> Promise<{ copied, failed, total, cancelled, result }>
//   zipLib is the zip.js module (@zip.js/zip.js, loaded by the caller); writer is a
//   WritableStream (from pickZipSave, so a multi-gigabyte export never sits in memory)
//   or a zip.js Writer such as BlobWriter (the download fallback). result is what
//   ZipWriter.close() returns: the Blob for a BlobWriter.
// zipLevelFor(name) -> 0 for formats that are already compressed, undefined for zip.js's default
// zipFileName(label, date) -> "<label> YYYY-MM-DD.zip", with characters files cannot hold removed
// pickZipSave(suggestedName) -> WritableStream, or null when cancelled; undefined when the
//   browser has no showSaveFilePicker. Call it straight from a click.

import { makeId } from './schema.js';

export function uniqueName(name, taken) {
  const lower = (s) => s.toLowerCase();
  if (!taken.has(lower(name))) { taken.add(lower(name)); return name; }
  const i = name.lastIndexOf('.');
  const stem = i > 0 ? name.slice(0, i) : name, ext = i > 0 ? name.slice(i) : '';
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!taken.has(lower(next))) { taken.add(lower(next)); return next; }
  }
}

// [{ id, name, fileId }] for the ids, in order: each still, then its paired MOV.
// fileId is the id lib.getFile reads (the MOV has no record of its own).
function exportItems(lib, ids, taken) {
  const out = [];
  for (const id of new Set(ids)) {
    const rec = lib.get(id);
    if (!rec) continue;
    const name = uniqueName(rec.name, taken);
    out.push({ id, name, fileId: id });
    if (rec.liveVideo) {
      const mov = rec.liveVideo.slice(rec.liveVideo.lastIndexOf('/') + 1);
      const i = name.lastIndexOf('.'), j = mov.lastIndexOf('.');
      const want = (i > 0 ? name.slice(0, i) : name) + (j > 0 ? mov.slice(j) : '');
      out.push({ id, name: uniqueName(want, taken), fileId: makeId(rec.rootId, rec.liveVideo) });
    }
  }
  return out;
}

export async function pickExportFolder() {
  if (typeof window === 'undefined' || !window.showDirectoryPicker) {
    throw new Error('This browser cannot pick a folder to export to. Use Chrome or Edge.');
  }
  try { return await window.showDirectoryPicker({ id: 'slate-export', mode: 'readwrite' }); }
  catch (e) { if (e?.name === 'AbortError') return null; throw e; }
}

export function albumExportIds(lib, albumId) {
  const al = lib.albums.get(albumId);
  if (!al) throw new Error(`no album ${albumId}`);
  return [...al.items].filter(id => { const r = lib.get(id); return r && !r.missing && !lib.choice(id).trashed; });
}

async function copyInto(file, dir, name) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    if (typeof file.stream === 'function') { await file.stream().pipeTo(w); return; } // pipeTo closes w
    await w.write(file);
    await w.close();
  } catch (e) {
    try { await w.abort?.(); } catch { /* already closed */ }
    throw e;
  }
}

export async function exportFiles(lib, ids, destDir) {
  if (!ids.some(id => lib.get(id))) return { copied: 0, failed: 0, total: 0 };
  // Names are reserved up front, so parallel copies never race for one name.
  const taken = new Set();
  for await (const [n] of destDir.entries()) taken.add(n.toLowerCase());
  const items = exportItems(lib, ids, taken);

  let copied = 0, failed = 0;
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve({ copied, failed, total: items.length }); } };
    const tick = () => { if (copied + failed === items.length) finish(); };
    lib.jobs.add('export', items, async (item, signal) => {
      try {
        if (signal?.aborted) throw new Error('cancelled');
        await copyInto(await lib.getFile(item.fileId), destDir, item.name);
        copied++;
      } catch (e) { failed++; throw e; }
      finally { tick(); }
    });
    // Cancelling drops pending items without running them; report what was copied.
    lib.jobs.controllers?.get('export')?.signal.addEventListener('abort', () => setTimeout(finish, 0));
  });
}

// ── one .zip file ───────────────────────────────────────────────────────────
const STORED = new Set(['jpg', 'jpeg', 'jpe', 'heic', 'heif', 'png', 'mp4', 'm4v', 'mov', 'webp', 'avif', 'gif']);
export const BLOB_WARN_BYTES = 2 * 1024 ** 3;   // the download fallback holds the zip in memory
const ZIP64_BYTES = 0xFFFFFFFF - 64 * 1024 ** 2; // past 4 GB (or 65,535 entries) the zip needs Zip64

export function zipLevelFor(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && STORED.has(name.slice(i + 1).toLowerCase()) ? 0 : undefined;
}

export function zipFileName(label, date = new Date()) {
  const clean = String(label ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Slate export';
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${clean} ${d}.zip`;
}

// Unique entry names for the zip, in the order of ids, as the folder export names them,
// each paired Live Photo MOV straight after its still.
export function zipEntries(lib, ids) {
  return exportItems(lib, ids, new Set());
}

export async function pickZipSave(suggestedName) {
  if (typeof window === 'undefined' || !window.showSaveFilePicker) return undefined;
  try {
    const fh = await window.showSaveFilePicker({ id: 'slate-export', suggestedName, types: [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }] });
    return await fh.createWritable();
  } catch (e) { if (e?.name === 'AbortError') return null; throw e; }
}

export async function exportZip(lib, ids, { zipLib, writer } = {}) {
  const items = zipEntries(lib, ids);
  const bytes = items.reduce((n, it) => n + (it.fileId === it.id ? lib.get(it.id).size || 0 : 0), 0);
  const zip = new zipLib.ZipWriter(writer, { zip64: bytes > ZIP64_BYTES || items.length > 0xFFFF });
  let copied = 0, failed = 0, fatal = null, cancelled = false;
  // zip.js writes one entry at a time to a stream; the chain keeps the adds in order,
  // so each original streams straight through and only one is open at once.
  let chain = Promise.resolve();
  if (items.length) {
    await new Promise((resolve) => {
      let finished = false;
      const finish = () => { if (!finished) { finished = true; chain.then(resolve); } };
      lib.jobs.add('export', items, (item, signal) => {
        const step = chain.then(async () => {
          if (signal?.aborted || fatal) throw new Error('cancelled');
          let file;
          try { file = await lib.getFile(item.fileId); } catch (e) { failed++; throw e; }
          try {
            const level = zipLevelFor(item.name);
            const opts = {};
            if (level === 0) opts.level = 0;
            if (file.lastModified) opts.lastModDate = new Date(file.lastModified);
            await zip.add(item.name, typeof file.stream === 'function' ? file.stream() : new zipLib.BlobReader(file), opts);
            copied++;
          } catch (e) {
            // A half-written entry leaves the zip unusable, so the export stops here.
            failed++; fatal = e; lib.jobs.cancel('export'); throw e;
          }
        });
        chain = step.catch(() => {});
        return step.finally(() => { if (copied + failed === items.length) finish(); });
      });
      // Cancelling drops pending items; the entry being written finishes, then the zip closes.
      lib.jobs.controllers?.get('export')?.signal.addEventListener('abort', () => { cancelled = !fatal; setTimeout(finish, 0); });
    });
  }
  if (fatal) {
    await writer?.abort?.().catch?.(() => {});
    throw new Error(`The zip export stopped: ${fatal.message ?? fatal}`);
  }
  const result = await zip.close();
  return { copied, failed, total: items.length, cancelled, result };
}
