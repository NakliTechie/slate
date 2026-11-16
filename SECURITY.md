# Security

Slate runs entirely in your browser. No accounts, no servers, no telemetry,
no analytics beacon, no fonts or icons fetched from a CDN. The image you
open never leaves your device.

This document covers the only place external code does enter the picture:
**format decoders** for niche image types are loaded on demand from a
content-distribution network (esm.sh) the first time you open such a file.
Below is the full list of those dependencies, why each is loaded, and how
the supply-chain risk is mitigated.

---

## Dependency inventory

| Format | Package | Source | Why on CDN, not vendored |
|---|---|---|---|
| TIFF (decode + encode) | `utif@3.1.0` | esm.sh | Imports `pako` for inflate; the two together are >70 KB of third-party JS. Kept on CDN. |
| HEIC / HEIF (decode) | `libheif-js@1.19.8` | esm.sh | ~2 MB WASM. Native browser decoders are tried first; libheif is the fallback. |
| JPEG-XL (decode) | `@jsquash/jxl@1.3.0` | esm.sh | ~700 KB WASM. |
| Photoshop (decode) | `ag-psd@30.1.1` | esm.sh | ~250 KB plus `pako` and `base64-js`. |
| Extract text (OCR) | `tesseract.js@7.0.0` | esm.sh, then jsdelivr | Loads only when you press Extract text. The library pulls its worker, `tesseract.js-core` (WASM) and the English `eng.traineddata` from jsdelivr (about 5 MB, cached). Recognition runs locally; the image is never sent anywhere. |
| Google Takeout import (zip read) | `@zip.js/zip.js@2.24.0` | esm.sh | Loads only when you import Google Takeout zips into the library. BSD-3-Clause, pure JS; inflate uses the browser's own DecompressionStream, and its web workers are turned off. The zips are read locally and never sent anywhere. |
| Search by meaning (photo library, opt-in) | `@huggingface/transformers@4.3.2` | jsdelivr | Loads only after you turn on Search by meaning, which first states the download size. Apache-2.0. It pulls `onnxruntime-web@1.31.0-dev.20260914-8d85527a0` (MIT) and its WebAssembly files from jsdelivr, then the model below from huggingface.co. The model runs in a worker on this device; photos and search text are never sent anywhere. |
| Search by meaning model weights | Xenova/clip-vit-base-patch32, revision `6b7c523` | huggingface.co | OpenAI CLIP ViT-B/32 converted to ONNX, MIT licence. About 157 MB with 8-bit weights (WebAssembly) or 307 MB with 16-bit weights (WebGPU), downloaded once and cached by the browser. Turning the feature off deletes the stored vectors; the browser cache keeps the model files until site data is cleared. |
| Background blur depth model | onnx-community/depth-anything-v2-small, revision `4472b73` | huggingface.co, with `@huggingface/transformers@4.3.2` from jsdelivr | Depth Anything V2 Small converted to ONNX, Apache-2.0 (the larger V2 models carry a non-commercial licence and are not used). About 50 MB with 16-bit weights (WebGPU) or 27 MB with 8-bit weights (WebAssembly), downloaded the first time you open Background blur and cached by the browser. The depth map is computed in a worker on this device; the image is never sent anywhere. |
| Targa (decode) | `tga-js@1.1.1` | **Vendored** at `src/vendor/tga-js.mjs` | 4 KB pure JS, no transitive deps. |
| DDS textures (decode) | `dds-parser@1.0.1` | **Vendored** at `src/vendor/dds-parser.mjs` | 4 KB pure JS, no transitive deps. |
| Photo library metadata (EXIF, XMP, embedded thumbnails) | `exifr@7.1.3` | **Vendored** at `src/vendor/exifr.mjs` | 75 KB pure JS (full ESM build), MIT, no transitive deps; one line break added before `export default` for the bundler. |

**Inlined into `index.html` at build time:**
the two vendored libraries above. After build, the single-file artifact
contains every byte of code that runs to decode TGA or DDS images. No
network fetch occurs for those formats.

**Loaded on demand from esm.sh:**
the four bigger libraries above. On first use of the relevant format
(opening a TIFF, an HEIC, a JPEG-XL, or a PSD), the browser fetches the
ESM bundle from esm.sh and caches it. Subsequent opens are zero-cost.
zip.js loads the same way the first time you import Google Takeout zips
into the photo library.

---

### Opt-in downloads (photo library)

| Feature | What loads | From | When |
|---|---|---|---|
| Search by meaning | `@huggingface/transformers@4.3.2`, its onnxruntime-web, and `Xenova/clip-vit-base-patch32` (MIT) at revision `6b7c523`, about 157 MB (WASM) or 307 MB (WebGPU) | cdn.jsdelivr.net, huggingface.co | after you turn it on |
| People (faces) | `onnxruntime-web@1.29.0`, YuNet 2023mar (MIT, 233 KB) and SFace 2021dec int8 (Apache-2.0, 9.9 MB), pinned to repository commits | cdn.jsdelivr.net, huggingface.co | after you turn it on |
| Background blur (editor) | `@huggingface/transformers@4.3.2`, its onnxruntime-web, and `onnx-community/depth-anything-v2-small` (Apache-2.0) at revision `4472b73`, about 27 MB (WASM) or 50 MB (WebGPU) | cdn.jsdelivr.net, huggingface.co | the first time you open Background blur |
| Places map file | `maplibre-gl@6.16.0`, `pmtiles@4.5.0` | cdn.jsdelivr.net | when you choose a .pmtiles file |
| Places | `assets/places/cities.bin` (GeoNames, CC BY 4.0), `assets/places/countries.json` (Natural Earth, public domain) | Slate's own site | when you open Places |

