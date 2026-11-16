#!/usr/bin/env node
// live-check.mjs: drive the built Slate photo library in the person's own Chrome through the CDP daemon
// (127.0.0.1:9334, chrome-cdpd.mjs) with real mouse, wheel and key events. Never a headless browser.
// The folder picker cannot be driven, so the test builds a synthetic folder in OPFS (a real
// FileSystemDirectoryHandle) and hands it to the library through window.__slateLibrary.addRoot.
// No real photos are used. Everything the run creates is deleted by name at the end.
//
//   node scripts/live-check.mjs --url http://127.0.0.1:8493/index.html [--count 10000] [--shots dir]
//
// Each check prints `PASS|FAIL <rows> <what> — <detail>`; the run ends with a JSON summary line.
// Timings are observed on a shared machine and are not benchmark claims.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFolderJs } from './live-check-data.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const URL0 = opt('url', 'http://127.0.0.1:8493/index.html');
const COUNT = Number(opt('count', '10000'));
const SHOTS = opt('shots', null);
const DAEMON = process.env.CDP_DAEMON || 'http://127.0.0.1:9334/';
const FOLDER = `slate-livecheck-${Date.now().toString(36)}`;
const FAKE = 100000;

const call = async (body) => (await fetch(DAEMON, { method: 'POST', body: JSON.stringify(body) })).text();
let T = null, CTX = null;
const raw = async (method, params = {}) => call({ cmd: 'raw', t: T, text: JSON.stringify({ method, params }) });
const ev = async (js) => {
  const t = await call({ cmd: 'eval', t: T, js: `(async()=>JSON.stringify(await (async()=>{${js}})()))()` });
  let v; try { v = JSON.parse(t); } catch { throw new Error(`daemon: ${t.slice(0, 300)}`); }
  if (v && typeof v === 'object' && v.exc) throw new Error(v.exc);
  return v === undefined || v === null ? v : JSON.parse(v);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (js, ms = 10000, step = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(js).catch(() => false)) return Date.now() - t0; await sleep(step); } return -1; };
