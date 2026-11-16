// Library view: the pure grid model (src/ui/library/grid-model.js).
// Row layout for the virtual grid, visible rows at a scroll offset, hit tests,
// lasso, keyboard movement, the month table for the scrubber, selection ranges.
import assert from 'node:assert/strict';
import {
  buildLayout, visibleRows, itemsInRows, itemRect, hitTest, lassoIndices, moveIndex,
  monthTable, monthAt, scrubberMarks, monthAtTrack, clickSelect, rangeIds, toggleGroup,
  ZOOMS, GAP, HEADER_H,
} from '../src/ui/library/grid-model.js';

let n = 0;
const test = (name, fn) => { fn(); n++; };

// Items newest first: `perDay` photos on each of `days` days, counting back from 31 Dec 2024.
function makeItems(days, perDay) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const t = Date.UTC(2024, 11, 31 - d, 12);
    for (let k = 0; k < perDay; k++) out.push({ id: `r/${d}-${k}.jpg`, time: t - k * 1000 });
  }
  return out;
}

test('columns and tile size fill the width', () => {
  const l = buildLayout([], { width: 1000, zoom: 1 });
  const cols = Math.floor((1000 + GAP) / (ZOOMS[1].tile + GAP));
  assert.equal(l.cols, cols);
  assert.equal(l.tile, Math.floor((1000 - GAP * (cols - 1)) / cols));
  assert.ok(l.cols * l.tile + (l.cols - 1) * GAP <= 1000);
  assert.equal(l.height, 0);
  assert.equal(buildLayout([], { width: 50, zoom: 2 }).cols, 1);
});

test('day headers and tile rows', () => {
  const items = makeItems(2, 7); // two days of 7
  const l = buildLayout(items, { width: 3 * 148 + 2 * GAP, zoom: 1 }); // 3 columns
  assert.equal(l.cols, 3);
  const kinds = l.rows.map(r => r.type);
  assert.deepEqual(kinds, ['header', 'tiles', 'tiles', 'tiles', 'header', 'tiles', 'tiles', 'tiles']);
  assert.deepEqual(l.rows.filter(r => r.type === 'tiles').map(r => [r.start, r.end]), [[0, 3], [3, 6], [6, 7], [7, 10], [10, 13], [13, 14]]);
  assert.equal(l.rows[0].key, '2024-12-31');
  assert.equal(l.rows[0].height, HEADER_H.day);
  assert.equal(l.rows[1].top, HEADER_H.day);
  assert.equal(l.height, 2 * HEADER_H.day + 6 * (l.tile + GAP));
  assert.equal(l.itemRow[6], 3);
  assert.equal(l.itemRow[7], 5);
});

test('zoomed out groups by month', () => {
  const items = makeItems(40, 2); // spans December and November
  const l = buildLayout(items, { width: 800, zoom: 0 });
  const heads = l.rows.filter(r => r.type === 'header');
  assert.deepEqual(heads.map(h => h.key), ['2024-12', '2024-11']);
  assert.equal(heads[0].unit, 'month');
  assert.equal(heads[0].count, 62);
});

test('ungrouped layout has no headers', () => {
  const l = buildLayout(makeItems(3, 3), { width: 500, zoom: 1, grouped: false });
  assert.ok(l.rows.every(r => r.type === 'tiles'));
});

test('visible rows at a scroll offset stay bounded at 100,000 items', () => {
  const items = makeItems(1000, 100); // 100,000
  const t0 = performance.now();
  const l = buildLayout(items, { width: 1200, zoom: 1 });
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `layout took ${ms} ms`);
  const viewH = 800, overscan = 400;
  for (const y of [0, l.height / 3, l.height / 2, l.height - viewH]) {
    const { first, last } = visibleRows(l, y, viewH, overscan);
    assert.ok(l.rows[first].top <= Math.max(0, y - overscan));
    assert.ok(l.rows[last].top <= y + viewH + overscan);
    if (last + 1 < l.rows.length) assert.ok(l.rows[last + 1].top > y + viewH + overscan);
    const count = itemsInRows(l, first, last).length;
    assert.ok(count > 0 && count < 200, `items in DOM at ${y}: ${count}`);
  }
  assert.deepEqual(visibleRows(buildLayout([], { width: 100 }), 0, 100), { first: 0, last: -1 });
});

test('item rects and hit tests agree', () => {
  const items = makeItems(3, 10);
  const l = buildLayout(items, { width: 700, zoom: 1 });
  for (const i of [0, 4, 9, 10, 29]) {
    const r = itemRect(l, i);
    assert.equal(hitTest(l, r.x + r.w / 2, r.y + r.h / 2), i);
  }
  assert.equal(hitTest(l, 10, 5), -1); // on the first header
  const r0 = itemRect(l, 0);
  assert.equal(hitTest(l, r0.x + r0.w + 1, r0.y + 5), -1); // in the gap
});

