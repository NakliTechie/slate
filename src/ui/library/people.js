// The People view (spec rows F1 and F2). Off: what turning faces on does, and
// a button to turn it on. On: progress, Pause, Delete all face data, and a
// grid of people (their cover face). A person's page names them, hides them,
// merges them into another person, sets the cover, marks a face as not this
// person, and lists their photos (a click opens one in the editor).
//
// initPeople(lib, ui) registers the view. The service is lib.services.faces
// (src/library/faces.js); names and groups live in this browser only.

import { esc } from '../../core/html.js';
import { OPT_IN_TEXT, MIN_FACES } from '../../library/faces.js';

const n = (x) => x.toLocaleString('en-GB');
const plural = (c, one, many = one + 's') => `${n(c)} ${c === 1 ? one : many}`;

// CSS for a face crop out of the photo's thumbnail: the box grows by a fifth on each side.
export function cropStyle(box) {
  let [x, y, w, h] = box;
  const pad = 0.2;
  x -= w * pad; y -= h * pad; w *= 1 + 2 * pad; h *= 1 + 2 * pad;
  w = Math.min(1, w); h = Math.min(1, h);
  x = Math.min(Math.max(0, x), 1 - w); y = Math.min(Math.max(0, y), 1 - h);
  const pos = (p, s) => (s >= 1 ? 0 : (p / (1 - s)) * 100);
  return `background-size:${100 / w}% ${100 / h}%;background-position:${pos(x, w)}% ${pos(y, h)}%`;
}

