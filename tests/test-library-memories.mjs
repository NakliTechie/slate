// Memories (B10): on this day across years, the leap day, hidden and trashed
// photos left out, and the fallback to the nearest day within 7 days.
import assert from 'node:assert/strict';
import { onThisDay, initMemories } from '../src/library/memories.js';
import { newRecord, wallClockToTime, emptyChoice } from '../src/library/schema.js';

const rec = (path, y, m, d, h = 12) => ({ ...newRecord('r1', path, { size: 1, lastModified: 0 }), time: wallClockToTime(y, m, d, h) });
const local = (y, m, d) => new Date(y, m - 1, d, 15, 0, 0);

{
  const records = [
    rec('a.jpg', 2020, 11, 16), rec('b.jpg', 2023, 11, 16, 23), rec('c.jpg', 2023, 11, 16, 1),
    rec('d.jpg', 2026, 11, 16), // this year: not a memory
    rec('e.jpg', 2022, 11, 17), rec('f.jpg', 2021, 10, 16),
    rec('g.jpg', 2019, 11, 16), rec('h.jpg', 2018, 11, 16),
  ];
  const choices = new Map([
    ['r1/g.jpg', { ...emptyChoice(), hidden: true }],
    ['r1/h.jpg', { ...emptyChoice(), trashed: '2026-01-01T00:00:00Z' }],
  ]);
  const m = onThisDay(records, choices, local(2026, 11, 16));
  assert.equal(m.offset, 0);
  assert.deepEqual(m.groups.map(g => g.year), [2023, 2020], 'grouped by year, newest first; this year left out');
  assert.deepEqual(m.groups[0].ids, ['r1/b.jpg', 'r1/c.jpg'], 'newest first within a year');
  assert.deepEqual(m.ids, ['r1/b.jpg', 'r1/c.jpg', 'r1/a.jpg'], 'hidden and trashed left out, other days left out');
}

{
  // A 29 February photo shows on 28 February in a year without 29 February.
  const records = [rec('leap.jpg', 2024, 2, 29), rec('feb28.jpg', 2023, 2, 28)];
  const plain = onThisDay(records, new Map(), local(2025, 2, 28));
  assert.deepEqual(plain.ids.sort(), ['r1/feb28.jpg', 'r1/leap.jpg']);
  const leapYear = onThisDay(records, new Map(), local(2028, 2, 28));
  assert.deepEqual(leapYear.ids, ['r1/feb28.jpg'], 'in a leap year 29 February keeps its own day');
  const leapDay = onThisDay(records, new Map(), local(2028, 2, 29));
  assert.deepEqual(leapDay.ids, ['r1/leap.jpg']);
}

{
  // No photos today: nearest day within 7 days, yesterday before tomorrow.
  const records = [rec('p3.jpg', 2020, 6, 13), rec('n3.jpg', 2021, 6, 19), rec('n2.jpg', 2021, 6, 18)];
  const m = onThisDay(records, new Map(), local(2026, 6, 16));
  assert.equal(m.offset, 2);
  assert.deepEqual(m.ids, ['r1/n2.jpg']);
  const tie = onThisDay([rec('p.jpg', 2020, 6, 14), rec('n.jpg', 2020, 6, 18)], new Map(), local(2026, 6, 16));
  assert.equal(tie.offset, -2, 'the earlier day wins a tie');
  const across = onThisDay([rec('y.jpg', 2020, 12, 30)], new Map(), local(2027, 1, 2));
  assert.equal(across.offset, -3, 'the fallback crosses a year boundary');
  const none = onThisDay([rec('far.jpg', 2020, 6, 24)], new Map(), local(2026, 6, 16));
  assert.equal(none.ids.length, 0, 'nothing beyond 7 days');
}

{
  // initMemories registers the view; it recomputes after a change.
  const listeners = {};
  const records = new Map([['r1/a.jpg', rec('a.jpg', 2000, new Date().getMonth() + 1, new Date().getDate())]]);
  const lib = { records, choices: new Map(), on: (t, fn) => { listeners[t] = fn; } };
  let view = null;
  initMemories(lib, { registerView: (v) => { view = v; } });
  assert.equal(view.id, 'memories');
  assert.equal(view.label, 'On this day');
  assert.equal(view.count(), 1);
  assert.deepEqual(view.ids(), ['r1/a.jpg']);
  lib.choices.set('r1/a.jpg', { ...emptyChoice(), hidden: true });
  listeners.choices({ ids: ['r1/a.jpg'] });
  assert.equal(view.count(), 0);
}

console.log('Slate library memories: PASS');
