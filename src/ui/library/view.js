// The Library mode: sidebar, search and filters, the virtualised grid with
// day and month headers, the month scrubber, selection, keyboard, the
// full-size viewer, the job status line and the storage panel.
// Search by meaning (rows Q2 and Q3, clip.js): a "Meaning" toggle beside the
// search box (or a leading ~) ranks the grid by CLIP similarity to the text,
// "Find similar" in the viewer ranks it by similarity to one photo, and the
// "Search by meaning" sidebar view turns the feature on and off.
// The editor stays underneath; the library covers it while open.
// Interface: docs/architecture.md, "The view".

import { state } from '../../core/state.js';
import { emit, on } from '../../core/events.js';
import { navigateTo, hasDirPicker } from '../../core/fs.js';
import { esc } from '../../core/html.js';
import { dayLabel, monthLabel } from '../../library/schema.js';
import { runCommand } from '../../library/commands.js';
import { buildStacks } from '../../library/stacks.js';
import { collapseStacks, buildLayout, ariaRowCount, ariaRowIndex, visibleRows, itemRect, hitTest, lassoIndices, moveIndex, monthTable, monthAt, scrubberMarks, monthAtTrack, clickSelect, toggleGroup, rangeIds } from './grid-model.js';
import { createPhotoViewer, formatDuration, formatTaken } from './photo-viewer.js';
import { openStoragePanel, needsDownload } from './storage.js';
import { downloadLibFile } from '../../library/persist.js';
import { openImportDialog } from './import.js';
import { createClip, pickWeights, WEIGHTS, MODEL_ID } from '../../library/clip.js';

const ZOOM_KEY = 'slate.v1.library.zoom';
const STACKS_KEY = 'slate.v1.library.stacks';
const PAD = 12;              // grid padding, px
const STRUCTURAL = new Set(['scan', 'load', 'rebuild', 'remove-root', 'empty-trash']);
const SLIDESHOW_MAX = 1000;
const BROWSE_ONLY_NOTE = 'This browser cannot keep access to a folder, so the library is browse-only here: Slate reads the files for this visit and keeps your choices in the browser. Download the library file from Storage to keep them.';
const icon = (id) => `<svg class="icon" aria-hidden="true"><use href="#icon-${id}"/></svg>`;

// The empty-grid message. A locked Hidden view says it is locked whatever the job queue
// is doing, because its photos stay out of the grid until the passphrase is entered.
export function emptyMessage({ view, busy = false, rankPending = false, ranked = null, searching = false, hiddenLocked = false }) {
  if (view === 'hidden' && hiddenLocked) return 'Hidden photos are locked. Unlock them to see them.';
  if (rankPending) return 'Searching by meaning.';
  if (ranked) return ranked.kind === 'similar' ? 'No similar photos found.' : 'No photos match this meaning closely enough.';
  if (busy) return 'Reading your folders. Photos appear here as they are found.';
  if (searching) return 'No photos match this search.';
  return { trash: 'The trash is empty.', hidden: 'No hidden photos.', favourites: 'No favourites yet.', videos: 'No videos.', album: 'This album is empty.' }[view] ?? 'No photos here.';
}

// The header count. A grid view counts its tiles. A view that draws its own panel shows
// the text its countText() gives, or no count at all, because its grid list is empty.
export function headCountText({ panel = null, items = 0, selected = 0 }) {
  if (panel) { try { return panel.countText?.() ?? ''; } catch { return ''; } }
  const n = `${items.toLocaleString('en-GB')} item${items === 1 ? '' : 's'}`;
  return selected ? `${n}, ${selected.toLocaleString('en-GB')} selected` : n;
}

// Stacks over ranked results (rows B9, Q2): the stacks come from the time-ordered list, so
// bursts are found as in the timeline, and each stack's top becomes its best-scoring member,
// so the tile shown for a stack is the closest match. Returns a new stackOf map.
export function rankedStackOf(stackOf, scores) {
  const out = new Map(), done = new Map();
  for (const [id, st] of stackOf) {
    let copy = done.get(st);
    if (!copy) {
      let top = st.top, best = scores.get(st.top) ?? -Infinity;
      for (const m of st.members) { const s = scores.get(m); if (s != null && s > best) { best = s; top = m; } }
      copy = { ...st, top };
      done.set(st, copy);
    }
    out.set(id, copy);
  }
  return out;
}

// The "Download … and turn on" button of the Search by meaning panel (row Q2). The panel
// renders the button once and only changes its text when the weights check returns, so the
// button never moves under the pointer. A click before the check returns is held and runs
// when the check answers, so it is never lost.
//   weights: a Promise of the dtype; enable(dtype): turns the feature on (handles its own errors);
//   onChange(): redraw the button's text and state.
export function meaningSwitch({ weights, enable, onChange = () => {} }) {
  let dtype = null, held = false, busy = false;
  const run = async () => {
    busy = true; onChange();
    try { await enable(dtype); } catch (err) { console.error('[slate meaning] turn on', err); } finally { busy = false; onChange(); }
  };
  Promise.resolve(weights).then((d) => {
    dtype = d; onChange();
    if (held) { held = false; run(); }
  });
  return {
    get dtype() { return dtype; },
    get busy() { return busy || held; },
    click() {
      if (busy || held) return 'ignored';
      if (!dtype) { held = true; onChange(); return 'held'; }
      run();
      return 'run';
    },
  };
}

