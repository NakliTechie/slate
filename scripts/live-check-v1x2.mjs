#!/usr/bin/env node
// live-check-v1x2.mjs: photo library batch 2 in Chrome over the CDP daemon, on synthetic OPFS folders:
// editor commands on the real editor (N5), stacks (B9), a Google Motion Photo built here (M6), an Apple
// Live Photo pair (M7), move and rename with undo (O10), iCloud export CSV details (I5), and folder
// watching with FileSystemObserver (L9). WebMCP (N6) is checked only when the browser offers it.
// Folders and databases are deleted by name at the end; the tab closes.
//
//   node scripts/live-check-v1x2.mjs --url http://127.0.0.1:8493/index.html

const args = process.argv.slice(2);
const URL0 = (() => { const i = args.indexOf('--url'); return i >= 0 ? args[i + 1] : 'http://127.0.0.1:8493/index.html'; })();
const DAEMON = process.env.CDP_DAEMON || 'http://127.0.0.1:9334/';
const FOLDER = `slate-livecheck-b2-${Date.now().toString(36)}`;
const call = async (body) => (await fetch(DAEMON, { method: 'POST', body: JSON.stringify(body) })).text();
let T = null;
const raw = (method, params = {}) => call({ cmd: 'raw', t: T, text: JSON.stringify({ method, params }) });
const ev = async (js) => { const t = await call({ cmd: 'eval', t: T, js: `(async()=>JSON.stringify(await (async()=>{${js}})()))()` }); const v = JSON.parse(t); if (v && v.exc) throw new Error(v.exc); return v == null ? v : JSON.parse(v); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(js).catch(() => false)) return true; await sleep(200); } return false; };
const results = [];
const check = (rows, what, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${rows} ${what}${detail !== '' ? ` — ${detail}` : ''}`); };
const L = 'const S=window.__slateLibrary, L=S.lib;';

// Page-side helpers: write a file into the test folder; make a JPEG; record a short MP4.
const HELPERS = `
  window.__root = await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(FOLDER)}, { create: true });
  window.__put = async (path, data) => { const parts=path.split('/'); const name=parts.pop(); let d=__root; for (const p of parts) d=await d.getDirectoryHandle(p,{create:true}); const w=await (await d.getFileHandle(name,{create:true})).createWritable(); await w.write(data); await w.close(); };
  window.__jpeg = async (hue) => { const c=new OffscreenCanvas(480,360); const g=c.getContext('2d'); g.fillStyle='hsl('+hue+' 60% 50%)'; g.fillRect(0,0,480,360); g.fillStyle='#fff'; g.fillRect(40,40,120,120); return new Uint8Array(await (await c.convertToBlob({type:'image/jpeg',quality:.85})).arrayBuffer()); };
  window.__exif = (jpeg, date, make) => { // insert a minimal EXIF APP1 with DateTimeOriginal and Make
    const enc=new TextEncoder(); const u16=v=>[v&255,v>>8], u32=v=>[v&255,(v>>8)&255,(v>>16)&255,(v>>>24)&255];
    const dt=[...enc.encode(date),0], mk=[...enc.encode(make),0];
    const ifd0Off=8, ifd0Size=2+2*12+4, exifOff=ifd0Off+ifd0Size, exifSize=2+12+4; let dataOff=exifOff+exifSize; const blobs=[]; const put=b=>{const o=dataOff; blobs.push(b); dataOff+=b.length; return o;};
    const ent=(tag,type,count,val)=>[...u16(tag),...u16(type),...u32(count),...u32(val)];
    const ifd0=[...u16(2),...ent(0x010F,2,mk.length,put(mk)),...ent(0x8769,4,1,exifOff),...u32(0)];
    const exif=[...u16(1),...ent(0x9003,2,dt.length,put(dt)),...u32(0)];
    const body=[...enc.encode('Exif'),0,0,0x49,0x49,42,0,...u32(8),...ifd0,...exif,...blobs.flat()];
    const app1=new Uint8Array([0xFF,0xE1,(body.length+2)>>8,(body.length+2)&255,...body]);
    const out=new Uint8Array(jpeg.length+app1.length); out.set(jpeg.subarray(0,2)); out.set(app1,2); out.set(jpeg.subarray(2),2+app1.length); return out; };
  window.__mp4 = async () => { const c=document.createElement('canvas'); c.width=320; c.height=240; const g=c.getContext('2d');
    const type=['video/mp4;codecs=avc1','video/mp4'].find(t=>MediaRecorder.isTypeSupported(t)); if(!type) return null;
    const rec=new MediaRecorder(c.captureStream(15),{mimeType:type}); const chunks=[]; rec.ondataavailable=e=>chunks.push(e.data); const stopped=new Promise(r=>rec.onstop=r); rec.start();
    const tEnd=performance.now()+1200; while(performance.now()<tEnd){ g.fillStyle='hsl('+((performance.now()/4)%360)+' 70% 50%)'; g.fillRect(0,0,320,240); await new Promise(r=>setTimeout(r,60)); }
    rec.stop(); await stopped; return new Uint8Array(await new Blob(chunks).arrayBuffer()); };
  return 1`;

try {
  T = JSON.parse(await call({ cmd: 'open', url: `${URL0}?lc=${Date.now()}` })).targetId;
  await raw('Target.activateTarget', { targetId: T }); await raw('Page.bringToFront');
  await raw('Page.enable'); await raw('Page.setWebLifecycleState', { state: 'active' }); await raw('Emulation.setFocusEmulationEnabled', { enabled: true });
  await raw('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await until('return !!window.__slateLibrary && !!window.__slate', 15000);
  await ev(`localStorage.setItem('slate.v2.tour-complete','1'); localStorage.setItem('slate.v2.library-tour-complete','1'); document.querySelector('.tour-skip')?.click(); return 1`);
  await ev(HELPERS);

  // ── files: a Slate edit beside its original, a burst, a Motion Photo, a Live Photo pair ──
  const made = await ev(`
    await __put('trip/beach.jpg', __exif(await __jpeg(200), '2024:03:01 10:00:00', 'Google'));
    await __put('trip/beach-240302101500.jpg', __exif(await __jpeg(210), '2024:03:01 10:00:00', 'Google'));
    for (let i=0;i<3;i++) await __put('trip/burst_'+i+'.jpg', __exif(await __jpeg(30+i*5), '2024:03:02 09:00:0'+i, 'Canon'));
    const mp4 = await __mp4(); if (!mp4) return { mp4: false };
    const jpeg = __exif(await __jpeg(120), '2024:03:03 18:00:00', 'Google');
    const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="'+mp4.length+'"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>';
    const enc=new TextEncoder(); const body=[...enc.encode('http://ns.adobe.com/xap/1.0/'),0,...enc.encode(xmp)];
    const app1=new Uint8Array([0xFF,0xE1,(body.length+2)>>8,(body.length+2)&255,...body]);
    const mp=new Uint8Array(jpeg.length+app1.length+mp4.length); mp.set(jpeg.subarray(0,2)); mp.set(app1,2); mp.set(jpeg.subarray(2),2+app1.length); mp.set(mp4, jpeg.length+app1.length);
    await __put('trip/PXL_20240303_motion.jpg', mp);
    await __put('trip/IMG_9001.jpg', __exif(await __jpeg(300), '2024:03:04 12:00:00', 'Apple'));
    await __put('trip/IMG_9001.mov', mp4);
    return { mp4: mp4.length }`);
  check('setup', 'synthetic files written (a short MP4 recorded in Chrome)', !!made.mp4, JSON.stringify(made));
  await ev(`${L} await S.addRoot(__root); S.ui.showLibrary(); return 1`);
  await until(`${L} return L.jobs.status().idle && [...L.records.values()].every(r=>r.thumb!=null)`, 60000);

  const recs = await ev(`${L} return [...L.records.values()].map(r=>({ n:r.name, motion:r.motion||null, live:r.liveVideo||null, kind:r.kind }))`);
  const mo = recs.find(r => r.n === 'PXL_20240303_motion.jpg');
  check('M6', 'a Google Motion Photo is recognised and its video located', mo?.motion?.length === made.mp4, JSON.stringify(mo?.motion));
  const live = recs.find(r => r.n === 'IMG_9001.jpg');
  check('M7', 'an Apple Live Photo pairs with its MOV, and the MOV gets no tile of its own', live?.live === 'trip/IMG_9001.mov' && !recs.some(r => r.n === 'IMG_9001.mov'), JSON.stringify(live));

  // the viewer plays the motion part
  await ev(`window.__slateLibrary.ui.select([[...window.__slateLibrary.lib.records.values()].find(r=>r.name==='PXL_20240303_motion.jpg').id]); return 1`);
  await raw('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await raw('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const vopen = await until(`return !document.querySelector('.lib-viewer').hidden`, 5000);
  const vstate = await ev(`return { open: ${vopen}, vis: document.visibilityState, buttons: [...document.querySelectorAll('.lib-viewer button')].map(b=>(b.getAttribute('aria-label')||b.innerText).trim()).slice(0,10) }`);
  const vplay = await ev(`const b=[...document.querySelectorAll('.lib-viewer button')].find(b=>/play|motion|live/i.test(b.innerText+' '+(b.getAttribute('aria-label')||''))); b?.click();
    const t0=performance.now(); let v; while(performance.now()-t0<6000){ v=document.querySelector('.lib-viewer video'); if (v && v.readyState>=2) break; await new Promise(r=>setTimeout(r,100)); }
    return v ? { ready:v.readyState, dur:v.duration, src: v.src.slice(0,5) } : null`);
  check('M6', 'the viewer plays the embedded video', vplay && vplay.ready >= 2 && vplay.dur > 0.5, JSON.stringify(vplay) + ' ' + JSON.stringify(vstate));
  await raw('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await raw('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  // ── stacks ──
  const st = await ev(`${L} const { stacks }=S.mods.buildStacks(L.search({})); const tiles=document.querySelectorAll('#library .lib-tile').length;
    return { kinds: stacks.map(s=>s.kind+':'+s.members.length), tiles, recs: L.search({}).length }`);
  check('B9', 'an edit beside its original and a three-shot burst stack into fewer tiles', st.tiles < st.recs && st.kinds.length >= 2, JSON.stringify(st));

  // ── move and rename, with dry run and undo ──
  const mv = await ev(`${L} const r=L.search({ q:'beach.jpg' }).find(r=>r.name==='beach.jpg'); L.setFavourite([r.id], true);
    const dry=await S.run('photo.move',{ moves:[{ id:r.id, toPath:'best/beach.jpg' }], dryRun:true });
    const res=await S.run('photo.move',{ moves:[{ id:r.id, toPath:'best/beach.jpg' }] });
    const moved=L.search({ q:'beach.jpg' }).find(x=>x.path==='best/beach.jpg');
    let onDisk=false; try { await (await __root.getDirectoryHandle('best')).getFileHandle('beach.jpg'); onDisk=true; } catch {}
    const fav=moved && L.choice(moved.id).fav;
    await S.run('library.undo',{ token: res.undo });
    let back=false; try { await (await __root.getDirectoryHandle('trip')).getFileHandle('beach.jpg'); back=true; } catch {}
    return { dry, changed: res.changed, onDisk, fav, back }`);
  check('O10', 'move: dry run, move with the favourite kept, undo moves it back', mv.dry?.dryRun && mv.changed === 1 && mv.onDisk && mv.fav && mv.back, JSON.stringify(mv));
  const rn = await ev(`${L} const ids=L.search({ q:'burst' }).map(r=>r.id); const res=await S.run('photo.rename',{ ids, template:'{date} burst {n}' }); const names=L.search({ q:'burst' }).map(r=>r.name).sort(); await S.run('library.undo',{ token: res.undo }); return { changed: res.changed, names, after: L.search({ q:'burst' }).map(r=>r.name).sort() }`);
  check('O10', 'rename from a template, then undo', rn.changed === 3 && rn.names.every(n => /^2024-03-02 burst \d+\.jpg$/.test(n)) && rn.after.every(n => /^burst_\d\.jpg$/.test(n)), JSON.stringify(rn));

  // ── iCloud CSV details ──
  const ic = await ev(`${L} const root=[...L.roots.values()][0];
    const details='imgName,fileChecksum,favorite,hidden,deleted,originalCreationDate,importDate\\nIMG_9001.jpg,abc,yes,no,no,"Monday March 4,2024 12:00 PM GMT",\\nburst_0.jpg,def,no,yes,no,,\\n';
    const album='Images\\nIMG_9001.jpg\\nburst_1.jpg\\n';
    const res=await S.mods.applyICloudCsv(L, root.id, [{ name:'Photo Details.csv', text: details }, { name:'Lisbon 2024.csv', text: album }]);
    const id=n=>L.search({ hidden:'include' }).find(r=>r.name===n)?.id;
    return { res: { changed: res.changed }, fav: L.choice(id('IMG_9001.jpg')).fav, hidden: L.choice(id('burst_0.jpg')).hidden, album: [...L.albums.values()].find(a=>a.name==='Lisbon 2024')?.items.size }`);
  check('I5', 'iCloud export CSVs set favourites, hidden and an album named after the CSV', ic.fav && ic.hidden && ic.album === 2, JSON.stringify(ic));

  // ── folder watching ──
  const ws = await ev(`return window.__slateLibrary.lib.services.watch?.status?.()`);
  if (ws === 'watching') {
    await ev(`await __put('trip/added_later.jpg', __exif(await __jpeg(90), '2024:03:05 08:00:00', 'Google')); return 1`);
    const seen = await until(`${L} return L.search({ q:'added_later' }).length === 1`, 15000);
    check('L9', 'a file added to a watched folder appears without a rescan', seen);
  } else {
    check('L9', 'FileSystemObserver unavailable in this Chrome: the storage panel says the Library rescans on open', ws === 'unavailable', String(ws));
  }

  // ── editor commands on the real editor ──
  const ed = await ev(`${L} const id=L.search({ q:'IMG_9001' })[0].id; await S.run('image.open',{ id }); const t0=performance.now(); while(!(window.__slate.state.image.working) && performance.now()-t0<8000) await new Promise(r=>setTimeout(r,100));
    const info0=await S.run('image.info',{}); await S.run('image.rotate',{ deg:90 }); await S.run('image.adjust',{ exposure:20, contrast:10, saturation:0 });
    const info1=await S.run('image.info',{}); await S.run('image.undo',{}); const info2=await S.run('image.info',{}); const snap=await S.run('image.snapshot',{});
    return { w0:info0.width??info0.w, h0:info0.height??info0.h, w1:info1.width??info1.w, h1:info1.height??info1.h, hist1: info1.edits, hist2: info2.edits, snap: (snap.dataUrl||'').slice(0,23), snapLen:(snap.dataUrl||'').length }`);
  check('N5', 'editor commands rotate, adjust, undo and snapshot the open photo through the editor', ed.w1 === ed.h0 && ed.h1 === ed.w0 && ed.hist2 === ed.hist1 - 1 && ed.snap.startsWith('data:image/jpeg') && ed.snapLen < 256000, JSON.stringify(ed));
  await raw('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await raw('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  const wm = await ev(`return !!navigator.modelContext?.registerTool`);
  console.log(`  N6 WebMCP: ${wm ? 'navigator.modelContext present (not driven)' : 'navigator.modelContext absent in this Chrome; registration is covered by tests/test-editor-commands.mjs'}`);
} catch (e) {
  check('run', 'batch 2 check ran to the end', false, e.message);
} finally {
  try {
    await ev(`${L} for (const id of [...L.roots.keys()]) await L.removeRoot(id).catch(()=>{}); const r=await navigator.storage.getDirectory(); await r.removeEntry(${JSON.stringify(FOLDER)},{recursive:true}).catch(()=>{}); await r.removeEntry('slate-thumbs',{recursive:true}).catch(()=>{});
      for (const n of ['slate.library','slate.v1']) await new Promise(res=>{const q=indexedDB.deleteDatabase(n); q.onsuccess=q.onerror=q.onblocked=()=>res();}); return 1`);
    console.log(`  cleaned up: OPFS ${FOLDER} and slate-thumbs; IndexedDB slate.library and slate.v1`);
  } catch (e) { console.log('  cleanup failed', e.message); }
  await raw('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId: T } }) }).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length }));
  process.exit(pass === results.length ? 0 : 1);
}
