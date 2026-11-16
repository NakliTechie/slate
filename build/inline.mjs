#!/usr/bin/env node
// Slate build script — inline.mjs
// Bundles src/ into a single dist/index.html.
// No runtime deps beyond Node stdlib.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, relative, join, extname, basename } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC  = join(ROOT, 'src');
const DIST = join(ROOT, 'dist'); // kept for backward compat / dev server
const VERSION = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const DEV_MODE = process.argv.includes('--dev');

// ── Collect CSS ───────────────────────────────────────────────────────────────

function collectCss(dir) {
  const files = [];
  for (const f of readdirSync(dir, { recursive: true })) {
    const full = join(dir, f);
    if (statSync(full).isFile() && f.endsWith('.css')) files.push(full);
  }
  return files.sort().map(f => `/* ${relative(SRC, f)} */\n${readFileSync(f, 'utf8')}`).join('\n\n');
}

// ── Module bundler ────────────────────────────────────────────────────────────

const bundled = new Map(); // path → module var name
const order = [];          // topological order of paths

function varName(filePath) {
  return '__m_' + relative(SRC, filePath)
    .replace(/\.mjs$/, '')
    .replace(/\.js$/, '')
    .replace(/[^a-zA-Z0-9]/g, '_');
}

function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null; // skip bare specifiers (none in v1)
  if (spec.endsWith('.js') || spec.endsWith('.mjs')) {
    return resolve(dirname(from), spec);
  }
  return resolve(dirname(from), spec + '.js');
}

function parseImports(src) {
  // Match: import { ... } from './path.js'
  //        import * as X from './path.js'
  //        import X from './path.js'
  //        import './path.js'
  const re = /^import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]\s*;?$/gm;
  const imports = [];
  let m;
  while ((m = re.exec(src)) !== null) imports.push(m[1]);
  return imports;
}

function parseNamedImports(src) {
  // Returns [{varname, specifier, names}] for rewriting
  const re = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?$/gm;
  const results = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    results.push({ clause: m[1], specifier: m[2], full: m[0] });
  }
  // Also catch bare imports
  const bareRe = /^import\s+['"]([^'"]+)['"]\s*;?$/gm;
  while ((m = bareRe.exec(src)) !== null) {
    results.push({ clause: null, specifier: m[1], full: m[0] });
  }
  return results;
}

function parseExports(src) {
  // Collect { local, exported } pairs for the module's return object.
  // Critical: preserves `export { X as Y }` so the bundled namespace has Y, not X.
  const pairs = [];
  const seen = new Set();
  const add = (local, exported) => {
    if (seen.has(exported)) return;
    seen.add(exported);
    pairs.push({ local, exported });
  };
  // export function/class/const/let/var NAME
  const re1 = /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/gm;
  let m;
  while ((m = re1.exec(src)) !== null) add(m[1], m[1]);
  // export { a, b as c }
  // Match `export { ... }` anywhere on the line. Vendored bundles inline
  // everything to one line so anchoring to ^ misses them.
  const re2 = /export\s*\{([^}]+)\}/g;
  while ((m = re2.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      const [local, exported] = cleaned.split(/\s+as\s+/).map(s => s.trim());
      add(local, exported || local);
    }
  }
  return pairs;
}

