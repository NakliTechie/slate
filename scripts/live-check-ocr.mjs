#!/usr/bin/env node
// live-check-ocr.mjs: Extract text in Chrome over the CDP daemon. Opens a synthetic image of printed
// text, presses the toolbar's Extract text button with a real click, and reads the dialog.
// Needs a network connection the first time (the recogniser loads from esm.sh and jsdelivr).
//
//   node scripts/live-check-ocr.mjs --url http://127.0.0.1:8493/index.html
const args = process.argv.slice(2);
const URL0 = (() => { const i = args.indexOf('--url'); return i >= 0 ? args[i + 1] : 'http://127.0.0.1:8493/index.html'; })();
const DAEMON = process.env.CDP_DAEMON || 'http://127.0.0.1:9334/';
const call = async (body) => (await fetch(DAEMON, { method: 'POST', body: JSON.stringify(body) })).text();
let T = null;
const raw = (method, params = {}) => call({ cmd: 'raw', t: T, text: JSON.stringify({ method, params }) });
const ev = async (js) => { const t = await call({ cmd: 'eval', t: T, js: `(async()=>JSON.stringify(await (async()=>{${js}})()))()` }); const v = JSON.parse(t); if (v && v.exc) throw new Error(v.exc); return v == null ? v : JSON.parse(v); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(js).catch(() => false)) return true; await sleep(250); } return false; };
const results = [];
const check = (rows, what, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${rows} ${what}${detail !== '' ? ` — ${detail}` : ''}`); };
const click = async ([x, y]) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await raw('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); await sleep(100); };
try {
  T = JSON.parse(await call({ cmd: 'open', url: `${URL0}?lc=${Date.now()}` })).targetId;
  await raw('Target.activateTarget', { targetId: T }); await raw('Page.bringToFront'); await raw('Page.enable'); await raw('Page.setWebLifecycleState', { state: 'active' }); await raw('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until('return !!window.__slate', 15000);
  await ev(`localStorage.setItem('slate.v2.tour-complete','1'); document.querySelector('.tour-skip')?.click();
    const c=new OffscreenCanvas(1200,360); const g=c.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,1200,360); g.fillStyle='#111';
    g.font='bold 64px Helvetica, Arial, sans-serif'; g.fillText('Invoice 2047 for Slate', 60, 130); g.font='48px Georgia, serif'; g.fillText('Paid on 16 November 2026', 60, 240);
    await __slate.openFromFile(new File([await c.convertToBlob({type:'image/png'})],'receipt.png',{type:'image/png'})); return 1`);
  await until('return __slate.state.image.working?.width === 1200');
  const btn = await ev(`const b=document.getElementById('tb-ocr'); if(!b||b.disabled) return null; const r=b.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]`);
  check('pending: OCR', 'the toolbar has an enabled Extract text button', !!btn);
  if (btn) await click(btn);
  check('pending: OCR', 'the Extract text dialog opens', await until(`return document.getElementById('modal-ocr')?.open`, 5000));
  const t0 = Date.now();
  const done = await until(`return !document.getElementById('ocr-copy').disabled || /Could not|No text/.test(document.getElementById('ocr-status').textContent)`, 120000);
  const out = await ev(`return { status: document.getElementById('ocr-status').textContent, text: document.getElementById('ocr-text').value }`);
  check('pending: OCR', 'printed text is read back', done && /Invoice\s+2047/i.test(out.text) && /November\s+2026/i.test(out.text), `${JSON.stringify(out.text)} in ${Date.now() - t0} ms; ${out.status}`);
  await ev(`document.getElementById('modal-ocr').close(); return 1`);
  await ev(`window.__ocrSeen = false; new MutationObserver((l,o)=>{ if (/Reading text/.test(document.getElementById('ocr-status')?.textContent||'')) { window.__ocrSeen = true; o.disconnect(); } }).observe(document.body,{subtree:true,childList:true,characterData:true}); return 1`);
  if (btn) await click(btn);
  const t1 = Date.now();
  const again = await until(`return window.__ocrSeen && document.getElementById('modal-ocr').open && /^Found/.test(document.getElementById('ocr-status').textContent)`, 60000);
  check('pending: OCR', 'a second run starts fresh and reuses the loaded recogniser', again && Date.now() - t1 < 20000, `${Date.now() - t1} ms`);
} catch (e) { check('run', 'OCR check ran to the end', false, e.message); }
finally {
  await ev(`for (const n of ['slate.library','slate.v1']) await new Promise(r=>{const q=indexedDB.deleteDatabase(n); q.onsuccess=q.onerror=q.onblocked=()=>r();}); return 1`).catch(() => {});
  await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId: T } }) }).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length }));
  process.exit(pass === results.length ? 0 : 1);
}
