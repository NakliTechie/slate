import { state } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { hasDirPicker } from '../core/fs.js';
import { esc } from '../core/html.js';
import { libraryFiles } from './batch.js';

const cfg = {
  mode: 'gallery',  // 'gallery' | 'sheet'
  cols: 4,
  thumbSize: 240,
  showLabels: true,
  bg: '#111113',
  embedFull: true,  // gallery: embed full images (big file) or thumb-only
  sheetFormat: 'png' // 'png' | 'jpeg'
};

// What the next run uses: the open folder, or a library selection (saved as a download).
let _files = [];
let _dir = null;
let _where = 'in this album';

export function initGallery() {
  on('modal:gallery', showGalleryModal);
  // Row O8: the library sends { ids } for the selected photos.
  on('library:gallery', async ({ ids } = {}) => {
    const { files, skipped } = await libraryFiles(ids);
    if (!files.length) { emit('toast', { message: 'None of the selected items can go on a contact sheet.', level: 'warn' }); return; }
    if (skipped) emit('toast', { message: `${skipped} selected item${skipped === 1 ? '' : 's'} skipped (videos, or files that could not be read).`, level: 'warn' });
    openGallery(files, null, 'from the library selection');
  });
}

function showGalleryModal() {
  if (!state.session.files.length) {
    emit('toast', { message: 'Open a folder first.', level: 'warn' });
    return;
  }
  openGallery(state.session.files, state.session.folderHandle, 'in this album');
}

function openGallery(files, dir, where) {
  _files = files;
  _dir = dir || null;
  _where = where;

  let dlg = document.getElementById('dialog-gallery');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dialog-gallery';
    dlg.className = 'batch-dialog';
    document.body.appendChild(dlg);
  }
  render(dlg);
  dlg.showModal();
}

function render(dlg) {
  const count = _files.length;
  dlg.innerHTML = `
    <div class="modal-header">
      <h2>Contact Sheet / Gallery</h2>
      <button class="btn-icon" data-gal="close" aria-label="Close">
        <svg class="icon" aria-hidden="true"><use href="#icon-x"/></svg>
      </button>
    </div>
    <div class="batch-body">
      <section class="batch-section">
        <h3>Mode</h3>
        <div class="export-fmt-group">
          <label class="export-fmt-option"><input type="radio" name="gal-mode" value="gallery"${cfg.mode==='gallery'?' checked':''}> Gallery page (HTML)</label>
          <label class="export-fmt-option"><input type="radio" name="gal-mode" value="sheet"${cfg.mode==='sheet'?' checked':''}> Contact sheet (image)</label>
        </div>
      </section>

      <section class="batch-section">
        <h3>Layout</h3>
        <div class="batch-op-config" style="padding-left:0">
          <label class="batch-inline">Columns <input type="number" id="gal-cols" min="1" max="20" value="${cfg.cols}" style="width:60px"></label>
          <label class="batch-inline">Thumb size <input type="number" id="gal-size" min="80" max="600" step="20" value="${cfg.thumbSize}" style="width:80px"> px</label>
          <label class="batch-inline"><input type="checkbox" id="gal-labels"${cfg.showLabels?' checked':''}> Show filenames</label>
          <label class="batch-inline">Background <input type="color" id="gal-bg" value="${cfg.bg}" style="width:36px;height:22px"></label>
        </div>
      </section>

      <section class="batch-section" id="gal-mode-gallery" style="${cfg.mode==='gallery'?'':'display:none'}">
        <h3>Gallery options</h3>
        <label class="batch-inline">
          <input type="checkbox" id="gal-embed-full"${cfg.embedFull?' checked':''}>
          Embed full-size images (self-contained, click to zoom)
        </label>
        <p class="modal-info" style="margin:6px 0 0;font-size:10px;color:var(--fg-2)">
          Off: HTML is smaller and expects images to stay in the same folder. On: HTML stands alone but file can get large.
        </p>
      </section>

      <section class="batch-section" id="gal-mode-sheet" style="${cfg.mode==='sheet'?'':'display:none'}">
        <h3>Contact sheet options</h3>
        <div class="export-fmt-group">
          <label class="export-fmt-option"><input type="radio" name="gal-sheet-fmt" value="png"${cfg.sheetFormat==='png'?' checked':''}> PNG</label>
          <label class="export-fmt-option"><input type="radio" name="gal-sheet-fmt" value="jpeg"${cfg.sheetFormat==='jpeg'?' checked':''}> JPEG</label>
        </div>
      </section>

      <p class="modal-info">${count} image${count===1?'':'s'} ${_where}.</p>
    </div>
    <div class="modal-footer batch-footer">
      <span class="batch-status" id="gal-status"></span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn" data-gal="close">Cancel</button>
        <button class="btn btn-primary" data-gal="go">Generate</button>
      </div>
    </div>
  `;
  bind(dlg);
}

