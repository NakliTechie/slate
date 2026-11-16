// Memories (spec row B10): "On this day", the photos taken on today's month and
// day in earlier years. A date query over the index; no model.
//
// onThisDay(records, choices, today = new Date())
//   -> { offset, date: Date, groups: [{ year, ids }], ids }
//   Capture times use the UTC wall clock (see the note in schema.js); `today`
//   is the person's own calendar day, so it uses local getters.
//   Hidden and trashed photos are left out. A photo taken on 29 February shows
//   on 28 February in years that have no 29 February.
//   When today has no photos, the nearest day within 7 days that has some is
//   used instead (yesterday before tomorrow); `offset` says how many days away.
//   Groups are newest year first; `ids` is every id in that order.
//
// initMemories(lib, ui) registers the "On this day" sidebar view; the grid
// shows its photos under its own day headers.

import { choiceOf } from './query.js';

const FALLBACK_DAYS = 7;
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const key = (m, d) => m * 100 + d; // month 1..12, day 1..31

export function onThisDay(records, choices, today = new Date()) {
  const byDay = new Map(); // key(month, day) -> records
  for (const r of records) {
    if (r.time == null || !Number.isFinite(r.time)) continue;
    const c = choiceOf(choices, r.id);
    if (c.hidden || c.trashed) continue;
    const t = new Date(r.time);
    const k = key(t.getUTCMonth() + 1, t.getUTCDate());
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }

  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const offsets = [0];
  for (let i = 1; i <= FALLBACK_DAYS; i++) offsets.push(-i, i);
  for (const offset of offsets) {
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
    const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    const keys = [key(m, d)];
    if (m === 2 && d === 28 && !isLeap(y)) keys.push(key(2, 29));
    const hits = keys.flatMap(k => byDay.get(k) ?? []).filter(r => new Date(r.time).getUTCFullYear() < y);
    if (!hits.length) continue;
    hits.sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : 1));
    const groups = [];
    for (const r of hits) {
      const year = new Date(r.time).getUTCFullYear();
      if (groups.at(-1)?.year !== year) groups.push({ year, ids: [] });
      groups.at(-1).ids.push(r.id);
    }
    return { offset, date, groups, ids: hits.map(r => r.id) };
  }
  return { offset: 0, date: base, groups: [], ids: [] };
}

export function initMemories(lib, ui) {
  let cache = null, cacheDay = '';
  const dayNow = () => { const t = new Date(); return `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`; };
  const result = () => {
    const d = dayNow();
    if (!cache || cacheDay !== d) { cache = onThisDay(lib.records.values(), lib.choices); cacheDay = d; }
    return cache;
  };
  const invalidate = () => { cache = null; };
  lib.on('records', invalidate);
  lib.on('choices', invalidate);
  ui.registerView({
    id: 'memories',
    label: 'On this day',
    count: () => result().ids.length,
    ids: () => result().ids,
  });
  return { result };
}