Photos and their vectors stay in the browser; only these libraries and model files are downloaded.

## Vendored modules — content hashes

Every byte of the vendored libraries is committed in this repository, so
the hash below is the hash that ships in `index.html`.

| File | SHA-256 |
|---|---|
| `src/vendor/tga-js.mjs` | `9c9b6fb90b1859e3f3a6f252fe7c433b6973bbb3979cecd4c17b575cfec99cd9` |
| `src/vendor/dds-parser.mjs` | `50b138cfc3c95a4e233764868328a07b427d63092c9360172cd85c874a684da8` |
| `src/vendor/exifr.mjs` | `7dcbbd1161038824bc8be0fa3cf09c5187efaa752ffdaa3bb34a1c2e92e2762a` |

To re-verify: `shasum -a 256 src/vendor/*.mjs` from a freshly cloned tree.

To upgrade a vendored library:

1. Fetch the new ESM bundle from esm.sh manually:
   `curl -sS -o src/vendor/<name>.mjs https://esm.sh/<package>@<version>/es2022/<name>.mjs`
2. Skim the file. (These are <5 KB pure-JS. Read time: under a minute.)
3. Update the SHA-256 in this document and commit both.

---

## CDN-loaded modules — exact-version pin

Every CDN-loaded package Slate imports by URL is pinned to an exact
version (no `@1`, no `latest`):

- `https://esm.sh/utif@3.1.0`
- `https://esm.sh/libheif-js@1.19.8/wasm-bundle.js`
- `https://esm.sh/@jsquash/jxl@1.3.0/decode`
- `https://esm.sh/ag-psd@30.1.1`
- `https://esm.sh/@zip.js/zip.js@2.24.0`
- `https://esm.sh/tesseract.js@7.0.0` (then `cdn.jsdelivr.net/npm/tesseract.js*` and the tessdata files)
- `https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm` (Search by meaning, opt-in), with the model files pinned to Hugging Face revision `6b7c523703ae26e39be4b03774966f8571c7f523`

One gap: jsdelivr's bundle of Transformers.js 4.3.2 imports `onnxruntime-common`
without a version, so jsdelivr picks the version it serves for that package.

A new version of any of these published upstream — malicious or not —
**does not reach a Slate user**. Their browser keeps requesting the
specific version frozen in the build. To upgrade, the URL has to change
in source, the bundle has to be rebuilt, and the new bundle has to be
deployed.

---

## What this prevents

- **A compromised upstream package** publishing a malicious patch
  (e.g. `tga-js@1.1.2`) is invisible to Slate users. Their browsers
  request `1.1.1` from a vendored file or `1.3.0` from a pinned CDN URL.

- **A registry takeover** that swaps the package contents for an existing
  version is partially mitigated for the four CDN-loaded libraries: esm.sh
  serves what npm publishes, so a compromised npm publisher could in theory
  replace `ag-psd@30.1.1`'s contents on disk. This is a known limitation of
  any non-locally-served package.

- **A typo-squat** on a similarly-named package can't reach users — the
  source code references the exact package names used in this document.

---

## What this does not prevent

- **A compromised esm.sh.** The four CDN-loaded packages are served by
  esm.sh. If the esm.sh infrastructure were itself compromised — its
  build pipeline, its mirror, its TLS certs — it could serve a different
  binary back from one of the four pinned URLs above. The Slate build does
  not include Subresource Integrity (SRI) hashes for ESM dynamic imports
  because no shipping browser supports `<script type="module" integrity>`
  on dynamic `import()` yet (the proposal is in flight under
  ["Import Maps with integrity"](https://github.com/whatwg/html/pull/10269)).

  Mitigation: a user who is concerned about this can run Slate fully
  offline by opening `index.html` directly, never opening a HEIC, JPEG-XL,
  TIFF, or PSD file. JPG / PNG / WebP / GIF / AVIF / SVG / BMP / TGA / DDS
  / RAW (embedded preview) all work with zero network traffic after the
  page loads.

- **A compromised jsdelivr or Hugging Face** for Search by meaning. The
  same reasoning as esm.sh applies: Transformers.js and its runtime come
  from jsdelivr, and the model files from huggingface.co, without SRI.
  Nothing from either loads until you turn the feature on.

- **A malicious upstream package version that we audit and ship.** If a
  vendored bundle (`tga-js@1.1.1` say) is itself malicious upstream, our
  vendoring captures that maliciousness. We rely on community trust in
  these libraries when vendoring.

---

## Threat model summary

Slate is a tool for image editing, not for opening adversarial files
from untrusted sources. The realistic threats are:

- **Drive-by image opens from a website that auto-downloads** — Slate is
  opened by the user explicitly (Open File / drag-drop / paste); it does
  not auto-load images from URLs.

- **Maliciously crafted format files exploiting a decoder bug** — outside
  the supply-chain scope of this document. Format decoders are
  battle-tested upstream libraries; bugs there are upstream's problem.

- **Maliciously crafted EXIF metadata** — Slate's HTML rendering of EXIF,
  filenames, and toast messages all goes through an `esc()` HTML-escape
  function in `src/core/html.js`. The full set of HTML-injection sinks
  was audited and patched in earlier commits.

If you find a security issue, please open an issue at
[github.com/NakliTechie/slate/issues](https://github.com/NakliTechie/slate/issues)
or DM [@NakliTechie](https://twitter.com/NakliTechie).
