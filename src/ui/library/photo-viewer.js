// The library's full-size viewer: one photo or video at a time, arrow keys,
// an info panel, and a button that hands the photo to the editor.
// Photos decode through Slate's decoder registry; videos play in <video>.
// A Motion Photo (row M6, `rec.motion`) plays the MP4 sliced from the end of its file, and a
// Live Photo (row M7, `rec.liveVideo`) plays its paired MOV, on hover or from the Play button.
// A stack (row B9) steps through its members with the Up and Down arrows or the stack buttons;
// the shown member is the one choices apply to.
// "Find similar" (row Q3) shows when the photo has a meaning vector (clip.js);
// it hands the id to hooks.onSimilar, and the grid shows the nearest photos.

import { decode } from '../../decode/registry.js';
import { esc } from '../../core/html.js';
import { dayKey, dayLabel, makeId } from '../../library/schema.js';

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

// Modal behaviour (review S24). While the viewer is open, every sibling of the viewer
// inside the Library gets the `inert` attribute, so a pointer, Tab or a screen reader
// cannot reach the grid behind it. A sibling that was inert already stays inert on close.
// Returns a function that undoes it.
export function makeSiblingsInert(el) {
  const changed = [];
  for (const sib of el.parentElement?.children ?? []) {
    if (sib === el || sib.hasAttribute('inert')) continue;
    sib.setAttribute('inert', '');
    changed.push(sib);
  }
  return () => { for (const sib of changed) sib.removeAttribute('inert'); };
}

