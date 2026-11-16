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
// Wikimedia answers bulk original downloads with HTTP 429 and asks clients to use a standard
// thumbnail size instead, so images come down as 1920 px thumbnails. Thumbnails carry no EXIF, so
// the script writes the original's camera EXIF (Make, Model, DateTimeOriginal, and GPS when the
// original's EXIF had it) back into each core photo from the API's commonmetadata.
const THUMB_WIDTH = 1920;
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
  // added for the larger set (top-up pass)
  'South Korea': [33, 38.7, 124.5, 130], 'Nepal': [26.3, 30.5, 80, 88.3], 'Sri Lanka': [5.9, 9.9, 79.5, 82],
  'Philippines': [4.5, 21.2, 116.9, 126.7], 'Malaysia': [0.8, 7.4, 99.6, 119.3], 'Taiwan': [21.8, 25.4, 119.9, 122.1],
  'Turkey': [35.8, 42.2, 25.6, 44.9], 'Jordan': [29.1, 33.4, 34.9, 39.3], 'United Arab Emirates': [22.6, 26.1, 51.5, 56.4],
  'Greece': [34.8, 41.8, 19.3, 28.3], 'Portugal': [36.9, 42.2, -9.6, -6.1], 'Netherlands': [50.7, 53.6, 3.3, 7.3],
  'Switzerland': [45.8, 47.9, 5.9, 10.5], 'Austria': [46.3, 49.1, 9.5, 17.2], 'Poland': [49, 54.9, 14.1, 24.2],
  'Czech Republic': [48.5, 51.1, 12.1, 18.9], 'Ireland': [51.4, 55.4, -10.5, -6], 'Sweden': [55.3, 69.1, 11, 24.2],
  'Finland': [59.8, 70.1, 20.5, 31.6], 'Croatia': [42.4, 46.6, 13.4, 19.5],
  'Colombia': [-4.2, 12.5, -79, -66.8], 'Ecuador': [-5, 1.5, -81, -75.2], 'Bolivia': [-22.9, -9.7, -69.7, -57.4],
  'Cuba': [19.8, 23.3, -85, -74.1], 'Guatemala': [13.7, 17.8, -92.3, -88.2], 'Costa Rica': [8, 11.3, -86, -82.5],
  'Ghana': [4.7, 11.2, -3.3, 1.2], 'Ethiopia': [3.4, 14.9, 33, 48], 'Namibia': [-29, -16.9, 11.7, 25.3],
  'Uganda': [-1.5, 4.2, 29.5, 35], 'Senegal': [12.3, 16.7, -17.6, -11.3], 'Madagascar': [-25.7, -11.9, 43.2, 50.5],
  'Fiji': [-21, -12.4, 176.8, 180],
};
const PER_COUNTRY = 4;            // first pass: ~27 countries x 4 ≈ 100 core photos
// Top-up pass (the "go big" scope): extend core to about CORE_TARGET without re-selecting.
const TOPUP_VERSION = 3;   // 3: artwork reproductions pruned from core, then refilled
const CORE_TARGET = 500;
const MAX_ORIGINAL_TOPUP = 4 * 1024 * 1024;   // smaller originals keep the set under ~2 GB
const TOTAL_BUDGET = 1.9e9;                     // bytes across every selected file
const TOPUP_TERMS = ['old town', 'harbour', 'park', 'temple', 'church', 'museum', 'sunset', 'river', 'lake', 'bridge', 'village', 'architecture', 'road', 'coast', 'forest', 'square'];
const TRAVEL_TERMS = ['landscape', 'city', 'street', 'view', 'beach', 'mountain', 'market', ''];
// A few core photos taken on the same month and day across different years ("On this day").
const SAME_DAY = { monthDay: '11-17', years: [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025], want: 12 };
const PORTRAIT_PEOPLE = ['Pete Buttigieg', 'Kamala Harris', 'Lloyd Austin'];
const PORTRAITS_PER_PERSON = 4;
const TEXT_QUERIES = ['shop sign', 'storefront', 'street sign', 'signboard', 'notice board', 'menu board', 'road sign', 'shop front', 'poster wall', 'information sign'];
const TEXT_WANT = 30;
const TEXT_QUERIES_TOPUP = ['shop sign', 'storefront', 'street sign', 'signboard', 'notice board', 'menu board', 'road sign', 'shop front', 'information sign', 'plaque', 'restaurant menu', 'bus stop sign', 'neon sign', 'banner', 'billboard', 'warning sign', 'station name sign', 'inscription', 'shop window', 'street name'];
const VIDEO_QUERIES = ['street', 'waves', 'river', 'train', 'beach', 'city'];
const VIDEO_WANT = 8;
const VIDEO_QUERIES_TOPUP = ['street', 'waves', 'river', 'train', 'beach', 'city', 'waterfall', 'traffic', 'market', 'boat', 'snow', 'birds'];
const BURST_SOURCES = 8;          // core photos to derive near-duplicates from (8 x 4 = 32 files)
const BURST_VARIANTS = [          // [suffix, sips args, note]
  ['a-copy', null, 'byte-identical copy of the source'],
  ['b-q60', ['-s', 'formatOptions', '60'], 're-saved at JPEG quality 60'],
  ['c-crop98', 'crop98', 'centre crop to 98% then quality 85'],
  ['d-q40-crop99', 'crop99q40', 'centre crop to 99% then quality 40'],
];

