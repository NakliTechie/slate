import { state } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { rotateJpegLossless } from '../ops/jpeg-lossless.js';
import { esc } from '../core/html.js';

export function initJpegRotate() {
  on('modal:jpeg-rotate', showModal);
}

async function showModal() {
  const entry = state.session.files[state.session.currentIndex];
  const currentFile = entry?.file;
  const isJpeg = currentFile && (currentFile.type === 'image/jpeg' || /\.jpe?g$/i.test(entry.name ?? ''));

  let dlg = document.getElementById('modal-jpeg-rotate');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'modal-jpeg-rotate';
    document.body.appendChild(dlg);
  }

  dlg.innerHTML = `
    <div class="modal-header"><h2>Lossless JPEG rotate</h2></div>
    <div class="modal-fields">
      <p class="modal-info" style="margin:0 0 12px">
        Rotates the current JPEG without re-encoding — the pixel bytes stay untouched
        and only the EXIF orientation tag is flipped. Zero quality loss. Any viewer
        that honours EXIF orientation will display the rotated image correctly.
      </p>
      ${isJpeg ? '' : `<div class="banner banner-warn" style="border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-warn"/></svg>
        Current file is not a JPEG — this operation only works on JPEGs.
      </div>`}
      ${isJpeg ? `<div class="modal-field-row">
        <label>Rotation</label>
        <div class="export-fmt-group">
          <label class="export-fmt-option"><input type="radio" name="jr-angle" value="1" checked> 90° CW</label>
          <label class="export-fmt-option"><input type="radio" name="jr-angle" value="2"> 180°</label>
          <label class="export-fmt-option"><input type="radio" name="jr-angle" value="3"> 90° CCW</label>
        </div>
      </div>
      <p class="modal-info" style="margin:6px 0 0;font-size:11px">File: <em>${esc(entry.name)}</em></p>` : ''}
    </div>
    <div class="modal-footer">
      <button class="btn" data-cancel>Cancel</button>
      ${isJpeg ? `<button class="btn btn-primary" data-apply>
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-check"/></svg>
        Save rotated
      </button>` : ''}
    </div>
  `;

  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-apply]')?.addEventListener('click', async () => {
    const turns = +dlg.querySelector('input[name="jr-angle"]:checked').value;
    dlg.close();
    await runRotate(entry, currentFile, turns);
  });

  dlg.showModal();
}

async function runRotate(entry, file, turns) {
  try {
    const rotated = await rotateJpegLossless(file, turns);
    const saved = await saveRotated(entry, rotated);
    emit('toast', { message: `Saved as ${saved}`, level: 'ok' });
  } catch (err) {
    emit('error', { message: `Lossless rotate failed: ${err.message}` });
  }
}

async function saveRotated(entry, blob) {
  const suffix = tstamp();
  const base = entry.name.replace(/\.[^.]+$/, '');
  const name = `${base}-${suffix}.jpg`;

  const dir = state.session.folderHandle;
  if (dir) {
    try {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return name;
    } catch { /* fall through to download */ }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

function tstamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return String(d.getFullYear()).slice(-2) + p(d.getMonth()+1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
