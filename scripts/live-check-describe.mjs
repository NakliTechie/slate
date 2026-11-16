#!/usr/bin/env node
// live-check-describe.mjs: Describe with AI, in Chrome over the CDP daemon, against a stubbed NakliOS host
// (standalone Slate has no host). The stub stands in for naklios.ai and records the request; the real
// host and model are the NakliOS session's check.
//
//   node scripts/live-check-describe.mjs --url http://127.0.0.1:8493/index.html
const args = process.argv.slice(2);
const URL0 = (() => { const i = args.indexOf('--url'); return i >= 0 ? args[i + 1] : 'http://127.0.0.1:8493/index.html'; })();
const DAEMON = process.env.CDP_DAEMON || 'http://127.0.0.1:9334/';
const call = async (body) => (await fetch(DAEMON, { method: 'POST', body: JSON.stringify(body) })).text();
let T = null;
const raw = (method, params = {}) => call({ cmd: 'raw', t: T, text: JSON.stringify({ method, params }) });
const ev = async (js) => { const t = await call({ cmd: 'eval', t: T, js: `(async()=>JSON.stringify(await (async()=>{${js}})()))()` }); const v = JSON.parse(t); if (v && v.exc) throw new Error(v.exc); return v == null ? v : JSON.parse(v); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(js).catch(() => false)) return true; await sleep(150); } return false; };
const results = [];
const check = (rows, what, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${rows} ${what}${detail !== '' ? ` — ${detail}` : ''}`); };
const click = async (sel) => { const p = await ev(`const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]`); if (!p) return false; for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await raw('Input.dispatchMouseEvent', { type, x: p[0], y: p[1], button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); await sleep(150); return true; };
try {
  T = JSON.parse(await call({ cmd: 'open', url: `${URL0}?lc=${Date.now()}` })).targetId;
  await raw('Target.activateTarget', { targetId: T }); await raw('Page.bringToFront'); await raw('Page.enable'); await raw('Page.setWebLifecycleState', { state: 'active' }); await raw('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until('return !!window.__slate', 15000);
  await ev(`localStorage.setItem('slate.v2.tour-complete','1'); document.querySelector('.tour-skip')?.click();
    const c=new OffscreenCanvas(3000,2000); const g=c.getContext('2d'); g.fillStyle='#4a90d9'; g.fillRect(0,0,3000,2000); g.fillStyle='#f5d76e'; g.beginPath(); g.arc(2200,500,250,0,7); g.fill();
    await __slate.openFromFile(new File([await c.convertToBlob({type:'image/png'})],'sky.png',{type:'image/png'})); return 1`);
  await until('return __slate.state.image.working?.width === 3000');
  await ev(`document.getElementById('info-panel').classList.remove('hidden'); __slate.emit('image:loaded', null); return 1`);
  check('X1', 'standalone, without a host model, Image Info offers no Describe button', !(await ev(`return !!document.getElementById('info-describe')`)));
  await ev(`const n=window.naklios; Object.assign(n.capabilities,{hosted:true, ai:true, experimental_aiVision:true, aiLocal:false, aiModelLabel:'Stub Vision', aiProvider:'test'});
    window.__req=null; n.ai.chat.completions.create = async (req)=>{ window.__req={ agent:req.agent, n:req.messages.length, url:req.messages[0].content[1].image_url.url }; return { choices:[{ message:{ content:'A blue sky with a yellow sun in the upper right.\\nKeywords: sky, sun, blue' } }] }; };
    __slate.emit('image:loaded', null); return 1`);
  check('X1', 'with a vision model in NakliOS, Image Info offers Describe with AI', await until(`return !!document.getElementById('info-describe')`, 3000));
  await click('#info-describe');
  const where = await ev(`return document.getElementById('desc-where')?.innerText`);
  check('X1', 'the dialog says where the image goes before sending', /Stub Vision \(test\), outside this device/.test(where || ''), where);
  await click('#desc-go');
  await until(`return !document.getElementById('desc-text').hidden`, 8000);
  const out = await ev(`const u=window.__req?.url||''; const img=new Image(); img.src=u; await img.decode().catch(()=>{}); return { text: document.getElementById('desc-text').value, keys: document.getElementById('desc-keys').textContent, agent: window.__req?.agent, w: img.naturalWidth, h: img.naturalHeight, kb: Math.round(u.length*0.75/1024), jpeg: u.startsWith('data:image/jpeg;base64,') }`);
  check('X1', 'the request is an agent request with a JPEG at most 1,536 px, well under 8 MB', out.agent === true && out.jpeg && Math.max(out.w, out.h) === 1536 && out.kb < 8192, `${out.w} x ${out.h}, ${out.kb} KB`);
  check('X1', 'the reply fills the description and keywords', /blue sky/.test(out.text) && /sky, sun, blue/.test(out.keys), `${JSON.stringify(out.text)} / ${out.keys}`);
} catch (e) { check('run', 'describe check ran to the end', false, e.message); }
finally {
  await ev(`for (const n of ['slate.library','slate.v1']) await new Promise(r=>{const q=indexedDB.deleteDatabase(n); q.onsuccess=q.onerror=q.onblocked=()=>r();}); return 1`).catch(() => {});
  await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId: T } }) }).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length }));
  process.exit(pass === results.length ? 0 : 1);
}
