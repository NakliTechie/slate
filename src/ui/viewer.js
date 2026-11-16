import { state } from '../core/state.js';
import { emit, on } from '../core/events.js';
import { esc } from '../core/html.js';
import { drawLayer } from '../core/layers.js';

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 32;
const PIXEL_GRID_THRESHOLD = 4;

let canvas, ctx, viewport;
let _raf = null;
let _dirty = true;
let _panning = false;
let _panStart = { x: 0, y: 0 };
let _panOrigin = { x: 0, y: 0 };
let _spaceHeld = false;

export function initViewer() {
  viewport = document.getElementById('viewport');
  canvas = document.getElementById('main-canvas');
  ctx = canvas.getContext('2d', { alpha: false });

  resizeCanvas();
  new ResizeObserver(resizeCanvas).observe(viewport);

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('dblclick', onDblClick);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  on('image:loaded', () => { fitToWindow(); scheduleRender(); });
  on('image:changed', () => scheduleRender());

  scheduleRender();
}

// ── Canvas sizing ─────────────────────────────────────────────────────────────

function resizeCanvas() {
  const r = viewport.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  ctx.scale(dpr, dpr);
  scheduleRender();
}

function vpW() { return viewport.clientWidth; }
function vpH() { return viewport.clientHeight; }

// ── Fit modes ─────────────────────────────────────────────────────────────────

export function fitToWindow() {
  const { image, view } = state;
  if (!image.original) return;
  const zoom = Math.min(vpW() / image.width, vpH() / image.height, 1);
  view.zoom = zoom;
  view.pan.x = (vpW() - image.width * zoom) / 2;
  view.pan.y = (vpH() - image.height * zoom) / 2;
  view.fitMode = 'window';
  scheduleRender();
}

export function fitToWidth() {
  const { image, view } = state;
  if (!image.original) return;
  const zoom = vpW() / image.width;
  view.zoom = zoom;
  view.pan.x = 0;
  view.pan.y = (vpH() - image.height * zoom) / 2;
  view.fitMode = 'width';
  scheduleRender();
}

export function fitToHeight() {
  const { image, view } = state;
  if (!image.original) return;
  const zoom = vpH() / image.height;
  view.zoom = zoom;
  view.pan.x = (vpW() - image.width * zoom) / 2;
  view.pan.y = 0;
  view.fitMode = 'height';
  scheduleRender();
}

export function fit1to1() {
  const { image, view } = state;
  if (!image.original) return;
  view.zoom = 1;
  view.pan.x = (vpW() - image.width) / 2;
  view.pan.y = (vpH() - image.height) / 2;
  view.fitMode = '1:1';
  scheduleRender();
}

export function fitFill() {
  const { image, view } = state;
  if (!image.original) return;
  const zoom = Math.max(vpW() / image.width, vpH() / image.height);
  view.zoom = zoom;
  view.pan.x = (vpW() - image.width * zoom) / 2;
  view.pan.y = (vpH() - image.height * zoom) / 2;
  view.fitMode = 'fill';
  scheduleRender();
}

export function applyFitMode() {
  switch (state.view.fitMode) {
    case 'window': fitToWindow(); break;
    case 'width':  fitToWidth();  break;
    case 'height': fitToHeight(); break;
    case '1:1':    fit1to1();     break;
    case 'fill':   fitFill();     break;
  }
}

// ── Zoom ──────────────────────────────────────────────────────────────────────

export function zoomTo(newZoom, cx, cy) {
  const { view } = state;
  cx = cx ?? vpW() / 2;
  cy = cy ?? vpH() / 2;
  newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
  const factor = newZoom / view.zoom;
  view.pan.x = cx - (cx - view.pan.x) * factor;
  view.pan.y = cy - (cy - view.pan.y) * factor;
  view.zoom = newZoom;
  view.fitMode = '1:1'; // custom zoom breaks fit
  emit('zoom:changed', { zoom: newZoom });
  scheduleRender();
}

