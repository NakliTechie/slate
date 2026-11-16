// Embedded edit list (src/encode/recipe.js): build, embed and read back in PNG and JPEG.
import assert from 'node:assert/strict';
import { buildRecipe, parseRecipe, embedRecipePNG, readRecipePNG, embedRecipeJPEG, readRecipeJPEG, crc32, readRecipe } from '../src/encode/recipe.js';

// a minimal valid PNG: signature, IHDR, IDAT, IEND (content need not decode for this test)
const chunk = (type, data) => {
  const t = new TextEncoder().encode(type), out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(t, 4); out.set(data, 8);
  const c = new Uint8Array(4 + data.length); c.set(t); c.set(data, 4); dv.setUint32(8 + data.length, crc32(c));
  return out;
};
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', new Uint8Array(13)), ...chunk('IDAT', new Uint8Array(4)), ...chunk('IEND', new Uint8Array(0))]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xe1, 0, 4, 1, 2, 0xff, 0xda, 0, 2, 9, 9, 0xff, 0xd9]);

const ops = [{ op: 'crop', params: { x: 1, y: 2, w: 30, h: 40 } }, { op: 'adjust', params: { brightness: 25, contrast: 0, saturation: 10 } },
  { op: 'lut', params: { name: 'film.cube', size: 33, data: new Float32Array(10), strength: 70 } }, { op: 'text', params: { content: 'Café' } }];
const json = buildRecipe(ops, { w: 30, h: 40 });
assert.ok(/^[\x00-\x7f]*$/.test(json), 'recipe JSON is ASCII');
const r = parseRecipe(json);
assert.equal(r.ops.length, 4);
assert.equal(r.ops[2].params.data, undefined, 'LUT table is not embedded');
assert.equal(r.ops[2].params.strength, 70);
assert.equal(r.ops[3].params.content, 'Café', 'non-ASCII survives via \\u escapes');
assert.equal(buildRecipe([]), null, 'no ops, no recipe');

const p2 = embedRecipePNG(png, json);
assert.equal(readRecipePNG(p2), json, 'PNG round trip');
assert.deepEqual([...p2.slice(-12)], [...png.slice(-12)], 'IEND stays last');
assert.equal(readRecipePNG(png), null);

const j2 = embedRecipeJPEG(jpeg, json);
assert.equal(readRecipeJPEG(j2), json, 'JPEG round trip');
assert.deepEqual([...j2.slice(2, 22)], [...jpeg.slice(2, 22)], 'APP0 stays first');
const comAt = j2.indexOf(0xfe, 20);
assert.ok(comAt > 26, 'COM lands after APP0 and APP1');
assert.equal(readRecipeJPEG(jpeg), null);

assert.deepEqual((await readRecipe(new Blob([j2]))).ops.length, 4, 'readRecipe on a Blob (JPEG)');
assert.deepEqual((await readRecipe(new Blob([p2]))).ops.length, 4, 'readRecipe on a Blob (PNG)');
assert.equal(await readRecipe(new Blob([new Uint8Array([1, 2, 3])])), null);
console.log('Slate embedded edit list: PASS');
