#!/usr/bin/env node
// Runs every test: scripts/test-slate-v2.mjs and tests/test-*.mjs, each in its own process.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = ['scripts/test-slate-v2.mjs', ...readdirSync('tests').filter(f => /^test-.*\.mjs$/.test(f)).sort().map(f => `tests/${f}`)];
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [f], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`FAIL ${f}`); }
}
console.log(`${files.length - failed} of ${files.length} test files pass`);
process.exit(failed ? 1 : 0);
