// amount: 0..5, typical 1.0
export async function apply(canvas, { amount = 1.0 }) {
  const { width: W, height: H } = canvas;

  const blurCanvas = new OffscreenCanvas(W, H);
  const blurCtx = blurCanvas.getContext('2d');
  blurCtx.filter = 'blur(1px)';
  blurCtx.drawImage(canvas, 0, 0);

  const src     = canvas.getContext('2d').getImageData(0, 0, W, H);
  const blurred = blurCtx.getImageData(0, 0, W, H);

  const out = new OffscreenCanvas(W, H);
  const outData = out.getContext('2d').createImageData(W, H);
  const od = outData.data;

  for (let i = 0; i < src.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      od[i+c] = Math.max(0, Math.min(255,
        src.data[i+c] + amount * (src.data[i+c] - blurred.data[i+c])
      ));
    }
    od[i+3] = src.data[i+3];
  }

  out.getContext('2d').putImageData(outData, 0, 0);
  return out;
}
