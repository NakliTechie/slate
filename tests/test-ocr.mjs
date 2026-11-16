// Extract text (src/ops/ocr.js): the pinned library URL and the text clean-up. Recognition itself
// runs only in the browser (scripts/live-check-ocr.mjs).
import assert from 'node:assert/strict';
import { TESSERACT_URL, cleanText } from '../src/ops/ocr.js';
assert.match(TESSERACT_URL, /^https:\/\/esm\.sh\/tesseract\.js@\d+\.\d+\.\d+$/, 'tesseract.js is pinned to an exact version');
assert.equal(cleanText('  Invoice 2047   \n\n\n\nPaid  \n'), 'Invoice 2047\n\nPaid');
assert.equal(cleanText(null), '');
console.log('Slate extract text: PASS');
import { confidentText } from '../src/ops/ocr.js';
{
  const w = (text, confidence) => ({ text, confidence });
  const page = (lines) => ({ blocks: [{ paragraphs: [{ lines: lines.map(words => ({ words })) }] }] });
  assert.equal(confidentText(page([[w('Platform', 95), w('9', 92), w('Departures', 96)]])), 'Platform 9 Departures', 'clear sign kept');
  assert.equal(confidentText(page([[w('Aq', 40), w('fg', 31), w('RT', 22), w('Te', 50)], [w('zo', 80), w('—', 60)]])), '', 'texture noise dropped');
  assert.equal(confidentText(page([[w('Cafe', 90), w('xq', 20), w('Open', 88)]])), 'Cafe Open', 'low-confidence words removed from a good line');
  assert.equal(confidentText(page([[w('Exit', 92)]])), '', 'a single word is not enough');
  assert.equal(confidentText({ text: 'plain' }), 'plain', 'older output shape passes through');
  console.log('Slate OCR confidence filter: PASS');
}