export function initPeople(lib, ui) {
  const faces = lib.services.faces;
  if (!faces) throw new Error('initPeople needs lib.services.faces (initFaces first)');
  let page = null;              // null = the people grid, else a person id
  let showHidden = false;
  let confirming = false;
  let host = null;

  const say = (m, level = 'info') => ui.toast?.(m, level);
  // A background update never redraws over a name or a choice being made.
  const redraw = () => {
    if (!host?.isConnected) return;
    const a = document.activeElement;
    if (a && host.contains(a) && /^(INPUT|SELECT)$/.test(a.tagName) && a.type !== 'checkbox') return;
    draw();
  };

  function loadCrops(root) {
    for (const el of root.querySelectorAll('[data-crop]')) {
      Promise.resolve(lib.services.thumbs?.url?.(el.dataset.crop)).then(u => { if (u) el.style.backgroundImage = `url("${u}")`; }).catch(() => {});
    }
    for (const img of root.querySelectorAll('img[data-id]')) {
      Promise.resolve(lib.services.thumbs?.url?.(img.dataset.id)).then(u => { if (u) img.src = u; }).catch(() => {});
    }
  }

  const faceTile = (f, extra = '') => `<span class="ppl-face" data-crop="${esc(f.id.slice(0, f.id.lastIndexOf('#')))}" style="${cropStyle(f.box)}">${extra}</span>`;

  function drawOff(el) {
    const s = faces.status();
    el.innerHTML = `<div class="ppl-intro">
      <h2>People</h2>
      <p>Faces are off. Turn them on to find faces in your photos and group them by person.</p>
      <p>When you turn faces on:</p>
      <ul>${OPT_IN_TEXT.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="ppl-row"><button type="button" class="btn btn-primary" data-act="on">Turn on faces</button>
      ${faces.hasData() ? '<button type="button" class="btn btn-danger" data-act="delete">Delete all face data</button>' : ''}</div>
      ${s.error ? `<p class="ppl-error">${esc(s.error)}</p>` : ''}
    </div>`;
  }

  function header() {
    const s = faces.status();
    const progress = s.done < s.total ? `Looked at ${n(s.done)} of ${plural(s.total, 'photo')}` : `Looked at ${plural(s.total, 'photo')}`;
    return `<div class="ppl-head">
      <div class="ppl-status">${progress}, found ${plural(s.faces, 'face')} and ${plural(s.people, 'person', 'people')}.${s.paused ? ' Paused.' : ''}</div>
      ${s.error ? `<p class="ppl-error">The last photo failed: ${esc(s.error)}</p>` : ''}
      <div class="ppl-row">
        ${s.paused ? '<button type="button" class="btn" data-act="resume">Resume</button>' : (s.done < s.total ? '<button type="button" class="btn" data-act="pause">Pause</button>' : '')}
        <label class="ppl-check"><input type="checkbox" data-act="hidden"${showHidden ? ' checked' : ''}> Show hidden people</label>
        <button type="button" class="btn" data-act="off">Turn off faces</button>
        <button type="button" class="btn btn-danger" data-act="delete">Delete all face data</button>
      </div>
      ${confirming ? `<div class="ppl-confirm" role="alert"><p>Delete ${plural(s.faces, 'face')}, ${plural(s.people, 'person', 'people')}, every name and the downloaded models from this browser? Your photos and their sidecars stay as they are. This cannot be undone.</p>
        <div class="ppl-row"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="button" class="btn btn-danger" data-act="confirm-delete">Delete face data</button></div></div>` : ''}
    </div>`;
  }

  function drawGrid(el) {
    const people = faces.people({ hidden: showHidden });
    el.innerHTML = `<div class="ppl-root">${header()}
      ${people.length ? `<div class="ppl-grid">${people.map(p => {
        const f = faces.coverFace(p.id);
        return `<button type="button" class="ppl-card${p.hidden ? ' ppl-hidden' : ''}" data-person="${esc(p.id)}">
          ${f ? faceTile(f) : '<span class="ppl-face"></span>'}
          <span class="ppl-name">${p.name ? esc(p.name) : 'Add a name'}</span>
          <span class="ppl-count">${plural(p.photos, 'photo')}${p.hidden ? ', hidden' : ''}</span></button>`;
      }).join('')}</div>` : `<p class="ppl-empty">No people yet. A person appears once the same face is found in ${MIN_FACES} photos.</p>`}
    </div>`;
  }

  function drawPerson(el, pid) {
    const p = faces.person(pid);
    if (!p) { page = null; drawGrid(el); return; }
    const list = faces.facesOf(pid);
    const cover = faces.coverFace(pid);
    const others = faces.people({ hidden: true }).filter(o => o.id !== pid);
    const photos = faces.photosOf(pid);
    el.innerHTML = `<div class="ppl-root">
      <div class="ppl-row"><button type="button" class="btn" data-act="back">Back to people</button></div>
      <div class="ppl-person">
        ${cover ? faceTile(cover) : ''}
        <form class="ppl-form" data-form="name"><label>Name <input type="text" maxlength="100" value="${esc(p.name)}" placeholder="Add a name"></label>
          <button type="submit" class="btn btn-primary">Save name</button></form>
        <div class="ppl-row">
          <button type="button" class="btn" data-act="hide">${p.hidden ? 'Show this person' : 'Hide this person'}</button>
          ${others.length ? `<label>Merge into <select data-merge><option value="">Choose a person</option>${others.map(o => `<option value="${esc(o.id)}">${esc(o.name || `Unnamed (${plural(o.photos, 'photo')})`)}</option>`).join('')}</select></label>
          <button type="button" class="btn" data-act="merge">Merge</button>` : ''}
        </div>
      </div>
      <h3 class="ppl-section">Faces (${n(list.length)})</h3>
      <div class="ppl-faces">${list.map(f => `<div class="ppl-facecell${cover?.id === f.id ? ' ppl-cover' : ''}">${faceTile(f)}
        <button type="button" class="btn" data-act="cover" data-face="${esc(f.id)}"${cover?.id === f.id ? ' disabled' : ''}>Set as cover</button>
        <button type="button" class="btn" data-act="wrong" data-face="${esc(f.id)}">Not this person</button></div>`).join('')}</div>
      <h3 class="ppl-section">Photos (${n(photos.length)})</h3>
      <div class="ppl-photos">${photos.map(id => `<button type="button" class="ppl-photo" data-open="${esc(id)}" title="${esc(lib.get(id)?.name ?? '')}"><img alt="" data-id="${esc(id)}"></button>`).join('')}</div>
    </div>`;
  }

  function draw() {
    if (!faces.enabled()) drawOff(host);
    else if (page) drawPerson(host, page);
    else drawGrid(host);
    loadCrops(host);
  }

  async function act(e) {
    const t = e.target.closest('[data-act], [data-person], [data-open]');
    if (!t || !host.contains(t)) return;
    try {
      if (t.dataset.person) { page = t.dataset.person; return draw(); }
      if (t.dataset.open) return ui.openInEditor(t.dataset.open);
      switch (t.dataset.act) {
        case 'on': await faces.setEnabled(true); say('Faces are on. Models download first, then photos are looked at in the background.'); break;
        case 'off': await faces.setEnabled(false); say('Faces are off. Face data stays until you delete it.'); break;
        case 'pause': faces.pause(); break;
        case 'resume': faces.resume(); break;
        case 'hidden': showHidden = t.checked; break;
        case 'delete': if (!faces.enabled()) { await faces.deleteAll(); say('Deleted all face data.', 'ok'); } else confirming = true; break;
        case 'cancel': confirming = false; break;
        case 'confirm-delete': confirming = false; page = null; await faces.deleteAll(); say('Deleted all face data.', 'ok'); break;
        case 'back': page = null; break;
        case 'hide': { const p = faces.hide(page, !faces.person(page).hidden); say(p.hidden ? 'Hidden. Show hidden people to see them again.' : 'Shown.'); break; }
        case 'merge': {
          const from = page, into = host.querySelector('[data-merge]')?.value;
          if (!into) { say('Choose a person to merge into.'); return; }
          faces.merge(into, from); page = into; say('Merged.', 'ok'); break;
        }
        case 'cover': faces.setCover(page, t.dataset.face); break;
        case 'wrong': faces.notThisPerson(t.dataset.face); say('Removed that face from this person.'); break;
        default: return;
      }
      draw(); ui.refreshView?.();
    } catch (err) { say(err?.message ?? String(err), 'error'); }
  }

  function onSubmit(e) {
    if (e.target.dataset.form !== 'name') return;
    e.preventDefault();
    try { faces.name(page, e.target.querySelector('input').value); say('Name saved.', 'ok'); draw(); ui.refreshView?.(); }
    catch (err) { say(err?.message ?? String(err), 'error'); }
  }

  ui.registerView({
    id: 'people',
    label: 'People',
    count: () => (faces.enabled() ? faces.people().length : null),
    render(el) {
      host = el;
      el.addEventListener('click', act);
      el.addEventListener('submit', onSubmit);
      el.addEventListener('keydown', (e) => e.stopPropagation()); // typing a name never reaches the grid keys
      draw();
      let timer = null;
      const off = faces.on(() => { clearTimeout(timer); timer = setTimeout(redraw, 400); });
      return () => { off(); clearTimeout(timer); host = null; };
    },
  });
}
