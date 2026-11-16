# Slate architecture: the photo library

This document describes how the photo library sits inside Slate, and the interface each part keeps. The scope is the v1 rows of [`specs/slate-photos-parity-001.md`](specs/slate-photos-parity-001.md).

## The shape

Slate is one HTML file. `node build/inline.mjs` bundles `src/` into `index.html`: each module becomes a function scope, and imports become constants. Modules import only relative paths. A package is vendored as one ES module under `src/vendor/`, with its licence text in a header comment. Worker code is a self-contained string turned into a blob URL, because a worker cannot import a bundled module (see `WORKER_SRC` in `src/ui/batch.js`).

The library is a second mode of Slate. The editor stays as it is. `src/app.js` calls `initLibrary()` from `src/library/boot.js` at the end of boot. If the library fails to start, the editor still works.

```
src/library/          core, no DOM except where noted
  schema.js           record shape, ids, paths, kinds, date keys            (spine)
  libfile.js          .slate-library.json format: parse, build, rematch    (spine)
  store.js            index store: IndexedDB `slate.library`, or memory     (spine)
  query.js            filter, text search, sort, group                      (spine)
  jobs.js             pausable job queue                                    (spine)
  library.js          Library: state, every write, undo, saving choices    (spine)
  commands.js         command table, runCommand(), manifest()              (spine)
  boot.js             wires services and UI; the test seam                 (spine)
  scan.js             walk a root, read metadata and sidecars, applyScan   (scan agent)
  metadata.js         exifr wrapper                                        (scan agent)
  thumbs.js           OPFS thumbnails, worker pool, video posters          (scan agent)
  persist.js          read and write the library file                      (organise agent)
  trash.js            move files into and out of .slate-trash              (organise agent)
  xmp.js              parse XMP sidecars                                   (organise agent)
  door.js             NakliOS command registration                         (door agent)
src/ui/library/
  view.js             Library mode: sidebar, search, grid, scrubber, viewer (grid agent)
  library.css         its styles                                           (grid agent)
  organise.js         action bar, culling keys, tag and album dialogs      (organise agent)
src/editor/commands.js  editor commands (image.*) appended to the library's command list
src/vendor/exifr.mjs  exifr 7.1.3 full ESM build, MIT                      (scan agent)
commands.json         written by scripts/gen-commands.mjs from manifest()
tests/test-*.mjs      Node tests; `npm test` builds and runs them all
```

## Data

The user's folders are the record. Slate never moves a photo into its own store and never edits an original file.

- **Roots.** A root is a folder the user added: `{ id, name, handle, mode, added, lastScan }`. `mode` is `fsa` (a `FileSystemDirectoryHandle`, Chrome and Edge) or `files` (a `webkitdirectory` pick on Firefox and Safari: browse-only, files held in memory as `root.files`, never stored).
- **Records.** One `PhotoRecord` per photo or video (`schema.js`). The id is `<rootId>/<relative path>`. Capture time is the EXIF wall clock stored as if it were UTC, so day grouping uses UTC getters everywhere.
- **The index** is IndexedDB `slate.library` (`store.js`): stores `photos`, `roots` and `kv`. It can be deleted at any time; a rescan rebuilds it.
- **Choices** are favourite, rating 0 to 5, flag (pick or reject), hidden, tags and trashed. They live in `lib.choices` (Map id to choice) and are saved in the library file.
- **Albums** are `{ id, name, created, cover, items: Set<id> }` in `lib.albums`. They hold references only.
- **The library file** is `.slate-library.json` at the top of each root. Its format is in the header of `libfile.js`. `Library.libFileFor(rootId)` builds it and `Library.flush()` hands it to `persist.save`. Saves are debounced by 600 ms after any change. It also keeps each photo's import details (`lib.meta`: date, place, caption and people from a Takeout JSON or an iCloud CSV), which `scan.js` applies where EXIF and XMP have none, so a rebuild keeps them.
- **Thumbnails** are WebP files in OPFS (`thumbs.js`), at most 256 px on the long edge.

## The core: `Library` (library.js)

Every change goes through a `Library` method, so buttons, keys and agents share one path and one undo log. Each write takes ids and `{ dryRun }`, and returns `{ changed, undo }` (or `{ changed, dryRun: true }`). `lib.undo(token)` reverses one change.

