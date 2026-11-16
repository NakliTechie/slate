// deg: arbitrary angle; canvas expands to contain the rotated image
export async function apply(canvas, { deg }) {
  if (deg === 0) {
    const out = new OffscreenCanvas(canvas.width, canvas.height);
    out.getContext('2d').drawImage(canvas, 0, 0);
    return out;
  }
  const rad = deg * Math.PI / 180;
  const W = canvas.width, H = canvas.height;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const outW = Math.ceil(W * cos + H * sin);
  const outH = Math.ceil(W * sin + H * cos);
  const out = new OffscreenCanvas(outW, outH);
  const ctx = out.getContext('2d');
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -W / 2, -H / 2);
  return out;
}