const CHILD_RX = /\b(child|children|kid|kids|baby|babies|infant|toddler|pupil|pupils|schoolchild|schoolchildren|school ?girl|school ?boy|boy|boys|girl|girls|minor|minors|kindergarten|nursery)\b/i;
const ART_RX = /\b(paintings?|artworks?|oil on canvas|drawings?|engravings?|lithographs?|etchings?|watercolou?rs?)\b/i;
const NON_TRAVEL_RX = /\b(paintings?|artworks?|oil on canvas|drawings?|engravings?|lithographs?|etchings?|watercolou?rs?|certificate|document|receipt|screenshot|diagram|map of|logo|chart|scan|x-ray|self-portrait|selfie|nude|naked|corpse|dead body)\b/i;

// ---- small helpers --------------------------------------------------------------------------
const cleanUrl = (u) => (u ? u.split('?')[0] : u);
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
    prop: 'imageinfo|coordinates', iiprop: 'url|size|mime|extmetadata|commonmetadata', iiurlwidth: String(THUMB_WIDTH),
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
    title: p.title, page: ii.descriptionurl, url: cleanUrl(ii.url), thumb: cleanUrl(ii.thumburl), size: ii.size, mime: ii.mime,
    width: ii.width, height: ii.height, duration: ii.duration ?? null,
    licence: stripHtml(em.LicenseShortName), licenceUrl: em.LicenseUrl ?? '', author: stripHtml(em.Artist),
    categories: em.Categories ?? '', description: stripHtml(em.ImageDescription),
    make: cm.Make ?? null, model: cm.Model ?? null, taken: cm.DateTimeOriginal ?? null, lat, lon,
    exifGps: cm.GPSLatitude != null && cm.GPSLongitude != null ? { lat: Number(cm.GPSLatitude), lon: Number(cm.GPSLongitude) } : null,
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

const coreBaseOk = (c) => isFree(c) && !hasChildren(c) && !NON_TRAVEL_RX.test(`${c.title} ${c.categories}`) &&
  c.mime === 'image/jpeg' && c.size <= MAX_ORIGINAL && c.make && c.model && c.taken && c.lat != null && c.width >= 1200;

