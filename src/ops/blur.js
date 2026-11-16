export async function apply(canvas, { x, y, w, h, strength = 10 }) {
  const rx = Math.round(x), ry = Math.round(y);
  const rw = Math.max(1, Math.round(w)), rh = Math.max(1, Math.round(h));
  const pad = Math.ceil(strength * 1.5); // avoid hard edge at boundary

  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);

  // Render blurred region (with padding for bloom) into a temp canvas
  const tmp = new OffscreenCanvas(rw + pad * 2, rh + pad * 2);
  const tctx = tmp.getContext('2d');
  tctx.filter = `blur(${Math.round(strength)}px)`;
  tctx.drawImage(canvas, pad - rx, pad - ry);

  // Composite back, clipped to the exact selection rect
  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();
  ctx.drawImage(tmp, rx - pad, ry - pad);
  ctx.restore();

  return out;
}
