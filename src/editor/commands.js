// The editor's commands (row N5). They join the library's list in src/library/commands.js,
// so they reach NakliOS and WebMCP through the same door. Each edit emits the same op event
// as its button (oprunner.js), so it lands in the editor's history and Ctrl+Z undoes it.
// A command returns once the editor reports `history:changed` (the op is applied), or fails
// after OP_TIMEOUT_MS.
//
// `run(lib, args, ctx)`: `ctx.editor` may replace the editor ({ state, emit, on, off, flatten })
// for tests; in the app it is the real state and event bus.

import { state } from '../core/state.js';
import { emit, on, off } from '../core/events.js';
import { flattenLayers } from '../core/layers.js';
import { extractText } from '../ops/ocr.js';
import { estimateDepth } from '../ops/depth.js';

export const OP_TIMEOUT_MS = 20000;
export const SAVE_TIMEOUT_MS = 60000;
export const SNAPSHOT_MAX_PX = 512;
export const SNAPSHOT_MAX_CHARS = 250000; // under the rail's 256 KB result limit

const EDITOR = { state, emit, on, off, flatten: c => flattenLayers(c) };
const ed = ctx => ctx?.editor ?? EDITOR;
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const num = (description, minimum, maximum) => ({ type: 'number', minimum, maximum, description });

function needImage(e) {
  if (!e.state.image.working) throw new Error('no image is open in the editor; open one with image.open');
}

function info(e) {
  const s = e.state;
  if (!s.image.working) return { open: false };
  const entry = s.session.files[s.session.currentIndex];
  return {
    open: true, name: entry?.name ?? null, w: s.image.width, h: s.image.height, format: s.image.format,
    history: s.history.size, edits: s.history.pointer + 1, canUndo: s.history.canUndo(), canRedo: s.history.canRedo(),
    layers: s.layers.length,
  };
}

// Emit an editor event and wait until the editor commits it to history.
function applied(e, type, params, label) {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); e.off('history:changed', done); resolve(info(e)); };
    const timer = setTimeout(() => { e.off('history:changed', done); reject(new Error(`the editor did not apply ${label}`)); }, OP_TIMEOUT_MS);
    e.on('history:changed', done);
    e.emit(type, params);
  });
}

function inRange(name, v, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
  return v;
}

// Save through the editor's own save path (app.js doSave), never overwriting the original.
function saved(e) {
  return new Promise((resolve, reject) => {
    let name = null;
    const onToast = t => { const m = /^(?:Saved as|Downloaded) (.+)$/.exec(t?.message ?? ''); if (m) name = m[1]; };
    const stop = () => { clearTimeout(timer); e.off('toast', onToast); e.off('save:complete', onDone); e.off('error', onError); };
    const onDone = p => { stop(); resolve(p?.name ?? name); };
    const onError = err => { stop(); reject(new Error(err?.message ?? 'save failed')); };
    const timer = setTimeout(() => { stop(); reject(new Error('the editor did not finish saving')); }, SAVE_TIMEOUT_MS);
    e.on('toast', onToast); e.on('save:complete', onDone); e.on('error', onError);
    e.emit('save:request', {});
  });
}

