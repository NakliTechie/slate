// Extract text (src/ops/ocr.js): the pinned library URL and the text clean-up. Recognition itself
// runs only in the browser (scripts/live-check-ocr.mjs).
import assert from 'node:assert/strict';
import { TESSERACT_URL, cleanText } from '../src/ops/ocr.js';
assert.match(TESSERACT_URL, /^https:\/\/esm\.sh\/tesseract\.js@\d+\.\d+\.\d+$/, 'tesseract.js is pinned to an exact version');
assert.equal(cleanText('  Invoice 2047   \n\n\n\nPaid  \n'), 'Invoice 2047\n\nPaid');
assert.equal(cleanText(null), '');
console.log('Slate extract text: PASS');
