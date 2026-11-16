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

**Loaded on demand from esm.sh, hash-checked:**
the four bigger libraries above. On first use of the relevant format
(opening a TIFF, an HEIC, a JPEG-XL, or a PSD), Slate fetches each file of
the decoder from esm.sh, checks its SHA-256 against the pin in
`src/decode/pinned.js`, and imports it from a `blob:` URL. A file whose
bytes differ from its pin is refused, and that format does not open.
See "Decoder hashes" below. zip.js loads from esm.sh the first time you
import Google Takeout zips into the photo library, without a hash check.

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

## Decoder hashes

Browsers check no integrity hash on a dynamic `import()`, so
`src/decode/pinned.js` does it for the four esm.sh decoders. It fetches
esm.sh's es2022 build file for each decoder by its full path (the short
URL such as `https://esm.sh/utif@3.1.0` answers with a stub that varies
with the browser's User-Agent; the build files do not). It hashes the
bytes with `crypto.subtle`, compares them with the pin, and rewrites each
esm.sh import inside the file to the `blob:` URL of that import's own
checked copy. The JPEG XL WebAssembly file is checked the same way and
handed to the decoder's `init()`, so the decoder fetches nothing itself.

The hashes below were taken on 2026-11-17 and matched for three
User-Agents (Chrome, Firefox, curl).

| esm.sh path | Used by | SHA-256 |
|---|---|---|
| `/utif@3.1.0/es2022/utif.mjs` | TIFF | `bb0f6185ed624db5c293f5922cf947cfaf88feb73bc24bda5eaa9c06d52a933d` |
| `/pako@1.0.11/es2022/pako.mjs` | TIFF (utif asks for `pako@^1.0.5`; Slate resolves it to 1.0.11) | `4895feb3e2441ef725da4052a5dc93d219d065fef1decc4452bb9b7ee1477c0d` |
| `/libheif-js@1.19.8/es2022/wasm-bundle.mjs` | HEIC (WebAssembly inside) | `e84a4fb2405b361cc33ca20ea4a07f966c2e2f4af97f4b38a5c09a943a0167d1` |
| `/@jsquash/jxl@1.3.0/es2022/decode.mjs` | JPEG XL | `2771c69b27edc1e803bea512d746883d7c131a4fe77e9dd0d04afb02a5f8674f` |
| `/@jsquash/jxl@1.3.0/codec/dec/jxl_dec.wasm` | JPEG XL | `165bde0f48f3bdc39c7806365db5bb3b777df67fefff48050841fb4430062433` |
| `/ag-psd@30.1.1/es2022/ag-psd.mjs` | PSD | `a48ef7bb66e3e06201e2e178d605960f1492c353d4a53c9dd1f6a0e55e14d011` |
| `/base64-js@1.5.1/es2022/base64-js.mjs` | PSD | `5dbae8a1d8f5789da21736786f9921727523b5ccc64cbcf9f831331c381957dc` |
| `/pako@2.1.0/es2022/pako.mjs` | PSD | `6f8c08355f970b0592aff0bdaf53ab881876152f0a2c6910cd5f3c2b71fb791d` |
| `/node/process.mjs` | TIFF, HEIC, JPEG XL | `79bdd29eef537eee63ba8ef06a00a9579a6a99efc4ba391807e017049ecfe452` |
| `/node/events.mjs` | via process | `4c6150b88c1444aa1fe9331013e3f37eda9836206f629f7f3ae8f3743dd90fa8` |
| `/node/async_hooks.mjs` | via events | `b7862dbfba8bbbca956f19e4e08280b529e4b27468779775a9093aef8c92dc1d` |
| `/node/tty.mjs` | via process | `c66ff4b406bad449bfb2ced355f15badf16f4d9e035d2d300e33b5aeee64e3be` |
| `/node/buffer.mjs` | HEIC, PSD | `64fb61aa5f48644d685f9ceabedba60ea6b5d6ce03dac1943e863d00d9e574f3` |
| `/node/util.mjs` | PSD | `0cc72bdadc46cf17685e6d9385e3d1536fdc4d6fa783cb18365574d14b74d5e8` |
| `/node/util/types.mjs` | via util | `3f3e225fbce928e7556c759c2426ecafb05e451430e798d9f14e62c61208f2f0` |

The `/node/*` files are esm.sh's Node polyfills. Their URLs carry no
version, so when esm.sh changes them the affected decoders refuse to load
until the pins are renewed. That failure is deliberate: Slate runs no
decoder byte it has not pinned.

