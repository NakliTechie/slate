// Places view (spec rows P1, P2, P3). initPlaces(lib, ui) adds two sidebar views:
//   Places        a panel with a List tab (countries and nearest places with photo counts)
//                 and a Map tab (Natural Earth outlines on a canvas, photo pins clustered by
//                 grid cell, drag to pan, wheel to zoom, click a pin to see its photos)
//   Place photos  the grid filtered to the place or pin last clicked
// Place data loads from Slate's own origin (src/library/places.js); nothing about a photo's
// position is sent anywhere.
//
// P3: "Use a map file (.pmtiles)" reads a PMTiles file the user picks, through the pmtiles
// library's FileSource (File.slice, no network), and draws it with MapLibre GL JS. Both
// libraries load from jsdelivr at pinned versions the first time the button is used. The
// file itself never leaves the device. Labels are not drawn, because MapLibre needs a font
// server for them.

import { createPlaces, groupByPlace, clusterPoints, ATTRIBUTION } from '../../library/places.js';
import { esc } from '../../core/html.js';

export const MAPLIBRE_URL = 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs';
export const MAPLIBRE_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.css';
export const PMTILES_URL = 'https://cdn.jsdelivr.net/npm/pmtiles@4.5.0/+esm';

const CELL = 44;          // pin cluster cell, CSS pixels
const MAX_SCALE = 4000;   // pixels per degree at the deepest zoom

