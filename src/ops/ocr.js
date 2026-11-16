// Extract text from the open image (plan/pending.md, 2026-10-14) with Tesseract.js (Apache-2.0).
// Indra OCR was the first candidate, but its weights carry a modified OpenRAIL-M licence
// ("cannot compete with our API"), so Slate does not ship it.
//
// Like the rare-format decoders, the library loads on first use from esm.sh at an exact
// version. Its worker, core and English data then download from jsdelivr (about 5 MB, cached
// by the browser). The image itself never leaves the page: recognition runs in a local worker.

export const TESSERACT_URL = 'https://esm.sh/tesseract.js@7.0.0';
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

// Returns { text, words, confidence }. `canvas` is an OffscreenCanvas or HTMLCanvasElement.
export async function extractText(canvas, { lang = 'eng', onProgress } = {}) {
  const worker = await getWorker(lang, onProgress);
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise(r => canvas.toBlob(r, 'image/png'));
  const { data } = await worker.recognize(blob);
  return { text: cleanText(data.text), confidence: Math.round(data.confidence ?? 0) };
}

// Trim trailing spaces on each line and collapse runs of three or more blank lines.
export function cleanText(text) {
  return String(text ?? '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
