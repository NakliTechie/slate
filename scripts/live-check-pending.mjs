#!/usr/bin/env node
// live-check-pending.mjs: the last pending items in Chrome over the CDP daemon: Background blur through
// image.lens_blur (the depth model downloads on first use), Extract text through image.extract_text, and
// Export as one .zip streamed into an OPFS file and read back. Synthetic inputs only; everything the run
// creates is deleted by name; the tab closes.
//
//   node scripts/live-check-pending.mjs --url http://127.0.0.1:8493/index.html

import { makeFolderJs } from './live-check-data.mjs';

const args = process.argv.slice(2);
const URL0 = (() => { const i = args.indexOf('--url'); return i >= 0 ? args[i + 1] : 'http://127.0.0.1:8493/index.html'; })();
const DAEMON = process.env.CDP_DAEMON || 'http://127.0.0.1:9334/';
const STAMP = Date.now().toString(36);
const F = { main: `slate-livecheck-p-${STAMP}`, zip: `slate-livecheck-pz-${STAMP}` };
const call = async (body) => (await fetch(DAEMON, { method: 'POST', body: JSON.stringify(body) })).text();
let T = null, CTX = null;
const raw = (method, params = {}) => call({ cmd: 'raw', t: T, text: JSON.stringify({ method, params }) });
const ev = async (js) => { const t = await call({ cmd: 'eval', t: T, js: `(async()=>JSON.stringify(await (async()=>{${js}})()))()` }); const v = JSON.parse(t); if (v && v.exc) throw new Error(v.exc); return v == null ? v : JSON.parse(v); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(js).catch(() => false)) return true; await sleep(250); } return false; };
const results = [];
const check = (rows, what, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${rows} ${what}${detail !== '' ? ` — ${detail}` : ''}`); };
const L = 'const S=window.__slateLibrary, L=S.lib;';

try {
  // Own browser context: other sessions' tab clean-ups cannot match this tab, and storage starts empty.
  CTX = JSON.parse(await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.createBrowserContext', params: {} }) })).browserContextId;
  T = JSON.parse(await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.createTarget', params: { url: `${URL0}?lc=${Date.now()}`, browserContextId: CTX } }) })).targetId;
  await raw('Target.activateTarget', { targetId: T }); await raw('Page.bringToFront');
  await raw('Page.enable'); await raw('Page.setWebLifecycleState', { state: 'active' }); await raw('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (!(await until('return !!window.__slateLibrary && !!window.__slate', 15000))) throw new Error('the library did not start');
  await ev(`localStorage.setItem('slate.v2.tour-complete','1'); localStorage.setItem('slate.download.ocr','1'); localStorage.setItem('slate.download.depth','1'); localStorage.setItem('slate.v2.library-tour-complete','1'); document.querySelector('.tour-skip')?.click(); return 1`);

  // ── Background blur: a near subject (large, low, warm) in front of a detailed far background ──
  await ev(`const c=new OffscreenCanvas(960,640); const g=c.getContext('2d');
    for (let y=0;y<640;y+=8) for (let x=0;x<960;x+=8) { g.fillStyle=((x+y)/8)%2?'#cfe3f5':'#6b8fb3'; g.fillRect(x,y,8,8*0.5); }
    const sky=g.createLinearGradient(0,0,0,640); sky.addColorStop(0,'rgba(120,170,220,.5)'); sky.addColorStop(1,'rgba(40,60,40,.2)'); g.fillStyle=sky; g.fillRect(0,0,960,640);
    g.fillStyle='#8a5a3c'; g.beginPath(); g.ellipse(480,520,180,240,0,0,7); g.fill(); g.fillStyle='#e8c4a0'; g.beginPath(); g.arc(480,300,90,0,7); g.fill();
    await __slate.openFromFile(new File([await c.convertToBlob({type:'image/png'})],'scene.png',{type:'image/png'})); return 1`);
  await until('return __slate.state.image.working?.width === 960');
  const t0 = Date.now();
  const lb = await ev(`${L} const w=()=>{ const c=__slate.state.image.working; return c.getContext('2d').getImageData(0,0,c.width,c.height).data; };
    const before=w(); const res=await S.run('image.lens_blur',{ x:0.5, y:0.47, strength:70 }); const after=w();
    const diff=(x0,y0,x1,y1)=>{ let s=0,n=0; for(let y=y0;y<y1;y+=3) for(let x=x0;x<x1;x+=3){ const i=(y*960+x)*4; s+=Math.abs(after[i]-before[i])+Math.abs(after[i+1]-before[i+1])+Math.abs(after[i+2]-before[i+2]); n++; } return s/n; };
    return { edits: res.edits, subject: diff(440,260,520,340), background: diff(20,20,200,120), hist: __slate.state.history.pointer }`);
  check('pending: lens blur', 'image.lens_blur downloads the depth model, blurs the far background and keeps the subject sharp', lb.edits >= 1 && lb.background > 3 * Math.max(1, lb.subject), `${JSON.stringify(lb)} in ${Math.round((Date.now() - t0) / 1000)} s`);
  const undo = await ev(`${L} await S.run('image.undo',{}); return __slate.state.history.pointer`);
  check('pending: lens blur', 'undo removes the blur', undo === lb.hist - 1, String(undo));

  // ── Extract text through the command ──
  await ev(`const c=new OffscreenCanvas(900,240); const g=c.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,900,240); g.fillStyle='#111'; g.font='bold 56px Helvetica, Arial'; g.fillText('Platform 9 Departures', 40, 140);
    await __slate.openFromFile(new File([await c.convertToBlob({type:'image/png'})],'sign.png',{type:'image/png'})); return 1`);
  await until('return __slate.state.image.working?.width === 900');
  const tx = await ev(`return await window.__slateLibrary.run('image.extract_text',{})`);
  check('N5', 'image.extract_text reads the printed words', /Platform\s+9\s+Departures/i.test(tx.text || ''), JSON.stringify(tx));

  // ── Export as one .zip, streamed into an OPFS file, then read back ──
  await ev(makeFolderJs({ name: F.main, count: 12, videos: 0 }));
  await ev(`${L} await S.addRoot(await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(F.main)})); return 1`);
  await until(`${L} return L.jobs.status().idle`, 30000);
  const zr = await ev(`${L} const z=await import(S.mods.ZIP_URL); z.configure?.({ useWebWorkers:false });
    const ids=L.search({ limit:5 }).slice(0,5).map(r=>r.id); const sizes=await Promise.all(ids.map(async id=>(await L.getFile(id)).size));
    const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(F.zip)},{create:true});
    const fh=await dir.getFileHandle('export.zip',{create:true}); const ws=await fh.createWritable();
    const res=await S.mods.exportZip(L, ids, { zipLib:z, writer: ws });
    const file=await fh.getFile(); const rd=new z.ZipReader(new z.BlobReader(file)); const entries=await rd.getEntries();
    const got=entries.map(e=>e.uncompressedSize).sort((a,b)=>a-b); await rd.close();
    return { res, bytes:file.size, entries:entries.length, same: JSON.stringify(got)===JSON.stringify(sizes.slice().sort((a,b)=>a-b)), stored: entries.filter(e=>e.compressedSize===e.uncompressedSize).length }`);
  check('I4', 'Export as one .zip streams the originals into a file; the zip reads back with the same files, JPEGs stored uncompressed', zr.entries === 5 && zr.same && zr.stored === 5, JSON.stringify(zr));
} catch (e) {
  check('run', 'pending check ran to the end', false, e.message);
} finally {
  try {
    await ev(`${L} for (const id of [...L.roots.keys()]) await L.removeRoot(id).catch(()=>{}); const r=await navigator.storage.getDirectory();
      for (const n of ${JSON.stringify(Object.values(F))}) await r.removeEntry(n,{recursive:true}).catch(()=>{}); await r.removeEntry('slate-thumbs',{recursive:true}).catch(()=>{});
      for (const n of ['slate.library','slate.v1']) await new Promise(res=>{const q=indexedDB.deleteDatabase(n); q.onsuccess=q.onerror=q.onblocked=()=>res();}); return 1`);
    console.log(`  cleaned up: OPFS ${Object.values(F).join(', ')} and slate-thumbs; IndexedDB slate.library and slate.v1`);
  } catch (e) { console.log('  cleanup failed', e.message); }
  await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId: T } }) }).catch(() => {});
  if (CTX) await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.disposeBrowserContext', params: { browserContextId: CTX } }) }).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length }));
  process.exit(pass === results.length ? 0 : 1);
}
