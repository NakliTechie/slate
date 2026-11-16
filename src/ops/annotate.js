// Pure draw functions — paint onto any 2d context, no canvas creation.
// The ctx is assumed to be positioned in image-space (caller handles zoom/pan).

export function drawPencil(ctx, { points, color = '#ff0000', thickness = 4 }) {
  if (!points || points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y);
  } else {
    // Quadratic-Bezier smoothing through midpoints of consecutive segments
    for (let i = 1; i < points.length - 1; i++) {
      const xMid = (points[i].x + points[i + 1].x) / 2;
      const yMid = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xMid, yMid);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawText(ctx, { x, y, content, font = 'sans-serif', size = 24, color = '#ffffff', bold = false, italic = false }) {
  ctx.save();
  ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px "${font}"`;
  ctx.fillStyle = color;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 3;
  ctx.fillText(content, x, y);
  ctx.restore();
}

export function drawArrow(ctx, { x1, y1, x2, y2, color = '#ff0000', thickness = 3, headSize = 14 }) {
  ctx.save();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = thickness;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const sx = x2 - (headSize * 0.8) * Math.cos(angle);
  const sy = y2 - (headSize * 0.8) * Math.sin(angle);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(sx, sy);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headSize * Math.cos(angle - Math.PI / 6), y2 - headSize * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headSize * Math.cos(angle + Math.PI / 6), y2 - headSize * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Flatten versions — paint onto a new OffscreenCanvas and return it.
// Used by the save path and the legacy op:annotate:text handler.

export async function applyText(canvas, params) {
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  drawText(ctx, params);
  return out;
}

export async function applyArrow(canvas, params) {
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  drawArrow(ctx, params);
  return out;
}

export async function applyPencil(canvas, params) {
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  drawPencil(ctx, params);
  return out;
}
