import { state } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { canvasToImage, imageToCanvas, markDirty } from './viewer.js';

let _dragging = false;
let _dragStart = { ix: 0, iy: 0 };
let _dragMode = 'new'; // 'new' | 'move' | 'resize'
let _resizeHandle = null; // 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'

const HANDLE_RADIUS = 5;
const HANDLE_HIT = 12; // px for hit testing

export function initSelection() {
  on('canvas:mousedown', onDown);
  on('canvas:mousemove', onMove);
  on('canvas:mouseup', onUp);
  on('render:overlay', drawOverlay);
}

export function clearSelection() {
  state.selection.shape = null;
  emit('selection:changed', null);
  markDirty();
}

export function selectAll() {
  state.selection.shape = 'rect';
  state.selection.x = 0;
  state.selection.y = 0;
  state.selection.w = state.image.width;
  state.selection.h = state.image.height;
  emit('selection:changed', state.selection);
  markDirty();
}

// ── Drag handlers ─────────────────────────────────────────────────────────────

function onDown({ x, y, imagePos }) {
  if (!['crop', 'redact', 'blur', 'pixelate', null].includes(state.activeTool)) return;
  if (state.activeTool === 'text' || state.activeTool === 'arrow') return;

  const { selection } = state;

  if (selection.shape) {
    // Check handles
    _resizeHandle = hitHandle(x, y);
    if (_resizeHandle) {
      _dragging = true;
      _dragMode = 'resize';
      _dragStart = { ix: imagePos.x, iy: imagePos.y, sel: { ...selection } };
      return;
    }
    // Check body for move
    const { x: sx, y: sy, w: sw, h: sh } = selectionCanvasBounds();
    if (x >= sx && x <= sx + sw && y >= sy && y <= sy + sh) {
      _dragging = true;
      _dragMode = 'move';
      _dragStart = { ix: imagePos.x, iy: imagePos.y, sel: { ...selection } };
      return;
    }
  }

  // Start new selection
  _dragging = true;
  _dragMode = 'new';
  _dragStart = { ix: imagePos.x, iy: imagePos.y };
  selection.shape = 'rect';
  selection.x = Math.round(imagePos.x);
  selection.y = Math.round(imagePos.y);
  selection.w = 0;
  selection.h = 0;
  markDirty();
}

function onMove({ x, y, imagePos }) {
  if (!_dragging) {
    if (state.selection.shape) updateCursor(x, y);
    return;
  }

  const { selection } = state;
  const imgW = state.image.width, imgH = state.image.height;

  if (_dragMode === 'new') {
    let ix = imagePos.x, iy = imagePos.y;
    const ox = _dragStart.ix, oy = _dragStart.iy;
    let x1 = Math.min(ox, ix), y1 = Math.min(oy, iy);
    let x2 = Math.max(ox, ix), y2 = Math.max(oy, iy);

    if (selection.aspectLock && selection.aspectLock !== 'free') {
      const ar = aspectRatio();
      if (ar) { const dw = x2 - x1; y2 = y1 + dw / ar; }
    }

    selection.x = Math.max(0, Math.round(x1));
    selection.y = Math.max(0, Math.round(y1));
    selection.w = Math.max(0, Math.round(Math.min(x2, imgW) - selection.x));
    selection.h = Math.max(0, Math.round(Math.min(y2, imgH) - selection.y));

  } else if (_dragMode === 'move') {
    const dx = Math.round(imagePos.x - _dragStart.ix);
    const dy = Math.round(imagePos.y - _dragStart.iy);
    selection.x = Math.max(0, Math.min(imgW - _dragStart.sel.w, _dragStart.sel.x + dx));
    selection.y = Math.max(0, Math.min(imgH - _dragStart.sel.h, _dragStart.sel.y + dy));

  } else if (_dragMode === 'resize') {
    applyResize(imagePos);
  }

  emit('selection:changed', selection);
  markDirty();
}

function onUp() {
  if (!_dragging) return;
  _dragging = false;
  // Normalize negative dimensions
  const { selection } = state;
  if (selection.w < 0) { selection.x += selection.w; selection.w = -selection.w; }
  if (selection.h < 0) { selection.y += selection.h; selection.h = -selection.h; }
  if (selection.w < 2 || selection.h < 2) clearSelection();
  else emit('selection:changed', selection);
  markDirty();
}

// ── Resize logic ──────────────────────────────────────────────────────────────

