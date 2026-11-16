# Slate Photos: photo library parity matrix

**Doc ID:** slate-photos-parity-001
**Status:** v1 APPROVED by Chirag (2026-11-16, "Approve, track src/ first") and BUILT (2026-11-16). `npm test` passes (8 test files) and `node scripts/live-check.mjs` passes 44 of 44 in Chrome over CDP, at 10,000 and at 300 synthetic photos. Each v1 row's note says how it was checked and what was not driven live.
**Reference systems:** Google Photos and Apple Photos (the experience people expect), Lightroom Classic's Library module (culling and ratings over files that stay put), digiKam (folder-first, XMP sidecars), PhotoPrism and Immich (self-hosted libraries with on-device ML), Ente (encrypted, client-side ML).
**Evidence:** the research run `naklios/plan/research/2026-11-16-slate-photo-library/` (8 units, 6,253 words, VERIFIED: all four gates pass; claim sample 5 supported, 5 partial, 0 unsupported). Rows marked R come from its architecture, limits or recommendation passages. Facts about Slate itself come from reading `src/` on 2026-11-16.

## How to read this matrix

The core job of Slate Photos is one sentence: **point Slate at the photo folders you already have, and browse, find, sort and cull them as one timeline, with every choice kept on your own disk and every photo one click from the editor; no account, no upload.**

Each row has one scope value:

- **v1**: in the first release. The build ends when every v1 row passes its check.
- **v1.x**: wanted, built after v1, in the order listed within each table.
- **Waived**: out of scope by default, because it needs a server, falls outside the core job, or the browser cannot do it well. Chirag can un-waive any row.

`Src`: **G** Google Photos, **A** Apple Photos, **L** Lightroom Classic, **D** digiKam, **P** PhotoPrism, **I** Immich, **E** Ente, **B** most of them, **R** the research report's recommendations, **S** Slate's own backlog (`PENDING.md`, `plan/pending.md`).

## What Slate already has

Read from `src/` on 2026-11-16:

- **Folder open:** `showDirectoryPicker({mode:'read'})` with a `webkitdirectory` and drag-drop fallback (`src/core/fs.js`). It lists one folder level only, and it keeps the list in memory for the session.
- **Thumbnails:** the thumbnail strip decodes each file on demand to a 128 px WebP object URL, lazily by IntersectionObserver (`src/ui/thumbstrip.js`). Nothing persists, so every visit decodes again.
- **Decoders:** 14 formats through `src/decode/registry.js`, including HEIC (libheif-js, native on Safari), TIFF, JPEG XL, PSD and RAW through the embedded JPEG preview (`src/decode/raw.js`).
- **EXIF:** an inline parser for JPEG, PNG and WebP that reads the first 128 KB (`src/exif.js`). It does not read HEIC, RAW or XMP.
- **Storage:** IndexedDB `slate.v1` holds only the resumable editing session (`src/core/session.js`). Saves go through download, overwrite or a workspace folder (`saveSidecar`).
- **Folder tools:** slideshow, batch operations with a worker pool, contact sheet and HTML gallery export.
- **Agent face:** none. Slate has no `commands.json` and registers no NakliOS commands.
- **NakliOS:** mirrored same-origin at `naklios.dev/apps/slate/` (`apps/manifest.json` id `slate`: `index.html` plus `LICENSE`, SDK inline), so `showDirectoryPicker` works inside NakliOS.
- **Build:** the tracked `index.html` is built by `build/inline.mjs` from `src/`, and `src/` is not in any repository (see Open questions).

## Design (decided from the research, unless Chirag objects)