| Method | Notes |
|---|---|
| `load()` | roots and records from the store, then each root's library file |
| `addRoot({ handle, name, files })` | stores the root, loads its library file, scans it |
| `removeRoot(id)`, `rescan(id?, { full })`, `rebuild()` | rebuild clears the index and thumbnails, keeps choices |
| `applyScan(rootId, { upserts, seen })` | for scan.js; `seen` (Set of ids) only on the final call of a full walk; marks missing files and runs `reconcile` |
| `patchRecords([{ id, ...fields }])` | for thumbs.js and late metadata |
| `search(opts)` | see `QueryOpts` in query.js |
| `setFavourite`, `setRating`, `setFlag`, `setHidden`, `tag` | choices |
| `trash`, `restore`, `emptyTrash` | call `services.trash`; emptying is the only permanent delete |
| `albumCreate`, `albumRename`, `albumDelete`, `albumAdd`, `albumRemove`, `albumSetCover`, `albumCover(al)` | albums |
| `getFile(id)`, `getHandle(id, { parent })` | the `File` or handle on disk for a record; `relPathOf(file)` gives a browse-only file's path |
| `counts()`, `tags()`, `folders()`, `rating(id)`, `tagsOf(id)`, `albumsOf(id)`, `choice(id)`, `get(id)` | reads |

Events: `lib.on('records' | 'choices' | 'albums' | 'roots' | 'saved' | 'error', fn)`. Background work runs on `lib.jobs` (`jobs.js`); its `onProgress` drives the status line.

## Scan (scan.js, metadata.js)

`scanRoot(lib, root, { full })`:

1. For `fsa` roots, check permission with `root.handle.queryPermission({ mode: 'readwrite' })`. If it is not granted, call `requestPermission` (this needs a user gesture). If that fails, throw an `Error` with `code = 'permission'`; the view shows a Reconnect button that calls `lib.rescan(root.id)` from a click.
2. Walk the folder recursively with `entries()`. Skip folders where `isSkippedDir(name)` is true, which includes every dot-folder and so `.slate-trash`. Index files whose `kindOf(name)` is `photo` or `video`. Remember `.xmp` files by folder for sidecar lookup. For `files` roots, use each `File.webkitRelativePath` without its first segment.
3. A file is unchanged when `unchanged(record, file)` holds (same size and lastModified). Unless `full` is set, an unchanged file is only added to `seen`.
4. A new or changed file gets `newRecord(...)`, then `readMetadata(file, rec)` fields. If a sidecar exists (`sidecarNames(name)` from xmp.js), `parseXmp(text)` applies too, and the sidecar wins over embedded metadata for tags, rating, time and GPS.
5. Call `lib.applyScan(root.id, { upserts })` in batches of about 500, then once more with `{ upserts: rest, seen }`. Hand the new and changed records to `lib.services.thumbs.enqueue(records)`.
6. Report progress through `lib.jobs`, as kind `scan` for metadata work, so the status line counts it.

`readMetadata(file, rec)` uses exifr on the head of the file. It returns `{ time, timeSource: 'exif', w, h, orient, camera, lens, lat, lon, xmpTags, xmpRating }`, setting only the fields it finds. A file with no date takes its `lastModified` converted to the local wall clock (`timeSource: 'file'`), so it groups under the local day like an EXIF time. MP4, MOV and M4V take their date from the `mvhd` box or QuickTime `com.apple.quicktime.creationdate` (`timeSource: 'video'`). Google Takeout and iCloud instants are converted the same way.

## Thumbnails (thumbs.js)

`createThumbs(lib)` returns `{ enqueue(records), url(id), dataUrl(id), remove(ids), clear(), sizeBytes(), rehash(records) }`. Each thumbnail also yields a 64-bit dHash on the record (`dhash`) for duplicate detection; `rehash` makes it from stored thumbnails.

- Store each thumbnail as one file in OPFS under `slate-thumbs/`, named from a hash of the record id. Write it from a worker where the browser allows; read it with `getFile()`.
- Try the embedded thumbnail first (`exifr.thumbnail`, for JPEG and RAW). If there is none, use `createImageBitmap(file, { resizeWidth })` in a worker for native formats. Rarer formats (HEIC off Safari, TIFF, JPEG XL, PSD, TGA, DDS, RAW without a preview) go through `decode()` from `src/decode/registry.js` on the main thread, and the bitmap is transferred, as `batch.js` does.
- Videos: load the file into a `<video>`, seek to about 10% of the duration, and draw a frame. Record `dur`, `w` and `h` with `lib.patchRecords`. A codec the browser cannot play gives `thumb: 'fail'`.
- Set `thumb` to `ok`, `none` or `fail` through `lib.patchRecords`, and fill `w` and `h` when metadata lacked them.
- `url(id)` returns an object URL from a bounded cache (revoke on eviction, about 600 entries). `dataUrl(id)` returns a data URL for the `photo.thumb` command.

## Library file, XMP and trash (persist.js, xmp.js, trash.js)

