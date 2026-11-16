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
// buildXmp({ rating, flag, label, tags, regions, existing }) -> XMP packet text (see below)
// parseRegions(text) -> MWG face regions (spec row F3), see "face regions" below

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

// ── face regions (MWG) ──────────────────────────────────────────────────────
// The Metadata Working Group regions schema, as digiKam, Lightroom and Picasa
// write it:
//   <mwg-rs:Regions rdf:parseType="Resource">
//    <mwg-rs:AppliedToDimensions stDim:w="4000" stDim:h="3000" stDim:unit="pixel"/>
//    <mwg-rs:RegionList><rdf:Bag><rdf:li><rdf:Description mwg-rs:Name="Asha" mwg-rs:Type="Face">
//      <mwg-rs:Area stArea:x="0.5" stArea:y="0.4" stArea:w="0.1" stArea:h="0.12" stArea:unit="normalized"/>
//    </rdf:Description></rdf:li></rdf:Bag></mwg-rs:RegionList>
//   </mwg-rs:Regions>
// stArea x and y are the centre of the rectangle; all four are fractions of
// the image (0 to 1). Each field may be an attribute or an element.
//
// parseRegions(text) -> { w, h, regions: [{ name, type, x, y, w, h }] } | null
//   name is '' when the region has none. Regions with no usable area are dropped.

export function parseRegions(text) {
  const src = String(text ?? '');
  const body = elementBody(src, 'mwg-rs:Regions');
  if (body == null) return null;
  const dims = { w: Number(single(body, 'stDim:w')) || 0, h: Number(single(body, 'stDim:h')) || 0 };
  const listBody = elementBody(body, 'mwg-rs:RegionList') ?? '';
  const regions = [];
  for (const m of listBody.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)) {
    const li = m[0];
    const num = (q) => { const v = Number(single(li, q)); return Number.isFinite(v) ? v : NaN; };
    const r = { name: single(li, 'mwg-rs:Name') ?? '', type: single(li, 'mwg-rs:Type') ?? '', x: num('stArea:x'), y: num('stArea:y'), w: num('stArea:w'), h: num('stArea:h') };
    if ([r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0) regions.push(r);
  }
  return { w: dims.w, h: dims.h, regions };
}

function regionsXml(reg, pad) {
  const n = (v) => String(Math.round(v * 1e6) / 1e6);
  const dim = reg.w > 0 && reg.h > 0 ? `${pad} <mwg-rs:AppliedToDimensions stDim:w="${Math.round(reg.w)}" stDim:h="${Math.round(reg.h)}" stDim:unit="pixel"/>\n` : '';
  const lis = reg.regions.map(r =>
    `${pad}   <rdf:li>\n${pad}    <rdf:Description${r.name ? ` mwg-rs:Name="${xmlEsc(r.name)}"` : ''} mwg-rs:Type="${xmlEsc(r.type || 'Face')}">\n` +
    `${pad}     <mwg-rs:Area stArea:x="${n(r.x)}" stArea:y="${n(r.y)}" stArea:w="${n(r.w)}" stArea:h="${n(r.h)}" stArea:unit="normalized"/>\n` +
    `${pad}    </rdf:Description>\n${pad}   </rdf:li>\n`).join('');
  return `${pad}<mwg-rs:Regions rdf:parseType="Resource">\n${dim}${pad} <mwg-rs:RegionList>\n${pad}  <rdf:Bag>\n${lis}${pad}  </rdf:Bag>\n${pad} </mwg-rs:RegionList>\n${pad}</mwg-rs:Regions>\n`;
}

export function sidecarNames(name) {
  const i = name.lastIndexOf('.');
  const full = name + '.xmp', stem = (i < 0 ? name : name.slice(0, i)) + '.xmp';
  return full === stem ? [full] : [full, stem];
}