export function zoomStep(delta, cx, cy) {
  const steps = [0.01, 0.02, 0.03, 0.05, 0.0625, 0.083, 0.1, 0.125, 0.167, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
  const cur = state.view.zoom;
  let idx = steps.findIndex(z => z >= cur - 1e-6);
  if (idx < 0) idx = steps.length - 1;
  const next = steps[Math.max(0, Math.min(steps.length - 1, idx + delta))];
  zoomTo(next, cx, cy);
}

// Canvas-space → image-space
export function canvasToImage(cx, cy) {
  const { zoom, pan } = state.view;
  return { x: (cx - pan.x) / zoom, y: (cy - pan.y) / zoom };
}

// Image-space → canvas-space
export function imageToCanvas(ix, iy) {
  const { zoom, pan } = state.view;
  return { x: ix * zoom + pan.x, y: iy * zoom + pan.y };
}

// ── Render ────────────────────────────────────────────────────────────────────

function scheduleRender() {
  _dirty = true;
  if (_raf) return;
  _raf = requestAnimationFrame(render);
}

function render() {
  _raf = null;
  if (!_dirty) return;
  _dirty = false;

  const W = vpW(), H = vpH();
  const { image, view } = state;

  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim() || '#111';
  ctx.fillRect(0, 0, W, H);

  if (!image.working) return;

  const { zoom, pan } = view;
  ctx.save();
  ctx.translate(pan.x, pan.y);
  ctx.scale(zoom, zoom);
  ctx.imageSmoothingEnabled = zoom < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image.working, 0, 0);
  // Layers (text, arrow) draw in image-space on top of the working canvas
  for (const layer of state.layers) drawLayer(ctx, layer);
  ctx.restore();

  // Pixel grid at high zoom
  if (zoom >= PIXEL_GRID_THRESHOLD) drawPixelGrid(W, H, zoom, pan);

  // Selection overlay (drawn by selection.js via composite)
  emit('render:overlay', { ctx, W, H, zoom, pan });

  updateStatusBar();
}

function drawPixelGrid(W, H, zoom, pan) {
  const imgW = state.image.width, imgH = state.image.height;
  ctx.save();
  ctx.strokeStyle = 'rgba(128,128,128,0.5)';
  ctx.lineWidth = 0.5;

  const startX = Math.max(0, Math.floor(-pan.x / zoom));
  const endX   = Math.min(imgW, Math.ceil((W - pan.x) / zoom));
  const startY = Math.max(0, Math.floor(-pan.y / zoom));
  const endY   = Math.min(imgH, Math.ceil((H - pan.y) / zoom));

  ctx.beginPath();
  for (let x = startX; x <= endX; x++) {
    const cx = x * zoom + pan.x;
    ctx.moveTo(cx, Math.max(0, startY * zoom + pan.y));
    ctx.lineTo(cx, Math.min(H, endY * zoom + pan.y));
  }
  for (let y = startY; y <= endY; y++) {
    const cy = y * zoom + pan.y;
    ctx.moveTo(Math.max(0, startX * zoom + pan.x), cy);
    ctx.lineTo(Math.min(W, endX * zoom + pan.x), cy);
  }
  ctx.stroke();
  ctx.restore();
}

// ── Status bar ────────────────────────────────────────────────────────────────

function updateStatusBar() {
  const bar = document.getElementById('status-bar');
  if (!bar || !state.image.working) return;
  const zoomPct = Math.round(state.view.zoom * 100);
  const { width: w, height: h } = state.image;
  const { files, currentIndex } = state.session;
  const parts = [
    `${w} × ${h} px`,
    `${zoomPct}%`,
  ];
  if (files.length > 1) parts.push(`${currentIndex + 1} / ${files.length}`);
  if (state.session.files[currentIndex]?.name) parts.push(state.session.files[currentIndex].name);
  bar.innerHTML = parts.map(p => `<span class="status-item">${esc(p)}</span>`).join('<span class="status-sep"> · </span>');
}

// ── Panning ───────────────────────────────────────────────────────────────────

function isPanGesture(e) {
  return _spaceHeld || e.button === 1 || (e.button === 0 && !state.activeTool);
}

function startPan(x, y) {
  _panning = true;
  _panStart = { x, y };
  _panOrigin = { x: state.view.pan.x, y: state.view.pan.y };
  canvas.style.cursor = 'grabbing';
}

function doPan(x, y) {
  if (!_panning) return;
  state.view.pan.x = _panOrigin.x + (x - _panStart.x);
  state.view.pan.y = _panOrigin.y + (y - _panStart.y);
  scheduleRender();
}

function endPan() {
  _panning = false;
  canvas.style.cursor = _spaceHeld ? 'grab' : '';
}

// ── Mouse handlers ────────────────────────────────────────────────────────────

