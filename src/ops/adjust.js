import { isWebGPUAvailable, applyAdjust as applyAdjustGPU } from '../gpu/adjust.js';
import { adjustPixels } from './colour.js';

// Use GPU path above this many pixels — CPU is usually faster below.
const GPU_MIN_PIXELS = 1_000_000;

// Linear-light adjustments (colour.js):
// brightness: -100..+100, exposure of ±2 stops
// contrast:   -100..+100, power curve about middle grey
// saturation: -100..+200, Oklab chroma scale
export async function apply(canvas, params) {
  const { width: W, height: H } = canvas;
  const { brightness = 0, contrast = 0, saturation = 0 } = params;

  if (isWebGPUAvailable() && W * H >= GPU_MIN_PIXELS) {
    try {
      return await applyAdjustGPU(canvas, { brightness, contrast, saturation });
    } catch (err) {
      console.warn('WebGPU adjust failed, falling back to CPU:', err.message);
    }
  }

  return applyAdjustCPU(canvas, { brightness, contrast, saturation });
}

async function applyAdjustCPU(canvas, params) {
  const { width: W, height: H } = canvas;
  const src = canvas.getContext('2d').getImageData(0, 0, W, H);
  adjustPixels(src.data, params);
  const out = new OffscreenCanvas(W, H);
  out.getContext('2d').putImageData(src, 0, 0);
  return out;
}
