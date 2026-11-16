import { state, commitOp, replaceWorking } from './state.js';
import { on, emit } from './events.js';
import { addLayer, flattenLayers, clearLayers, setLayers, applyLayerOp, isLayerOp } from './layers.js';
import { pushRecentColor } from './colors.js';

import * as cropOp       from '../ops/crop.js';
import * as rotateOp     from '../ops/rotate.js';
import * as flipOp       from '../ops/flip.js';
import * as redactOp     from '../ops/redact.js';
import * as blurOp       from '../ops/blur.js';
import * as pixelateOp   from '../ops/pixelate.js';
import * as resizeOp     from '../ops/resize.js';
import * as adjustOp     from '../ops/adjust.js';
import * as sharpenOp    from '../ops/sharpen.js';
import * as straightenOp from '../ops/straighten.js';
import { applyText, applyArrow } from '../ops/annotate.js';

const OPS = {
  crop: cropOp, rotate: rotateOp, flip: flipOp,
  redact: redactOp, blur: blurOp, pixelate: pixelateOp, resize: resizeOp,
  adjust: adjustOp, sharpen: sharpenOp, straighten: straightenOp,
};

export function initOpRunner() {
  on('op:crop', async () => {
    const { selection } = state;
    if (!selection.shape || !state.image.working) return;
    await runOp('crop', { x: selection.x, y: selection.y, w: selection.w, h: selection.h });
    emit('selection:clear', null);
    emit('tool:activate', { tool: state.activeTool }); // toggle off
    emit('fit:window', null);
  });

  on('op:rotate', async ({ deg }) => {
    if (!state.image.working) return;
    await runOp('rotate', { deg });
    emit('fit:window', null);
  });

  on('op:flip', async ({ axis }) => {
    if (!state.image.working) return;
    await runOp('flip', { axis });
  });

  on('op:redact', async () => {
    const { selection, toolSettings } = state;
    if (!selection.shape || !state.image.working) return;
    await runOp('redact', { x: selection.x, y: selection.y, w: selection.w, h: selection.h, fill: toolSettings.redactFill });
    emit('selection:clear', null);
    emit('tool:activate', { tool: state.activeTool });
  });

  on('op:blur', async () => {
    const { selection, toolSettings } = state;
    if (!selection.shape || !state.image.working) return;
    await runOp('blur', { x: selection.x, y: selection.y, w: selection.w, h: selection.h, strength: toolSettings.blurStrength });
    emit('selection:clear', null);
    emit('tool:activate', { tool: state.activeTool });
  });

  on('op:resize', async (params) => {
    if (!state.image.working) return;
    await runOp('resize', params);
    emit('fit:window', null);
  });

  on('op:adjust', async (params) => {
    if (!state.image.working) return;
    await runOp('adjust', params);
  });

  on('op:sharpen', async (params) => {
    if (!state.image.working) return;
    await runOp('sharpen', params);
  });

  on('op:straighten', async (params) => {
    if (!state.image.working) return;
    await runOp('straighten', params);
    emit('fit:window', null);
  });

  on('op:annotate:text', async (params) => {
    if (!state.image.working) return;
    addLayer('text', params);
  });

  on('op:annotate:arrow', async (params) => {
    if (!state.image.working) return;
    addLayer('arrow', params);
  });

  on('op:annotate:pencil', async (params) => {
    if (!state.image.working) return;
    addLayer('pencil', params);
  });

  on('op:annotate:shape', async (params) => {
    if (!state.image.working) return;
    addLayer('shape', params);
  });

  on('op:pixelate', async () => {
    const { selection, toolSettings } = state;
    if (!selection.shape || !state.image.working) return;
    await runOp('pixelate', {
      x: selection.x, y: selection.y, w: selection.w, h: selection.h,
      size: toolSettings.pixelateSize
    });
    emit('selection:clear', null);
    emit('tool:activate', { tool: state.activeTool });
  });

  on('op:eyedropper', ({ imagePos }) => {
    if (!state.image.working) return;
    const ctx = state.image.working.getContext('2d');
    const x = Math.max(0, Math.min(state.image.width  - 1, Math.round(imagePos.x)));
    const y = Math.max(0, Math.min(state.image.height - 1, Math.round(imagePos.y)));
    const data = ctx.getImageData(x, y, 1, 1).data;
    const hex = '#' + [data[0], data[1], data[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    // Apply to all annotation tools' colour settings + clipboard
    state.toolSettings.pencil.color = hex;
    state.toolSettings.arrow.color  = hex;
    state.toolSettings.shape.color  = hex;
    state.toolSettings.text.color   = hex;
    navigator.clipboard?.writeText(hex).catch(() => {});
    pushRecentColor(hex);
    emit('toast', { message: `Picked ${hex} (copied to clipboard)`, level: 'ok', duration: 2200 });
    // After picking: return to the drawing tool the user came from. Falls back
    // to toggling eyedropper off if there was none.
    if (_toolBeforeEyedropper && _toolBeforeEyedropper !== 'eyedropper') {
      // tool:activate is a toggle — switching from eyedropper to prev requires
      // first clearing the active tool, then activating prev so its aria-pressed
      // state flips. Direct activation works because state.activeTool is currently
      // 'eyedropper', not the target tool.
      emit('tool:activate', { tool: _toolBeforeEyedropper });
    } else {
      emit('tool:activate', { tool: 'eyedropper' });
    }
  });

  // Remember the last drawing tool so eyedropper can return to it after picking.
  on('tool:changed', ({ tool }) => {
    if (tool && tool !== 'eyedropper') _toolBeforeEyedropper = tool;
  });

  on('history:undo', undoOp);
  on('history:redo', redoOp);
}

let _toolBeforeEyedropper = null;

// Live-path apply: flatten any visible layers, run the op, commit.
// Replay/walker reproduces this exact sequence.
async function runOp(name, params) {
  const mod = OPS[name];
  if (!mod) { console.warn('Unknown op:', name); return; }
  const base = flattenLayers(state.image.working);
  if (base !== state.image.working) {
    replaceWorking(base);
    clearLayers();
  }
  const result = await mod.apply(state.image.working, params);
  replaceWorking(result);
  commitOp(name, params);
}

async function undoOp() {
  if (!state.history.canUndo()) return;
  state.history.stepBack();
  await applyToPointer(state.history.pointer);
  emit('history:changed', { canUndo: state.history.canUndo(), canRedo: state.history.canRedo() });
  emit('fit:window', null);
}

async function redoOp() {
  if (!state.history.canRedo()) return;
  state.history.stepForward();
  await applyToPointer(state.history.pointer);
  emit('history:changed', { canUndo: state.history.canUndo(), canRedo: state.history.canRedo() });
  emit('fit:window', null);
}

// Walker shared by undo/redo replay and session-restore replay.
// Mutates a (canvas, layers) pair by walking ops in order. Image ops flatten
// the current layer stack into the canvas before running, mirroring runOp.
async function walkOps(canvas, layers, ops) {
  let curCanvas = canvas;
  let curLayers = layers;
  for (const { op, params } of ops) {
    if (isLayerOp(op)) {
      curLayers = applyLayerOp(curLayers, op, params);
      continue;
    }
    if (curLayers.length > 0) {
      curCanvas = flattenLayers(curCanvas, curLayers);
      curLayers = [];
    }
    const name = op.replace('annotate:', '');
    const mod = OPS[name] ?? OPS[op];
    if (mod) {
      curCanvas = await mod.apply(curCanvas, params);
    } else if (op === 'annotate:text') {
      // Legacy ops written by older sessions before layers existed
      curCanvas = await applyText(curCanvas, params);
    } else if (op === 'annotate:arrow') {
      curCanvas = await applyArrow(curCanvas, params);
    }
  }
  return { canvas: curCanvas, layers: curLayers };
}

async function applyToPointer(targetPointer) {
  const { snap, ops } = state.history.getReplayPlan(targetPointer);

  let canvas;
  let layers;
  if (snap) {
    canvas = new OffscreenCanvas(snap.width, snap.height);
    canvas.getContext('2d').putImageData(snap.imageData, 0, 0);
    layers = (snap.layers ?? []).map(l => ({ id: l.id, type: l.type, params: { ...l.params }, visible: l.visible }));
  } else {
    canvas = new OffscreenCanvas(state.image.original.width, state.image.original.height);
    canvas.getContext('2d').drawImage(state.image.original, 0, 0);
    layers = [];
  }

  const result = await walkOps(canvas, layers, ops);
  setLayers(result.layers);
  replaceWorking(result.canvas);
}

// Replay a serialised ops array (session restore after page reload).
// Walks the ops to reconstruct canvas+layers, then re-pushes the same ops to
// history so undo/redo work as before the reload.
export async function replayOps(ops) {
  if (!state.image.working || !ops?.length) return;

  let canvas = new OffscreenCanvas(state.image.original.width, state.image.original.height);
  canvas.getContext('2d').drawImage(state.image.original, 0, 0);

  const result = await walkOps(canvas, [], ops);
  setLayers(result.layers);
  replaceWorking(result.canvas);

  // Re-populate history so undo can step back through the replayed ops.
  // We push directly (not commitOp) to avoid the per-op snapshot work; one
  // final snapshot at the current pointer is enough to bootstrap further undos.
  for (const { op, params } of ops) state.history.push(op, params);
  const ctx = state.image.working.getContext('2d');
  const finalImage = ctx.getImageData(0, 0, state.image.width, state.image.height);
  const finalLayers = state.layers.map(l => ({ id: l.id, type: l.type, params: { ...l.params }, visible: l.visible }));
  state.history.saveSnapshot(state.history.pointer, finalImage, state.image.width, state.image.height, finalLayers);

  emit('history:changed', { canUndo: state.history.canUndo(), canRedo: state.history.canRedo() });
  emit('fit:window', null);
}