- **The library is a second mode of Slate, not a second app.** A Library view (grid, sidebar of Timeline, Albums, Favourites, Folders, Hidden, Trash) sits beside the existing editor. Opening a photo hands it to the editor; Escape returns to the grid at the same scroll position. Slate stays one HTML file. The editor stays light, per the 2026-10-12 Slate and Atelier decision.
- **Your folders are the record; the index is disposable.** Slate never moves photos into its own store. It scans one or more picked root folders recursively. Everything it learns (dates, sizes, aspect ratios, thumbnails, hashes, vectors) can be rebuilt from the folder. The research found Safari deletes script-writable storage after seven days without use, and that eviction is possible elsewhere, so an index that can vanish must cost only a rescan (R, storage unit).
- **Your choices live in the folder too.** Albums, favourites, ratings, pick or reject flags, hidden and tags are written to one library file, `.slate-library.json`, at each root folder, keyed by relative path plus size. It survives a cleared browser, travels with the folder to another machine, and is human-readable. XMP sidecars (`photo.jpg.xmp`, the digiKam full-name form, so `IMG_1.jpg` and `IMG_1.dng` never collide) are read in v1 and written in v1.x behind an explicit setting, for portability to Lightroom and digiKam (R, sidecars unit). Slate never edits an original file.
- **Index in IndexedDB, thumbnails in OPFS.** A new database `slate.library` holds one row per photo (id, root, relative path, size, lastModified, capture time, width, height, orientation, camera, GPS, kind, flags) with a compound index on capture time plus id for date paging. Thumbnails are 256 px WebP files in OPFS, read and written in a worker: about 1 to 3 GB at 100,000 photos, inside every engine's quota (R). SQLite Wasm is held back: it needs one writer per origin and, for its fast path, cross-origin isolation headers the mirror does not set; IndexedDB has neither cost (R).
- **Scan in workers, as a pausable job queue.** Scan, metadata, thumbnail and (later) ML jobs run in workers with pause, resume and a progress count, the pattern Immich uses for its job workers (R). Change detection is a rescan comparing path, size and lastModified. `FileSystemObserver` is experimental and Chrome-only, so it is not a dependency (R).
- **Metadata through exifr, thumbnails through the decoders Slate has.** exifr (MIT) replaces the inline parser for library scans: it reads only the file head, covers HEIC, XMP and IPTC, and can return the embedded thumbnail, so most JPEG, HEIC and RAW grid tiles need no full decode. Its bundles are about 4 to 73 KB by the project's own figures (R). Files without an embedded thumbnail go through the existing decoder registry and `createImageBitmap` resize in a worker.
- **A virtualised grid of our own.** Row heights come from stored aspect ratios; only the visible rows plus overscan exist in the DOM; decodes cancel when rows leave the window; a month scrubber maps dates to row offsets. At 256 px, 200 visible tiles decode to about 51 MB of bitmaps (arithmetic from the research, not measured).
- **AI is removable and arrives later.** Text search with CLIP-style embeddings, near-duplicates, places, faces and captions are v1.x rows behind measured gates, in that order. Pull every model and the library still works, per the NakliTechie rule. Brute-force search over int8 or float16 vectors in a worker is the default; an ANN library (sqlite-vec, hnswlib-wasm, USearch, Voy) is added only if measured latency at 100,000 vectors fails (R).
- **One manifest, two doors.** Every library action is a command in a new `commands.json`, named `slate.library.*`, `slate.photo.*` and `slate.album.*`, with a JSON Schema input and a scope of read, write or destructive. The same handlers back the buttons, the keys and `naklios.experimental_commands.register`. Results carry ids and short fields, never image bytes, to stay under the host's 256 KB result cap; every write takes `dryRun` and returns an undo token; any action on more than 200 photos, and any delete, is declared destructive so the host shows the count for review (R, agent unit).
- **Browser support is tiered.** Chrome and Edge get the full library. Firefox and Safari have no `showDirectoryPicker`; there Slate offers browse-only mode over a `webkitdirectory` pick, with choices kept in IndexedDB and exportable as `.slate-library.json`, and it says so on screen (R).

