# Slate

IrfanView for the browser. A complete image editor in a single HTML file.

**No install. No upload. Nothing leaves your device.**

▶️ **Try it →** [slate.naklitechie.com](https://slate.naklitechie.com/)
&nbsp;&nbsp; 📖 **Guide →** [slate.naklitechie.com/guide/](https://slate.naklitechie.com/guide/)

---

## Features

### Editor

- **Selection tools:** crop, redact (solid black box), blur, pixelate
- **Annotation tools (live layers):** text, arrow, freehand pencil, shapes (rectangle / oval / line)
- **Layers panel** — every annotation is editable: reorder, hide, delete. Survives undo across destructive transforms.
- **Eyedropper** — pick any pixel's colour from the canvas; copies to clipboard and applies to all drawing tools. Recent-colour swatches shown next to every colour picker.
- **Transforms:** rotate (90° CW / CCW / 180°), flip (H / V), straighten (fine angle, expanding canvas), resize
- **Adjustments:** brightness, contrast, saturation (WebGPU fast path, ~5× on 12 MP images), sharpen
- **Lossless JPEG rotate** via EXIF orientation flip — zero re-encode, zero quality loss

### Viewer

- Zoom (wheel + pinch), pan, fit modes (window / width / height / 1:1 / fill)
- Fullscreen, ruler overlay, pixel grid at high zoom
- Album mode: open a folder, navigate with arrow keys, thumbnail strip
- Slideshow with timer / transitions / shuffle

### File handling

- **Open:** file picker (FSA), folder picker (FSA), drag-drop, clipboard paste
- **Save:** smart Ctrl+S (workspace-folder sidecar / overwrite / download), timestamped filenames
- **Workspace folder** — pick once, every save lands there

### Formats

- **Read:** JPG, PNG, WebP, GIF (first frame), AVIF, SVG, BMP, **HEIC, HEIF**, **TIFF**, **JPEG-XL**, **PSD**, **TGA**, **DDS**, **RAW** (CR2, NEF, ARW, DNG, RAF, ORF — via embedded JPEG preview)
- **Write:** PNG, JPEG, WebP, **TIFF**
- **EXIF:** displayed on open with GPS warning, stripped on save by default (toggle)

### Batch tools

- **Batch operations** — convert / resize / rotate / flip / rename across a folder, with worker pool, dry-run, progress bar, cancel
- **Contact sheet / gallery export** — one-click HTML gallery or grid PNG of a folder

### Misc

- Session restore — reload the page, click Resume, your image and edits come back
- Undo / redo 50 steps with periodic snapshots
- 5-tab Help modal (`?` key)

## Privacy & supply chain

Nothing leaves your browser. Slate makes no network requests for editing — pixels never go anywhere.

A handful of niche format decoders (HEIC, JPEG-XL, PSD, TIFF) lazy-load the first time you open such a file, from `esm.sh` with **exact version pins**. The smaller libraries (TGA, DDS) are vendored directly into the bundle with **SHA-256 content hashes** in [`SECURITY.md`](./SECURITY.md). No accounts, no telemetry, no analytics beacon.

## Browser support

| Browser | Version | Notes |
|---|---|---|
| Chrome / Edge | 111+ | Full support including folder access |
| Firefox | 113+ | File picker + download (no folder write-back) |
| Safari | 16.4+ | File picker + download (no folder write-back); native HEIC decode |

## How to run locally

It's one HTML file. Save `index.html` to disk, open it in a browser. That's it. No build step, no dev server needed.

For development of the source modules (under `src/`, gitignored), use any static server like `python3 -m http.server` and run `node build/inline.mjs` to rebuild the single-file output.

## What it isn't

- A cloud editor — there's no server, nothing syncs anywhere, nothing uploads
- A Photoshop replacement — no curves, masks, layer groups, blend modes (yet)
- A multi-file project tool — Slate edits one image at a time; folder operations (slideshow, batch, gallery) work across many but each transform is per-file
- A backup service — your edits live in IndexedDB until you save; nothing protects you from clearing browser data

## Credits

Slate uses these libraries, lazy-loaded only when you open the matching format:

| Library | Purpose | Status |
|---|---|---|
| [`utif`](https://www.npmjs.com/package/utif) | TIFF read + write | exact-pinned on esm.sh |
| [`libheif-js`](https://www.npmjs.com/package/libheif-js) | HEIC / HEIF fallback (Safari has native) | exact-pinned on esm.sh |
| [`@jsquash/jxl`](https://www.npmjs.com/package/@jsquash/jxl) | JPEG-XL decode | exact-pinned on esm.sh |
| [`ag-psd`](https://www.npmjs.com/package/ag-psd) | Photoshop decode | exact-pinned on esm.sh |
| [`tga-js`](https://www.npmjs.com/package/tga-js) | Targa decode | vendored, hashed in SECURITY.md |
| [`dds-parser`](https://www.npmjs.com/package/dds-parser) | DirectDraw Surface decode | vendored, hashed in SECURITY.md |

Everything else is vanilla browser APIs — Canvas 2D, OffscreenCanvas, FileSystemAccess, IndexedDB, Web Workers, WebGPU.

## Palette

Coloured with **`iran-10 · شب یلدا SHAB-E YALDA`** — Persian winter solstice, 7000 years pre-Zoroastrian; the night of staying awake till dawn with Hafez and pomegranate. Aubergine body, saffron ink, royal-blue active accent, pomegranate alerts. Both dark (default) and light (warm parchment companion) themes retuned.

Palette pulled from [**Rangrez**](https://github.com/NakliTechie/rangrez), the global colour-palette library that backs all NakliTechie projects.

## Other projects

[More browser-native, local-first apps at naklitechie.github.io →](https://naklitechie.github.io/)

## Issues

[github.com/NakliTechie/slate/issues](https://github.com/NakliTechie/slate/issues)

## License

MIT