function onWheel(e) {
  e.preventDefault();
  if (!state.image.working) return;
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  if (e.ctrlKey) {
    // Trackpad pinch-to-zoom (ctrlKey+wheel on Mac/Windows)
    const clamped = Math.max(-20, Math.min(20, e.deltaY));
    const factor = Math.exp(-clamped * 0.006);
    zoomTo(state.view.zoom * factor, cx, cy);
  } else if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
    // Discrete mouse wheel (line/page delta) → step zoom
    zoomStep(e.deltaY < 0 ? 1 : -1, cx, cy);
  } else {
    // Trackpad two-finger scroll (pixel delta, no pinch) → pan
    state.view.pan.x -= e.deltaX;
    state.view.pan.y -= e.deltaY;
    scheduleRender();
  }
}

function onMouseDown(e) {
  if (!state.image.working) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (isPanGesture(e)) {
    e.preventDefault();
    startPan(x, y);
  } else {
    emit('canvas:mousedown', { x, y, e, imagePos: canvasToImage(x, y) });
  }
}

function onMouseMove(e) {
  if (!state.image.working) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (_panning) {
    doPan(x, y);
  } else {
    emit('canvas:mousemove', { x, y, e, imagePos: canvasToImage(x, y) });
    emit('cursor:move', { x, y, imagePos: canvasToImage(x, y) });
  }
}

function onMouseUp(e) {
  if (_panning) { endPan(); return; }
  if (!state.image.working) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  emit('canvas:mouseup', { x, y, e, imagePos: canvasToImage(x, y) });
}

function onMouseLeave() {
  if (_panning) endPan();
  emit('cursor:leave', null);
}

function onDblClick(e) {
  if (!state.image.working) return;
  const rect = canvas.getBoundingClientRect();
  fitToWindow();
}

// ── Touch (pinch zoom + pan) ───────────────────────────────────────────────────

let _touches = [];
let _lastPinchDist = 0;
let _lastPinchCenter = { x: 0, y: 0 };

function onTouchStart(e) {
  e.preventDefault();
  _touches = Array.from(e.touches);
  if (_touches.length === 1) {
    const rect = canvas.getBoundingClientRect();
    startPan(_touches[0].clientX - rect.left, _touches[0].clientY - rect.top);
  } else if (_touches.length === 2) {
    _panning = false;
    _lastPinchDist = touchDist(_touches[0], _touches[1]);
    _lastPinchCenter = touchCenter(_touches[0], _touches[1], canvas.getBoundingClientRect());
  }
}

function onTouchMove(e) {
  e.preventDefault();
  const touches = Array.from(e.touches);
  const rect = canvas.getBoundingClientRect();
  if (touches.length === 1 && _panning) {
    doPan(touches[0].clientX - rect.left, touches[0].clientY - rect.top);
  } else if (touches.length === 2) {
    const dist = touchDist(touches[0], touches[1]);
    const center = touchCenter(touches[0], touches[1], rect);
    if (_lastPinchDist) {
      const raw = dist / _lastPinchDist;
      const factor = 1 + (raw - 1) * 0.55; // dampen sensitivity
      zoomTo(state.view.zoom * factor, center.x, center.y);
    }
    _lastPinchDist = dist;
    _lastPinchCenter = center;
  }
}

function onTouchEnd(e) {
  _touches = Array.from(e.touches);
  _lastPinchDist = 0;
  if (_touches.length === 0) endPan();
}

function touchDist(a, b) { return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY); }
function touchCenter(a, b, rect) {
  return { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top };
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

function onKeyDown(e) {
  if (e.code === 'Space' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {
    if (!_spaceHeld) { _spaceHeld = true; canvas.style.cursor = 'grab'; }
    if (document.getElementById('viewport')?.contains(document.activeElement) || document.activeElement === document.body) {
      e.preventDefault();
    }
  }
}

function onKeyUp(e) {
  if (e.code === 'Space') {
    _spaceHeld = false;
    if (!_panning) canvas.style.cursor = '';
  }
}

// ── Fullscreen ────────────────────────────────────────────────────────────────

export function toggleFullscreen() {
  const app = document.getElementById('app');
  state.view.fullscreen = !state.view.fullscreen;
  app.classList.toggle('fullscreen', state.view.fullscreen);
  scheduleRender();
}

export { scheduleRender as markDirty };