## 1. Library and storage

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| L1 | Add one or more root folders; scan them recursively; remember them across visits and re-ask permission once per session | B R | v1 | Built (scan.js). Checked: live check (`scripts/live-check.mjs`, Chrome over CDP, 2026-11-16, 44 of 44 at 10,000 and at 300 photos): a recursive OPFS folder of 10,006 files gave 10,004 records; tests/test-library-scan.mjs (permission refusal, remembered roots). The real folder picker is not driven (test seam) |
| L2 | Index in IndexedDB `slate.library`, thumbnails as 256 px WebP in OPFS, written from workers | R | v1 | Built (store.js, thumbs.js). Checked: live check (`scripts/live-check.mjs`, Chrome over CDP, 2026-11-16, 44 of 44 at 10,000 and at 300 photos): 10,004 thumbnails written to OPFS, 0 failed |
| L3 | Choices (albums, favourites, ratings, flags, hidden, tags) in `.slate-library.json` at each root | R | v1 | Built (persist.js, libfile.js). Checked: live check (`scripts/live-check.mjs`, Chrome over CDP, 2026-11-16, 44 of 44 at 10,000 and at 300 photos): the file in the folder holds the favourite, rating, flag, hidden, tags and album; tests/test-library-core.mjs and test-library-organise.mjs round trips |
| L4 | Rescan on open: new, changed (path, size, lastModified) and missing files; missing files marked, not dropped | R | v1 | Built. Checked: tests/test-library-core.mjs (moved file keeps its choices) and test-library-scan.mjs (deleted file becomes missing); live check: dot-folders skipped |
| L5 | Pausable background job queue with a visible count (scan, metadata, thumbnails) | I R | v1 | Built (jobs.js, status line with Pause). Checked: live check (`scripts/live-check.mjs`, Chrome over CDP, 2026-11-16, 44 of 44 at 10,000 and at 300 photos): first tiles after 534 ms while the queue ran; tests/test-library-core.mjs pause and resume |
| L6 | Rebuild index: delete the index and thumbnails by name and rescan | R | v1 | Built. Checked: live check (`scripts/live-check.mjs`, Chrome over CDP, 2026-11-16, 44 of 44 at 10,000 and at 300 photos): Rebuild keeps every choice and album (v1 check 3) |
| L7 | Storage panel: index size, thumbnail size, `navigator.storage.persist()` request | R | v1 | Built (storage.js). Checked: live check: the panel shows sizes and Rebuild index |
| L8 | Browse-only mode on Firefox and Safari over a `webkitdirectory` pick | R | v1 | Built (webkitdirectory pick, library file kept in IndexedDB, Download library file). Checked: tests/test-library-organise.mjs kv fallback. Not driven in Firefox or Safari |
| L9 | Watch for changes with `FileSystemObserver` where available | R | v1.x | Built 2026-11-17 (watch.js: FileSystemObserver per root, rescan of that root after 1.5 s; the storage panel says whether watching is on). Checked: `scripts/live-check-v1x2.mjs` 10/10, twice (Chrome over CDP, 2026-11-17): a file added to a watched OPFS folder appears without a rescan |
| L10 | Copy-in mode: import files into OPFS for browsers with no folder access | R | Waived | Duplicates the user's photos into browser storage that Safari may delete |

## 2. Metadata and formats

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| M1 | Capture date, dimensions, orientation, camera, lens, GPS from EXIF, read from the file head with exifr | R | v1 | Built (metadata.js, exifr). Checked: live check: EXIF date, camera and GPS; tests/test-library-scan.mjs synthetic EXIF with orientation 6. HEIC, TIFF and RAW files not driven live (no synthetic encoder) |
| M2 | Grid tiles from the embedded thumbnail where one exists; otherwise decode and resize in a worker | R | v1 | Built (thumbs.js). Checked: live check: tiles fill after scrolling. The embedded-preview path for RAW is not driven live |
| M3 | Videos (MP4, MOV, WebM) in the timeline with a poster frame and duration; play in a viewer | B | v1 | Built (poster, duration, viewer playback). Checked: live check: two WebM clips get posters and durations. MP4 and MOV not driven |
| M4 | Read XMP sidecars: `dc:subject`, `xmp:Rating`, `xmp:Label`, date, GPS; both `photo.jpg.xmp` and `photo.xmp` | D R | v1 | Built (xmp.js). Checked: live check: a sidecar's tags and rating applied; tests/test-library-organise.mjs Lightroom, digiKam and darktable samples |
| M5 | Write XMP sidecars for rating, label and keywords, as `photo.ext.xmp`, behind a setting | D L R | v1.x | Built 2026-11-17 (xmpwrite.js, setting in the storage panel, off by default; reject writes Rating -1; existing sidecar properties kept). Checked: `scripts/live-check-v1x.mjs` 11/11 (Chrome over CDP, 2026-11-17); tests/test-library-xmpwrite.mjs. Known limit: a tag Slate wrote comes back as a file tag on rescan, so Slate cannot remove it |
| M6 | Google Motion Photos: play the MP4 embedded at the end of the JPEG | G R | v1.x | Built 2026-11-17 (metadata.js reads the Container, GContainer and MicroVideoOffset forms and checks for an MP4 header; the viewer plays the clip by slicing the file). Checked: `scripts/live-check-v1x2.mjs` 10/10, twice (Chrome over CDP, 2026-11-17): a Motion Photo built from an MP4 recorded in Chrome is found and plays; tests/test-library-motion.mjs |
| M7 | Apple Live Photos: pair a HEIC and MOV by name and play the movie | A R | v1.x | Built 2026-11-17 (scan.js pairs a HEIC or JPEG with a same-name MOV; the MOV gets no tile; the viewer plays it). Checked: `scripts/live-check-v1x2.mjs` 10/10, twice (Chrome over CDP, 2026-11-17); tests/test-library-scan.mjs |
| M8 | Ultra HDR gain maps shown as HDR | G | Waived | Tiles and viewer show the SDR base image, which every reader supports (R) |
| M9 | Full RAW develop | L | Waived | Belongs to Atelier; the library uses the embedded preview |

