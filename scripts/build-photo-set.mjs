#!/usr/bin/env node
// Build a copyright-free (CC0 / public domain) photo test set for Slate's photo library.
//
// Sources: Wikimedia Commons via the MediaWiki API only. Every file's licence is read from
// extmetadata and recorded in CREDITS.csv. Node 22, no npm dependencies. Uses macOS `sips`
// only to make the derived near-duplicates in bursts/.
//
// Usage:
//   node scripts/build-photo-set.mjs [--out DIR] [--reselect] [--verify-only]
//
// Resumable and idempotent: the selection is saved to <out>/manifest.json on first run and
// reused afterwards; files already on disk are skipped. --reselect throws the saved selection
// away and searches again (files no longer selected are left alone; delete them by name).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(opt('--out', '/Volumes/Seagate/naklitechie/slate/plan-artifacts/2026-11-17-photo-set'));
const MANIFEST = path.join(OUT, 'manifest.json');
const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'slate-photo-testset/1.0 (local test fixtures)';
const MAX_ORIGINAL = 6.5 * 1024 * 1024;   // "about 6 MB"
const MAX_VIDEO = 30 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 60;

// ---- target shape ---------------------------------------------------------------------------
// core/: one person's travel library. Country -> [latMin, latMax, lonMin, lonMax] (coarse box;
// a photo counts for a country only when its GPS falls in that box).
const COUNTRIES = {
  'Japan': [24, 46, 122, 146], 'India': [6, 36, 68, 98], 'Thailand': [5.5, 20.5, 97.3, 105.7],
  'Vietnam': [8.4, 23.4, 102, 110], 'Indonesia': [-11, 6, 95, 141],
  'France': [41.3, 51.1, -5.2, 9.6], 'Italy': [36.6, 47.1, 6.6, 18.6], 'Germany': [47.2, 55.1, 5.8, 15.1],
  'United Kingdom': [49.9, 60.9, -8.2, 1.8], 'Spain': [36, 43.8, -9.4, 3.4], 'Norway': [57.9, 71.2, 4.5, 31.1],
  'Iceland': [63.3, 66.6, -24.6, -13.5],
  'United States': [24.5, 49.4, -125, -66.9], 'Canada': [41.7, 70, -141, -52], 'Mexico': [14.5, 32.7, -118, -86.7],
  'Brazil': [-33.8, 5.3, -74, -34.8], 'Peru': [-18.4, -0.03, -81.4, -68.7], 'Argentina': [-55, -21.8, -73.6, -53.6],
  'Chile': [-56, -17.5, -75.7, -66.4],
  'Kenya': [-4.7, 5, 33.9, 41.9], 'Morocco': [27.6, 35.9, -13.2, -1], 'South Africa': [-34.9, -22.1, 16.4, 32.9],
  'Egypt': [22, 31.7, 24.7, 36.9], 'Tanzania': [-11.8, -1, 29.3, 40.5],
  'Australia': [-43.7, -10.6, 113, 153.7], 'New Zealand': [-47.3, -34.4, 166.4, 178.6],
  'Antarctica': [-90, -60, -180, 180],
};
const PER_COUNTRY = 4;            // ~27 countries x 4 ≈ 100 core photos (some yield fewer)
const TRAVEL_TERMS = ['landscape', 'city', 'street', 'view', 'beach', 'mountain', 'market', ''];
// A few core photos taken on the same month and day across different years ("On this day").
const SAME_DAY = { monthDay: '11-17', years: [2012, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024], want: 6 };
const PORTRAIT_PEOPLE = ['Pete Buttigieg', 'Kamala Harris', 'Lloyd Austin'];
const PORTRAITS_PER_PERSON = 4;
const TEXT_QUERIES = ['shop sign', 'storefront', 'street sign', 'signboard', 'notice board', 'menu board', 'road sign', 'shop front', 'poster wall', 'information sign'];
const TEXT_WANT = 10;
const VIDEO_QUERIES = ['street', 'waves', 'river', 'train', 'beach', 'city'];
const VIDEO_WANT = 4;
const BURST_SOURCES = 2;          // core photos to derive near-duplicates from
const BURST_VARIANTS = [          // [suffix, sips args, note]
  ['a-copy', null, 'byte-identical copy of the source'],
  ['b-q60', ['-s', 'formatOptions', '60'], 're-saved at JPEG quality 60'],
  ['c-crop98', 'crop98', 'centre crop to 98% then quality 85'],
  ['d-q40-crop99', 'crop99q40', 'centre crop to 99% then quality 40'],
];

