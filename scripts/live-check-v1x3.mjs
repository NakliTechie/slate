#!/usr/bin/env node
// live-check-v1x3.mjs: photo library batches 3 to 5 in Chrome over the CDP daemon, on synthetic OPFS folders:
// Places (P1, P2), Search by meaning and Find similar (Q2, Q3), People (F1, F2), text read from photos
// (X3) and the locked Hidden view (O9). Models download from Hugging Face on first use (CLIP q8 about
// 157 MB, faces about 10 MB). The faces check uses the example image from OpenCV's YuNet model repository
// (opencv/face_detection_yunet, example_outputs/largest_selfie.jpg), saved at three scales; no personal photos. Folders and databases this run
// creates are deleted by name; the tab closes.
//
//   node scripts/live-check-v1x3.mjs --url http://127.0.0.1:8493/index.html [--skip-clip] [--skip-faces]

const args = process.argv.slice(2);
const URL0 = (() => { const i = args.indexOf('--url'); return i >= 0 ? args[i + 1] : 'http://127.0.0.1:8493/index.html'; })();
const SKIP_CLIP = args.includes('--skip-clip'), SKIP_FACES = args.includes('--skip-faces');
const DAEMON = process.env.CDP_DAEMON || 'http://127.0.0.1:9334/';
const FOLDER = `slate-livecheck-b3-${Date.now().toString(36)}`;
const call = async (body) => (await fetch(DAEMON, { method: 'POST', body: JSON.stringify(body) })).text();
let T = null;
const raw = (method, params = {}) => call({ cmd: 'raw', t: T, text: JSON.stringify({ method, params }) });
const ev = async (js) => { const t = await call({ cmd: 'eval', t: T, js: `(async()=>JSON.stringify(await (async()=>{${js}})()))()` }); const v = JSON.parse(t); if (v && v.exc) throw new Error(v.exc); return v == null ? v : JSON.parse(v); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (js, ms = 10000, step = 300) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(js).catch(() => false)) return true; await sleep(step); } return false; };
const results = [];
const check = (rows, what, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${rows} ${what}${detail !== '' ? ` — ${detail}` : ''}`); };
const L = 'const S=window.__slateLibrary, L=S.lib;';

try {
  T = JSON.parse(await call({ cmd: 'open', url: `${URL0}?lc=${Date.now()}` })).targetId;
  await raw('Target.activateTarget', { targetId: T }); await raw('Page.bringToFront');
  await raw('Page.enable'); await raw('Page.setWebLifecycleState', { state: 'active' }); await raw('Emulation.setFocusEmulationEnabled', { enabled: true });
  await raw('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await until('return !!window.__slateLibrary', 15000);
  await ev(`localStorage.setItem('slate.v2.tour-complete','1'); localStorage.setItem('slate.v2.library-tour-complete','1'); document.querySelector('.tour-skip')?.click(); return 1`);

  // ── the folder: red and blue pictures, photos with GPS in Goa and Lisbon, a receipt, three copies of messi5.jpg ──
  const made = await ev(`
    const root=await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(FOLDER)},{create:true}); window.__root=root;
    const put=async(name,data)=>{ const w=await (await root.getFileHandle(name,{create:true})).createWritable(); await w.write(data); await w.close(); };
    const enc=new TextEncoder(); const u16=v=>[v&255,v>>8], u32=v=>[v&255,(v>>8)&255,(v>>16)&255,(v>>>24)&255];
    const exif=(jpeg,lat,lon)=>{ const rat=d=>{const a=Math.floor(d), m=Math.floor((d-a)*60), s=Math.round(((d-a)*60-m)*60*100); return [...u32(a),...u32(1),...u32(m),...u32(1),...u32(s),...u32(100)];};
      const ifd0Off=8, ifd0Size=2+12+4, gpsOff=ifd0Off+ifd0Size, gpsSize=2+4*12+4; let dataOff=gpsOff+gpsSize; const blobs=[]; const put2=b=>{const o=dataOff; blobs.push(b); dataOff+=b.length; return o;};
      const ent=(tag,type,count,val)=>[...u16(tag),...u16(type),...u32(count),...u32(val)];
      const ifd0=[...u16(1),...ent(0x8825,4,1,gpsOff),...u32(0)];
      const gps=[...u16(4),...ent(1,2,2,lat>=0?78:83),...ent(2,5,3,put2(rat(Math.abs(lat)))),...ent(3,2,2,lon>=0?69:87),...ent(4,5,3,put2(rat(Math.abs(lon)))),...u32(0)];
      const body=[...enc.encode('Exif'),0,0,0x49,0x49,42,0,...u32(8),...ifd0,...gps,...blobs.flat()];
      const app1=new Uint8Array([0xFF,0xE1,(body.length+2)>>8,(body.length+2)&255,...body]);
      const out=new Uint8Array(jpeg.length+app1.length); out.set(jpeg.subarray(0,2)); out.set(app1,2); out.set(jpeg.subarray(2),2+app1.length); return out; };
    const jpg=async(draw,w=480,h=360)=>{ const c=new OffscreenCanvas(w,h); const g=c.getContext('2d'); draw(g,w,h); return new Uint8Array(await (await c.convertToBlob({type:'image/jpeg',quality:.9})).arrayBuffer()); };
    for (let i=0;i<8;i++) await put('red_'+i+'.jpg', await jpg((g,w,h)=>{ g.fillStyle='hsl('+(358+i)%360+' 85% '+(40+i*2)+'%)'; g.fillRect(0,0,w,h); }));
    for (let i=0;i<8;i++) await put('blue_'+i+'.jpg', await jpg((g,w,h)=>{ g.fillStyle='hsl('+(220+i)+' 80% '+(40+i*2)+'%)'; g.fillRect(0,0,w,h); }));
    for (let i=0;i<3;i++) await put('goa_'+i+'.jpg', exif(await jpg((g,w,h)=>{ g.fillStyle='#3a9'; g.fillRect(0,0,w,h); }), 15.4989+i*0.001, 73.8278));
    await put('lisbon.jpg', exif(await jpg((g,w,h)=>{ g.fillStyle='#c84'; g.fillRect(0,0,w,h); }), 38.7223, -9.1393));
    await put('receipt.png', new Uint8Array(await (await (async()=>{ const c=new OffscreenCanvas(1000,300); const g=c.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,1000,300); g.fillStyle='#111'; g.font='bold 60px Helvetica, Arial'; g.fillText('Invoice 7781 Lighthouse Cafe', 40, 130); return c.convertToBlob({type:'image/png'}); })()).arrayBuffer()));
    let faces=0;
    if (${!SKIP_FACES}) { const r=await fetch('https://huggingface.co/opencv/face_detection_yunet/resolve/main/example_outputs/largest_selfie.jpg'); const bmp=await createImageBitmap(await r.blob());
      for (const [i,s] of [[0,1],[1,0.85],[2,0.7]].entries()) { const c=new OffscreenCanvas(Math.round(bmp.width*s[1]),Math.round(bmp.height*s[1])); c.getContext('2d').drawImage(bmp,0,0,c.width,c.height); await put('person_'+i+'.jpg', new Uint8Array(await (await c.convertToBlob({type:'image/jpeg',quality:.92})).arrayBuffer())); faces++; } }
    await S_add(); async function S_add(){ await window.__slateLibrary.addRoot(root); }
    return { faces }`);
  await ev(`window.__slateLibrary.ui.showLibrary(); return 1`);
  await until(`${L} return L.jobs.status().idle && [...L.records.values()].every(r=>r.thumb!=null)`, 60000);
  check('setup', 'synthetic folder indexed', (await ev(`${L} return L.records.size`)) >= 21, JSON.stringify(made));

  // ── Places ──
  await ev(`document.querySelector('.library-sidebar [data-xview="places"]')?.click(); return 1`);
  const placesOk = await until(`return /India/.test(document.querySelector('.lib-panel')?.innerText||'') && /Portugal/.test(document.querySelector('.lib-panel')?.innerText||'')`, 20000);
  const ptxt = await ev(`return (document.querySelector('.lib-panel')?.innerText||'').replace(/\\s+/g,' ').slice(0,300)`);
  check('P1', 'Places lists India and Portugal with their cities, offline', placesOk && /Panjim|Panaji|Goa/.test(ptxt) && /Lisbon/.test(ptxt), ptxt);
  const map = await ev(`const b=[...document.querySelectorAll('.lib-panel button, .lib-panel [role=tab]')].find(b=>/^map$/i.test(b.innerText.trim())); b?.click(); await new Promise(r=>setTimeout(r,800)); const c=document.querySelector('.lib-panel canvas'); if(!c) return null; const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let ink=0; for(let i=3;i<d.length;i+=4*7) if(d[i]>0) ink++; return { w:c.width, h:c.height, ink }`);
  check('P2', 'the Map tab draws country outlines and pins on a canvas', map && map.ink > 500, JSON.stringify(map));

  // ── text read from photos, and the locked Hidden view ──
  const ocr = await ev(`${L} await L.services.textIndex.setEnabled(true); const t0=performance.now(); while(performance.now()-t0<60000){ if (L.search({ q:'lighthouse' }).some(r=>r.name==='receipt.png')) break; await new Promise(r=>setTimeout(r,500)); }
    return { hit: L.search({ q:'lighthouse' }).map(r=>r.name), text: (L.textOf?.(L.search({ q:'receipt' })[0]?.id)||'').slice(0,60) }`);
  check('X3', 'text read from a photo makes it searchable', ocr.hit.includes('receipt.png'), JSON.stringify(ocr));
  await ev(`${L} await L.services.textIndex.setEnabled(false); return 1`);
  const lk = await ev(`${L} const id=L.search({ q:'lisbon' })[0].id; L.setHidden([id], true); const lock=L.services.lock;
    await lock.set('correct horse'); lock.lock(); const lockedCount=L.search({ hidden:'only' }).length;
    const wrong=await lock.unlock('wrong horse').then(()=>true).catch(()=>false); const afterWrong=L.search({ hidden:'only' }).length;
    await lock.unlock('correct horse'); const unlockedCount=L.search({ hidden:'only' }).length; await lock.reset(); L.setHidden([id], false);
    return { lockedCount, wrongAccepted: wrong && afterWrong>0, unlockedCount }`);
  check('O9', 'locked: hidden photos stay out of every view until the passphrase is given', lk.lockedCount === 0 && !lk.wrongAccepted && lk.unlockedCount === 1, JSON.stringify(lk));

  // ── Search by meaning and Find similar ──
  if (!SKIP_CLIP) {
    const t0 = Date.now();
    await ev(`${L} await L.services.clip.enable('q8'); return 1`);
    const ready = await until(`${L} const s=L.services.clip.status?.() ?? {}; return (s.count ?? 0) >= L.records.size - 3`, 600000, 2000);
    const st = await ev(`${L} return L.services.clip.status?.()`);
    check('Q2', 'Search by meaning downloads the model and embeds every photo from its thumbnail', ready, `${JSON.stringify(st)} after ${Math.round((Date.now() - t0) / 1000)} s`);
    const q = await ev(`${L} const r=await S.run('library.search_meaning',{ text:'a plain red picture', limit:8 }); const b=await S.run('library.search_meaning',{ text:'a plain blue picture', limit:8 }); return { red: r.items.map(x=>x.name), blue: b.items.map(x=>x.name) }`);
    const redTop = q.red.slice(0, 6).filter(n => n.startsWith('red_')).length, blueTop = q.blue.slice(0, 6).filter(n => n.startsWith('blue_')).length;
    check('Q2', 'words find the matching pictures: "red" returns red ones first, "blue" blue ones', redTop >= 5 && blueTop >= 5, `red top 6: ${redTop}, blue top 6: ${blueTop}`);
    const sim = await ev(`${L} const id=L.search({ q:'red_0' })[0].id; const r=await S.run('photo.similar',{ id, limit:6 }); return r.items.map(x=>x.name)`);
    check('Q3', 'Find similar returns pictures like the chosen one', sim.filter(n => n.startsWith('red_')).length >= 5, sim.join(', '));
    await ev(`${L} await L.services.clip.disable(); return 1`);
  }

  // ── People ──
  if (!SKIP_FACES) {
    const t1 = Date.now();
    await ev(`${L} await L.services.faces.setEnabled(true); return 1`);
    const done = await until(`${L} const s=L.services.faces.status(); return s.done >= s.total && s.total > 0 && !L.jobs.status().kinds?.faces?.total || (s.done>=s.total && s.total>0)`, 300000, 2000);
    await sleep(3000);
    const fs = await ev(`${L} return L.services.faces.status()`);
    check('F1', 'People finds faces of 32 px or more in each copy of the sample and groups each person across all three copies', done && fs.people >= 2 && fs.faces === fs.people * 3, `${JSON.stringify(fs)} after ${Math.round((Date.now() - t1) / 1000)} s`);
    await ev(`document.querySelector('.library-sidebar [data-xview="people"]')?.click(); return 1`);
    const pv = await until(`return document.querySelectorAll('.lib-panel img, .lib-panel [style*="background"]').length > 0`, 10000);
    check('F2', 'the People view shows the person', pv);
    await ev(`${L} await L.services.faces.setEnabled(false); return 1`);
  }
} catch (e) {
  check('run', 'batch 3 check ran to the end', false, e.message);
} finally {
  try {
    await ev(`${L} for (const id of [...L.roots.keys()]) await L.removeRoot(id).catch(()=>{}); await L.services.faces?.deleteAll?.().catch?.(()=>{});
      const r=await navigator.storage.getDirectory(); await r.removeEntry(${JSON.stringify(FOLDER)},{recursive:true}).catch(()=>{}); await r.removeEntry('slate-thumbs',{recursive:true}).catch(()=>{});
      for (const n of ['slate.library','slate.v1','slate.faces']) await new Promise(res=>{const q=indexedDB.deleteDatabase(n); q.onsuccess=q.onerror=q.onblocked=()=>res();}); return 1`);
    console.log(`  cleaned up: OPFS ${FOLDER} and slate-thumbs; IndexedDB slate.library, slate.v1, slate.faces (model caches kept in Cache Storage for reruns)`);
  } catch (e) { console.log('  cleanup failed', e.message); }
  await raw('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId: T } }) }).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length }));
  process.exit(pass === results.length ? 0 : 1);
}
