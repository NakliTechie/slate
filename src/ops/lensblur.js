// Background blur (plan/pending.md, "Lens blur from a depth map, kept light"). The physics is
// AnyBokeh's relation, not its model: the blur-disc radius of a pixel grows linearly with how far
// its depth is from the focus plane, r = maxR * |d - d0|, where maxR comes from Strength.
//
// The depth map comes from src/ops/depth.js (a small in-browser model) and is stored in the op's
// params, so undo, redo and session restore replay this op without the model:
//   params = { focus: { x, y } (0..1), strength (0..100), depth: { w, h, data: Uint8Array } }
//
// Rendering is a gather blur over a weighted pyramid. Level i is the image averaged over
// 2^i x 2^i blocks, then smoothed and sampled bilinearly, so it reads as a blur of radius about
// 2^i. Each pixel blends the two levels either side of its own radius, which keeps the result
// continuous in r and exact (the source pixel) at r = 0. In every level a source pixel counts
// with weight min(1, r_src / R_level): a sharp, in-focus pixel adds almost nothing to a blurred
// one, so a sharp foreground edge does not smear into the blurred background around it.
//
// Pure maths on typed arrays; tests/test-lensblur.mjs runs it in Node.

export const MAX_FRACTION = 0.05; // radius at Strength 100 and full depth distance, as a share of the long side
const EPS = 1e-3;                 // the least weight a pixel keeps, so an all-sharp block still has a colour
const STRIDE = 6;                 // per cell: sum r*w, g*w, b*w, w, sum of radius, pixel count

// The depth bytes from params, whether a Uint8Array, a plain array or an object with numeric keys
// (what JSON makes of a typed array).
export function depthBytes(depth) {
  const d = depth?.data;
  if (!d || !(depth.w > 0) || !(depth.h > 0)) throw new Error('the blur has no depth map');
  const bytes = d instanceof Uint8Array ? d : Uint8Array.from(Array.isArray(d) || ArrayBuffer.isView(d) ? d : Object.values(d));
  if (bytes.length < depth.w * depth.h) throw new Error('the depth map is shorter than its size');
  return { w: depth.w, h: depth.h, data: bytes };
}

// Bilinear resample of a w x h byte depth map to W x H, as 0..1 floats (pixel centres aligned).
export function resampleDepth({ w, h, data }, W, H) {
  const out = new Float32Array(W * H);
  const xs0 = new Int32Array(W), xs1 = new Int32Array(W), fx = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const s = Math.min(w - 1, Math.max(0, (x + 0.5) * w / W - 0.5));
    xs0[x] = Math.floor(s); xs1[x] = Math.min(w - 1, xs0[x] + 1); fx[x] = s - xs0[x];
  }
  for (let y = 0; y < H; y++) {
    const s = Math.min(h - 1, Math.max(0, (y + 0.5) * h / H - 0.5));
    const y0 = Math.floor(s), y1 = Math.min(h - 1, y0 + 1), fy = s - y0;
    const r0 = y0 * w, r1 = y1 * w, o = y * W;
    for (let x = 0; x < W; x++) {
      const a = data[r0 + xs0[x]], b = data[r0 + xs1[x]], c = data[r1 + xs0[x]], d = data[r1 + xs1[x]];
      const top = a + (b - a) * fx[x], bot = c + (d - c) * fx[x];
      out[o + x] = (top + (bot - top) * fy) / 255;
    }
  }
  return out;
}

// The depth (0..1) at a normalised point, read bilinearly from the map.
export function depthAt({ w, h, data }, x, y) {
  const sx = Math.min(w - 1, Math.max(0, x * w - 0.5)), sy = Math.min(h - 1, Math.max(0, y * h - 0.5));
  const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = sx - x0, fy = sy - y0;
  const top = data[y0 * w + x0] + (data[y0 * w + x1] - data[y0 * w + x0]) * fx;
  const bot = data[y1 * w + x0] + (data[y1 * w + x1] - data[y1 * w + x0]) * fx;
  return (top + (bot - top) * fy) / 255;
}

export const maxRadius = (strength, W, H) => Math.max(0, Math.min(100, +strength || 0)) / 100 * MAX_FRACTION * Math.max(W, H);

// Circle-of-confusion radius per pixel: r = maxR * |d - d0|, 0 at the focus plane.
export function radiusMap(d, d0, maxR) {
  const r = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) r[i] = maxR * Math.abs(d[i] - d0);
  return r;
}

const weight = (r, R) => Math.max(EPS, Math.min(1, r / R));

// Level 1 from full-resolution pixels: 2 x 2 blocks, each pixel weighted by its radius.
function firstLevel(px, W, H, r) {
  const w1 = (W + 1) >> 1, h1 = (H + 1) >> 1, L = new Float32Array(w1 * h1 * STRIDE);
  for (let y = 0; y < H; y++) {
    const row = (y >> 1) * w1;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4, c = (row + (x >> 1)) * STRIDE, ri = r[i];
      const wt = weight(ri, 2);
      L[c] += px[p] * wt; L[c + 1] += px[p + 1] * wt; L[c + 2] += px[p + 2] * wt;
      L[c + 3] += wt; L[c + 4] += ri; L[c + 5] += 1;
    }
  }
  return { w: w1, h: h1, data: L };
}

