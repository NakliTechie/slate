import { state } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { canvasToImage, markDirty } from './viewer.js';
import { esc } from '../core/html.js';
import { getRecentColors, pushRecentColor } from '../core/colors.js';

// ── Arrow tool state ───────────────────────────────────────────────────────────
let _arrowStart = null;
let _arrowCurrent = null;

// ── Pencil tool state ──────────────────────────────────────────────────────────
let _pencilPoints = null;     // null when idle, [{x,y}, …] while drawing
const PENCIL_MIN_DIST = 1.5;  // image-px between successive samples

// ── Shape tool state ──────────────────────────────────────────────────────────
let _shapeStart = null;
let _shapeCurrent = null;

export function initToolHandlers() {
  on('canvas:mousedown', onDown);
  on('canvas:mousemove', onMove);
  on('canvas:mouseup',   onUp);
  on('render:overlay',   drawArrowPreview);
  on('render:overlay',   drawPencilPreview);
  on('render:overlay',   drawShapePreview);
  on('tool:changed',     onToolChanged);
}

function onToolChanged() {
  _arrowStart = null;
  _arrowCurrent = null;
  _pencilPoints = null;
  _shapeStart = null;
  _shapeCurrent = null;
}

// ── Mouse routing ──────────────────────────────────────────────────────────────

function onDown({ imagePos }) {
  if (!state.image.working) return;

  if (state.activeTool === 'text') {
    showTextModal(Math.round(imagePos.x), Math.round(imagePos.y));
  } else if (state.activeTool === 'arrow') {
    _arrowStart = { x: Math.round(imagePos.x), y: Math.round(imagePos.y) };
    _arrowCurrent = { ...imagePos };
  } else if (state.activeTool === 'pencil') {
    _pencilPoints = [{ x: imagePos.x, y: imagePos.y }];
  } else if (state.activeTool === 'shape') {
    _shapeStart   = { x: Math.round(imagePos.x), y: Math.round(imagePos.y) };
    _shapeCurrent = { ...imagePos };
  } else if (state.activeTool === 'eyedropper') {
    emit('op:eyedropper', { imagePos });
  }
}

function onMove({ imagePos }) {
  if (state.activeTool === 'arrow' && _arrowStart) {
    _arrowCurrent = { x: Math.round(imagePos.x), y: Math.round(imagePos.y) };
    markDirty();
  } else if (state.activeTool === 'pencil' && _pencilPoints) {
    const last = _pencilPoints[_pencilPoints.length - 1];
    const dx = imagePos.x - last.x;
    const dy = imagePos.y - last.y;
    if (dx * dx + dy * dy >= PENCIL_MIN_DIST * PENCIL_MIN_DIST) {
      _pencilPoints.push({ x: imagePos.x, y: imagePos.y });
      markDirty();
    }
  } else if (state.activeTool === 'shape' && _shapeStart) {
    _shapeCurrent = { x: Math.round(imagePos.x), y: Math.round(imagePos.y) };
    markDirty();
  }
}

function onUp({ imagePos }) {
  if (state.activeTool === 'arrow' && _arrowStart) {
    const x2 = Math.round(imagePos.x), y2 = Math.round(imagePos.y);
    const dx = x2 - _arrowStart.x, dy = y2 - _arrowStart.y;
    if (Math.hypot(dx, dy) > 8) {
      const { arrow } = state.toolSettings;
      emit('op:annotate:arrow', {
        x1: _arrowStart.x, y1: _arrowStart.y, x2, y2,
        color: arrow.color, thickness: arrow.thickness, headSize: arrow.headSize,
      });
    }
    _arrowStart = null;
    _arrowCurrent = null;
    markDirty();
  } else if (state.activeTool === 'pencil' && _pencilPoints) {
    if (_pencilPoints.length >= 2) {
      const { pencil } = state.toolSettings;
      // Round points to .1 px to keep payload size sane on long strokes
      const points = _pencilPoints.map(p => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
      emit('op:annotate:pencil', { points, color: pencil.color, thickness: pencil.thickness });
    }
    _pencilPoints = null;
    markDirty();
  } else if (state.activeTool === 'shape' && _shapeStart) {
    const x2 = Math.round(imagePos.x), y2 = Math.round(imagePos.y);
    const dx = x2 - _shapeStart.x, dy = y2 - _shapeStart.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      const { shape } = state.toolSettings;
      emit('op:annotate:shape', {
        mode: shape.mode, x1: _shapeStart.x, y1: _shapeStart.y, x2, y2,
        color: shape.color, thickness: shape.thickness, fill: shape.fill
      });
    }
    _shapeStart = null;
    _shapeCurrent = null;
    markDirty();
  }
}

// ── Arrow live preview ─────────────────────────────────────────────────────────

