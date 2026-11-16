// Export (spec row I4): copy the original files of a selection or an album into
// a folder the person picks. Originals only, byte for byte; nothing is re-encoded.
// A name that is already taken in the destination gets " (2)", " (3)" and so on.
// Progress runs on lib.jobs as kind 'export', so the status line counts it.
//
// exportFiles(lib, ids, destDir) -> Promise<{ copied, failed, total }>
//   destDir is a FileSystemDirectoryHandle with write permission.
// albumExportIds(lib, albumId) -> ids of the album's photos that are not trashed or missing
// pickExportFolder() -> FileSystemDirectoryHandle, or null when cancelled
//   Call it straight from a click: the browser needs the user gesture.

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
  const list = [...new Set(ids)].filter(id => lib.get(id));
  if (!list.length) return { copied: 0, failed: 0, total: 0 };
  // Names are reserved up front, so parallel copies never race for one name.
  const taken = new Set();
  for await (const [n] of destDir.entries()) taken.add(n.toLowerCase());
  const items = list.map(id => ({ id, name: uniqueName(lib.get(id).name, taken) }));

  let copied = 0, failed = 0;
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve({ copied, failed, total: items.length }); } };
    const tick = () => { if (copied + failed === items.length) finish(); };
    lib.jobs.add('export', items, async (item, signal) => {
      try {
        if (signal?.aborted) throw new Error('cancelled');
        await copyInto(await lib.getFile(item.id), destDir, item.name);
        copied++;
      } catch (e) { failed++; throw e; }
      finally { tick(); }
    });
    // Cancelling drops pending items without running them; report what was copied.
    lib.jobs.controllers?.get('export')?.signal.addEventListener('abort', () => setTimeout(finish, 0));
  });
}
