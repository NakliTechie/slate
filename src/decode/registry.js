import { decodeNative } from './native.js';
import { decodeHeic } from './heic.js';
import { decodeTiff } from './tiff.js';
import { decodeRaw } from './raw.js';
import { decodeJxl } from './jxl.js';
import { decodePsd } from './psd.js';
import { decodeTga } from './tga.js';
import { decodeDds } from './dds.js';

// Supported v1 input formats
const SUPPORTED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/avif', 'image/svg+xml', 'image/bmp',
  'image/heic', 'image/heif',
  'image/tiff',
  'image/x-raw',
  'image/jxl',
  'image/vnd.adobe.photoshop',
  'image/x-targa', 'image/x-tga',
  'image/vnd.ms-dds',
]);

const SUPPORTED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg', 'bmp',
  'heic', 'heif',
  'tif', 'tiff',
  'cr2', 'nef', 'arw', 'dng', 'raf', 'orf',
  'jxl',
  'psd',
  'tga', 'tpic',
  'dds',
]);

const RAW_EXTS = new Set(['cr2', 'nef', 'arw', 'dng', 'raf', 'orf']);

const EXT_TO_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  svg: 'image/svg+xml', bmp: 'image/bmp',
  heic: 'image/heic', heif: 'image/heif',
  tif: 'image/tiff', tiff: 'image/tiff',
  cr2: 'image/x-raw', nef: 'image/x-raw', arw: 'image/x-raw',
  dng: 'image/x-raw', raf: 'image/x-raw', orf: 'image/x-raw',
  jxl: 'image/jxl',
  psd: 'image/vnd.adobe.photoshop',
  tga: 'image/x-targa', tpic: 'image/x-targa',
  dds: 'image/vnd.ms-dds',
};

export function isSupportedFile(file) {
  if (SUPPORTED_TYPES.has(file.type)) return true;
  const ext = extOf(file.name);
  return ext != null && SUPPORTED_EXTENSIONS.has(ext);
}

export function extOf(name) {
  const dot = name?.lastIndexOf('.');
  if (dot == null || dot < 0) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function mimeOf(file) {
  if (file.type && SUPPORTED_TYPES.has(file.type)) return file.type;
  const ext = extOf(file.name);
  return ext ? (EXT_TO_MIME[ext] ?? null) : null;
}

export function formatOf(file) {
  const mime = mimeOf(file);
  const map = {
    'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
    'image/heic': 'heic', 'image/heif': 'heif',
    'image/tiff': 'tiff',
    'image/x-raw': 'raw',
    'image/jxl': 'jxl',
    'image/vnd.adobe.photoshop': 'psd',
    'image/x-targa': 'tga', 'image/x-tga': 'tga',
    'image/vnd.ms-dds': 'dds',
  };
  return map[mime] ?? 'unknown';
}

// Check if AVIF is supported by the browser
let _avifSupported = null;
export async function checkAvifSupport() {
  if (_avifSupported !== null) return _avifSupported;
  try {
    // Tiny 1×1 AVIF
    const avif = 'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAABcAAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDAQAEAAAAAAMCAA==';
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve; img.onerror = reject; img.src = avif;
    });
    _avifSupported = true;
  } catch {
    _avifSupported = false;
  }
  return _avifSupported;
}

export async function decode(file) {
  const mime = mimeOf(file);
  if (!mime) throw new Error(`Unsupported format: ${file.name}`);

  // Warn gracefully if AVIF not supported
  if (mime === 'image/avif') {
    const ok = await checkAvifSupport();
    if (!ok) throw new Error('AVIF is not supported in this browser. Try Chrome or Firefox.');
  }

  // Ensure the blob has the correct MIME type
  const blob = file.type === mime ? file : file.slice(0, file.size, mime);

  // HEIC / HEIF: try native, then lazy-load libheif fallback
  if (mime === 'image/heic' || mime === 'image/heif') {
    return decodeHeic(blob);
  }

  // TIFF: lazy-load utif
  if (mime === 'image/tiff') {
    return decodeTiff(blob);
  }

  // RAW: extract embedded JPEG preview
  if (mime === 'image/x-raw' || RAW_EXTS.has(extOf(file.name))) {
    return decodeRaw(blob);
  }

  // JPEG-XL
  if (mime === 'image/jxl' || extOf(file.name) === 'jxl') {
    return decodeJxl(blob);
  }

  // PSD
  if (mime === 'image/vnd.adobe.photoshop' || extOf(file.name) === 'psd') {
    return decodePsd(blob);
  }

  // TGA
  if (mime === 'image/x-targa' || mime === 'image/x-tga' || extOf(file.name) === 'tga' || extOf(file.name) === 'tpic') {
    return decodeTga(blob);
  }

  // DDS
  if (mime === 'image/vnd.ms-dds' || extOf(file.name) === 'dds') {
    return decodeDds(blob);
  }

  return decodeNative(blob);
}