// ---- selection ------------------------------------------------------------------------------
async function select() {
  const picked = []; const seenTitles = new Set(); const seenSeries = new Set();
  const take = (c, group, extra) => { picked.push({ ...c, group, ...extra }); seenTitles.add(c.title); seenSeries.add(seriesKey(c.title)); };
  const coreOk = (c) => coreBaseOk(c) && !seenTitles.has(c.title) && !seenSeries.has(seriesKey(c.title));

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

  return { createdAt: new Date().toISOString(), files: picked, rawHeicSearch: rawFound.map((r) => r.title) };
}

// Same month-day across several years, for "On this day". Appended to core once; recorded in the manifest.
async function sameDayPass(man) {
  const seenTitles = new Set(man.files.map((f) => f.title));
  const seenSeries = new Set(man.files.map((f) => seriesKey(f.title)));
  const haveYears = new Set(man.files.filter((f) => /^same-day/.test(f.note ?? '')).map((f) => String(f.taken).slice(0, 4)));
  let sd = haveYears.size;
  for (const y of SAME_DAY.years) {
    if (sd >= SAME_DAY.want) break;
    if (haveYears.has(String(y))) continue;
    const day = `${y}-${SAME_DAY.monthDay}`;
    const q = `deepcat:"Photographs taken on ${day}" filetype:bitmap filemime:image/jpeg hastemplate:Cc-zero`;
    let results = [];
    try { results = await search(q); } catch (e) { log('search failed:', e.message); continue; }
    const c = results.find((r) => coreBaseOk(r) && !seenTitles.has(r.title) && !seenSeries.has(seriesKey(r.title)) &&
      String(r.taken).startsWith(day.replace(/-/g, ':')) && countryOf(r.lat, r.lon));
    if (c) { man.files.push({ ...c, group: 'core', country: countryOf(c.lat, c.lon), query: q, note: `same-day set: taken ${day}` }); seenTitles.add(c.title); seenSeries.add(seriesKey(c.title)); sd++; }
  }
  man.sameDayDone = sd; man.sameDayVersion = TOPUP_VERSION;
  log(`core same-day (${SAME_DAY.monthDay}): ${sd}`);
}

