// Pure maths for the library grid: row layout for the virtual grid, the
// month-to-row table for the scrubber, keyboard movement, hit tests and
// selection ranges. No DOM, so it runs in Node tests.
//
// A layout is a list of rows in content coordinates. A row is a header
// (one per day or month) or a run of square tiles. Only the rows that meet
// the viewport plus overscan are put in the DOM.

import { groupBy } from '../../library/query.js';
import { monthKey, monthLabel } from '../../library/schema.js';

// Three zoom levels. The smallest groups by month, the other two by day.
export const ZOOMS = [
  { tile: 88, unit: 'month' },
  { tile: 148, unit: 'day' },
  { tile: 232, unit: 'day' },
];
export const GAP = 4;
export const HEADER_H = { day: 36, month: 44 };

/**
 * @param {object[]} items  sorted records (only `time` is read)
 * @param {{ width: number, zoom?: number, grouped?: boolean, gap?: number }} o
 * @returns {{ rows: object[], cols: number, tile: number, gap: number, height: number, unit: string|null, itemRow: Int32Array }}
 */
export function buildLayout(items, { width, zoom = 1, grouped = true, gap = GAP }) {
  const z = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, zoom))];
  const w = Math.max(1, Math.floor(width));
  const cols = Math.max(1, Math.floor((w + gap) / (z.tile + gap)));
  const tile = Math.max(1, Math.floor((w - gap * (cols - 1)) / cols));
  const unit = grouped ? z.unit : null;
  const groups = unit ? groupBy(items, unit) : (items.length ? [{ key: null, start: 0, count: items.length }] : []);
  const rows = [];
  const itemRow = new Int32Array(items.length);
  let y = 0;
  for (const g of groups) {
    if (g.key) {
      rows.push({ type: 'header', key: g.key, unit, start: g.start, count: g.count, top: y, height: HEADER_H[unit] });
      y += HEADER_H[unit];
    }
    const end = g.start + g.count;
    for (let i = g.start; i < end; i += cols) {
      const rEnd = Math.min(i + cols, end);
      for (let k = i; k < rEnd; k++) itemRow[k] = rows.length;
      rows.push({ type: 'tiles', start: i, end: rEnd, top: y, height: tile });
      y += tile + gap;
    }
  }
  return { rows, cols, tile, gap, height: y, unit, itemRow };
}

// Index of the last row whose top is at or above `y` (0 when none).
export function rowAt(layout, y) {
  const rows = layout.rows;
  let lo = 0, hi = rows.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// Rows that meet [scrollTop - overscan, scrollTop + viewH + overscan].
// Returns { first, last } row indices (inclusive), or { first: 0, last: -1 } when empty.
export function visibleRows(layout, scrollTop, viewH, overscan = 400) {
  if (!layout.rows.length) return { first: 0, last: -1 };
  const top = Math.max(0, scrollTop - overscan);
  const bottom = scrollTop + viewH + overscan;
  const first = rowAt(layout, top);
  let last = rowAt(layout, bottom);
  if (layout.rows[last].top > bottom) last = Math.max(first, last - 1);
  return { first, last };
}

// The items (indices) in a row range, for counting what is in the DOM.
export function itemsInRows(layout, first, last) {
  const out = [];
  for (let r = first; r <= last; r++) {
    const row = layout.rows[r];
    if (row?.type === 'tiles') for (let i = row.start; i < row.end; i++) out.push(i);
  }
  return out;
}

export function itemRect(layout, index) {
  const row = layout.rows[layout.itemRow[index]];
  const col = index - row.start;
  return { x: col * (layout.tile + layout.gap), y: row.top, w: layout.tile, h: layout.tile };
}

// The item under a point in content coordinates, or -1.
export function hitTest(layout, x, y) {
  if (!layout.rows.length) return -1;
  const row = layout.rows[rowAt(layout, y)];
  if (row.type !== 'tiles' || y > row.top + row.height) return -1;
  const step = layout.tile + layout.gap;
  const col = Math.floor(x / step);
  if (col < 0 || x - col * step > layout.tile) return -1;
  const i = row.start + col;
  return i < row.end ? i : -1;
}

// Every item whose tile meets the rectangle { x, y, w, h } (content coordinates).
export function lassoIndices(layout, rect) {
  const x0 = Math.min(rect.x, rect.x + rect.w), x1 = Math.max(rect.x, rect.x + rect.w);
  const y0 = Math.min(rect.y, rect.y + rect.h), y1 = Math.max(rect.y, rect.y + rect.h);
  const out = [];
  if (!layout.rows.length) return out;
  const step = layout.tile + layout.gap;
  const c0 = Math.max(0, Math.floor(x0 / step));
  const c1 = Math.floor(x1 / step);
  for (let r = rowAt(layout, y0); r < layout.rows.length; r++) {
    const row = layout.rows[r];
    if (row.top > y1) break;
    if (row.type !== 'tiles' || row.top + row.height < y0) continue;
    for (let c = c0; c <= c1; c++) {
      const i = row.start + c;
      if (i >= row.end) break;
      if (x0 <= c * step + layout.tile) out.push(i);
    }
  }
  return out;
}

// The next tile row after (dir 1) or before (dir -1) row r, or -1.
function nextTileRow(layout, r, dir) {
  for (let k = r + dir; k >= 0 && k < layout.rows.length; k += dir) {
    if (layout.rows[k].type === 'tiles') return k;
  }
  return -1;
}

/**
 * Keyboard movement. `key` is a KeyboardEvent.key; `pageRows` is how many
 * tile rows fit in the viewport. Returns the new index (clamped).
 */
export function moveIndex(layout, index, key, count, pageRows = 3) {
  if (!count) return -1;
  if (index < 0 || index >= count) return 0;
  const vertical = (dir, times) => {
    let r = layout.itemRow[index];
    const col = index - layout.rows[r].start;
    for (let t = 0; t < times; t++) {
      const n = nextTileRow(layout, r, dir);
      if (n < 0) break;
      r = n;
    }
    const row = layout.rows[r];
    return Math.min(row.start + col, row.end - 1);
  };
  switch (key) {
    case 'ArrowLeft': return Math.max(0, index - 1);
    case 'ArrowRight': return Math.min(count - 1, index + 1);
    case 'ArrowUp': return vertical(-1, 1);
    case 'ArrowDown': return vertical(1, 1);
    case 'PageUp': return vertical(-1, Math.max(1, pageRows));
    case 'PageDown': return vertical(1, Math.max(1, pageRows));
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return index;
  }
}

// ── Scrubber ───────────────────────────────────────────────────────────────

// One entry per month, at the top of the first header of that month.
// [{ key: 'YYYY-MM', year, label, top }] in layout order.
export function monthTable(layout, items) {
  const out = [];
  let prev = null;
  for (const row of layout.rows) {
    if (row.type !== 'header') continue;
    const k = monthKey(items[row.start].time);
    if (k === prev) continue;
    prev = k;
    out.push({ key: k, year: Number(k.slice(0, 4)), label: monthLabel(k), top: row.top });
  }
  return out;
}

// The month shown at a scroll offset: the last entry whose top is at or above it.
export function monthAt(table, y) {
  if (!table.length) return null;
  let lo = 0, hi = table.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid].top <= y + 1) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return table[ans];
}

