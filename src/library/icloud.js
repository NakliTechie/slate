// iCloud Photos export details (spec row I5), as immich-go's `from-icloud` reads them.
// An iCloud Photos export (privacy.apple.com) holds the photos plus CSV files:
//   "Photo Details.csv" (also "Photo Details-1.csv" ...), one row per photo:
//     imgName,fileChecksum,favorite,hidden,deleted,originalCreationDate,viewCount,importDate
//     favorite/hidden/deleted are "yes" or "no"; dates read like
//     "Saturday March 18,2023 3:26 PM GMT"
//   "Albums/<album name>.csv", one column headed "Images", one image name per row.
//
//   parseCsv(text) -> string[][]                     RFC 4180: quotes, "" escapes, CRLF, BOM
//   parseICloudCsv(fileName, text) -> { kind: 'details', rows } | { kind: 'album', album, names } | { kind: 'unknown' }
//   parseICloudDate(text) -> ms | null
//   applyICloudCsv(lib, rootId, csvTexts, { dryRun }) -> summary with `undo`
//     csvTexts: [{ name, text }]; photos in the root are matched by file name, ignoring case.
//
// Dates: the CSV gives an instant in GMT and Slate stores a wall clock as if it were UTC
// (schema.wallClockToTime), so the GMT wall clock is stored, as takeout.js does. A CSV date
// fills a record's time only when the file had no date of its own (timeSource 'file').
// Each date applied is also saved in the library file (libfile.js `meta`, source 'icloud'), so
// a rebuild or full rescan restores it without the CSV (scan.applyMeta).

import { metaTaken } from './libfile.js';

export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const yes = v => /^(yes|true|1)$/i.test(String(v ?? '').trim());

export function parseICloudDate(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // "Saturday March 18,2023 3:26 PM GMT", "March 18, 2023 15:26 GMT"
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    if (mo >= 0) {
      let h = Number(m[4] ?? 0);
      const ap = m[7]?.toUpperCase();
      if (ap === 'PM' && h < 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      return Date.UTC(+m[3], mo, +m[2], h, Number(m[5] ?? 0), Number(m[6] ?? 0));
    }
  }
  // ISO "2023-03-18 15:26:00" or with a zone
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3], Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0));
  return null;
}

const baseName = n => String(n ?? '').replace(/\\/g, '/').split('/').pop();

export function parseICloudCsv(fileName, text) {
  const rows = parseCsv(text);
  if (!rows.length) return { kind: 'unknown' };
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = k => head.indexOf(k.toLowerCase());
  const iName = col('imgName');
  if (iName >= 0) {
    const iFav = col('favorite'), iHid = col('hidden'), iDel = col('deleted'), iDate = col('originalCreationDate');
    const out = [];
    for (const r of rows.slice(1)) {
      const name = (r[iName] ?? '').trim();
      if (!name) continue;
      out.push({
        name,
        favourite: iFav >= 0 && yes(r[iFav]),
        hidden: iHid >= 0 && yes(r[iHid]),
        deleted: iDel >= 0 && yes(r[iDel]),
        time: iDate >= 0 ? parseICloudDate(r[iDate]) : null,
      });
    }
    return { kind: 'details', rows: out };
  }
  if (head.length === 1) {
    const album = baseName(fileName).replace(/\.csv$/i, '').trim();
    const body = head[0] === 'images' ? rows.slice(1) : rows;
    const names = body.map(r => (r[0] ?? '').trim()).filter(Boolean);
    return album ? { kind: 'album', album, names } : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

export async function applyICloudCsv(lib, rootId, csvTexts, { dryRun = false } = {}) {
  if (!lib.roots.has(rootId)) throw new Error(`no root ${rootId}`);
  const byName = new Map();
  for (const r of lib.records.values()) {
    if (r.rootId !== rootId) continue;
    const k = r.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r.id);
  }
  const unmatched = new Set(), matched = new Set();
  const lookup = (name) => {
    const ids = byName.get(baseName(name).toLowerCase()) ?? [];
    if (ids.length) ids.forEach(id => matched.add(id)); else unmatched.add(name);
    return ids;
  };

  const fav = new Set(), hid = new Set(), times = new Map(), albums = new Map();
  let deleted = 0, skippedFiles = 0;
  for (const { name, text } of csvTexts) {
    const p = parseICloudCsv(name, text);
    if (p.kind === 'details') {
      for (const row of p.rows) {
        const ids = lookup(row.name);
        if (row.deleted) deleted++;
        for (const id of ids) {
          if (row.favourite) fav.add(id);
          if (row.hidden) hid.add(id);
          const rec = lib.get(id);
          if (row.time != null && rec.timeSource === 'file' && rec.time !== row.time) times.set(id, row.time);
        }
      }
    } else if (p.kind === 'album') {
      if (!albums.has(p.album)) albums.set(p.album, new Set());
      for (const n of p.names) for (const id of lookup(n)) albums.get(p.album).add(id);
    } else skippedFiles++;
  }

  const favIds = [...fav].filter(id => !lib.choice(id).fav);
  const hidIds = [...hid].filter(id => !lib.choice(id).hidden);
  const findAlbum = (name) => [...lib.albums.values()].find(a => a.name.toLowerCase() === name.toLowerCase());
  const albumPlan = [...albums].filter(([, ids]) => ids.size).map(([name, ids]) => {
    const al = findAlbum(name);
    return { name, albumId: al?.id ?? null, ids: [...ids].filter(id => !al?.items.has(id)) };
  }).filter(a => a.ids.length || !a.albumId);
  const summary = {
    matched: matched.size,
    unmatched: unmatched.size,
    unmatchedNames: [...unmatched].slice(0, 20),
    favourites: favIds.length,
    hidden: hidIds.length,
    dates: times.size,
    albums: albumPlan.map(a => ({ name: a.name, added: a.ids.length, created: !a.albumId })),
    deleted,
    skippedFiles,
  };
  if (dryRun) return { ...summary, dryRun: true };

  const tokens = [];
  if (favIds.length) tokens.push(lib.setFavourite(favIds, true).undo);
  if (hidIds.length) tokens.push(lib.setHidden(hidIds, true).undo);
  for (const a of albumPlan) {
    if (a.albumId) tokens.push(lib.albumAdd(a.albumId, a.ids).undo);
    else tokens.push(lib.albumCreate(a.name, { ids: a.ids }).undo);
  }
  if (times.size) {
    const before = [...times.keys()].map(id => ({ id, time: lib.get(id).time, timeSource: lib.get(id).timeSource }));
    const metaBefore = new Map([...times.keys()].map(id => [id, lib.meta.get(id) ?? null]));
    await lib.patchRecords([...times].map(([id, time]) => ({ id, time, timeSource: 'icloud' })), 'icloud');
    for (const [id, time] of times) lib.setMeta(id, { ...metaBefore.get(id), taken: metaTaken(time), source: 'icloud' });
    tokens.push(lib.rememberUndo('icloud-dates', async () => {
      for (const [id, m] of metaBefore) lib.setMeta(id, m);
      await lib.patchRecords(before.filter(b => lib.get(b.id)), 'undo');
    }));
  }
  const list = tokens.filter(Boolean);
  const undo = list.length ? lib.rememberUndo('icloud', async () => {
    for (const t of [...list].reverse()) if (lib.undoLog.has(t)) await lib.undo(t);
  }) : null;
  const changed = favIds.length + hidIds.length + times.size + albumPlan.reduce((n, a) => n + a.ids.length, 0);
  return { ...summary, changed, undo };
}
