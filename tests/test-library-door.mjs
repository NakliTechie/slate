// The NakliOS door (rows N1, N2, N4): the library commands pass the host rail's checks,
// commands.json matches the code, every command ships in index.html, destructive commands
// say what they cost, and door.js registers each command with a handler that runs it.
// Run after `node build/inline.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, manifest } from '../src/library/commands.js';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const json = JSON.parse(readFileSync(new URL('commands.json', root), 'utf8'));

// ── The rail's parse() from naklios sys/host/catalog.mjs, re-implemented ─────────────────
const NAME = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){0,3}$/;
const SCOPES = ['read', 'write', 'destructive'];
const RAIL_MAX = 256;
function checkSchema(schema) {
  if (schema == null) return true;
  if (typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') return false;
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter(k => typeof k === 'string') : [];
  return required.every(k => Object.hasOwn(properties, k));
}
function railParse(defs) {
  if (!Array.isArray(defs)) return 'commands must be a list';
  if (defs.length > RAIL_MAX) return `at most ${RAIL_MAX} commands`;
  const seen = new Set();
  for (const raw of defs) {
    if (!raw || typeof raw !== 'object') return 'each command must be an object';
    const { name, description, scope } = raw;
    if (typeof name !== 'string' || !NAME.test(name)) return `invalid command name: ${String(name)}`;
    if (typeof description !== 'string' || !description.trim()) return `${name}: description is required`;
    if (!SCOPES.includes(scope)) return `${name}: scope must be read, write or destructive`;
    if (!checkSchema(raw.input)) return `${name}: input must be an object schema`;
    if (seen.has(name)) return `duplicate command: ${name}`;
    if (raw.shows !== undefined && typeof raw.shows !== 'boolean') return `${name}: shows must be true or false`;
    seen.add(name);
  }
  return null;
}

let n = 0;
const failed = [];
const check = (fn, msg) => {
  try { fn(); n++; console.log('ok', msg); }
  catch (e) { failed.push(msg); console.log('FAIL', msg, '\n ', e.message.split('\n').join('\n  ')); }
};

check(() => assert.equal(railParse(manifest().commands), null), 'manifest() passes the rail checks');
check(() => assert.equal(railParse(json.commands), null), 'commands.json passes the rail checks');
check(() => assert.deepEqual(json, JSON.parse(JSON.stringify(manifest()))), 'commands.json equals manifest()');
check(() => assert.ok(COMMANDS.length <= 64, `${COMMANDS.length} commands, at most 64 reach chat`), 'at most 64 commands');
check(() => {
  for (const c of COMMANDS) {
    assert.equal(typeof c.input, 'object', `${c.name}: input declared`);
    assert.equal(c.input.type, 'object', `${c.name}: input is an object schema`);
    for (const k of c.input.required ?? []) assert.ok(Object.hasOwn(c.input.properties, k), `${c.name}: required key ${k} declared`);
  }
}, 'every input schema declares its required keys');
check(() => {
  const missing = COMMANDS.filter(c => !html.includes(`'${c.name}'`)).map(c => c.name);
  assert.deepEqual(missing, [], 'command names missing from the built index.html');
}, 'every command name ships in index.html');
check(() => {
  // A destructive command's description says what is lost (or kept, or recoverable) or that it asks first.
  const SAYS = /permanent|cannot be undone|can be restored|stay|is lost|are lost|asks? (the person|you)? ?first/i;
  const vague = COMMANDS.filter(c => c.scope === 'destructive' && !SAYS.test(c.description)).map(c => c.name);
  assert.deepEqual(vague, [], 'destructive commands whose description says neither what is lost nor that it asks first');
}, 'destructive descriptions say what is lost or that they ask first');

// ── door.js registers every command, with a handler that runs it ──────────────────────
let registered = null;
const themeCalls = [];
globalThis.document = { documentElement: { setAttribute: (k, v) => themeCalls.push([k, v]) }, querySelector: () => null };
globalThis.window = {
  naklios: {
    capabilities: { hosted: true },
    experimental_commands: { register: list => { registered = list; return Promise.resolve({ ok: true }); } },
    theme: { onChange: cb => cb({ id: 'paper', mood: 'light' }) },
  },
};
const { initDoor } = await import('../src/library/door.js');
let shown = 0;
const fakeLib = { counts: () => ({ photos: 3 }) };
const fakeUi = { showLibrary: () => { shown++; } };
initDoor(fakeLib, fakeUi);
check(() => {
  assert.equal(registered.length, COMMANDS.length);
  assert.deepEqual(registered.map(r => r.name), COMMANDS.map(c => c.name));
  for (const r of registered) assert.equal(typeof r.handler, 'function', `${r.name} has a handler`);
  assert.equal(railParse(registered), null);
}, 'initDoor registers every command and the registration passes the rail checks');
const out = await registered.find(r => r.name === 'library.open').handler({});
check(() => { assert.equal(shown, 1); assert.equal(out.photos, 3); }, 'a registered handler runs the command with the library ui');
check(() => assert.deepEqual(themeCalls, [['data-theme', 'light']]), 'the host theme sets data-theme (row N4)');

// A rejected registration is logged, not thrown; no SDK means no-op.
window.naklios.experimental_commands.register = () => Promise.reject(new Error('host said no'));
const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
initDoor(fakeLib, fakeUi);
await new Promise(r => setTimeout(r, 0));
window.naklios = undefined;
initDoor(fakeLib, fakeUi);
console.warn = warn;
check(() => assert.equal(warned, 1), 'a failed registration is logged and swallowed; standalone is a no-op');

console.log(`test-library-door: ${n} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
