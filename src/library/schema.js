// Library record schema. One record per photo or video found under a root folder.
// The index (IndexedDB) holds these rows; every field can be rebuilt by a rescan,
// so nothing here is the user's only copy of anything. The user's choices
// (favourites, ratings, flags, hidden, tags, trash, albums) live apart, in the
// library file (libfile.js), and are merged in at run time.

export const SCHEMA_VERSION = 1;

// File extensions the library indexes. Photos go through Slate's decoder
// registry; videos get a poster frame and play in a <video> element.
export const PHOTO_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg',
  'heic', 'heif', 'tif', 'tiff', 'jxl', 'psd', 'tga', 'dds',
  'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2',
]);
export const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'webm']);

// Sidecar extension; `photo.jpg.xmp` (full name) and `photo.xmp` (stem) are both read.
export const SIDECAR_EXT = 'xmp';

// Folders the scanner never descends into. `.slate-trash` holds trashed files
// (see trash.js); every dot-folder is skipped so app metadata never indexes itself.
export const TRASH_DIR = '.slate-trash';
export const LIBRARY_FILE = '.slate-library.json';
export function isSkippedDir(name) { return name.startsWith('.') || name === '@eaDir' || name === '$RECYCLE.BIN'; }

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function kindOf(name) {
  const e = extOf(name);
  if (PHOTO_EXTS.has(e)) return 'photo';
  if (VIDEO_EXTS.has(e)) return 'video';
  return null;
}

// Paths are relative to their root, '/'-separated, never starting with '/'.
export function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

// A record id is "<rootId>/<relative path>". Root ids never contain '/'.
export function makeId(rootId, path) { return `${rootId}/${normPath(path)}`; }
export function splitId(id) {
  const i = id.indexOf('/');
  return i < 0 ? { rootId: id, path: '' } : { rootId: id.slice(0, i), path: id.slice(i + 1) };
}

export function folderOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * @typedef {object} PhotoRecord
 * @property {string} id        "<rootId>/<path>"
 * @property {string} rootId
 * @property {string} path      relative to the root, '/'-separated
 * @property {string} name      file name
 * @property {string} ext       lower-case extension
 * @property {'photo'|'video'} kind
 * @property {number} size      bytes
 * @property {number} mtime     File.lastModified, ms
 * @property {number} time      capture time, ms since epoch (local wall clock read as UTC; see note)
 * @property {'exif'|'xmp'|'video'|'takeout'|'icloud'|'file'} timeSource  'video': an MP4 or MOV header (metadata.js)
 * @property {number} w         pixel width after orientation (0 when unknown)
 * @property {number} h         pixel height after orientation (0 when unknown)
 * @property {number} orient    EXIF orientation 1..8 (1 when unknown)
 * @property {string} camera    "Make Model", '' when unknown
 * @property {string} lens
 * @property {number|null} lat
 * @property {number|null} lon
 * @property {number} dur       video duration in seconds (0 for photos)
 * @property {'ok'|'none'|'fail'|null} thumb  thumbnail state; null = not made yet
 * @property {boolean} sidecar  an XMP sidecar was found and read
 * @property {string[]} xmpTags keywords read from XMP or embedded metadata (choices.tags adds to these)
 * @property {number} xmpRating rating read from XMP (0 when none)
 * @property {string} [description] caption from a Google Takeout JSON (searchable)
 * @property {boolean} [takeout]  the file had a Google Takeout JSON beside it
 * @property {string} [dhash]    64-bit perceptual hash as 16 hex characters, from the thumbnail (duplicates)
 * @property {string} [fingerprint] SHA-256 hex of the first 1 MB, the last 1 MB and the size; only for files that share a size. Byte equality is checked separately (dupes.js)
 * @property {{offset:number,length:number}} [motion] a Google Motion Photo's embedded MP4, as bytes from the end of the file
 * @property {string} [liveVideo] path of the paired Apple Live Photo MOV in the same folder (that MOV has no record of its own)
 * @property {boolean} missing  last rescan did not find the file
 * @property {number} indexed   ms when this row was written
 *
 * The index is disposable, so details from an import (Takeout JSON, iCloud CSV) are also kept
 * in the library file as an item's `meta` (lib.meta), and scan.js applies them on every read.
 *
 * Capture time note: EXIF DateTimeOriginal has no zone. It is stored as if it
 * were UTC (Date.UTC of the wall-clock fields) so a photo taken at 09:00
 * groups under 09:00 on its day wherever the library is opened. Day and month
 * keys below therefore use UTC getters. A true instant (File.lastModified, an
 * MP4 mvhd time) is first turned into this browser's local wall clock with
 * instantToWallClock, so a file written at 01:30 IST on 2 January groups
 * under 2 January (review S9).
 */

/**
 * @typedef {object} ImportMeta  library-file `meta` for one photo (libfile.js); every field optional
 * @property {string} [taken]    wall clock as stored (no zone), "2019-07-03T15:26:30"
 * @property {number} [lat]
 * @property {number} [lon]
 * @property {string} [caption]
 * @property {string[]} [people] names, applied as people/<name> tags
 * @property {'takeout'|'icloud'} source
 */

export function newRecord(rootId, path, file) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    id: makeId(rootId, path), rootId, path: normPath(path), name, ext: extOf(name),
    kind: kindOf(name) ?? 'photo',
    size: file?.size ?? 0, mtime: file?.lastModified ?? 0,
    time: file?.lastModified ? instantToWallClock(file.lastModified) : 0, timeSource: 'file',
    w: 0, h: 0, orient: 1, camera: '', lens: '', lat: null, lon: null, dur: 0,
    thumb: null, sidecar: false, xmpTags: [], xmpRating: 0,
    missing: false, indexed: Date.now(),
  };
}

// The same file seen again: path, size and lastModified all match.
export function unchanged(rec, file) {
  return rec && file && rec.size === file.size && rec.mtime === file.lastModified;
}

// Wall-clock fields to the stored time (see note above).
export function wallClockToTime(y, mo, d, h = 0, mi = 0, s = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

// A true instant (ms since the epoch) to the stored time: the local wall clock of this
// browser at that instant, read as UTC. Not for EXIF times, which are wall clocks already.
export function instantToWallClock(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return 0;
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

export function dayKey(time) {
  const d = new Date(time);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export function monthKey(time) {
  const d = new Date(time);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthName(i) { return MONTHS[i]; }
export function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  return `${wd} ${d} ${MONTHS[m - 1]} ${y}`;
}
export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

// Default choices for a record with no entry in the library file.
export function emptyChoice() {
  return { fav: false, rating: 0, flag: null, hidden: false, tags: [], trashed: null };
}
export const FLAGS = ['pick', 'reject'];
export function isEmptyChoice(c) {
  return !c || (!c.fav && !c.rating && !c.flag && !c.hidden && !(c.tags && c.tags.length) && !c.trashed);
}

// Tags are trimmed, '/'-separated for hierarchy, compared case-insensitively.
export function normTag(t) {
  return String(t).split('/').map(s => s.trim()).filter(Boolean).join('/');
}