test('lasso selects the tiles it meets', () => {
  const items = makeItems(1, 12);
  const l = buildLayout(items, { width: 4 * 148 + 3 * GAP, zoom: 1 }); // 4 columns, 3 rows
  const a = itemRect(l, 1), b = itemRect(l, 6);
  const got = lassoIndices(l, { x: a.x + 5, y: a.y + 5, w: b.x - a.x, h: b.y - a.y });
  assert.deepEqual(got.sort((x, y) => x - y), [1, 2, 5, 6]);
  // dragging up and left gives the same answer
  const back = lassoIndices(l, { x: b.x + 5, y: b.y + 5, w: a.x - b.x, h: a.y - b.y });
  assert.deepEqual(back.sort((x, y) => x - y), [1, 2, 5, 6]);
});

test('arrow keys move through rows and across day headers', () => {
  const items = makeItems(2, 5); // 3 columns: day 1 rows [0..2],[3,4]; day 2 rows [5..7],[8,9]
  const l = buildLayout(items, { width: 3 * 148 + 2 * GAP, zoom: 1 });
  assert.equal(moveIndex(l, 0, 'ArrowRight', 10), 1);
  assert.equal(moveIndex(l, 0, 'ArrowLeft', 10), 0);
  assert.equal(moveIndex(l, 1, 'ArrowDown', 10), 4);
  assert.equal(moveIndex(l, 2, 'ArrowDown', 10), 4); // short row: clamp to its last tile
  assert.equal(moveIndex(l, 4, 'ArrowDown', 10), 6); // across the header, same column
  assert.equal(moveIndex(l, 6, 'ArrowUp', 10), 4);
  assert.equal(moveIndex(l, 9, 'ArrowDown', 10), 9);
  assert.equal(moveIndex(l, 1, 'PageDown', 10, 2), 6);
  assert.equal(moveIndex(l, 5, 'Home', 10), 0);
  assert.equal(moveIndex(l, 5, 'End', 10), 9);
  assert.equal(moveIndex(l, 5, 'ArrowRight', 0), -1);
});

test('month table and scrubber', () => {
  const items = makeItems(70, 3); // 31 Dec back to 22 Oct
  const l = buildLayout(items, { width: 900, zoom: 1 });
  const t = monthTable(l, items);
  assert.deepEqual(t.map(m => m.key), ['2024-12', '2024-11', '2024-10']);
  assert.equal(t[0].top, 0);
  assert.equal(t[0].label, 'December 2024');
  // each entry's top is the top of that month's first day header
  const nov = l.rows.find(r => r.type === 'header' && r.key === '2024-11-30');
  assert.equal(t[1].top, nov.top);
  assert.equal(monthAt(t, 0).key, '2024-12');
  assert.equal(monthAt(t, nov.top).key, '2024-11');
  assert.equal(monthAt(t, nov.top - 10).key, '2024-12');
  assert.equal(monthAt([], 10), null);
  assert.equal(monthAtTrack(t, 0, l.height, 500).key, '2024-12');
  assert.equal(monthAtTrack(t, 500, l.height, 500).key, '2024-10');
  assert.equal(monthAtTrack(t, 9999, l.height, 500).key, '2024-10');
});

test('scrubber marks one label per year without overlap', () => {
  const table = [
    { key: '2024-12', year: 2024, top: 0 }, { key: '2024-01', year: 2024, top: 100 },
    { key: '2023-12', year: 2023, top: 200 }, { key: '2022-05', year: 2022, top: 210 },
    { key: '2021-05', year: 2021, top: 900 },
  ];
  const marks = scrubberMarks(table, 1000, 500, 18);
  assert.deepEqual(marks.map(m => m.year), [2024, 2023, 2021]); // 2022 sits 5 px under 2023
  assert.deepEqual(marks.map(m => m.pos), [0, 100, 450]);
});

test('click, Shift range and Ctrl toggle', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  let s = clickSelect(new Set(), ids, 1);
  assert.deepEqual([...s.sel], ['b']); assert.equal(s.anchor, 1);
  s = clickSelect(s.sel, ids, 3, { shift: true, anchor: s.anchor });
  assert.deepEqual([...s.sel].sort(), ['b', 'c', 'd']);
  s = clickSelect(s.sel, ids, 0, { shift: true, anchor: s.anchor });
  assert.deepEqual([...s.sel].sort(), ['a', 'b']); // a new range replaces the old one
  s = clickSelect(s.sel, ids, 4, { toggle: true, anchor: s.anchor });
  assert.deepEqual([...s.sel].sort(), ['a', 'b', 'e']); assert.equal(s.anchor, 4);
  s = clickSelect(s.sel, ids, 4, { toggle: true, anchor: s.anchor });
  assert.deepEqual([...s.sel].sort(), ['a', 'b']);
  s = clickSelect(new Set(['e']), ids, 2, { shift: true, toggle: true, anchor: 0 });
  assert.deepEqual([...s.sel].sort(), ['a', 'b', 'c', 'e']); // Ctrl+Shift adds the range
  assert.deepEqual(rangeIds(ids, 3, 1), ['b', 'c', 'd']);
  assert.deepEqual(rangeIds(ids, -2, 9), ids);
});

test('select all in a day, then clear it', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  let s = toggleGroup(new Set(['a']), ids, 1, 3);
  assert.deepEqual([...s].sort(), ['a', 'b', 'c', 'd']);
  s = toggleGroup(s, ids, 1, 3);
  assert.deepEqual([...s], ['a']);
});

console.log(`test-library-view: ${n} tests pass`);
