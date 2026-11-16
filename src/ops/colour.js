// Colour maths for the adjustments, in float linear light (plan/pending.md, 2026-10-12).
// The old path added a fixed offset to 8-bit display values, pivoted contrast at 128 and
// mixed saturation against sRGB luma, which clips highlights and shifts hue. Here:
//   exposure    in stops: linear × 2^EV (the Brightness slider, ±100, maps to ±2 EV)
//   contrast    a power curve about middle grey (0.18 linear), so black and middle grey stay put
//   saturation  scales chroma in Oklab, so hue and lightness hold
// Pure functions; the CPU path and the Node tests use them, and gpu/adjust.js mirrors them in WGSL.

export const MID_GREY = 0.18;
export const EV_PER_UNIT = 2 / 100;          // slider ±100 → ±2 stops

export function srgbToLinear(v) {             // v in 0..1
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
export function linearToSrgb(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

// 8-bit sRGB to linear, as a 256-entry table.
export const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_TO_LINEAR[i] = srgbToLinear(i / 255);

// Oklab (Björn Ottosson, 2020), from linear sRGB.
export function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
export function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

// Slider values to the numbers the maths uses.
//   brightness -100..100 → gain 2^EV;  contrast -100..100 → exponent 0.5..2 (1 = none);  saturation -100..200 → chroma ×0..3
export function adjustFactors({ brightness = 0, contrast = 0, saturation = 0 } = {}) {
  return {
    gain: 2 ** (brightness * EV_PER_UNIT),
    k: 2 ** (contrast / 100),
    sat: Math.max(0, 1 + saturation / 100),
  };
}

// One pixel, linear in and linear out.
export function adjustLinear(r, g, b, { gain, k, sat }) {
  r *= gain; g *= gain; b *= gain;
  if (k !== 1) {
    r = r > 0 ? MID_GREY * (r / MID_GREY) ** k : 0;
    g = g > 0 ? MID_GREY * (g / MID_GREY) ** k : 0;
    b = b > 0 ? MID_GREY * (b / MID_GREY) ** k : 0;
  }
  if (sat !== 1) {
    const [L, A, B] = linearToOklab(Math.max(0, r), Math.max(0, g), Math.max(0, b));
    [r, g, b] = oklabToLinear(L, A * sat, B * sat);
  }
  return [r, g, b];
}

// RGBA 8-bit buffer in place.
export function adjustPixels(data, params) {
  const f = adjustFactors(params);
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = adjustLinear(SRGB_TO_LINEAR[data[i]], SRGB_TO_LINEAR[data[i + 1]], SRGB_TO_LINEAR[data[i + 2]], f);
    data[i] = Math.round(linearToSrgb(r) * 255);
    data[i + 1] = Math.round(linearToSrgb(g) * 255);
    data[i + 2] = Math.round(linearToSrgb(b) * 255);
  }
  return data;
}