- `createPersist(store)` returns `{ load(root), save(root, libfile), canWrite(root) }`. For `fsa` roots it reads and writes `<root>/.slate-library.json` with `createWritable()`. `load` returns `null` when the file does not exist. Without write permission, or for `files` roots, it keeps the file in `store` kv under `libfile:<rootId>`, and the view offers to download it as `.slate-library.json`.
- `parseXmp(text)` returns `{ tags, rating, label, time, lat, lon }`. It reads `dc:subject`, `lr:hierarchicalSubject` (with `|` turned into `/`), `xmp:Rating`, `xmp:Label`, `exif:DateTimeOriginal` or `photoshop:DateCreated`, and `exif:GPSLatitude` and `exif:GPSLongitude`. It must run in Node (no DOMParser).
- `createTrash()` returns `{ move(root, path), restore(root, path), purge(root, path) }`. `move` puts the file at `<root>/.slate-trash/<path>`, creating folders, and moves a sidecar with it. It uses `FileSystemHandle.move()` where it exists, and otherwise copies then removes the original. `restore` moves the file back, refusing if a file already exists at the original path. `purge` removes the file from `.slate-trash`.

## The view (ui/library/view.js) and organise (ui/library/organise.js)

`initLibraryView(lib)` builds the Library mode and returns the `ui` object:

```
ui.showLibrary() / ui.hideLibrary() / ui.isOpen()
ui.openInEditor(id)        load the file into the editor (fs.js); Escape in the editor returns to the grid at the same place
ui.select(ids) / ui.selection() -> ids / ui.focused() -> id|null
ui.current() -> { view: 'timeline'|'favourites'|'videos'|'album'|'folder'|'hidden'|'trash'|'search', albumId?, rootId?, folder?, opts }
ui.registerView({ id, label, count?, ids? | render? })  adds a sidebar view: ids() shows those photos in the grid; render(el, { lib, ui, refresh }) draws a panel and may return a cleanup
ui.refreshView()           re-render the current registered view
ui.hooks.albumMenu(albumId, anchorEl)   set by organise.js; the view calls it from an album's menu button
ui.hooks.onKey(event) -> handled?       set by organise.js; the view calls it for keys it does not handle
ui.actionsEl                            an element in the library header where organise.js mounts its action bar
ui.toast(message, level)
```

The view owns layout, the sidebar (Timeline, Favourites, Videos, Albums, Folders, Hidden, Trash, and the roots with Add folder and Reconnect), the search box and filter bar, the virtualised grid with day and month headers, the month scrubber, three zoom levels, selection (click, Shift range, Ctrl or Cmd toggle, select a day), keyboard navigation (arrows, Enter, Escape, Space, `/`), the full-size viewer with an info panel and video playback, the job progress line, and the storage panel (sizes, `navigator.storage.persist()`, Rebuild index).

`initOrganise(lib, ui)` owns the action bar for the selection or the focused photo, and the culling keys: `F` favourite, `0` to `5` rate, `P` `X` `U` flag, `H` hide, `T` tag, `Delete` trash, and Shift with any of these to apply and move to the next photo. It also owns the tag dialog, the album picker (add to an album or a new one), album rename, delete and cover, and the Trash view actions (Restore, Empty trash with a confirmation that states the count). Every action calls `runCommand(lib, name, args, { ui })`, so the agent face and the buttons share one path.

## Agent door (door.js, commands.js)

`commands.js` is the one list: library commands plus the image.* editor commands from `src/editor/commands.js` (45 in all; commands.json is generated from it). `door.js` registers it with `naklios.experimental_commands.register`, and also as WebMCP tools (`slate_<name with underscores>`) when `navigator.modelContext.registerTool` exists; destructive tools ask `confirm()` first. Each entry's handler is `input => runCommand(lib, name, input, { ui })`. Standalone, the SDK no-ops. Rules from the NakliOS rail: names match `/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){0,3}$/`, scopes are read, write or destructive, at most 64 commands reach chat, and results stay under 256 KB. Write commands take at most 200 ids, `photo.bulk` (destructive) takes more, and `photo.trash`, `trash.empty` and `album.delete` are destructive, so NakliOS stages them for the person.

## Testing

- `npm test` builds `index.html`, then runs `scripts/test-slate-v2.mjs` and every `tests/test-*.mjs` in its own process.
- Core logic is tested in Node with `memoryStore()` and fake services (`tests/test-library-core.mjs`).
- Browser behaviour is checked live in Chrome over the CDP daemon through the test seam `window.__slateLibrary`. A test builds a synthetic folder in OPFS (`navigator.storage.getDirectory()`), which is a real `FileSystemDirectoryHandle`, and passes it to `addRoot`. No real photos are used.