To upgrade a decoder or renew a pin: change the path in
`src/decode/pinned.js`, fetch that file and every esm.sh file it imports
(`curl -sS https://esm.sh<path> | shasum -a 256`), read what changed, and
record each hash in `pinned.js` and in this table.

Two other esm.sh imports are not hash-checked yet: the TIFF encoder
(`src/encode/tiff.js`, the same utif URL) and zip.js.

---

## Content security policy

`src/index.html` carries the policy as a `<meta http-equiv>` tag, so the
direct site and the NakliOS mirror both get it. `build/inline.mjs`
repeats it in `dist/_headers` and adds `frame-ancestors`, which a meta tag
cannot set; on the NakliOS mirror the host's own headers set framing.

| Directive | Allows | Why |
|---|---|---|
| `default-src` | `'self'` | everything not listed below |
| `script-src` | `'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:` esm.sh, cdn.jsdelivr.net | the app is one inline script; decoders import from `blob:` after the hash check; HEIC, JPEG XL, OCR and the models compile WebAssembly; libraries load from the two CDNs |
| `worker-src` | `'self' blob:` esm.sh, cdn.jsdelivr.net | thumbnail, batch, CLIP, face and depth workers start from `blob:` URLs; library workers |
| `connect-src` | `'self' blob: data:` esm.sh, cdn.jsdelivr.net, huggingface.co, `*.huggingface.co`, `*.hf.co` | decoder files for the hash check; library WebAssembly and OCR data; model files, which huggingface.co redirects to `*.cdn.hf.co` (on 2026-11-17, `us.aws.cdn.hf.co`); thumbnails read back from `blob:` URLs |
| `img-src` | `'self' data: blob:` | thumbnails and the inlined favicon |
| `media-src` | `'self' blob:` | video thumbnails and playback |
| `style-src` | `'self' 'unsafe-inline'` cdn.jsdelivr.net | inline styles; the MapLibre stylesheet |
| `font-src` | `'self' data:` | |
| `object-src` | `'none'` | |
| `base-uri` | `'none'` | |

The policy does not stop code from esm.sh or jsDelivr sending data to
those same hosts; it stops it from sending data anywhere else.

---

## CDN-loaded modules — exact-version pin

Every CDN-loaded package Slate imports by URL is pinned to an exact
version (no `@1`, no `latest`):

- `https://esm.sh/utif@3.1.0/es2022/utif.mjs` (hash-checked, as are the three below)
- `https://esm.sh/libheif-js@1.19.8/es2022/wasm-bundle.mjs`
- `https://esm.sh/@jsquash/jxl@1.3.0/es2022/decode.mjs`
- `https://esm.sh/ag-psd@30.1.1/es2022/ag-psd.mjs`
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

- **A compromised esm.sh, for zip.js, tesseract.js and the TIFF encoder.**
  The four decoders are hash-checked (see "Decoder hashes"), so a changed
  file from esm.sh is refused. zip.js, tesseract.js and the TIFF encoder's
  copy of utif still load without a hash, because no shipping browser
  checks integrity on a dynamic `import()` (the proposal is
  ["Import Maps with integrity"](https://github.com/whatwg/html/pull/10269)).

  Mitigation: JPG / PNG / WebP / GIF / AVIF / SVG / BMP / TGA / DDS / RAW
  (embedded preview) all work with zero network traffic after the page
  loads.

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
  Slate does bound the memory a header can ask for: TGA, DDS, TIFF, PSD,
  HEIC (through libheif), JPEG XL and SVG files whose header claims more
  than 100 megapixels are refused before any pixel buffer is allocated,
  and TGA and DDS files shorter than their header requires are refused
  (`src/decode/limits.js`). A photo whose thumbnail needs a main-thread
  decode is recorded as `pending` first, so a tab that dies during that
  decode marks it failed on the next visit instead of trying again.
  Formats the browser decodes itself are left to the browser's own limits.

- **Maliciously crafted EXIF metadata** — Slate's HTML rendering of EXIF,
  filenames, and toast messages all goes through an `esc()` HTML-escape
  function in `src/core/html.js`. The full set of HTML-injection sinks
  was audited and patched in earlier commits.

If you find a security issue, please open an issue at
[github.com/NakliTechie/slate/issues](https://github.com/NakliTechie/slate/issues)
or DM [@NakliTechie](https://twitter.com/NakliTechie).
