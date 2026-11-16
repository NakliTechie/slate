// The Duplicates view: exact copies first, then similar photos, each group as
// a row of thumbnails with the suggested keeper marked. "Keep the marked one,
// trash the rest" trashes one group; "Trash all suggested exact copies" does every
// exact group on the page. Similar groups hold different pictures, so each needs its
// own click. Both go through runCommand('photo.trash') and offer Undo.
// Photos the lock hides (lib.visible, locked.js) are never compared or shown.
//
// initDupes(lib, ui) registers the view. Exact copies take two passes on
// lib.jobs as kind 'dupes': a sampled fingerprint (first and last 1 MB plus the
// size) for files that share a size, then a chunked byte comparison of files
// whose fingerprints match, so no whole large video is read into memory.
// Similar-photo fingerprints (dHash) come from thumbs.js, and thumbs.rehash() fills
// them for photos thumbnailed before Slate took them.
// "Also use meaning (CLIP)" (row D4) adds a third pass over the vectors that
// Search by meaning keeps (lib.services.clip, clip.js): photos whose cosine is
// at or above the slider value, leaving out pairs the first two passes grouped.

import { runCommand, visible } from '../../library/commands.js';
import { esc } from '../../core/html.js';
import { exactGroups, fingerprintCandidates, splitByBytes, sampleFingerprint, sameBytes, nearGroupsAsync, clipGroupsAsync, sizeCollisions, dropCoveredNear, runOnJobs, DEFAULT_MAX_DISTANCE, MAX_DISTANCE_LIMIT, CLIP_DEFAULT_MIN, CLIP_MIN_LIMIT, CLIP_MAX_LIMIT } from '../../library/dupes.js';

const TRASH_CAP = 5000;        // photo.trash takes at most this many ids per call
const UNDO_TOAST_MS = 6000;
const PAGE = 40;               // groups drawn at a time
const RECOMPUTE_MS = 1200;
const THRESHOLD_KEY = 'slate.dupes.threshold';
const FP_PATCH_BATCH = 200;
const CLIP_ON_KEY = 'slate.dupes.clip';
const CLIP_MIN_KEY = 'slate.dupes.clipmin';