function applyResize(imagePos) {
  const sel = _dragStart.sel;
  const { selection } = state;
  const ix = Math.round(imagePos.x), iy = Math.round(imagePos.y);
  const imgW = state.image.width, imgH = state.image.height;

  let nx = sel.x, ny = sel.y, nw = sel.w, nh = sel.h;

  if (_resizeHandle.includes('e')) { nw = Math.max(1, Math.min(imgW - nx, ix - nx)); }
  if (_resizeHandle.includes('w')) { const r = nx + nw; nx = Math.max(0, Math.min(r - 1, ix)); nw = r - nx; }
  if (_resizeHandle.includes('s')) { nh = Math.max(1, Math.min(imgH - ny, iy - ny)); }
  if (_resizeHandle.includes('n')) { const b = ny + nh; ny = Math.max(0, Math.min(b - 1, iy)); nh = b - ny; }

  selection.x = nx; selection.y = ny; selection.w = nw; selection.h = nh;
}

// ── Hit testing ───────────────────────────────────────────────────────────────

function hitHandle(cx, cy) {
  const handles = getHandlePositions();
  for (const [name, { x, y }] of Object.entries(handles)) {
    if (Math.abs(cx - x) <= HANDLE_HIT && Math.abs(cy - y) <= HANDLE_HIT) return name;
  }
  return null;
}

function updateCursor(cx, cy) {
  const canvas = document.getElementById('main-canvas');
  if (!canvas) return;
  const handle = hitHandle(cx, cy);
  const cursors = {
    nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize',
    e: 'e-resize', se: 'se-resize', s: 's-resize',
    sw: 'sw-resize', w: 'w-resize'
  };
  const { x: sx, y: sy, w: sw, h: sh } = selectionCanvasBounds();
  if (handle) canvas.style.cursor = cursors[handle];
  else if (cx >= sx && cx <= sx + sw && cy >= sy && cy <= sy + sh) canvas.style.cursor = 'move';
  else canvas.style.cursor = '';
}

// ── Canvas bounds & handles ───────────────────────────────────────────────────

function selectionCanvasBounds() {
  const { x, y, w, h } = state.selection;
  const c1 = imageToCanvas(x, y);
  const c2 = imageToCanvas(x + w, y + h);
  return { x: c1.x, y: c1.y, w: c2.x - c1.x, h: c2.y - c1.y };
}

function getHandlePositions() {
  const { x, y, w, h } = selectionCanvasBounds();
  const mx = x + w / 2, my = y + h / 2;
  return {
    nw: { x, y }, n: { x: mx, y }, ne: { x: x+w, y },
    e: { x: x+w, y: my }, se: { x: x+w, y: y+h },
    s: { x: mx, y: y+h }, sw: { x, y: y+h }, w: { x, y: my }
  };
}

function aspectRatio() {
  const lock = state.selection.aspectLock;
  if (!lock || lock === 'free') return null;
  const map = { '1:1': 1, '16:9': 16/9, '4:3': 4/3 };
  if (map[lock]) return map[lock];
  if (lock === 'original' && state.image.original) return state.image.original.width / state.image.original.height;
  if (lock === 'custom') return state.selection.customAspect.w / state.selection.customAspect.h;
  return null;
}

// ── Render overlay ────────────────────────────────────────────────────────────

function drawOverlay({ ctx, W, H }) {
  if (!state.selection.shape || !state.image.working) return;

  const { x, y, w, h } = selectionCanvasBounds();
  if (w <= 0 || h <= 0) return;

  // Darken outside selection
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  if (state.selection.shape === 'circle') {
    ctx.ellipse(x + w/2, y + h/2, w/2, h/2, 0, 0, Math.PI*2, true);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fill('evenodd');

  // Border
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--selection-border').trim();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  if (state.selection.shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(x + w/2, y + h/2, w/2, h/2, 0, 0, Math.PI*2);
    ctx.stroke();
  } else {
    ctx.strokeRect(x, y, w, h);
  }
  ctx.setLineDash([]);

  // Handles (rect only)
  if (state.selection.shape === 'rect') {
    const hc = getComputedStyle(document.documentElement).getPropertyValue('--selection-handle').trim();
    ctx.fillStyle = hc;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--selection-border').trim();
    ctx.lineWidth = 1;
    for (const { x: hx, y: hy } of Object.values(getHandlePositions())) {
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ── Keyboard nudge ────────────────────────────────────────────────────────────

export function nudgeSelection(dx, dy, resize = false) {
  const { selection } = state;
  if (!selection.shape) return;
  if (resize) {
    selection.w = Math.max(1, selection.w + dx);
    selection.h = Math.max(1, selection.h + dy);
  } else {
    selection.x = Math.max(0, Math.min(state.image.width - selection.w, selection.x + dx));
    selection.y = Math.max(0, Math.min(state.image.height - selection.h, selection.y + dy));
  }
  emit('selection:changed', selection);
  markDirty();
}
