// Editor commands (row N5) against a fake editor: a real History, a fake event bus and a fake
// op runner that commits each op event the way oprunner.js does. Then the WebMCP door (row N6)
// against a fake navigator.modelContext.

import assert from 'node:assert/strict';
import { History } from '../src/core/history.js';
import { COMMANDS, runCommand } from '../src/library/commands.js';
import { EDITOR_COMMANDS } from '../src/editor/commands.js';

let n = 0;
const failed = [];
const check = async (fn, msg) => {
  try { await fn(); n++; console.log('ok', msg); }
  catch (e) { failed.push(msg); console.log('FAIL', msg, '\n ', e.message.split('\n').join('\n  ')); }
};

// ── a fake editor ──────────────────────────────────────────────────────────────────────
function fakeEditor({ image = true, folder = false } = {}) {
  const bus = new Map();
  const on = (t, fn) => { if (!bus.has(t)) bus.set(t, new Set()); bus.get(t).add(fn); };
  const off = (t, fn) => bus.get(t)?.delete(fn);
  const emit = (t, d) => bus.get(t)?.forEach(fn => fn(d));
  const state = {
    image: { working: image ? { width: 800, height: 600 } : null, width: 800, height: 600, format: 'jpeg' },
    session: { files: [{ name: 'goa.jpg' }], currentIndex: 0, folderHandle: folder ? {} : null },
    selection: { shape: null, x: 0, y: 0, w: 0, h: 0 },
    layers: [], history: new History(),
    export: { format: 'tiff', quality: 50, saveMode: 'overwrite' },
  };
  const emitted = [];
  const later = fn => setTimeout(fn, 1); // ops are async in the real runner
  const commit = (op, params) => later(() => { state.history.push(op, params); emitted.push([op, params]); emit('history:changed', {}); });
  for (const op of ['rotate', 'flip', 'resize', 'adjust', 'sharpen', 'straighten']) on(`op:${op}`, p => commit(op, p));
  on('op:crop', () => { const { x, y, w, h } = state.selection; commit('crop', { x, y, w, h }); });
  on('history:undo', () => later(() => { state.history.stepBack(); emit('history:changed', {}); }));
  let saveFails = false;
  on('save:request', () => later(() => {
    if (saveFails) return emit('error', { message: 'Save failed: disk full' });
    const ext = state.export.format === 'jpeg' ? 'jpg' : state.export.format;
    const name = `goa-261116120000.${ext}`;
    emit('toast', { message: state.export.saveMode === 'sidecar' ? `Saved as ${name}` : `Downloaded ${name}`, level: 'ok' });
    emit('save:complete', null);
  }));
  const editor = { state, emit, on, off, flatten: c => c };
  return { editor, state, emitted, failSave: () => { saveFails = true; } };
}

const run = (name, args, ctx) => runCommand({}, name, args, ctx);

await check(() => {
  assert.equal(EDITOR_COMMANDS.length, 12);
  for (const c of EDITOR_COMMANDS) assert.ok(COMMANDS.includes(c), `${c.name} is in the manifest list`);
  assert.ok(COMMANDS.length <= 64, `${COMMANDS.length} commands`);
  assert.deepEqual(EDITOR_COMMANDS.filter(c => c.scope === 'destructive'), []);
}, 'the 12 editor commands join the manifest, none destructive, total at most 64');

await check(async () => {
  const { editor } = fakeEditor();
  const out = await run('image.info', {}, { editor });
  assert.deepEqual(out, { open: true, name: 'goa.jpg', w: 800, h: 600, format: 'jpeg', history: 0, edits: 0, canUndo: false, canRedo: false, layers: 0 });
  assert.deepEqual(await run('image.info', {}, { editor: fakeEditor({ image: false }).editor }), { open: false });
}, 'image.info reports the open image, or open: false');

