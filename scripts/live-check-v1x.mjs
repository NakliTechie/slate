#!/usr/bin/env node
// live-check-v1x.mjs: the photo library's v1.x rows in Chrome over the CDP daemon, on synthetic OPFS folders.
// Covers Google Takeout JSON on a scanned folder (I2) and from a zip (I3), On this day (B10), duplicates
// with their review screen (D1 to D3), XMP sidecar writing (M5) and export (I4). Pickers cannot be driven,
// so folders are OPFS directories passed through window.__slateLibrary (its `mods` give the picker-less
// functions). Every folder and database this run creates is deleted by name at the end, and the tab closes.
//
//   node scripts/live-check-v1x.mjs --url http://127.0.0.1:8493/index.html

import { makeFolderJs } from './live-check-data.mjs';

const args = process.argv.slice(2);
const URL0 = (() => { const i = args.indexOf('--url'); return i >= 0 ? args[i + 1] : 'http://127.0.0.1:8493/index.html'; })();
const DAEMON = process.env.CDP_DAEMON || 'http://127.0.0.1:9334/';
const STAMP = Date.now().toString(36);
const F = { main: `slate-livecheck-v1x-${STAMP}`, exp: `slate-livecheck-exp-${STAMP}`, zipdest: `slate-livecheck-zip-${STAMP}` };
const call = async (body) => (await fetch(DAEMON, { method: 'POST', body: JSON.stringify(body) })).text();
let T = null;
const raw = (method, params = {}) => call({ cmd: 'raw', t: T, text: JSON.stringify({ method, params }) });
const ev = async (js) => { const t = await call({ cmd: 'eval', t: T, js: `(async()=>JSON.stringify(await (async()=>{${js}})()))()` }); const v = JSON.parse(t); if (v && v.exc) throw new Error(v.exc); return v == null ? v : JSON.parse(v); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(js).catch(() => false)) return true; await sleep(200); } return false; };
const results = [];
const check = (rows, what, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${rows} ${what}${detail !== '' ? ` — ${detail}` : ''}`); };
const click = async (sel) => { const p = await ev(`const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]`); if (!p) return false; for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await raw('Input.dispatchMouseEvent', { type, x: p[0], y: p[1], button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); await sleep(200); return true; };
const L = 'const S=window.__slateLibrary, L=S.lib;';
const OPFS = (name) => `(await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(name)}, { create: true }))`;

try {
  T = JSON.parse(await call({ cmd: 'open', url: `${URL0}?lc=${Date.now()}` })).targetId;
  await raw('Target.activateTarget', { targetId: T }); await raw('Page.bringToFront');
  await raw('Page.enable'); await raw('Page.setWebLifecycleState', { state: 'active' }); await raw('Emulation.setFocusEmulationEnabled', { enabled: true });
  await raw('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await until('return !!window.__slateLibrary', 15000);
  await ev(`localStorage.setItem('slate.v2.tour-complete','1'); localStorage.setItem('slate.v2.library-tour-complete','1'); document.querySelector('.tour-skip')?.click(); return 1`);

  // ── a folder with a Google Takeout JSON beside the photo that has no EXIF ──
  await ev(makeFolderJs({ name: F.main, count: 240, videos: 0 }));
  await ev(`const d=await ${OPFS(F.main)}.getDirectoryHandle('extras');
    const fh=await d.getFileHandle('no-exif.png.supplemental-metadata.json',{create:true}); const w=await fh.createWritable();
    await w.write(JSON.stringify({ title:'no-exif.png', description:'Lighthouse at dusk', photoTakenTime:{ timestamp:'1563546600' }, geoData:{ latitude:15.49, longitude:73.82, altitude:0 }, people:[{ name:'Asha' }], favorited:true })); await w.close(); return 1`);
  await ev(`${L} await S.addRoot(${OPFS(F.main)}); S.ui.showLibrary(); return 1`);
  await until(`${L} return L.jobs.status().idle && [...L.records.values()].every(r=>r.thumb!=null)`, 120000);
  const tk = await ev(`${L} const r=[...L.records.values()].find(r=>r.name==='no-exif.png'); return r && { time:new Date(r.time).toISOString(), src:r.timeSource, lat:r.lat, desc:r.description, tags:L.tagsOf(r.id), fav:L.choice(r.id).fav, json: [...L.records.values()].some(x=>x.name.endsWith('.json')) }`);
  check('I2', 'Takeout JSON gives a photo without EXIF its date, place, caption, people and favourite', tk && tk.src === 'takeout' && tk.time.startsWith('2019-07-19T14:30') && tk.lat === 15.49 && tk.desc === 'Lighthouse at dusk' && tk.tags.includes('people/Asha') && tk.fav && !tk.json, JSON.stringify(tk));
  check('I2', 'search finds the Takeout caption', (await ev(`${L} return L.search({ q: 'lighthouse' }).length`)) === 1);

  // ── On this day ──
  const mem = await ev(`const b=[...document.querySelectorAll('.library-sidebar [data-view="x"]')].map(b=>b.dataset.xview+':'+b.innerText.replace(/\\s+/g,' ')); return b`);
  check('B10', 'the sidebar offers On this day and Duplicates', mem.some(m => m.startsWith('memories:On this day')) && mem.some(m => m.startsWith('duplicates:')), mem.join(' | '));
  await click('.library-sidebar [data-xview="memories"]');
  await sleep(600);
  const md = await ev(`${L} const ids=[...document.querySelectorAll('#library .lib-tile')].map(t=>t.dataset.id); const now=new Date(); const doy=(d)=>Math.floor((Date.UTC(2001,d.getUTCMonth(),d.getUTCDate())-Date.UTC(2001,0,1))/864e5);
    const t=doy(new Date(Date.UTC(2001,now.getMonth(),now.getDate()))); const days=ids.map(id=>doy(new Date(L.get(id).time)));
    return { n: ids.length, within: days.every(d=>Math.abs(d-t)<=7), years:[...new Set(ids.map(id=>new Date(L.get(id).time).getUTCFullYear()))] }`);
  check('B10', 'On this day shows photos from this date (within 7 days) in earlier years', md.n > 0 && md.within && md.years.every(y => y < new Date().getFullYear()), JSON.stringify(md));

  // ── duplicates: the synthetic folder reuses 12 base pictures, so near-duplicate groups exist ──
  await click('.library-sidebar [data-xview="duplicates"]');
  const dupShown = await until(`return document.querySelectorAll('.lib-panel [class*="group"]').length > 0 || /group/i.test(document.querySelector('.lib-panel')?.innerText||'')`, 60000);
  const dp = await ev(`const p=document.querySelector('.lib-panel'); return { text: p.innerText.slice(0,300).replace(/\\s+/g,' '), buttons: [...p.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean).slice(0,12) }`);
  check('D2 D3', 'the Duplicates view finds near-duplicate groups and offers to trash all but the keeper', dupShown && dp.buttons.some(b => /trash/i.test(b)), dp.text);
  const before = await ev(`${L} return L.search({ trashed: 'only' }).length`);
  const keepBtn = await ev(`const b=[...document.querySelectorAll('.lib-panel button')].find(b=>/Keep the marked/i.test(b.innerText)); if(!b) return null; b.setAttribute('data-lc','1'); return true`);
  if (keepBtn) await click('[data-lc="1"]');
  await until(`${L} return L.search({ trashed: 'only' }).length > ${before}`, 15000);
  const trashed = await ev(`${L} return L.search({ trashed: 'only' }).map(r=>r.id)`);
  check('D3', '"Keep the marked one, trash the rest" moves the others to the trash', trashed.length > before, `${trashed.length} in trash`);
  const undone = await ev(`const b=[...document.querySelectorAll('.org-toast button, .toast button')].find(b=>/undo/i.test(b.innerText)); if(!b) return 'no undo button'; b.click(); await new Promise(r=>setTimeout(r,1500)); return window.__slateLibrary.lib.search({ trashed: 'only' }).length`);
  check('D3', 'Undo brings them back', undone === before, String(undone));

  // ── XMP sidecar writing (setting on), then a rating writes photo.jpg.xmp beside it ──
  const xmp = await ev(`${L} await L.services.xmpWrite.setEnabled(true); const r=L.search({ q: 'IMG_00010' })[0]; L.setRating([r.id], 5); L.tag([r.id], { add: ['trips/goa'] });
    await new Promise(res=>setTimeout(res, 2600)); await L.services.xmpWrite.flush?.();
    const dir=await L.getHandle(r.id,{parent:true}); try { return await (await (await dir.getFileHandle(r.name+'.xmp')).getFile()).text(); } catch (e) { return 'missing: '+e.name; }`);
  check('M5', 'with the setting on, a rating and a tag write photo.jpg.xmp beside the photo', /xmp:Rating="?5|<xmp:Rating>5/.test(xmp) && /trips\|goa/.test(xmp), xmp.slice(0, 160).replace(/\s+/g, ' '));
  await ev(`${L} await L.services.xmpWrite.setEnabled(false); return 1`);

  // ── export a selection's originals to another folder ──
  const ex = await ev(`${L} const ids=L.search({ limit: 3 }).slice(0,3).map(r=>r.id); const dest=${OPFS(F.exp)}; const res=await S.mods.exportFiles(L, ids, dest);
    const names=[]; for await (const [n] of dest.entries()) names.push(n); const a=await L.getFile(ids[0]); const b=await (await dest.getFileHandle(a.name)).getFile();
    return { res, names: names.length, same: a.size===b.size }`);
  check('I4', 'Export copies the originals of a selection into a folder, unchanged', ex.names === 3 && ex.same, JSON.stringify(ex));

  // ── Google Takeout zip: built here with zip.js, imported into a folder, then added ──
  const zr = await ev(`${L} const z=await import(S.mods.ZIP_URL); z.configure?.({ useWebWorkers:false });
    const c=new OffscreenCanvas(320,240); c.getContext('2d').fillStyle='#3a7'; c.getContext('2d').fillRect(0,0,320,240); const png=await c.convertToBlob({type:'image/png'});
    const w=new z.ZipWriter(new z.BlobWriter('application/zip'));
    await w.add('Takeout/Google Photos/Photos from 2021/beach.png', new z.BlobReader(png));
    await w.add('Takeout/Google Photos/Photos from 2021/beach.png.supplemental-metadata.json', new z.TextReader(JSON.stringify({ title:'beach.png', photoTakenTime:{ timestamp:'1625140800' } })));
    await w.add('Takeout/Google Photos/Goa trip/beach.png', new z.BlobReader(png));
    await w.add('Takeout/Google Photos/Goa trip/beach.png.supplemental-metadata.json', new z.TextReader(JSON.stringify({ title:'beach.png', photoTakenTime:{ timestamp:'1625140800' } })));
    const blob=await w.close(); const dest=${OPFS(F.zipdest)};
    const res=await S.mods.importTakeoutZips({ zips:[new File([blob],'takeout-001.zip',{type:'application/zip'})], dest, zipLib:z });
    const again=await S.mods.importTakeoutZips({ zips:[new File([blob],'takeout-001.zip',{type:'application/zip'})], dest, zipLib:z });
    const root=await S.addRoot(dest); await new Promise(r=>setTimeout(r,800));
    const recs=[...L.records.values()].filter(r=>r.rootId===root.id);
    return { res, again, n: recs.length, times: recs.map(r=>new Date(r.time).toISOString().slice(0,10)+' '+r.timeSource) }`);
  check('I3', 'a Takeout zip imports into a folder, keeping album folders, and its JSON dates apply', zr.res.written >= 2 && zr.n === 2 && zr.times.every(t => t === '2021-07-01 takeout'), JSON.stringify(zr));
  check('I3', 'importing the same zip again skips files already there', zr.again.written === 0 && zr.again.skipped >= 2, JSON.stringify(zr.again));
} catch (e) {
  check('run', 'v1.x check ran to the end', false, e.message);
} finally {
  try {
    await ev(`${L} for (const id of [...L.roots.keys()]) await L.removeRoot(id).catch(()=>{}); const r=await navigator.storage.getDirectory();
      for (const n of ${JSON.stringify(Object.values(F))}) await r.removeEntry(n,{recursive:true}).catch(()=>{}); await r.removeEntry('slate-thumbs',{recursive:true}).catch(()=>{});
      for (const n of ['slate.library','slate.v1']) await new Promise(res=>{const q=indexedDB.deleteDatabase(n); q.onsuccess=q.onerror=q.onblocked=()=>res();}); return 1`);
    console.log(`  cleaned up: OPFS ${Object.values(F).join(', ')} and slate-thumbs; IndexedDB slate.library and slate.v1`);
  } catch (e) { console.log('  cleanup failed', e.message); }
  await raw('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId: T } }) }).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length }));
  process.exit(pass === results.length ? 0 : 1);
}