function drawArrowPreview({ ctx, zoom, pan }) {
  if (state.activeTool !== 'arrow' || !_arrowStart || !_arrowCurrent) return;

  const { arrow } = state.toolSettings;
  const toC = (ix, iy) => ({ x: ix * zoom + pan.x, y: iy * zoom + pan.y });
  const s = toC(_arrowStart.x, _arrowStart.y);
  const e = toC(_arrowCurrent.x, _arrowCurrent.y);

  const angle = Math.atan2(e.y - s.y, e.x - s.x);
  const hs = arrow.headSize * zoom;
  const sx = e.x - (hs * 0.8) * Math.cos(angle);
  const sy = e.y - (hs * 0.8) * Math.sin(angle);

  ctx.save();
  ctx.strokeStyle = arrow.color;
  ctx.fillStyle = arrow.color;
  ctx.lineWidth = arrow.thickness * zoom;
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.85;

  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(sx, sy);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(e.x, e.y);
  ctx.lineTo(e.x - hs * Math.cos(angle - Math.PI / 6), e.y - hs * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(e.x - hs * Math.cos(angle + Math.PI / 6), e.y - hs * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// ── Pencil live preview ────────────────────────────────────────────────────────

function drawPencilPreview({ ctx, zoom, pan }) {
  if (state.activeTool !== 'pencil' || !_pencilPoints || _pencilPoints.length < 2) return;
  const { pencil } = state.toolSettings;
  const toC = (ix, iy) => ({ x: ix * zoom + pan.x, y: iy * zoom + pan.y });

  ctx.save();
  ctx.strokeStyle = pencil.color;
  ctx.lineWidth = pencil.thickness * zoom;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.92;

  ctx.beginPath();
  const first = toC(_pencilPoints[0].x, _pencilPoints[0].y);
  ctx.moveTo(first.x, first.y);
  if (_pencilPoints.length === 2) {
    const p = toC(_pencilPoints[1].x, _pencilPoints[1].y);
    ctx.lineTo(p.x, p.y);
  } else {
    for (let i = 1; i < _pencilPoints.length - 1; i++) {
      const p  = toC(_pencilPoints[i].x, _pencilPoints[i].y);
      const pn = toC(_pencilPoints[i + 1].x, _pencilPoints[i + 1].y);
      ctx.quadraticCurveTo(p.x, p.y, (p.x + pn.x) / 2, (p.y + pn.y) / 2);
    }
    const last = toC(_pencilPoints[_pencilPoints.length - 1].x, _pencilPoints[_pencilPoints.length - 1].y);
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
  ctx.restore();
}

// ── Shape live preview ─────────────────────────────────────────────────────────

function drawShapePreview({ ctx, zoom, pan }) {
  if (state.activeTool !== 'shape' || !_shapeStart || !_shapeCurrent) return;
  const { shape } = state.toolSettings;
  const toC = (ix, iy) => ({ x: ix * zoom + pan.x, y: iy * zoom + pan.y });
  const a = toC(_shapeStart.x, _shapeStart.y);
  const b = toC(_shapeCurrent.x, _shapeCurrent.y);

  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle   = shape.color;
  ctx.lineWidth   = shape.thickness * zoom;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.globalAlpha = 0.85;

  if (shape.mode === 'rect') {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (shape.fill) ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  } else if (shape.mode === 'circle') {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (shape.fill) ctx.fill();
    ctx.stroke();
  } else if (shape.mode === 'line') {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

// ── Text modal ─────────────────────────────────────────────────────────────────

function showTextModal(ix, iy) {
  const { text: ts } = state.toolSettings;
  let dlg = document.getElementById('modal-text');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'modal-text';
    document.body.appendChild(dlg);
  }

  dlg.innerHTML = `
    <div class="modal-header"><h2>Add Text</h2></div>
    <div class="modal-fields">
      <div class="modal-field-row">
        <label for="txt-content">Text</label>
        <textarea id="txt-content" rows="3" style="width:100%;resize:vertical">${esc(ts.content)}</textarea>
      </div>
      <div class="modal-field-row">
        <label for="txt-font">Font</label>
        <select id="txt-font">
          ${['sans-serif','serif','monospace','Arial','Georgia','Courier New','Impact'].map(f =>
            `<option value="${f}"${f === ts.font ? ' selected' : ''}>${f}</option>`
          ).join('')}
        </select>
      </div>
      <div class="modal-field-row">
        <label for="txt-size">Size</label>
        <input type="number" id="txt-size" min="8" max="300" value="${ts.size}" style="width:80px">
        <span class="modal-unit">px</span>
      </div>
      <div class="modal-field-row">
        <label for="txt-color">Color</label>
        <input type="color" id="txt-color" value="${ts.color}">
        <div class="ctx-swatches" id="txt-swatches" style="margin-left:8px">
          ${getRecentColors().map(c =>
            `<button class="ctx-swatch" type="button" data-swatch="${c}" style="background:${c}" title="${c}" aria-label="Use ${c}"></button>`
          ).join('')}
        </div>
      </div>
      <div class="modal-field-row">
        <label><input type="checkbox" id="txt-bold"${ts.bold ? ' checked' : ''}> Bold</label>
        <label><input type="checkbox" id="txt-italic"${ts.italic ? ' checked' : ''}> Italic</label>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-apply>
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-check"/></svg>
        Place Text
      </button>
    </div>
  `;

  // Wire swatches: click sets the color picker
  dlg.querySelector('#txt-swatches')?.querySelectorAll('[data-swatch]').forEach(b => {
    b.addEventListener('click', () => { dlg.querySelector('#txt-color').value = b.dataset.swatch; });
  });

  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-apply]').addEventListener('click', () => {
    const content = dlg.querySelector('#txt-content').value.trim();
    if (!content) { dlg.close(); return; }
    const font   = dlg.querySelector('#txt-font').value;
    const size   = parseInt(dlg.querySelector('#txt-size').value, 10) || ts.size;
    const color  = dlg.querySelector('#txt-color').value;
    const bold   = dlg.querySelector('#txt-bold').checked;
    const italic = dlg.querySelector('#txt-italic').checked;

    // Persist settings
    ts.content = content; ts.font = font; ts.size = size;
    ts.color = color; ts.bold = bold; ts.italic = italic;
    pushRecentColor(color);

    emit('op:annotate:text', { x: ix, y: iy + size, content, font, size, color, bold, italic });
    dlg.close();
  });

  dlg.showModal();
  dlg.querySelector('#txt-content').focus();
}
