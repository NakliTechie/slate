// Stacks (row B9): group related photos so the grid shows one tile for them.
//
//   buildStacks(records) -> { stacks: Stack[], stackOf: Map<id, Stack> }
//   Stack = { id, kind: 'edit'|'raw'|'burst', top: id, members: id[] }   (top first)
//
// Three kinds, each within one folder of one root, photos only:
//   - an edited version Slate saved beside its original: `<stem>-<yymmddhhmmss>.<ext>`
//     next to `<stem>.<any ext>` (app.js doSave names saves this way; an edit of an edit
//     adds another suffix, and stacks with the same original)
//   - RAW plus JPEG (or any other photo format) with the same stem
//   - bursts: more than 2 photos from the same camera, each within 1 second of the one before
// The top is the newest edited version, else the JPEG, else the first member in the order given.
// A stack is a view of records only: choices (favourite, rating, flags) stay per file.

import { folderOf, extOf } from './schema.js';

export const RAW_EXTS = new Set(['cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2']);
const JPEG_EXTS = new Set(['jpg', 'jpeg']);
const EDIT_SUFFIX = /-\d{12}$/;
export const BURST_GAP_MS = 1000;
export const BURST_MIN = 3;

// 'IMG_1-261116101010-261117090000.jpg' -> { base: 'IMG_1', edit: '261117090000' }
export function editInfo(name) {
  const i = name.lastIndexOf('.');
  let stem = i < 0 ? name : name.slice(0, i);
  let edit = null;
  while (EDIT_SUFFIX.test(stem)) {
    edit ??= stem.slice(-12);
    stem = stem.slice(0, -13);
  }
  return { base: stem, edit };
}

export function buildStacks(records) {
  const photos = records.filter(r => r.kind === 'photo');
  const order = new Map(photos.map((r, i) => [r.id, i]));
  const stacks = [];
  const stackOf = new Map();
  const add = (kind, members) => {
    const top = pickTop(members, order);
    const st = { id: top.id, kind, top: top.id, members: [top.id, ...members.filter(m => m !== top).sort((a, b) => order.get(a.id) - order.get(b.id)).map(m => m.id)] };
    stacks.push(st);
    for (const id of st.members) stackOf.set(id, st);
  };

  // Name stacks: edits and RAW plus JPEG, grouped by root, folder and base stem.
  const byStem = new Map();
  for (const r of photos) {
    const { base, edit } = editInfo(r.name);
    const k = `${r.rootId}\u0000${folderOf(r.path)}\u0000${base.toLowerCase()}`;
    if (!byStem.has(k)) byStem.set(k, []);
    byStem.get(k).push({ r, edit });
  }
  for (const group of byStem.values()) {
    if (group.length < 2) continue;
    const originals = group.filter(g => !g.edit);
    const hasEdit = originals.length > 0 && originals.length < group.length;
    const hasRawPair = originals.some(g => RAW_EXTS.has(g.r.ext)) && originals.some(g => !RAW_EXTS.has(g.r.ext));
    if (hasEdit || hasRawPair) add(hasEdit ? 'edit' : 'raw', group.map(g => g.r));
  }

  // Bursts among the photos left: same root, folder and camera, consecutive gaps of at most 1 s.
  const byCam = new Map();
  for (const r of photos) {
    if (stackOf.has(r.id) || !r.camera || r.timeSource === 'file') continue;
    const k = `${r.rootId}\u0000${folderOf(r.path)}\u0000${r.camera}`;
    if (!byCam.has(k)) byCam.set(k, []);
    byCam.get(k).push(r);
  }
  for (const list of byCam.values()) {
    if (list.length < BURST_MIN) continue;
    list.sort((a, b) => a.time - b.time || (a.name < b.name ? -1 : 1));
    let run = [list[0]];
    const close = () => { if (run.length >= BURST_MIN) add('burst', run); };
    for (let i = 1; i < list.length; i++) {
      if (list[i].time - list[i - 1].time <= BURST_GAP_MS) run.push(list[i]);
      else { close(); run = [list[i]]; }
    }
    close();
  }
  return { stacks, stackOf };
}

function pickTop(members, order) {
  const edits = members.map(r => ({ r, edit: editInfo(r.name).edit })).filter(x => x.edit);
  if (edits.length) return edits.sort((a, b) => (a.edit < b.edit ? 1 : a.edit > b.edit ? -1 : 0))[0].r;
  const byOrder = [...members].sort((a, b) => order.get(a.id) - order.get(b.id));
  return byOrder.find(r => JPEG_EXTS.has(extOf(r.name))) ?? byOrder[0];
}
