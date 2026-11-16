import { History } from './history.js';
import { emit, on } from './events.js';

export const state = {
  session: {
    source: null,            // 'fsa' | 'picker' | 'dragdrop' | 'paste'
    folderHandle: null,
    files: [],               // [{ handle, name, size, type, index }]
    currentIndex: 0
  },
  image: {
    original: null,          // ImageBitmap, immutable
    working: null,           // OffscreenCanvas, current edit state
    width: 0,
    height: 0,
    format: null,            // 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'svg' | 'bmp'
    exif: null,
    recipe: null             // edit list embedded in the opened file (encode/recipe.js), or null
  },
  view: {
    zoom: 1.0,
    pan: { x: 0, y: 0 },
    fitMode: 'window',       // 'window' | 'width' | 'height' | '1:1' | 'fill'
    rulers: true,
    fullscreen: false
  },
  selection: {
    shape: null,             // 'rect' | 'circle' | null
    x: 0, y: 0, w: 0, h: 0,
    aspectLock: null,        // null | 'free' | '1:1' | '16:9' | '4:3' | 'original' | 'custom'
    customAspect: { w: 1, h: 1 }
  },
  activeTool: null,          // 'crop' | 'redact' | 'blur' | 'pixelate' | 'text' | 'arrow' | 'pencil' | 'shape' | 'eyedropper' | null
  toolSettings: {
    blurStrength: 10,
    pixelateSize: 12,
    redactFill: '#000000',
    text: { content: '', font: 'sans-serif', size: 24, color: '#ffffff', bold: false, italic: false },
    arrow:  { color: '#ff0000', thickness: 3, headSize: 12 },
    pencil: { color: '#ff0000', thickness: 4 },
    shape:  { mode: 'rect', color: '#ff0000', thickness: 3, fill: false }
  },
  layers: [],                // [{ id, type, params, visible }]
  history: new History(),
  export: {
    format: 'png',
    quality: 90,
    stripExif: true,
    embedEdits: false,
    removeLocation: true,
    saveMode: 'download'
  }
};

export const FLAGS = {
  slideshow: true
};

// Load preferences from localStorage
const PREFS_KEY = 'slate.v1.prefs';
export function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.theme != null) document.documentElement.setAttribute('data-theme', p.theme);
    if (p.rulers != null) state.view.rulers = p.rulers;
    if (p.thumbstrip != null) state._thumbstripVisible = p.thumbstrip !== false;
    if (p.saveMode) state.export.saveMode = p.saveMode;
    if (p.quality != null) state.export.quality = p.quality;
    if (p.exportFormat) state.export.format = p.exportFormat;
    if (p.stripExif != null) state.export.stripExif = p.stripExif;
    if (p.embedEdits != null) state.export.embedEdits = p.embedEdits;
    if (p.removeLocation != null) state.export.removeLocation = p.removeLocation;
    if (p.numericPanelPos) state._numericPanelPos = p.numericPanelPos;
    if (p.blurStrength != null) state.toolSettings.blurStrength = p.blurStrength;
    if (typeof p.activeTool === 'string') {
      const valid = ['crop', 'redact', 'blur', 'pixelate', 'text', 'arrow', 'pencil', 'shape'];
      if (valid.includes(p.activeTool)) state.activeTool = p.activeTool;
    }
  } catch {}
}

export function savePrefs() {
  try {
    const p = {
      theme: document.documentElement.getAttribute('data-theme'),
      rulers: state.view.rulers,
      thumbstrip: state._thumbstripVisible !== false,
      saveMode: state.export.saveMode,
      quality: state.export.quality,
      exportFormat: state.export.format,
      stripExif: state.export.stripExif,
      embedEdits: state.export.embedEdits,
      removeLocation: state.export.removeLocation,
      numericPanelPos: state._numericPanelPos,
      blurStrength: state.toolSettings.blurStrength,
      activeTool: state.activeTool && state.activeTool !== 'eyedropper' ? state.activeTool : null
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {}
}

on('tool:changed', () => savePrefs());

// Called after a new image is decoded and ready to display
export function setImage(bitmap, format, exif = null) {
  // Revoke previous bitmap
  if (state.image.original) state.image.original.close?.();

  const w = bitmap.width;
  const h = bitmap.height;
  const working = new OffscreenCanvas(w, h);
  working.getContext('2d').drawImage(bitmap, 0, 0);

  state.image.original = bitmap;
  state.image.working = working;
  state.image.width = w;
  state.image.height = h;
  state.image.format = format;
  state.image.exif = exif;

  state.selection = { shape: null, x: 0, y: 0, w: 0, h: 0, aspectLock: null, customAspect: { w: 1, h: 1 } };
  state.layers = [];
  state.history.clear();

  emit('image:loaded', { width: w, height: h, format, exif });
}

// Commit the working canvas to history as a new op
export function commitOp(op, params) {
  const pointer = state.history.push(op, params);

  // Save snapshot every SNAPSHOT_INTERVAL steps. Capture both image and layers.
  const ctx = state.image.working.getContext('2d');
  const imageData = ctx.getImageData(0, 0, state.image.width, state.image.height);
  const snapshotLayers = state.layers.map(l => ({ id: l.id, type: l.type, params: { ...l.params }, visible: l.visible }));
  state.history.saveSnapshot(pointer, imageData, state.image.width, state.image.height, snapshotLayers);

  emit('history:changed', { canUndo: state.history.canUndo(), canRedo: state.history.canRedo() });
}

// Replace the working canvas with the given OffscreenCanvas
export function replaceWorking(canvas) {
  state.image.working = canvas;
  state.image.width = canvas.width;
  state.image.height = canvas.height;
  emit('image:changed', null);
}
