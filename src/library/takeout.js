// Google Takeout JSON: match each photo to its JSON file and read what the JSON says.
// Pure functions; scan.js applies the result. See spec rows I2 and I3.
//
//   matchSidecars(names) -> Map(mediaName -> jsonName)   names: every file name in one folder
//   readTakeoutJson(text) -> { time, lat, lon, description, people, favorited, archived, trashed } | null
//
// Takeout is undocumented. The naming rules below come from the Timelinize source, gpth and
// user reports (research report S4.1):
//   IMG_1.jpg           IMG_1.jpg.json, IMG_1.json (older exports)
//                       IMG_1.jpg.supplemental-metadata.json, and any cut of that suffix
//                       (IMG_1.jpg.supplemen.json, IMG_1.jpg.s.json, IMG_1.jpg..json)
//   IMG(1).jpg          IMG.jpg(1).json, IMG.jpg.supplemental-metadata(1).json
//   IMG-edited.jpg      shares IMG.jpg's JSON
//   long names          the JSON name is cut to 51 characters with ".json" (the media name to
//                       47 characters before its extension), so the JSON base is a prefix
//   fuzzy fallback      a JSON base one character away, or the same stem with another
//                       extension (IMG.HEIC.json for IMG.jpg or IMG.MP4), when only one fits
// Takeout replaces '&' and '?' in titles with '_'; both sides are compared that way, ignoring case.
//
// Time: Takeout's photoTakenTime is a true instant (Unix seconds), while Slate stores the EXIF
// wall clock as if it were UTC (schema.wallClockToTime). Slate has no zone for the photo, so the
// instant is stored as its UTC wall clock: a photo taken at 09:00 in India (UTC+05:30) groups
// under 03:30. scan.js uses it only when the photo has no EXIF or XMP time.
// scan.js saves what the JSON says in the library file (libfile.js `meta`) the first time and
// does not read the JSON again after that.

import { kindOf } from './schema.js';

const SUPPLEMENTAL = 'supplemental-metadata';
// Suffixes Google adds to edited copies, by export language.
const EDITED = ['-edited', '-modifié', '-bearbeitet', '-editado', '-modificato', '-bewerkt'];
// A JSON base this long that is a prefix of a media name is a cut name, not a different photo.
const MIN_PREFIX = 30;

const norm = s => s.replace(/[&?]/g, '_').toLowerCase();
const stemOf = n => { const i = n.lastIndexOf('.'); return i <= 0 ? n : n.slice(0, i); };
const extPart = n => { const i = n.lastIndexOf('.'); return i <= 0 ? '' : n.slice(i); };

// "IMG(1).jpg" -> { name: 'IMG.jpg', n: 1 }; "IMG.jpg" -> { name: 'IMG.jpg', n: 0 }.
function splitMediaCounter(name) {
  const m = /^(.*)\((\d+)\)(\.[^.]*)?$/.exec(name);
  return m ? { name: m[1] + (m[3] || ''), n: Number(m[2]) } : { name, n: 0 };
}

// The bases one JSON name stands for: [{ base, n }], counter removed, suffix cut removed.
function jsonBases(jsonName) {
  let base = jsonName.slice(0, -5); // ".json"
  let n = 0;
  const c = /^(.*)\((\d+)\)$/.exec(base);
  if (c) { base = c[1]; n = Number(c[2]); }
  const out = [{ base, n }];
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const tail = base.slice(dot + 1).toLowerCase();
    if (SUPPLEMENTAL.startsWith(tail) && !kindOf(base)) {
      let b = base.slice(0, dot), k = n;
      const c2 = !k && /^(.*)\((\d+)\)$/.exec(b); // IMG.jpg(1).supplemental-metadata.json
      if (c2) { b = c2[1]; k = Number(c2[2]); }
      out.push({ base: b, n: k });
    }
  }
  return out;
}

function editedOriginal(name) {
  const stem = stemOf(name), ext = extPart(name), low = stem.toLowerCase();
  for (const s of EDITED) if (low.endsWith(s)) return stem.slice(0, -s.length) + ext;
  return null;
}