const n = (x) => x.toLocaleString('en-GB');
const plural = (c, one, many = one + 's') => `${n(c)} ${c === 1 ? one : many}`;
const chunks = (list, k) => { const out = []; for (let i = 0; i < list.length; i += k) out.push(list.slice(i, i + k)); return out; };
export function formatBytes(b) {
  if (!(b > 0)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b >= 10 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`;
}
const dateOf = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function initDupes(lib, ui) {
  let threshold = DEFAULT_MAX_DISTANCE;
  try { const t = Number(localStorage.getItem(THRESHOLD_KEY)); if (t >= 1 && t <= MAX_DISTANCE_LIMIT) threshold = t; } catch { /* storage blocked */ }
  let useClip = false, clipMin = CLIP_DEFAULT_MIN;
  try {
    useClip = localStorage.getItem(CLIP_ON_KEY) === '1';
    const m = Number(localStorage.getItem(CLIP_MIN_KEY)); if (m >= CLIP_MIN_LIMIT && m <= CLIP_MAX_LIMIT) clipMin = m;
  } catch { /* storage blocked */ }
  const clip = () => lib.services.clip ?? null;
  const clipReady = () => !!(clip()?.enabled() && clip().count());

  const fp = new Map();        // id -> sampled fingerprint found this session (also patched onto the record)
  const same = new Map();      // 'idA|idB|fingerprint' -> byte comparison result this session
  const keep = new Map();      // group key -> Set of ids marked to keep
  let exact = [], near = [], byMeaning = [];
  let computed = false, stale = true, busy = false, again = false;
  let status = '', unhashed = 0, lastCount = null;
  let shown = PAGE;
  let host = null, scrollTop = 0, recomputeTimer = null, observer = null;

  const opts = () => ({
    isTrashed: (r) => !!lib.choice(r.id).trashed,
    choiceOf: (id) => ({ fav: lib.choice(id).fav, rating: lib.rating(id) }),
  });
  // Records written before 2026-11-17 carry a whole-file `sha256`; it is a
  // different hash, so it is ignored and the fingerprint is made afresh.
  const fingerprintOf = (r) => fp.get(r.id) ?? r.fingerprint ?? null;
  const pairKey = (a, b) => `${a.id}|${b.id}|${fingerprintOf(a)}`;
  const sameOf = async (a, b, signal) => {
    const k = pairKey(a, b);
    if (!same.has(k)) same.set(k, await sameBytes(await lib.getFile(a.id), await lib.getFile(b.id), { signal }));
    return same.get(k);
  };
  const knownSame = (a, b) => same.get(pairKey(a, b)) ?? false;

  function say(message, level = 'info') { ui.toast?.(message, level); }

  // A toast with an Undo button that undoes every token, newest first (as organise.js does).
  function done(message, tokens) {
    tokens = tokens.filter(Boolean);
    if (!tokens.length || typeof document === 'undefined') { say(message, 'ok'); return; }
    const box = document.getElementById('toasts') || document.body;
    const el = document.createElement('div');
    el.className = 'toast ok org-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span>${esc(message)}</span><button type="button" class="btn org-undo">Undo</button>`;
    const timer = setTimeout(() => el.remove(), UNDO_TOAST_MS);
    el.querySelector('button').addEventListener('click', async () => {
      clearTimeout(timer);
      el.remove();
      try { for (const t of [...tokens].reverse()) await lib.undo(t); say('Undone', 'ok'); }
      catch (e) { say(e?.message ?? String(e), 'error'); }
    });
    box.appendChild(el);
  }

  // Progress of this run's 'dupes' jobs, from the queue's running count for the kind.
  function trackJobs(label, total) {
    const base = (() => { const c = lib.jobs.status().kinds.dupes; return c ? c.done + c.failed : 0; })();
    setStatus(`${label}: 0 of ${n(total)}`);
    return lib.jobs.onProgress((p) => {
      const c = p.kinds?.dupes; if (!c) return;
      setStatus(`${label}: ${n(Math.min(total, c.done + c.failed - base))} of ${n(total)}`);
    });
  }

  function setStatus(s) {
    status = s;
    const el = host?.querySelector('.dup-status-text');
    if (el) el.textContent = s;
  }

  async function compute() {
    if (busy) { again = true; return; }
    busy = true; stale = false;
    drawHeader();
    try {
      const o = opts();
      const all = [...lib.records.values()].filter(r => visible(lib, r.id));

      // 1. Fingerprints for photos thumbnailed before dHash existed.
      const noHash = all.filter(r => r.thumb === 'ok' && !r.dhash && !r.missing && !o.isTrashed(r));
      if (noHash.length && lib.services.thumbs?.rehash) {
        const off = trackJobs(`Making fingerprints for ${plural(noHash.length, 'photo')}`, noHash.length);
        try { await lib.services.thumbs.rehash(noHash); } finally { off(); }
      }

      // 2a. Sampled fingerprints, only for files whose size another file shares.
      const todo = sizeCollisions(all, o).filter(r => !fingerprintOf(r));
      if (todo.length) {
        const off = trackJobs(`Fingerprinting ${plural(todo.length, 'file')} that share a size`, todo.length);
        let patches = [];
        const flush = () => { const l = patches; patches = []; return l.length ? lib.patchRecords(l, 'dupes').catch(() => {}) : null; };
        try {
          await runOnJobs(lib.jobs, 'dupes', todo, async (rec, signal) => {
            const file = await lib.getFile(rec.id);
            if (signal.aborted) return;
            const h = await sampleFingerprint(file);
            fp.set(rec.id, h);
            patches.push({ id: rec.id, fingerprint: h });
            if (patches.length >= FP_PATCH_BATCH) flush();
          });
        } finally { off(); await flush(); }
      }
      // 2b. Byte comparison of files whose fingerprints match, one job per set.
      const candidates = [...(await fingerprintCandidates(all, fingerprintOf, o)).values()]
        .filter(list => list.slice(1).some(r => !same.has(pairKey(list[0], r))));
      if (candidates.length) {
        const off = trackJobs(`Comparing the bytes of ${plural(candidates.length, 'set')} of matching files`, candidates.length);
        try {
          await runOnJobs(lib.jobs, 'dupes', candidates, (list, signal) => splitByBytes(list, (a, b) => sameOf(a, b, signal)));
        } finally { off(); }
      }
      exact = await exactGroups(all, fingerprintOf, knownSame, o);

      // 3. Similar photos by fingerprint.
      const hashed = all.filter(r => r.dhash).length;
      setStatus(`Comparing fingerprints of ${plural(hashed, 'photo')}`);
      near = dropCoveredNear(await nearGroupsAsync(all, {
        ...o, maxDistance: threshold,
        onProgress: (p) => setStatus(`Comparing fingerprints: ${n(p.done)} of ${n(p.total)}`),
      }), exact);
      // 4. Similar by meaning, when asked for and the vectors exist.
      byMeaning = [];
      if (useClip && clipReady()) {
        setStatus('Comparing photos by meaning');
        byMeaning = await clipGroupsAsync(all, (id) => clip().vectorOf(id), {
          ...o, minCosine: clipMin, exclude: [...exact, ...near],
          onProgress: (p) => setStatus(`Comparing photos by meaning: ${n(Math.min(p.done, p.total))} of ${n(p.total)} steps`),
        });
      }
      unhashed = all.filter(r => r.kind === 'photo' && !r.dhash && !r.missing && r.thumb == null && !o.isTrashed(r)).length;

      const live = new Set(allGroups().map(g => g.key));
      for (const k of keep.keys()) if (!live.has(k)) keep.delete(k);
      computed = true;
      const groups = exact.length + near.length + byMeaning.length;
      setStatus(groups
        ? `Found ${plural(exact.length, 'group')} of exact copies and ${plural(near.length, 'group')} of similar photos${useClip && clipReady() ? `, and ${plural(byMeaning.length, 'group')} similar by meaning` : ''}.`
        : 'No duplicates found.');
    } catch (e) {
      setStatus(`Could not finish: ${e?.message ?? e}`);
    } finally {
      busy = false;
    }
    if (again) { again = false; return compute(); }
    // A new count redraws the sidebar through refreshView, which also remounts
    // the open panel; it would remount another view's panel too, so skip it then.
    const count = allGroups().length;
    const other = !isOpen() && ui.current?.().view === 'x';
    if (count !== lastCount && !other) { lastCount = count; ui.refreshView?.(); if (isOpen()) return; }
    draw();
  }

  const isOpen = () => !!host && host.isConnected;

  function scheduleRecompute() {
    stale = true;
    if (!isOpen()) return;
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => compute(), RECOMPUTE_MS);
  }
  lib.on('records', (e) => { if (e?.reason !== 'dupes') scheduleRecompute(); });
  lib.on('choices', () => scheduleRecompute());

  // ── drawing ──────────────────────────────────────────────────────────────
  const marked = (g) => {
    if (!keep.has(g.key)) keep.set(g.key, new Set([g.keeper]));
    return keep.get(g.key);
  };
  const allGroups = () => [...exact, ...near, ...byMeaning];
  const visibleGroups = () => allGroups().slice(0, shown);
  // "Trash all suggested" takes exact copies only.
  const exactShown = () => visibleGroups().filter(g => g.kind === 'exact');
  const suggestedTrash = (groups) => groups.flatMap(g => { const k = marked(g); return k.size ? g.ids.filter(id => !k.has(id)) : []; });

  function drawHeader() {
    const head = host?.querySelector('.dup-head');
    if (!head) return;
    const groups = visibleGroups();
    const count = suggestedTrash(groups.filter(g => g.kind === 'exact')).length;
    head.innerHTML = `
      <div class="dup-status" role="status" aria-live="polite">
        <span class="dup-status-text">${esc(status || 'Looking for duplicates')}</span>
        ${busy ? '<button type="button" class="btn dup-stop">Stop</button>' : ''}
      </div>
      <div class="dup-controls">
        <label class="dup-threshold">Similar photos: how close
          <input type="range" min="1" max="${MAX_DISTANCE_LIMIT}" step="1" value="${threshold}" aria-describedby="dup-thr-note">
          <span class="dup-thr-value">${threshold}</span>
        </label>
        <span id="dup-thr-note" class="dup-note">Lower finds only near copies; higher also finds bursts.</span>
        <label class="lib-check dup-clip"><input type="checkbox" class="dup-clip-on" ${useClip ? 'checked' : ''} ${clipReady() ? '' : 'disabled'}> Also use meaning (CLIP)</label>
        ${useClip && clipReady() ? `<label class="dup-clip-min">Meaning: how close
          <input type="range" min="${CLIP_MIN_LIMIT}" max="${CLIP_MAX_LIMIT}" step="0.01" value="${clipMin}">
          <span class="dup-clip-value">${clipMin.toFixed(2)}</span>
        </label>` : ''}
        <button type="button" class="btn btn-danger dup-trash-all" ${count && !busy ? '' : 'disabled'}>Trash all suggested exact copies (${n(count)})</button>
      </div>
      ${clipReady() ? '' : '<p class="dup-note">Turn on Search by meaning to also compare photos by what they show.</p>'}
      ${unhashed ? `<p class="dup-note">${plural(unhashed, 'photo')} have no thumbnail yet, so they are not compared for similarity.</p>` : ''}`;
  }

  function tileHtml(g, id) {
    const r = lib.get(id);
    if (!r || !visible(lib, id)) return '';
    const kept = marked(g).has(id);
    return `<label class="dup-tile${kept ? ' is-keep' : ''}" data-id="${esc(id)}">
      <span class="dup-thumb"><img alt="" data-id="${esc(id)}"></span>
      <span class="dup-meta">
        <span class="dup-name" title="${esc(r.path)}">${esc(r.name)}</span>
        <span>${esc(formatBytes(r.size))}${r.w ? ` · ${n(r.w)} × ${n(r.h)}` : ''}</span>
        <span>${esc(dateOf(r.time))}</span>
      </span>
      <span class="dup-keep"><input type="checkbox" ${kept ? 'checked' : ''} data-group="${esc(g.key)}" data-id="${esc(id)}"> Keep</span>
      ${id === g.keeper ? '<span class="dup-badge">Suggested keeper</span>' : ''}
    </label>`;
  }

  function groupHtml(g) {
    const k = marked(g);
    const title = g.kind === 'exact' ? `Exact copies, ${plural(g.ids.length, 'file')}`
      : g.kind === 'clip' ? `Similar by meaning, ${plural(g.ids.length, 'photo')}` : `Similar photos, ${plural(g.ids.length, 'photo')}`;
    return `<section class="dup-group" data-key="${esc(g.key)}">
      <header class="dup-ghead">
        <h3>${esc(title)}</h3>
        <button type="button" class="btn dup-trash-group" data-group="${esc(g.key)}" ${k.size && k.size < g.ids.length && !busy ? '' : 'disabled'}>Keep the marked one, trash the rest</button>
      </header>
      <div class="dup-tiles">${g.ids.map(id => tileHtml(g, id)).join('')}</div>
    </section>`;
  }

  function draw() {
    if (!isOpen()) return;
    drawHeader();
    const body = host.querySelector('.dup-body');
    const all = allGroups();
    const groups = all.slice(0, shown);
    if (!computed) { body.innerHTML = ''; return; }
    if (!all.length) { body.innerHTML = '<p class="dup-empty">No duplicates in the library.</p>'; return; }
    const exactShown = groups.filter(g => g.kind === 'exact'), nearShown = groups.filter(g => g.kind === 'near'), clipShown = groups.filter(g => g.kind === 'clip');
    body.innerHTML = `
      ${exactShown.length ? `<h2 class="dup-section">Exact copies (${n(exact.length)})</h2>${exactShown.map(groupHtml).join('')}` : ''}
      ${nearShown.length ? `<h2 class="dup-section">Similar photos (${n(near.length)})</h2>${nearShown.map(groupHtml).join('')}` : ''}
      ${clipShown.length ? `<h2 class="dup-section">Similar by meaning (${n(byMeaning.length)})</h2>${clipShown.map(groupHtml).join('')}` : ''}
      ${all.length > shown ? `<button type="button" class="btn dup-more">Show ${n(Math.min(PAGE, all.length - shown))} more of ${n(all.length - shown)}</button>` : ''}`;
    observeThumbs(body);
  }

  function observeThumbs(body) {
    observer?.disconnect();
    const load = (img) => {
      const p = lib.services.thumbs?.url(img.dataset.id);
      p?.then(u => { if (u && img.isConnected) img.src = u; }).catch(() => {});
    };
    const imgs = body.querySelectorAll('img[data-id]');
    if (typeof IntersectionObserver === 'undefined') { imgs.forEach(load); return; }
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); load(e.target); }
    }, { root: host.parentElement, rootMargin: '400px' });
    imgs.forEach(img => observer.observe(img));
  }

  // ── actions ──────────────────────────────────────────────────────────────
  async function trashIds(ids, what) {
    ids = ids.filter(id => visible(lib, id));
    if (!ids.length) return;
    try {
      const tokens = []; let changed = 0;
      for (const part of chunks(ids, TRASH_CAP)) {
        const r = await runCommand(lib, 'photo.trash', { ids: part }, { ui });
        changed += r.changed; tokens.push(r.undo);
      }
      done(`Moved ${plural(changed, 'photo')} ${what} to the trash`, tokens);
    } catch (e) { say(e?.message ?? String(e), 'error'); }
  }

  const groupByKey = (key) => allGroups().find(g => g.key === key);

  function onClick(e) {
    const t = e.target;
    if (t.closest('.dup-stop')) { lib.jobs.cancel('dupes'); return; }
    if (t.closest('.dup-more')) { shown += PAGE; draw(); return; }
    const gb = t.closest('.dup-trash-group');
    if (gb) {
      const g = groupByKey(gb.dataset.group); if (!g) return;
      const k = marked(g);
      if (!k.size) { say('Mark at least one photo to keep.', 'warn'); return; }
      trashIds(g.ids.filter(id => !k.has(id)), 'from the group');
      return;
    }
    if (t.closest('.dup-trash-all')) { trashIds(suggestedTrash(exactShown()), 'from exact-copy groups'); }
  }

  function onChange(e) {
    const t = e.target;
    if (t.matches('.dup-clip-on')) {
      useClip = t.checked;
      try { localStorage.setItem(CLIP_ON_KEY, useClip ? '1' : '0'); } catch { /* storage blocked */ }
      compute();
      return;
    }
    if (t.matches('input[type="checkbox"][data-group]')) {
      const g = groupByKey(t.dataset.group); if (!g) return;
      const k = marked(g);
      if (t.checked) k.add(t.dataset.id); else k.delete(t.dataset.id);
      t.closest('.dup-tile')?.classList.toggle('is-keep', t.checked);
      const btn = host.querySelector(`.dup-trash-group[data-group="${CSS.escape(g.key)}"]`);
      if (btn) btn.disabled = !(k.size && k.size < g.ids.length) || busy;
      drawHeader();
    }
  }

  let thrTimer = null;
  function onInput(e) {
    const t = e.target;
    if (t.matches('.dup-clip-min input')) {
      clipMin = Number(t.value);
      const v = host.querySelector('.dup-clip-value'); if (v) v.textContent = clipMin.toFixed(2);
      try { localStorage.setItem(CLIP_MIN_KEY, String(clipMin)); } catch { /* storage blocked */ }
      clearTimeout(thrTimer);
      thrTimer = setTimeout(() => compute(), 250);
      return;
    }
    if (!t.matches('.dup-threshold input')) return;
    threshold = Number(t.value);
    const v = host.querySelector('.dup-thr-value'); if (v) v.textContent = String(threshold);
    try { localStorage.setItem(THRESHOLD_KEY, String(threshold)); } catch { /* storage blocked */ }
    clearTimeout(thrTimer);
    thrTimer = setTimeout(() => compute(), 250);
  }

  ui.registerView({
    id: 'duplicates',
    label: 'Duplicates',
    count: () => (computed ? allGroups().length : null),
    countText: () => { if (!computed) return ''; const n = allGroups().length; return `${n.toLocaleString('en-GB')} group${n === 1 ? '' : 's'}`; },
    render(el) {
      el.innerHTML = '<div class="dup-root"><div class="dup-head"></div><div class="dup-body"></div></div>';
      host = el.querySelector('.dup-root');
      host.addEventListener('click', onClick);
      host.addEventListener('change', onChange);
      host.addEventListener('input', onInput);
      draw();
      el.scrollTop = scrollTop;
      if (stale && !busy) compute();
      return () => {
        scrollTop = el.scrollTop;
        observer?.disconnect(); observer = null;
        clearTimeout(recomputeTimer);
        host = null;
      };
    },
  });
}
