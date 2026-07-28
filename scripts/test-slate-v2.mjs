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

console.log('Slate v2.0 onboarding contract: PASS');
