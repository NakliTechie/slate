import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

for (const [index, match] of [...html.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)].entries()) {
  assert.doesNotThrow(() => new Function(match[1]), `inline Slate script ${index + 1} parses`);
}

assert.match(html, /const TOUR_KEY = 'slate\.v2\.tour-complete'/, 'tour has a durable completion key');
assert.match(
  html,
  /const STEPS = \[[\s\S]*?target: '\.dropzone-actions'[\s\S]*?target: '#tb-help'/,
  'tour walks real controls from opening an image through permanent help',
);
assert.equal(
  (html.match(/target: '(?:[^']+)'/g) || []).filter((entry) =>
    ['.dropzone-actions', '#toolbar', '#tb-crop', '#right-sidebar', '#tb-save', '#tb-help']
      .some((target) => entry.includes(target))).length,
  6,
  'tour remains a focused six-step walkthrough',
);
assert.match(html, /role="dialog" aria-modal="true"/, 'tour identifies itself as a modal dialog');
assert.match(
  html,
  /event\.key !== 'Tab'[\s\S]*?const first[\s\S]*?last\.focus\(\)[\s\S]*?first\.focus\(\)/,
  'tour traps keyboard focus',
);
assert.match(html, /event\.key === 'Escape'[\s\S]*?finishTour\(\)/, 'Escape dismisses and records the tour');
assert.match(
  html,
  /modal owns every key[\s\S]*?event\.stopPropagation\(\)[\s\S]*?event\.key === 'Enter'/,
  'modal tour blocks every key before handling its own keyboard actions',
);
assert.match(
  html,
  /event\.key === 'Enter'[\s\S]*?tour-actions button[\s\S]*?event\.target\.click\(\)/,
  'Enter and Space activate the focused tour action',
);
assert.match(
  html,
  /prefers-reduced-motion: reduce[\s\S]*?transition-duration: 0\.01ms/,
  'tour motion respects reduced-motion settings',
);
assert.match(html, /id="help-start-tour"/, 'Help offers a permanent tour replay action');
assert.match(html, /showTour\(\{ force: true \}\)/, 'Help can replay a completed tour');
assert.match(
  html,
  /function targetIsVisible[\s\S]*?rect\.width > 0 && rect\.height > 0[\s\S]*?STEPS\.filter\(targetIsVisible\)/,
  'tour replay skips controls hidden by the current editor state',
);
assert.match(html, /id="app-version">Slate v2\.0\.0/, 'the shipped footer visibly reports the honest version');
assert.match(readme, /Current release: \*\*Slate v2\.0\.0\*\*/, 'README reports the shipped version');
assert.match(
  readme,
  /animation timeline[\s\S]*?intentionally out of scope/i,
  'public backlog position excludes animation editing',
);

// ── Read-only formats (HEIC, TIFF, RAW, PSD…) survive the batch pipeline ──────

assert.match(
  html,
  /const WORKER_DECODABLE = new Set\(\['jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'\]\)/,
  'batch knows which formats a worker can open unaided',
);
assert.match(
  html,
  /const needsMainThreadDecode = !WORKER_DECODABLE\.has\(formatOf\(job\.src\.file\)\)[\s\S]*?await decode\(job\.src\.file\)/,
  'batch decodes worker-opaque formats through the main-thread registry',
);
assert.match(
  html,
  /w\.postMessage\(\{ id, \.\.\.payload \}, transfer\)/,
  'the decoded bitmap is transferred to the worker rather than copied',
);
assert.match(
  html,
  /const bitmap = preDecoded \?\? await createImageBitmap\(file\)/,
  'the worker prefers a pre-decoded bitmap and still opens plain formats itself',
);

// ── Output bytes always match the extension they are written under ────────────

assert.match(
  html,
  /const ENCODABLE = new Set\(\['png', 'jpeg', 'webp'\]\)/,
  'batch distinguishes formats it can write from formats it can only read',
);
assert.match(
  html,
  /function outputFormatFor[\s\S]*?ENCODABLE\.has\(srcFmt\) \? srcFmt : 'png'/,
  'an unwritable source format falls back to lossless PNG instead of mislabelled JPEG',
);
assert.match(
  html,
  /dest\.mode === 'overwrite' && outFmt !== formatOf\(job\.src\.file\)[\s\S]*?throw new Error/,
  'batch refuses to overwrite an original with bytes of a different container',
);
assert.match(
  html,
  /const srcFmt = formatOf\(entry\.file \?\? entry\)[\s\S]*?srcFmt !== 'unknown' && srcFmt !== exp\.format[\s\S]*?emit\('error'/,
  'single-image save refuses to overwrite a HEIC with PNG or JPEG data',
);
assert.match(
  readme,
  /Open a HEIC off your phone, edit it, export it as PNG, JPEG, WebP or TIFF/,
  'README documents the read-only-format conversion path',
);
assert.match(
  html,
  /\$\{section\('Formats', `[\s\S]*?Anything Slate can read, it can convert[\s\S]*?Overwrite<\/strong> is unavailable for them/,
  'Help explains what converts, and why overwrite is unavailable for read-only formats',
);
assert.match(
  html,
  /\$\{section\('Batch conversion', `[\s\S]*?saved as lossless PNG instead/,
  'Help documents the batch fallback for read-only formats',
);

// ── A missing lazy decoder is not reported as a corrupt file ─────────────────

assert.match(
  html,
  /function decodeFailureMessage[\s\S]*?decoder\|connection\|network[\s\S]*?Could not open \$\{name\}: \$\{reason\}/,
  'a decoder that failed to load reports the real reason instead of blaming the file',
);
assert.equal(
  (html.match(/Could not decode \$\{(?:file|entry)\.name\}\. The file may be corrupted\./g) || []).length,
  0,
  'no loader still hardcodes the corrupt-file message',
);

console.log('Slate v2.0 onboarding contract: PASS');
console.log('Slate HEIC / read-only format contract: PASS');
