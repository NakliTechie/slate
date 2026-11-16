// WebGPU fast path for brightness / contrast / saturation adjustment.
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

const WGSL = `
struct Params {
  brightness: f32,
  contrast: f32,
  saturation: f32,
  _pad: f32,
};

@group(0) @binding(0) var inputTex:  texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(inputTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }

  let src = textureLoad(inputTex, vec2<i32>(i32(id.x), i32(id.y)), 0);
  var c = src.rgb;

  // Brightness: add offset in 0..1 space (params.brightness is in -100..100 normalised by caller to ±100/255)
  c = c + vec3<f32>(params.brightness);

  // Contrast: standard formula normalised. cf = (259(C+255)) / (255(259-C)) where C ∈ [-255,255].
  // params.contrast passes cf directly to avoid recomputing per-pixel on the GPU.
  c = (c - vec3<f32>(0.5)) * params.contrast + vec3<f32>(0.5);

  // Saturation: luminosity (Rec.709) + interpolation.
  let lum = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  let satF = 1.0 + params.saturation;
  c = vec3<f32>(lum) + (c - vec3<f32>(lum)) * satF;

  c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  textureStore(outputTex, vec2<i32>(i32(id.x), i32(id.y)), vec4<f32>(c, src.a));
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

  // Precompute contrast factor on CPU, ship as uniform (single value).
  const cf = contrast !== 0
    ? (259 * (contrast + 255)) / (255 * (259 - contrast))
    : 1;

  const paramsBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paramsBuf, 0, new Float32Array([
    brightness / 255,
    cf,
    saturation / 100,
    0,
  ]));

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
