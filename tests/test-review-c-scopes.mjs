// Review 2026-11-17, S18, S25 (command side) and S26: the scopes in commands.json match the
// command table, photo.restore and file-moving undos are destructive, the WebMCP question
// names the count and the first file names, and the first model download needs consent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, manifest, runCommand, undoCommandFor } from '../src/library/commands.js';
import { confirmText } from '../src/library/door.js';
import { DOWNLOADS, downloadAllowed, askDownload } from '../src/editor/commands.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok -', name); }
const json = JSON.parse(readFileSync(new URL('../commands.json', import.meta.url), 'utf8'));
const scope = (name) => json.commands.find(c => c.name === name)?.scope;

await test('commands.json scopes match the command table, and file moves are destructive', () => {
  assert.deepEqual(json.commands.map(c => [c.name, c.scope]), manifest().commands.map(c => [c.name, c.scope]));
  assert.deepEqual(json.commands.map(c => [c.name, c.scope]), COMMANDS.map(c => [c.name, c.scope]));
  for (const name of ['photo.restore', 'photo.trash', 'photo.move', 'photo.rename', 'trash.empty', 'library.undo_files']) assert.equal(scope(name), 'destructive', name);
  assert.equal(scope('library.undo'), 'write');
  assert.equal(scope('image.extract_text'), 'read');
  for (const name of ['image.extract_text', 'image.lens_blur']) {
    const c = json.commands.find(x => x.name === name);
    assert.match(c.description, /Downloads .* the first time/, `${name} says it downloads`);
    assert.equal(c.input.properties.allowDownload.type, 'boolean');
  }
});

// A stand-in library with an undo log like library.js (#remember keeps { reason, fn }).
function undoLib() {
  const undone = [];
  const undoLog = new Map([['t-trash', { reason: 'trash' }], ['t-move', { reason: 'move' }], ['t-fav', { reason: 'favourite' }]]);
  return {
    undone, undoLog,
    undo(token) { const e = undoLog.get(token); if (!e) throw new Error('that change can no longer be undone'); undoLog.delete(token); undone.push(token); return { undone: e.reason }; },
  };
}

await test('library.undo takes the scope of the change: file moves go through library.undo_files', async () => {
  const lib = undoLib();
  await assert.rejects(runCommand(lib, 'library.undo', { token: 't-trash' }), /library\.undo_files/);
  await assert.rejects(runCommand(lib, 'library.undo', { token: 't-move' }), /library\.undo_files/);
  await assert.rejects(runCommand(lib, 'library.undo_files', { token: 't-fav' }), /library\.undo\b/);
  assert.deepEqual(lib.undone, []);
  assert.equal(undoCommandFor(lib, 't-trash'), 'library.undo_files');
  assert.equal(undoCommandFor(lib, 't-fav'), 'library.undo');
  await runCommand(lib, 'library.undo', { token: 't-fav' });
  await runCommand(lib, 'library.undo_files', { token: 't-trash' });
  assert.deepEqual(lib.undone, ['t-fav', 't-trash']);
});

await test('the WebMCP question gives the count and the first names', () => {
  const recs = new Map(Array.from({ length: 5 }, (_, i) => [`r/IMG_${i}.jpg`, { name: `IMG_${i}.jpg` }]));
  const lib = { get: (id) => recs.get(id) ?? null, records: recs, choice: (id) => ({ trashed: id !== 'r/IMG_4.jpg' }) };
  const cmd = (n) => COMMANDS.find(c => c.name === n);
  const q = confirmText(lib, cmd('photo.trash'), { ids: [...recs.keys()] });
  assert.match(q, /on 5 photos \(IMG_0\.jpg, IMG_1\.jpg, IMG_2\.jpg and 2 more\)/);
  assert.match(confirmText(lib, cmd('trash.empty'), {}), /on 4 photos/, 'Empty trash counts what is in the trash');
  assert.match(confirmText(lib, cmd('photo.move'), { moves: [{ id: 'r/IMG_0.jpg', toPath: 'a/b.jpg' }] }), /on 1 photo \(IMG_0\.jpg\)/);
  assert.match(confirmText(lib, cmd('photo.restore'), { ids: ['r/IMG_1.jpg'] }), /Restore from trash.*1 photo/);
});

await test('the first download needs allowDownload: true from an agent, or a yes from the person', async () => {
  const editor = { state: { image: { working: { width: 4, height: 4 } } }, flatten: (c) => c, emit() {}, on() {}, off() {} };
  assert.equal(downloadAllowed('ocr'), false);
  await assert.rejects(runCommand({}, 'image.extract_text', {}, { editor }), /allowDownload: true/);
  await assert.rejects(runCommand({}, 'image.lens_blur', { x: 0.5, y: 0.5 }, { editor }), /allowDownload: true/);
  assert.equal(askDownload('depth', () => false), false, 'the person said no');
  assert.equal(downloadAllowed('depth'), false);
  let asked = '';
  assert.equal(askDownload('depth', (q) => { asked = q; return true; }), true);
  assert.match(asked, /downloads .*depth model.*MB/i);
  assert.equal(downloadAllowed('depth'), true, 'asked once');
  assert.equal(askDownload('depth', () => { throw new Error('asked twice'); }), true);
  assert.ok(DOWNLOADS.ocr.what().includes('5 MB'));
});

console.log(`test-review-c-scopes: ${passed} passed`);
