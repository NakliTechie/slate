#!/usr/bin/env node
// Builds the offline places assets (spec rows P1 and P2) into assets/places/:
//   cities.bin      every GeoNames place with population 5,000 or more (cities5000):
//                   name, country code, latitude and longitude. Format below.
//   countries.json  Natural Earth 1:110m country outlines, rounded to 0.01 degree,
//                   plus GeoNames country names by ISO code.
//   README.md       sources, licences and the build date.
//
// Usage: node scripts/build-places.mjs [tempDir]
// Inputs download into tempDir (default: a new folder under the OS temp dir) and are
// deleted afterwards. Needs `unzip` on PATH.
//
// cities.bin, little-endian:
//   0   'SLPC'            magic
//   4   u32 version (1)
//   8   u32 n             number of places
//   12  u32 nc            number of country codes
//   16  nc x 2 bytes      ASCII ISO 3166-1 alpha-2 codes, padded with zeros to a multiple of 4
//   ..  Int32[n]          latitude  x 1e5 (about 1 m)
//   ..  Int32[n]          longitude x 1e5
//   ..  Uint8[n]          index into the country codes
//   ..  UTF-8 names joined by '\n'
// Why binary: 68,000 places as JSON arrays take about 2.4 MB; this layout takes about
// 1.3 MB, and the two Int32Arrays are views on the fetched buffer with no parsing.

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'places');

const SRC = {
  cities: 'https://download.geonames.org/export/dump/cities5000.zip',
  countryInfo: 'https://download.geonames.org/export/dump/countryInfo.txt',
  countries: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_admin_0_countries.geojson',
};

const base = process.argv[2] ? resolve(process.argv[2]) : tmpdir();
mkdirSync(base, { recursive: true });
const tmp = mkdtempSync(join(base, 'slate-places-'));

async function download(url, file) {
  const r = await fetch(url, { headers: { 'user-agent': 'slate-build-places' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(file, buf);
  console.log(`downloaded ${url} (${buf.length} bytes)`);
  return file;
}

try {
  const zip = await download(SRC.cities, join(tmp, 'cities5000.zip'));
  const info = await download(SRC.countryInfo, join(tmp, 'countryInfo.txt'));
  const ne = await download(SRC.countries, join(tmp, 'countries.geojson'));
  execFileSync('unzip', ['-o', '-q', zip, '-d', join(tmp, 'x')]);

  // Country names from GeoNames countryInfo.txt (tab-separated, '#' comments).
  const names = {};
  for (const line of readFileSync(info, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f[0]?.length === 2 && f[4]) names[f[0]] = f[4];
  }

  // Places. GeoNames columns: 1 name, 4 latitude, 5 longitude, 7 feature code, 8 country code.
  // Sections of a city (PPLX, such as Lisbon's Intendente) and historical, abandoned or
  // destroyed places are dropped, so a photo is labelled with the town it was taken in.
  const SKIP = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']);
  const rows = [];
  for (const line of readFileSync(join(tmp, 'x', 'cities5000.txt'), 'utf8').split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    if (SKIP.has(f[7])) continue;
    const lat = Math.round(Number(f[4]) * 1e5), lon = Math.round(Number(f[5]) * 1e5);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows.push({ name: f[1].replace(/\n/g, ' '), cc: f[8] || 'ZZ', lat, lon });
  }
  const codes = [...new Set(rows.map(r => r.cc))].sort();
  if (codes.length > 255) throw new Error('more than 255 country codes');
  const ci = new Map(codes.map((c, i) => [c, i]));
  const n = rows.length, nc = codes.length;
  const ccBytes = Math.ceil((nc * 2) / 4) * 4;
  const nameBuf = Buffer.from(rows.map(r => r.name).join('\n'), 'utf8');
  const head = 16 + ccBytes;
  const bin = Buffer.alloc(head + n * 9 + nameBuf.length);
  bin.write('SLPC', 0, 'ascii');
  bin.writeUInt32LE(1, 4); bin.writeUInt32LE(n, 8); bin.writeUInt32LE(nc, 12);
  codes.forEach((c, i) => bin.write(c.padEnd(2, 'Z').slice(0, 2), 16 + i * 2, 'ascii'));
  rows.forEach((r, i) => {
    bin.writeInt32LE(r.lat, head + i * 4);
    bin.writeInt32LE(r.lon, head + n * 4 + i * 4);
    bin.writeUInt8(ci.get(r.cc), head + n * 8 + i);
  });
  nameBuf.copy(bin, head + n * 9);

  // Country outlines: rings as flat [lon, lat, lon, lat, ...] at 0.01 degree.
  const gj = JSON.parse(readFileSync(ne, 'utf8'));
  const r2 = v => Math.round(v * 100) / 100;
  const countries = [];
  for (const feat of gj.features) {
    const p = feat.properties;
    let cc = [p.ISO_A2, p.ISO_A2_EH, p.WB_A2].find(c => c && /^[A-Z]{2}$/.test(c)) || '';
    const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
    const rings = [];
    for (const poly of polys) for (const ring of poly) {
      const flat = [];
      for (const [x, y] of ring) {
        const a = r2(x), b = r2(y);
        if (flat.length && flat[flat.length - 2] === a && flat[flat.length - 1] === b) continue;
        flat.push(a, b);
      }
      if (flat.length >= 6) rings.push(flat);
    }
    countries.push({ cc, name: names[cc] || p.NAME, rings });
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'cities.bin'), bin);
  writeFileSync(join(OUT, 'countries.json'), JSON.stringify({ names, countries }));
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(join(OUT, 'README.md'), `# Places data

Built by \`node scripts/build-places.mjs\` on ${date}. Slate fetches these files from its own
origin the first time you open Places; nothing else is requested.

| File | Contents | Source | Licence |
|---|---|---|---|
| \`cities.bin\` | ${n} places with population 5,000 or more, without city sections (PPLX) or historical places: name, country code, latitude and longitude (format in the script header) | GeoNames \`cities5000.zip\`, ${SRC.cities} | CC BY 4.0, https://creativecommons.org/licenses/by/4.0/ |
| \`countries.json\` \`names\` | Country names by ISO code | GeoNames \`countryInfo.txt\`, ${SRC.countryInfo} | CC BY 4.0 |
| \`countries.json\` \`countries\` | ${countries.length} country outlines at 1:110m, rounded to 0.01 degree | Natural Earth, ${SRC.countries} | Public domain, https://www.naturalearthdata.com/about/terms-of-use/ |

Attribution: place names from GeoNames (geonames.org), licensed CC BY 4.0. Country outlines
from Natural Earth (naturalearthdata.com), public domain. Slate changed the GeoNames data by
keeping only these four fields and rounding coordinates to 0.00001 degree.
`);
  console.log(`cities.bin ${bin.length} bytes, ${n} places, ${nc} country codes`);
  console.log(`countries.json ${readFileSync(join(OUT, 'countries.json')).length} bytes, ${countries.length} countries`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
