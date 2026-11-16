// The library's full-size viewer: one photo or video at a time, arrow keys,
// an info panel, and a button that hands the photo to the editor.
// Photos decode through Slate's decoder registry; videos play in <video>.

import { decode } from '../../decode/registry.js';
import { esc } from '../../core/html.js';
import { dayKey, dayLabel } from '../../library/schema.js';

const INFO_KEY = 'slate.v1.library.info';

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(s) {
  const t = Math.max(0, Math.round(s || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// Capture time is stored as UTC wall clock (see schema.js), so read it with UTC getters.
export function formatTaken(time) {
  const d = new Date(time);
  return `${dayLabel(dayKey(time))}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * @param {object} lib
 * @param {HTMLElement} el  the viewer container (starts hidden)
 * @param {{ getList: () => object[], onShow: (index:number) => void, onClose: () => void, onEdit: (id:string) => void }} hooks
 */
export function createPhotoViewer(lib, el, { getList, onShow, onClose, onEdit }) {
  el.innerHTML = `
    <div class="lv-bar">
      <button class="btn-icon" data-v="close" aria-label="Back to the grid (Escape)"><svg class="icon" aria-hidden="true"><use href="#icon-x"/></svg></button>
      <span class="lv-name"></span>
      <span class="lv-pos"></span>
      <span class="lv-spacer"></span>
      <button class="btn-icon" data-v="prev" aria-label="Previous photo (Left arrow)"><span aria-hidden="true">&#8249;</span></button>
      <button class="btn-icon" data-v="next" aria-label="Next photo (Right arrow)"><span aria-hidden="true">&#8250;</span></button>
      <button class="btn-icon" data-v="info" aria-label="Photo information (I)" aria-pressed="true"><svg class="icon" aria-hidden="true"><use href="#icon-info"/></svg></button>
      <button class="btn btn-primary" data-v="edit" aria-label="Open in the editor (E)">Edit</button>
    </div>
    <div class="lv-body">
      <div class="lv-stage" aria-live="polite"></div>
      <aside class="lv-info" aria-label="Photo information"></aside>
    </div>`;
  const stage = el.querySelector('.lv-stage');
  const info = el.querySelector('.lv-info');
  const nameEl = el.querySelector('.lv-name');
  const posEl = el.querySelector('.lv-pos');
  const infoBtn = el.querySelector('[data-v="info"]');
  const editBtn = el.querySelector('[data-v="edit"]');

  let index = -1, id = null, token = 0, videoUrl = null;
  let showInfo = true;
  try { showInfo = localStorage.getItem(INFO_KEY) !== '0'; } catch { /* storage blocked */ }
  applyInfo();

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    const a = b.dataset.v;
    if (a === 'close') close();
    else if (a === 'prev') move(-1);
    else if (a === 'next') move(1);
    else if (a === 'info') toggleInfo();
    else if (a === 'edit' && id) onEdit(id);
  });

  function applyInfo() {
    info.hidden = !showInfo;
    infoBtn.setAttribute('aria-pressed', String(showInfo));
  }
  function toggleInfo() {
    showInfo = !showInfo;
    try { localStorage.setItem(INFO_KEY, showInfo ? '1' : '0'); } catch { /* storage blocked */ }
    applyInfo();
  }

  function clearStage() {
    for (const v of stage.querySelectorAll('video')) { v.pause(); v.removeAttribute('src'); v.load(); }
    if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; }
    stage.replaceChildren();
  }
  function message(text) {
    const p = document.createElement('p');
    p.className = 'lv-msg';
    p.textContent = text;
    stage.replaceChildren(p);
  }

  function open(i) {
    el.hidden = false;
    show(i);
    el.querySelector('[data-v="close"]').focus();
  }

  function close() {
    if (el.hidden) return;
    token++;
    clearStage();
    el.hidden = true;
    index = -1; id = null;
    onClose();
  }

  function move(delta) {
    const list = getList();
    if (!list.length) return;
    const next = Math.max(0, Math.min(list.length - 1, index + delta));
    if (next !== index) show(next);
  }

  async function show(i) {
    const list = getList();
    if (!list.length) { close(); return; }
    index = Math.max(0, Math.min(list.length - 1, i));
    const rec = list[index];
    id = rec.id;
    onShow(index);
    const t = ++token;
    nameEl.textContent = rec.name;
    renderPos(list);
    renderInfo(rec);
    editBtn.disabled = rec.kind === 'video';
    clearStage();
    message('Loading');
    lib.services.thumbs?.url?.(rec.id).then(u => {
      if (t !== token || !u || !stage.querySelector('.lv-msg')) return;
      const img = document.createElement('img');
      img.className = 'lv-preview';
      img.alt = '';
      img.src = u;
      stage.replaceChildren(img);
    }).catch(() => {});
    try {
      const file = await lib.getFile(rec.id);
      if (t !== token) return;
      if (rec.kind === 'video') {
        videoUrl = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.controls = true;
        v.playsInline = true;
        v.preload = 'metadata';
        v.setAttribute('aria-label', `Video ${rec.name}`);
        v.addEventListener('error', () => { if (t === token) message('This browser cannot play this video format.'); });
        v.src = videoUrl;
        stage.replaceChildren(v);
        return;
      }
      const bmp = await decode(file);
      if (t !== token) { bmp.close?.(); return; }
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close?.();
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', rec.name);
      stage.replaceChildren(c);
    } catch (err) {
      if (t === token) message(rec.missing ? `${rec.name} is missing from its folder.` : `Could not open ${rec.name}: ${err.message}`);
    }
  }

  function renderPos(list) { posEl.textContent = `${index + 1} of ${list.length.toLocaleString('en-GB')}`; }

  function renderInfo(rec) {
    const c = lib.choice(rec.id);
    const root = lib.roots.get(rec.rootId);
    const rows = [
      ['Taken', formatTaken(rec.time) + (rec.timeSource === 'file' ? ' (file date)' : '')],
      rec.w ? ['Dimensions', `${rec.w} × ${rec.h} px`] : null,
      ['File size', formatBytes(rec.size)],
      ['Type', rec.ext.toUpperCase()],
      rec.kind === 'video' && rec.dur ? ['Duration', formatDuration(rec.dur)] : null,
      rec.camera ? ['Camera', rec.camera] : null,
      rec.lens ? ['Lens', rec.lens] : null,
      rec.lat != null && rec.lon != null ? ['Location', `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}`] : null,
      ['Folder', `${root?.name ?? ''}/${rec.path}`],
      lib.rating(rec.id) ? ['Rating', `${lib.rating(rec.id)} of 5`] : null,
      c.flag ? ['Flag', c.flag === 'pick' ? 'Pick' : 'Reject'] : null,
      c.fav ? ['Favourite', 'Yes'] : null,
      lib.tagsOf(rec.id).length ? ['Tags', lib.tagsOf(rec.id).join(', ')] : null,
      lib.albumsOf(rec.id).length ? ['Albums', lib.albumsOf(rec.id).map(a => a.name).join(', ')] : null,
      rec.missing ? ['Status', 'Missing from its folder'] : null,
    ].filter(Boolean);
    info.innerHTML = `<h2 class="lv-info-title">Information</h2><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  }

  // After the list changes: keep the same photo when it is still there,
  // otherwise show the one that took its place.
  function refresh() {
    if (el.hidden) return;
    const list = getList();
    if (!list.length) { close(); return; }
    const at = list.findIndex(r => r.id === id);
    if (at < 0) { show(Math.min(index, list.length - 1)); return; }
    index = at;
    renderPos(list);
    renderInfo(list[at]);
    onShow(index);
  }

  // Keys the viewer handles itself; returns true when handled.
  function handleKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    switch (e.key) {
      case 'ArrowLeft': move(-1); return true;
      case 'ArrowRight': move(1); return true;
      case 'Home': show(0); return true;
      case 'End': show(getList().length - 1); return true;
      case 'Escape': close(); return true;
      case 'i': case 'I': toggleInfo(); return true;
      case 'e': case 'E': if (id && getList()[index]?.kind !== 'video') onEdit(id); return true;
      default: return false;
    }
  }

  return { open, close, refresh, handleKey, isOpen: () => !el.hidden, id: () => (el.hidden ? null : id) };
}