// Year labels on a track `trackH` pixels tall, skipping labels closer than `minGap`.
export function scrubberMarks(table, totalH, trackH, minGap = 18) {
  const marks = [];
  let lastYear = null, lastPos = -Infinity;
  for (const m of table) {
    if (m.year === lastYear) continue;
    lastYear = m.year;
    const pos = totalH > 0 ? Math.round((m.top / totalH) * trackH) : 0;
    if (pos - lastPos < minGap) continue;
    marks.push({ year: m.year, key: m.key, pos });
    lastPos = pos;
  }
  return marks;
}

// A pointer at `pos` on the track: the month to jump to.
export function monthAtTrack(table, pos, totalH, trackH) {
  if (!table.length || trackH <= 0) return null;
  const frac = Math.max(0, Math.min(1, pos / trackH));
  return monthAt(table, frac * totalH);
}

// ── Selection ──────────────────────────────────────────────────────────────

/**
 * Apply a click to a selection.
 * @param {Set<string>} sel   current selection (not changed)
 * @param {string[]} ids      ids in view order
 * @param {number} index      clicked item
 * @param {{ shift?: boolean, toggle?: boolean, anchor?: number }} o
 * @returns {{ sel: Set<string>, anchor: number }}
 */
export function clickSelect(sel, ids, index, { shift = false, toggle = false, anchor = -1 } = {}) {
  const id = ids[index];
  if (shift && anchor >= 0 && anchor < ids.length) {
    const next = toggle ? new Set(sel) : new Set();
    for (const x of rangeIds(ids, anchor, index)) next.add(x);
    return { sel: next, anchor };
  }
  if (toggle) {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { sel: next, anchor: index };
  }
  return { sel: new Set([id]), anchor: index };
}

export function rangeIds(ids, a, b) {
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(ids.length - 1, Math.max(a, b));
  return ids.slice(lo, hi + 1);
}

// Select every item of a day (or month) header; if all are already selected, clear them.
export function toggleGroup(sel, ids, start, count) {
  const group = ids.slice(start, start + count);
  const next = new Set(sel);
  const all = group.every(id => next.has(id));
  for (const id of group) { if (all) next.delete(id); else next.add(id); }
  return next;
}

// ── Stacks (row B9) ────────────────────────────────────────────────────────

/**
 * One tile per stack. `stackOf` maps a record id to its stack ({ top, members }), as
 * stacks.js buildStacks gives. Only members present in `items` count: the stack shows its
 * top when the top is present, else its first present member, at that member's place.
 * @returns {{ items: object[], members: Map<string, string[]> }}  members: shown id -> present member ids (top first)
 */
export function collapseStacks(items, stackOf) {
  if (!stackOf?.size) return { items, members: new Map() };
  const present = new Map(); // stack -> present ids in item order
  for (const r of items) {
    const st = stackOf.get(r.id);
    if (!st) continue;
    if (!present.has(st)) present.set(st, []);
    present.get(st).push(r.id);
  }
  const shown = new Map(); // shown id -> member ids
  for (const [st, list] of present) {
    if (list.length < 2) continue;
    const head = list.includes(st.top) ? st.top : list[0];
    const rank = new Map(st.members.map((id, i) => [id, i]));
    shown.set(head, [head, ...list.filter(id => id !== head).sort((a, b) => rank.get(a) - rank.get(b))]);
  }
  const hidden = new Set();
  for (const m of shown.values()) for (const id of m.slice(1)) hidden.add(id);
  return { items: items.filter(r => !hidden.has(r.id)), members: shown };
}