const CHILD_RX = /\b(child|children|kid|kids|baby|babies|infant|toddler|pupil|pupils|schoolchild|schoolchildren|school ?girl|school ?boy|boy|boys|girl|girls|minor|minors|kindergarten|nursery)\b/i;
const NON_TRAVEL_RX = /\b(certificate|document|receipt|screenshot|diagram|map of|logo|chart|scan|x-ray|self-portrait|selfie|nude|naked|corpse|dead body)\b/i;

// ---- small helpers --------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => sleep(lo + Math.random() * (hi - lo));
const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const slug = (s, n = 60) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^File:/, '')
  .replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, n).replace(/-$/, '').toLowerCase() || 'file';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function http(url, { binary = false } = {}) {
  for (let attempt = 0; attempt < 7; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } }); }
    catch (e) { log('network error, retrying:', e.message); await sleep(2000 * 2 ** attempt); continue; }
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers.get('retry-after')) || 0;
      const wait = Math.max(ra * 1000, 5000 * 2 ** attempt);
      log(`HTTP ${res.status}, backing off ${Math.round(wait / 1000)} s`);
      await sleep(wait); continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
  }
  throw new Error(`gave up after retries: ${url}`);
}

async function search(query, { limit = 50, offset = 0 } = {}) {
  const p = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', maxlag: '5',
    generator: 'search', gsrnamespace: '6', gsrlimit: String(limit), gsroffset: String(offset), gsrsearch: query,
    prop: 'imageinfo|coordinates', iiprop: 'url|size|mime|extmetadata|commonmetadata', iiurlwidth: '2048',
  });
  await jitter(400, 900);          // one API request at a time, spaced out
  const d = await http(`${API}?${p}`);
  if (d.error) throw new Error(`API error: ${d.error.info}`);
  return (d.query?.pages ?? []).sort((a, b) => a.index - b.index).map(toCandidate).filter(Boolean);
}

function toCandidate(p) {
  const ii = p.imageinfo?.[0]; if (!ii) return null;
  const em = Object.fromEntries(Object.entries(ii.extmetadata ?? {}).map(([k, v]) => [k, v?.value]));
  const cm = Object.fromEntries((ii.commonmetadata ?? []).map((m) => [m.name, m.value]));
  const lat = p.coordinates?.[0]?.lat ?? (cm.GPSLatitude != null ? Number(cm.GPSLatitude) : null);
  const lon = p.coordinates?.[0]?.lon ?? (cm.GPSLongitude != null ? Number(cm.GPSLongitude) : null);
  return {
    title: p.title, page: ii.descriptionurl, url: ii.url, thumb: ii.thumburl, size: ii.size, mime: ii.mime,
    width: ii.width, height: ii.height, duration: ii.duration ?? null,
    licence: stripHtml(em.LicenseShortName), licenceUrl: em.LicenseUrl ?? '', author: stripHtml(em.Artist),
    categories: em.Categories ?? '', description: stripHtml(em.ImageDescription),
    make: cm.Make ?? null, model: cm.Model ?? null, taken: cm.DateTimeOriginal ?? null, lat, lon,
  };
}

const isFree = (c) => /^(cc0|cc-zero|public domain|pd)\b/i.test(c.licence) || /^pd[- ]/i.test(c.licence);
const hasChildren = (c) => CHILD_RX.test(`${c.title} ${c.categories} ${c.description}`);
const countryOf = (lat, lon) => {
  if (lat == null || lon == null) return null;
  for (const [name, [a, b, c, d]] of Object.entries(COUNTRIES)) if (lat >= a && lat <= b && lon >= c && lon <= d) return name;
  return null;
};
const inCountry = (c, name) => { const [a, b, x, y] = COUNTRIES[name]; return c.lat != null && c.lat >= a && c.lat <= b && c.lon >= x && c.lon <= y; };
const yearOf = (c) => (c.taken ? Number(String(c.taken).slice(0, 4)) : null);
const seriesKey = (t) => t.replace(/^File:/, '').replace(/\(.*?\)/g, '').replace(/[\d_\-.,]+/g, ' ').replace(/\.\w+$/, '').trim().toLowerCase().slice(0, 30);