## 3. Browsing

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| B1 | Timeline grid by capture date, grouped by day and month, virtualised to 100,000 items | B | v1 | Built (view.js, grid-model.js). Checked: live check (`scripts/live-check.mjs`, Chrome over CDP, 2026-11-16, 44 of 44 at 10,000 and at 300 photos): 10,004 photos render 171 tiles; a 60-step fling over 100,304 rows leaves 120 visible tiles and 1,340 DOM nodes (v1 check 2) |
| B2 | Month and year scrubber that jumps the grid | G A I | v1 | Built. Checked: live check: a scrubber click moves the grid |
| B3 | Zoom levels for the grid (3 tile sizes) | G A | v1 | Built. Checked: live check: zoom in takes tiles from 90 px to 158 px. Pinch not driven |
| B4 | Folder view mirroring the disk tree | D P I | v1 | Built (counts include subfolders). Checked: live check: the sidebar lists folders |
| B5 | Photo viewer: full size, arrow keys, info panel (EXIF, path, size), open in editor | B | v1 | Built (photo-viewer.js). Checked: live check: Enter opens the viewer with camera and path; Escape closes it |
| B6 | Multi-select with click, Shift-range, Ctrl, drag-lasso and select-all-in-day | B | v1 | Built. Checked: live check: click, Shift-click range (4), Cmd-click (5), Escape; tests/test-library-view.mjs lasso and day selection. Lasso and select-a-day not driven live |
| B7 | Sort and filter bar: date range, file type, folder, camera, rating, flag, tag, favourite | L P | v1 | Built (filter bar). Checked: tests/test-library-core.mjs filters; the filter bar controls are not driven live |
| B8 | Slideshow of any selection or album | B | v1 | Built (selection or view into the editor slideshow, at most 1,000 photos). Not driven live |
| B9 | Stacks: group an edited version, bursts and RAW plus JPEG pairs under one tile | L I | v1.x | Built 2026-11-17 (stacks.js: Slate edits with their original, RAW plus JPEG, bursts of 3 or more within 1 s; "Stack similar files" toggle, on by default). Checked: `scripts/live-check-v1x2.mjs` 10/10, twice (Chrome over CDP, 2026-11-17): 7 files show as 4 tiles; tests/test-library-stacks.mjs. RAW plus JPEG pairs checked in Node only |
| B10 | Memories: "On this day" and year-ago groups | G A I P | v1.x | Built 2026-11-17 (memories.js: On this day, nearest day within 7 days when today has none, 29 February on 28 February). Checked: `scripts/live-check-v1x.mjs` 11/11 (Chrome over CDP, 2026-11-17); tests/test-library-memories.mjs |

