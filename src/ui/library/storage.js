// Storage panel: how big the index and thumbnails are, the browser's quota,
// a request to keep the data (navigator.storage.persist), library file
// downloads for browse-only folders, the "Write XMP sidecars" setting, and
// Rebuild index with a confirmation.

import { emit } from '../../core/events.js';
import { esc } from '../../core/html.js';
import { downloadLibFile } from '../../library/persist.js';
import { formatBytes } from './photo-viewer.js';
import { XMP_SETTING_KEY } from '../../library/xmpwrite.js';

// A root whose library file stays in the browser: browse-only, or not writable.
export function needsDownload(lib, root) {
  if (root.mode === 'files' || !root.handle) return true;
  const can = lib.services.persist?.canWrite?.(root);
  return can === false;
}

export function openStoragePanel(lib, dlg) {
  const browseOnly = [...lib.roots.values()].filter(r => needsDownload(lib, r));
  dlg.setAttribute('aria-labelledby', 'lib-storage-title');
  dlg.innerHTML = `
    <div class="modal-header"><h2 id="lib-storage-title">Storage</h2></div>
    <dl class="lib-storage-list">
      <dt>Index</dt><dd>${lib.records.size.toLocaleString('en-GB')} rows</dd>
      <dt>Thumbnails</dt><dd data-s="thumbs">Measuring</dd>
      <dt>Browser storage</dt><dd data-s="quota">Measuring</dd>
      <dt>Kept by the browser</dt><dd data-s="persisted">Checking</dd>
    </dl>
    <p class="lib-note">The index and thumbnails can be rebuilt from your folders at any time. Your choices and albums are kept in each folder's library file.</p>
    <p class="lib-note">${lib.services.watch?.status?.() === 'watching' ? 'Slate watches your folders and picks up new, changed and removed files on its own.' : 'This browser cannot watch folders, so Slate looks for new and changed files each time the Library opens.'}</p>
    <label class="lib-storage-xmp"><input type="checkbox" data-s-xmp> Write XMP sidecars for ratings, labels and tags</label>
    <p class="lib-note">Slate writes a photo.jpg.xmp file beside each photo you rate, reject or tag, so Lightroom, digiKam and darktable see the same choices. Your photos are never changed.</p>
    ${browseOnly.length ? `<div class="lib-storage-files"><p class="lib-note">Slate cannot write the library file into these folders, so their choices are kept in this browser. Download the library file and put it in the folder to keep a copy.</p>
      ${browseOnly.map(r => `<button class="btn" data-s-download="${esc(r.id)}">Download library file for ${esc(r.name)}</button>`).join('')}</div>` : ''}
    <div class="lib-storage-confirm" hidden>
      <p>Rebuild deletes the index and every thumbnail, then scans all ${lib.roots.size} folder${lib.roots.size === 1 ? '' : 's'} again. Your choices and albums stay.</p>
      <div class="modal-footer">
        <button class="btn" data-s="cancel-rebuild">Cancel</button>
        <button class="btn btn-danger" data-s="confirm-rebuild">Rebuild now</button>
      </div>
    </div>
    <div class="modal-footer" data-s="footer">
      <button class="btn" data-s="persist">Keep data</button>
      <button class="btn" data-s="rebuild">Rebuild index</button>
      <button class="btn btn-primary" data-s="close">Close</button>
    </div>`;

  const set = (k, v) => { const el = dlg.querySelector(`[data-s="${k}"]`); if (el) el.textContent = v; };
  Promise.resolve(lib.services.thumbs?.sizeBytes?.() ?? 0).then(n => set('thumbs', formatBytes(n))).catch(() => set('thumbs', 'Unknown'));
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(e => set('quota', `${formatBytes(e.usage ?? 0)} used of ${formatBytes(e.quota ?? 0)}`)).catch(() => set('quota', 'Unknown'));
  } else set('quota', 'Not reported by this browser');
  if (navigator.storage?.persisted) navigator.storage.persisted().then(p => set('persisted', p ? 'Yes' : 'No')).catch(() => set('persisted', 'Unknown'));
  else set('persisted', 'Not supported');

  const xmpBox = dlg.querySelector('[data-s-xmp]');
  const xmp = lib.services.xmpWrite;
  Promise.resolve(xmp ? xmp.ready?.then(() => xmp.enabled()) : lib.store?.getKv?.(XMP_SETTING_KEY))
    .then(v => { xmpBox.checked = v === true; }).catch(() => {});
  xmpBox.onchange = async () => {
    const v = xmpBox.checked;
    try {
      if (xmp) await xmp.setEnabled(v); else await lib.store?.setKv?.(XMP_SETTING_KEY, v);
      emit('toast', { message: v ? 'Slate will write XMP sidecars for the photos you change.' : 'Slate will stop writing XMP sidecars.', level: 'ok' });
    } catch (e) { emit('error', { message: `Could not save the setting: ${e.message}` }); }
  };

  const confirmBox = dlg.querySelector('.lib-storage-confirm');
  const footer = dlg.querySelector('[data-s="footer"]');

  dlg.onclick = async (e) => {
    const dl = e.target.closest('[data-s-download]');
    if (dl) {
      if (lib.roots.has(dl.dataset.sDownload)) downloadLibFile(lib, dl.dataset.sDownload);
      return;
    }
    const a = e.target.closest('[data-s]')?.dataset.s;
    if (a === 'close') dlg.close();
    else if (a === 'persist') {
      if (!navigator.storage?.persist) { emit('toast', { message: 'This browser cannot be asked to keep data.', level: 'warn' }); return; }
      const ok = await navigator.storage.persist().catch(() => false);
      set('persisted', ok ? 'Yes' : 'No');
      emit('toast', ok ? { message: 'The browser will keep the library data.', level: 'ok' } : { message: 'The browser did not agree to keep the data. It may clear it when space runs low; a rescan rebuilds it.', level: 'warn', duration: 6000 });
    } else if (a === 'rebuild') { confirmBox.hidden = false; footer.hidden = true; dlg.querySelector('[data-s="cancel-rebuild"]').focus(); }
    else if (a === 'cancel-rebuild') { confirmBox.hidden = true; footer.hidden = false; }
    else if (a === 'confirm-rebuild') {
      dlg.close();
      emit('toast', { message: 'Rebuilding the index.', level: 'info' });
      lib.rebuild().then(() => emit('toast', { message: 'Index rebuilt.', level: 'ok' }))
        .catch(err => emit('error', { message: `Rebuild failed: ${err.message}` }));
    }
  };
  if (!dlg.open) dlg.showModal();
}
