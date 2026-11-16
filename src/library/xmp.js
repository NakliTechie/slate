// XMP sidecars: read the keywords, rating, colour label, capture date and GPS
// that Lightroom, digiKam and darktable write next to a photo. Plain text
// matching, no DOMParser, so it runs in Node tests and in workers.
//
// Each property may be written as an attribute of rdf:Description
// (xmp:Rating="3") or as an element (<xmp:Rating>3</xmp:Rating>). Lists
// (dc:subject, lr:hierarchicalSubject) are rdf:Bag or rdf:Seq elements.
//
// parseXmp(text) -> { tags: string[], rating: number, label: string|null,
//                     time: number|null, lat: number|null, lon: number|null }
// sidecarNames(name) -> ['photo.jpg.xmp', 'photo.xmp']  (full-name form first, as digiKam writes it)

import { normTag, wallClockToTime } from './schema.js';

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The element body of `qname`, or null. Self-closing elements give ''.
function elementBody(text, qname) {
  const q = reEsc(qname);
  const m = new RegExp(`<${q}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${q}\\s*>)`).exec(text);
  return m ? (m[1] ?? '') : null;
}

// A single value: attribute form first, then element form (first rdf:li when
// the element holds an rdf:Alt, as photoshop and some writers do).
function single(text, qname) {
  const q = reEsc(qname);
  const a = new RegExp(`(?<![\\w:.-])${q}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(text);
  if (a) return decode((a[1] ?? a[2]).trim());
  const body = elementBody(text, qname);
  if (body == null) return null;
  const li = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/.exec(body);
  const v = decode((li ? li[1] : body).replace(/<[^>]*>/g, '').trim());
  return v || null;
}

// A list: every rdf:li in the element; an attribute form gives one value.
function list(text, qname) {
  const body = elementBody(text, qname);
  if (body != null) {
    const out = [];
    for (const m of body.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)) {
      const v = decode(m[1].replace(/<[^>]*>/g, '').trim());
      if (v) out.push(v);
    }
    return out;
  }
  const one = single(text, qname);
  return one ? [one] : [];
}

// "2024-03-01T09:15:30.12+05:30", "2024:03:01 09:15:30", "2024-03-01".
// The wall clock is kept as written; any zone is ignored (see schema.js).
export function parseXmpDate(s) {
  const m = /^\s*(\d{4})[-:](\d{2})(?:[-:](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?)?/.exec(s ?? '');
  if (!m) return null;
  const [y, mo, d = 1, h = 0, mi = 0, sec = 0] = m.slice(1).map(v => (v == null ? undefined : +v));
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return wallClockToTime(y, mo, d, h, mi, sec);
}

// XMP GPS: "DD,MM.mmmN" or "DD,MM,SSN" (N, S, E, W last); a plain decimal is also accepted.
export function parseXmpGps(s) {
  if (s == null) return null;
  const t = String(s).trim();
  const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?\s*([NSEW])$/i.exec(t);
  let v;
  if (m) {
    v = +m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0);
    if (/[SW]/i.test(m[4])) v = -v;
  } else if (/^-?\d+(?:\.\d+)?$/.test(t)) {
    v = +t;
  } else return null;
  return Number.isFinite(v) ? Math.round(v * 1e7) / 1e7 : null;
}

export function parseXmp(text) {
  const src = String(text ?? '');
  const seen = new Set(), tags = [];
  const add = (t) => { const n = normTag(t); if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); tags.push(n); } };
  for (const t of list(src, 'lr:hierarchicalSubject')) add(t.replace(/\|/g, '/'));
  // A flat keyword that is already the leaf of a hierarchical tag adds nothing.
  const leaves = new Set(tags.map(t => t.slice(t.lastIndexOf('/') + 1).toLowerCase()));
  for (const t of list(src, 'dc:subject')) if (!leaves.has(normTag(t).toLowerCase())) add(t);

  // Lightroom writes -1 for rejected; the library keeps ratings 0 to 5.
  const r = Math.round(Number(single(src, 'xmp:Rating')));
  const rating = Number.isFinite(r) ? Math.max(0, Math.min(5, r)) : 0;
  const label = single(src, 'xmp:Label') || null;
  const time = parseXmpDate(single(src, 'exif:DateTimeOriginal')) ?? parseXmpDate(single(src, 'photoshop:DateCreated'));
  const lat = parseXmpGps(single(src, 'exif:GPSLatitude'));
  const lon = parseXmpGps(single(src, 'exif:GPSLongitude'));
  return { tags, rating, label, time, lat, lon };
}

export function sidecarNames(name) {
  const i = name.lastIndexOf('.');
  const full = name + '.xmp', stem = (i < 0 ? name : name.slice(0, i)) + '.xmp';
  return full === stem ? [full] : [full, stem];
}