## 4. Organising and culling

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| O1 | Favourite (heart), shown as its own view | B | v1 | Built. Checked: live check: F favourites the focused photo |
| O2 | Star ratings 0 to 5 and pick, reject, unflag with Lightroom keys (0 to 5, P, X, U; Shift applies and advances) | L S | v1 | Built. Checked: live check: 4 rates, P picks, X rejects, Shift+3 rates and moves on (the selection moves with the focus) |
| O3 | Albums: create, rename, delete, add, remove, cover photo; a photo can be in many | B | v1 | Built. Checked: live check: a new album shows in the sidebar, opens with its 5 photos, and its menu offers rename, cover and delete; tests/test-library-organise.mjs |
| O4 | Tags (keywords), hierarchical with `/` | L D I | v1 | Built. Checked: live check: hierarchical tags through the command face; the tag dialog is not driven live |
| O5 | Hide: a hidden photo leaves the timeline and search, kept in a Hidden view | G A P I | v1 | Built. Checked: live check: H hides; the photo leaves the timeline |
| O6 | Trash: delete moves the file into `.slate-trash/` under its root, with restore; empty trash is a separate confirmed action | G A I | v1 | Built (trash.js). Checked: live check: the file moves into .slate-trash and back; tests/test-library-core.mjs and test-library-organise.mjs empty trash and restore refusal. Empty trash not run live |
| O7 | Edit from the library: open in the editor, save as a new version beside the original | S R | v1 | Built. Checked: live check: E opens the photo in the editor; Escape returns to the Library. Saving beside the original not driven live |
| O8 | Batch from a selection: Slate's batch tools, contact sheet and gallery export run on the selected photos | S | v1 | Built (batch.js, gallery.js take a selection). Not driven live |
| O9 | Locked folder: hidden photos behind a passphrase, encrypted at rest | G I | v1.x | Needs an encryption design; hide (O5) covers the common case |
| O10 | Bulk rename and move between folders | D | v1.x | Built 2026-11-17 (move.js; Library.moveFiles and renameFiles re-key choices and albums; commands photo.move and photo.rename, destructive; dialogs require a dry run first). Checked: `scripts/live-check-v1x2.mjs` 10/10, twice (Chrome over CDP, 2026-11-17): move keeps the favourite and undoes; rename from a template and undo; tests/test-library-move.mjs |

## 5. Search

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| Q1 | Search box over filename, folder, tag, album, camera and date words ("2024", "March", "Canon") | B | v1 | Built. Checked: live check: / focuses search; "canon 2024" filters to 2,501 |
| Q2 | Text search by meaning with CLIP-style embeddings in a worker (WebGPU, WASM fallback); model downloaded on opt-in | G A I E R | v1.x | First candidates MobileCLIP2-S2 or CLIP ViT-B/32; licence check first; gate is brute-force latency at 100,000 vectors |
| Q3 | Find similar photos to this one | I D | v1.x | Same vectors as Q2 |
| Q4 | Hindi and other Indic queries | R | v1.x | Only NLLB-CLIP models measured well, at about 4.7 GB class; or translate the query first |

## 6. Duplicates

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| D1 | Exact duplicates: same size and content hash, grouped for review | P I | v1.x | Built 2026-11-17 (dupes.js: same size, then SHA-256 of colliding files only). Checked: `scripts/live-check-v1x.mjs` 11/11 (Chrome over CDP, 2026-11-17); tests/test-library-dupes.mjs. The synthetic folder had no exact copies, so exact grouping is checked in Node only |
| D2 | Near-duplicates and bursts by perceptual hash (dHash or pHash), Hamming threshold set by Slate's own tests | D R | v1.x | Built 2026-11-17 (64-bit dHash from the thumbnail; bucket lookup; threshold slider 1 to 11, default 6 from synthetic images). Checked: `scripts/live-check-v1x.mjs` 11/11 (Chrome over CDP, 2026-11-17): 9 groups of similar photos; Node: matches brute force on 2,000 hashes, 100,000 grouped in 1.4 s |
| D3 | Review screen: keep the best, trash the rest in one step | I | v1.x | Built 2026-11-17 (Duplicates view: keeper suggested by size, favourite, rating, age). Checked: `scripts/live-check-v1x.mjs` 11/11 (Chrome over CDP, 2026-11-17): keep-one trashes 59 others, Undo restores them |
| D4 | Near-duplicates by CLIP similarity as a second pass | I R | v1.x | After Q2 |

## 7. Places

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| P1 | Places list: photos grouped by country and nearest city from a bundled GeoNames gazetteer, offline | R | v1.x | `cities1000` or `cities5000`; CC BY 4.0 attribution required; download size to measure |
| P2 | Map of pins over Natural Earth country outlines, drawn on a canvas, offline | R | v1.x | |
| P3 | Vector basemap from a PMTiles file the user supplies, through MapLibre | R | v1.x | Gated on a prototype that reads a picked file, which the research could not confirm |
| P4 | Online tiles or reverse geocoding from OpenStreetMap, Nominatim or MapTiler | I | Waived | OSM's tile policy forbids offline use and needs a Referer header; Nominatim bars bulk reverse geocoding; both send locations off the device (R) |