async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(s)}`;
}

export const EDITOR_COMMANDS = [
  { name: 'image.info', label: 'Image info', description: 'Describe the image open in the editor: file name, width and height in pixels, format, and how many edits are in its history.', scope: 'read', input: obj(),
    run: (lib, a, ctx) => info(ed(ctx)) },
  { name: 'image.open', label: 'Edit photo', description: 'Open one library photo (an id from library.search) in the editor, so the image commands work on it.', scope: 'read', input: obj({ id: { type: 'string' } }, ['id']), shows: true,
    run: async (lib, a, ctx) => {
      const rec = lib.get(a.id);
      if (!rec) throw new Error(`unknown photo id: ${a.id}`);
      if (rec.kind === 'video') throw new Error('videos play in the library viewer; the editor opens photos');
      if (!ctx?.ui?.openInEditor) throw new Error('the library view is not running');
      await ctx.ui.openInEditor(a.id);
      return info(ed(ctx));
    } },
  { name: 'image.crop', label: 'Crop', description: 'Crop the open image to a rectangle, in pixels from its top-left corner. Undo with image.undo.', scope: 'write',
    input: obj({ x: num('left edge', 0), y: num('top edge', 0), w: num('width', 1), h: num('height', 1) }, ['x', 'y', 'w', 'h']),
    run: (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      const { width: W, height: H } = e.state.image;
      const x = inRange('x', a.x, 0, W - 1), y = inRange('y', a.y, 0, H - 1);
      const w = inRange('w', a.w, 1, W - x), h = inRange('h', a.h, 1, H - y);
      e.state.selection = { ...e.state.selection, shape: 'rect', x, y, w, h };
      return applied(e, 'op:crop', null, 'the crop');
    } },
  { name: 'image.rotate', label: 'Rotate', description: 'Rotate the open image by 90 degrees clockwise (90), anticlockwise (-90), or 180.', scope: 'write', input: obj({ deg: { type: 'integer', enum: [90, -90, 180] } }, ['deg']),
    run: (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      if (![90, -90, 180].includes(a.deg)) throw new Error('deg must be 90, -90 or 180');
      return applied(e, 'op:rotate', { deg: a.deg }, 'the rotation');
    } },
  { name: 'image.flip', label: 'Flip', description: 'Flip the open image horizontally (h, a mirror image) or vertically (v).', scope: 'write', input: obj({ axis: { type: 'string', enum: ['h', 'v'] } }, ['axis']),
    run: (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      if (a.axis !== 'h' && a.axis !== 'v') throw new Error('axis must be h or v');
      return applied(e, 'op:flip', { axis: a.axis }, 'the flip');
    } },
  { name: 'image.resize', label: 'Resize', description: 'Resize the open image to a width and height in pixels (at most 16384 each).', scope: 'write',
    input: obj({ w: { type: 'integer', minimum: 1, maximum: 16384 }, h: { type: 'integer', minimum: 1, maximum: 16384 } }, ['w', 'h']),
    run: (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      const w = Math.round(inRange('w', a.w, 1, 16384)), h = Math.round(inRange('h', a.h, 1, 16384));
      return applied(e, 'op:resize', { w, h }, 'the resize');
    } },
  { name: 'image.adjust', label: 'Adjust', description: 'Change exposure (-100 to 100, about 2 stops at the ends), contrast (-100 to 100) and saturation (-100 to 200) of the open image. 0 leaves a setting as it is.', scope: 'write',
    input: obj({ exposure: num('-100 to 100', -100, 100), contrast: num('-100 to 100', -100, 100), saturation: num('-100 to 200', -100, 200) }),
    run: (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      const brightness = inRange('exposure', a.exposure ?? 0, -100, 100);
      const contrast = inRange('contrast', a.contrast ?? 0, -100, 100);
      const saturation = inRange('saturation', a.saturation ?? 0, -100, 200);
      if (!brightness && !contrast && !saturation) throw new Error('give exposure, contrast or saturation other than 0');
      return applied(e, 'op:adjust', { brightness, contrast, saturation }, 'the adjustment');
    } },
  { name: 'image.sharpen', label: 'Sharpen', description: 'Sharpen the open image. Amount 0.1 to 5; 1 is typical.', scope: 'write', input: obj({ amount: num('0.1 to 5', 0.1, 5) }, ['amount']),
    run: (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      return applied(e, 'op:sharpen', { amount: inRange('amount', a.amount, 0.1, 5) }, 'the sharpening');
    } },
  { name: 'image.straighten', label: 'Straighten', description: 'Rotate the open image by a small angle in degrees (-45 to 45, positive is clockwise). The canvas grows to fit.', scope: 'write', input: obj({ angle: num('degrees, -45 to 45', -45, 45) }, ['angle']),
    run: (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      const deg = inRange('angle', a.angle, -45, 45);
      if (deg === 0) throw new Error('angle must not be 0');
      return applied(e, 'op:straighten', { deg }, 'the straightening');
    } },
  { name: 'image.undo', label: 'Undo edit', description: 'Undo the last edit to the open image.', scope: 'write', input: obj(),
    run: (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      if (!e.state.history.canUndo()) throw new Error('nothing to undo');
      return applied(e, 'history:undo', null, 'the undo');
    } },
  { name: 'image.export', label: 'Export image', description: 'Save the edited image as a new file: beside the original when the editor has a save folder, otherwise as a download. The original file is never replaced. Returns the file name.', scope: 'write',
    input: obj({ format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'default png' }, quality: { type: 'integer', minimum: 1, maximum: 100, description: 'jpeg and webp only, default 90' } }),
    run: async (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      const format = a.format ?? 'png';
      if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error('format must be png, jpeg or webp');
      const exp = e.state.export;
      const prev = { format: exp.format, quality: exp.quality, saveMode: exp.saveMode };
      exp.format = format;
      exp.quality = Math.round(inRange('quality', a.quality ?? 90, 1, 100));
      exp.saveMode = e.state.session.folderHandle ? 'sidecar' : 'download';
      const to = exp.saveMode === 'sidecar' ? 'folder' : 'download';
      try { return { saved: true, name: await saved(e), to, format }; }
      finally { Object.assign(exp, prev); }
    } },
  { name: 'image.extract_text', label: 'Extract text', description: 'Read printed English text from the open image on this device (Tesseract.js; downloads about 5 MB the first time). Returns the text and a confidence from 0 to 100.', scope: 'read', input: obj(),
    run: async (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      return extractText(e.flatten(e.state.image.working));
    } },
  { name: 'image.lens_blur', label: 'Background blur', description: 'Blur the background by depth, keeping the subject at a focus point sharp. x and y are 0 to 1 across the image. The depth model (about 27 to 50 MB) downloads the first time. Undo with image.undo.', scope: 'write',
    input: obj({ x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 }, strength: { type: 'integer', minimum: 1, maximum: 100, description: 'default 50' } }, ['x', 'y']),
    run: async (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      const depth = await estimateDepth(e.state.image.working);
      return applied(e, 'op:lensblur', { focus: { x: inRange('x', a.x, 0, 1), y: inRange('y', a.y, 0, 1) }, strength: Math.round(inRange('strength', a.strength ?? 50, 1, 100)), depth }, 'the background blur');
    } },
  { name: 'image.snapshot', label: 'Snapshot', description: `A small JPEG data URL of the open image as it looks now (at most ${SNAPSHOT_MAX_PX} px on the long edge), for looking at it.`, scope: 'read', input: obj(),
    run: async (lib, a, ctx) => {
      const e = ed(ctx); needImage(e);
      const src = e.flatten(e.state.image.working);
      const scale = Math.min(1, SNAPSHOT_MAX_PX / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
      g.drawImage(src, 0, 0, w, h);
      for (const quality of [0.8, 0.6, 0.4, 0.2]) {
        const dataUrl = await toDataUrl(await c.convertToBlob({ type: 'image/jpeg', quality }));
        if (dataUrl.length <= SNAPSHOT_MAX_CHARS) return { w, h, dataUrl };
      }
      throw new Error('the snapshot is too large');
    } },
];
