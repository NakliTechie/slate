// Places (spec rows P1 and P2): the nearest named place for a photo's GPS position, and
// the country outlines for the map. Pure and Node-testable: the data comes from two
// same-origin files built by scripts/build-places.mjs (assets/places/cities.bin and
// countries.json), fetched once, the first time places are asked for. No other request
// is made, so a photo's position never leaves the device.
//
//   createPlaces({ fetch, base }) -> places
//     places.load()                    fetch and index the data (once; later calls share it)
//     places.ready                     true once load() has finished
//     places.nearestCity(lat, lon)     -> { name, country, distanceKm } | null
//     places.placeOf(record)           -> { city, country, countryName, distanceKm } | null, cached per record
//     places.countryName(cc)           -> GeoNames name for an ISO code
//     places.outlines()                -> [{ cc, name, rings: [[lon, lat, ...], ...] }]
//   groupByPlace(records, places)      -> countries with cities and photo ids, largest first
//   clusterPoints(points, cellSize)    -> grid clusters for map pins
//   parseCities(arrayBuffer)           -> the decoded gazetteer (format in build-places.mjs)
//
// The nearest place is found with a k-d tree over unit vectors on the sphere, so the
// answer is exact (the same as checking every place) and needs no special case at the
// poles or the 180th meridian.

export const ATTRIBUTION = 'Place names from GeoNames (geonames.org), CC BY 4.0. Country outlines from Natural Earth, public domain.';
const EARTH_KM = 6371.0088;
const RAD = Math.PI / 180;

export function parseCities(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'SLPC' || dv.getUint32(4, true) !== 1) throw new Error('cities.bin: unknown format');
  const n = dv.getUint32(8, true), nc = dv.getUint32(12, true);
  const codes = [];
  for (let i = 0; i < nc; i++) codes.push(String.fromCharCode(dv.getUint8(16 + i * 2), dv.getUint8(17 + i * 2)));
  const head = 16 + Math.ceil((nc * 2) / 4) * 4;
  const lat = new Int32Array(buf, head, n);
  const lon = new Int32Array(buf, head + n * 4, n);
  const cc = new Uint8Array(buf, head + n * 8, n);
  const names = new TextDecoder().decode(new Uint8Array(buf, head + n * 9)).split('\n');
  if (names.length !== n) throw new Error('cities.bin: name count differs from place count');
  return { n, codes, lat, lon, cc, names };
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * RAD / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// k-d tree stored as a permutation of point indices: the median of each range is the node.
function buildTree(xyz, n) {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const split = (lo, hi, axis) => {
    if (hi - lo <= 1) return;
    const sub = Array.from(order.subarray(lo, hi)).sort((a, b) => xyz[a * 3 + axis] - xyz[b * 3 + axis]);
    order.set(sub, lo);
    const mid = (lo + hi) >> 1, next = (axis + 1) % 3;
    split(lo, mid, next);
    split(mid + 1, hi, next);
  };
  split(0, n, 0);
  return order;
}

function toXyz(lat, lon) {
  const la = lat * RAD, lo = lon * RAD, c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}

export function createPlaces({ fetch: fetchFn = globalThis.fetch?.bind(globalThis), base = './assets/places/' } = {}) {
  let data = null, xyz = null, order = null, countries = null, names = {};
  let loading = null;
  const cache = new Map(); // record id -> { key, place }

  const places = {
    ready: false,
    load() {
      loading ??= (async () => {
        const [cb, cj] = await Promise.all([
          fetchFn(base + 'cities.bin').then(r => { if (!r.ok) throw new Error(`cities.bin: HTTP ${r.status}`); return r.arrayBuffer(); }),
          fetchFn(base + 'countries.json').then(r => { if (!r.ok) throw new Error(`countries.json: HTTP ${r.status}`); return r.json(); }),
        ]);
        data = parseCities(cb);
        xyz = new Float64Array(data.n * 3);
        for (let i = 0; i < data.n; i++) xyz.set(toXyz(data.lat[i] / 1e5, data.lon[i] / 1e5), i * 3);
        order = buildTree(xyz, data.n);
        countries = cj.countries;
        names = cj.names || {};
        places.ready = true;
        return places;
      })();
      loading.catch(() => { loading = null; });
      return loading;
    },

    nearestCity(lat, lon) {
      if (!data || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const [qx, qy, qz] = toXyz(lat, lon);
      let best = -1, bestD = Infinity;
      const visit = (lo, hi, axis) => {
        if (lo >= hi) return;
        const mid = (lo + hi) >> 1, p = order[mid];
        const dx = xyz[p * 3] - qx, dy = xyz[p * 3 + 1] - qy, dz = xyz[p * 3 + 2] - qz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = p; }
        const diff = (axis === 0 ? qx : axis === 1 ? qy : qz) - xyz[p * 3 + axis];
        const next = (axis + 1) % 3;
        const [near, far] = diff < 0 ? [[lo, mid], [mid + 1, hi]] : [[mid + 1, hi], [lo, mid]];
        visit(near[0], near[1], next);
        if (diff * diff < bestD) visit(far[0], far[1], next);
      };
      visit(0, data.n, 0);
      if (best < 0) return null;
      return {
        name: data.names[best],
        country: data.codes[data.cc[best]],
        distanceKm: haversineKm(lat, lon, data.lat[best] / 1e5, data.lon[best] / 1e5),
      };
    },

    placeOf(rec) {
      if (!rec || rec.lat == null || rec.lon == null || !data) return null;
      const key = `${rec.lat},${rec.lon}`;
      const hit = cache.get(rec.id);
      if (hit && hit.key === key) return hit.place;
      const c = places.nearestCity(rec.lat, rec.lon);
      const place = c ? { city: c.name, country: c.country, countryName: places.countryName(c.country), distanceKm: c.distanceKm } : null;
      cache.set(rec.id, { key, place });
      return place;
    },

    countryName(cc) { return names[cc] || cc; },
    outlines() { return countries || []; },
    // For tests and the brute-force check: the raw gazetteer.
    _data() { return data; },
  };
  return places;
}

// Photos grouped by country, then by nearest place. Counts are photos, sorted largest first.
export function groupByPlace(records, places) {
  const byCountry = new Map();
  for (const r of records) {
    const p = places.placeOf(r);
    if (!p) continue;
    let c = byCountry.get(p.country);
    if (!c) byCountry.set(p.country, c = { cc: p.country, name: p.countryName, count: 0, ids: [], cities: new Map() });
    c.count++; c.ids.push(r.id);
    let city = c.cities.get(p.city);
    if (!city) c.cities.set(p.city, city = { name: p.city, count: 0, ids: [] });
    city.count++; city.ids.push(r.id);
  }
  const bySize = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
  return [...byCountry.values()]
    .map(c => ({ ...c, cities: [...c.cities.values()].sort(bySize) }))
    .sort(bySize);
}

// Grid clustering for map pins: points are { x, y, id } in screen pixels; one cluster per
// occupied cell, placed at the mean of its points.
export function clusterPoints(points, cellSize) {
  const cells = new Map();
  for (const p of points) {
    const k = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)}`;
    let c = cells.get(k);
    if (!c) cells.set(k, c = { x: 0, y: 0, ids: [] });
    c.x += p.x; c.y += p.y; c.ids.push(p.id);
  }
  return [...cells.values()].map(c => ({ x: c.x / c.ids.length, y: c.y / c.ids.length, ids: c.ids }));
}
