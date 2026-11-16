// Extract text from the open image (plan/pending.md, 2026-10-14) with Tesseract.js (Apache-2.0).
// Indra OCR was the first candidate, but its weights carry a modified OpenRAIL-M licence
// ("cannot compete with our API"), so Slate does not ship it.
//
// Like the rare-format decoders, the library loads on first use from esm.sh at an exact
// version. Its worker, core and English data then download from jsdelivr (about 5 MB, cached
// by the browser). The image itself never leaves the page: recognition runs in a local worker.
//
// The photo library (src/library/textindex.js, row X3) uses the same worker: it passes a Blob
// from ocrImage(file), a version of the photo at most 1600 px on the long edge.

export const TESSERACT_URL = 'https://esm.sh/tesseract.js@7.0.0';
export const OCR_MAX_EDGE = 1600;
let workerPromise = null;

async function getWorker(lang, onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import(/* @vite-ignore */ TESSERACT_URL);
      const createWorker = mod.createWorker ?? mod.default?.createWorker;
      if (!createWorker) throw new Error('the text recogniser did not load');
      return createWorker(lang, 1, { logger: (m) => onProgressRef.fn?.(m) });
    })().catch((err) => { workerPromise = null; throw err; });
  }
  onProgressRef.fn = onProgress;
  return workerPromise;
}
const onProgressRef = { fn: null };

// A PNG or the Blob itself, from a Blob, an ImageBitmap, an OffscreenCanvas or an HTMLCanvasElement.
async function toBlob(source) {
  if (typeof Blob !== 'undefined' && source instanceof Blob) return source;
  let canvas = source;
  if (!source.convertToBlob && !source.toBlob) {
    canvas = new OffscreenCanvas(source.width, source.height);
    canvas.getContext('2d').drawImage(source, 0, 0);
  }
  return canvas.convertToBlob ? canvas.convertToBlob({ type: 'image/png' }) : new Promise(r => canvas.toBlob(r, 'image/png'));
}

// Returns { text, confidence }. `source` is a Blob, an ImageBitmap or a canvas.
export async function extractText(source, { lang = 'eng', onProgress } = {}) {
  const worker = await getWorker(lang, onProgress);
  const { data } = await worker.recognize(await toBlob(source));
  return { text: cleanText(data.text), confidence: Math.round(data.confidence ?? 0) };
}

// A version of a photo file for recognition: a PNG Blob at most `max` px on the long edge.
// The browser applies the EXIF orientation while it decodes.
export async function ocrImage(file, max = OCR_MAX_EDGE) {
  const full = await createImageBitmap(file);
  try {
    const scale = Math.min(1, max / Math.max(full.width, full.height));
    const w = Math.max(1, Math.round(full.width * scale)), h = Math.max(1, Math.round(full.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(full, 0, 0, w, h);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally { full.close?.(); }
}

// Trim trailing spaces on each line and collapse runs of three or more blank lines.
export function cleanText(text) {
  return String(text ?? '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
