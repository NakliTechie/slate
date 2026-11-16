// Shape annotations: rectangle outline, ellipse outline, straight line.
// Each shape becomes a layer of type 'shape' with mode in params.

export function drawShape(ctx, params) {
  const { mode = 'rect', x1, y1, x2, y2, color = '#ff0000', thickness = 3, fill = false } = params;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = thickness;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (mode === 'rect') {
    const x = Math.min(x1, x2), y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if (fill) ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  } else if (mode === 'circle') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (fill) ctx.fill();
    ctx.stroke();
  } else if (mode === 'line') {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();
}

export async function applyShape(canvas, params) {
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  drawShape(ctx, params);
  return out;
}
