import { adjustFactors } from '../ops/colour.js';

// WebGPU fast path for the exposure / contrast / saturation adjustment.
// Falls back silently — callers should catch and use the CPU path.

let _device = null;

export function isWebGPUAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

async function getDevice() {
  if (_device) return _device;
  if (!navigator.gpu) throw new Error('WebGPU not available');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No GPU adapter');
  _device = await adapter.requestDevice();
  return _device;
}

// Mirrors src/ops/colour.js: decode sRGB to linear, exposure gain, contrast power curve
// about middle grey, saturation as an Oklab chroma scale, encode back to sRGB.
const WGSL = `
struct Params {
  gain: f32,
  k: f32,
  sat: f32,
  _pad: f32,
};

@group(0) @binding(0) var inputTex:  texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;

fn toLinear(v: vec3<f32>) -> vec3<f32> {
  return select(pow((v + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), v / 12.92, v <= vec3<f32>(0.04045));
}
fn toSrgb(v0: vec3<f32>) -> vec3<f32> {
  let v = clamp(v0, vec3<f32>(0.0), vec3<f32>(1.0));
  return select(1.055 * pow(v, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055), v * 12.92, v <= vec3<f32>(0.0031308));
}
fn cbrt3(v: vec3<f32>) -> vec3<f32> { return sign(v) * pow(abs(v), vec3<f32>(1.0 / 3.0)); }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inputTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let src = textureLoad(inputTex, vec2<i32>(i32(id.x), i32(id.y)), 0);
  var c = toLinear(src.rgb) * params.gain;
  if (params.k != 1.0) {
    c = select(vec3<f32>(0.0), 0.18 * pow(max(c, vec3<f32>(1e-12)) / 0.18, vec3<f32>(params.k)), c > vec3<f32>(0.0));
  }
  if (params.sat != 1.0) {
    let p = max(c, vec3<f32>(0.0));
    let lms = cbrt3(vec3<f32>(
      0.4122214708 * p.r + 0.5363325363 * p.g + 0.0514459929 * p.b,
      0.2119034982 * p.r + 0.6806995451 * p.g + 0.1073969566 * p.b,
      0.0883024619 * p.r + 0.2817188376 * p.g + 0.6299787005 * p.b));
    let L = 0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z;
    let A = (1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z) * params.sat;
    let B = (0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z) * params.sat;
    let l3 = pow(L + 0.3963377774 * A + 0.2158037573 * B, 3.0);
    let m3 = pow(L - 0.1055613458 * A - 0.0638541728 * B, 3.0);
    let s3 = pow(L - 0.0894841775 * A - 1.2914855480 * B, 3.0);
    c = vec3<f32>(
      4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
      -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
      -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3);
  }
  textureStore(outputTex, vec2<i32>(i32(id.x), i32(id.y)), vec4<f32>(toSrgb(c), src.a));
}
`;

export async function applyAdjust(canvas, { brightness = 0, contrast = 0, saturation = 0 }) {
  const device = await getDevice();
  const W = canvas.width, H = canvas.height;

  // Read source pixels as Uint8 for GPU upload
  const srcCtx = canvas.getContext('2d');
  const srcImage = srcCtx.getImageData(0, 0, W, H);

  const inputTex = device.createTexture({
    size: [W, H, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  device.queue.writeTexture(
    { texture: inputTex },
    srcImage.data,
    { bytesPerRow: W * 4 },
    [W, H, 1]
  );

  const outputTex = device.createTexture({
    size: [W, H, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });

  const f = adjustFactors({ brightness, contrast, saturation });

  const paramsBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paramsBuf, 0, new Float32Array([f.gain, f.k, f.sat, 0]));

  const shader = device.createShaderModule({ code: WGSL });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: shader, entryPoint: 'main' },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: inputTex.createView() },
      { binding: 1, resource: outputTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
  pass.end();

  // Copy output texture to a readback buffer (row-stride aligned to 256)
  const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
  const readBuf = device.createBuffer({
    size: bytesPerRow * H,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer(
    { texture: outputTex },
    { buffer: readBuf, bytesPerRow },
    [W, H, 1]
  );
  device.queue.submit([encoder.finish()]);

  await readBuf.mapAsync(GPUMapMode.READ);
  const aligned = new Uint8Array(readBuf.getMappedRange());

  // Re-pack rows into a tight Uint8ClampedArray for putImageData
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    out.set(aligned.subarray(y * bytesPerRow, y * bytesPerRow + W * 4), y * W * 4);
  }
  readBuf.unmap();

  const outCanvas = new OffscreenCanvas(W, H);
  const outImage = new ImageData(out, W, H);
  outCanvas.getContext('2d').putImageData(outImage, 0, 0);

  inputTex.destroy();
  outputTex.destroy();
  paramsBuf.destroy();
  readBuf.destroy();

  return outCanvas;
}