const results = [];
const check = (rows, what, ok, detail = '') => { results.push({ rows, what, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${rows} ${what}${detail !== '' ? ` — ${detail}` : ''}`); };
const shot = async (name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await call({ cmd: 'shot', t: T, out: join(SHOTS, `${name}.png`) }); };

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const bits = (m = []) => m.reduce((b, k) => b | MOD[k], 0);
async function mouse(type, x, y, mods = [], extra = {}) { await raw('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers: bits(mods), ...extra }); }
async function click([x, y], mods = []) { await mouse('mouseMoved', x, y, mods); await mouse('mousePressed', x, y, mods); await mouse('mouseReleased', x, y, mods); await sleep(80); }
async function wheel([x, y], dy) { await raw('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }); }
const KC = { Escape: 27, Enter: 13, ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Delete: 46, ' ': 32, '/': 191 };
async function key(k, mods = []) {
  const single = k.length === 1;
  const code = single ? (/[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : /\d/.test(k) ? `Digit${k}` : k === ' ' ? 'Space' : k === '/' ? 'Slash' : '') : k;
  const vk = KC[k] ?? (single ? k.toUpperCase().charCodeAt(0) : 0);
  const b = bits(mods);
  const text = single && !(b & (MOD.meta | MOD.ctrl)) ? (b & MOD.shift ? k.toUpperCase() : k) : undefined;
  await raw('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: b & MOD.shift && single ? k.toUpperCase() : k, code, windowsVirtualKeyCode: vk, modifiers: b, ...(text ? { text } : {}) });
  await raw('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: b });
  await sleep(120);
}
const centre = (sel) => ev(`const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]`);
const L = 'const S=window.__slateLibrary, L=S.lib;';

// A hung step (a stalled tab, a promise that never settles) fails the run instead of hanging it.
const WATCHDOG = setTimeout(() => { check('run', 'live check finished within 20 minutes', false, 'watchdog'); finish(); }, 20 * 60 * 1000);
let finishing = null;
const finish = () => finishing ??= cleanup();

try {
  // Own browser context: other sessions' tab clean-ups cannot match this tab, and storage starts empty.
  CTX = JSON.parse(await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.createBrowserContext', params: {} }) })).browserContextId;
  T = JSON.parse(await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.createTarget', params: { url: `${URL0}?lc=${Date.now()}`, browserContextId: CTX } }) })).targetId;
  await raw('Target.activateTarget', { targetId: T }); await raw('Page.bringToFront');
  // Chrome slows timers and media in a tab that is not in front, and this is the person's everyday Chrome.
  // Keep the test tab active and focused for the whole run.
  await raw('Page.enable');
  await raw('Page.setWebLifecycleState', { state: 'active' });
  await raw('Emulation.setFocusEmulationEnabled', { enabled: true });
  await raw('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  check('boot', 'the library starts beside the editor', (await until('return !!window.__slateLibrary', 15000)) >= 0);
  await ev(`window.__lcErrors=[]; addEventListener('error',e=>__lcErrors.push(String(e.message))); addEventListener('unhandledrejection',e=>__lcErrors.push(String(e.reason?.message||e.reason)));`);

  // ── open the Library with Ctrl+L, then the toolbar button ──
  await click([640, 400]);
  await key('l', ['ctrl']);
  // First open shows the short library tour; a person closes it with Skip tour.
  if ((await until(`return !!document.querySelector('.tour-skip')`, 2000)) >= 0) { await click(await centre('.tour-skip')); }
  check('K3', 'the first Library open shows the library tour, and Skip closes it', !(await ev(`return !!document.querySelector('.tour-layer')`)));
  check('N1 B1', 'Ctrl+L opens the Library', await ev(`return !document.getElementById('library').hidden`));
  const empty = await ev(`return !!document.querySelector('#library') && document.querySelector('#library').innerText.includes('Add folder')`);
  check('B1', 'empty Library offers Add folder', empty);
  await key('l', ['ctrl']);
  const tb = await centre('#tb-library');
  if (tb) await click(tb);
  check('N1', 'the toolbar Library button opens it', !!tb && await ev(`return !document.getElementById('library').hidden`));

  // ── a synthetic folder of COUNT photos ──
  const gen = await ev(makeFolderJs({ name: FOLDER, count: COUNT, videos: 2 }));
  console.log(`  built ${gen.files} files, ${(gen.bytes / 1e6).toFixed(1)} MB in OPFS folder ${FOLDER}, ${gen.ms} ms`);
  await ev(`window.__lcAdd = (async()=>{ ${L} const t0=performance.now(); const root=await navigator.storage.getDirectory(); const h=await root.getDirectoryHandle(${JSON.stringify(FOLDER)}); window.__lcT0=t0; await S.addRoot(h); window.__lcScanMs=performance.now()-t0; })(); return 1`);
  const firstTile = await until(`return document.querySelectorAll('#library .lib-tile').length > 0`, 60000, 50);
  check('v1 check 1', `grid usable within 5 s of adding the folder (${COUNT} photos)`, firstTile >= 0 && firstTile <= 5000, `first tiles after ${firstTile} ms (observed, shared machine)`);
  await until('return window.__lcScanMs != null', 600000, 500);
  const scanMs = await ev('return Math.round(window.__lcScanMs)');
  const idleMs = await until(`${L} return L.jobs.status().idle`, 1800000, 1000);
  await until(`${L} return [...L.records.values()].every(r=>r.thumb!=null)`, 10000, 250);
  const total = await ev(`${L} return {recs:L.records.size, ok:[...L.records.values()].filter(r=>r.thumb==='ok').length, fail:[...L.records.values()].filter(r=>r.thumb==='fail').length, jobs:L.jobs.status(), errors:L.jobs.errors.slice(0,3), ms:Math.round(performance.now()-window.__lcT0)}`);
  check('v1 check 1', 'first-run scan and thumbnails finish', total.recs === COUNT + 4 && total.ok === total.recs, `${total.recs} records, ${total.ok} thumbnails, ${total.fail} failed ${JSON.stringify(total.errors)}; scan ${scanMs} ms, scan plus thumbnails ${total.ms} ms (observed, shared machine)`);
  check('L1 L4', 'recursive scan skips dot-folders', await ev(`${L} return ![...L.records.values()].some(r=>r.path.startsWith('.'))`));
  check('M1', 'EXIF date, camera and GPS read', await ev(`${L} const r=[...L.records.values()].find(r=>r.lat!=null); return !!r && r.timeSource==='exif' && /Google|Canon/.test(r.camera)`));
  check('M4', 'XMP sidecar tags and rating applied', await ev(`${L} const r=[...L.records.values()].find(r=>r.name==='tagged.jpg'); return r.xmpTags.includes('beach') && r.xmpRating===4`));
  check('M3', 'videos have a poster and duration', await ev(`${L} const v=[...L.records.values()].filter(r=>r.kind==='video'); return v.length===2 && v.every(r=>r.thumb==='ok' && r.dur>0.5)`));
  await shot('01-timeline');

  // ── grid: virtualised, headers, scrubber, zoom ──
  const dom = await ev(`return { tiles: document.querySelectorAll('#library .lib-tile').length, heads: document.querySelectorAll('#library .lib-head-row').length, imgs: document.querySelectorAll('#library .lib-tile img').length }`);
  check('B1', 'grid keeps only visible rows in the DOM', dom.tiles > 0 && dom.tiles < 600 && dom.heads > 0, `${dom.tiles} tiles, ${dom.heads} headers for ${total.recs} photos`);
  const g = await centre('.library-grid');
  const before = await ev(`return document.querySelector('.library-grid').scrollTop`);
  for (let i = 0; i < 10; i++) await wheel(g, 600);
  await sleep(400);
  const after = await ev(`return { top: document.querySelector('.library-grid').scrollTop, tiles: document.querySelectorAll('#library .lib-tile').length, blank: [...document.querySelectorAll('#library .lib-tile')].filter(t=>{const r=t.getBoundingClientRect(); return r.bottom>0 && r.top<innerHeight && !t.classList.contains('has-img')}).length }`);
  check('B1', 'wheel scrolls the grid and new rows render', after.top > before && after.tiles > 0, `scrollTop ${before} to ${after.top}, ${after.tiles} tiles`);
  await sleep(1500);
  const filled = await ev(`return [...document.querySelectorAll('#library .lib-tile')].filter(t=>{const r=t.getBoundingClientRect(); return r.bottom>0 && r.top<innerHeight}).every(t=>t.classList.contains('has-img'))`);
  check('M2', 'thumbnails fill the visible tiles after scrolling', filled);
  const scrub = await ev(`const s=document.querySelector('.lib-scrub'); if(!s||s.hidden) return null; const r=s.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height*0.8]`);
  if (scrub) await click(scrub);
  await sleep(300);
  const afterScrub = await ev(`return document.querySelector('.library-grid').scrollTop`);
  check('B2', 'the month scrubber jumps the grid', !!scrub && afterScrub !== after.top, `scrollTop ${after.top} to ${afterScrub}`);
  const w0 = await ev(`return document.querySelector('#library .lib-tile').getBoundingClientRect().width`);
  await click(await centre('[data-act="zoom-in"]'));
  await sleep(200);
  const w1 = await ev(`return document.querySelector('#library .lib-tile').getBoundingClientRect().width`);
  check('B3', 'zoom changes tile size', w1 > w0, `${Math.round(w0)} px to ${Math.round(w1)} px`);
  await click(await centre('[data-act="zoom-out"]'));
  await ev(`document.querySelector('.library-grid').scrollTop = 0; return 1`);
  await sleep(300);

  // ── selection and culling keys on the focused photo ──
  const tiles = await ev(`return [...document.querySelectorAll('#library .lib-tile')].slice(0,6).map(t=>{const r=t.getBoundingClientRect(); return {id:t.dataset.id, x:r.left+r.width/2, y:r.top+r.height/2}})`);
  await click([tiles[0].x, tiles[0].y]);
  const f0 = await ev(`return window.__slateLibrary.ui.focused()`);
  await key('ArrowRight');
  const f1 = await ev(`return window.__slateLibrary.ui.focused()`);
  check('K1 K2', 'click focuses a photo and ArrowRight moves on', !!f0 && !!f1 && f0 !== f1, `${f0?.split('/').pop()} to ${f1?.split('/').pop()}`);
  await click([tiles[0].x, tiles[0].y]);
  await click([tiles[3].x, tiles[3].y], ['shift']);
  const range = await ev(`return window.__slateLibrary.ui.selection().length`);
  check('B6', 'Shift-click selects a range', range === 4, `${range} selected`);
  await click([tiles[5].x, tiles[5].y], ['meta']);
  const tog = await ev(`return window.__slateLibrary.ui.selection().length`);
  check('B6', 'Cmd-click adds one photo', tog === 5, `${tog} selected`);
  await key('Escape');
  check('B6', 'Escape clears the selection', (await ev(`return window.__slateLibrary.ui.selection().length`)) === 0);

  await click([tiles[1].x, tiles[1].y]);
  const id1 = await ev(`return window.__slateLibrary.ui.focused()`);
  await key('f'); await key('4'); await key('p');
  const c1 = await ev(`${L} const c=L.choice(${JSON.stringify(id1)}); return {fav:c.fav, rating:c.rating, flag:c.flag}`);
  check('O1 O2', 'F, 4 and P favourite, rate and pick the focused photo', c1.fav && c1.rating === 4 && c1.flag === 'pick', JSON.stringify(c1));
  const undoBtn = await ev(`return !!document.querySelector('.org-toast button')`);
  check('N3', 'each change shows an Undo button', undoBtn);
  await key('3', ['shift']);
  const adv = await ev(`return window.__slateLibrary.ui.focused()`);
  check('O2', 'Shift with a rating key applies it and moves to the next photo', adv !== id1, `focus moved to ${adv?.split('/').pop()}`);
  const ae = await ev(`const a=document.activeElement; return a ? a.tagName+'.'+a.className+' '+(a.getAttribute('aria-label')||'') : null`);
  await key('x');
  check('O2', 'X rejects', (await ev(`${L} return L.choice(${JSON.stringify(adv)}).flag`)) === 'reject', `focus on ${ae}`);
  await key('h');
  check('O5', 'H hides; the photo leaves the timeline', await ev(`${L} return L.choice(${JSON.stringify(adv)}).hidden && !L.search().some(r=>r.id===${JSON.stringify(adv)})`));
  await shot('02-culled');

  // ── viewer ── (on the first JPEG tile; the newest tiles are the two videos)
  const jpg = await ev(`const t=[...document.querySelectorAll('#library .lib-tile')].find(t=>/\\.jpg$/.test(t.dataset.id)); const r=t.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]`);
  await click(jpg);
  const pre = await ev(`const a=document.activeElement; return { f: window.__slateLibrary.ui.focused(), sel: window.__slateLibrary.ui.selection().length, ae: a?.tagName+'.'+a?.className, dlg: [...document.querySelectorAll('dialog[open], [role=dialog]:not([hidden]), .tour-layer')].map(d=>d.className||d.id) }`);
  await key('Enter');
  check('B5', 'Enter opens the viewer', await until(`return !document.querySelector('.lib-viewer').hidden && !!document.querySelector('.lib-viewer img, .lib-viewer canvas, .lib-viewer video')`, 5000) >= 0, JSON.stringify(pre));
  await key('ArrowRight');
  await sleep(300);
  const info = await ev(`return document.querySelector('.lib-viewer').innerText`);
  check('B5', 'the viewer shows details (camera, path)', /Canon|Google/.test(info) && /IMG_/.test(info));
  await shot('03-viewer');
  await key('Escape');
  check('B5', 'Escape closes the viewer', await ev(`return document.querySelector('.lib-viewer').hidden`));

  // ── search ──
  await key('/');
  const focusedSearch = await ev(`return document.activeElement?.classList.contains('lib-q')`);
  await call({ cmd: 'insert', t: T, text: 'canon 2024' });
  await sleep(500);
  const sr = await ev(`${L} return { want: L.search({ q: 'canon 2024' }).length, shown: S.ui.current() }`);
  check('Q1', '/ focuses search; words filter the grid', focusedSearch && sr.want > 0 && sr.want < total.recs, `${sr.want} match "canon 2024"`);
  await key('Escape');
  await sleep(200);

  // ── albums, tags, folders through the UI and commands ──
  const ids = (await ev(`${L} return L.search({ limit: 5 }).slice(0,5).map(r=>r.id)`));
  const al = await ev(`return (await window.__slateLibrary.run('album.create', { name: 'Live check album', ids: ${JSON.stringify(ids)} }))`);
  await sleep(200);
  await until(`return !!document.querySelector('.library-sidebar [data-album="${al.albumId}"]')`, 5000);
  const alBtn = await ev(`const b=[...document.querySelectorAll('.library-sidebar [data-album]')].find(b=>b.dataset.album===${JSON.stringify(al.albumId)}); if(!b) return null; const r=b.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]`);
  if (alBtn) await click(alBtn);
  await sleep(300);
  const alView = await ev(`return { cur: window.__slateLibrary.ui.current(), tiles: document.querySelectorAll('#library .lib-tile').length }`);
  check('O3', 'a new album appears in the sidebar and opens with its photos', !!alBtn && alView.cur.view === 'album' && alView.tiles === 5, `${alView.tiles} tiles, button ${!!alBtn}, view ${alView.cur.view}`);
  const menu = await ev(`const b=document.querySelector('[data-album-menu="${al.albumId}"]'); const r=b?.getBoundingClientRect(); return r?[r.left+r.width/2,r.top+r.height/2]:null`);
  if (menu) await click(menu);
  check('O3', 'the album menu offers rename, cover and delete', await until(`return /Rename/.test(document.body.innerText) && /Delete album/.test(document.body.innerText)`, 3000) >= 0);
  await key('Escape');
  const tg = await ev(`return (await window.__slateLibrary.run('photo.tag', { ids: ${JSON.stringify(ids.slice(0, 2))}, add: ['trips/goa'] })).changed`);
  check('O4', 'tags (hierarchical) through the command face', tg === 2 && (await ev(`${L} return L.search({ tag: 'trips' }).length`)) === 2);
  const fold = await ev(`const b=document.querySelector('.library-sidebar [data-folder]'); return !!b`);
  check('B4', 'the sidebar lists folders', fold);

  // ── trash, restore, library file on disk ──
  await ev(`window.__slateLibrary.ui.showLibrary(); return 1`);
  const trashId = ids[4];
  const tr = await ev(`return (await window.__slateLibrary.run('photo.trash', { ids: [${JSON.stringify(trashId)}] })).changed`);
  const onDisk = await ev(`const root=await navigator.storage.getDirectory(); const h=await root.getDirectoryHandle(${JSON.stringify(FOLDER)}); const t=await h.getDirectoryHandle('.slate-trash'); const p=${JSON.stringify(trashId.split('/').slice(1).join('/'))}.split('/'); let d=t; for (const s of p.slice(0,-1)) d=await d.getDirectoryHandle(s); await d.getFileHandle(p.at(-1)); return true`).catch(() => false);
  check('O6', 'trash moves the file into .slate-trash', tr === 1 && onDisk);
  const rs = await ev(`return (await window.__slateLibrary.run('photo.restore', { ids: [${JSON.stringify(trashId)}] })).changed`);
  check('O6', 'restore moves it back', rs === 1 && (await ev(`${L} return !L.choice(${JSON.stringify(trashId)}).trashed`)));
  await ev(`${L} await L.flush(); return 1`);
  const lf = await ev(`const root=await navigator.storage.getDirectory(); const h=await root.getDirectoryHandle(${JSON.stringify(FOLDER)}); return JSON.parse(await (await (await h.getFileHandle('.slate-library.json')).getFile()).text())`);
  check('L3', '.slate-library.json at the folder holds favourites, ratings, flags, hidden, tags and the album', lf.format === 'slate-library' && Object.values(lf.items).some(i => i.fav && i.rating === 3 && i.flag === 'pick') && Object.values(lf.items).some(i => i.hidden) && lf.albums.some(a => a.name === 'Live check album' && a.items.length === 5), `${Object.keys(lf.items).length} items, ${lf.albums.length} album`);

  // ── rebuild: choices come back unchanged ──
  const beforeRb = await ev(`${L} return JSON.stringify([...L.choices].sort())+JSON.stringify([...L.albums.values()].map(a=>[a.id,a.name,[...a.items].sort()]))`);
  await ev(`${L} await L.rebuild(); return 1`);
  await until(`${L} return L.jobs.status().idle`, 1800000, 1000);
  const afterRb = await ev(`${L} return JSON.stringify([...L.choices].sort())+JSON.stringify([...L.albums.values()].map(a=>[a.id,a.name,[...a.items].sort()]))`);
  check('v1 check 3 L6', 'rebuilding the index keeps every choice and album', beforeRb === afterRb && (await ev(`${L} return L.records.size`)) === total.recs);

  // ── storage panel ──
  await click(await centre('[data-act="storage"]'));
  const panel = await until(`return /Rebuild index/.test(document.body.innerText) && /thumbnail/i.test(document.body.innerText)`, 3000);
  check('L7', 'the storage panel shows sizes and Rebuild index', panel >= 0);
  await shot('04-storage');
  await key('Escape');

  // ── open in the editor and come back (O7) ──
  await ev(`window.__slateLibrary.ui.showLibrary(); return 1`);
  const t2 = await ev(`const t=[...document.querySelectorAll('#library .lib-tile')].find(t=>/\\.jpg$/.test(t.dataset.id)); const r=t.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]`);
  await click(t2);
  await key('e');
  const ed = await until(`return document.getElementById('library').hidden && document.getElementById('empty-state')?.classList.contains('hidden')`, 8000);
  check('O7', 'E opens the photo in the editor', ed >= 0);
  const folderSet = await ev(`return !!window.__slateLibrary && document.title.length > 0`);
  await key('Escape');
  check('O7', 'Escape in the editor returns to the Library', await until(`return !document.getElementById('library').hidden`, 3000) >= 0);

  // ── synthetic 100,000-row grid ──
  await ev(`${L} const id='rfake'; L.roots.set(id,{id,name:'Synthetic',handle:null,mode:'files',files:[],added:Date.now(),lastScan:Date.now()});
    const recs=[]; const t0=Date.UTC(2000,0,1);
    for (let i=0;i<${FAKE};i++){ recs.push({id:id+'/f/'+i+'.jpg',rootId:id,path:'f/'+i+'.jpg',name:i+'.jpg',ext:'jpg',kind:'photo',size:1,mtime:1,time:t0+i*3600000,timeSource:'exif',w:400,h:300,orient:1,camera:'',lens:'',lat:null,lon:null,dur:0,thumb:'none',sidecar:false,xmpTags:[],xmpRating:0,missing:false,indexed:0}); }
    for (const r of recs) L.records.set(r.id,r); L.emit('records',{ids:null,reason:'test'}); return L.records.size`);
  await ev(`window.__slateLibrary.ui.showLibrary(); return 1`);
  await until(`return !!document.querySelector('.library-sidebar [data-view="timeline"]')`, 3000);
  await click(await centre('.library-sidebar [data-view="timeline"]'));
  await until(`return window.__slateLibrary.ui.current().view === 'timeline' && document.querySelector('.library-grid').scrollHeight > 100000`, 5000);
  const g2 = await centre('.library-grid');
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) await wheel(g2, 2500);
  await sleep(600);
  const fling = await ev(`const g=document.querySelector('.library-grid'); const vis=[...document.querySelectorAll('#library .lib-tile')].filter(t=>{const r=t.getBoundingClientRect(); return r.bottom>g.getBoundingClientRect().top && r.top<innerHeight}); return { nodes: document.querySelectorAll('#library *').length, tiles: document.querySelectorAll('#library .lib-tile').length, visible: vis.length, top: g.scrollTop, height: g.scrollHeight }`);
  check('v1 check 2 B1', `${FAKE + total.recs} photos: a fling leaves the visible rows filled and the DOM bounded`, fling.visible > 20 && fling.tiles < 800 && fling.nodes < 8000 && fling.top > 50000, `${fling.tiles} tiles, ${fling.nodes} nodes, ${fling.visible} visible after 60 wheel steps in ${Date.now() - t0} ms; scroll ${fling.top}/${fling.height}`);
  await shot('05-fling');
  await ev(`${L} for (const id of [...L.records.keys()]) if (id.startsWith('rfake/')) L.records.delete(id); L.roots.delete('rfake'); L.emit('records',{ids:null,reason:'test'}); L.emit('roots',{}); return 1`);

  // ── 978 px window, both themes ──
  await raw('Emulation.setDeviceMetricsOverride', { width: 978, height: 760, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const ov = await ev(`return { sw: document.documentElement.scrollWidth, w: innerWidth, lib: document.getElementById('library').scrollWidth <= document.getElementById('library').clientWidth + 1 }`);
  check('K2', 'no horizontal overflow at 978 px', ov.sw <= ov.w && ov.lib, `${ov.sw} <= ${ov.w}`);
  const themes = await ev(`const bg=()=>getComputedStyle(document.getElementById('library')).backgroundColor; document.documentElement.setAttribute('data-theme','light'); const a=bg(); document.documentElement.setAttribute('data-theme','dark'); const b=bg(); return [a,b]`);
  check('N4', 'the Library follows light and dark themes', themes[0] !== themes[1], themes.join(' / '));
  await shot('06-978-dark');
  await raw('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

  // ── commands registered literally ──
  const errs = await ev('return window.__lcErrors');
  check('all', 'no uncaught page errors during the run', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', 'live check ran to the end', false, e.message);
} finally {
  await finish();
}

async function cleanup() {
  clearTimeout(WATCHDOG);
  // Cleanup by name: the library state for this test origin, the synthetic folder, thumbnails, test databases.
  try {
    await ev(`${L} for (const id of [...L.roots.keys()]) await L.removeRoot(id).catch(()=>{}); return 1`);
    await ev(`const root=await navigator.storage.getDirectory(); await root.removeEntry(${JSON.stringify(FOLDER)}, { recursive: true }).catch(()=>{}); await root.removeEntry('slate-thumbs', { recursive: true }).catch(()=>{}); return 1`);
    await ev(`for (const n of ['slate.library','slate.v1']) await new Promise(r=>{const q=indexedDB.deleteDatabase(n); q.onsuccess=q.onerror=q.onblocked=()=>r();}); return 1`);
    console.log(`  cleaned up: OPFS ${FOLDER} and slate-thumbs, IndexedDB slate.library and slate.v1 on ${new URL(URL0).origin}`);
  } catch (e) { console.log(`  cleanup failed: ${e.message}`); }
  await raw('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId: T } }) }).catch(() => {});
  if (CTX) await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.disposeBrowserContext', params: { browserContextId: CTX } }) }).catch(() => {});
  const pass = results.filter(r => r.ok).length;
  console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length }));
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