// ---- selection ------------------------------------------------------------------------------
async function select() {
  const picked = []; const seenTitles = new Set(); const seenSeries = new Set();
  const take = (c, group, extra) => { picked.push({ ...c, group, ...extra }); seenTitles.add(c.title); seenSeries.add(seriesKey(c.title)); };
  const coreOk = (c) => isFree(c) && !hasChildren(c) && !NON_TRAVEL_RX.test(`${c.title} ${c.categories}`) &&
    c.mime === 'image/jpeg' && c.size <= MAX_ORIGINAL && c.make && c.model && c.taken && c.lat != null &&
    c.width >= 1200 && !seenTitles.has(c.title) && !seenSeries.has(seriesKey(c.title));

  // core: per country, travel-flavoured searches
  const yearCount = {};
  for (const country of Object.keys(COUNTRIES)) {
    let n = 0; const authors = {};
    for (const term of TRAVEL_TERMS) {
      if (n >= PER_COUNTRY) break;
      const q = `filetype:bitmap filemime:image/jpeg hastemplate:Cc-zero hastemplate:Location "${country}" ${term}`.trim();
      let results = [];
      try { results = await search(q); } catch (e) { log('search failed:', e.message); continue; }
      for (const c of results) {
        if (n >= PER_COUNTRY) break;
        if (!coreOk(c) || !inCountry(c, country)) continue;
        const a = c.author || '?'; if ((authors[a] ?? 0) >= 2) continue;   // spread photographers
        const y = yearOf(c); if ((yearCount[y] ?? 0) >= 18) continue;       // spread years
        authors[a] = (authors[a] ?? 0) + 1; yearCount[y] = (yearCount[y] ?? 0) + 1;
        take(c, 'core', { country, query: q }); n++;
      }
    }
    log(`core ${country}: ${n}`);
  }

  // core: same month-day across years
  let sd = 0;
  for (const y of SAME_DAY.years) {
    if (sd >= SAME_DAY.want) break;
    const day = `${y}-${SAME_DAY.monthDay}`;
    const q = `incategory:"Photographs taken on ${day}" filetype:bitmap filemime:image/jpeg hastemplate:Cc-zero hastemplate:Location`;
    let results = [];
    try { results = await search(q); } catch (e) { log('search failed:', e.message); continue; }
    const c = results.find((r) => coreOk(r) && String(r.taken).startsWith(day.replace(/-/g, ':')) && countryOf(r.lat, r.lon));
    if (c) { take(c, 'core', { country: countryOf(c.lat, c.lon), query: q, note: `same-day set: taken ${day}` }); sd++; }
  }
  log(`core same-day (${SAME_DAY.monthDay}): ${sd}`);

  // portraits: public-domain photos of public figures (adults), several distinct photos each
  for (const person of PORTRAIT_PEOPLE) {
    let n = 0;
    const q = `intitle:"${person}" filetype:bitmap`;
    for (const offset of [0, 50]) {
      if (n >= PORTRAITS_PER_PERSON) break;
      let results = [];
      try { results = await search(q, { offset }); } catch (e) { log('search failed:', e.message); continue; }
      for (const c of results) {
        if (n >= PORTRAITS_PER_PERSON) break;
        const key = c.title.replace(/\s*\((?:[^)]*)\)/g, '').replace(/\.\w+$/, '').toLowerCase();
        if (!isFree(c) || hasChildren(c) || seenSeries.has('p:' + key) || !/image\/(jpeg|png)/.test(c.mime)) continue;
        if (!new RegExp(person.split(' ').pop(), 'i').test(c.title)) continue;
        picked.push({ ...c, group: 'portraits', person, query: q }); seenTitles.add(c.title); seenSeries.add('p:' + key); n++;
      }
    }
    log(`portraits ${person}: ${n}`);
  }

  // text: signage, shop fronts, notices
  let t = 0;
  for (const term of TEXT_QUERIES) {
    if (t >= TEXT_WANT) break;
    const q = `filetype:bitmap filemime:image/jpeg hastemplate:Cc-zero ${term}`;
    let results = [];
    try { results = await search(q, { limit: 20 }); } catch (e) { log('search failed:', e.message); continue; }
    const c = results.find((r) => isFree(r) && !hasChildren(r) && !seenTitles.has(r.title) && !seenSeries.has(seriesKey(r.title)) && r.width >= 1000);
    if (c) { take(c, 'text', { query: q }); t++; }
  }
  log(`text: ${t}`);

  // video: short real-world clips
  let v = 0;
  for (const term of VIDEO_QUERIES) {
    if (v >= VIDEO_WANT) break;
    const q = `filetype:video hastemplate:Cc-zero ${term}`;
    let results = [];
    try { results = await search(q, { limit: 30 }); } catch (e) { log('search failed:', e.message); continue; }
    const c = results.find((r) => isFree(r) && !hasChildren(r) && !seenTitles.has(r.title) && !seenSeries.has(seriesKey(r.title)) &&
      r.size <= MAX_VIDEO && r.duration != null && r.duration >= 3 && r.duration <= MAX_VIDEO_SECONDS && !/software|animation|fractal|speech|interview/i.test(r.categories + r.title));
    if (c) { take(c, 'video', { query: q }); v++; }
  }
  log(`video: ${v}`);

  // raw-heic: Commons does not accept HEIC/HEIF/DNG uploads; check once and record the result.
  const rawFound = [];
  for (const m of ['image/heic', 'image/heif', 'image/x-adobe-dng', 'image/x-dcraw']) {
    try { const r = await search(`filemime:${m}`, { limit: 5 }); rawFound.push(...r.filter(isFree)); } catch { /* ignore */ }
  }

  // assign stable local paths
  const used = new Set();
  for (const p of picked) {
    const ext = p.group === 'video' ? path.extname(p.url).toLowerCase()
      : (p.size <= MAX_ORIGINAL ? path.extname(p.url).toLowerCase() : '.jpg');
    const prefix = p.country ? slug(p.country, 20) + '-' : p.person ? slug(p.person, 20) + '-' : '';
    let rel = `${p.group}/${prefix}${slug(p.title, 56)}${ext === '.jpeg' ? '.jpg' : ext}`;
    for (let i = 2; used.has(rel); i++) rel = rel.replace(/(\.\w+)$/, `-${i}$1`);
    used.add(rel); p.path = rel;
    p.useThumb = p.group !== 'video' && p.size > MAX_ORIGINAL;
    p.downloadUrl = p.useThumb ? p.thumb : p.url;
  }
  // bursts: derived near-duplicates of the first core photos with GPS (CC0 sources only)
  const sources = picked.filter((p) => p.group === 'core' && /cc0|cc-zero/i.test(p.licence)).slice(0, BURST_SOURCES);
  const bursts = [];
  sources.forEach((s, i) => {
    for (const [suffix, , note] of BURST_VARIANTS) {
      bursts.push({ group: 'bursts', derivedFrom: s.path, variant: suffix, path: `bursts/set${i + 1}-${suffix}.jpg`,
        title: s.title, page: s.page, url: s.url, author: s.author, licence: s.licence, licenceUrl: s.licenceUrl, note: `derived: ${note}` });
    }
  });
  return { createdAt: new Date().toISOString(), files: picked, bursts, rawHeicSearch: rawFound.map((r) => r.title) };
}