// The element Tab (or Shift+Tab) moves to, kept inside `stops`, the viewer's focusable
// elements in document order: past the last comes the first, and before the first the last.
export function nextTabStop(stops, current, back = false) {
  if (!stops.length) return null;
  const i = stops.indexOf(current);
  if (back) return i <= 0 ? stops[stops.length - 1] : stops[i - 1];
  return i < 0 || i === stops.length - 1 ? stops[0] : stops[i + 1];
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

/**
 * @param {object} lib
 * @param {HTMLElement} el  the viewer container (starts hidden)
 * @param {{ getList: () => object[], getStack?: (id:string) => string[]|null, onShow: (index:number) => void, onClose: () => void, onEdit: (id:string) => void, canSimilar?: (id:string) => boolean, onSimilar?: (id:string) => void }} hooks
 */

// The motion clip of a record as a Blob, or null: the embedded MP4 of a Motion Photo,
// or the paired MOV of a Live Photo.
export async function motionClip(lib, rec) {
  if (rec.motion) {
    const file = await lib.getFile(rec.id);
    const start = file.size - rec.motion.offset;
    return file.slice(start, start + rec.motion.length, 'video/mp4');
  }
  if (rec.liveVideo) return lib.getFile(makeId(rec.rootId, rec.liveVideo));
  return null;
}

export function createPhotoViewer(lib, el, { getList, getStack = () => null, onShow, onClose, onEdit, canSimilar = () => false, onSimilar = () => {} }) {
  el.innerHTML = `
    <div class="lv-bar">
      <button class="btn-icon" data-v="close" aria-label="Back to the grid (Escape)"><svg class="icon" aria-hidden="true"><use href="#icon-x"/></svg></button>
      <span class="lv-name"></span>
      <span class="lv-pos"></span>
      <span class="lv-motion" hidden></span>
      <span class="lv-stack" hidden>
        <button class="btn-icon" data-v="sprev" aria-label="Previous in stack (Up arrow)"><span aria-hidden="true">&#8963;</span></button>
        <span class="lv-stackpos"></span>
        <button class="btn-icon" data-v="snext" aria-label="Next in stack (Down arrow)"><span aria-hidden="true">&#8964;</span></button>
      </span>
      <span class="lv-spacer"></span>
      <button class="btn-icon" data-v="prev" aria-label="Previous photo (Left arrow)"><span aria-hidden="true">&#8249;</span></button>
      <button class="btn-icon" data-v="next" aria-label="Next photo (Right arrow)"><span aria-hidden="true">&#8250;</span></button>
      <button class="btn-icon" data-v="info" aria-label="Photo information (I)" aria-pressed="true"><svg class="icon" aria-hidden="true"><use href="#icon-info"/></svg></button>
      <button class="btn" data-v="similar" aria-label="Find similar photos" hidden>Find similar</button>
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
  const similarBtn = el.querySelector('[data-v="similar"]');
  const motionEl = el.querySelector('.lv-motion');
  const stackEl = el.querySelector('.lv-stack');
  const stackPosEl = el.querySelector('.lv-stackpos');

  let index = -1, id = null, token = 0, videoUrl = null, clipUrl = null;
  let members = null, member = 0; // the stack at `index`, and which member is shown
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
    else if (a === 'sprev') step(-1);
    else if (a === 'snext') step(1);
    else if (a === 'play') playMotion();
    else if (a === 'edit' && id) onEdit(id);
    else if (a === 'similar' && id) { const sid = id; close(); onSimilar(sid); }
  });

  // Hovering the photo plays its motion clip (rows M6 and M7).
  stage.addEventListener('mouseenter', () => { if (!stage.querySelector('.lv-msg')) playMotion(); });

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
    if (clipUrl) { URL.revokeObjectURL(clipUrl); clipUrl = null; }
    stage.replaceChildren();
  }
  function message(text) {
    const p = document.createElement('p');
    p.className = 'lv-msg';
    p.textContent = text;
    stage.replaceChildren(p);
  }

  let restoreInert = null;
  function tabStops() {
    return [...el.querySelectorAll(FOCUSABLE)].filter(n => !n.closest('[hidden]') && !n.closest('[inert]') && n.getClientRects().length > 0);
  }

  function open(i) {
    el.hidden = false;
    if (!restoreInert) restoreInert = makeSiblingsInert(el);
    show(i);
    el.querySelector('[data-v="close"]').focus();
  }

  function close() {
    if (el.hidden) return;
    token++;
    clearStage();
    el.hidden = true;
    restoreInert?.(); restoreInert = null;
    index = -1; id = null; members = null;
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
    members = getStack(list[index].id);
    member = 0;
    onShow(index);
    showRecord(list[index]);
  }

  function step(delta) {
    if (!members) return;
    const next = Math.max(0, Math.min(members.length - 1, member + delta));
    if (next === member) return;
    member = next;
    const rec = lib.get(members[member]);
    if (rec) showRecord(rec);
  }

  function renderStack() {
    stackEl.hidden = !members;
    if (members) stackPosEl.textContent = `${member + 1} of ${members.length} in stack`;
  }

  // Play the motion clip over the still; the still comes back when the clip ends.
  async function playMotion() {
    const rec = lib.get(id);
    if (!rec || (!rec.motion && !rec.liveVideo) || stage.querySelector('video.lv-clip')) return;
    const t = token;
    let blob;
    try { blob = await motionClip(lib, rec); } catch { blob = null; }
    if (t !== token || !blob) return;
    const still = stage.firstElementChild;
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.className = 'lv-clip';
    v.muted = true; v.playsInline = true; v.autoplay = true;
    v.setAttribute('aria-label', `${rec.motion ? 'Motion' : 'Live'} clip of ${rec.name}`);
    const back = () => { if (t === token && v.isConnected) { stage.replaceChildren(...(still ? [still] : [])); } };
    v.addEventListener('ended', back);
    v.addEventListener('error', () => { back(); if (t === token) motionEl.textContent = 'This browser cannot play the clip'; });
    v.src = clipUrl;
    stage.replaceChildren(v);
  }

  async function showRecord(rec) {
    id = rec.id;
    renderStack();
    const t = ++token;
    nameEl.textContent = rec.name;
    renderPos(getList());
    renderInfo(rec);
    editBtn.disabled = rec.kind === 'video';
    similarBtn.hidden = !canSimilar(rec.id);
    const hasClip = !!(rec.motion || rec.liveVideo);
    motionEl.hidden = !hasClip;
    motionEl.innerHTML = hasClip ? `<span class="lv-motion-badge">${rec.motion ? 'Motion' : 'Live'}</span> <button class="btn btn-sm" data-v="play" aria-label="Play the ${rec.motion ? 'motion' : 'live'} clip (Space)">Play</button>` : '';
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
      rec.description ? ['Caption', rec.description] : null,
      lib.textOf?.(rec.id) ? ['Text in photo', lib.textOf(rec.id).slice(0, 400)] : null,
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
    const shownId = members ? members[0] : id;
    const at = list.findIndex(r => r.id === shownId);
    if (at < 0) { show(Math.min(index, list.length - 1)); return; }
    index = at;
    const fresh = getStack(shownId);
    if (members && (!fresh || !fresh.includes(id))) { show(at); return; }
    members = fresh;
    if (members) member = members.indexOf(id);
    renderStack();
    renderPos(list);
    const rec = lib.get(id) ?? list[at];
    renderInfo(rec);
    similarBtn.hidden = !canSimilar(id);
    onShow(index);
  }

  // Keys the viewer handles itself; returns true when handled.
  function handleKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    switch (e.key) {
      case 'Tab': nextTabStop(tabStops(), document.activeElement, e.shiftKey)?.focus(); return true;
      case 'ArrowLeft': move(-1); return true;
      case 'ArrowRight': move(1); return true;
      case 'Home': show(0); return true;
      case 'End': show(getList().length - 1); return true;
      case 'Escape': close(); return true;
      case 'ArrowUp': if (!members) return false; step(-1); return true;
      case 'ArrowDown': if (!members) return false; step(1); return true;
      case ' ': if (!lib.get(id)?.motion && !lib.get(id)?.liveVideo) return false; playMotion(); return true;
      case 'i': case 'I': toggleInfo(); return true;
      case 'e': case 'E': if (id && getList()[index]?.kind !== 'video') onEdit(id); return true;
      default: return false;
    }
  }

  return { open, close, refresh, handleKey, isOpen: () => !el.hidden, id: () => (el.hidden ? null : id) };
}
