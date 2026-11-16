// live-check-data.mjs: page-side code (as strings) that builds a synthetic photo folder in OPFS for the live
// checks. No real photos are used. The folder is `slate-livecheck-<stamp>` at the OPFS root; the live check
// deletes it by that name when it finishes.
//
// makeFolderJs({ name, count, videos }) returns the body of an async function that runs in the page and resolves
// to { name, files, bytes, ms }. Photos are JPEGs drawn on a canvas, each with an EXIF APP1 block carrying
// DateTimeOriginal (spread over 2023 and 2024), Make, Model and Orientation 1, and GPS on every 10th photo.
// They sit in year/month folders. A few extras test the edges: a PNG with no EXIF, a JPEG with an XMP
// sidecar (tags and a rating), a dot-folder that must be skipped, and short WebM videos.

export function makeFolderJs({ name, count = 200, videos = 2, scenic = false }) {
  return `
  const t0 = performance.now();
  const root = await navigator.storage.getDirectory();
  const top = await root.getDirectoryHandle(${JSON.stringify(name)}, { create: true });
  const enc = new TextEncoder();

  // EXIF APP1 (little-endian TIFF): IFD0 Make, Model, Orientation, ExifIFD pointer, GPS pointer; ExifIFD DateTimeOriginal.
  function exifApp1({ date, make, model, gps }) {
    const ascii = s => [...enc.encode(s), 0];
    const entries0 = [], data = [];
    const ifd0Count = gps ? 5 : 4;
    const ifd0Size = 2 + ifd0Count * 12 + 4;
    const exifIfdOff = 8 + ifd0Size;
    const exifIfdSize = 2 + 12 + 4;
    const gpsIfdOff = exifIfdOff + exifIfdSize;
    const gpsIfdSize = gps ? 2 + 4 * 12 + 4 : 0;
    let dataOff = gpsIfdOff + gpsIfdSize;
    const blobs = [];
    const put = (bytes) => { const off = dataOff; blobs.push(bytes); dataOff += bytes.length; return off; };
    const u16 = v => [v & 255, v >> 8], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const entry = (tag, type, count, valueOrOff) => [...u16(tag), ...u16(type), ...u32(count), ...(type === 3 && count === 1 ? [...u16(valueOrOff), 0, 0] : u32(valueOrOff))];
    const mk = ascii(make), md = ascii(model), dt = ascii(date);
    const ifd0 = [...u16(ifd0Count),
      ...entry(0x010F, 2, mk.length, put(mk)),
      ...entry(0x0110, 2, md.length, put(md)),
      ...entry(0x0112, 3, 1, 1),
      ...entry(0x8769, 4, 1, exifIfdOff),
      ...(gps ? entry(0x8825, 4, 1, gpsIfdOff) : []),
      ...u32(0)];
    const exifIfd = [...u16(1), ...entry(0x9003, 2, dt.length, put(dt)), ...u32(0)];
    let gpsIfd = [];
    if (gps) {
      const rat = (deg) => { const d = Math.floor(deg), m = Math.floor((deg - d) * 60), s = Math.round(((deg - d) * 60 - m) * 60 * 100); return [...u32(d), ...u32(1), ...u32(m), ...u32(1), ...u32(s), ...u32(100)]; };
      gpsIfd = [...u16(4),
        ...entry(0x0001, 2, 2, (gps.lat >= 0 ? 78 : 83)),
        ...entry(0x0002, 5, 3, put(rat(Math.abs(gps.lat)))),
        ...entry(0x0003, 2, 2, (gps.lon >= 0 ? 69 : 87)),
        ...entry(0x0004, 5, 3, put(rat(Math.abs(gps.lon)))),
        ...u32(0)];
    }
    const tiff = [0x49, 0x49, 42, 0, ...u32(8), ...ifd0, ...exifIfd, ...gpsIfd, ...blobs.flat()];
    const body = [...enc.encode('Exif'), 0, 0, ...tiff];
    const len = body.length + 2;
    return new Uint8Array([0xFF, 0xE1, len >> 8, len & 255, ...body]);
  }
  function withExif(jpeg, app1) {
    // insert after SOI (and after JFIF APP0 if present)
    let at = 2;
    if (jpeg[2] === 0xFF && jpeg[3] === 0xE0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
    const out = new Uint8Array(jpeg.length + app1.length);
    out.set(jpeg.subarray(0, at), 0); out.set(app1, at); out.set(jpeg.subarray(at), at + app1.length);
    return out;
  }
  async function write(dir, fname, bytes) {
    const fh = await dir.getFileHandle(fname, { create: true });
    const w = await fh.createWritable(); await w.write(bytes); await w.close();
    return bytes.byteLength ?? bytes.size;
  }

  // 12 base images, reused with different EXIF so generation stays fast.
  const bases = [];
  for (let i = 0; i < 12; i++) {
    const c = new OffscreenCanvas(i % 3 === 0 ? 480 : 640, i % 3 === 0 ? 640 : 480);
    const g = c.getContext('2d');
    if (${scenic}) {
      // a procedural landscape: sky gradient, sun, three hill layers, water; no real photo
      const W = c.width, H = c.height, hue = [200, 25, 330, 210, 40, 190, 15, 260, 180, 35, 220, 300][i];
      const sky = g.createLinearGradient(0, 0, 0, H * .7);
      sky.addColorStop(0, 'hsl(' + hue + ' 55% ' + (i % 2 ? 30 : 62) + '%)'); sky.addColorStop(1, 'hsl(' + (hue + 30) + ' 70% ' + (i % 2 ? 62 : 85) + '%)');
      g.fillStyle = sky; g.fillRect(0, 0, W, H);
      g.beginPath(); g.arc(W * (.25 + (i % 4) * .17), H * (.25 + (i % 3) * .1), 22 + (i % 3) * 10, 0, 7); g.fillStyle = 'hsl(' + (hue + 40) + ' 90% 88%)'; g.fill();
      for (let k = 0; k < 3; k++) {
        g.beginPath(); g.moveTo(0, H);
        for (let x = 0; x <= W; x += 8) g.lineTo(x, H * (.5 + k * .12) + Math.sin(x / (60 + k * 30) + i + k) * (24 - k * 5) + Math.sin(x / 23 + k) * 4);
        g.lineTo(W, H); g.closePath(); g.fillStyle = 'hsl(' + (hue + 140 + k * 10) + ' ' + (30 + k * 8) + '% ' + (40 - k * 11) + '%)'; g.fill();
      }
      if (i % 3 === 1) { const wat = g.createLinearGradient(0, H * .82, 0, H); wat.addColorStop(0, 'hsl(' + hue + ' 50% 45%)'); wat.addColorStop(1, 'hsl(' + hue + ' 60% 25%)'); g.fillStyle = wat; g.fillRect(0, H * .82, W, H * .18); }
    } else {
      g.fillStyle = 'hsl(' + (i * 30) + ' 60% 55%)'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = 'rgba(255,255,255,.8)'; g.font = 'bold 96px sans-serif'; g.fillText(String(i + 1), 40, 140);
      g.beginPath(); g.arc(c.width * .65, c.height * .6, 90, 0, 7); g.fillStyle = 'hsl(' + (i * 30 + 180) + ' 70% 40%)'; g.fill();
    }
    bases.push(new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: .8 })).arrayBuffer()));
  }

  const dirs = new Map();
  async function dirFor(path) {
    if (dirs.has(path)) return dirs.get(path);
    let d = top;
    for (const p of path.split('/')) d = await d.getDirectoryHandle(p, { create: true });
    dirs.set(path, d); return d;
  }
  let files = 0, bytes = 0;
  const N = ${count};
  for (let i = 0; i < N; i++) {
    const t = Date.UTC(2023, 0, 1) + Math.floor(i * (730 * 86400000) / N) + (i % 7) * 3600000;
    const d = new Date(t);
    const y = d.getUTCFullYear(), mo = String(d.getUTCMonth() + 1).padStart(2, '0'), da = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const date = y + ':' + mo + ':' + da + ' ' + hh + ':00:00';
    const app1 = exifApp1({ date, make: i % 2 ? 'Canon' : 'Google', model: i % 2 ? 'EOS R6' : 'Pixel 8', gps: i % 10 === 0 ? { lat: 15.5 + (i % 5) / 10, lon: 73.8 } : null });
    const dir = await dirFor(y + '/' + mo);
    bytes += await write(dir, 'IMG_' + String(i).padStart(5, '0') + '.jpg', withExif(bases[i % bases.length], app1));
    files++;
  }
  // edges
  const extra = await dirFor('extras');
  const png = new OffscreenCanvas(300, 200); png.getContext('2d').fillRect(0, 0, 300, 200);
  bytes += await write(extra, 'no-exif.png', await png.convertToBlob({ type: 'image/png' })); files++;
  bytes += await write(extra, 'tagged.jpg', withExif(bases[0], exifApp1({ date: '2022:06:15 10:30:00', make: 'Sony', model: 'A7', gps: null }))); files++;
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmp:Rating="4"><dc:subject><rdf:Bag><rdf:li>livecheck</rdf:li><rdf:li>beach</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>';
  bytes += await write(extra, 'tagged.jpg.xmp', enc.encode(xmp)); files++;
  const hidden = await top.getDirectoryHandle('.cache', { create: true });
  bytes += await write(hidden, 'skip-me.jpg', bases[1]); files++;
  // videos: a short WebM recorded from a canvas
  for (let v = 0; v < ${videos}; v++) {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
    const chunks = []; rec.ondataavailable = e => chunks.push(e.data);
    const stopped = new Promise(r => rec.onstop = r);
    rec.start();
    const tEnd = performance.now() + 1200;
    while (performance.now() < tEnd) { g.fillStyle = 'hsl(' + ((performance.now() / 5) % 360) + ' 70% 50%)'; g.fillRect(0, 0, 320, 240); await new Promise(r => setTimeout(r, 60)); }
    rec.stop(); await stopped;
    bytes += await write(extra, 'clip-' + v + '.webm', new Blob(chunks, { type: 'video/webm' })); files++;
  }
  return { name: ${JSON.stringify(name)}, files, bytes, ms: Math.round(performance.now() - t0) };`;
}

// Deletes the synthetic folder by its exact name.
export function removeFolderJs(name) {
  return `const root = await navigator.storage.getDirectory(); await root.removeEntry(${JSON.stringify(name)}, { recursive: true }); return true;`;
}