// ---- EXIF (JPEG APP1) reader: Make, Model, DateTimeOriginal, GPS ----------------------------
export function readExif(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 < buf.length) {
    if (buf[o] !== 0xff) return null;
    const marker = buf[o + 1]; const len = buf.readUInt16BE(o + 2);
    if (marker === 0xe1 && buf.toString('latin1', o + 4, o + 10) === 'Exif\0\0') return parseTiff(buf.subarray(o + 10, o + 2 + len));
    if (marker === 0xda) return null;
    o += 2 + len;
  }
  return null;
}
function parseTiff(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (i) => (le ? t.readUInt16LE(i) : t.readUInt16BE(i));
  const u32 = (i) => (le ? t.readUInt32LE(i) : t.readUInt32BE(i));
  const ifd = (off) => {
    const out = {}; if (!off || off + 2 > t.length) return out;
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12; if (e + 12 > t.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const sz = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] ?? 1;
      const vo = sz * count > 4 ? u32(e + 8) : e + 8;
      if (vo + sz * count > t.length) continue;
      if (type === 2) out[tag] = t.toString('latin1', vo, vo + count).replace(/\0.*$/s, '').trim();
      else if (type === 3) out[tag] = u16(vo);
      else if (type === 4) out[tag] = u32(vo);
      else if (type === 5) out[tag] = Array.from({ length: count }, (_, j) => { const d = u32(vo + j * 8 + 4); return d ? u32(vo + j * 8) / d : 0; });
    }
    return out;
  };
  try {
    const ifd0 = ifd(u32(4)); const ex = ifd(ifd0[0x8769]); const gps = ifd(ifd0[0x8825]);
    const dms = (a, ref) => (Array.isArray(a) && a.length === 3 ? (a[0] + a[1] / 60 + a[2] / 3600) * (/[SW]/.test(ref ?? '') ? -1 : 1) : null);
    const lat = dms(gps[2], gps[1]); const lon = dms(gps[4], gps[3]);
    return { make: ifd0[0x010f] ?? null, model: ifd0[0x0110] ?? null, dateTimeOriginal: ex[0x9003] ?? null,
      gps: lat != null && lon != null && !(lat === 0 && lon === 0) ? { lat, lon } : null };
  } catch { return null; }
}

