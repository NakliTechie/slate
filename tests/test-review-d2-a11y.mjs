// Review S24: the viewer is modal (the rest of the Library is inert, Tab stays inside),
// and the virtual grid states its row count and each rendered row's index.
import assert from 'node:assert/strict';
import { buildLayout, ariaRowCount, ariaRowIndex } from '../src/ui/library/grid-model.js';
import { makeSiblingsInert, nextTabStop } from '../src/ui/library/photo-viewer.js';

// Grid rows: headers and tile rows both count; rows are numbered from 1.
{
  const items = [];
  for (let d = 0; d < 3; d++) for (let k = 0; k < 5; k++) items.push({ id: `r/${d}-${k}.jpg`, time: Date.UTC(2024, 0, 10 - d, 12) - k * 1000 });
  const l = buildLayout(items, { width: 3 * 148 + 2 * 4, zoom: 1 });
  assert.equal(ariaRowCount(l), l.rows.length);
  assert.equal(ariaRowCount(l), 3 * (1 + Math.ceil(5 / l.cols)));
  assert.equal(ariaRowIndex(0), 1);
  assert.equal(ariaRowIndex(l.rows.length - 1), ariaRowCount(l));
  assert.equal(ariaRowCount(buildLayout([], { width: 500 })), 0);
}

// Tab order inside the viewer wraps both ways.
{
  const [a, b, c] = ['close', 'info', 'edit'];
  assert.equal(nextTabStop([a, b, c], a), b);
  assert.equal(nextTabStop([a, b, c], c), a, 'Tab past the last goes to the first');
  assert.equal(nextTabStop([a, b, c], a, true), c, 'Shift+Tab before the first goes to the last');
  assert.equal(nextTabStop([a, b, c], 'outside'), a, 'focus outside the viewer comes back in');
  assert.equal(nextTabStop([], a), null);
}

// Siblings become inert while open; one that was inert before stays inert after.
{
  const node = (name, inert = false) => {
    const attrs = new Map(inert ? [['inert', '']] : []);
    return { name, hasAttribute: (k) => attrs.has(k), setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
  };
  const head = node('head'), body = node('body'), dialog = node('dialog', true), viewer = node('viewer');
  const parent = { children: [head, body, viewer, dialog] };
  viewer.parentElement = parent;
  const undo = makeSiblingsInert(viewer);
  assert.ok(head.hasAttribute('inert') && body.hasAttribute('inert') && dialog.hasAttribute('inert'));
  assert.ok(!viewer.hasAttribute('inert'), 'the viewer itself stays reachable');
  undo();
  assert.ok(!head.hasAttribute('inert') && !body.hasAttribute('inert'));
  assert.ok(dialog.hasAttribute('inert'), 'an element inert before opening stays inert');
}

console.log('review d2 accessibility (S24): PASS');
