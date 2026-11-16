// Apply a 3D colour lookup table from a .cube file (Adobe/Resolve format) as a "look".
// The LUT maps sRGB-encoded input to sRGB-encoded output, as camera and grading LUTs do.
// params: { name, size, min: [r,g,b], max: [r,g,b], data: Float32Array(size^3 * 3), strength: 0..100 }
// The parsed table rides in the op's params, so undo, session restore and replay keep it.

export function parseCube(text) {
  let size = 0, title = '';
  let min = [0, 0, 0], max = [1, 1, 1];
  const values = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'TITLE') { title = line.slice(5).trim().replace(/^"|"$/g, ''); continue; }
    if (key === 'LUT_3D_SIZE') { size = parseInt(parts[1], 10); continue; }
    if (key === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported; use a 3D .cube LUT');
    if (key === 'DOMAIN_MIN') { min = parts.slice(1, 4).map(Number); continue; }
    if (key === 'DOMAIN_MAX') { max = parts.slice(1, 4).map(Number); continue; }
    if (/^[A-Z_]+$/.test(key)) continue; // other keywords (LUT_IN_VIDEO_RANGE, …)
    if (parts.length !== 3) throw new Error(`bad LUT line: ${line.slice(0, 40)}`);
    values.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!size || size < 2 || size > 256) throw new Error('missing or invalid LUT_3D_SIZE');
  if (values.length !== size ** 3 * 3) throw new Error(`expected ${size ** 3} entries, found ${values.length / 3}`);
  if (values.some(v => !Number.isFinite(v))) throw new Error('the LUT has a value that is not a number');
  return { title, size, min, max, data: new Float32Array(values) };
}

// Trilinear lookup. In .cube files red changes fastest: index = r + g*N + b*N*N.
export function lookup(lut, r, g, b) {
  const { size: N, data, min, max } = lut;
  const p = [r, g, b].map((v, i) => {
    const t = (v - min[i]) / (max[i] - min[i]);
    return Math.min(N - 1, Math.max(0, t * (N - 1)));
  });
  const i0 = p.map(Math.floor), i1 = i0.map(i => Math.min(N - 1, i + 1)), f = p.map((v, i) => v - i0[i]);
  const at = (x, y, z, c) => data[(x + y * N + z * N * N) * 3 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(i0[0], i0[1], i0[2], c) * (1 - f[0]) + at(i1[0], i0[1], i0[2], c) * f[0];
    const c10 = at(i0[0], i1[1], i0[2], c) * (1 - f[0]) + at(i1[0], i1[1], i0[2], c) * f[0];
    const c01 = at(i0[0], i0[1], i1[2], c) * (1 - f[0]) + at(i1[0], i0[1], i1[2], c) * f[0];
    const c11 = at(i0[0], i1[1], i1[2], c) * (1 - f[0]) + at(i1[0], i1[1], i1[2], c) * f[0];
    out[c] = (c00 * (1 - f[1]) + c10 * f[1]) * (1 - f[2]) + (c01 * (1 - f[1]) + c11 * f[1]) * f[2];
  }
  return out;
}

// RGBA 8-bit buffer in place; strength 0..100 blends from the original.
export function lutPixels(data, lut, strength = 100) {
  const s = Math.max(0, Math.min(100, strength)) / 100;
  const cache = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let o = cache.get(key);
    if (!o) {
      const [r, g, b] = lookup(lut, data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      o = [r * 255, g * 255, b * 255];
      if (cache.size < 1 << 18) cache.set(key, o);
    }
    for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, Math.round(data[i + c] + (o[c] - data[i + c]) * s)));
  }
  return data;
}

export async function apply(canvas, params) {
  const { width: W, height: H } = canvas;
  const img = canvas.getContext('2d').getImageData(0, 0, W, H);
  lutPixels(img.data, { size: params.size, min: params.min, max: params.max, data: params.data }, params.strength ?? 100);
  const out = new OffscreenCanvas(W, H);
  out.getContext('2d').putImageData(img, 0, 0);
  return out;
}
