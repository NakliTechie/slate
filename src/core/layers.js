import { state, commitOp } from './state.js';
import { emit } from './events.js';
import { drawText, drawArrow, drawPencil } from '../ops/annotate.js';
import { drawShape } from '../ops/shapes.js';

// IDs are derived from the current layer stack so they survive replay
// deterministically: the largest id ever in use is preserved across undo/redo
// because the layer:add op carries its id in its params.
function nextId() {
  return state.layers.reduce((m, l) => Math.max(m, l.id), 0) + 1;
}

export function addLayer(type, params) {
  const id = nextId();
  const visible = true;
  state.layers.push({ id, type, params: { ...params }, visible });
  emit('layers:changed', state.layers);
  emit('image:changed', null);
  commitOp('layer:add', { id, type, params: { ...params }, visible });
  return id;
}

export function removeLayer(id) {
  if (!state.layers.some(l => l.id === id)) return;
  state.layers = state.layers.filter(l => l.id !== id);
  emit('layers:changed', state.layers);
  emit('image:changed', null);
  commitOp('layer:remove', { id });
}

export function toggleLayer(id) {
  const l = state.layers.find(l => l.id === id);
  if (!l) return;
  l.visible = !l.visible;
  emit('layers:changed', state.layers);
  emit('image:changed', null);
  commitOp('layer:toggle', { id });
}

export function moveLayer(id, direction) {
  const i = state.layers.findIndex(l => l.id === id);
  if (i < 0) return;
  const j = i + direction;
  if (j < 0 || j >= state.layers.length) return;
  [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
  emit('layers:changed', state.layers);
  emit('image:changed', null);
  commitOp('layer:move', { id, direction });
}

// Used by replay (no history commit) — bulk replace the layer stack.
export function setLayers(layers) {
  state.layers = layers.map(l => ({ id: l.id, type: l.type, params: { ...l.params }, visible: l.visible }));
  emit('layers:changed', state.layers);
}

// Live-path: clear without committing. Used by runOp post-flatten.
export function clearLayers() {
  if (state.layers.length === 0) return;
  state.layers = [];
  emit('layers:changed', state.layers);
}

// Render a single layer onto a ctx already positioned in image-space.
export function drawLayer(ctx, layer) {
  if (!layer.visible) return;
  if (layer.type === 'text')        drawText(ctx, layer.params);
  else if (layer.type === 'arrow')  drawArrow(ctx, layer.params);
  else if (layer.type === 'pencil') drawPencil(ctx, layer.params);
  else if (layer.type === 'shape')  drawShape(ctx, layer.params);
}

// Flatten an arbitrary layer list onto a copy of the canvas.
// Defaults to the current state.layers when no list is provided.
export function flattenLayers(canvas, layers = state.layers) {
  if (!layers.length) return canvas;
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  for (const layer of layers) {
    if (!layer.visible) continue;
    if (layer.type === 'text')        drawText(ctx, layer.params);
    else if (layer.type === 'arrow')  drawArrow(ctx, layer.params);
    else if (layer.type === 'pencil') drawPencil(ctx, layer.params);
    else if (layer.type === 'shape')  drawShape(ctx, layer.params);
  }
  return out;
}

// Apply a single layer op to a layer stack. Used by the replay walker.
export function applyLayerOp(layers, op, params) {
  if (op === 'layer:add') {
    return [...layers, { id: params.id, type: params.type, params: { ...params.params }, visible: params.visible !== false }];
  }
  if (op === 'layer:remove') {
    return layers.filter(l => l.id !== params.id);
  }
  if (op === 'layer:toggle') {
    return layers.map(l => l.id === params.id ? { ...l, visible: !l.visible } : l);
  }
  if (op === 'layer:move') {
    const i = layers.findIndex(l => l.id === params.id);
    if (i < 0) return layers;
    const j = i + params.direction;
    if (j < 0 || j >= layers.length) return layers;
    const out = [...layers];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }
  return layers;
}

export function isLayerOp(op) {
  return op === 'layer:add' || op === 'layer:remove' || op === 'layer:toggle' || op === 'layer:move';
}