await check(async () => {
  const { editor, emitted, state } = fakeEditor();
  let out = await run('image.crop', { x: 10, y: 20, w: 100, h: 50 }, { editor });
  assert.deepEqual(emitted.at(-1), ['crop', { x: 10, y: 20, w: 100, h: 50 }]);
  assert.equal(state.selection.shape, 'rect');
  assert.equal(out.edits, 1);
  out = await run('image.rotate', { deg: -90 }, { editor });
  assert.deepEqual(emitted.at(-1), ['rotate', { deg: -90 }]);
  await run('image.flip', { axis: 'v' }, { editor });
  assert.deepEqual(emitted.at(-1), ['flip', { axis: 'v' }]);
  await run('image.resize', { w: 400, h: 300 }, { editor });
  assert.deepEqual(emitted.at(-1), ['resize', { w: 400, h: 300 }]);
  await run('image.adjust', { exposure: 20, saturation: 150 }, { editor });
  assert.deepEqual(emitted.at(-1), ['adjust', { brightness: 20, contrast: 0, saturation: 150 }]);
  await run('image.sharpen', { amount: 1.5 }, { editor });
  assert.deepEqual(emitted.at(-1), ['sharpen', { amount: 1.5 }]);
  out = await run('image.straighten', { angle: -3.5 }, { editor });
  assert.deepEqual(emitted.at(-1), ['straighten', { deg: -3.5 }]);
  assert.equal(out.edits, 7);
  assert.equal(state.history.pointer, 6);
}, 'each edit emits the button\'s op event and returns once the history pointer moves');

await check(async () => {
  const { editor, state } = fakeEditor();
  await run('image.rotate', { deg: 90 }, { editor });
  await run('image.flip', { axis: 'h' }, { editor });
  const out = await run('image.undo', {}, { editor });
  assert.equal(state.history.pointer, 0);
  assert.equal(out.edits, 1);
  assert.equal(out.canRedo, true);
  await run('image.undo', {}, { editor });
  await assert.rejects(run('image.undo', {}, { editor }), /nothing to undo/);
}, 'image.undo steps the history back and refuses at the start');

await check(async () => {
  const { editor, emitted } = fakeEditor();
  await assert.rejects(run('image.rotate', { deg: 45 }, { editor }), /90, -90 or 180/);
  await assert.rejects(run('image.flip', { axis: 'x' }, { editor }), /h or v/);
  await assert.rejects(run('image.crop', { x: 700, y: 0, w: 200, h: 10 }, { editor }), /w must be/);
  await assert.rejects(run('image.adjust', {}, { editor }), /other than 0/);
  await assert.rejects(run('image.adjust', { contrast: 150 }, { editor }), /contrast/);
  await assert.rejects(run('image.straighten', { angle: 0 }, { editor }), /not be 0/);
  await assert.rejects(run('image.sharpen', {}, { editor }), /amount is required/);
  const none = fakeEditor({ image: false }).editor;
  for (const name of ['image.crop', 'image.rotate', 'image.export', 'image.snapshot', 'image.undo'])
    await assert.rejects(run(name, { x: 0, y: 0, w: 1, h: 1, deg: 90 }, { editor: none }), /no image is open/, name);
  assert.equal(emitted.length, 0);
}, 'bad arguments and a missing image are refused before any op runs');

await check(async () => {
  const { editor, state } = fakeEditor();
  const out = await run('image.export', { format: 'jpeg', quality: 80 }, { editor });
  assert.deepEqual(out, { saved: true, name: 'goa-261116120000.jpg', to: 'download', format: 'jpeg' });
  assert.deepEqual(state.export, { format: 'tiff', quality: 50, saveMode: 'overwrite' }, 'export settings restored');
  const f = fakeEditor({ folder: true });
  const out2 = await run('image.export', {}, { editor: f.editor });
  assert.deepEqual(out2, { saved: true, name: 'goa-261116120000.png', to: 'folder', format: 'png' });
  const g = fakeEditor(); g.failSave();
  await assert.rejects(run('image.export', {}, { editor: g.editor }), /disk full/);
  assert.equal(g.state.export.saveMode, 'overwrite');
}, 'image.export saves to the folder or a download, never overwrite, and returns the file name');

