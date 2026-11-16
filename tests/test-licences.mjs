// Licences: every vendored file carries a header naming the package, version, source and
// full licence text; every bundled package's licence text is in the built index.html; and
// every package in SECURITY.md's supply-chain table is in src/library/licences.js.
// Run after `node build/inline.mjs`.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LICENCES } from '../src/library/licences.js';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const security = readFileSync(new URL('SECURITY.md', root), 'utf8');
const vendorDir = new URL('src/vendor/', root);
const norm = s => s.replace(/\s+/g, ' ').trim();

let n = 0;
const failed = [];
const check = (fn, msg) => {
  try { fn(); n++; console.log('ok', msg); }
  catch (e) { failed.push(msg); console.log('FAIL', msg, '\n ', e.message); }
};

// The licence text inside a vendored file's first comment: from "MIT License" or the first
// "Copyright" line to the end of the comment, with the " * " prefixes removed.
function headerOf(src) {
  if (!src.startsWith('/*')) return null;
  const lines = src.slice(0, src.indexOf('*/')).split('\n').map(l => l.replace(/^\/?\s?\*\s?/, ''));
  const start = lines.findIndex(l => /^(MIT License|Copyright|Apache License)/.test(l));
  return { head: lines.join('\n'), licence: start < 0 ? '' : lines.slice(start).join('\n').trim() };
}

const bundled = LICENCES.filter(l => l.loaded === 'bundled');

for (const f of readdirSync(vendorDir).filter(f => /\.m?js$/.test(f))) {
  const src = readFileSync(new URL(f, vendorDir), 'utf8');
  check(() => {
    const h = headerOf(src);
    assert.ok(h, `${f} has no header comment at the top`);
    const entry = bundled.find(l => h.head.includes(`${l.name} ${l.version}`));
    assert.ok(entry, `${f}: header names no bundled package and version from licences.js`);
    assert.match(h.head, /Source: https?:\/\//, `${f}: header names no source`);
    assert.match(h.licence, /Permission is hereby granted|Apache License|GNU/, `${f}: header has no licence text`);
    assert.ok(norm(entry.text).includes(norm(h.licence)) && norm(h.licence).length >= norm(entry.text).length - 20,
      `${f}: header licence text differs from licences.js`);
  }, `src/vendor/${f} carries package, version, source and licence text`);
}

for (const l of bundled) {
  check(() => {
    assert.ok(l.text && l.text.length > 200, `${l.name}: no licence text in licences.js`);
    assert.ok(html.includes(l.text), `${l.name}: licence text missing from index.html`);
  }, `bundled ${l.name} licence text is in index.html`);
}

check(() => {
  for (const l of LICENCES) {
    for (const k of ['name', 'version', 'licence', 'loaded', 'use', 'source']) assert.ok(l[k], `${l.name}: ${k} missing`);
    assert.ok(['bundled', 'esm.sh'].includes(l.loaded), `${l.name}: loaded is bundled or esm.sh`);
  }
}, 'every licences.js entry has name, version, licence, loading and source');

check(() => {
  // The supply-chain table in SECURITY.md names every package Slate loads, as `name@version`.
  const table = security.slice(security.indexOf('|'), security.indexOf('## Vendored modules'));
  const names = [...new Set([...table.matchAll(/`((?:@[a-z0-9-]+\/)?[a-z0-9._-]+)@\d[^`]*`/g)].map(m => m[1]))];
  assert.ok(names.length > 0, 'SECURITY.md has no supply-chain table');
  const missing = names.filter(name => !LICENCES.some(l => l.name === name));
  assert.deepEqual(missing, [], 'SECURITY.md packages missing from licences.js');
}, 'every package in the SECURITY.md supply-chain table is in licences.js');

check(() => assert.match(html, /'Licences'/), 'Help has a Licences section');

console.log(`test-licences: ${n} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