## 8. People

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| F1 | Face detection, embedding and clustering, off by default, explicit opt-in, delete-all-face-data button | G A D P I R | v1.x | YuNet with SFace (the permissive pairing PhotoPrism ships) on ONNX Runtime Web; incremental DBSCAN as Immich; model id stored with each vector |
| F2 | Name, merge, hide a person; mark a face as wrong; set a cover | P I | v1.x | After F1 |
| F3 | Read and write face regions in XMP (MWG regions) | D | v1.x | Interoperates with digiKam and Lightroom |
| F4 | InsightFace `buffalo_l` models | R | Waived | Non-commercial research licence |

## 9. Import and export

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| I1 | Apple Photos: open an osxphotos export folder; its embedded keywords, GPS and album folders come in | A R | v1 | Built (an export folder scans like any folder; embedded XMP and IPTC keywords are read). Checked: tests/test-library-scan.mjs. Not driven with a real osxphotos export |
| I2 | Google Takeout, extracted: match each JSON to its photo (47-character title truncation, `(N)` counters, `-edited` copies, fuzzy fallback); take the photo-taken time, description and GPS | G R | v1.x | Built 2026-11-17 (takeout.js: 47-character titles, (N) counters, -edited, supplemental-metadata, fuzzy match; scan applies time, GPS, caption, people, favourite, archived as hidden, trashed as reject). Checked: `scripts/live-check-v1x.mjs` 11/11 (Chrome over CDP, 2026-11-17); tests/test-library-takeout.mjs 31 checks. The JSON is re-read on each rescan rather than written once to the library file |
| I3 | Google Takeout zips read in place with zip.js, one part at a time | G R | v1.x | Built 2026-11-17 (import.js; zip.js 2.24.0 from esm.sh; album folders kept; existing files skipped). Checked: `scripts/live-check-v1x.mjs` 11/11 (Chrome over CDP, 2026-11-17): a synthetic zip imports, its dates apply, and a second import skips all 4 files. The dialog's pickers are not driven |
| I4 | Export an album or selection as a folder of originals, or as a zip | B | v1.x | Built 2026-11-17 as a folder of originals (export.js; action bar and album menu). Checked: `scripts/live-check-v1x.mjs` 11/11 (Chrome over CDP, 2026-11-17). Zip export not built |
| I5 | iCloud takeout CSV for dates and albums | A | v1.x | Built 2026-11-17 (icloud.js: Photo Details CSV favourite, hidden and dates; album CSVs become albums). Checked: `scripts/live-check-v1x2.mjs` 10/10, twice (Chrome over CDP, 2026-11-17); tests/test-library-icloud.mjs. Dates from the CSV are lost on a full rescan |

## 10. AI (removable: the library works fully without a model)

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| X1 | Describe a photo on demand through the NakliOS host model (`naklios.ai`, vision gated by `experimental_aiVision`) | R | v1.x | Built 2026-11-16 in the editor's Image Info (src/ops/describe.js): shown only when the host offers vision; the dialog names the destination before sending; a JPEG of at most 1,536 px. Checked: tests/test-describe.mjs; scripts/live-check-describe.mjs 5/5 against a stubbed host. A real host model is not checked |
| X2 | Bulk captions for the whole library | R | Waived | About 28 hours for 50,000 photos at 2 s each (arithmetic); text search (Q2) covers the use |
| X3 | Extract text (OCR) and describe-image models already logged for Slate (Indra OCR, LFM3-VL-2B) searchable in the library | S | v1.x | Separate backlog items; indexed when present |