await check(async () => {
  const draws = [];
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { fillRect() {}, drawImage: (...a) => draws.push(a) }; }
    async convertToBlob({ type, quality }) { return new Blob([new Uint8Array(quality > 0.5 ? 300000 : 30000)], { type }); }
  };
  const { editor } = fakeEditor();
  editor.state.image.working = { width: 4000, height: 3000 };
  const out = await run('image.snapshot', {}, { editor });
  assert.equal(out.w, 512); assert.equal(out.h, 384);
  assert.ok(out.dataUrl.startsWith('data:image/jpeg;base64,'));
  assert.ok(out.dataUrl.length <= 250000, `${out.dataUrl.length} chars`);
  assert.deepEqual(draws.at(-1).slice(1), [0, 0, 512, 384]);
}, 'image.snapshot returns a JPEG data URL at most 512 px and under 256 KB');

await check(async () => {
  const { editor } = fakeEditor();
  const opened = [];
  const lib = { get: id => ({ 'r/a.jpg': { kind: 'photo' }, 'r/v.mp4': { kind: 'video' } })[id] };
  const ui = { openInEditor: async id => { opened.push(id); } };
  const out = await runCommand(lib, 'image.open', { id: 'r/a.jpg' }, { ui, editor });
  assert.deepEqual(opened, ['r/a.jpg']);
  assert.equal(out.name, 'goa.jpg');
  await assert.rejects(runCommand(lib, 'image.open', { id: 'r/v.mp4' }, { ui, editor }), /videos/);
  await assert.rejects(runCommand(lib, 'image.open', { id: 'nope' }, { ui, editor }), /unknown photo id/);
}, 'image.open opens a library photo through ui.openInEditor');

// ── WebMCP (row N6) ─────────────────────────────────────────────────────────────────────
globalThis.window = {};
const { registerWebMcp, initDoor, webmcpName } = await import('../src/library/door.js');
await check(() => assert.equal(registerWebMcp({}, {}), 0), 'without navigator.modelContext nothing registers');

const tools = [];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { modelContext: { registerTool: t => tools.push(t) } } });
let asked = 0, answer = false;
globalThis.confirm = () => { asked++; return answer; };
let trashed = 0;
const lib = { trash: () => { trashed++; return { changed: 1 }; }, counts: () => ({ photos: 1 }) };
initDoor(lib, { showLibrary() {} });
await check(() => {
  assert.equal(tools.length, COMMANDS.length);
  assert.deepEqual(tools.map(t => t.name), COMMANDS.map(c => webmcpName(c.name)));
  assert.ok(tools.every(t => /^slate_[a-z0-9_-]+$/.test(t.name)));
  assert.equal(webmcpName('trash.empty'), 'slate_trash_empty');
  for (const [i, t] of tools.entries()) {
    assert.equal(t.inputSchema, COMMANDS[i].input);
    assert.equal(typeof t.execute, 'function');
    assert.equal(/changes files/.test(t.description), COMMANDS[i].scope === 'destructive', t.name);
  }
}, 'initDoor registers every command as a slate_ tool with its schema; destructive ones say they change files');

await check(async () => {
  const tool = tools.find(t => t.name === 'slate_photo_trash');
  let out = await tool.execute({ ids: ['r/a.jpg'] });
  assert.equal(asked, 1); assert.equal(trashed, 0); assert.equal(out.isError, true);
  answer = true;
  out = await tool.execute({ ids: ['r/a.jpg'] });
  assert.equal(asked, 2); assert.equal(trashed, 1);
  assert.deepEqual(JSON.parse(out.content[0].text), { changed: 1 });
}, 'a destructive tool asks confirm() first and runs only on yes');

await check(async () => {
  const before = asked;
  const out = await tools.find(t => t.name === 'slate_library_stats').execute({});
  assert.equal(asked, before);
  assert.equal(out.isError, true, 'fake lib has no jobs, so the error comes back as a tool result');
  const ok = await tools.find(t => t.name === 'slate_image_info').execute({});
  assert.deepEqual(JSON.parse(ok.content[0].text), { open: false });
}, 'other tools run through runCommand without asking and return errors as results');

console.log(`test-editor-commands: ${n} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
