// Browser-native decoder using createImageBitmap + Image element fallback for SVG

export async function decodeNative(blob) {
  const mime = blob.type;

  // SVG needs rasterization via <img> element
  if (mime === 'image/svg+xml' || blob.name?.toLowerCase().endsWith('.svg')) {
    return decodeSvg(blob);
  }

  try {
    return await createImageBitmap(blob);
  } catch (err) {
    // Fallback: load via <img> for formats createImageBitmap might reject
    return decodeViaImg(blob);
  }
}

async function decodeSvg(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('SVG decode failed'));
      img.src = url;
    });
    // Rasterize at natural size (or viewport size for SVG with no intrinsic dimensions)
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 1024;
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return await createImageBitmap(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeViaImg(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = url;
    });
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}