// Top-up: extend every group toward its larger target, keeping what is already selected.
async function topUp(man) {
  const seenTitles = new Set(man.files.map((f) => f.title));
  const seenSeries = new Set(man.files.map((f) => seriesKey(f.title)));
  const bytes = () => man.files.reduce((a, f) => a + (f.group === 'video' ? f.size : 0.8e6), 0);
  const count = (g) => man.files.filter((f) => f.group === g).length;
  const add = (c, group, extra) => { man.files.push({ ...c, group, ...extra }); seenTitles.add(c.title); seenSeries.add(seriesKey(c.title)); };
  const fresh = (c) => !seenTitles.has(c.title) && !seenSeries.has(seriesKey(c.title));

  // core: round-robin over countries so every continent grows evenly
  const countries = Object.keys(COUNTRIES);
  const perCountry = Math.ceil(CORE_TARGET / countries.length) + 1;
  const yearCount = {}; for (const f of man.files.filter((x) => x.group === 'core')) { const y = yearOf(f); yearCount[y] = (yearCount[y] ?? 0) + 1; }
  const yearCap = Math.round(CORE_TARGET * 0.15);
  const terms = [...TRAVEL_TERMS, ...TOPUP_TERMS];
  for (const country of countries) {
    if (count('core') >= CORE_TARGET || bytes() > TOTAL_BUDGET * 0.9) break;
    let n = man.files.filter((f) => f.group === 'core' && f.country === country).length;
    const authors = {}; for (const f of man.files.filter((x) => x.country === country)) authors[f.author || '?'] = (authors[f.author || '?'] ?? 0) + 1;
    for (const term of terms) {
      if (n >= perCountry || count('core') >= CORE_TARGET) break;
      const q = `filetype:bitmap filemime:image/jpeg hastemplate:Cc-zero hastemplate:Location "${country}" ${term}`.trim();
      let results = [];
      try { results = await search(q); } catch (e) { log('search failed:', e.message); continue; }
      for (const c of results) {
        if (n >= perCountry) break;
        if (!coreBaseOk(c) || !fresh(c) || !inCountry(c, country)) continue;
        const a = c.author || '?'; if ((authors[a] ?? 0) >= 4) continue;
        const y = yearOf(c); if ((yearCount[y] ?? 0) >= yearCap) continue;
        authors[a] = (authors[a] ?? 0) + 1; yearCount[y] = (yearCount[y] ?? 0) + 1;
        add(c, 'core', { country, query: q }); n++;
      }
    }
    log(`top-up core ${country}: ${n} (core total ${count('core')})`);
  }

  // text: several per query
  for (const term of TEXT_QUERIES_TOPUP) {
    if (count('text') >= TEXT_WANT) break;
    const q = `filetype:bitmap filemime:image/jpeg hastemplate:Cc-zero ${term}`;
    let results = [];
    try { results = await search(q, { limit: 30 }); } catch (e) { log('search failed:', e.message); continue; }
    let k = 0;
    for (const r of results) {
      if (k >= 3 || count('text') >= TEXT_WANT) break;
      if (isFree(r) && !hasChildren(r) && fresh(r) && r.width >= 1000) { add(r, 'text', { query: q }); k++; }
    }
  }
  log(`top-up text: ${count('text')}`);

  // video
  for (const term of VIDEO_QUERIES_TOPUP) {
    if (count('video') >= VIDEO_WANT) break;
    const q = `filetype:video hastemplate:Cc-zero ${term}`;
    let results = [];
    try { results = await search(q, { limit: 40 }); } catch (e) { log('search failed:', e.message); continue; }
    let k = 0;
    for (const r of results) {
      if (k >= 2 || count('video') >= VIDEO_WANT) break;
      if (isFree(r) && !hasChildren(r) && fresh(r) && r.size <= MAX_VIDEO && r.duration != null && r.duration >= 3 &&
        r.duration <= MAX_VIDEO_SECONDS && !/software|animation|fractal|speech|interview/i.test(r.categories + r.title)) { add(r, 'video', { query: q }); k++; }
    }
  }
  log(`top-up video: ${count('video')}`);
  man.topUpVersion = TOPUP_VERSION;
}

// Stable local paths (deterministic from the manifest order), then the derived bursts.
function layout(man) {
  const used = new Set();
  for (const p of man.files) {
    if (!p.fetched) { p.useThumb = p.group !== 'video' && p.width > THUMB_WIDTH && !!p.thumb; p.downloadUrl = p.useThumb ? thumbAt(p.thumb) : p.url; }
    const ext0 = path.extname(new URL(p.downloadUrl).pathname).toLowerCase();
    const ext = ext0 === '.jpeg' ? '.jpg' : ext0;
    const prefix = p.country ? slug(p.country, 20) + '-' : p.person ? slug(p.person, 20) + '-' : '';
    let rel = `${p.group}/${prefix}${slug(p.title, 56)}${ext}`;
    for (let i = 2; used.has(rel); i++) rel = rel.replace(/(\.\w+)$/, `-${i}$1`);
    used.add(rel); p.path = rel;
  }
  // bursts: near-duplicates derived locally from CC0 core photos; sources are fixed by title once chosen
  man.burstSources = (man.burstSources ?? []).filter((t) => man.files.some((f) => f.title === t));
  for (const p of man.files) {
    if (man.burstSources.length >= BURST_SOURCES) break;
    if (p.group === 'core' && /cc0|cc-zero/i.test(p.licence) && !man.burstSources.includes(p.title)) man.burstSources.push(p.title);
  }
  man.bursts = [];
  man.burstSources.forEach((title, i) => {
    const s = man.files.find((f) => f.title === title); if (!s) return;
    for (const [suffix, , note] of BURST_VARIANTS) {
      man.bursts.push({ group: 'bursts', derivedFrom: s.path, variant: suffix, path: `bursts/set${i + 1}-${suffix}.jpg`,
        title: s.title, page: s.page, url: s.url, author: s.author, licence: s.licence, licenceUrl: s.licenceUrl, note: `derived: ${note}` });
    }
  });
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

const thumbAt = (u) => u.replace(/\/\d+px-([^/]+)$/, `/${THUMB_WIDTH}px-$1`);

// Fill exifGps / camera fields for manifest entries chosen before those fields existed (50 titles per request).
async function refreshMeta(man) {
  const todo = man.files.filter((f) => f.group !== 'video' && !('exifGps' in f));
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const p = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', maxlag: '5', titles: batch.map((f) => f.title).join('|'),
      prop: 'imageinfo', iiprop: 'commonmetadata' });
    await jitter(400, 900);
    const d = await http(`${API}?${p}`);
    for (const pg of d.query?.pages ?? []) {
      const cm = Object.fromEntries((pg.imageinfo?.[0]?.commonmetadata ?? []).map((m) => [m.name, m.value]));
      for (const f of batch.filter((x) => x.title === pg.title)) {
        f.exifGps = cm.GPSLatitude != null && cm.GPSLongitude != null ? { lat: Number(cm.GPSLatitude), lon: Number(cm.GPSLongitude) } : null;
        f.make ??= cm.Make ?? null; f.model ??= cm.Model ?? null; f.taken ??= cm.DateTimeOriginal ?? null;
      }
    }
  }
}

