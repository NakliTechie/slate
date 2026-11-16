import { state } from '../core/state.js';
import { on } from '../core/events.js';

let rulerH, rulerV, rulerCorner;
let rulerHCtx, rulerVCtx;
let cursorX = -1, cursorY = -1;

const RULER_SIZE = 24;

export function initRulers() {
  rulerH = document.getElementById('ruler-h');
  rulerV = document.getElementById('ruler-v');
  rulerCorner = document.getElementById('ruler-corner');

  rulerHCtx = rulerH?.getContext?.('2d') ?? null;
  rulerVCtx = rulerV?.getContext?.('2d') ?? null;

  // Replace divs with canvases for pixel-accurate drawing
  if (rulerH && !rulerH.getContext) {
    const c = document.createElement('canvas');
    c.id = 'ruler-h'; c.style.cssText = rulerH.style.cssText;
    c.style.display = 'block';
    rulerH.replaceWith(c);
    rulerH = c;
    rulerHCtx = c.getContext('2d');
  }
  if (rulerV && !rulerV.getContext) {
    const c = document.createElement('canvas');
    c.id = 'ruler-v'; c.style.cssText = rulerV.style.cssText;
    c.style.display = 'block';
    rulerV.replaceWith(c);
    rulerV = c;
    rulerVCtx = c.getContext('2d');
  }

  new ResizeObserver(drawRulers).observe(document.getElementById('main-area') ?? document.body);

  on('cursor:move', ({ x, y }) => {
    cursorX = x; cursorY = y;
    drawRulers();
  });
  on('cursor:leave', () => { cursorX = -1; cursorY = -1; drawRulers(); });
  on('image:loaded', drawRulers);
  on('image:changed', drawRulers);
  on('zoom:changed', drawRulers);
  on('render:overlay', drawRulers);

  drawRulers();
}

export function setRulersVisible(visible) {
  const mainArea = document.getElementById('main-area');
  mainArea?.classList.toggle('rulers-hidden', !visible);
  state.view.rulers = visible;
}

function drawRulers() {
  if (!state.view.rulers || !rulerH || !rulerV) return;
  if (!state.image.working) { clearRulers(); return; }
  drawHRuler();
  drawVRuler();
}

function clearRulers() {
  if (rulerHCtx) { rulerHCtx.clearRect(0, 0, rulerH.width, rulerH.height); }
  if (rulerVCtx) { rulerVCtx.clearRect(0, 0, rulerV.width, rulerV.height); }
}

function getTickInterval(zoom) {
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  for (const c of candidates) {
    if (c * zoom >= 40) return c;
  }
  return 1000;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawHRuler() {
  const w = rulerH.parentElement?.clientWidth ?? rulerH.clientWidth;
  if (!w) return;
  rulerH.width = w;
  rulerH.height = RULER_SIZE;
  const ctx = rulerHCtx;
  const { zoom, pan } = state.view;

  ctx.fillStyle = cssVar('--ruler-bg');
  ctx.fillRect(0, 0, w, RULER_SIZE);

  const tickInterval = getTickInterval(zoom);
  const startPx = Math.floor(-pan.x / zoom / tickInterval) * tickInterval;
  const endPx = Math.ceil((w - pan.x) / zoom / tickInterval) * tickInterval;

  ctx.strokeStyle = cssVar('--ruler-tick');
  ctx.fillStyle = cssVar('--ruler-label');
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 0.5;

  ctx.beginPath();
  for (let px = startPx; px <= endPx; px += tickInterval) {
    const cx = px * zoom + pan.x;
    if (cx < 0 || cx > w) continue;
    const isMajor = px % (tickInterval * 5) === 0 || tickInterval >= 100;
    const tickH = isMajor ? 10 : 5;
    ctx.moveTo(cx, RULER_SIZE);
    ctx.lineTo(cx, RULER_SIZE - tickH);
    if (isMajor) ctx.fillText(String(px), cx, RULER_SIZE / 2 - 1);
  }
  ctx.stroke();

  // Crosshair
  if (cursorX >= 0) {
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cursorX, 0);
    ctx.lineTo(cursorX, RULER_SIZE);
    ctx.stroke();
  }

  ctx.strokeStyle = cssVar('--bg-3');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_SIZE - 0.5);
  ctx.lineTo(w, RULER_SIZE - 0.5);
  ctx.stroke();
}

function drawVRuler() {
  const h = rulerV.parentElement?.clientHeight ?? rulerV.clientHeight;
  if (!h) return;
  rulerV.width = RULER_SIZE;
  rulerV.height = h;
  const ctx = rulerVCtx;
  const { zoom, pan } = state.view;

  ctx.fillStyle = cssVar('--ruler-bg');
  ctx.fillRect(0, 0, RULER_SIZE, h);

  const tickInterval = getTickInterval(zoom);
  const startPy = Math.floor(-pan.y / zoom / tickInterval) * tickInterval;
  const endPy = Math.ceil((h - pan.y) / zoom / tickInterval) * tickInterval;

  ctx.strokeStyle = cssVar('--ruler-tick');
  ctx.fillStyle = cssVar('--ruler-label');
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 0.5;

  ctx.beginPath();
  for (let py = startPy; py <= endPy; py += tickInterval) {
    const cy = py * zoom + pan.y;
    if (cy < 0 || cy > h) continue;
    const isMajor = py % (tickInterval * 5) === 0 || tickInterval >= 100;
    const tickW = isMajor ? 10 : 5;
    ctx.moveTo(RULER_SIZE, cy);
    ctx.lineTo(RULER_SIZE - tickW, cy);

    if (isMajor) {
      ctx.save();
      ctx.translate(RULER_SIZE / 2 - 1, cy);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(String(py), 0, 0);
      ctx.restore();
    }
  }
  ctx.stroke();

  // Crosshair
  if (cursorY >= 0) {
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cursorY);
    ctx.lineTo(RULER_SIZE, cursorY);
    ctx.stroke();
  }

  ctx.strokeStyle = cssVar('--bg-3');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(RULER_SIZE - 0.5, 0);
  ctx.lineTo(RULER_SIZE - 0.5, h);
  ctx.stroke();
}
