#!/usr/bin/env node
// live-check-recipe.mjs: the embedded edit list, in Chrome over the CDP daemon.
// Opens a synthetic image, crops and adjusts it, exports PNG and JPEG with "Embed the edit list" on
// (downloads are captured in memory, never written to the Downloads folder), reopens each export,
// checks Image Info lists the edits, then applies them to a second image with Ctrl+Shift+V.
//
//   node scripts/live-check-recipe.mjs --url http://127.0.0.1:8493/index.html

const args = process.argv.slice(2);
const URL0 = (() => { const i = args.indexOf('--url'); return i >= 0 ? args[i + 1] : 'http://127.0.0.1:8493/index.html'; })();
const DAEMON = process.env.CDP_DAEMON || 'http://127.0.0.1:9334/';
const call = async (body) => (await fetch(DAEMON, { method: 'POST', body: JSON.stringify(body) })).text();
let T = null;
const raw = (method, params = {}) => call({ cmd: 'raw', t: T, text: JSON.stringify({ method, params }) });
const ev = async (js) => {
  const t = await call({ cmd: 'eval', t: T, js: `(async()=>JSON.stringify(await (async()=>{${js}})()))()` });
  const v = JSON.parse(t); if (v && v.exc) throw new Error(v.exc);
  return v == null ? v : JSON.parse(v);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(js).catch(() => false)) return true; await sleep(100); } return false; };
