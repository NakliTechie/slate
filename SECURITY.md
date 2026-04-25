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
| Targa (decode) | `tga-js@1.1.1` | **Vendored** at `src/vendor/tga-js.mjs` | 4 KB pure JS, no transitive deps. |
| DDS textures (decode) | `dds-parser@1.0.1` | **Vendored** at `src/vendor/dds-parser.mjs` | 4 KB pure JS, no transitive deps. |

**Inlined into `index.html` at build time:**
the two vendored libraries above. After build, the single-file artifact
contains every byte of code that runs to decode TGA or DDS images. No
network fetch occurs for those formats.

**Loaded on demand from esm.sh:**
the four bigger libraries above. On first use of the relevant format
(opening a TIFF, an HEIC, a JPEG-XL, or a PSD), the browser fetches the
ESM bundle from esm.sh and caches it. Subsequent opens are zero-cost.

---

## Vendored modules — content hashes

Every byte of the vendored libraries is committed in this repository, so
the hash below is the hash that ships in `index.html`.

| File | SHA-256 |
|---|---|
| `src/vendor/tga-js.mjs` | `7751fbf0dcb846f0307d531da3aab99a1a2b1ef413868420c0c910a84046e720` |
| `src/vendor/dds-parser.mjs` | `b4ef205b26e599b044bca448f4783bad4317dcda519a8b37a3c88ab7d6edad22` |

To re-verify: `shasum -a 256 src/vendor/*.mjs` from a freshly cloned tree.

To upgrade a vendored library:

1. Fetch the new ESM bundle from esm.sh manually:
   `curl -sS -o src/vendor/<name>.mjs https://esm.sh/<package>@<version>/es2022/<name>.mjs`
2. Skim the file. (These are <5 KB pure-JS. Read time: under a minute.)
3. Update the SHA-256 in this document and commit both.

---

## CDN-loaded modules — exact-version pin

All four CDN-loaded packages are pinned to an exact version (no `@1`,
no `latest`):

- `https://esm.sh/utif@3.1.0`
- `https://esm.sh/libheif-js@1.19.8/wasm-bundle.js`
- `https://esm.sh/@jsquash/jxl@1.3.0/decode`
- `https://esm.sh/ag-psd@30.1.1`

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
