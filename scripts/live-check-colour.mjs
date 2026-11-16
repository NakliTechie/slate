#!/usr/bin/env node
// live-check-colour.mjs: the linear-light Adjust and the .cube LUT op in Chrome over the CDP daemon.
// It opens a synthetic 1,200 x 1,000 image (above the 1-megapixel WebGPU threshold), applies Adjust through
// the editor's own op path, and compares the result with the CPU maths (src/ops/colour.js) pixel by pixel.
// Then it applies a LUT through the op path, undoes it, and drives the Adjust dialog's controls.
//
//   node scripts/live-check-colour.mjs --url http://127.0.0.1:8493/index.html

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

const IMG = `const c=new OffscreenCanvas(1200,1000); const g=c.getContext('2d');
  const gr=g.createLinearGradient(0,0,1200,0); gr.addColorStop(0,'#000'); gr.addColorStop(.5,'#c84'); gr.addColorStop(1,'#fff');
  g.fillStyle=gr; g.fillRect(0,0,1200,500);
  for(let i=0;i<12;i++){ g.fillStyle='hsl('+(i*30)+' 80% 50%)'; g.fillRect(i*100,500,100,500); }
  const blob=await c.convertToBlob({type:'image/png'}); window.__lcFile=new File([blob],'colour-test.png',{type:'image/png'});`;
const PIX = `return __pix()`;

try {
  T = JSON.parse(await call({ cmd: 'open', url: `${URL0}?lc=${Date.now()}` })).targetId;
  await raw('Target.activateTarget', { targetId: T });
  await raw('Page.enable'); await raw('Page.setWebLifecycleState', { state: 'active' }); await raw('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until('return !!window.__slate', 15000);
  await ev(`window.__pix=()=>{ const w=__slate.state.image.working; return Array.from(w.getContext('2d').getImageData(0,0,w.width,w.height).data); }; window.__lcWarn=[]; const w0=console.warn; console.warn=(...a)=>{__lcWarn.push(a.join(' ')); w0(...a)}; window.__lcErr=[]; addEventListener('error',e=>__lcErr.push(String(e.message))); return 1`);
  await ev(`try{localStorage.setItem('slate.v2.tour-complete','1')}catch{} document.querySelector('.tour-skip')?.click(); return 1`);
  await ev(`${IMG} await __slate.openFromFile(__lcFile); return 1`);
  check('setup', 'a 1,200 x 1,000 synthetic image opens in the editor', await until(`return __slate.state.image.working?.width === 1200`));
  const gpu = await ev(`return !!navigator.gpu && !!(await navigator.gpu.requestAdapter())`);
  const P = { brightness: 50, contrast: 30, saturation: 40 };
  const res = await ev(`const before=__pix(); const W=__slate.state.image.working;
    const expect=__slate.ops.adjustPixels(new Uint8ClampedArray(before), ${JSON.stringify(P)});
    const h0=__slate.state.history.pointer;
    __slate.emit('op:adjust', ${JSON.stringify(P)});
    const t0=performance.now(); while(__slate.state.history.pointer===h0 && performance.now()-t0<10000) await new Promise(r=>setTimeout(r,50));
    const after=__pix();
    let max=0, n=0; for(let i=0;i<after.length;i++){ if(i%4===3) continue; const d=Math.abs(after[i]-expect[i]); if(d>max) max=d; if(d>1) n++; }
    let changed=0; for(let i=0;i<after.length;i+=4){ if(after[i]!==before[i]) changed++; }
    return { max, n, changed, px: after.length/4, ms: Math.round(performance.now()-t0) }`);
  check('pending: linear light', `Adjust through the editor matches the CPU linear-light maths (${gpu ? 'WebGPU path' : 'CPU path; no WebGPU adapter'})`, res.max <= 2 && res.changed > res.px / 2, `max channel difference ${res.max}, ${res.n} channels off by more than 1, ${res.changed} of ${res.px} pixels changed, ${res.ms} ms`);
  const warns = await ev(`return __lcWarn.filter(w=>/WebGPU/.test(w))`);
  check('pending: linear light', 'the WebGPU path ran without falling back to the CPU', !gpu || warns.length === 0, warns.join(' | ') || (gpu ? 'no fallback warning' : 'no adapter'));

  // LUT through the op path: a channel swap (red <-> blue) at 100%, then undo
  const cube = 'TITLE "swap"\nLUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n';
  const lut = await ev(`const before=__pix(); const L=__slate.ops.parseCube(${JSON.stringify(cube)});
    const h0=__slate.state.history.pointer;
    __slate.emit('op:lut', { name:'swap.cube', title:L.title, size:L.size, min:L.min, max:L.max, data:L.data, strength:100 });
    const t0=performance.now(); while(__slate.state.history.pointer===h0 && performance.now()-t0<10000) await new Promise(r=>setTimeout(r,50));
    const after=__pix();
    let bad=0; for(let i=0;i<after.length;i+=4){ if(Math.abs(after[i]-before[i+2])>1 || Math.abs(after[i+2]-before[i])>1) bad++; }
    __slate.emit('history:undo', null);
    const t1=performance.now(); while(__slate.state.history.pointer!==h0 && performance.now()-t1<10000) await new Promise(r=>setTimeout(r,50));
    await new Promise(r=>setTimeout(r,200));
    const undone=__pix(); let diff=0; for(let i=0;i<undone.length;i++) if(undone[i]!==before[i]) diff++;
    return { bad, diff }`);
  check('pending: LUT', 'a .cube LUT applies through the op path (red and blue swapped on every pixel)', lut.bad === 0, `${lut.bad} pixels off`);
  check('pending: LUT', 'undo removes the LUT exactly', lut.diff === 0, `${lut.diff} channels differ after undo`);

  // The Adjust dialog shows Exposure, the LUT loader and the strength slider
  await ev(`__slate.emit('modal:adjust', null); return 1`);
  const dlg = await ev(`const d=document.getElementById('modal-adjust'); return d && d.open ? d.innerText : null`);
  check('pending: UI', 'the Adjust dialog offers Exposure, Look (LUT) and Look strength', !!dlg && /Exposure/.test(dlg) && /Look \(LUT\)/.test(dlg) && /Look strength/.test(dlg));
  await ev(`document.getElementById('modal-adjust')?.close(); return 1`);
  const errs = await ev(`return (window.__lcErr||[])`);
  check('all', 'no page errors', errs.length === 0);
} catch (e) {
  check('run', 'colour check ran to the end', false, e.message);
} finally {
  await ev(`for (const n of ['slate.library','slate.v1']) await new Promise(r=>{const q=indexedDB.deleteDatabase(n); q.onsuccess=q.onerror=q.onblocked=()=>r();}); return 1`).catch(() => {});
  await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId: T } }) }).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length }));
  process.exit(pass === results.length ? 0 : 1);
}
