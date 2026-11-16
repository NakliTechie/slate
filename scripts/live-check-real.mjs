#!/usr/bin/env node
// live-check-real.mjs: the photo library on a real, copyright-free photo set (CC0 and public domain,
// built by scripts/build-photo-set.mjs, credits in its CREDITS.csv), in Chrome over the CDP daemon.
// The page fetches the set from the test server (a `testset` symlink next to index.html, which git
// ignores), copies it into an OPFS folder and adds that folder as a library root. It reports what the
// set exercises that the synthetic folders cannot: real EXIF from many cameras, GPS across countries,
// real faces, real signage, near-duplicate bursts, real video codecs.
//
//   ln -s <photo set folder> testset
//   node scripts/live-check-real.mjs --url http://127.0.0.1:8493/index.html [--set testset] [--models]
//
// --models also runs Search by meaning and People (model downloads). Everything in OPFS and IndexedDB
// that the run creates is deleted by name; the photo set itself is never touched.

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const URL0 = opt('url', 'http://127.0.0.1:8493/index.html');
const SET = opt('set', 'testset');
const MODELS = args.includes('--models');
const DAEMON = process.env.CDP_DAEMON || 'http://127.0.0.1:9334/';
const FOLDER = `slate-livecheck-real-${Date.now().toString(36)}`;
const call = async (body) => (await fetch(DAEMON, { method: 'POST', body: JSON.stringify(body) })).text();
let T = null;
const raw = (method, params = {}) => call({ cmd: 'raw', t: T, text: JSON.stringify({ method, params }) });
const ev = async (js) => { const t = await call({ cmd: 'eval', t: T, js: `(async()=>JSON.stringify(await (async()=>{${js}})()))()` }); const v = JSON.parse(t); if (v && v.exc) throw new Error(v.exc); return v == null ? v : JSON.parse(v); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (js, ms = 10000, step = 500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(js).catch(() => false)) return true; await sleep(step); } return false; };
const results = [];
const check = (rows, what, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${rows} ${what}${detail !== '' ? ` — ${detail}` : ''}`); };
const note = (s) => console.log(`  ${s}`);
const L = 'const S=window.__slateLibrary, L=S.lib;';

try {
  T = JSON.parse(await call({ cmd: 'open', url: `${URL0}?lc=${Date.now()}` })).targetId;
  await raw('Target.activateTarget', { targetId: T }); await raw('Page.bringToFront');
  await raw('Page.enable'); await raw('Page.setWebLifecycleState', { state: 'active' }); await raw('Emulation.setFocusEmulationEnabled', { enabled: true });
  await raw('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  if (!(await until('return !!window.__slateLibrary', 15000))) throw new Error('the library did not start');
  await ev(`window.__errs=[]; const ce=console.error; console.error=(...a)=>{ __errs.push(a.map(x=>x&&x.stack?String(x.stack).split('\\n').slice(0,2).join(' / '):String(x)).join(' ')); ce(...a); }; addEventListener('error',e=>__errs.push('X '+e.message)); addEventListener('unhandledrejection',e=>__errs.push('R '+(e.reason&&e.reason.message||e.reason))); return 1`);
  await ev(`localStorage.setItem('slate.v2.tour-complete','1'); localStorage.setItem('slate.v2.library-tour-complete','1'); document.querySelector('.tour-skip')?.click(); return 1`);

  // ── copy the set into OPFS ──
  const copied = await ev(`
    const base=new URL(${JSON.stringify(SET + '/')}, location.href);
    const cell=(line)=>{ const out=[]; let cur='', q=false; for (let i=0;i<line.length;i++){ const ch=line[i]; if(q){ if(ch==='"'&&line[i+1]==='"'){cur+='"';i++;} else if(ch==='"') q=false; else cur+=ch; } else if(ch==='"') q=true; else if(ch===','){out.push(cur);cur='';} else cur+=ch; } out.push(cur); return out; };
    let paths;
    const credits=await fetch(new URL('CREDITS.csv', base));
    if (credits.ok) {
      const rows=(await credits.text()).trim().split(/\\r?\\n/); const head=rows.shift().split(',');
      const pi=head.findIndex(h=>/^"?path"?$/i.test(h.trim())); if (pi<0) throw new Error('CREDITS.csv has no path column');
      paths=rows.map(r=>cell(r)[pi]).filter(Boolean);
    } else {
      // No CREDITS.csv yet (the set is still building): walk the test server's directory listing.
      paths=[]; const walk=async(rel)=>{ const html=await (await fetch(new URL(rel, base))).text();
        for (const m of html.matchAll(/href="([^"?#]+)"/g)) { const h=decodeURIComponent(m[1]); if (h.startsWith('/')||h.startsWith('..')) continue;
          if (h.endsWith('/')) await walk(rel+m[1]); else if (!/\\.(csv|md|json|txt)$/i.test(h)) paths.push(decodeURIComponent(rel)+h); } };
      await walk('');
    }
    const root=await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(FOLDER)},{create:true});
    let bytes=0, n=0, missing=[];
    for (const p of paths) {
      const r=await fetch(new URL(p.split('/').map(encodeURIComponent).join('/'), base)); if(!r.ok){ missing.push(p); continue; }
      const parts=p.split('/'); const name=parts.pop(); let d=root; for (const s of parts) d=await d.getDirectoryHandle(s,{create:true});
      const w=await (await d.getFileHandle(name,{create:true})).createWritable(); const b=await r.blob(); await w.write(b); await w.close(); bytes+=b.size; n++;
    }
    window.__root=root; return { listed: paths.length, n, mb: Math.round(bytes/1e5)/10, missing: missing.slice(0,5) }`);
  note(`copied ${copied.n} of ${copied.listed} files (${copied.mb} MB) into OPFS ${FOLDER}${copied.missing.length ? `; missing ${copied.missing.join(', ')}` : ''}`);
  const t0 = Date.now();
  await ev(`${L} await S.addRoot(__root); S.ui.showLibrary(); return 1`);
  await until(`${L} return L.jobs.status().idle && [...L.records.values()].every(r=>r.thumb!=null)`, 900000, 2000);
  const sum = await ev(`${L} const rs=[...L.records.values()]; const by=(f)=>{ const m={}; for (const r of rs){ const k=f(r); m[k]=(m[k]||0)+1; } return m; };
    return { records: rs.length, kinds: by(r=>r.kind), exts: by(r=>r.ext), timeSource: by(r=>r.timeSource), gps: rs.filter(r=>r.lat!=null).length,
      thumbs: by(r=>r.thumb), thumbFails: rs.filter(r=>r.thumb!=='ok').map(r=>r.path+' ('+r.thumb+')').slice(0,12),
      years: [...new Set(rs.map(r=>new Date(r.time).getUTCFullYear()))].sort(), cameras: [...new Set(rs.map(r=>r.camera).filter(Boolean))].length,
      noDims: rs.filter(r=>r.kind==='photo' && (!r.w||!r.h)).map(r=>r.path).slice(0,8), videosNoDur: rs.filter(r=>r.kind==='video' && !r.dur).map(r=>r.path),
      errors: L.jobs.errors.slice(0,8) }`);
  note(`indexed in ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(sum)}`);
  check('L1 M1 M2', 'every copied file is indexed with a thumbnail', sum.records === copied.n && sum.thumbFails.length === 0, `${sum.records} records; failures: ${sum.thumbFails.join(', ') || 'none'}`);
  check('M1', 'real EXIF: capture dates from cameras, several years and cameras', (sum.timeSource.exif || 0) >= sum.records * 0.6 && sum.years.length >= 5 && sum.cameras >= 5, `exif dates ${sum.timeSource.exif || 0}, years ${sum.years.join(' ')}, ${sum.cameras} cameras`);
  check('M1', 'every photo has its pixel size', sum.noDims.length === 0, sum.noDims.join(', ') || 'all');
  check('M3', 'every video has a poster and a duration', sum.videosNoDur.length === 0 && (sum.kinds.video || 0) >= 1, `${sum.kinds.video || 0} videos; without duration: ${sum.videosNoDur.join(', ') || 'none'}`);

  // ── Places ──
  await ev(`document.querySelector('.library-sidebar [data-xview="places"]')?.click(); return 1`);
  const tPl = Date.now();
  const plDone = await until(`return /in \\d+ countr/i.test(document.querySelector('.lib-panel')?.innerText||'')`, 90000);
  note(`Places listed after ${Math.round((Date.now() - tPl) / 100) / 10} s`);
  if (!plDone) note(`Places did not finish; page errors: ${JSON.stringify(await ev('return __errs.slice(-5)'))}`);
  const pl = await ev(`return (document.querySelector('.lib-panel')?.innerText||'').replace(/\\s+/g,' ').slice(0,400)`);
  const nCountries = Number((/in (\d+) countr/.exec(pl) || [])[1] || 0);
  check('P1', 'Places groups the GPS photos by country and town', sum.gps >= 50 && nCountries >= 8, `${sum.gps} photos with GPS; ${pl.slice(0, 200)}`);

  // ── On this day, duplicates ──
  const mem = await ev(`return [...document.querySelectorAll('.library-sidebar [data-xview="memories"]')].map(b=>b.innerText.replace(/\\s+/g,' '))[0]`);
  note(`On this day: ${mem}`);
  await ev(`document.querySelector('.library-sidebar [data-xview="duplicates"]')?.click(); return 1`);
  const dpDone = await until(`return /Found \\d+ group|No duplicates found/.test(document.querySelector('.lib-panel')?.innerText||'')`, 120000);
  if (!dpDone) note(`Duplicates did not finish: ${JSON.stringify(await ev("return { text: (document.querySelector('.lib-panel')?.innerText||'').slice(0,200), jobs: window.__slateLibrary.lib.jobs.status(), errs: __errs.slice(-5) }"))}`);
  const dup = await ev(`return (/Found[^.]*\\./.exec(document.querySelector('.lib-panel')?.innerText||'')||[''])[0]`);
  check('D2', 'Duplicates finds the bursts and near-duplicates', /(\d+) groups? of similar/.test(dup) && Number(/(\d+) groups? of similar/.exec(dup)[1]) >= 1, dup || 'No duplicates found');

  // ── text in photos ──
  await ev(`${L} await L.services.textIndex.setEnabled(true); return 1`);
  const tOcr = Date.now();
  await until(`${L} const s=L.jobs.status(); return !!s.kinds?.ocr && s.kinds.ocr.done + s.kinds.ocr.failed >= s.kinds.ocr.total`, 1200000, 3000);
  await sleep(2500);
  const ocr = await ev(`${L} const withText=[...L.records.values()].filter(r=>(L.textOf?.(r.id)||'').trim().length>=8);
    const sample=withText.slice(0,5).map(r=>r.path+': '+L.textOf(r.id).replace(/\\s+/g,' ').slice(0,40));
    const word=(withText.map(r=>L.textOf(r.id)).join(' ').match(/[A-Za-z]{5,}/)||[])[0]; const hits=word?L.search({ q: word }).length:0;
    await L.services.textIndex.setEnabled(false); return { withText: withText.length, sample, word, hits }`);
  ocr.seconds = Math.round((Date.now() - tOcr) / 1000);
  check('X3', 'text is read from real signs and a word from them finds the photo', ocr.withText >= 3 && ocr.hits >= 1, JSON.stringify(ocr));

  if (MODELS) {
    await ev(`${L} await L.services.clip.enable(); return 1`);
    await until(`${L} const s=L.services.clip.status(); return (s.count||0) >= s.indexable && s.model==='ready'`, 1200000, 3000);
    const cl = await ev(`${L} const q=async t=>(await S.run('library.search_meaning',{ text:t, limit:5 })).items.map(x=>x.folder+'/'+x.name);
      const out={ mountains: await q('snowy mountains'), beach: await q('a beach with the sea'), city: await q('a city street at night'), status: L.services.clip.status() };
      await L.services.clip.disable(); return out`);
    note(`Search by meaning, top 5 each: ${JSON.stringify(cl)}`);
    check('Q2', 'search by meaning returns results on real photos', cl.mountains.length && cl.beach.length && cl.city.length, 'top results listed above for review');
    await ev(`${L} await L.services.faces.setEnabled(true); return 1`);
    await until(`${L} const s=L.services.faces.status(); return s.total>0 && s.done>=s.total`, 1200000, 3000);
    await sleep(4000);
    const fc = await ev(`${L} const s=L.services.faces.status(); await L.services.faces.setEnabled(false); return s`);
    check('F1', 'People groups the repeated portraits into people', fc.people >= 2, JSON.stringify(fc));
  }
} catch (e) {
  check('run', 'real-set check ran to the end', false, e.message);
} finally {
  try {
    await ev(`${L} for (const id of [...L.roots.keys()]) await L.removeRoot(id).catch(()=>{}); await L.services.faces?.deleteAll?.()?.catch?.(()=>{});
      const r=await navigator.storage.getDirectory(); await r.removeEntry(${JSON.stringify(FOLDER)},{recursive:true}).catch(()=>{}); await r.removeEntry('slate-thumbs',{recursive:true}).catch(()=>{});
      for (const n of ['slate.library','slate.v1','slate.faces']) await new Promise(res=>{const q=indexedDB.deleteDatabase(n); q.onsuccess=q.onerror=q.onblocked=()=>res();}); return 1`);
    note(`cleaned up: OPFS ${FOLDER} and slate-thumbs; IndexedDB slate.library, slate.v1, slate.faces (the photo set itself is untouched)`);
  } catch (e) { note(`cleanup failed ${e.message}`); }
  await raw('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await call({ cmd: 'raw', text: JSON.stringify({ method: 'Target.closeTarget', params: { targetId: T } }) }).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length }));
  process.exit(pass === results.length ? 0 : 1);
}