// ---- download + derive ----------------------------------------------------------------------
async function download(m) {
  const abs = path.join(OUT, m.path);
  if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const buf = await http(m.downloadUrl, { binary: true });
  fs.writeFileSync(abs + '.part', buf); fs.renameSync(abs + '.part', abs);
  return true;
}
function derive(b) {
  const abs = path.join(OUT, b.path); const src = path.join(OUT, b.derivedFrom);
  if (fs.existsSync(abs) || !fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const [, sipsArgs] = BURST_VARIANTS.find(([s]) => s === b.variant);
  if (!sipsArgs) { fs.copyFileSync(src, abs); return; }
  const dims = execFileSync('/usr/bin/sips', ['-g', 'pixelHeight', '-g', 'pixelWidth', src]).toString();
  const h = Number(/pixelHeight: (\d+)/.exec(dims)[1]), w = Number(/pixelWidth: (\d+)/.exec(dims)[1]);
  let a;
  if (sipsArgs === 'crop98') a = ['-c', String(Math.round(h * 0.98)), String(Math.round(w * 0.98)), '-s', 'formatOptions', '85'];
  else if (sipsArgs === 'crop99q40') a = ['-c', String(Math.round(h * 0.99)), String(Math.round(w * 0.99)), '-s', 'formatOptions', '40'];
  else a = sipsArgs;
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', ...a, src, '--out', abs], { stdio: 'ignore' });
}

// ---- outputs --------------------------------------------------------------------------------
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function writeCredits(man) {
  const rows = [['path', 'source_page', 'original_file_url', 'author', 'licence', 'licence_url', 'derived', 'notes']];
  for (const m of man.files) {
    if (!fs.existsSync(path.join(OUT, m.path))) continue;
    const notes = [m.country && `country: ${m.country}`, m.person && `person: ${m.person}`,
      m.useThumb && 'downloaded as the 2048 px thumbnail (original over 6 MB); thumbnail usually lacks EXIF', m.note].filter(Boolean).join('; ');
    rows.push([m.path, m.page, m.url, m.author, m.licence, m.licenceUrl, 'no', notes]);
  }
  for (const b of man.bursts) {
    if (!fs.existsSync(path.join(OUT, b.path))) continue;
    rows.push([b.path, b.page, b.url, b.author, b.licence, b.licenceUrl, 'yes', `${b.note}; from ${b.derivedFrom}`]);
  }
  fs.writeFileSync(path.join(OUT, 'CREDITS.csv'), rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
  return rows.length - 1;
}
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }

function verify(man) {
  const groups = {}; let total = 0;
  const media = walk(OUT).filter((f) => /\/(core|bursts|portraits|text|video|raw-heic)\//.test(f) && !f.endsWith('.part'));
  for (const f of media) { const g = path.relative(OUT, f).split('/')[0]; groups[g] = (groups[g] ?? 0) + 1; total += fs.statSync(f).size; }
  const core = man.files.filter((m) => m.group === 'core' && fs.existsSync(path.join(OUT, m.path)));
  let withDate = 0, withGps = 0, withBoth = 0, withCamera = 0; const countries = new Set(), years = new Set(), monthDays = {};
  for (const m of core) {
    const ex = readExif(fs.readFileSync(path.join(OUT, m.path))) ?? {};
    if (ex.make && ex.model) withCamera++;
    if (ex.dateTimeOriginal) { withDate++; years.add(ex.dateTimeOriginal.slice(0, 4)); const md = ex.dateTimeOriginal.slice(5, 10); monthDays[md] = (monthDays[md] ?? new Set()).add(ex.dateTimeOriginal.slice(0, 4)); }
    if (ex.gps) { withGps++; const c = countryOf(ex.gps.lat, ex.gps.lon); if (c) countries.add(c); }
    if (ex.gps && ex.dateTimeOriginal) withBoth++;
  }
  const sharedDays = Object.entries(monthDays).filter(([, ys]) => ys.size >= 2).map(([md, ys]) => `${md.replace(':', '-')} (${[...ys].sort().join(', ')})`);
  const csvRows = fs.readFileSync(path.join(OUT, 'CREDITS.csv'), 'utf8').trim().split('\n').length - 1;
  const csvPaths = new Set(fs.readFileSync(path.join(OUT, 'CREDITS.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')[0]));
  const missingCredit = media.map((f) => path.relative(OUT, f)).filter((p) => !csvPaths.has(p));
  return { groups, files: media.length, totalBytes: total, core: core.length, withCamera, withDate, withGps, withBoth,
    countries: [...countries].sort(), years: [...years].sort(), sharedDays, csvRows, missingCredit };
}

function writeReadme(man, v) {
  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  const txt = `# Slate photo test set (2026-11-17)

A copyright-free photo library for Slate's live tests and promo videos. Every file is CC0 or public
domain on Wikimedia Commons; \`CREDITS.csv\` lists the source page, original URL, author, licence and
licence URL for each file. Rebuild or resume with \`node scripts/build-photo-set.mjs\` in the Slate repo.

Built ${man.createdAt.slice(0, 10)}; ${v.files} files, ${mb(v.totalBytes)} in total.

| Folder | Files | Purpose |
|---|---|---|
| core/ | ${v.groups.core ?? 0} | One travel library: camera EXIF (Make, Model, DateTimeOriginal) with GPS, ${v.countries.length} countries on every continent, years ${v.years[0]} to ${v.years.at(-1)}. Some share a month and day across years for "On this day". |
| bursts/ | ${v.groups.bursts ?? 0} | Near-duplicates made locally from ${BURST_SOURCES} CC0 core photos: a copy, a quality-60 re-save, a 98% crop, a 99% crop at quality 40. Marked derived in CREDITS.csv. |
| portraits/ | ${v.groups.portraits ?? 0} | Public-domain US government photos of adult public figures (${PORTRAIT_PEOPLE.join(', ')}), several different photos each, for face grouping. |
| text/ | ${v.groups.text ?? 0} | Signs, shop fronts and notices, for OCR. |
| video/ | ${v.groups.video ?? 0} | Short CC0 clips under ${MAX_VIDEO_SECONDS} s and 30 MB. |

Checked by parsing each core file's EXIF: ${v.withCamera} of ${v.core} have Make and Model, ${v.withDate} have
DateTimeOriginal, ${v.withGps} have GPS, ${v.withBoth} have both.

Countries (from GPS): ${v.countries.join(', ')}.

Years (from DateTimeOriginal): ${v.years.join(', ')}.

Shared month-day across years: ${v.sharedDays.join('; ') || 'none'}.

No raw-heic/ folder: Commons hosts no CC0 or public-domain HEIC, HEIF or DNG files (search by MIME
type returned ${man.rawHeicSearch.length}), so the set has no HEIC or RAW sample.
`;
  fs.writeFileSync(path.join(OUT, 'README.md'), txt);
}

// ---- main -----------------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let man = !flag('--reselect') && fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;
  if (!man) {
    log('selecting files from Wikimedia Commons ...');
    man = await select();
    fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 2));
    log(`selected ${man.files.length} files + ${man.bursts.length} derived`);
  }
  if (!flag('--verify-only')) {
    let i = 0;
    for (const m of man.files) {
      i++;
      try { if (await download(m)) { log(`[${i}/${man.files.length}] ${m.path}`); await jitter(1000, 3000); } }
      catch (e) { log(`[${i}] FAILED ${m.path}: ${e.message}`); }
    }
    // core files whose EXIF lost date or GPS do not belong in core; drop them from the manifest
    for (const m of man.files.filter((x) => x.group === 'core')) {
      const abs = path.join(OUT, m.path); if (!fs.existsSync(abs)) continue;
      const ex = readExif(fs.readFileSync(abs));
      if (!ex?.dateTimeOriginal || !ex?.gps) { m.rejected = 'EXIF lacks DateTimeOriginal or GPS after download'; log('core file lacks EXIF date/GPS, kept out of core:', m.path); fs.unlinkSync(abs); }
    }
    man.files = man.files.filter((m) => !m.rejected);
    fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 2));
    for (const b of man.bursts) derive(b);
  }
  const rows = writeCredits(man);
  const v = verify(man);
  writeReadme(man, v);
  log(`CREDITS.csv rows: ${rows}`);
  console.log(JSON.stringify(v, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
