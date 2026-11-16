// Pixelate a rectangular region by averaging colour in size×size blocks.
// Different visual signature from blur — useful for hiding faces / text where
// "this is intentionally hidden" should read clearly.

export async function apply(canvas, { x, y, w, h, size = 12 }) {
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);

  const rx = Math.max(0, Math.round(x));
  const ry = Math.max(0, Math.round(y));
  const rw = Math.min(canvas.width  - rx, Math.round(w));
  const rh = Math.min(canvas.height - ry, Math.round(h));
  if (rw <= 0 || rh <= 0) return out;

  const block = Math.max(2, Math.round(size));
  const id = ctx.getImageData(rx, ry, rw, rh);
  const d  = id.data;

  for (let by = 0; by < rh; by += block) {
    for (let bx = 0; bx < rw; bx += block) {
      const bw = Math.min(block, rw - bx);
      const bh = Math.min(block, rh - by);

      // Average channel values across the block
      let r = 0, g = 0, bb = 0, a = 0, n = 0;
      for (let py = 0; py < bh; py++) {
        for (let px = 0; px < bw; px++) {
          const i = ((by + py) * rw + (bx + px)) * 4;
          r += d[i]; g += d[i + 1]; bb += d[i + 2]; a += d[i + 3];
          n++;
        }
      }
      r = r / n | 0; g = g / n | 0; bb = bb / n | 0; a = a / n | 0;

      // Fill the block with the averaged colour
      for (let py = 0; py < bh; py++) {
        for (let px = 0; px < bw; px++) {
          const i = ((by + py) * rw + (bx + px)) * 4;
          d[i] = r; d[i + 1] = g; d[i + 2] = bb; d[i + 3] = a;
        }
      }
    }
  }
  ctx.putImageData(id, rx, ry);
  return out;
}
