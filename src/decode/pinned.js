// Hash-checked loader for the four decoders Slate fetches from esm.sh (review finding S8).
//
// Browsers do not check an integrity hash on a dynamic import(), so Slate does it here:
// it fetches each file, compares its SHA-256 with the pin below, and imports it from a
// blob: URL. Each file's own esm.sh imports are rewritten to the blob: URLs of their
// checked copies, so no byte from esm.sh runs unless it matches its pin. A file that
// differs is refused and the decoder does not load.
//
// The paths name esm.sh's es2022 build files directly. The short URLs (https://esm.sh/utif@3.1.0)
// answer with a stub that depends on the browser's User-Agent; the build files do not.
// The pins were taken on 2026-11-17 and matched across three User-Agents. To upgrade a
// decoder, change its path, fetch every file it imports, and record each new hash here
// and in SECURITY.md.

export const ESM_BASE = 'https://esm.sh';

export const ENTRIES = {
  utif: '/utif@3.1.0/es2022/utif.mjs',
  libheif: '/libheif-js@1.19.8/es2022/wasm-bundle.mjs',
  jxl: '/@jsquash/jxl@1.3.0/es2022/decode.mjs',
  jxlWasm: '/@jsquash/jxl@1.3.0/codec/dec/jxl_dec.wasm',
  agPsd: '/ag-psd@30.1.1/es2022/ag-psd.mjs',
};

// esm.sh path -> SHA-256 of the exact bytes it serves.
export const PINS = {
  '/utif@3.1.0/es2022/utif.mjs': 'bb0f6185ed624db5c293f5922cf947cfaf88feb73bc24bda5eaa9c06d52a933d',
  '/pako@1.0.11/es2022/pako.mjs': '4895feb3e2441ef725da4052a5dc93d219d065fef1decc4452bb9b7ee1477c0d',
  '/libheif-js@1.19.8/es2022/wasm-bundle.mjs': 'e84a4fb2405b361cc33ca20ea4a07f966c2e2f4af97f4b38a5c09a943a0167d1',
  '/@jsquash/jxl@1.3.0/es2022/decode.mjs': '2771c69b27edc1e803bea512d746883d7c131a4fe77e9dd0d04afb02a5f8674f',
  '/@jsquash/jxl@1.3.0/codec/dec/jxl_dec.wasm': '165bde0f48f3bdc39c7806365db5bb3b777df67fefff48050841fb4430062433',
  '/ag-psd@30.1.1/es2022/ag-psd.mjs': 'a48ef7bb66e3e06201e2e178d605960f1492c353d4a53c9dd1f6a0e55e14d011',
  '/base64-js@1.5.1/es2022/base64-js.mjs': '5dbae8a1d8f5789da21736786f9921727523b5ccc64cbcf9f831331c381957dc',
  '/pako@2.1.0/es2022/pako.mjs': '6f8c08355f970b0592aff0bdaf53ab881876152f0a2c6910cd5f3c2b71fb791d',
  // esm.sh's Node polyfills, which the decoders import. Their URLs carry no version, so a
  // change on esm.sh's side makes the decoder refuse to load until the pins are renewed.
  '/node/process.mjs': '79bdd29eef537eee63ba8ef06a00a9579a6a99efc4ba391807e017049ecfe452',
  '/node/events.mjs': '4c6150b88c1444aa1fe9331013e3f37eda9836206f629f7f3ae8f3743dd90fa8',
  '/node/async_hooks.mjs': 'b7862dbfba8bbbca956f19e4e08280b529e4b27468779775a9093aef8c92dc1d',
  '/node/tty.mjs': 'c66ff4b406bad449bfb2ced355f15badf16f4d9e035d2d300e33b5aeee64e3be',
  '/node/buffer.mjs': '64fb61aa5f48644d685f9ceabedba60ea6b5d6ce03dac1943e863d00d9e574f3',
  '/node/util.mjs': '0cc72bdadc46cf17685e6d9385e3d1536fdc4d6fa783cb18365574d14b74d5e8',
  '/node/util/types.mjs': '3f3e225fbce928e7556c759c2426ecafb05e451430e798d9f14e62c61208f2f0',
};

// utif imports pako by a version range; Slate resolves it to the version it pinned.
export const ALIASES = {
  '/pako@^1.0.5?target=es2022': '/pako@1.0.11/es2022/pako.mjs',
};

const SPEC_RE = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\/[^"']+)\2/g;

// The esm.sh paths a module imports, in order, without repeats.
export function esmImports(text) {
  return [...new Set([...text.matchAll(SPEC_RE)].map(m => m[3]))];
}

// The module text with each esm.sh import replaced by urls[path].
export function rewriteImports(text, urls) {
  return text.replace(SPEC_RE, (all, lead, q, path) => {
    const u = urls[path];
    if (!u) throw new Error(`${path} has no checked copy`);
    return `${lead}${q}${u}${q}`;
  });
}

export async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}

// The bytes of one pinned esm.sh file, or an error when they differ from the pin.
export async function fetchPinned(path, fetchFn = fetch) {
  const want = PINS[path];
  if (!want) throw new Error(`${path} is not a pinned decoder file, so Slate did not load it`);
  const res = await fetchFn(ESM_BASE + path, { credentials: 'omit' });
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const got = await sha256Hex(buf);
  if (got !== want) throw new Error(`${path} from esm.sh does not match its pinned SHA-256, so Slate did not run it`);
  return buf;
}

const urls = new Map(); // path -> Promise<blob: URL>

function moduleUrl(path, stack = []) {
  path = ALIASES[path] ?? path;
  if (stack.includes(path)) throw new Error(`circular import at ${path}`);
  if (!urls.has(path)) {
    const p = (async () => {
      const text = new TextDecoder().decode(await fetchPinned(path));
      const deps = esmImports(text);
      const depUrls = await Promise.all(deps.map(d => moduleUrl(d, [...stack, path])));
      const map = Object.fromEntries(deps.map((d, i) => [d, depUrls[i]]));
      return URL.createObjectURL(new Blob([rewriteImports(text, map)], { type: 'text/javascript' }));
    })();
    p.catch(() => urls.delete(path));
    urls.set(path, p);
  }
  return urls.get(path);
}

// Import one pinned esm.sh module and everything it imports, each checked against its pin.
export async function importPinned(path) {
  return import(/* @vite-ignore */ await moduleUrl(path));
}