export function initPlaces(lib, ui, { places = createPlaces() } = {}) {
  let tab = 'list';
  let picked = null;      // { title, ids } for the Place photos view
  let gpsCount = null;    // photos with a position; null = recount
  lib.on('records', () => { gpsCount = null; });
  lib.on('choices', () => { gpsCount = null; });

  const located = () => lib.search({}).filter(r => r.lat != null && r.lon != null);

  // A pin's title: its place, or "near <place>" for a cluster.
  function titleFor(ids) {
    const p = places.placeOf(lib.get(ids[0]));
    if (!p) return 'pin';
    return ids.length === 1 ? p.city : `near ${p.city}`;
  }

  function showPhotos(title, ids) {
    picked = { title: title ?? titleFor(ids), ids: [...ids] };
    ui.refreshView();
    const btn = document.querySelector('.lib-nav[data-xview="place-photos"]');
    if (btn) btn.click();
    else ui.toast(`${ids.length} photos in ${title}`);
  }

  ui.registerView({
    id: 'places',
    label: 'Places',
    count: () => (gpsCount ??= located().length),
    countText: () => { const n = (gpsCount ??= located().length); return `${n.toLocaleString('en-GB')} photo${n === 1 ? '' : 's'} with a location`; },
    render(el) {
      el.innerHTML = `<div class="plc-root">
        <div class="plc-head">
          <div class="plc-tabs" role="tablist">
            <button class="btn plc-tab" data-tab="list" role="tab">List</button>
            <button class="btn plc-tab" data-tab="map" role="tab">Map</button>
          </div>
          <button class="btn plc-pm" hidden>Use a map file (.pmtiles)…</button>
          <input type="file" class="plc-file" accept=".pmtiles" hidden>
        </div>
        <div class="plc-body"><p class="plc-note">Loading places…</p></div>
        <p class="plc-attr">${esc(ATTRIBUTION)}</p>
      </div>`;
      const root = el.querySelector('.plc-root'), body = el.querySelector('.plc-body');
      const pmBtn = el.querySelector('.plc-pm'), fileIn = el.querySelector('.plc-file');
      let cleanupTab = null, alive = true, redrawTimer = 0;

      const draw = () => {
        if (!alive || !places.ready) return;
        try { cleanupTab?.(); } catch { /* old tab gone */ }
        cleanupTab = null;
        for (const b of root.querySelectorAll('.plc-tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
        pmBtn.hidden = tab !== 'map';
        const recs = located();
        gpsCount = recs.length;
        if (tab === 'list') drawList(body, recs);
        else cleanupTab = drawMap(body, recs);
      };

      root.addEventListener('click', (e) => {
        const t = e.target.closest('[data-tab]');
        if (t) { tab = t.dataset.tab; draw(); return; }
        if (e.target.closest('.plc-pm')) { fileIn.value = ''; fileIn.click(); return; }
        const p = e.target.closest('[data-place]');
        if (p) {
          const g = groupByPlace(located(), places).find(c => c.cc === p.dataset.cc);
          const city = p.dataset.place === '*' ? null : g?.cities.find(c => c.name === p.dataset.place);
          if (city) showPhotos(`${city.name}, ${g.name}`, city.ids);
          else if (g) showPhotos(g.name, g.ids);
        }
      });
      fileIn.addEventListener('change', async () => {
        const file = fileIn.files?.[0];
        if (!file) return;
        try { cleanupTab?.(); } catch { /* old tab gone */ }
        cleanupTab = null;
        body.innerHTML = '<p class="plc-note">Loading the map library…</p>';
        try {
          const stop = await drawBasemap(body, file, located(), showPhotos, () => draw());
          if (alive) cleanupTab = stop; else stop();
        }
        catch (err) {
          console.error('[slate places] map file', err);
          body.innerHTML = `<p class="plc-note">Could not open ${esc(file.name)}: ${esc(err.message)}</p>`;
        }
      });

      const offRecords = lib.on('records', () => { clearTimeout(redrawTimer); redrawTimer = setTimeout(() => { if (!body.querySelector('.plc-gl')) draw(); }, 800); });
      places.load().then(draw, (err) => {
        if (alive) body.innerHTML = `<p class="plc-note">Place data did not load: ${esc(err.message)}</p>`;
      });
      return () => {
        alive = false;
        clearTimeout(redrawTimer);
        offRecords();
        try { cleanupTab?.(); } catch { /* panel gone */ }
      };
    },
  });

  ui.registerView({
    id: 'place-photos',
    get label() { return picked ? `Place: ${picked.title}` : 'Place photos'; },
    count: () => (picked ? picked.ids.length : null),
    ids: () => picked?.ids ?? [],
  });

  function drawList(body, recs) {
    const groups = groupByPlace(recs, places);
    const none = lib.search({}).length - recs.length;
    if (!groups.length) {
      body.innerHTML = `<p class="plc-note">No photos have a location yet. Photos taken with location turned on carry GPS in their EXIF data or XMP sidecar.</p>`;
      return;
    }
    body.innerHTML = `<p class="plc-note">${recs.length.toLocaleString('en-GB')} photos in ${groups.length} ${groups.length === 1 ? 'country' : 'countries'}${none ? `; ${none.toLocaleString('en-GB')} ${none === 1 ? 'has' : 'have'} no location` : ''}. Each photo is placed at the nearest town of 5,000 people or more.</p>
      <div class="plc-list">${groups.map(g => `
        <details class="plc-country"${groups.length <= 3 ? ' open' : ''}>
          <summary><span class="plc-cname">${esc(g.name)}</span><span class="plc-count">${g.count.toLocaleString('en-GB')}</span></summary>
          <button class="plc-city plc-all" data-cc="${esc(g.cc)}" data-place="*">All of ${esc(g.name)}<span class="plc-count">${g.count.toLocaleString('en-GB')}</span></button>
          ${g.cities.map(c => `<button class="plc-city" data-cc="${esc(g.cc)}" data-place="${esc(c.name)}">${esc(c.name)}<span class="plc-count">${c.count.toLocaleString('en-GB')}</span></button>`).join('')}
        </details>`).join('')}
      </div>`;
  }

  // ── P2: outline map on a canvas, equirectangular ─────────────────────────
  function drawMap(body, recs) {
    body.innerHTML = '<div class="plc-map"><canvas class="plc-canvas" tabindex="0" aria-label="Map of photo locations. Drag to pan, scroll to zoom, click a pin to see its photos."></canvas><p class="plc-hint">Drag to pan, scroll to zoom, click a pin to see its photos.</p></div>';
    const wrap = body.querySelector('.plc-map'), cv = body.querySelector('canvas'), ctx = cv.getContext('2d');
    const css = getComputedStyle(body);
    const col = (v, d) => css.getPropertyValue(v).trim() || d;
    const colours = { sea: col('--bg-0', '#111'), land: col('--bg-2', '#333'), edge: col('--bg-3', '#555'), pin: col('--accent', '#3b82f6'), text: col('--accent-contrast', '#fff') };
    const pts = recs.map(r => ({ lat: r.lat, lon: r.lon, id: r.id }));
    const paths = places.outlines().map(c => {
      const p = new Path2D();
      for (const ring of c.rings) { p.moveTo(ring[0], -ring[1]); for (let i = 2; i < ring.length; i += 2) p.lineTo(ring[i], -ring[i + 1]); p.closePath(); }
      return p;
    });
    // View: (cx, cy) is the map point at the canvas centre, in degrees; s is pixels per degree.
    let w = 0, h = 0, cx = 0, cy = 0, s = 1, fitted = false, clusters = [];

    function fit() {
      if (pts.length) {
        let a = 90, b = -90, c = 180, d = -180;
        for (const p of pts) { a = Math.min(a, p.lat); b = Math.max(b, p.lat); c = Math.min(c, p.lon); d = Math.max(d, p.lon); }
        const pad = 10;
        cx = (c + d) / 2; cy = (a + b) / 2;
        s = Math.min(w / Math.max(d - c + pad * 2, 20), h / Math.max(b - a + pad * 2, 10));
      } else { cx = 0; cy = 15; s = w / 360; }
      s = Math.max(Math.min(s, MAX_SCALE), w / 360);
    }
    const toX = lon => (lon - cx) * s + w / 2, toY = lat => (cy - lat) * s + h / 2;

    function paint() {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colours.sea; ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2 - cx * s, h / 2 + cy * s);
      ctx.scale(s, s);
      ctx.fillStyle = colours.land; ctx.strokeStyle = colours.edge; ctx.lineWidth = 1 / s;
      for (const p of paths) { ctx.fill(p, 'evenodd'); ctx.stroke(p); }
      ctx.restore();
      clusters = clusterPoints(pts.map(p => ({ x: toX(p.lon), y: toY(p.lat), id: p.id })).filter(p => p.x > -CELL && p.y > -CELL && p.x < w + CELL && p.y < h + CELL), CELL);
      ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const c of clusters) {
        c.r = c.ids.length === 1 ? 5 : Math.min(22, 9 + Math.log2(c.ids.length) * 2);
        ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        ctx.fillStyle = colours.pin; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = colours.text; ctx.stroke();
        if (c.ids.length > 1) { ctx.fillStyle = colours.text; ctx.fillText(c.ids.length > 999 ? `${Math.round(c.ids.length / 1000)}k` : String(c.ids.length), c.x, c.y); }
      }
    }

    function resize() {
      const r = wrap.getBoundingClientRect();
      w = Math.max(200, Math.floor(r.width)); h = Math.max(200, Math.floor(r.height));
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`; cv.style.height = `${h}px`;
      if (!fitted) { fit(); fitted = true; }
      paint();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    function zoomAt(px, py, f) {
      const lon = cx + (px - w / 2) / s, lat = cy - (py - h / 2) / s;
      s = Math.max(w / 360, Math.min(MAX_SCALE, s * f));
      cx = lon - (px - w / 2) / s; cy = lat + (py - h / 2) / s;
      clampView(); paint();
    }
    function clampView() { cx = Math.max(-180, Math.min(180, cx)); cy = Math.max(-85, Math.min(85, cy)); }

    let drag = null;
    const onWheel = (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)); };
    const onDown = (e) => { drag = { x: e.clientX, y: e.clientY, cx, cy, moved: false }; cv.setPointerCapture(e.pointerId); };
    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      cx = drag.cx - dx / s; cy = drag.cy + dy / s; clampView(); paint();
    };
    const onUp = (e) => {
      const d = drag; drag = null;
      if (!d || d.moved) return;
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const hit = clusters.find(c => Math.hypot(c.x - x, c.y - y) <= c.r + 3);
      if (!hit) return;
      showPhotos(null, hit.ids);
    };
    const onKey = (e) => {
      const step = 60 / s;
      if (e.key === '+' || e.key === '=') zoomAt(w / 2, h / 2, 1.5);
      else if (e.key === '-') zoomAt(w / 2, h / 2, 1 / 1.5);
      else if (e.key === 'ArrowLeft') { cx -= step; clampView(); paint(); }
      else if (e.key === 'ArrowRight') { cx += step; clampView(); paint(); }
      else if (e.key === 'ArrowUp') { cy += step; clampView(); paint(); }
      else if (e.key === 'ArrowDown') { cy -= step; clampView(); paint(); }
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('keydown', onKey);
    return () => { ro.disconnect(); };
  }
}

// ── P3: vector or raster basemap from a user's PMTiles file ──────────────────
let libsPromise = null;
function loadMapLibs() {
  libsPromise ??= (async () => {
    if (!document.querySelector(`link[href="${MAPLIBRE_CSS}"]`)) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = MAPLIBRE_CSS;
      document.head.appendChild(l);
    }
    const [maplibregl, pmtiles] = await Promise.all([import(MAPLIBRE_URL), import(PMTILES_URL)]);
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
    return { maplibregl, pmtiles, protocol };
  })();
  libsPromise.catch(() => { libsPromise = null; });
  return libsPromise;
}

let mapSeq = 0;
async function drawBasemap(body, file, recs, showPhotos, back) {
  const { maplibregl, pmtiles, protocol } = await loadMapLibs();
  const source = new pmtiles.FileSource(file);
  const key = `slate-map-${++mapSeq}`;
  source.getKey = () => key; // a fixed key, so a file name with spaces or slashes stays a valid URL
  const archive = new pmtiles.PMTiles(source);
  protocol.add(archive);
  const header = await archive.getHeader();
  const meta = await archive.getMetadata().catch(() => ({}));
  const url = `pmtiles://${key}`;
  const bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat];

  const style = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dfe6ea' } }] };
  const attribution = typeof meta.attribution === 'string' ? meta.attribution : '';
  if (header.tileType === 1) {
    style.sources.base = { type: 'vector', tiles: [`${url}/{z}/{x}/{y}`], minzoom: header.minZoom, maxzoom: header.maxZoom, bounds, attribution };
    for (const vl of meta.vector_layers || []) {
      const water = /water|ocean|sea/i.test(vl.id);
      style.layers.push(
        { id: `${vl.id}-fill`, type: 'fill', source: 'base', 'source-layer': vl.id, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': water ? '#a9c9de' : '#f2efe9', 'fill-opacity': water ? 1 : 0.6 } },
        { id: `${vl.id}-line`, type: 'line', source: 'base', 'source-layer': vl.id, filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': water ? '#8fb3cc' : '#b8b2a7', 'line-width': 0.8 } },
      );
    }
    if (!meta.vector_layers?.length) throw new Error('the file lists no vector layers');
  } else if ([2, 3, 4, 5].includes(header.tileType)) {
    style.sources.base = { type: 'raster', tiles: [`${url}/{z}/{x}/{y}`], tileSize: 256, minzoom: header.minZoom, maxzoom: header.maxZoom, bounds, attribution };
    style.layers.push({ id: 'base', type: 'raster', source: 'base' });
  } else {
    throw new Error('this file holds a tile type Slate cannot draw (MapLibre Tiles or unknown)');
  }

  body.innerHTML = `<div class="plc-map plc-glwrap"><div class="plc-gl"></div>
    <p class="plc-hint">${esc(file.name)}, read from your disk. <button class="btn plc-back">Back to the outline map</button></p></div>`;
  const map = new maplibregl.Map({ container: body.querySelector('.plc-gl'), style, bounds, fitBoundsOptions: { padding: 20 }, attributionControl: { compact: true } });
  body.querySelector('.plc-back').addEventListener('click', () => back());
  map.on('load', () => {
    map.addSource('photos', {
      type: 'geojson', cluster: true, clusterRadius: 40,
      data: { type: 'FeatureCollection', features: recs.map(r => ({ type: 'Feature', properties: { id: r.id }, geometry: { type: 'Point', coordinates: [r.lon, r.lat] } })) },
    });
    map.addLayer({ id: 'pins', type: 'circle', source: 'photos', paint: {
      'circle-color': '#3b82f6', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
      'circle-radius': ['case', ['has', 'point_count'], ['min', 22, ['+', 8, ['*', 2, ['log2', ['get', 'point_count']]]]], 6],
    } });
    map.on('click', 'pins', async (e) => {
      const f = e.features?.[0];
      if (!f) return;
      if (f.properties.cluster) {
        const leaves = await map.getSource('photos').getClusterLeaves(f.properties.cluster_id, Infinity, 0);
        showPhotos(null, leaves.map(l => l.properties.id));
      } else showPhotos(null, [f.properties.id]);
    });
    map.on('mouseenter', 'pins', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'pins', () => { map.getCanvas().style.cursor = ''; });
  });
  return () => { map.remove(); };
}