## 11. Agent door and NakliOS

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| N1 | `commands.json` with the library commands: `slate.library.search`, `.list`, `.thumb`, `.rescan`; `slate.photo.favourite`, `.rate`, `.flag`, `.tag`, `.hide`, `.trash`, `.restore`, `.open`; `slate.album.create`, `.add`, `.remove`, `.list` | R | v1 | Built (commands.json, 26 commands). Checked: tests/test-library-core.mjs and test-library-door.mjs; live check: Ctrl+L and the toolbar button run library.open |
| N2 | Registered with `naklios.experimental_commands.register`; scopes read, write and destructive; more than 200 ids or any trash is destructive and goes through host review | R | v1 | Built (door.js). Checked: tests/test-library-door.mjs re-runs the rail's checks. Registration inside NakliOS is the NakliOS session's check |
| N3 | `dryRun` on every write, and an undo token for each write | R | v1 | Built. Checked: tests/test-library-core.mjs dry runs and undo; live check: every change shows Undo |
| N4 | Runs in the existing same-origin mirror at `naklios.dev/apps/slate/`, follows the host theme, signals `naklios.ready()` | R | v1 | Built (follows the host theme in door.js). Checked: live check: the Library restyles for light and dark. Running in the mirror is the NakliOS session's check |
| N5 | Editor commands (crop, rotate, adjust, export) in the same manifest | S | v1.x | Built 2026-11-17 (src/editor/commands.js: 12 image.* commands through the editor's own op events; 40 commands in all). Checked: `scripts/live-check-v1x2.mjs` 10/10, twice (Chrome over CDP, 2026-11-17): open, rotate, adjust, undo and snapshot on the real editor; tests/test-editor-commands.mjs |
| N6 | Publish the same commands as WebMCP tools | R | v1.x | Built 2026-11-17 (door.js registers every command as a WebMCP tool, slate_<name>, when navigator.modelContext exists; destructive tools ask first). Checked: tests/test-editor-commands.mjs with a fake navigator.modelContext. This Chrome has no navigator.modelContext, so it is not driven live |

## 12. Sharing and sync

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| H1 | Shared albums, public links, partner sharing | G A I P | Waived | Needs a server |
| H2 | Cloud backup and cross-device sync of photos | G A I E | Waived | Needs a server; the folder plus its library file is the backup |
| H3 | Sync of the library file between devices through Crate or the private-mesh fabric | R | Waived | Possible later; the research judged a photo library a poor fit for the fabric checklist (zero-config start, bundle size), unverified |
| H4 | Mobile upload from a phone camera | I E | Waived | Needs a server or a native app |

## 13. Keyboard and accessibility

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| K1 | Keys: arrows move focus, Enter opens, Escape returns, Space selects, F favourite, 0 to 5 rate, P, X, U flag, H hide, Delete trash, / search, E edit | L B | v1 | Built; keys listed in Help. Checked: live check: arrows, Enter, Escape, Space, /, F, 0 to 5, P, X, H, E |
| K2 | Every control has an accessible name; the grid is a keyboard-navigable grid role | B | v1 | Built. Checked: live check: no horizontal overflow at 978 px; the grid has role grid; tests/test-library-door.mjs |
| K3 | First-run tour steps for the Library | S | v1 | Built (a two-step library tour; the editor tour no longer covers the Library). Checked: live check: the first open shows it and Skip closes it |

## v1 checks

The build ends when every v1 row passes its check. Three checks need numbers measured in Chrome over the CDP daemon on this Mac, outside a GPU timing turn:

1. First-run scan plus thumbnails for a 10,000-photo folder (mixed JPEG, HEIC, RAW, video): record the time; the grid must be usable within 5 s of picking the folder.
2. Grid scrolling over a synthetic 100,000-row index: no dropped tiles at the end of a fling; DOM node count stays bounded.
3. Rebuild after deleting the index: choices in `.slate-library.json` come back unchanged.

## Counts

v1: 37 rows. v1.x: 29 rows. Waived: 10 rows. 76 in all.

## Out of scope by design

Accounts, cloud storage, shared or public albums, phone upload, online maps and geocoding, bulk captioning, RAW develop (Atelier's job) and any change to an original photo file. Each needs a server, sends photos or locations off the device, or belongs to another app.

## Open questions for Chirag

1. **Slate's `src/` is in no repository.** The tracked `index.html` is built from an untracked local `src/` (noted by the SDK session on 2026-11-11). A multi-agent build cannot work on a file it cannot see in git. Recommend: track `src/` and `build/` in the Slate repo before the build starts.
2. **Library file name and location.** `.slate-library.json` at each root is hidden on macOS and Linux. A visible name (`Slate Library.json`) is easier to find and back up. Default: the hidden name.
3. **Trash folder.** `.slate-trash/` inside each root keeps restores simple but leaves files in the photo tree. Default: as written; Empty Trash is the only permanent delete.
4. **Model downloads for v1.x.** CLIP search needs a one-time model download (MobileCLIP2-S2 vision encoder about 136 MB, B/32 class similar); faces add YuNet and SFace (small, size not measured). MobileCLIP2 carries Apple's sample-code licence, not an open one. Default: CLIP ViT-B/32 (MIT weights) unless the licence check clears MobileCLIP2.
5. **Size targets.** v1 is designed for 100,000 photos and measured at 10,000 (scan) and 100,000 (synthetic grid). Real 100,000-photo scan time is unknown until measured; the research found no published timing for enumerating that many files through the File System Access API.