export function initLibraryView(lib) {
  const el = document.getElementById('library');
  if (!el) throw new Error('the #library container is missing from index.html');

  el.innerHTML = `
    <header class="lib-head">
      <button class="btn lib-back" data-act="editor" aria-label="Back to the editor (Ctrl+L)">Editor</button>
      <h1 class="lib-title">Library</h1>
      <div class="lib-search" role="search">
        <input type="search" class="lib-q" placeholder="Search names, folders, tags, cameras, dates" aria-label="Search photos (/)" autocomplete="off">
        <button type="button" class="btn btn-sm lib-meaning" data-act="meaning" aria-pressed="false" title="Search by what photos show (or type ~ first)">Meaning</button>
      </div>
      <button class="btn" data-act="filters" aria-expanded="false" aria-controls="lib-filters">Filters</button>
      <div class="lib-zoom" role="group" aria-label="Tile size">
        <button class="btn-icon" data-act="zoom-out" aria-label="Smaller tiles (minus)">${icon('zoom-out')}</button>
        <button class="btn-icon" data-act="zoom-in" aria-label="Larger tiles (plus)">${icon('zoom-in')}</button>
      </div>
      <button class="btn-icon" data-act="slideshow" aria-label="Slideshow of the selection or this view">${icon('play')}</button>
      <button class="btn-icon" data-act="storage" aria-label="Storage and index">${icon('settings')}</button>
      <div class="lib-actions"></div>
    </header>
    <form class="lib-filters" id="lib-filters" hidden aria-label="Filters">
      <label>From <input type="date" name="from"></label>
      <label>To <input type="date" name="to"></label>
      <label>Type <select name="kind"><option value="">All</option><option value="photo">Photos</option><option value="video">Videos</option></select></label>
      <label>Camera <select name="camera"><option value="">Any</option></select></label>
      <label>Rating <select name="minRating"><option value="">Any</option><option value="1">1 star or more</option><option value="2">2 stars or more</option><option value="3">3 stars or more</option><option value="4">4 stars or more</option><option value="5">5 stars</option></select></label>
      <label>Flag <select name="flag"><option value="">Any</option><option value="pick">Pick</option><option value="reject">Reject</option><option value="none">No flag</option></select></label>
      <label>Tag <select name="tag"><option value="">Any</option></select></label>
      <label class="lib-check"><input type="checkbox" name="fav"> Favourites only</label>
      <button type="reset" class="btn">Clear filters</button>
    </form>
    <div class="lib-body">
      <nav class="lib-side library-sidebar" aria-label="Library views"></nav>
      <main class="lib-main">
        <div class="lib-viewhead">
          <h2 class="lib-viewname">Timeline</h2>
          <span class="lib-count"></span>
          <span class="lib-month" aria-hidden="true"></span>
          <span class="lib-ranked" hidden><span class="lib-ranked-text"></span> <button type="button" class="btn btn-sm" data-act="clear-ranked">Clear</button></span>
          <label class="lib-check lib-stacks"><input type="checkbox" class="lib-stacks-on"> Stack similar files</label>
        </div>
        <div class="lib-gridwrap">
          <div class="lib-grid library-grid" role="grid" tabindex="0" aria-label="Photos" aria-multiselectable="true">
            <div class="lib-sizer"></div>
            <div class="lib-lasso" hidden></div>
          </div>
          <div class="lib-scrub" role="slider" tabindex="0" aria-label="Jump to month" aria-orientation="vertical" hidden>
            <div class="lib-scrub-marks"></div>
            <div class="lib-scrub-thumb"></div>
            <div class="lib-scrub-bubble" hidden></div>
          </div>
          <div class="lib-empty" hidden></div>
          <div class="lib-panel" hidden></div>
        </div>
      </main>
    </div>
    <footer class="lib-status">
      <span class="lib-job" role="status" aria-live="polite"></span>
      <button class="btn btn-sm lib-pause" hidden>Pause</button>
    </footer>
    <div class="lib-viewer" role="dialog" aria-modal="true" aria-label="Photo viewer" hidden></div>
    <dialog class="lib-storage"></dialog>`;

  const $ = (s) => el.querySelector(s);
  const grid = $('.lib-grid'), sizer = $('.lib-sizer'), lasso = $('.lib-lasso');
  const side = $('.lib-side'), search = $('.lib-q'), filtersForm = $('.lib-filters');
  const scrub = $('.lib-scrub'), scrubMarks = $('.lib-scrub-marks'), scrubThumb = $('.lib-scrub-thumb'), scrubBubble = $('.lib-scrub-bubble');
  const emptyEl = $('.lib-empty'), countEl = $('.lib-count'), monthEl = $('.lib-month'), viewNameEl = $('.lib-viewname');
  const jobEl = $('.lib-job'), pauseBtn = $('.lib-pause'), storageDlg = $('.lib-storage');
  const panelEl = $('.lib-panel');
  const stacksBox = $('.lib-stacks-on');
  const meaningBtn = $('.lib-meaning'), rankedEl = $('.lib-ranked'), rankedText = $('.lib-ranked-text');
  // Views other modules add to the sidebar (ui.registerView): a view gives `ids()` to show
  // those photos in the grid, or `render(el, ctx)` to draw its own panel (returning a cleanup).
  const extraViews = new Map();
  let panelCleanup = null;

  // ── state ────────────────────────────────────────────────────────────────
  let open = false;
  let cur = { view: 'timeline' };
  let q = '';
  let filters = {};
  // Ranked results (rows Q2, Q3): { kind: 'meaning'|'similar', text?, id?, label, scores: Map id -> cosine }.
  let meaning = false, ranked = null, rankPending = false, rankSeq = 0;
  let list = [], ids = [], indexOf = new Map();
  let layout = buildLayout([], { width: 1 });
  let months = [];
  let sel = new Set(), anchor = -1, focusId = null;
  let zoom = 1;
  // Stacks (row B9): one tile for an edit and its original, RAW plus JPEG, and bursts.
  let stacking = true, stackMembers = new Map();
  try { stacking = localStorage.getItem(STACKS_KEY) !== '0'; } catch { /* storage blocked */ }
  try { const z = Number(localStorage.getItem(ZOOM_KEY)); if (z >= 0 && z <= 2) zoom = z; } catch { /* storage blocked */ }
  let dirty = true;                      // list needs a requery
  let savedScroll = 0;
  let firstOpen = true;
  const reconnect = new Set();           // root ids whose scan needs a click to re-ask permission
  const rowEls = new Map();              // row index -> { el, ctl }
  let lastWidth = 0;

  const ui = {
    showLibrary, hideLibrary, isOpen: () => open,
    openInEditor,
    select(list2) { setSelection(new Set((list2 || []).filter(id => indexOf.has(id)))); const f = list2?.find(id => indexOf.has(id)); if (f) setFocus(indexOf.get(f)); },
    selection: () => ids.filter(id => sel.has(id)),
    focused: () => viewer.id() ?? (focusId && indexOf.has(focusId) ? focusId : null),
    current,
    focusNext: () => moveFocusBy(1),
    focusPrev: () => moveFocusBy(-1),
    hooks: { albumMenu: null, onKey: null },
    registerView(def) {
      if (!def?.id || !def.label || (!def.ids && !def.render)) throw new Error('a view needs id, label and ids() or render()');
      extraViews.set(def.id, def);
      // Deferred: a view may register while initLibraryView is still running, before queueSidebar exists.
      queueMicrotask(() => queueSidebar());
    },
    refreshView() { if (cur.view === 'x') { if (extraViews.get(cur.xview)?.render) mountPanel(); else scheduleRequery(); } queueMicrotask(() => queueSidebar()); },
    actionsEl: $('.lib-actions'),
    toast: (message, level = 'info') => emit('toast', { message, level }),
  };

  // The meaning service; boot.js may set it first, otherwise the view makes it.
  const clip = lib.services.clip ?? (lib.services.clip = createClip(lib));

  const viewer = createPhotoViewer(lib, $('.lib-viewer'), {
    getList: () => list,
    getStack: (id) => stackMembers.get(id) ?? null,
    onShow: (i) => { focusId = ids[i]; },
    onClose: () => { const i = indexOf.get(focusId); if (i != null) setFocus(i); else grid.focus(); },
    onEdit: (id) => openInEditor(id),
    canSimilar: (id) => clip.enabled() && clip.has(id),
    onSimilar: (id) => findSimilar(id),
  });

  // ── entry points into the mode ───────────────────────────────────────────
  const group = document.querySelector('#toolbar .toolbar-group[aria-label="File"]') ?? document.getElementById('toolbar');
  if (group) {
    const b = document.createElement('button');
    b.id = 'tb-library'; b.className = 'btn-icon';
    b.title = b.ariaLabel = 'Photo library (Ctrl+L)';
    b.setAttribute('aria-label', 'Photo library (Ctrl+L)');
    b.innerHTML = icon('grid');
    b.addEventListener('click', () => runCommand(lib, 'library.open', {}, { ui }));
    group.insertBefore(b, group.firstChild);
  }
  const dzActions = document.querySelector('#empty-state .dropzone-actions');
  if (dzActions) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.innerHTML = `${icon('grid').replace('class="icon"', 'class="icon icon-sm"')} Photo library`;
    b.addEventListener('click', () => runCommand(lib, 'library.open', {}, { ui }));
    dzActions.appendChild(b);
  }

  function showLibrary() {
    if (!open) {
      open = true;
      el.hidden = false;
      document.getElementById('app')?.classList.add('library-open');
      renderSidebar();
      relayoutOrRequery();
      grid.scrollTop = savedScroll;
      render();
      if (!viewer.isOpen()) grid.focus({ preventScroll: true });
      if (firstOpen) { firstOpen = false; rescanAll(); }
      viewChanged();
    }
    emit('library:shown', null);
  }

  function hideLibrary() {
    if (!open) return;
    savedScroll = grid.scrollTop;
    viewer.close();
    open = false;
    el.hidden = true;
    document.getElementById('app')?.classList.remove('library-open');
    emit('library:hidden');
  }

  function current() {
    const opts = currentOpts();
    const searching = !!q || Object.keys(filters).length > 0;
    const view = searching && cur.view === 'timeline' ? 'search' : cur.view;
    const out = { view: ranked || rankPending ? 'search' : view, opts };
    if (ranked?.kind === 'meaning') out.meaning = ranked.text;
    if (ranked?.kind === 'similar') out.similarTo = ranked.id;
    if (cur.albumId) out.albumId = cur.albumId;
    if (cur.rootId) out.rootId = cur.rootId;
    if (cur.folder != null) out.folder = cur.folder;
    if (cur.xview) out.xview = cur.xview;
    return out;
  }

  // ── editor hand-off (row O7) ─────────────────────────────────────────────
  // The editor gets the one file. Its folder becomes the session's workspace
  // folder, so the editor's existing save writes a new file beside the
  // original; no file handle is passed, so the original is never overwritten.
  let editorRoot = null;
  async function openInEditor(id) {
    const rec = lib.get(id);
    if (!rec) throw new Error(`unknown photo id: ${id}`);
    if (rec.kind === 'video') { ui.toast('Videos play in the library viewer; the editor opens photos.', 'warn'); return; }
    let file, parent = null;
    try { file = await lib.getFile(id); }
    catch (err) { emit('error', { message: `Could not open ${rec.name}: ${err.message}` }); return; }
    try { parent = await lib.getHandle(id, { parent: true }); } catch { parent = null; }
    state.session.source = 'library';
    state.session.folderHandle = parent;
    state.session.files = [{ handle: null, name: rec.name, size: file.size, type: file.type, index: 0, file }];
    state.session.currentIndex = 0;
    editorRoot = rec.rootId;
    focusId = id;
    hideLibrary();
    await navigateTo(0);
    emit('session:changed', state.session);
    if (!parent) ui.toast('This folder is browse-only, so saves download a copy.', 'info');
  }

  // A save beside the original adds a file to the folder: index it.
  on('save:complete', () => {
    if (state.session.source !== 'library' || !editorRoot || state.export.saveMode !== 'sidecar') return;
    if (!lib.roots.has(editorRoot)) return;
    lib.rescan(editorRoot).catch(err => scanFailed(editorRoot, err));
  });

  // ── slideshow (row B8): Slate's slideshow runs over state.session.files ──
  async function startSlideshow() {
    const pick = (sel.size ? ids.filter(id => sel.has(id)) : ids).filter(id => lib.get(id)?.kind === 'photo' && !lib.get(id)?.missing);
    if (!pick.length) { ui.toast('There are no photos to show here.', 'warn'); return; }
    if (pick.length > SLIDESHOW_MAX) ui.toast(`The slideshow shows the first ${SLIDESHOW_MAX.toLocaleString('en-GB')} photos.`, 'info');
    const chosen = pick.slice(0, SLIDESHOW_MAX);
    const files = (await Promise.all(chosen.map(id => lib.getFile(id).catch(() => null))))
      .map((f, i) => f && { handle: null, name: lib.get(chosen[i]).name, size: f.size, type: f.type, index: 0, file: f })
      .filter(Boolean);
    if (!files.length) { ui.toast('Could not read those photos.', 'error'); return; }
    files.forEach((f, i) => { f.index = i; });
    state.session.source = 'library';
    state.session.folderHandle = null;
    state.session.files = files;
    state.session.currentIndex = 0;
    editorRoot = null;
    hideLibrary();
    await navigateTo(0);
    emit('session:changed', state.session);
    emit('slideshow:start', null);
  }

  // ── query ────────────────────────────────────────────────────────────────
  function baseOpts() {
    switch (cur.view) {
      case 'favourites': return { fav: true };
      case 'videos': return { kind: 'video' };
      case 'album': return { album: cur.albumId };
      case 'folder': return { root: cur.rootId, folder: cur.folder };
      case 'hidden': return { hidden: 'only' };
      case 'trash': return { trashed: 'only', hidden: 'include' };
      default: return {};
    }
  }
  function currentOpts() {
    const o = { ...baseOpts(), ...filters };
    if (q && !meaningText()) o.q = q;
    if (cur.view === 'videos') o.kind = 'video';
    if (cur.view === 'favourites') o.fav = true;
    return o;
  }

  function requery() {
    dirty = false;
    const keep = scrollAnchor();
    const xdef = cur.view === 'x' ? extraViews.get(cur.xview) : null;
    if (xdef?.render) { list = []; ids = []; indexOf = new Map(); months = []; updateMonthLabel(); renderHead(); return; }
    list = lib.search(currentOpts());
    if (xdef?.ids) { const want = new Set(xdef.ids()); list = list.filter(r => want.has(r.id)); }
    let timeOrder = list;
    if (ranked) {
      const sc = ranked.scores;
      timeOrder = list.filter(r => sc.has(r.id));
      list = [...timeOrder].sort((a, b) => sc.get(b.id) - sc.get(a.id));
    } else if (rankPending) list = timeOrder = [];
    renderRanked();
    stackMembers = new Map();
    if (stacking && cur.view !== 'trash') {
      let { stackOf } = buildStacks(timeOrder);
      if (ranked) stackOf = rankedStackOf(stackOf, ranked.scores);
      ({ items: list, members: stackMembers } = collapseStacks(list, stackOf));
    }
    ids = list.map(r => r.id);
    indexOf = new Map(ids.map((id, i) => [id, i]));
    let pruned = false;
    for (const id of sel) if (!indexOf.has(id)) { sel.delete(id); pruned = true; }
    relayout(keep);
    updateMonthLabel();
    renderHead();
    viewer.refresh();
    if (pruned) { announceSelection(); selectionChanged(); }
  }

  let rqTimer = null, rqLast = 0;
  function scheduleRequery() {
    dirty = true;
    if (!open || rqTimer) return;
    const wait = Math.max(0, rqLast + 500 - performance.now());
    rqTimer = setTimeout(() => { rqTimer = null; rqLast = performance.now(); if (open) requery(); }, wait);
  }
  function relayoutOrRequery() { if (dirty) requery(); else relayout(scrollAnchor()); }

  // ── layout and rendering ─────────────────────────────────────────────────
  const sortable = () => !ranked; // every view sorts by capture time, newest first; ranked results by score
  function relayout(keep) {
    const width = grid.clientWidth - PAD * 2;
    if (width <= 0) return;
    lastWidth = grid.clientWidth;
    layout = buildLayout(list, { width, zoom, grouped: sortable() });
    months = monthTable(layout, list);
    sizer.style.height = `${layout.height}px`;
    grid.setAttribute('aria-rowcount', String(ariaRowCount(layout)));
    sizer.style.width = `${width}px`;
    const carry = clearRows();
    renderScrubber();
    if (keep && indexOf.has(keep.id)) grid.scrollTop = itemRect(layout, indexOf.get(keep.id)).y - keep.offset;
    render(carry);
    renderEmpty();
  }

  // The first visible item and its distance from the top, to hold position across relayouts.
  function scrollAnchor() {
    if (!layout.rows.length || !list.length) return null;
    const top = grid.scrollTop - PAD;
    const fi = indexOf.get(focusId);
    if (fi != null && layout.itemRow.length > fi) {
      const r = itemRect(layout, fi);
      if (r.y >= top && r.y < top + grid.clientHeight) return { id: focusId, offset: r.y - grid.scrollTop };
    }
    const { first } = visibleRows(layout, top, grid.clientHeight, 0);
    for (let r = first; r < layout.rows.length; r++) {
      const row = layout.rows[r];
      if (row.type === 'tiles' && row.start < ids.length) return { id: ids[row.start], offset: row.top - grid.scrollTop };
    }
    return null;
  }

  function clearRows() {
    const carry = new Map();
    for (const { el: r, ctl } of rowEls.values()) {
      ctl.abort();
      for (const img of r.querySelectorAll('img[src]')) carry.set(img.closest('[data-id]').dataset.id, img.src);
      r.remove();
    }
    rowEls.clear();
    return carry;
  }

  let renderQueued = false;
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render(carry = null) {
    if (!open) return;
    const { first, last } = visibleRows(layout, grid.scrollTop - PAD, grid.clientHeight, 600);
    for (const [r, entry] of rowEls) {
      if (r < first || r > last) { entry.ctl.abort(); entry.el.remove(); rowEls.delete(r); }
    }
    for (let r = first; r <= last; r++) if (!rowEls.has(r)) makeRow(r, carry);
    updateScrubThumb();
  }

  function makeRow(r, carry) {
    const row = layout.rows[r];
    const ctl = new AbortController();
    const div = document.createElement('div');
    div.className = row.type === 'header' ? `lib-row lib-head-row lib-head-${row.unit}` : 'lib-row';
    div.setAttribute('role', 'row');
    div.setAttribute('aria-rowindex', String(ariaRowIndex(r)));
    div.style.transform = `translateY(${row.top}px)`;
    div.style.height = `${row.height}px`;
    if (row.type === 'header') {
      const label = row.unit === 'month' ? monthLabel(row.key) : dayLabel(row.key);
      const all = ids.slice(row.start, row.start + row.count).every(id => sel.has(id));
      div.innerHTML = `<div role="rowheader" class="lib-hcell">
        <button class="lib-daysel" data-group="${r}" aria-pressed="${all}" aria-label="Select all ${row.count} in ${esc(label)}"><span class="lib-tick" aria-hidden="true"></span></button>
        <span class="lib-hlabel">${esc(label)}</span><span class="lib-hcount">${row.count.toLocaleString('en-GB')}</span></div>`;
    } else {
      for (let i = row.start; i < row.end; i++) div.appendChild(makeTile(i, ctl.signal, carry));
    }
    sizer.appendChild(div);
    rowEls.set(r, { el: div, ctl });
  }

  function makeTile(i, signal, carry) {
    const rec = list[i];
    const c = lib.choice(rec.id);
    const rating = lib.rating(rec.id);
    const t = document.createElement('div');
    t.className = 'lib-tile';
    t.id = `lib-t-${i}`;
    t.dataset.id = rec.id;
    t.dataset.i = i;
    t.setAttribute('role', 'gridcell');
    t.setAttribute('aria-selected', String(sel.has(rec.id)));
    t.style.width = t.style.height = `${layout.tile}px`;
    if (sel.has(rec.id)) t.classList.add('is-sel');
    if (rec.id === focusId) t.classList.add('is-focus');
    if (c.hidden) t.classList.add('is-hidden');
    const label = [rec.name, formatTaken(rec.time)];
    const badges = [];
    if (rec.kind === 'video') { label.push(`video${rec.dur ? ' ' + formatDuration(rec.dur) : ''}`); badges.push(`<span class="lib-b lib-b-dur">${rec.dur ? formatDuration(rec.dur) : 'Video'}</span>`); }
    const stack = stackMembers.get(rec.id);
    if (stack) { label.push(`stack of ${stack.length}`); badges.push(`<span class="lib-b lib-b-stack">${stack.length}</span>`); }
    if (rec.motion || rec.liveVideo) { label.push(rec.motion ? 'motion photo' : 'live photo'); badges.push(`<span class="lib-b lib-b-motion">${rec.motion ? 'Motion' : 'Live'}</span>`); }
    if (c.fav) { label.push('favourite'); badges.push('<span class="lib-b lib-b-fav">&#9829;</span>'); }
    if (rating) { label.push(`${rating} star${rating === 1 ? '' : 's'}`); badges.push(`<span class="lib-b lib-b-star">&#9733;${rating}</span>`); }
    if (c.flag === 'pick') { label.push('picked'); badges.push('<span class="lib-b lib-b-pick">&#10003;</span>'); }
    if (c.flag === 'reject') { label.push('rejected'); badges.push('<span class="lib-b lib-b-reject">&#10005;</span>'); }
    if (rec.missing) { label.push('missing'); badges.push('<span class="lib-b lib-b-missing">Missing</span>'); }
    t.setAttribute('aria-label', label.join(', '));
    t.innerHTML = `<span class="lib-ph" aria-hidden="true">${esc(rec.ext.toUpperCase())}</span><span class="lib-badges" aria-hidden="true">${badges.join('')}</span><span class="lib-selmark" aria-hidden="true"></span>`;
    const known = carry?.get(rec.id);
    if (known) setThumb(t, known);
    if (rec.thumb !== 'fail' && rec.thumb !== 'none') loadThumb(t, rec.id, signal);
    return t;
  }

  function setThumb(t, url) {
    let img = t.querySelector('img');
    if (!img) { img = document.createElement('img'); img.alt = ''; img.draggable = false; img.decoding = 'async'; t.insertBefore(img, t.firstChild); }
    if (img.src !== url) img.src = url;
    t.classList.add('has-img');
  }

  function loadThumb(t, id, signal) {
    const thumbs = lib.services.thumbs;
    if (!thumbs?.url) return;
    // The signal lets a thumbnail service drop requests for rows that scrolled away;
    // either way a late answer for a removed tile is ignored here.
    Promise.resolve(thumbs.url(id, { signal })).then(u => {
      if (!u || signal.aborted || t.dataset.id !== id || !t.isConnected) return;
      setThumb(t, u);
    }).catch(() => {});
  }

  // Tiles whose record changed without a change of order (thumbnails, durations, choices).
  function refreshTiles(changed) {
    for (const [, { el: rowEl, ctl }] of rowEls) {
      for (const t of rowEl.querySelectorAll('.lib-tile')) {
        if (!changed.has(t.dataset.id)) continue;
        const fresh = makeTile(Number(t.dataset.i), ctl.signal, new Map([[t.dataset.id, t.querySelector('img')?.src]].filter(x => x[1])));
        t.replaceWith(fresh);
      }
    }
  }

  function repaintSelection() {
    for (const [, { el: rowEl }] of rowEls) {
      for (const t of rowEl.querySelectorAll('.lib-tile')) {
        const on1 = sel.has(t.dataset.id);
        t.classList.toggle('is-sel', on1);
        t.setAttribute('aria-selected', String(on1));
        t.classList.toggle('is-focus', t.dataset.id === focusId);
      }
      for (const b of rowEl.querySelectorAll('.lib-daysel')) {
        const row = layout.rows[Number(b.dataset.group)];
        b.setAttribute('aria-pressed', String(ids.slice(row.start, row.start + row.count).every(id => sel.has(id))));
      }
    }
  }

  // ── header, counts, empty state ──────────────────────────────────────────
  function viewTitle() {
    if (ranked) return ranked.kind === 'similar' ? 'Similar photos' : 'Search by meaning';
    if (rankPending) return 'Searching by meaning';
    if (q || Object.keys(filters).length) { if (cur.view === 'timeline') return 'Search results'; }
    switch (cur.view) {
      case 'favourites': return 'Favourites';
      case 'videos': return 'Videos';
      case 'album': return lib.albums.get(cur.albumId)?.name ?? 'Album';
      case 'folder': return `${lib.roots.get(cur.rootId)?.name ?? ''}${cur.folder ? '/' + cur.folder : ''}`;
      case 'hidden': return 'Hidden';
      case 'trash': return 'Trash';
      case 'x': return extraViews.get(cur.xview)?.label ?? 'Library';
      default: return 'Timeline';
    }
  }
  function renderHead() {
    viewNameEl.textContent = viewTitle();
    const xdef = cur.view === 'x' ? extraViews.get(cur.xview) : null;
    countEl.textContent = headCountText({ panel: xdef?.render ? xdef : null, items: list.length, selected: sel.size });
    countEl.hidden = !countEl.textContent;
  }
  function announceSelection() { renderHead(); }

  function renderEmpty() {
    if (!lib.roots.size) {
      emptyEl.hidden = false;
      emptyEl.innerHTML = `<div class="lib-empty-inner"><h2>Add a folder of photos</h2>
        <p>Slate reads the photos where they are. Nothing is uploaded or copied, and your choices are saved in the folder.</p>
        <button class="btn btn-primary" data-act="add-folder">Add folder</button>
        ${hasDirPicker ? '<button class="btn" data-act="import-takeout">Import Google Takeout…</button>' : ''}
        ${hasDirPicker ? '' : `<p class="lib-note">${BROWSE_ONLY_NOTE}</p>`}</div>`;
      return;
    }
    if (list.length) { emptyEl.hidden = true; return; }
    const locked = cur.view === 'hidden' && !!lib.hiddenLocked?.();
    const msg = emptyMessage({ view: cur.view, busy: !lib.jobs.status().idle, rankPending, ranked, searching: !!q || Object.keys(filters).length > 0, hiddenLocked: locked });
    emptyEl.hidden = false;
    emptyEl.innerHTML = `<div class="lib-empty-inner"><p>${esc(msg)}</p>${locked && ui.hooks.unlockHidden ? '<button type="button" class="btn btn-primary" data-act="unlock-hidden" aria-haspopup="dialog">Unlock…</button>' : ''}</div>`;
  }

  // ── sidebar ──────────────────────────────────────────────────────────────
  function isCurrent(v, extra = {}) {
    if (cur.view !== v) return false;
    return Object.entries(extra).every(([k, val]) => cur[k] === val);
  }
  function viewBtn(view, label, count, extra = {}, cls = '') {
    const attrs = Object.entries(extra).map(([k, v]) => `data-${k}="${esc(String(v))}"`).join(' ');
    return `<button class="lib-nav ${cls}" data-view="${view}" ${attrs} ${isCurrent(view, extra) ? 'aria-current="page"' : ''}><span class="lib-nav-label">${esc(label)}</span>${count != null ? `<span class="lib-nav-count">${count.toLocaleString('en-GB')}</span>` : ''}</button>`;
  }

  function renderSidebar() {
    if (!open) return;
    const c = lib.counts();
    const albums = [...lib.albums.values()].sort((a, b) => a.name.localeCompare(b.name));
    const folders = lib.folders();
    let html = `<div class="lib-side-sec">
      ${viewBtn('timeline', 'Timeline', c.photos + c.videos)}
      ${viewBtn('favourites', 'Favourites', c.favourites)}
      ${viewBtn('videos', 'Videos', c.videos)}
      ${[...extraViews.values()].map(d => viewBtn('x', d.label, d.count ? d.count() : null, { xview: d.id })).join('')}
    </div>
    <h2 class="lib-side-h">Albums</h2><div class="lib-side-sec">`;
    if (!albums.length) html += '<p class="lib-side-note">No albums yet.</p>';
    for (const al of albums) {
      const n = [...al.items].filter(id => lib.get(id) && !lib.choice(id).trashed).length;
      html += `<div class="lib-side-row">${viewBtn('album', al.name, n, { album: al.id })}<button class="btn-icon lib-more" data-album-menu="${esc(al.id)}" aria-label="Options for album ${esc(al.name)}" aria-haspopup="menu"><span aria-hidden="true">&#8943;</span></button></div>`;
    }
    html += '</div><h2 class="lib-side-h">Folders</h2><div class="lib-side-sec">';
    for (const root of lib.roots.values()) {
      const browseOnly = root.mode === 'files' || !root.handle;
      html += `<div class="lib-root"><div class="lib-root-head">${viewBtn('folder', root.name, subtreeCounts(folders.get(root.id) ?? new Map()).get('') ?? 0, { root: root.id, folder: '' }, 'lib-root-name')}`;
      if (reconnect.has(root.id)) html += `<button class="btn btn-sm btn-primary" data-reconnect="${esc(root.id)}" aria-label="Reconnect ${esc(root.name)}">Reconnect</button>`;
      html += '</div>';
      if (browseOnly) html += '<p class="lib-side-note">Browse-only</p>';
      if (needsDownload(lib, root)) html += `<button class="btn btn-sm lib-dl" data-download="${esc(root.id)}" aria-label="Download the library file for ${esc(root.name)}">Download library file</button>`;
      html += folderTree(root, folders.get(root.id) ?? new Map());
      html += '</div>';
    }
    html += `<button class="btn lib-add" data-act="add-folder">${icon('folder').replace('class="icon"', 'class="icon icon-sm"')} Add folder</button>`;
    if (hasDirPicker) html += `<button class="btn lib-add" data-act="import-takeout">Import Google Takeout…</button>`;
    if (!hasDirPicker) html += `<p class="lib-side-note">${BROWSE_ONLY_NOTE}</p>`;
    html += `</div><div class="lib-side-sec lib-side-end">
      ${viewBtn('hidden', 'Hidden', lib.hiddenLocked?.() ? null : c.hidden)}
      ${viewBtn('trash', 'Trash', c.trashed)}
    </div>`;
    side.innerHTML = html;
    if (cur.view === 'x' && extraViews.get(cur.xview)?.render) renderHead();
  }

  // Top-level folders of a root, plus the branch down to (and the children of) the current folder.
  // Photos in a folder and every folder below it.
  function subtreeCounts(counts) {
    const out = new Map();
    for (const [p, n] of counts) {
      const parts = p ? p.split('/') : [];
      for (let k = 0; k <= parts.length; k++) {
        const key = parts.slice(0, k).join('/');
        out.set(key, (out.get(key) || 0) + n);
      }
    }
    return out;
  }

  function folderTree(root, direct) {
    const counts = subtreeCounts(direct);
    const all = new Set();
    for (const p of counts.keys()) {
      if (!p) continue;
      const parts = p.split('/');
      for (let k = 1; k <= parts.length; k++) all.add(parts.slice(0, k).join('/'));
    }
    const curFolder = cur.view === 'folder' && cur.rootId === root.id ? cur.folder : null;
    const shown = [...all].filter(p => {
      const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      return parent === '' || (curFolder != null && (curFolder === parent || curFolder.startsWith(parent + '/')));
    }).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!shown.length) return '';
    return `<div class="lib-tree">${shown.map(p => {
      const depth = p.split('/').length;
      return `<div style="padding-left:${(depth - 1) * 12}px">${viewBtn('folder', p.slice(p.lastIndexOf('/') + 1), counts.get(p) ?? 0, { root: root.id, folder: p })}</div>`;
    }).join('')}</div>`;
  }

  side.addEventListener('click', (e) => {
    const menu = e.target.closest('[data-album-menu]');
    if (menu) { ui.hooks.albumMenu?.(menu.dataset.albumMenu, menu); return; }
    const dl = e.target.closest('[data-download]');
    if (dl) { downloadLibFile(lib, dl.dataset.download); return; }
    const rc = e.target.closest('[data-reconnect]');
    if (rc) { reconnectRoot(rc.dataset.reconnect); return; }
    const b = e.target.closest('[data-view]');
    if (!b) return;
    const v = b.dataset.view;
    cur = { view: v };
    if (v === 'album') cur.albumId = b.dataset.album;
    if (v === 'folder') { cur.rootId = b.dataset.root; cur.folder = b.dataset.folder ?? ''; }
    if (v === 'x') cur.xview = b.dataset.xview;
    switchView();
  });

  function mountPanel() {
    try { panelCleanup?.(); } catch { /* a view's cleanup never stops the switch */ }
    panelCleanup = null;
    const def = cur.view === 'x' ? extraViews.get(cur.xview) : null;
    const usePanel = !!def?.render;
    panelEl.hidden = !usePanel;
    grid.hidden = usePanel;
    if (usePanel) { scrub.hidden = true; emptyEl.hidden = true; panelEl.innerHTML = ''; panelCleanup = def.render(panelEl, { lib, ui, refresh: () => ui.refreshView() }) ?? null; }
  }

  function switchView() {
    sel = new Set(); anchor = -1; focusId = null;
    monthEl.textContent = ''; monthEl.hidden = true;
    if (ranked?.kind === 'similar') { ranked = null; rankSeq++; }
    viewer.close();
    mountPanel();
    grid.scrollTop = 0;
    requery();
    grid.scrollTop = 0;
    render();
    renderSidebar();
    selectionChanged();
    viewChanged();
  }

  // ── folders: add, rescan, reconnect ──────────────────────────────────────
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    if (a === 'add-folder') addFolder();
    if (a === 'import-takeout') openImportDialog();
    else if (a === 'editor') hideLibrary();
    else if (a === 'filters') toggleFilters();
    else if (a === 'zoom-in') setZoom(zoom + 1);
    else if (a === 'zoom-out') setZoom(zoom - 1);
    else if (a === 'slideshow') startSlideshow();
    else if (a === 'storage') openStoragePanel(lib, storageDlg);
    else if (a === 'meaning') toggleMeaning();
    else if (a === 'clear-ranked') clearRanked();
    else if (a === 'unlock-hidden') ui.hooks.unlockHidden?.();
  });

  function pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.webkitdirectory = true;
      input.onchange = () => resolve(Array.from(input.files ?? []));
      input.click();
    });
  }

  async function addFolder() {
    if (hasDirPicker) {
      let handle;
      try { handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'slate-library' }); }
      catch (err) { if (err.name !== 'AbortError') emit('error', { message: `Could not add the folder: ${err.message}` }); return; }
      cur = { view: 'timeline' };
      switchView();
      lib.addRoot({ handle }).then(() => renderSidebar()).catch(async (err) => {
        for (const r of lib.roots.values()) if (r.handle && await r.handle.isSameEntry?.(handle)) { scanFailed(r.id, err); return; }
        emit('error', { message: `Could not add the folder: ${err.message}` });
      });
    } else {
      const files = await pickFiles();
      if (!files.length) return;
      const name = (files[0].webkitRelativePath || '').split('/')[0] || 'Photos';
      cur = { view: 'timeline' };
      switchView();
      ui.toast(`${name} is browse-only in this browser.`, 'info');
      lib.addRoot({ name, files }).then(() => renderSidebar()).catch(err => emit('error', { message: `Could not read ${name}: ${err.message}` }));
    }
  }

  function scanFailed(rootId, err) {
    if (err?.code === 'permission') {
      reconnect.add(rootId);
      renderSidebar();
      ui.toast(`Slate needs your permission to read ${lib.roots.get(rootId)?.name ?? 'a folder'} again. Press Reconnect.`, 'warn');
    } else emit('error', { message: `Could not scan ${lib.roots.get(rootId)?.name ?? 'a folder'}: ${err?.message ?? err}` });
  }

  function rescanRoot(rootId) {
    return lib.rescan(rootId).then(() => { if (reconnect.delete(rootId)) renderSidebar(); }, err => scanFailed(rootId, err));
  }

  // Once per session, look for new, changed and missing files (row L4). This runs
  // from the click or key that opened the library, so a permission prompt can show.
  async function rescanAll() {
    for (const root of [...lib.roots.values()]) {
      if (!root.handle && !root.files) { reconnect.add(root.id); continue; }
      await rescanRoot(root.id);
    }
    renderSidebar();
  }

  async function reconnectRoot(rootId) {
    const root = lib.roots.get(rootId);
    if (!root) return;
    if (!root.handle) {
      const files = await pickFiles();
      if (!files.length) return;
      root.files = files; // browse-only roots hold their files in memory (see library.js addRoot)
    } else if (root.handle.requestPermission) {
      // Ask here, from the click, then read the library file before anything is saved (review S1).
      try { await root.handle.requestPermission({ mode: 'readwrite' }); } catch { /* the scan reports it */ }
    }
    await lib.loadLibFile(root);
    rescanRoot(rootId);
  }

  // ── search and filters ───────────────────────────────────────────────────
  let qTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      q = search.value.trim();
      if (ranked?.kind === 'similar') ranked = null;
      grid.scrollTop = 0;
      if (meaningText()) runMeaning(); else { if (ranked || rankPending) { ranked = null; rankPending = false; rankSeq++; } requery(); }
      viewChanged();
    }, 150);
  });

  // ── search by meaning (rows Q2, Q3) ──────────────────────────────────────
  // The text of a meaning query: the box text when the toggle is on, or after a leading ~.
  function meaningText() {
    if (!clip.enabled()) return '';
    if (q.startsWith('~')) return q.slice(1).trim();
    return meaning ? q : '';
  }

  async function runMeaning() {
    const text = meaningText();
    if (ranked?.kind === 'meaning' && ranked.text === text) { requery(); return; }
    const my = ++rankSeq;
    ranked = null; rankPending = true;
    requery();
    try {
      const hits = await clip.searchText(text);
      if (my !== rankSeq) return;
      ranked = { kind: 'meaning', text, label: `Closest to “${text}”`, scores: new Map(hits.map(h => [h.id, h.score])) };
    } catch (err) {
      if (my === rankSeq) ui.toast(`Search by meaning failed: ${err?.message ?? err}`, 'error');
    } finally {
      if (my === rankSeq) { rankPending = false; requery(); viewChanged(); }
    }
  }

  function findSimilar(id) {
    const rec = lib.get(id);
    if (!rec) return;
    const hits = clip.similar(id);
    rankSeq++; rankPending = false;
    q = ''; search.value = '';
    if (cur.view !== 'timeline') { cur = { view: 'timeline' }; switchView(); }
    ranked = { kind: 'similar', id, label: `Like ${rec.name}`, scores: new Map([[id, 2], ...hits.map(h => [h.id, h.score])]) };
    grid.scrollTop = 0;
    requery();
    renderSidebar();
    viewChanged();
  }

  function clearRanked() {
    rankSeq++; rankPending = false;
    q = ''; search.value = '';
    ranked = null;
    requery();
    viewChanged();
  }

  function toggleMeaning() {
    if (!clip.enabled()) { cur = { view: 'x', xview: 'meaning' }; switchView(); return; }
    meaning = !meaning;
    renderMeaningBtn();
    if (q) { if (meaningText()) runMeaning(); else { ranked = null; rankPending = false; rankSeq++; requery(); } }
    search.focus();
  }

  function renderMeaningBtn() {
    const on = clip.enabled();
    meaningBtn.setAttribute('aria-pressed', String(on && meaning));
    meaningBtn.title = on ? 'Search by what photos show (or type ~ first)' : 'Turn on search by meaning';
    search.placeholder = on && meaning ? 'Describe what the photo shows' : 'Search names, folders, tags, cameras, dates';
  }

  function renderRanked() {
    rankedEl.hidden = !ranked;
    if (ranked) rankedText.textContent = `${ranked.label}, best match first`;
  }

  clip.onChange(() => {
    renderMeaningBtn();
    queueSidebar();
    if (!clip.enabled() && (ranked || rankPending || meaning)) { meaning = false; ranked = null; rankPending = false; rankSeq++; scheduleRequery(); }
    if (viewer.isOpen()) viewer.refresh();
  });

  // The "Search by meaning" view: what it downloads, the switch, and the vector store.
  // Each state (off, on) renders its structure once; later changes update text in place,
  // so no button is replaced while the pointer is on it (row Q2, promo finding 10).
  const mb = (b) => `${Math.round(b / 1e6).toLocaleString('en-GB')} MB`;
  let weightsGuess = null, weightsCheck = null;
  const checkWeights = () => (weightsCheck ??= pickWeights().then(d => (weightsGuess = d)));
  ui.registerView({
    id: 'meaning',
    label: 'Search by meaning',
    count: () => (clip.enabled() ? clip.count() : null),
    countText: () => (clip.enabled() ? `${clip.count().toLocaleString('en-GB')} photos with a vector` : ''),
    render(host) {
      const root = document.createElement('div');
      root.className = 'mng-root';
      host.appendChild(root);
      let queued = false, mode = '', actionsSig = '';
      const sw = meaningSwitch({
        weights: weightsGuess ?? checkWeights(),
        enable: async (dtype) => { try { await clip.enable(dtype); } catch (err) { ui.toast(err?.message ?? String(err), 'error'); } },
        onChange: () => queue(),
      });
      const drawOff = () => {
        if (mode !== 'off') {
          mode = 'off';
          root.innerHTML = `<h2>Search by meaning</h2>
            <p>Find photos by what they show, such as “dog on a beach” or “birthday cake”, and find photos that look like the one you are viewing. Duplicates can also use it to find near copies that fingerprints miss.</p>
            <p>Turning this on downloads the ${esc(MODEL_ID)} model (OpenAI CLIP ViT-B/32, MIT licence) from Hugging Face, once<span class="mng-size"></span>. Slate then reads each photo’s 256 px thumbnail on this device to make a small vector for it. No photo and no search text leaves this device.</p>
            <p class="mng-note"></p>
            <button type="button" class="btn btn-primary" data-mng="on"></button>`;
        }
        const dtype = sw.dtype, w = dtype ? WEIGHTS[dtype] : null;
        root.querySelector('.mng-size').innerHTML = w ? `: about <strong>${mb(w.bytes)}</strong>` : '';
        root.querySelector('.mng-note').textContent = dtype ? (dtype === 'fp16' ? 'This browser will run the model on the graphics card (WebGPU, 16-bit weights).' : 'This browser will run the model on the processor (WebAssembly, 8-bit weights), which is slower.') : 'Checking this browser';
        const btn = root.querySelector('[data-mng="on"]');
        const label = sw.busy ? (dtype ? 'Turning on…' : 'Checking this browser…') : `Download ${w ? mb(w.bytes) + ' ' : ''}and turn on`;
        if (btn.textContent !== label) btn.textContent = label;
        btn.setAttribute('aria-disabled', String(sw.busy));
      };
      const drawOn = (s) => {
        if (mode !== 'on') {
          mode = 'on'; actionsSig = '';
          root.innerHTML = `<h2>Search by meaning</h2>
            <dl class="mng-facts">
              <dt>Model</dt><dd class="mng-model"></dd>
              <dt>Photos with a vector</dt><dd class="mng-count"></dd>
              <dt>Vector store</dt><dd class="mng-bytes"></dd>
            </dl>
            <p>Press Meaning beside the search box, or type ~ before a search, then describe the photo. In the viewer, Find similar shows the photos closest to the one you are viewing.</p>
            <div class="mng-actions"></div>`;
        }
        const job = lib.jobs.status().kinds.clip;
        const left = job ? Math.max(0, job.total - job.done - job.failed) : 0;
        root.querySelector('.mng-model').textContent = s.model === 'loading'
          ? (s.progress ? `Downloading the model: ${mb(s.progress.loaded)} of ${mb(s.progress.total)}` : 'Loading the model')
          : s.model === 'ready' ? `Model ready on ${s.device === 'webgpu' ? 'WebGPU' : 'WebAssembly'}`
            : s.model === 'error' ? `The model did not load: ${s.error}` : 'The model loads when it is first needed';
        root.querySelector('.mng-count').textContent = `${s.count.toLocaleString('en-GB')} of ${s.indexable.toLocaleString('en-GB')}${left ? `, ${left.toLocaleString('en-GB')} in the queue` : ''}`;
        root.querySelector('.mng-bytes').textContent = `${mb(s.bytes)} in this browser`;
        const sig = s.model === 'error' ? 'error' : 'ok';
        if (sig !== actionsSig) {
          actionsSig = sig;
          root.querySelector('.mng-actions').innerHTML = `${sig === 'error' ? '<button type="button" class="btn" data-mng="retry">Try again</button>' : ''}
            <button type="button" class="btn btn-danger" data-mng="off">Turn off and delete vectors</button>`;
        }
      };
      const draw = () => {
        queued = false;
        if (!root.isConnected) return;
        const s = clip.status();
        if (s.on) drawOn(s); else drawOff();
      };
      const queue = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
      draw();
      root.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-mng]');
        if (!b) return;
        if (b.dataset.mng === 'on') { sw.click(); return; }
        if (b.disabled) return;
        b.disabled = true;
        try {
          if (b.dataset.mng === 'off') { await clip.disable(); ui.toast('Search by meaning is off and its vectors are deleted.', 'ok'); }
          else if (b.dataset.mng === 'retry') await clip.retry();
        } catch (err) { ui.toast(err?.message ?? String(err), 'error'); }
        b.disabled = false;
        queue();
      });
      const offClip = clip.onChange(queue);
      const offJobs = lib.jobs.onProgress((p) => { if (p.kind === 'clip') queue(); });
      return () => { offClip(); offJobs(); };
    },
  });

  function toggleFilters() {
    const show = filtersForm.hidden;
    filtersForm.hidden = !show;
    el.querySelector('[data-act="filters"]').setAttribute('aria-expanded', String(show));
    if (show) { fillFilterLists(); filtersForm.querySelector('input,select')?.focus(); }
  }

  function fillFilterLists() {
    const cams = new Set();
    for (const r of lib.records.values()) if (r.camera) cams.add(r.camera);
    const fill = (name, values) => {
      const s = filtersForm.elements[name];
      const keep = s.value;
      s.innerHTML = '<option value="">Any</option>' + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
      s.value = values.includes(keep) ? keep : '';
    };
    fill('camera', [...cams].sort());
    fill('tag', [...lib.tags().keys()].sort((a, b) => a.localeCompare(b)));
  }

  function readFilters() {
    const f = filtersForm.elements;
    const out = {};
    const date = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
    const from = date(f.from.value), to = date(f.to.value);
    if (from != null) out.from = from;
    if (to != null) out.to = to + 86400000; // the "to" day is included
    if (f.kind.value) out.kind = f.kind.value;
    if (f.camera.value) out.camera = f.camera.value;
    if (f.minRating.value) out.minRating = Number(f.minRating.value);
    if (f.flag.value) out.flag = f.flag.value;
    if (f.tag.value) out.tag = f.tag.value;
    if (f.fav.checked) out.fav = true;
    return out;
  }
  filtersForm.addEventListener('change', () => { filters = readFilters(); grid.scrollTop = 0; requery(); viewChanged(); });
  filtersForm.addEventListener('reset', () => setTimeout(() => { filters = {}; requery(); viewChanged(); }));
  filtersForm.addEventListener('submit', (e) => e.preventDefault());

  // ── zoom (row B3) ────────────────────────────────────────────────────────
  function setZoom(z) {
    const next = Math.max(0, Math.min(2, z));
    if (next === zoom) return;
    const keep = scrollAnchor();
    zoom = next;
    try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* storage blocked */ }
    relayout(keep);
  }

  let wheelAcc = 0;
  grid.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) > 60) { setZoom(zoom + (wheelAcc < 0 ? 1 : -1)); wheelAcc = 0; }
  }, { passive: false });
  // Safari trackpad pinch
  let gestureDone = false;
  grid.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureDone = false; });
  grid.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (gestureDone) return;
    if (e.scale > 1.2) { setZoom(zoom + 1); gestureDone = true; } else if (e.scale < 0.83) { setZoom(zoom - 1); gestureDone = true; }
  });

  // Touch pinch: two pointers moving apart or together.
  const touches = new Map();
  let pinchStart = 0, pinchDone = false;
  const dist = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };

  // ── pointer: click, Shift and Ctrl clicks, lasso, double-click ───────────
  let drag = null;
  const contentPoint = (e) => { const r = sizer.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  grid.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) { pinchStart = dist(); pinchDone = false; }
      return;
    }
    if (e.button !== 0 || e.target.closest('.lib-daysel') || e.offsetX > grid.clientWidth) return; // not on the scrollbar
    const p = contentPoint(e);
    drag = { start: p, base: e.shiftKey || e.ctrlKey || e.metaKey ? new Set(sel) : new Set(), lasso: false, id: e.pointerId, e };
  });
  grid.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && !pinchDone && pinchStart) {
        const ratio = dist() / pinchStart;
        if (ratio > 1.25) { setZoom(zoom + 1); pinchDone = true; } else if (ratio < 0.8) { setZoom(zoom - 1); pinchDone = true; }
      }
      return;
    }
    if (!drag) return;
    const p = contentPoint(e);
    if (!drag.lasso && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 6) return;
    if (!drag.lasso) { drag.lasso = true; grid.setPointerCapture(drag.id); lasso.hidden = false; }
    const gr = grid.getBoundingClientRect();
    if (e.clientY < gr.top + 30) grid.scrollTop -= 24;
    else if (e.clientY > gr.bottom - 30) grid.scrollTop += 24;
    const p2 = contentPoint(e);
    const rect = { x: drag.start.x, y: drag.start.y, w: p2.x - drag.start.x, h: p2.y - drag.start.y };
    Object.assign(lasso.style, {
      left: `${PAD + Math.min(rect.x, rect.x + rect.w)}px`, top: `${PAD + Math.min(rect.y, rect.y + rect.h)}px`,
      width: `${Math.abs(rect.w)}px`, height: `${Math.abs(rect.h)}px`,
    });
    const next = new Set(drag.base);
    for (const i of lassoIndices(layout, rect)) next.add(ids[i]);
    sel = next;
    repaintSelection();
    renderHead();
    selectionChanged();
  });
  const endTouch = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinchStart = 0; };
  grid.addEventListener('pointercancel', (e) => { endTouch(e); if (drag?.lasso) lasso.hidden = true; drag = null; });
  grid.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') { endTouch(e); if (!pinchDone) touchTap(e); return; }
    if (!drag) return;
    const d = drag; drag = null;
    if (d.lasso) { lasso.hidden = true; grid.releasePointerCapture?.(d.id); return; }
    const p = contentPoint(e);
    const i = hitTest(layout, p.x, p.y);
    if (i < 0) {
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && sel.size) setSelection(new Set());
      return;
    }
    const res = clickSelect(sel, ids, i, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey, anchor });
    anchor = res.anchor;
    setSelection(res.sel);
    setFocus(i, { keepSelection: true });
  });
  function touchTap(e) {
    const p = contentPoint(e);
    const i = hitTest(layout, p.x, p.y);
    if (i >= 0 && !touches.size) { setFocus(i); viewer.open(i); }
  }
  grid.addEventListener('dblclick', (e) => {
    const p = contentPoint(e);
    const i = hitTest(layout, p.x, p.y);
    if (i >= 0) viewer.open(i);
  });
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('.lib-daysel');
    if (!b) return;
    const row = layout.rows[Number(b.dataset.group)];
    setSelection(toggleGroup(sel, ids, row.start, row.count));
  });

  grid.addEventListener('scroll', () => { queueRender(); updateMonthLabel(); });
  new ResizeObserver(() => {
    if (!open || grid.clientWidth === lastWidth) { if (open) { renderScrubber(); queueRender(); } return; }
    relayout(scrollAnchor());
  }).observe(grid);

  // ── selection and focus ──────────────────────────────────────────────────
  function setSelection(next) {
    sel = next;
    repaintSelection();
    renderHead();
    selectionChanged();
  }
  function selectionChanged() { emit('library:selection', { ids: ui.selection() }); }
  function viewChanged() { emit('library:view', current()); }

  // Next or previous photo in the current view; in the viewer, the viewer moves.
  function moveFocusBy(delta) {
    if (viewer.isOpen()) { viewer.handleKey({ key: delta > 0 ? 'ArrowRight' : 'ArrowLeft' }); return ui.focused(); }
    const fi = focusId != null && indexOf.has(focusId) ? indexOf.get(focusId) : -1;
    const ni = Math.max(0, Math.min(ids.length - 1, fi + delta));
    // Culling: when the selection is just the focused photo, it moves with the focus,
    // so "apply and advance" acts on the next photo, as in Lightroom.
    const single = sel.size === 1 && sel.has(focusId);
    if (ni >= 0 && ni !== fi) { anchor = ni; setFocus(ni, { keepSelection: !single }); if (single) emit('library:selection', { ids: [...sel] }); }
    return ui.focused();
  }

  function setFocus(i, { keepSelection = true } = {}) {
    if (i < 0 || i >= ids.length) return;
    focusId = ids[i];
    if (!keepSelection) { sel = new Set([focusId]); anchor = i; }
    const r = itemRect(layout, i);
    const top = r.y + PAD, bottom = top + r.h;
    if (top < grid.scrollTop + 4) grid.scrollTop = top - 40;
    else if (bottom > grid.scrollTop + grid.clientHeight - 4) grid.scrollTop = bottom - grid.clientHeight + 8;
    render();
    grid.setAttribute('aria-activedescendant', `lib-t-${i}`);
    repaintSelection();
    renderHead();
    if (!viewer.isOpen() && document.activeElement !== grid && !el.contains(document.activeElement?.closest?.('input,select'))) grid.focus({ preventScroll: true });
  }

  // ── scrubber (row B2) ────────────────────────────────────────────────────
  function renderScrubber() {
    const show = months.length > 1 && layout.height > grid.clientHeight;
    scrub.hidden = !show;
    if (!show) return;
    const trackH = scrub.clientHeight;
    scrubMarks.innerHTML = scrubberMarks(months, layout.height, trackH).map(m => `<span class="lib-scrub-year" style="top:${m.pos}px">${m.year}</span>`).join('');
    scrub.setAttribute('aria-valuemin', '0');
    scrub.setAttribute('aria-valuemax', String(months.length - 1));
    updateScrubThumb();
  }
  function updateScrubThumb() {
    if (scrub.hidden) return;
    const max = Math.max(1, layout.height + PAD * 2 - grid.clientHeight);
    scrubThumb.style.top = `${Math.round((grid.scrollTop / max) * (scrub.clientHeight - 4))}px`;
    const m = monthAt(months, grid.scrollTop - PAD);
    if (m) {
      scrub.setAttribute('aria-valuenow', String(months.indexOf(m)));
      scrub.setAttribute('aria-valuetext', m.label);
    }
  }
  function updateMonthLabel() {
    const panel = cur.view === 'x' && !!extraViews.get(cur.xview)?.render;
    const m = panel || !list.length ? null : monthAt(months, grid.scrollTop - PAD);
    monthEl.textContent = m && layout.unit ? m.label : '';
    monthEl.hidden = !monthEl.textContent;
  }
  function jumpTo(m) { if (m) { grid.scrollTop = m.top; render(); updateMonthLabel(); } }
  let scrubbing = false;
  const scrubAt = (e) => {
    const r = scrub.getBoundingClientRect();
    const pos = e.clientY - r.top;
    const m = monthAtTrack(months, pos, layout.height, r.height);
    jumpTo(m);
    if (m) { scrubBubble.hidden = false; scrubBubble.textContent = m.label; scrubBubble.style.top = `${Math.max(0, Math.min(r.height - 24, pos - 12))}px`; }
  };
  scrub.addEventListener('pointerdown', (e) => { scrubbing = true; scrub.setPointerCapture(e.pointerId); scrubAt(e); });
  scrub.addEventListener('pointermove', (e) => {
    if (scrubbing) { scrubAt(e); return; }
    const r = scrub.getBoundingClientRect();
    const m = monthAtTrack(months, e.clientY - r.top, layout.height, r.height);
    if (m) { scrubBubble.hidden = false; scrubBubble.textContent = m.label; scrubBubble.style.top = `${Math.max(0, Math.min(r.height - 24, e.clientY - r.top - 12))}px`; }
  });
  scrub.addEventListener('pointerup', () => { scrubbing = false; });
  scrub.addEventListener('pointerleave', () => { if (!scrubbing) scrubBubble.hidden = true; });

  function scrubKey(e) {
    const m = monthAt(months, grid.scrollTop - PAD);
    let i = m ? months.indexOf(m) : 0;
    const year = months[i]?.year;
    switch (e.key) {
      case 'ArrowDown': i++; break;
      case 'ArrowUp': i--; break;
      case 'PageDown': while (i < months.length - 1 && months[i].year === year) i++; break;
      case 'PageUp': { let k = i - 1; while (k > 0 && months[k - 1].year === months[k].year) k--; i = k; break; }
      case 'Home': i = 0; break;
      case 'End': i = months.length - 1; break;
      default: return false;
    }
    jumpTo(months[Math.max(0, Math.min(months.length - 1, i))]);
    return true;
  }

  // ── keyboard ─────────────────────────────────────────────────────────────
  // One capture listener on window, so the editor's own shortcuts never see a
  // key meant for the library. Inputs, dialogs and the slideshow keep theirs.
  window.addEventListener('keydown', onKey, true);

  function onKey(e) {
    const t = e.target;
    const inInput = !!t?.closest?.('input, textarea, select, [contenteditable="true"]');
    const meta = e.ctrlKey || e.metaKey;
    if (document.querySelector('dialog[open]')) return;
    if (document.getElementById('app')?.classList.contains('slideshow-active')) return;
    const isL = meta && !e.shiftKey && !e.altKey && (e.key === 'l' || e.key === 'L');

    if (!open) {
      if (isL) { e.preventDefault(); e.stopImmediatePropagation(); runCommand(lib, 'library.open', {}, { ui }); return; }
      if (e.key === 'Escape' && !inInput && state.session.source === 'library'
        && !state.view.fullscreen && !state.selection.shape && !state.activeTool) {
        e.preventDefault(); e.stopImmediatePropagation(); showLibrary();
      }
      return;
    }

    if (isL) { e.preventDefault(); e.stopImmediatePropagation(); hideLibrary(); return; }
    if (inInput) {
      if (t === search) {
        if (e.key === 'Escape') { e.preventDefault(); if (search.value || ranked) clearRanked(); else grid.focus(); }
        else if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); grid.focus(); if (focusId == null && ids.length) setFocus(0); }
      }
      return; // the editor ignores keys typed in inputs; the input keeps them
    }
    e.stopImmediatePropagation();
    if ((e.key === 'Enter' || e.key === ' ') && t?.closest?.('button') && t !== grid) return; // let buttons activate

    if (viewer.isOpen()) {
      if (viewer.handleKey(e)) { e.preventDefault(); return; }
      if (e.key === ' ' && !meta) { e.preventDefault(); const id = viewer.id(); if (id) { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSelection(n); } return; }
      if (ui.hooks.onKey?.(e)) e.preventDefault();
      return;
    }

    if (t === scrub && scrubKey(e)) { e.preventDefault(); return; }
    if (handleGridKey(e)) { e.preventDefault(); return; }
    if (ui.hooks.onKey?.(e)) e.preventDefault();
  }

  function handleGridKey(e) {
    const meta = e.ctrlKey || e.metaKey;
    const fi = focusId != null && indexOf.has(focusId) ? indexOf.get(focusId) : -1;
    if (e.key === '/' && !meta) { search.focus(); search.select(); return true; }
    if (meta && (e.key === 'a' || e.key === 'A')) { setSelection(new Set(ids)); return true; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key) && !meta) {
      if (!ids.length) return true;
      const pageRows = Math.max(1, Math.floor(grid.clientHeight / (layout.tile + layout.gap)) - 1);
      const ni = fi < 0 ? 0 : moveIndex(layout, fi, e.key, ids.length, pageRows);
      if (e.shiftKey) {
        if (anchor < 0) anchor = Math.max(0, fi);
        setSelection(new Set(rangeIds(ids, anchor, ni)));
      } else anchor = ni;
      setFocus(ni);
      return true;
    }
    if (meta || e.altKey) return false;
    switch (e.key) {
      case 'Enter': if (fi >= 0) viewer.open(fi); return true;
      case ' ': if (fi >= 0) { const n = new Set(sel); n.has(focusId) ? n.delete(focusId) : n.add(focusId); anchor = fi; setSelection(n); } return true;
      case 'Escape': if (sel.size) setSelection(new Set()); return true;
      case 'e': case 'E': if (fi >= 0) openInEditor(focusId); return true;
      case '+': case '=': setZoom(zoom + 1); return true;
      case '-': setZoom(zoom - 1); return true;
      default: return false;
    }
  }

  grid.addEventListener('focus', () => {
    if (focusId == null && ids.length) {
      const { first } = visibleRows(layout, grid.scrollTop - PAD, grid.clientHeight, 0);
      const row = layout.rows.slice(first).find(r => r.type === 'tiles');
      if (row) { focusId = ids[row.start]; grid.setAttribute('aria-activedescendant', `lib-t-${row.start}`); repaintSelection(); }
    }
  });

  // ── job status line (row L5) ─────────────────────────────────────────────
  const KIND_NAMES = { scan: 'reading files', thumbs: 'thumbnails', meta: 'details', clip: 'meaning vectors' };
  let jobQueued = false;
  function renderJobs() {
    jobQueued = false;
    const s = lib.jobs.status();
    const active = s.total > 0 && s.done + s.failed < s.total;
    pauseBtn.hidden = !active && !s.paused;
    pauseBtn.textContent = s.paused ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-label', s.paused ? 'Resume background indexing' : 'Pause background indexing');
    if (active || s.paused) {
      const parts = Object.entries(s.kinds).filter(([, k]) => k.total > k.done + k.failed)
        .map(([k, v]) => `${KIND_NAMES[k] ?? k} ${(v.done + v.failed).toLocaleString('en-GB')} of ${v.total.toLocaleString('en-GB')}`);
      jobEl.textContent = `${s.paused ? 'Paused' : 'Indexing'}: ${parts.join(', ')}${s.failed ? ` (${s.failed} could not be read)` : ''}`;
    } else {
      const c = lib.counts();
      jobEl.textContent = `${c.photos.toLocaleString('en-GB')} photos, ${c.videos.toLocaleString('en-GB')} videos${c.missing ? `, ${c.missing} missing` : ''}${s.failed ? `. ${s.failed} files could not be read.` : ''}`;
    }
  }
  const queueJobs = () => { if (!jobQueued) { jobQueued = true; requestAnimationFrame(renderJobs); } };
  lib.jobs.onProgress(queueJobs);
  pauseBtn.addEventListener('click', () => { lib.jobs.status().paused ? lib.jobs.resume() : lib.jobs.pause(); queueJobs(); });

  // ── library events ───────────────────────────────────────────────────────
  let sideQueued = false;
  const queueSidebar = () => { if (!sideQueued) { sideQueued = true; setTimeout(() => { sideQueued = false; renderSidebar(); }, 300); } };

  lib.on('records', (ev) => {
    queueSidebar();
    queueJobs();
    // Scans add and reorder records; patches (thumbnails, durations) only change tiles.
    if (!ev?.ids || STRUCTURAL.has(ev.reason)) { scheduleRequery(); return; }
    if (open) { refreshTiles(new Set(ev.ids)); viewer.refresh(); }
  });
  lib.on('choices', () => { queueSidebar(); scheduleRequery(); });
  // Text read from photos (textindex.js): an active search may now match more.
  lib.on('text', () => { if (q) scheduleRequery(); });
  lib.on('albums', () => { queueSidebar(); if (cur.view === 'album' || q) scheduleRequery(); else if (open) renderHead(); });
  lib.on('roots', () => {
    if (cur.view === 'folder' && !lib.roots.has(cur.rootId)) cur = { view: 'timeline' };
    renderSidebar(); scheduleRequery(); queueJobs();
  });
  stacksBox.checked = stacking;
  stacksBox.addEventListener('change', () => {
    stacking = stacksBox.checked;
    try { localStorage.setItem(STACKS_KEY, stacking ? '1' : '0'); } catch { /* storage blocked */ }
    if (open) requery(); else dirty = true;
  });
  lib.on('error', (ev) => emit('error', { message: ev?.message ?? 'Library error' }));

  renderJobs();
  renderMeaningBtn();
  return ui;
}
