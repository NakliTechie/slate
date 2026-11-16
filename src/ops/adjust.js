import { isWebGPUAvailable, applyAdjust as applyAdjustGPU } from '../gpu/adjust.js';

// Use GPU path above this many pixels — CPU is usually faster below.
const GPU_MIN_PIXELS = 1_000_000;

// brightness: -100..+100 (pixel offset)
// contrast:   -100..+100 (standard formula)
// saturation: -100..+200 (percent delta)
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

async function applyAdjustCPU(canvas, { brightness, contrast, saturation }) {
  const { width: W, height: H } = canvas;
  const src = canvas.getContext('2d').getImageData(0, 0, W, H);
  const d = src.data;

  const cf = contrast !== 0
    ? (259 * (contrast + 255)) / (255 * (259 - contrast))
    : 1;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i+1], b = d[i+2];

    // Brightness
    r += brightness; g += brightness; b += brightness;

    // Contrast
    if (contrast !== 0) {
      r = cf * (r - 128) + 128;
      g = cf * (g - 128) + 128;
      b = cf * (b - 128) + 128;
    }

    // Saturation via luminosity
    if (saturation !== 0) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const f = 1 + saturation / 100;
      r = lum + (r - lum) * f;
      g = lum + (g - lum) * f;
      b = lum + (b - lum) * f;
    }

    d[i]   = Math.max(0, Math.min(255, r));
    d[i+1] = Math.max(0, Math.min(255, g));
    d[i+2] = Math.max(0, Math.min(255, b));
  }

  const out = new OffscreenCanvas(W, H);
  out.getContext('2d').putImageData(src, 0, 0);
  return out;
}