function transformModule(filePath, src) {
  const vn = varName(filePath);

  // Rewrite imports to reference already-bundled module vars
  const importInfos = parseNamedImports(src);
  let body = src;

  for (const info of importInfos) {
    const absPath = resolveImport(filePath, info.specifier);
    if (!absPath) continue;
    const depVar = varName(absPath);

    let replacement = '';
    if (info.clause) {
      const clause = info.clause.trim();
      if (clause.startsWith('{')) {
        // Named imports: { a, b, c as d }
        const inner = clause.slice(1, clause.lastIndexOf('}'));
        const parts = inner.split(',').map(p => {
          const [orig, alias] = p.trim().split(/\s+as\s+/);
          return alias ? `const ${alias.trim()} = ${depVar}.${orig.trim()};`
                       : `const ${orig.trim()} = ${depVar}.${orig.trim()};`;
        });
        replacement = parts.join('\n');
      } else if (clause.startsWith('*')) {
        // Namespace import: * as X
        const alias = clause.replace(/\*\s+as\s+/, '').trim();
        replacement = `const ${alias} = ${depVar};`;
      } else {
        // Default import
        replacement = `const ${clause} = ${depVar}.default ?? ${depVar};`;
      }
    }
    body = body.replace(info.full, replacement);
  }

  // Remove export keywords, collect exported names
  body = body
    .replace(/^export\s+default\s+/gm, 'const __default__ = ')
    .replace(/^export\s+(async\s+)?(function|class)\s+/gm, '$1$2 ')
    .replace(/^export\s+(const|let|var)\s+/gm, '$1 ')
    // Strip `export { ... }` blocks anywhere on a line (vendored bundles inline
    // everything onto one line, so anchoring to ^...$ misses them)
    .replace(/export\s*\{[^}]*\}\s*;?/g, '');

  const exports = parseExports(src);
  const defaultExport = /^export\s+default\s+/m.test(src) ? '__default__' : null;

  const retObj = [
    ...exports.map(p => p.local === p.exported ? p.local : `${p.exported}: ${p.local}`),
    ...(defaultExport ? [`default: ${defaultExport}`] : [])
  ].join(', ');

  return `const ${vn} = (() => {\n${body}\nreturn { ${retObj} };\n})();`;
}

function bundle(entryPath) {
  if (bundled.has(entryPath)) return;
  const src = readFileSync(entryPath, 'utf8');

  // Process deps first (topological order)
  for (const spec of parseImports(src)) {
    const abs = resolveImport(entryPath, spec);
    if (abs) bundle(abs);
  }

  bundled.set(entryPath, true);
  order.push(entryPath);
}

// ── SVG icons (inline into HTML) ──────────────────────────────────────────────

function readIcons() {
  const svgPath = join(SRC, 'ui', 'icons.svg');
  return readFileSync(svgPath, 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

mkdirSync(DIST, { recursive: true });

const entryPath = join(SRC, 'app.js');
bundle(entryPath);

const jsBlocks = order.map(p => transformModule(p, readFileSync(p, 'utf8')));
// Append boot call (app.js export is side-effectful, but the IIFE runs the module)
const inlineJs = jsBlocks.join('\n\n');

const css = collectCss(SRC);
const icons = readIcons();
const template = readFileSync(join(SRC, 'index.html'), 'utf8');

const hash = createHash('sha256').update(inlineJs).digest('hex').slice(0, 7);
const versionStr = DEV_MODE ? `Slate v${VERSION} (${hash})` : `Slate v${VERSION}`;

// Inline favicon as data URL so the file is truly self-contained
const faviconSvg = readFileSync(join(ROOT, 'favicon.svg'), 'utf8');
const faviconDataUrl = `data:image/svg+xml,${encodeURIComponent(faviconSvg)}`;

let html = template
  .replace(/<link rel="stylesheet" href="[^"]*">\s*/g, '')
  .replace(/<script type="module" src="[^"]*"><\/script>/, '')
  .replace('<body>', `<body>\n<div id="icon-sprite" aria-hidden="true" style="display:none">\n${icons}\n</div>`)
  .replace('</head>', `<style>\n${css}\n</style>\n</head>`)
  .replace('</body>', `<script type="module">\n${inlineJs}\n</script>\n</body>`)
  .replace('href="/favicon.svg"', `href="${faviconDataUrl}"`);

// Root index.html — the single deployable file
writeFileSync(join(ROOT, 'index.html'), html, 'utf8');

// Also write to dist/ for Cloudflare Pages + _headers
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'index.html'), html, 'utf8');
// The content security policy lives in src/index.html as a <meta> tag, so the direct site and the
// NakliOS mirror both get it (review finding S8). The header copy repeats that policy and adds
// frame-ancestors, which a meta tag cannot set. NakliOS embeds Slate, so framing is allowed from
// this origin and naklios.dev only.
const cspMeta = template.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
if (!cspMeta) throw new Error('src/index.html has no Content-Security-Policy meta tag');
const headers = `/*
  Content-Security-Policy: ${cspMeta[1]}; frame-ancestors 'self' https://naklios.dev
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
`;
writeFileSync(join(DIST, '_headers'), headers);

const size = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`✓ Built ${versionStr} → index.html (${size} KB)`);