// ── writing ─────────────────────────────────────────────────────────────────
// buildXmp({ rating, flag, label, tags, existing }) writes the four properties
// Slate owns and nothing else:
//   xmp:Rating               0 to 5; a rejected photo writes -1
//   xmp:Label                the colour label, when `label` is a string;
//                            undefined leaves an existing label alone, null removes it
//   dc:subject (rdf:Bag)     the leaf of every tag ('trips/goa' gives 'goa')
//   lr:hierarchicalSubject   every tag in full, with '|' for '/' (Lightroom's form)
// Flag mapping: Slate's choices have no colour label, so flags never become a
// label. Only reject is written, as xmp:Rating -1, the convention Lightroom,
// digiKam and darktable read. A pick writes nothing beyond its rating.
// With `existing` (a sidecar's text), only these four properties are replaced,
// in attribute or element form; every other property and namespace stays.
// `regions` ({ w, h, regions } as parseRegions returns) also replaces
// mwg-rs:Regions; left undefined, an existing mwg-rs:Regions stays as it is,
// and an empty regions list removes it.

const NS = {
  xmp: 'http://ns.adobe.com/xap/1.0/',
  dc: 'http://purl.org/dc/elements/1.1/',
  lr: 'http://ns.adobe.com/lightroom/1.0/',
};
const REGION_NS = {
  'mwg-rs': 'http://www.metadataworkinggroup.com/schemas/regions/',
  stArea: 'http://ns.adobe.com/xmp/sType/Area#',
  stDim: 'http://ns.adobe.com/xap/1.0/sType/Dimensions#',
};
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const OWNED = ['xmp:Rating', 'xmp:Label', 'dc:subject', 'lr:hierarchicalSubject'];

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function removeProp(text, qname) {
  const q = reEsc(qname);
  return text
    .replace(new RegExp(`\\s+${q}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'g'), '')
    .replace(new RegExp(`[ \\t]*<${q}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${q}\\s*>)[ \\t]*\\r?\\n?`, 'g'), '');
}

function bag(qname, items, pad) {
  return `${pad}<${qname}>\n${pad} <rdf:Bag>\n${items.map(t => `${pad}  <rdf:li>${xmlEsc(t)}</rdf:li>\n`).join('')}${pad} </rdf:Bag>\n${pad}</${qname}>\n`;
}

export function buildXmp({ rating = 0, flag = null, label, tags = [], regions, existing = null } = {}) {
  const r = flag === 'reject' ? -1 : Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  const clean = [...new Set(tags.map(normTag).filter(Boolean))];
  const leaves = [...new Set(clean.map(t => t.slice(t.lastIndexOf('/') + 1)))];
  const keepLabel = label === undefined && existing ? single(existing, 'xmp:Label') : null;
  const lab = typeof label === 'string' && label ? label : keepLabel;

  const pad = '   ';
  let props = `${pad}<xmp:Rating>${r}</xmp:Rating>\n`;
  if (lab) props += `${pad}<xmp:Label>${xmlEsc(lab)}</xmp:Label>\n`;
  if (leaves.length) props += bag('dc:subject', leaves, pad);
  if (clean.length) props += bag('lr:hierarchicalSubject', clean.map(t => t.replace(/\//g, '|')), pad);
  const writeRegions = regions !== undefined;
  if (regions?.regions?.length) props += regionsXml(regions, pad);
  const ns = regions?.regions?.length ? { ...NS, ...REGION_NS } : NS;

  let text = existing ? String(existing) : '';
  const open = /<rdf:Description\b[^>]*?(\/?)>/.exec(text);
  if (!open) {
    return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Slate">
 <rdf:RDF xmlns:rdf="${RDF_NS}">
  <rdf:Description rdf:about=""
    xmlns:xmp="${NS.xmp}"
    xmlns:dc="${NS.dc}"
    xmlns:lr="${NS.lr}"${ns === NS ? '' : Object.entries(REGION_NS).map(([p, u]) => `\n    xmlns:${p}="${u}"`).join('')}>
${props}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
  }
  for (const q of OWNED) text = removeProp(text, q);
  if (writeRegions) text = removeProp(text, 'mwg-rs:Regions');
  const m = /<rdf:Description\b([^>]*?)(\/?)>/.exec(text);
  let attrs = m[1];
  for (const [p, uri] of Object.entries(ns)) if (!new RegExp(`xmlns:${p}\\s*=`).test(attrs)) attrs += ` xmlns:${p}="${uri}"`;
  const head = `<rdf:Description${attrs}>\n${props}`;
  const tail = m[2] ? '  </rdf:Description>' : '';
  return text.slice(0, m.index) + head + tail + text.slice(m.index + m[0].length).replace(/^\s*\n/, '');
}