// One edit at most between a and b (insert, delete or replace a character).
function withinOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function matchSidecars(names) {
  const jsons = names.filter(n => n.toLowerCase().endsWith('.json'));
  const media = names.filter(n => kindOf(n));
  const out = new Map();
  if (!jsons.length) return out;

  // key "n|base" -> json name; entries: every (base, n, json) for the prefix and fuzzy passes.
  const exact = new Map(), entries = [];
  for (const j of jsons) {
    for (const { base, n } of jsonBases(j)) {
      const key = `${n}|${norm(base)}`;
      if (!exact.has(key)) exact.set(key, j);
      entries.push({ base: norm(base), n, json: j });
    }
  }

  const find = (name) => {
    const { name: orig, n } = splitMediaCounter(name);
    const o = norm(orig), whole = norm(name);
    // 1. Exact: the full name, the stem, or the literal name with its counter.
    for (const key of [`${n}|${o}`, `${n}|${norm(stemOf(orig))}`, `0|${whole}`]) {
      if (exact.has(key)) return exact.get(key);
    }
    // 2. Cut names: the longest JSON base that is a prefix of the media name.
    let best = null;
    for (const e of entries) {
      if (e.n !== n || e.base.length < MIN_PREFIX || !o.startsWith(e.base)) continue;
      if (!best || e.base.length > best.base.length) best = e;
    }
    return best?.json ?? null;
  };

  const fuzzy = (name) => {
    const { name: orig, n } = splitMediaCounter(name);
    const o = norm(orig), stem = norm(stemOf(orig));
    const hits = new Set();
    for (const e of entries) {
      if (e.n !== n || !kindOf(e.base)) continue;
      if (withinOne(e.base, o) || norm(stemOf(e.base)) === stem) hits.add(e.json);
    }
    return hits.size === 1 ? [...hits][0] : null;
  };

  // Originals first, so an edited copy can borrow its original's JSON.
  for (const m of media) {
    if (editedOriginal(m)) continue;
    const j = find(m);
    if (j) out.set(m, j);
  }
  for (const m of media) {
    const orig = editedOriginal(m);
    if (!orig) continue;
    const j = find(m) ?? out.get(media.find(x => x.toLowerCase() === orig.toLowerCase())) ?? find(orig);
    if (j) out.set(m, j);
  }
  // Fuzzy last, and only when one photo and one JSON point at each other.
  const claims = new Map();
  for (const m of media) {
    if (out.has(m)) continue;
    const j = fuzzy(editedOriginal(m) ?? m);
    if (j) claims.set(m, j);
  }
  const per = new Map();
  for (const j of claims.values()) per.set(j, (per.get(j) || 0) + 1);
  for (const [m, j] of claims) if (per.get(j) === 1) out.set(m, j);
  return out;
}

export function readTakeoutJson(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const out = { time: null, lat: null, lon: null, description: '', people: [], favorited: false, archived: false, trashed: false };

  const secs = Number(j.photoTakenTime?.timestamp ?? NaN);
  const made = Number(j.creationTime?.timestamp ?? NaN);
  const s = Number.isFinite(secs) && secs > 0 ? secs : Number.isFinite(made) && made > 0 ? made : null;
  if (s != null) out.time = s * 1000; // the instant, read as the UTC wall clock (see the header)

  for (const g of [j.geoData, j.geoDataExif]) {
    const lat = Number(g?.latitude), lon = Number(g?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)
      && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { out.lat = lat; out.lon = lon; break; }
  }

  if (typeof j.description === 'string') out.description = j.description.trim();
  if (Array.isArray(j.people)) {
    out.people = [...new Set(j.people.map(p => (typeof p?.name === 'string' ? p.name.trim() : '')).filter(Boolean))];
  }
  out.favorited = j.favorited === true;
  out.archived = j.archived === true;
  out.trashed = j.trashed === true;
  return out;
}