const results = [];
const check = (rows, what, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${rows} ${what}${detail !== '' ? ` — ${detail}` : ''}`); };
async function key(k, mods = 0, code, vk) {
  await raw('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await raw('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(150);
}

const MAKE = (name, hue) => `const c=new OffscreenCanvas(400,300); const g=c.getContext('2d'); g.fillStyle='hsl(${hue} 60% 50%)'; g.fillRect(0,0,400,300); g.fillStyle='#fff'; g.fillRect(50,50,100,100);
  return new File([await c.convertToBlob({type:'image/png'})], '${name}', {type:'image/png'});`;

try {
  T = JSON.parse(await call({ cmd: 'open', url: `${URL0}?lc=${Date.now()}` })).targetId;
  await raw('Target.activateTarget', { targetId: T }); await raw('Page.bringToFront');
  await raw('Page.enable'); await raw('Page.setWebLifecycleState', { state: 'active' }); await raw('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until('return !!window.__slate', 15000);
  await ev(`try{localStorage.setItem('slate.v2.tour-complete','1')}catch{} document.querySelector('.tour-skip')?.click();
    window.__dl=[]; const oc=URL.createObjectURL; URL.createObjectURL=(b)=>{ const u=oc(b); window.__lastBlob=b; return u; };
    HTMLAnchorElement.prototype.click=function(){ if(this.download){ __dl.push({name:this.download, blob:window.__lastBlob}); return; } };
    window.__waitPtr=async(p)=>{ const t0=performance.now(); while(__slate.state.history.pointer!==p && performance.now()-t0<8000) await new Promise(r=>setTimeout(r,50)); };
    return 1`);
  await ev(`const f=await (async()=>{${MAKE('first.png', 200)}})(); await __slate.openFromFile(f); return 1`);
  await until('return __slate.state.image.working?.width === 400');
  await ev(`__slate.emit('op:adjust',{brightness:40,contrast:20,saturation:30}); await __waitPtr(0);
    __slate.state.selection.shape='rect'; Object.assign(__slate.state.selection,{x:10,y:20,w:300,h:200}); __slate.emit('op:crop',null); await __waitPtr(1); return __slate.state.history.pointer`);
  check('setup', 'two edits (adjust, crop) on the first image', (await ev('return __slate.state.history.pointer')) === 1);

  for (const fmt of ['png', 'jpeg']) {
    const got = await ev(`Object.assign(__slate.state.export,{format:'${fmt}', saveMode:'download', embedEdits:true}); __dl.length=0;
      __slate.emit('save:request',{dialog:false}); const t0=performance.now(); while(!__dl.length && performance.now()-t0<8000) await new Promise(r=>setTimeout(r,50));
      const d=__dl[0]; if(!d) return null; window.__exported=new File([d.blob], d.name, {type:d.blob.type}); return { name:d.name, size:d.blob.size }`);
    check('pending: edits in exports', `a ${fmt.toUpperCase()} export with "Embed the edit list" downloads`, !!got, got && `${got.name}, ${got.size} bytes`);
    await ev(`await __slate.openFromFile(__exported); return 1`);
    const rec = await ev(`const t0=performance.now(); while(!__slate.state.image.recipe && performance.now()-t0<5000) await new Promise(r=>setTimeout(r,50)); return __slate.state.image.recipe`);
    check('pending: edits in exports', `reopening the ${fmt.toUpperCase()} reads the edit list`, rec?.ops?.map(o => o.op).join(',') === 'adjust,crop', rec ? rec.ops.map(o => o.op).join(',') : 'none');
    // re-apply the same edits on the original for the next format
    await ev(`const f=await (async()=>{${MAKE('first.png', 200)}})(); await __slate.openFromFile(f);
      __slate.emit('op:adjust',{brightness:40,contrast:20,saturation:30}); await __waitPtr(0);
      __slate.state.selection.shape='rect'; Object.assign(__slate.state.selection,{x:10,y:20,w:300,h:200}); __slate.emit('op:crop',null); await __waitPtr(1); return 1`);
  }

  // Image Info shows the list and copies it; Ctrl+Shift+V applies it to another image.
  await ev(`await __slate.openFromFile(__exported); const t0=performance.now(); while(!__slate.state.image.recipe && performance.now()-t0<5000) await new Promise(r=>setTimeout(r,50));
    document.getElementById('info-panel').classList.remove('hidden'); __slate.emit('image:loaded', null); return 1`);
  const info = await ev(`return document.getElementById('info-panel').innerText`);
  check('pending: edits in exports', 'Image Info says "Edited in Slate" with the edits', /Edited in Slate/.test(info) && /adjust, crop/.test(info));
  await ev(`document.getElementById('info-apply-recipe').click(); return 1`);
  await ev(`const f=await (async()=>{${MAKE('second.png', 30)}})(); await __slate.openFromFile(f); return 1`);
  await until('return __slate.state.image.working?.width === 400 && __slate.state.history.pointer === -1');
  await ev(`document.activeElement?.blur(); return 1`);
  await key('V', 4 | 8, 'KeyV', 86);
  await until('return __slate.state.history.pointer === 1', 8000);
  const applied = await ev(`return { p: __slate.state.history.pointer, w: __slate.state.image.working.width, h: __slate.state.image.working.height }`);
  check('pending: edits in exports', 'Ctrl+Shift+V applies the copied edits to another image (crop to 300 x 200, two undo steps)', applied.p === 1 && applied.w === 300 && applied.h === 200, JSON.stringify(applied));
  const off = await ev(`Object.assign(__slate.state.export,{format:'png', embedEdits:false}); __dl.length=0; __slate.emit('save:request',{dialog:false});
    const t0=performance.now(); while(!__dl.length && performance.now()-t0<8000) await new Promise(r=>setTimeout(r,50)); await __slate.openFromFile(new File([__dl[0].blob],'x.png',{type:'image/png'})); await new Promise(r=>setTimeout(r,500)); return __slate.state.image.recipe`);
  check('pending: edits in exports', 'with the setting off (the default), an export carries no edit list', off === null);
} catch (e) {
  check('run', 'recipe check ran to the end', false, e.message);
} finally {
  await ev(`for (const n of ['slate.library','slate.v1']) await new Promise(r=>{const q=indexedDB.deleteDatabase(n); q.onsuccess=q.onerror=q.onblocked=()=>r();}); return 1`).catch(() => {});
  await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId: T } }) }).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length }));
  process.exit(pass === results.length ? 0 : 1);
}