// Minimal EXIF writer: IFD0 Make/Model/Software, Exif IFD DateTimeOriginal, GPS IFD lat/lon.
function buildExif({ make, model, taken, gps }) {
  const ascii = (v) => Buffer.from(String(v).replace(/[^\x20-\x7e]/g, '').trim() + '\0', 'latin1');
  const rat3 = (deg) => { const a = Math.abs(deg); const d = Math.floor(a); const mF = (a - d) * 60; const m = Math.floor(mF); const sec = Math.round((mF - m) * 60 * 10000);
    return [[d, 1], [m, 1], [sec, 10000]]; };
  const ifds = { ifd0: [], exif: [], gps: [] };
  if (make) ifds.ifd0.push([0x010f, 2, ascii(make)]);
  if (model) ifds.ifd0.push([0x0110, 2, ascii(model)]);
  ifds.ifd0.push([0x0131, 2, ascii('slate-photo-testset: EXIF copied from the Commons original')]);
  const dt = String(taken ?? '').replace(/^(\d{4})-(\d{2})-(\d{2})[T ]?/, '$1:$2:$3 ').slice(0, 19);
  if (/^\d{4}:\d{2}:\d{2}/.test(dt)) ifds.exif.push([0x9003, 2, ascii(dt.length === 10 ? dt + ' 00:00:00' : dt.padEnd(19, '0'))]);
  if (gps) {
    const rb = (r) => { const b = Buffer.alloc(24); r.forEach(([n, d], i) => { b.writeUInt32LE(n, i * 8); b.writeUInt32LE(d, i * 8 + 4); }); return b; };
    ifds.gps.push([0x0000, 1, Buffer.from([2, 2, 0, 0])], [0x0001, 2, ascii(gps.lat < 0 ? 'S' : 'N')], [0x0002, 5, rb(rat3(gps.lat))],
      [0x0003, 2, ascii(gps.lon < 0 ? 'W' : 'E')], [0x0004, 5, rb(rat3(gps.lon))]);
  }
  // layout: header(8) | IFD0 | ExifIFD | GPSIFD | data
  const n0 = ifds.ifd0.length + 1 + (ifds.gps.length ? 1 : 0);
  const sizeOf = (n) => 2 + n * 12 + 4;
  const off0 = 8, offE = off0 + sizeOf(n0), offG = offE + sizeOf(ifds.exif.length);
  let dataOff = offG + (ifds.gps.length ? sizeOf(ifds.gps.length) : 0);
  const data = []; const tiff = [];
  const writeIfd = (entries, extra) => {
    const all = [...entries, ...extra].sort((a, b) => a[0] - b[0]);
    const b = Buffer.alloc(sizeOf(all.length)); b.writeUInt16LE(all.length, 0);
    all.forEach(([tag, type, val], i) => {
      const e = 2 + i * 12; b.writeUInt16LE(tag, e); b.writeUInt16LE(type, e + 2);
      if (type === 4) { b.writeUInt32LE(1, e + 4); b.writeUInt32LE(val, e + 8); return; }
      const count = type === 5 ? val.length / 8 : val.length; b.writeUInt32LE(count, e + 4);
      if (val.length <= 4) val.copy(b, e + 8); else { b.writeUInt32LE(dataOff, e + 8); data.push(val); dataOff += val.length + (val.length % 2); if (val.length % 2) data.push(Buffer.alloc(1)); }
    });
    b.writeUInt32LE(0, b.length - 4); tiff.push(b);
  };
  writeIfd(ifds.ifd0, [[0x8769, 4, offE], ...(ifds.gps.length ? [[0x8825, 4, offG]] : [])]);
  writeIfd(ifds.exif, []);
  if (ifds.gps.length) writeIfd(ifds.gps, []);
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), header, ...tiff, ...data]);
  const seg = Buffer.alloc(4); seg.writeUInt16BE(0xffe1, 0); seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([seg, body]);
}
export function injectExif(jpeg, meta) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  // drop any existing EXIF APP1, keep everything else
  const parts = [jpeg.subarray(0, 2)]; let o = 2;
  while (o + 4 < jpeg.length && jpeg[o] === 0xff && jpeg[o + 1] !== 0xda) {
    const len = jpeg.readUInt16BE(o + 2);
    const isExif = jpeg[o + 1] === 0xe1 && jpeg.toString('latin1', o + 4, o + 10) === 'Exif\0\0';
    if (!isExif) parts.push(jpeg.subarray(o, o + 2 + len));
    o += 2 + len;
  }
  parts.splice(1, 0, buildExif(meta));
  parts.push(jpeg.subarray(o));
  return Buffer.concat(parts);
}

