// Organising the library: the action bar for the selection (or the focused
// photo), the culling keys, the tag dialog, the album picker, the album menu
// the Trash view actions, and Export (copy the originals of the selection or an
// album into a folder, or into one .zip file), Read text for the selection (row X3, textindex.js) and
// the lock on hidden photos in the Hidden view (row O9, locked.js). Every action goes through runCommand(), so the
// buttons, the keys and the agent face share one path and one undo log.
//
// initOrganise(lib, ui) uses from the view: ui.actionsEl, ui.hooks, ui.selection(),
// ui.focused(), ui.current(), ui.toast(); and ui.focusNext() when the view has it.

import { runCommand, MAX_WRITE_IDS } from '../../library/commands.js';
import { emit, on } from '../../core/events.js';
import { esc } from '../../core/html.js';
import { exportFiles, pickExportFolder, albumExportIds, exportZip, pickZipSave, zipFileName, BLOB_WARN_BYTES } from '../../library/export.js';
import { ZIP_URL } from './import.js';
import { splitId, normPath } from '../../library/schema.js';
import { RENAME_FIELDS } from '../../library/move.js';

const TRASH_CAP = 5000;      // photo.trash takes at most this many ids per call
const UNDO_TOAST_MS = 6000;

const NAMES = { favourite: 'photo.favourite', rate: 'photo.rate', flag: 'photo.flag', tag: 'photo.tag', hide: 'photo.hide', album_add: 'album.add', album_remove: 'album.remove' };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

// Map a keydown to an organise action, or null. Pure, so the tests can run it.
//   { op: 'favourite'|'rate'|'flag'|'hide'|'tag'|'trash', rating?, flag?, advance }
export function keyAction(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? '') || t.isContentEditable)) return null;
  const advance = !!e.shiftKey;
  const digit = /^(?:Digit|Numpad)([0-5])$/.exec(e.code ?? '') ?? (/^[0-5]$/.test(e.key ?? '') ? [null, e.key] : null);
  if (digit) return { op: 'rate', rating: +digit[1], advance };
  switch ((e.key ?? '').toLowerCase()) {
    case 'f': return { op: 'favourite', advance };
    case 'p': return { op: 'flag', flag: 'pick', advance };
    case 'x': return { op: 'flag', flag: 'reject', advance };
    case 'u': return { op: 'flag', flag: 'none', advance };
    case 'h': return { op: 'hide', advance };
    case 't': return { op: 'tag', advance };
    case 'delete': return { op: 'trash', advance };
    default: return null;
  }
}