function bind(dlg) {
  dlg.querySelectorAll('[data-gal]').forEach(el => {
    el.addEventListener('click', () => {
      const a = el.dataset.gal;
      if (a === 'close') dlg.close();
      else if (a === 'go') run(dlg);
    });
  });
  dlg.querySelectorAll('input[name="gal-mode"]').forEach(r => r.addEventListener('change', e => {
    cfg.mode = e.target.value;
    dlg.querySelector('#gal-mode-gallery').style.display = cfg.mode === 'gallery' ? '' : 'none';
    dlg.querySelector('#gal-mode-sheet').style.display = cfg.mode === 'sheet' ? '' : 'none';
  }));
  dlg.querySelector('#gal-cols').addEventListener('change', e => { cfg.cols = Math.max(1, +e.target.value); });
  dlg.querySelector('#gal-size').addEventListener('change', e => { cfg.thumbSize = Math.max(80, +e.target.value); });
  dlg.querySelector('#gal-labels').addEventListener('change', e => { cfg.showLabels = e.target.checked; });
  dlg.querySelector('#gal-bg').addEventListener('change', e => { cfg.bg = e.target.value; });
  dlg.querySelector('#gal-embed-full').addEventListener('change', e => { cfg.embedFull = e.target.checked; });
  dlg.querySelectorAll('input[name="gal-sheet-fmt"]').forEach(r => r.addEventListener('change', e => { cfg.sheetFormat = e.target.value; }));
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function run(dlg) {
  const status = dlg.querySelector('#gal-status');
  const files = _files;

  try {
    if (cfg.mode === 'gallery') {
      status.textContent = 'Rendering thumbnails…';
      const html = await buildGalleryHtml(files, (i, total) => {
        status.textContent = `Rendering ${i} / ${total}…`;
      });
      await saveArtifact(new Blob([html], { type: 'text/html' }), 'gallery.html');
    } else {
      status.textContent = 'Composing contact sheet…';
      const blob = await buildContactSheet(files, (i, total) => {
        status.textContent = `Placing ${i} / ${total}…`;
      });
      const ts = tstamp();
      const ext = cfg.sheetFormat === 'jpeg' ? 'jpg' : 'png';
      await saveArtifact(blob, `contact-sheet-${ts}.${ext}`);
    }
    dlg.close();
    emit('toast', { message: 'Done.', level: 'ok' });
  } catch (err) {
    status.textContent = '';
    emit('error', { message: `Gallery failed: ${err.message}` });
  }
}

async function saveArtifact(blob, name) {
  const dir = _dir;
  if (dir) {
    try {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch (err) {
      // Fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Gallery HTML build ───────────────────────────────────────────────────────

async function buildGalleryHtml(files, onProgress) {
  const items = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i].file ?? (files[i].handle ? await files[i].handle.getFile() : null);
    if (!file) continue;

    const bitmap = await createImageBitmap(file);
    const thumbDataUrl = await thumbToDataUrl(bitmap, cfg.thumbSize, 'image/webp', 0.82);
    let fullDataUrl = '';
    if (cfg.embedFull) {
      fullDataUrl = await blobToDataUrl(file);
    } else {
      fullDataUrl = esc(files[i].name);
    }
    bitmap.close?.();
    items.push({
      name: files[i].name,
      thumb: thumbDataUrl,
      full: fullDataUrl,
      w: bitmap.width, h: bitmap.height
    });
    onProgress(i + 1, files.length);
  }

  return htmlTemplate(items);
}

function htmlTemplate(items) {
  const cssBg = cfg.bg;
  const cssFg = pickReadable(cssBg);
  const cols = cfg.cols;
  const thumbPx = cfg.thumbSize;

  const tiles = items.map((it, i) => `
    <figure class="tile" data-i="${i}">
      <img src="${it.thumb}" alt="${esc(it.name)}" loading="lazy">
      ${cfg.showLabels ? `<figcaption>${esc(it.name)}</figcaption>` : ''}
    </figure>
  `).join('');

  const manifest = items.map(it => ({ name: it.name, full: it.full })).map(m => `{name:${JSON.stringify(m.name)},full:${JSON.stringify(m.full)}}`).join(',');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gallery</title>
<style>
  :root { --bg:${cssBg}; --fg:${cssFg}; --fg-soft:${pickSoft(cssBg)}; }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:-apple-system,system-ui,sans-serif}
  header{padding:24px 24px 16px;border-bottom:1px solid var(--fg-soft)}
  h1{margin:0;font-size:16px;font-weight:600;letter-spacing:.02em}
  .sub{margin:4px 0 0;font-size:12px;color:var(--fg-soft)}
  .grid{padding:16px;display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px}
  .tile{margin:0;cursor:zoom-in;overflow:hidden;border-radius:6px;background:var(--fg-soft)}
  .tile img{display:block;width:100%;height:${thumbPx}px;object-fit:cover}
  figcaption{font-size:10px;padding:6px 8px;color:var(--fg);background:var(--fg-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;cursor:zoom-out;z-index:10}
  .lightbox.open{display:flex}
  .lightbox img{max-width:96vw;max-height:92vh;object-fit:contain}
  .lightbox-info{position:absolute;top:16px;left:16px;color:#fff;font-size:12px;background:rgba(0,0,0,.5);padding:6px 10px;border-radius:4px}
  .lightbox-nav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.5);color:#fff;border:none;width:44px;height:44px;font-size:20px;cursor:pointer;border-radius:22px}
  .lightbox-nav.prev{left:16px}
  .lightbox-nav.next{right:16px}
  footer{padding:16px 24px;border-top:1px solid var(--fg-soft);font-size:11px;color:var(--fg-soft);text-align:center}
</style>
</head>
<body>
<header>
  <h1>Gallery</h1>
  <p class="sub">${items.length} image${items.length===1?'':'s'}</p>
</header>
<div class="grid">${tiles}</div>
<div class="lightbox" id="lb">
  <button class="lightbox-nav prev" id="lb-prev" aria-label="Previous">‹</button>
  <img id="lb-img">
  <button class="lightbox-nav next" id="lb-next" aria-label="Next">›</button>
  <div class="lightbox-info" id="lb-info"></div>
</div>
<footer>Generated with Slate — <a href="https://slate.naklitechie.com" style="color:var(--fg-soft)">slate.naklitechie.com</a></footer>
<script>
  const items = [${manifest}];
  const lb = document.getElementById('lb');
  const img = document.getElementById('lb-img');
  const info = document.getElementById('lb-info');
  let cur = 0;
  function open(i){ cur=(i+items.length)%items.length; img.src=items[cur].full; info.textContent=items[cur].name + ' (' + (cur+1) + '/' + items.length + ')'; lb.classList.add('open'); }
  function close(){ lb.classList.remove('open'); img.src=''; }
  document.querySelectorAll('.tile').forEach(t => t.addEventListener('click', () => open(+t.dataset.i)));
  lb.addEventListener('click', e => { if(e.target===lb||e.target===img) close(); });
  document.getElementById('lb-prev').addEventListener('click', e => { e.stopPropagation(); open(cur-1); });
  document.getElementById('lb-next').addEventListener('click', e => { e.stopPropagation(); open(cur+1); });
  document.addEventListener('keydown', e => {
    if(!lb.classList.contains('open')) return;
    if(e.key==='Escape') close();
    else if(e.key==='ArrowLeft') open(cur-1);
    else if(e.key==='ArrowRight') open(cur+1);
  });
<\/script>
</body>
</html>`;
}

// ── Contact sheet build ──────────────────────────────────────────────────────

async function buildContactSheet(files, onProgress) {
  const cols = cfg.cols;
  const rows = Math.ceil(files.length / cols);
  const thumbW = cfg.thumbSize;
  const thumbH = Math.round(thumbW * 0.75); // 4:3 cell
  const labelH = cfg.showLabels ? 20 : 0;
  const pad = 8;
  const cellW = thumbW + pad;
  const cellH = thumbH + labelH + pad;
  const outW = cols * cellW + pad;
  const outH = rows * cellH + pad;

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = cfg.bg;
  ctx.fillRect(0, 0, outW, outH);

  ctx.font = '10px -apple-system, sans-serif';
  ctx.textBaseline = 'top';

  for (let i = 0; i < files.length; i++) {
    const file = files[i].file ?? (files[i].handle ? await files[i].handle.getFile() : null);
    if (!file) continue;

    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = pad + col * cellW;
    const y = pad + row * cellH;

    try {
      const bitmap = await createImageBitmap(file);
      // Cover-fit the thumb into thumbW × thumbH
      const sRatio = bitmap.width / bitmap.height;
      const tRatio = thumbW / thumbH;
      let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
      if (sRatio > tRatio) {
        // wider source: crop horizontally
        sw = bitmap.height * tRatio;
        sx = (bitmap.width - sw) / 2;
      } else {
        sh = bitmap.width / tRatio;
        sy = (bitmap.height - sh) / 2;
      }
      ctx.drawImage(bitmap, sx, sy, sw, sh, x, y, thumbW, thumbH);
      bitmap.close?.();
    } catch {
      ctx.fillStyle = '#444';
      ctx.fillRect(x, y, thumbW, thumbH);
    }

    if (cfg.showLabels) {
      ctx.fillStyle = pickReadable(cfg.bg);
      const label = files[i].name.length > 32 ? files[i].name.slice(0, 30) + '…' : files[i].name;
      ctx.fillText(label, x + 4, y + thumbH + 4);
    }
    onProgress(i + 1, files.length);
  }

  return canvas.convertToBlob({
    type: cfg.sheetFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
    quality: 0.9
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function thumbToDataUrl(bitmap, maxSize, type, quality) {
  const scale = Math.min(maxSize / bitmap.width, maxSize / bitmap.height, 1);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await c.convertToBlob({ type, quality });
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

function pickReadable(bg) {
  // Pick black or white text depending on bg luminance
  const { r, g, b } = hexToRgb(bg);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? '#111' : '#fafafa';
}
function pickSoft(bg) {
  const { r, g, b } = hexToRgb(bg);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.12)';
}
function hexToRgb(hex) {
  const s = hex.replace('#', '');
  const h = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function tstamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return String(d.getFullYear()).slice(-2) + p(d.getMonth()+1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