// ---- download + derive ----------------------------------------------------------------------
async function download(m) {
  const abs = path.join(OUT, m.path);
  if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let buf = await http(m.downloadUrl, { binary: true });
  m.fetched = m.useThumb ? 'thumb' : 'original';
  if (m.useThumb && m.group === 'core' && /\.jpe?g$/i.test(m.path)) {
    buf = injectExif(buf, { make: m.make, model: m.model, taken: m.taken, gps: m.exifGps });
    m.exifRewritten = true;
  }
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
      m.fetched === 'original' && 'original file',
      m.useThumb && `${THUMB_WIDTH} px Commons thumbnail (Wikimedia asks bulk clients to use thumbnails)`,
      m.exifRewritten && `EXIF Make/Model/DateTimeOriginal${m.exifGps ? '/GPS' : ''} copied from the original's metadata via the Commons API`, m.note].filter(Boolean).join('; ');
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
  const originals = core.filter((m) => m.fetched === 'original').length, rewritten = core.filter((m) => m.exifRewritten).length;
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
  return { groups, files: media.length, totalBytes: total, core: core.length, originals, rewritten, withCamera, withDate, withGps, withBoth,
    countries: [...countries].sort(), labelledCountries: [...new Set(core.map((m) => m.country).filter(Boolean))].sort(), years: [...years].sort(), sharedDays, csvRows, missingCredit };
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
| core/ | ${v.groups.core ?? 0} | One travel library: camera EXIF (Make, Model, DateTimeOriginal), GPS where the original kept it, ${v.labelledCountries.length} countries on every continent, years ${v.years[0]} to ${v.years.at(-1)}. Some share a month and day across years for "On this day". |
| bursts/ | ${v.groups.bursts ?? 0} | Near-duplicates made locally from ${BURST_SOURCES} CC0 core photos: a copy, a quality-60 re-save, a 98% crop, a 99% crop at quality 40. Marked derived in CREDITS.csv. |
| portraits/ | ${v.groups.portraits ?? 0} | Public-domain US government photos of adult public figures (${PORTRAIT_PEOPLE.join(', ')}), several different photos each, for face grouping. |
| text/ | ${v.groups.text ?? 0} | Signs, shop fronts and notices, for OCR. |
| video/ | ${v.groups.video ?? 0} | Short CC0 clips under ${MAX_VIDEO_SECONDS} s and 30 MB. |

