// Review finding S8: the built index.html carries a content security policy that allows every
// host licences.js names, dist/_headers repeats it, and the four esm.sh decoders load only
// through the hash-checked loader (src/decode/pinned.js). Run after `node build/inline.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LICENCES } from '../src/library/licences.js';
import { PINS, ENTRIES, ALIASES, esmImports, rewriteImports, fetchPinned } from '../src/decode/pinned.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0;
const ok = (msg) => { n++; console.log('ok', msg); };

const html = read('index.html');
const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
assert.ok(meta, 'the built index.html has a Content-Security-Policy meta tag');
assert.ok(html.indexOf(meta[0]) < html.indexOf('<script'), 'the policy comes before the first script');
const policy = Object.fromEntries(meta[1].split(';').map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
ok('the built index.html has a CSP meta tag before any script');

const HOST = { 'esm.sh': 'https://esm.sh', jsdelivr: 'https://cdn.jsdelivr.net', huggingface: 'https://huggingface.co' };
const loaded = [...new Set(LICENCES.map(l => l.loaded))];
for (const kind of loaded) assert.ok(['bundled', 'same-origin', ...Object.keys(HOST)].includes(kind), `licences.js loading "${kind}" has a host mapping`);
for (const kind of loaded.filter(k => HOST[k])) {
  assert.ok(policy['connect-src'].includes(HOST[kind]), `connect-src allows ${HOST[kind]}`);
  if (kind !== 'huggingface') {
    assert.ok(policy['script-src'].includes(HOST[kind]), `script-src allows ${HOST[kind]}`);
    assert.ok(policy['worker-src'].includes(HOST[kind]), `worker-src allows ${HOST[kind]}`);
  }
}
ok(`the policy names every host in licences.js (${loaded.filter(k => HOST[k]).map(k => HOST[k]).join(', ')})`);

assert.ok(policy['connect-src'].includes('https://*.hf.co'), 'connect-src allows the Hugging Face file CDN that model downloads redirect to');
for (const [d, v] of [['script-src', 'blob:'], ['script-src', "'wasm-unsafe-eval'"], ['worker-src', 'blob:'], ['img-src', 'data:'], ['img-src', 'blob:'], ['media-src', 'blob:'], ['connect-src', 'blob:']]) {
  assert.ok(policy[d]?.includes(v), `${d} allows ${v}`);
}
assert.deepEqual(policy['object-src'], ["'none'"]);
assert.deepEqual(policy['base-uri'], ["'none'"]);
assert.ok(!meta[1].includes("'unsafe-eval'"), 'no unsafe-eval');
assert.ok(!policy['connect-src'].includes("'none'"), 'connect-src is not none');
assert.ok(!('frame-ancestors' in policy), 'frame-ancestors is left to the response headers');
ok('blob workers, WebAssembly, thumbnails and model redirects are allowed; object-src and base-uri are none');

const headers = read('dist/_headers');
assert.ok(headers.includes(`Content-Security-Policy: ${meta[1]}; frame-ancestors `), 'dist/_headers repeats the meta policy and adds frame-ancestors');
assert.ok(!/X-Frame-Options: DENY/.test(headers), 'no X-Frame-Options DENY, which would block NakliOS');
ok('dist/_headers carries the same policy plus frame-ancestors');

// The four decoders import only through the pinned loader.
for (const f of ['tiff', 'heic', 'jxl', 'psd']) {
  const src = read(`src/decode/${f}.js`);
  assert.ok(!/import\(\s*['"`]?https?:/.test(src) && !/https:\/\/esm\.sh/.test(src), `${f}.js has no direct esm.sh import`);
  assert.match(src, /importPinned\(ENTRIES\./, `${f}.js loads through importPinned`);
}
for (const p of Object.values(ENTRIES)) assert.ok(PINS[p], `${p} is pinned`);
for (const p of Object.values(ALIASES)) assert.ok(PINS[p], `alias target ${p} is pinned`);
for (const h of Object.values(PINS)) assert.match(h, /^[0-9a-f]{64}$/);
const security = read('SECURITY.md');
for (const [p, h] of Object.entries(PINS)) assert.ok(security.includes(p) && security.includes(h), `SECURITY.md lists ${p} with its hash`);
ok('tiff, heic, jxl and psd load through importPinned; every pin is in SECURITY.md');

// Import rewriting covers the shapes esm.sh writes, and refuses an import with no checked copy.
const sample = 'import __P$ from "/node/process.mjs";\nimport*as __0$ from"/pako@^1.0.5?target=es2022";export{a}from"/x.mjs";';
assert.deepEqual(esmImports(sample), ['/node/process.mjs', '/pako@^1.0.5?target=es2022', '/x.mjs']);
const rewritten = rewriteImports(sample, { '/node/process.mjs': 'blob:a', '/pako@^1.0.5?target=es2022': 'blob:b', '/x.mjs': 'blob:c' });
assert.equal(rewritten, 'import __P$ from "blob:a";\nimport*as __0$ from"blob:b";export{a}from"blob:c";');
assert.throws(() => rewriteImports(sample, {}), /no checked copy/);
ok('esm.sh import specifiers are found and rewritten; an unpinned one is refused');

// fetchPinned returns matching bytes and refuses changed bytes or an unpinned path.
const path = '/base64-js@1.5.1/es2022/base64-js.mjs';
const good = Buffer.from('pretend module');
const fakeFetch = (bytes) => async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const saved = PINS[path];
PINS[path] = createHash('sha256').update(good).digest('hex');
try {
  const buf = await fetchPinned(path, fakeFetch(good));
  assert.equal(Buffer.from(buf).toString(), 'pretend module');
  await assert.rejects(fetchPinned(path, fakeFetch(Buffer.from('pretend module, changed'))), /does not match its pinned SHA-256/);
} finally { PINS[path] = saved; }
await assert.rejects(fetchPinned('/evil@1.0.0/es2022/evil.mjs', fakeFetch(good)), /not a pinned decoder file/);
ok('fetchPinned accepts the pinned bytes and refuses changed bytes and unpinned paths');

console.log(`${n} checks pass`);