// Level i from level i - 1. Each child block is reweighted from R/2 to R by its mean radius.
function nextLevel(prev, R) {
  const { w: pw, h: ph, data: P } = prev;
  const w = (pw + 1) >> 1, h = (ph + 1) >> 1, L = new Float32Array(w * h * STRIDE);
  for (let y = 0; y < ph; y++) {
    const row = (y >> 1) * w;
    for (let x = 0; x < pw; x++) {
      const s = (y * pw + x) * STRIDE, c = (row + (x >> 1)) * STRIDE;
      const n = P[s + 5];
      if (!n) continue;
      const mr = P[s + 4] / n, k = weight(mr, R) / weight(mr, R / 2);
      L[c] += P[s] * k; L[c + 1] += P[s + 1] * k; L[c + 2] += P[s + 2] * k; L[c + 3] += P[s + 3] * k;
      L[c + 4] += P[s + 4]; L[c + 5] += n;
    }
  }
  return { w, h, data: L };
}

// The four premultiplied sums of a level, smoothed by a [1 2 1] / 4 tent in x then y.
function smooth({ w, h, data }) {
  const a = new Float32Array(w * h * 4), b = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 4; c++) a[i * 4 + c] = data[i * STRIDE + c];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = y * w + Math.max(0, x - 1), m = y * w + x, r = y * w + Math.min(w - 1, x + 1);
    for (let c = 0; c < 4; c++) b[m * 4 + c] = (a[l * 4 + c] + 2 * a[m * 4 + c] + a[r * 4 + c]) / 4;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = Math.max(0, y - 1) * w + x, m = y * w + x, d = Math.min(h - 1, y + 1) * w + x;
    for (let c = 0; c < 4; c++) a[m * 4 + c] = (b[u * 4 + c] + 2 * b[m * 4 + c] + b[d * 4 + c]) / 4;
  }
  return { w, h, data: a };
}

// Blur levels 1..K as smoothed premultiplied grids; level i has radius about 2^i.
export function buildLevels(px, W, H, r, K) {
  const raw = [firstLevel(px, W, H, r)];
  for (let i = 2; i <= K; i++) raw.push(nextLevel(raw[raw.length - 1], 2 ** i));
  return raw.map(smooth);
}

// Colour of level `lv` (1-based scale 2^i) at full-resolution pixel (x, y), into out[0..2].
function sample(lv, scale, x, y, out) {
  const { w, h, data } = lv;
  const sx = Math.min(w - 1, Math.max(0, (x + 0.5) / scale - 0.5));
  const sy = Math.min(h - 1, Math.max(0, (y + 0.5) / scale - 0.5));
  const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = sx - x0, fy = sy - y0;
  const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
  const wa = (1 - fx) * (1 - fy), wb = fx * (1 - fy), wc = (1 - fx) * fy, wd = fx * fy;
  const sw = data[a + 3] * wa + data[b + 3] * wb + data[c + 3] * wc + data[d + 3] * wd;
  for (let ch = 0; ch < 3; ch++) {
    out[ch] = (data[a + ch] * wa + data[b + ch] * wb + data[c + ch] * wc + data[d + ch] * wd) / sw;
  }
}

// Render: each pixel blends the two levels either side of its radius (level 0 is the source).
export function lensBlurPixels(px, W, H, r) {
  let rmax = 0;
  for (let i = 0; i < r.length; i++) if (r[i] > rmax) rmax = r[i];
  const out = new Uint8ClampedArray(px);
  if (rmax <= 0) return out;
  const K = Math.max(1, Math.ceil(Math.log2(rmax)));
  const levels = buildLevels(px, W, H, r, K);
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, ri = r[i];
      if (ri <= 0) continue;
      const p = i * 4;
      let a, iLo;
      if (ri < 2) { iLo = 0; a = ri / 2; }
      else {
        iLo = Math.min(K, Math.floor(Math.log2(ri)));
        a = iLo >= K ? 0 : (ri - 2 ** iLo) / 2 ** iLo;
      }
      if (iLo === 0) { lo[0] = px[p]; lo[1] = px[p + 1]; lo[2] = px[p + 2]; }
      else sample(levels[iLo - 1], 2 ** iLo, x, y, lo);
      if (a > 0) sample(levels[iLo], 2 ** (iLo + 1), x, y, hi);
      for (let c = 0; c < 3; c++) out[p + c] = Math.round(a > 0 ? lo[c] + (hi[c] - lo[c]) * a : lo[c]);
    }
  }
  return out;
}

// The whole op on RGBA bytes: returns new RGBA bytes.
export function renderLensBlur(px, W, H, { focus, strength, depth }) {
  const dep = depthBytes(depth);
  const fx = Math.min(1, Math.max(0, +focus?.x || 0)), fy = Math.min(1, Math.max(0, +focus?.y || 0));
  const d = resampleDepth(dep, W, H);
  const r = radiusMap(d, depthAt(dep, fx, fy), maxRadius(strength, W, H));
  return lensBlurPixels(px, W, H, r);
}

export async function apply(canvas, params) {
  const W = canvas.width, H = canvas.height;
  const src = canvas.getContext('2d').getImageData(0, 0, W, H);
  const out = new OffscreenCanvas(W, H);
  out.getContext('2d').putImageData(new ImageData(renderLensBlur(src.data, W, H, params), W, H), 0, 0);
  return out;
}