Core files: ${v.originals} are untouched originals with their own EXIF; ${v.rewritten} are ${THUMB_WIDTH} px
thumbnails whose EXIF (Make, Model, DateTimeOriginal, and GPS when the original had it) the script copied
from the original's metadata, because Wikimedia rate-limits bulk original downloads and thumbnails carry
no EXIF. CREDITS.csv says which is which.

Checked by parsing each core file's EXIF: ${v.withCamera} of ${v.core} have Make and Model, ${v.withDate} have
DateTimeOriginal, ${v.withGps} have GPS, ${v.withBoth} have both.

Countries (from each photo's Commons location, ${v.labelledCountries.length}): ${v.labelledCountries.join(', ')}.

Countries confirmed from the file's own EXIF GPS (${v.countries.length}): ${v.countries.join(', ')}.

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
  }
  for (const f of man.files) { f.url = cleanUrl(f.url); f.thumb = cleanUrl(f.thumb); }
  for (const f of man.files) {   // files already on disk from an earlier run: original when the byte size matches
    if (f.fetched || !f.path) continue;
    const abs = path.join(OUT, f.path);
    if (fs.existsSync(abs)) f.fetched = fs.statSync(abs).size === f.size ? 'original' : 'thumb';
  }
  // core is a camera travel library: drop photos of paintings and other artworks (and their files)
  const art = man.files.filter((f) => f.group === 'core' && ART_RX.test(`${f.title} ${f.categories} ${f.description ?? ''}`));
  for (const f of art) { const abs = f.path && path.join(OUT, f.path); if (abs && fs.existsSync(abs)) { fs.unlinkSync(abs); log('removed artwork file', f.path); } }
  if (art.length) { man.files = man.files.filter((f) => !art.includes(f)); log(`pruned ${art.length} artwork entries from core`); }
  if (man.sameDayVersion !== TOPUP_VERSION) await sameDayPass(man);
  if (man.topUpVersion !== TOPUP_VERSION) await topUp(man);
  await refreshMeta(man);
  layout(man);
  fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 2));
  log(`selected ${man.files.length} files + ${man.bursts.length} derived`);
  if (!flag('--verify-only')) {
    let i = 0;
    for (const m of man.files) {
      i++;
      try { if (await download(m)) { log(`[${i}/${man.files.length}] ${m.path}`); await jitter(3000, 6000); } }
      catch (e) { log(`[${i}] FAILED ${m.path}: ${e.message}`); }
    }
    // core files whose EXIF lost date or GPS do not belong in core; drop them from the manifest
    for (const m of man.files.filter((x) => x.group === 'core')) {
      const abs = path.join(OUT, m.path); if (!fs.existsSync(abs)) continue;
      const ex = readExif(fs.readFileSync(abs));
      if (!ex?.dateTimeOriginal) { m.rejected = 'EXIF lacks DateTimeOriginal after download'; log('core file lacks EXIF date/GPS, kept out of core:', m.path); fs.unlinkSync(abs); }
    }
    man.files = man.files.filter((m) => !m.rejected);
    layout(man);
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