export function initOrganise(lib, ui) {
  ui.hooks ??= {};
  const run = (name, args) => runCommand(lib, name, args, { ui });
  const view = () => ui.current?.() ?? { view: 'timeline' };
  const targets = () => {
    const sel = ui.selection?.() ?? [];
    if (sel.length) return [...sel];
    const f = ui.focused?.();
    return f ? [f] : [];
  };

  // ── toasts ─────────────────────────────────────────────────────────────
  function say(message, level = 'info') {
    if (ui.toast) ui.toast(message, level); else emit('toast', { message, level });
  }
  function fail(e) { say(e?.message ?? String(e), 'error'); }

  // A toast with an Undo button that undoes every token, newest first.
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
      catch (e) { fail(e); }
    });
    box.appendChild(el);
  }

  // ── writes ─────────────────────────────────────────────────────────────
  // One choice or album write; more than 200 ids go through photo.bulk.
  async function write(op, ids, extra = {}) {
    if (ids.length > MAX_WRITE_IDS) return run('photo.bulk', { op, ids, ...extra });
    return run(NAMES[op], { ids, ...extra });
  }

  async function act(a, ids) {
    if (!ids.length) { say('Select a photo first', 'warn'); return false; }
    const n = plural(ids.length, 'photo');
    try {
      switch (a.op) {
        case 'favourite': {
          const value = !ids.every(id => lib.choice(id).fav);
          const r = await write('favourite', ids, { value });
          done(value ? `Favourited ${n}` : `Removed ${n} from favourites`, [r.undo]);
          break;
        }
        case 'rate': {
          const r = await write('rate', ids, { rating: a.rating });
          done(a.rating ? `Rated ${n} ${plural(a.rating, 'star')}` : `Cleared the rating of ${n}`, [r.undo]);
          break;
        }
        case 'flag': {
          const r = await write('flag', ids, { flag: a.flag });
          done(a.flag === 'pick' ? `Picked ${n}` : a.flag === 'reject' ? `Rejected ${n}` : `Cleared the flag of ${n}`, [r.undo]);
          break;
        }
        case 'hide': {
          const value = !ids.every(id => lib.choice(id).hidden);
          const r = await write('hide', ids, { value });
          done(value ? `Hid ${n}` : `Unhid ${n}`, [r.undo]);
          break;
        }
        case 'trash': {
          const tokens = []; let changed = 0;
          for (const part of chunks(ids, TRASH_CAP)) { const r = await run('photo.trash', { ids: part }); changed += r.changed; tokens.push(r.undo); }
          done(`Moved ${plural(changed, 'photo')} to the trash`, tokens);
          break;
        }
        case 'tag': tagDialog(ids, a.advance); return false; // the dialog advances on apply
        default: return false;
      }
    } catch (e) { fail(e); return false; }
    return true;
  }

  function focusNext(evt) {
    if (ui.focusNext) { ui.focusNext(); return; }
    evt?.target?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
  }

  // ── culling keys ───────────────────────────────────────────────────────
  ui.hooks.onKey = (e) => {
    const a = keyAction(e);
    if (!a || view().view === 'trash') return false;
    e.preventDefault?.();
    act(a, targets()).then(ok => { if (ok && a.advance) focusNext(e); });
    return true;
  };

  // ── dialogs ────────────────────────────────────────────────────────────
  let seq = 0;
  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function openDialog(title, build) {
    const prev = document.activeElement;
    const dlg = document.createElement('dialog');
    const hid = `org-dlg-${++seq}`;
    dlg.className = 'org-dialog';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', hid);
    dlg.innerHTML = `<div class="modal-header"><h2 id="${hid}">${esc(title)}</h2></div><div class="org-body"></div>`;
    document.body.appendChild(dlg);
    const close = () => { if (dlg.open) dlg.close(); };
    dlg.addEventListener('close', () => { dlg.remove(); prev?.focus?.(); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    dlg.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keys typed here never reach the grid
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = [...dlg.querySelectorAll(FOCUSABLE)];
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    build(dlg.querySelector('.org-body'), close);
    dlg.showModal();
    (dlg.querySelector('[autofocus]') || dlg.querySelector(FOCUSABLE))?.focus();
    return close;
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      let ok = false;
      openDialog(title, (body, close) => {
        body.innerHTML = `<p class="org-text">${esc(text)}</p>
          <div class="modal-footer"><button type="button" class="btn" data-no autofocus>Cancel</button>
          <button type="button" class="btn btn-danger" data-yes>${esc(okLabel)}</button></div>`;
        body.querySelector('[data-no]').addEventListener('click', close);
        body.querySelector('[data-yes]').addEventListener('click', () => { ok = true; close(); });
        body.closest('dialog').addEventListener('close', () => resolve(ok));
      });
    });
  }

  function promptDialog(title, label, value, okLabel) {
    return new Promise((resolve) => {
      let out = null;
      openDialog(title, (body, close) => {
        body.innerHTML = `<form class="org-form"><label class="org-label">${esc(label)}
          <input type="text" class="org-input" value="${esc(value)}" maxlength="200" autofocus></label>
          <div class="modal-footer"><button type="button" class="btn" data-no>Cancel</button>
          <button type="submit" class="btn btn-primary">${esc(okLabel)}</button></div></form>`;
        const inp = body.querySelector('input');
        body.querySelector('[data-no]').addEventListener('click', close);
        body.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); if (inp.value.trim()) { out = inp.value.trim(); close(); } });
        body.closest('dialog').addEventListener('close', () => resolve(out));
        setTimeout(() => inp.select(), 0);
      });
    });
  }

  // Tags: the photos' own tags with a remove button each, an input with
  // suggestions from every tag in the library, and Apply as one undoable change.
  function tagDialog(ids, advance = false) {
    if (!ids.length) { say('Select a photo first', 'warn'); return; }
    const own = new Map(); // tag -> how many of the photos carry it
    for (const id of ids) for (const t of lib.choice(id).tags ?? []) own.set(t, (own.get(t) ?? 0) + 1);
    const fromFile = [...new Set(ids.flatMap(id => lib.tagsOf(id)))].filter(t => ![...own.keys()].some(o => o.toLowerCase() === t.toLowerCase()));
    const all = [...lib.tags()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const add = [], remove = new Set();
    const lower = (t) => t.toLowerCase();

    openDialog(`Tags for ${plural(ids.length, 'photo')}`, (body, close) => {
      const listId = `org-tags-${seq}`;
      body.innerHTML = `
        <div class="org-chips" aria-label="Tags" role="list"></div>
        ${fromFile.length ? `<p class="modal-info">From the photo files: ${esc(fromFile.join(', '))}</p>` : ''}
        <form class="org-row">
          <label class="visually-hidden" for="${listId}-in">New tag</label>
          <input id="${listId}-in" class="org-input" list="${listId}" placeholder="Add a tag, e.g. trips/goa" autocomplete="off" autofocus>
          <datalist id="${listId}">${all.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
          <button type="submit" class="btn">Add</button>
        </form>
        <div class="org-suggest" aria-label="Suggested tags"></div>
        <div class="modal-footer"><button type="button" class="btn" data-no>Cancel</button>
        <button type="button" class="btn btn-primary" data-apply>Apply</button></div>`;
      const chips = body.querySelector('.org-chips'), sugg = body.querySelector('.org-suggest'), inp = body.querySelector('input');

      const current = () => [...[...own.keys()].filter(t => !remove.has(t)), ...add];
      function render() {
        const cur = current();
        chips.innerHTML = cur.length
          ? cur.map(t => `<span class="org-chip" role="listitem">${esc(t)}${own.has(t) && own.get(t) < ids.length ? ` <small>${own.get(t)}/${ids.length}</small>` : ''}<button type="button" class="org-chip-x" data-rm="${esc(t)}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('')
          : '<span class="modal-info">No tags yet</span>';
        const have = new Set(cur.map(lower));
        const s = all.filter(t => !have.has(lower(t))).slice(0, 12);
        sugg.innerHTML = s.map(t => `<button type="button" class="org-chip org-chip-add" data-add="${esc(t)}" aria-label="Add tag ${esc(t)}">+ ${esc(t)}</button>`).join('');
      }
      function addTag(t) {
        t = t.trim();
        if (!t || current().some(x => lower(x) === lower(t))) return;
        const removed = [...remove].find(x => lower(x) === lower(t));
        if (removed) remove.delete(removed); else add.push(t);
        render();
      }
      chips.addEventListener('click', (e) => {
        const t = e.target.closest('[data-rm]')?.dataset.rm;
        if (t == null) return;
        const i = add.indexOf(t);
        if (i >= 0) add.splice(i, 1); else remove.add(t);
        render();
        inp.focus();
      });
      sugg.addEventListener('click', (e) => { const t = e.target.closest('[data-add]')?.dataset.add; if (t != null) { addTag(t); inp.focus(); } });
      body.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        if (inp.value.trim()) { addTag(inp.value); inp.value = ''; } else apply();
      });
      body.querySelector('[data-no]').addEventListener('click', close);
      body.querySelector('[data-apply]').addEventListener('click', apply);
      async function apply() {
        if (inp.value.trim()) { addTag(inp.value); inp.value = ''; }
        close();
        if (!add.length && !remove.size) return;
        try {
          const r = await write('tag', ids, { add: [...add], remove: [...remove] });
          done(`Updated the tags of ${plural(ids.length, 'photo')}`, [r.undo]);
          if (advance) focusNext({ target: document.activeElement });
        } catch (e) { fail(e); }
      }
      render();
    });
  }

  // Album picker: the existing albums, plus New album.
  function albumPicker(ids) {
    if (!ids.length) { say('Select a photo first', 'warn'); return; }
    const albums = [...lib.albums.values()].sort((a, b) => a.name.localeCompare(b.name));
    openDialog(`Add ${plural(ids.length, 'photo')} to an album`, (body, close) => {
      body.innerHTML = `
        ${albums.length ? `<ul class="org-albums" aria-label="Albums">${albums.map(al => `<li><button type="button" class="btn org-album" data-album="${esc(al.id)}">${esc(al.name)} <small>${al.items.size}</small></button></li>`).join('')}</ul>` : '<p class="modal-info">No albums yet.</p>'}
        <form class="org-row">
          <label class="visually-hidden" for="org-new-album">New album name</label>
          <input id="org-new-album" class="org-input" placeholder="New album name" maxlength="200" ${albums.length ? '' : 'autofocus'}>
          <button type="submit" class="btn btn-primary">New album</button>
        </form>
        <div class="modal-footer"><button type="button" class="btn" data-no>Cancel</button></div>`;
      body.querySelector('[data-no]').addEventListener('click', close);
      body.querySelector('.org-albums')?.addEventListener('click', async (e) => {
        const albumId = e.target.closest('[data-album]')?.dataset.album;
        if (!albumId) return;
        close();
        try {
          const r = await write('album_add', ids, { album: albumId });
          done(`Added ${plural(r.changed, 'photo')} to ${lib.albums.get(albumId)?.name ?? 'the album'}`, [r.undo]);
        } catch (err) { fail(err); }
      });
      body.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = body.querySelector('input').value.trim();
        if (!name) return;
        close();
        try {
          const small = ids.length <= MAX_WRITE_IDS;
          const c = await run('album.create', small ? { name, ids } : { name });
          const tokens = [c.undo];
          if (!small) tokens.push((await write('album_add', ids, { album: c.albumId })).undo);
          done(`Made the album ${name} with ${plural(ids.length, 'photo')}`, tokens);
        } catch (err) { fail(err); }
      });
    });
  }

  // ── move and rename (O10) ──────────────────────────────────────────────
  // Both are destructive (files change place on disk), so each dialog runs a
  // dry run first, states the count and any conflicts, and only then enables
  // the button that moves the files. The toast after offers Undo.
  function oneRoot(ids) {
    if (!ids.length) { say('Select a photo first', 'warn'); return null; }
    const roots = new Set(ids.map(id => splitId(id).rootId));
    if (roots.size > 1) { say('Select photos from one library folder to move or rename them', 'warn'); return null; }
    const root = lib.roots.get([...roots][0]);
    if (!root?.handle) { say('This folder is browse-only, so Slate cannot move its files', 'warn'); return null; }
    return root;
  }

  // Wires the Check and Run buttons of a move or rename dialog.
  //   plan() -> [{ id, toPath }] (may throw); verb: 'Move' | 'Rename'
  function reviewStep(body, close, plan, verb, doneText) {
    const out = body.querySelector('.org-review'), check = body.querySelector('[data-check]'), go = body.querySelector('[data-go]');
    let moves = null;
    const reset = () => { moves = null; go.disabled = true; go.textContent = verb; out.textContent = ''; };
    body.addEventListener('input', reset);
    body.addEventListener('change', reset);
    check.addEventListener('click', async () => {
      reset();
      try {
        const p = plan();
        const r = await lib.moveFiles(p, { dryRun: true });
        const same = p.length - r.changed - r.conflicts.length;
        const lines = [`${verb === 'Move' ? 'Moves' : 'Renames'} ${plural(r.changed, 'file')}, with their XMP sidecars.`];
        if (same > 0) lines.push(`${plural(same, 'file')} already ${same === 1 ? 'has' : 'have'} that ${verb === 'Move' ? 'place' : 'name'}.`);
        if (r.conflicts.length) {
          lines.push(`${plural(r.conflicts.length, 'file')} cannot be ${verb === 'Move' ? 'moved' : 'renamed'}, so nothing will change until you fix ${r.conflicts.length === 1 ? 'it' : 'them'}:`);
          for (const c of r.conflicts.slice(0, 5)) lines.push(`${lib.get(c.id)?.name ?? c.id} to ${c.to || '(empty)'}: ${c.reason}`);
          if (r.conflicts.length > 5) lines.push(`and ${r.conflicts.length - 5} more`);
        }
        out.innerHTML = lines.map(l => `<p>${esc(l)}</p>`).join('');
        if (r.changed && !r.conflicts.length) { moves = p; go.disabled = false; go.textContent = `${verb} ${plural(r.changed, 'file')}`; go.focus(); }
      } catch (e) { out.innerHTML = `<p class="org-error">${esc(e.message)}</p>`; }
    });
    go.addEventListener('click', async () => {
      if (!moves) return;
      close();
      try {
        const r = await lib.moveFiles(moves);
        const msg = doneText(r.changed);
        if (r.failed.length) say(`${msg}; ${plural(r.failed.length, 'file')} could not be moved: ${r.failed[0].reason}`, 'warn');
        done(msg, [r.undo]);
      } catch (e) { fail(e); }
    });
  }

  const reviewHtml = (verb) => `<div class="org-review" role="status" aria-live="polite"></div>
    <div class="modal-footer"><button type="button" class="btn" data-no>Cancel</button>
    <button type="button" class="btn" data-check>Check</button>
    <button type="button" class="btn btn-danger" data-go disabled>${verb}</button></div>`;

  function moveDialog(ids) {
    const root = oneRoot(ids);
    if (!root) return;
    const folders = [...(lib.folders().get(root.id)?.keys() ?? [])].sort((a, b) => a.localeCompare(b));
    if (!folders.includes('')) folders.unshift('');
    openDialog(`Move ${plural(ids.length, 'photo')} to a folder`, (body, close) => {
      body.innerHTML = `
        <p class="org-text">Choose a folder inside ${esc(root.name)}. The files move on disk, with their XMP sidecars, and keep their names, choices and albums.</p>
        <label class="org-label">Folder
          <select class="org-input org-folder" autofocus>${folders.map(f => `<option value="${esc(f)}">${esc(f || `Top of ${root.name}`)}</option>`).join('')}</select></label>
        <label class="org-label">Or a new subfolder path
          <input type="text" class="org-input org-newfolder" placeholder="e.g. 2024/Goa" maxlength="400" autocomplete="off"></label>
        ${reviewHtml('Move')}`;
      body.querySelector('[data-no]').addEventListener('click', close);
      const target = () => {
        const typed = body.querySelector('.org-newfolder').value.trim();
        return normPath(typed || body.querySelector('.org-folder').value).replace(/\/+$/, '');
      };
      reviewStep(body, close, () => {
        const dest = target();
        return ids.map(id => { const r = lib.get(id); return { id, toPath: dest ? `${dest}/${r.name}` : r.name }; });
      }, 'Move', (n) => `Moved ${plural(n, 'photo')} to ${target() || `the top of ${root.name}`}`);
    });
  }

  function renameDialog(ids) {
    if (!oneRoot(ids)) return;
    openDialog(`Rename ${plural(ids.length, 'photo')}`, (body, close) => {
      body.innerHTML = `
        <label class="org-label">Name template
          <input type="text" class="org-input org-template" value="{date}_{n}" maxlength="200" autocomplete="off" autofocus></label>
        <p class="modal-info">Fields: ${RENAME_FIELDS.map(f => `{${f}}`).join(' ')}. {n} counts in capture order. The extension stays the same, and photos stay in their folders.</p>
        <ul class="org-preview" aria-label="New names of the first 5 photos"></ul>
        ${reviewHtml('Rename')}`;
      body.querySelector('[data-no]').addEventListener('click', close);
      const tpl = body.querySelector('.org-template'), prev = body.querySelector('.org-preview');
      const plan = () => lib.renamePlan(ids, tpl.value);
      function preview() {
        try {
          prev.innerHTML = plan().slice(0, 5).map(m => {
            const to = m.toPath.slice(m.toPath.lastIndexOf('/') + 1);
            return `<li><span class="org-old">${esc(lib.get(m.id).name)}</span> to <span class="org-new">${esc(to)}</span></li>`;
          }).join('');
        } catch (e) { prev.innerHTML = `<li class="org-error">${esc(e.message)}</li>`; }
      }
      tpl.addEventListener('input', preview);
      preview();
      reviewStep(body, close, plan, 'Rename', (n) => `Renamed ${plural(n, 'photo')}`);
      setTimeout(() => tpl.select(), 0);
    });
  }

  // ── menus ──────────────────────────────────────────────────────────────
  let menuEl = null;
  function closeMenu(refocus) {
    if (!menuEl) return;
    const { el, prev, outside } = menuEl;
    menuEl = null;
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) prev?.focus?.();
  }
  function openMenu(anchor, label, items) {
    closeMenu();
    const prev = document.activeElement;
    const el = document.createElement('div');
    el.className = 'org-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', label);
    el.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" tabindex="-1" class="org-menu-item${it.danger ? ' org-danger' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('');
    document.body.appendChild(el);
    const r = anchor?.getBoundingClientRect?.() ?? { left: 0, bottom: 0 };
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(4, Math.min(r.left, innerWidth - w - 4))}px`;
    el.style.top = `${r.bottom + h + 4 > innerHeight ? Math.max(4, r.top - h - 4) : r.bottom + 4}px`;
    const btns = [...el.querySelectorAll('[role="menuitem"]')];
    const outside = (e) => { if (!el.contains(e.target) && e.target !== anchor) closeMenu(false); };
    document.addEventListener('pointerdown', outside, true);
    menuEl = { el, prev, outside };
    el.addEventListener('click', (e) => {
      const i = e.target.closest('[data-i]')?.dataset.i;
      if (i == null) return;
      closeMenu(true);
      items[+i].run();
    });
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const at = btns.indexOf(document.activeElement);
      const go = (j) => { e.preventDefault(); btns[(j + btns.length) % btns.length].focus(); };
      if (e.key === 'ArrowDown') go(at + 1);
      else if (e.key === 'ArrowUp') go(at - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(btns.length - 1);
      else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
      else if (e.key === 'Tab') closeMenu(false);
    });
    btns[0]?.focus();
  }

  ui.hooks.albumMenu = (albumId, anchorEl) => {
    const al = lib.albums.get(albumId);
    if (!al) return;
    openMenu(anchorEl, `Album ${al.name}`, [
      { label: 'Rename', run: async () => {
        const name = await promptDialog('Rename album', 'Album name', al.name, 'Rename');
        if (!name || name === al.name) return;
        try { const r = await run('album.rename', { album: albumId, name }); done(`Renamed the album to ${name}`, [r.undo]); } catch (e) { fail(e); }
      } },
      { label: 'Set cover from the focused photo', run: async () => {
        const id = ui.focused?.();
        if (!id) { say('Focus a photo in this album first', 'warn'); return; }
        try { const r = await run('album.cover', { album: albumId, id }); done(`Set the cover of ${al.name}`, [r.undo]); } catch (e) { fail(e); }
      } },
      { label: 'Export…', run: () => exportTo(() => albumExportIds(lib, albumId), ` from ${al.name}`, al.name) },
      { label: 'Delete album', danger: true, run: async () => {
        try { const r = await run('album.delete', { album: albumId }); done(`Deleted the album ${al.name}; its photos stay in the library`, [r.undo]); } catch (e) { fail(e); }
      } },
    ]);
  };

  // ── export ─────────────────────────────────────────────────────────────
  // The dialog asks for a folder of originals or one .zip file. The folder or save
  // picker then opens first inside the Export click, as the browser requires.
  let zipPromise = null;
  const loadZip = () => (zipPromise ??= import(ZIP_URL)
    .then((z) => { z.configure?.({ useWebWorkers: false }); return z; })
    .catch((e) => { zipPromise = null; throw new Error(`Could not load zip.js from esm.sh: ${e.message}`); }));

  function exportTo(getIds, what, label) {
    let ids;
    try { ids = getIds(); } catch (e) { fail(e); return; }
    if (!ids.length) { say('There is nothing to export', 'warn'); return; }
    const bytes = ids.reduce((n, id) => n + (lib.get(id)?.size || 0), 0);
    const inMemory = typeof window.showSaveFilePicker !== 'function' && bytes > BLOB_WARN_BYTES;
    openDialog(`Export ${plural(ids.length, 'file')}`, (body, close) => {
      body.innerHTML = `<p class="org-text">Slate copies the original files byte for byte. Nothing is re-encoded.</p>
        <fieldset class="org-choice"><legend class="org-label">Export as</legend>
          <label class="org-radio"><input type="radio" name="org-export" value="folder" checked autofocus> Folder of originals</label>
          <label class="org-radio"><input type="radio" name="org-export" value="zip"> One .zip file</label>
        </fieldset>
        ${inMemory ? `<p class="modal-info org-warn" style="display:none">This browser cannot write the zip to disk as it goes, so it holds all ${(bytes / 1024 ** 3).toFixed(1)} GB in memory before the download. Use Chrome or Edge, or export a folder.</p>` : ''}
        <div class="modal-footer"><button type="button" class="btn" data-no>Cancel</button>
        <button type="button" class="btn btn-primary" data-go>Export</button></div>`;
      const mode = () => body.querySelector('input[name="org-export"]:checked').value;
      const warn = body.querySelector('.org-warn');
      body.querySelector('.org-choice').addEventListener('change', () => { if (warn) warn.style.display = mode() === 'zip' ? '' : 'none'; });
      body.querySelector('[data-no]').addEventListener('click', close);
      body.querySelector('[data-go]').addEventListener('click', () => {
        const m = mode();
        close();
        if (m === 'zip') exportToZip(ids, what, label); else exportToFolder(ids, what);
      });
    });
  }

  async function exportToFolder(ids, what) {
    let dest;
    try { dest = await pickExportFolder(); } catch (e) { fail(e); return; }
    if (!dest) return;
    try {
      say(`Exporting ${plural(ids.length, 'file')} to ${dest.name}`);
      const r = await exportFiles(lib, ids, dest);
      const msg = `Exported ${plural(r.copied, 'file')}${what} to ${dest.name}`;
      say(r.failed ? `${msg}; ${r.failed} could not be copied` : msg, r.failed ? 'warn' : 'ok');
    } catch (e) { fail(e); }
  }

  async function exportToZip(ids, what, label) {
    const fileName = zipFileName(label);
    let writer;
    try { writer = await pickZipSave(fileName); } catch (e) { fail(e); return; }
    if (writer === null) return;
    const download = writer === undefined; // no save picker: build the zip in memory, then download it
    try {
      const zipLib = await loadZip();
      if (download) writer = new zipLib.BlobWriter('application/zip');
      say(`Exporting ${plural(ids.length, 'file')} to ${fileName}`);
      const r = await exportZip(lib, ids, { zipLib, writer });
      if (download) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(r.result);
        a.download = fileName;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      }
      let msg = `Exported ${plural(r.copied, 'file')}${what} to ${fileName}`;
      if (r.cancelled) msg = `Export cancelled; ${fileName} holds ${plural(r.copied, 'file')}`;
      say(r.failed ? `${msg}; ${r.failed} could not be read` : msg, r.failed || r.cancelled ? 'warn' : 'ok');
    } catch (e) {
      if (!download) await writer.abort?.().catch(() => {});
      fail(e);
    }
  }

  // ── trash view ─────────────────────────────────────────────────────────
  async function restore(ids) {
    if (!ids.length) { say('Select a photo in the trash first', 'warn'); return; }
    let changed = 0;
    try { for (const part of chunks(ids, MAX_WRITE_IDS)) changed += (await run('photo.restore', { ids: part })).changed; }
    catch (e) { fail(e); }
    if (changed) say(`Restored ${plural(changed, 'photo')}`, 'ok');
  }

  async function emptyTrash() {
    const n = lib.counts().trashed;
    if (!n) { say('The trash is empty'); return; }
    const files = plural(n, 'file');
    const ok = await confirmDialog('Empty trash', `Permanently delete ${files} in the trash? This cannot be undone.`, `Delete ${files}`);
    if (!ok) return;
    try { const r = await run('trash.empty', {}); say(`Deleted ${plural(r.changed, 'file')} permanently`, 'ok'); }
    catch (e) { fail(e); }
  }

  // ── read text (X3) ─────────────────────────────────────────────────────
  function readText(ids) {
    const ti = lib.services.textIndex;
    if (!ti) return;
    if (!ids.length) { say('Select a photo first', 'warn'); return; }
    const n = ti.runFor(ids);
    say(n ? `Reading the text in ${plural(n, 'photo')}. Search finds it when it is done.` : 'Slate has already read the text in these photos', n ? 'info' : 'ok');
  }

  // ── lock on hidden photos (O9) ─────────────────────────────────────────
  const NOT_ENCRYPTED = 'This hides photos from casual viewers of this browser. It does not encrypt the files on disk: anyone who opens the folder sees every photo.';

  function passDialog(title, intro, fields, okLabel, submit) {
    openDialog(title, (body, close) => {
      body.innerHTML = `${intro.map(t => `<p class="org-text">${esc(t)}</p>`).join('')}
        <form class="org-form">
          ${fields.map((f, i) => `<label class="org-label">${esc(f.label)}<input type="password" class="org-input" autocomplete="${f.auto}" data-pass="${i}"${i ? '' : ' autofocus'}></label>`).join('')}
          <p class="org-error" role="alert" hidden></p>
          <div class="modal-footer"><button type="button" class="btn" data-no>Cancel</button>
          <button type="submit" class="btn btn-primary">${esc(okLabel)}</button></div></form>`;
      const err = body.querySelector('.org-error'), go = body.querySelector('[type="submit"]');
      body.querySelector('[data-no]').addEventListener('click', close);
      body.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = [...body.querySelectorAll('[data-pass]')].map(x => x.value);
        go.disabled = true; err.hidden = true;
        try {
          const problem = await submit(values);
          if (!problem) { close(); return; }
          err.textContent = problem;
        } catch (x) { err.textContent = x?.message ?? String(x); }
        err.hidden = false; go.disabled = false;
        body.querySelector('[data-pass="0"]').select();
      });
    });
  }

  function setLock() {
    const lk = lib.services.lock;
    passDialog('Lock hidden photos', ['From now on the Hidden view shows nothing until you enter this passphrase, once each session.', NOT_ENCRYPTED, 'Slate cannot recover a forgotten passphrase. Reset lock then removes the lock and leaves the photos hidden but viewable.'],
      [{ label: 'Passphrase', auto: 'new-password' }, { label: 'Passphrase again', auto: 'new-password' }], 'Lock',
      async ([a, b]) => {
        if (a !== b) return 'The two passphrases differ.';
        await lk.set(a);
        say('Hidden photos are locked', 'ok');
        return null;
      });
  }

  function unlock() {
    const lk = lib.services.lock;
    passDialog('Unlock hidden photos', ['Enter the passphrase to show the hidden photos until you close Slate or lock them again.'],
      [{ label: 'Passphrase', auto: 'current-password' }], 'Unlock',
      async ([a]) => (await lk.unlock(a)) ? null : 'That passphrase is not right.');
  }

  async function resetLock() {
    const ok = await confirmDialog('Reset lock', 'Remove the passphrase? Hidden photos become viewable in the Hidden view to anyone who uses this browser. They stay hidden from the other views, and nothing is deleted.', 'Remove lock');
    if (!ok) return;
    try { await lib.services.lock.reset(); say('The lock is removed. Hidden photos are viewable in the Hidden view.', 'ok'); } catch (e) { fail(e); }
  }

  // ── action bar ─────────────────────────────────────────────────────────
  if (!ui.actionsEl || typeof document === 'undefined') return;
  const bar = document.createElement('div');
  bar.className = 'org-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Photo actions');
  ui.actionsEl.appendChild(bar);

  let sig = '';
  function render() {
    const v = view(), ids = targets(), n = ids.length;
    const allFav = n > 0 && ids.every(id => lib.choice(id).fav);
    const allHidden = n > 0 && ids.every(id => lib.choice(id).hidden);
    const trashed = v.view === 'trash' ? lib.counts().trashed : 0;
    const lk = lib.services.lock;
    const lockState = !lk ? '' : lk.isLocked() ? (lk.isSet() ? 'locked' : '') : lk.isSet() ? 'open' : 'none';
    const next = [v.view, v.albumId ?? '', n, allFav, allHidden, trashed, lockState, !!lib.services.textIndex].join('|');
    if (next === sig) return;
    sig = next;
    const off = n ? '' : ' disabled';
    const count = `<span class="org-count" aria-live="polite">${n ? `${plural(n, 'photo')}` : 'Nothing selected'}</span>`;
    if (v.view === 'trash') {
      bar.innerHTML = `${count}
        <button type="button" class="btn" data-act="restore"${off}>Restore</button>
        <button type="button" class="btn btn-danger" data-act="empty"${trashed ? '' : ' disabled'}>Empty trash</button>`;
      return;
    }
    const hiddenView = v.view === 'hidden';
    if (hiddenView && lockState === 'locked') {
      bar.innerHTML = `<span class="org-count">Hidden photos are locked</span>
        <button type="button" class="btn btn-primary" data-act="unlock" aria-haspopup="dialog">Unlock…</button>
        <button type="button" class="btn" data-act="reset-lock" aria-haspopup="dialog">Reset lock…</button>`;
      return;
    }
    const lockBtns = !hiddenView ? ''
      : lockState === 'open' ? `<span class="separator" aria-hidden="true"></span><button type="button" class="btn" data-act="relock">Lock now</button><button type="button" class="btn" data-act="reset-lock" aria-haspopup="dialog">Reset lock…</button>`
      : lockState === 'none' ? `<span class="separator" aria-hidden="true"></span><button type="button" class="btn" data-act="set-lock" aria-haspopup="dialog" title="Ask for a passphrase before the Hidden view shows anything">Lock hidden photos…</button>` : '';
    bar.innerHTML = `${count}
      <button type="button" class="btn" data-act="favourite" aria-pressed="${allFav}" title="Favourite (F)"${off}>${allFav ? 'Unfavourite' : 'Favourite'}</button>
      <button type="button" class="btn" data-act="rate" aria-haspopup="menu" title="Rate (0 to 5)"${off}>Rate</button>
      <button type="button" class="btn" data-act="flag" aria-haspopup="menu" title="Pick (P), reject (X), clear (U)"${off}>Flag</button>
      <button type="button" class="btn" data-act="tag" aria-haspopup="dialog" title="Tag (T)"${off}>Tag…</button>
      <button type="button" class="btn" data-act="album" aria-haspopup="dialog"${off}>Add to album…</button>
      ${v.view === 'album' && v.albumId ? `<button type="button" class="btn" data-act="unalbum"${off}>Remove from album</button>` : ''}
      <button type="button" class="btn" data-act="hide" title="Hide (H)"${off}>${allHidden ? 'Unhide' : 'Hide'}</button>
      <button type="button" class="btn" data-act="trash" title="Move to trash (Delete)"${off}>Move to trash</button>
      <button type="button" class="btn" data-act="move" aria-haspopup="dialog" title="Move the files to another folder"${off}>Move to folder…</button>
      <button type="button" class="btn" data-act="rename" aria-haspopup="dialog" title="Rename the files from a template"${off}>Rename…</button>
      <span class="separator" aria-hidden="true"></span>
      <button type="button" class="btn" data-act="batch"${off}>Batch…</button>
      <button type="button" class="btn" data-act="gallery"${off}>Contact sheet</button>
      <button type="button" class="btn" data-act="export" aria-haspopup="dialog" title="Copy the original files into a folder or one .zip file"${off}>Export…</button>
      ${lib.services.textIndex ? `<button type="button" class="btn" data-act="read-text" title="Find the words in these photos so search matches them"${off}>Read text</button>` : ''}${lockBtns}`;
  }

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const ids = targets();
    switch (btn.dataset.act) {
      case 'favourite': act({ op: 'favourite' }, ids); break;
      case 'hide': act({ op: 'hide' }, ids); break;
      case 'trash': act({ op: 'trash' }, ids); break;
      case 'tag': tagDialog(ids); break;
      case 'album': albumPicker(ids); break;
      case 'rate': openMenu(btn, 'Rating', [0, 1, 2, 3, 4, 5].map(k => ({ label: k ? `${'★'.repeat(k)}  ${plural(k, 'star')}` : 'No rating', run: () => act({ op: 'rate', rating: k }, ids) }))); break;
      case 'flag': openMenu(btn, 'Flag', [
        { label: 'Pick', run: () => act({ op: 'flag', flag: 'pick' }, ids) },
        { label: 'Reject', run: () => act({ op: 'flag', flag: 'reject' }, ids) },
        { label: 'Clear flag', run: () => act({ op: 'flag', flag: 'none' }, ids) },
      ]); break;
      case 'unalbum': {
        const albumId = view().albumId;
        write('album_remove', ids, { album: albumId })
          .then(r => done(`Removed ${plural(r.changed, 'photo')} from the album`, [r.undo])).catch(fail);
        break;
      }
      case 'batch': emit('library:batch', { ids }); break;
      case 'gallery': emit('library:gallery', { ids }); break;
      case 'export': exportTo(() => ids, ''); break;
      case 'move': moveDialog(ids); break;
      case 'rename': renameDialog(ids); break;
      case 'read-text': readText(ids); break;
      case 'set-lock': setLock(); break;
      case 'unlock': unlock(); break;
      case 'relock': lib.services.lock?.lock(); say('Hidden photos are locked', 'ok'); break;
      case 'reset-lock': resetLock(); break;
      case 'restore': restore(ids); break;
      case 'empty': emptyTrash(); break;
    }
  });

  // The view has no selection event, so the bar refreshes after any click or
  // key, and on library changes; render() does nothing when nothing changed.
  let pending = false;
  const update = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; render(); }, 0); };
  for (const t of ['choices', 'albums', 'records']) lib.on(t, update);
  on('library:selection', update);
  on('library:view', update);
  document.addEventListener('click', update, true);
  document.addEventListener('keyup', update, true);
  render();
}
