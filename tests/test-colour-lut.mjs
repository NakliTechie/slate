// Linear-light adjustments (src/ops/colour.js) and .cube LUTs (src/ops/lut.js).
import assert from 'node:assert/strict';
import { srgbToLinear, linearToSrgb, linearToOklab, oklabToLinear, adjustFactors, adjustLinear, adjustPixels } from '../src/ops/colour.js';
import { parseCube, lookup, lutPixels } from '../src/ops/lut.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// transfer functions round-trip
for (const v of [0, 0.01, 0.2, 0.5, 0.9, 1]) near(linearToSrgb(srgbToLinear(v)), v, 1e-9, `sRGB round trip ${v}`);
// Oklab round-trips and white is L=1, a=b=0
const [L, A, B] = linearToOklab(1, 1, 1);
near(L, 1, 1e-4, 'white L'); near(A, 0, 1e-4, 'white a'); near(B, 0, 1e-4, 'white b');
const rt = oklabToLinear(...linearToOklab(0.3, 0.6, 0.1));
[0.3, 0.6, 0.1].forEach((v, i) => near(rt[i], v, 1e-6, 'Oklab round trip'));

// neutral settings leave pixels unchanged
const px = new Uint8ClampedArray([12, 128, 250, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
assert.deepEqual([...adjustPixels(px.slice(), {})], [...px], 'zero adjustment is the identity');

// +1 stop doubles linear light (+50 on the slider)
const f = adjustFactors({ brightness: 50 });
near(f.gain, 2, 1e-12, '+50 is one stop');
near(adjustLinear(0.1, 0.1, 0.1, f)[0], 0.2, 1e-12, 'exposure doubles linear values');

// contrast keeps black and middle grey, spreads the rest
const k = adjustFactors({ contrast: 50 });
near(adjustLinear(0.18, 0.18, 0.18, k)[0], 0.18, 1e-12, 'middle grey is the pivot');
assert.equal(adjustLinear(0, 0, 0, k)[0], 0, 'black stays black');
assert.ok(adjustLinear(0.5, 0.5, 0.5, k)[0] > 0.5, 'contrast lifts values above grey');
assert.ok(adjustLinear(0.05, 0.05, 0.05, k)[0] < 0.05, 'and lowers values below grey');

// saturation -100 gives a neutral grey at the same Oklab lightness; hue holds when saturating
const grey = adjustLinear(0.6, 0.2, 0.1, adjustFactors({ saturation: -100 }));
near(grey[0], grey[1], 1e-6, 'desaturated R=G'); near(grey[1], grey[2], 1e-6, 'desaturated G=B');
near(linearToOklab(...grey)[0], linearToOklab(0.6, 0.2, 0.1)[0], 1e-6, 'lightness kept');
const [, a0, b0] = linearToOklab(0.6, 0.2, 0.1);
const [, a1, b1] = linearToOklab(...adjustLinear(0.6, 0.2, 0.1, adjustFactors({ saturation: 50 })));
near(Math.atan2(b1, a1), Math.atan2(b0, a0), 1e-6, 'hue angle kept when saturating');

// .cube parsing: identity LUT of size 2 and a channel swap
const identity = `TITLE "identity"\n# comment\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`;
const id = parseCube(identity);
assert.equal(id.size, 2); assert.equal(id.title, 'identity');
const mid = lookup(id, 0.25, 0.5, 0.75);
[0.25, 0.5, 0.75].forEach((v, i) => near(mid[i], v, 1e-6, 'identity LUT is trilinear-exact'));
const swap = parseCube(identity.replace(/\n(\d) (\d) (\d)/g, '\n$3 $2 $1').replace('TITLE "identity"', ''));
const sw = lookup(swap, 0.2, 0.4, 0.9);
near(sw[0], 0.9, 1e-6, 'swap LUT red from blue'); near(sw[2], 0.2, 1e-6, 'swap LUT blue from red');
const buf = new Uint8ClampedArray([200, 100, 50, 255]);
lutPixels(buf, swap, 50);
assert.deepEqual([...buf], [125, 100, 125, 255], 'strength 50% blends halfway');
assert.throws(() => parseCube('LUT_3D_SIZE 3\n0 0 0\n'), /expected 27 entries/);
assert.throws(() => parseCube('LUT_1D_SIZE 4\n'), /1D LUTs/);

console.log('Slate colour and LUT: PASS');
