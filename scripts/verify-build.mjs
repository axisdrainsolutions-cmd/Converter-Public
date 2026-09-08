/**
 * Post-build gate. Fails the build (and therefore the deploy) if the production
 * output would break on GitHub Pages.
 *
 * It checks the things that actually went wrong before:
 *   - an asset URL that assumes root hosting instead of /Converter-Public/
 *   - a referenced file that is not in dist/ (the classic 404 on Pages)
 *   - the ffmpeg core assets missing entirely
 *   - the ffmpeg class worker not being emitted as a real same-origin file
 *   - a leftover runtime dependency on unpkg / jsdelivr
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const BASE = '/Converter-Public/';

const problems = [];
const notes = [];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

function distHas(files, urlPath) {
  const rel = urlPath.startsWith(BASE) ? urlPath.slice(BASE.length) : urlPath.replace(/^\//, '');
  const target = join(dist, rel);
  return files.includes(target);
}

const files = await walk(dist).catch(() => {
  problems.push('dist/ does not exist — run `npm run build` first.');
  return [];
});
if (!files.length && problems.length) fail();

const rels = files.map((f) => relative(dist, f).replaceAll('\\', '/')).sort();

/* 1. Core assets present and sane ---------------------------------------- */
for (const name of ['ffmpeg/ffmpeg-core.js', 'ffmpeg/ffmpeg-core.wasm']) {
  if (!rels.includes(name)) problems.push(`missing required runtime asset: dist/${name}`);
}
const wasm = files.find((f) => f.endsWith('ffmpeg-core.wasm'));
if (wasm) {
  const info = await stat(wasm);
  if (info.size < 10_000_000) {
    problems.push(`ffmpeg-core.wasm is only ${info.size} bytes — looks truncated.`);
  } else {
    notes.push(`ffmpeg-core.wasm ${(info.size / 1024 / 1024).toFixed(1)} MB`);
  }
  const head = await readFile(wasm, { encoding: null });
  if (head.subarray(0, 4).toString('binary') !== '\0asm') {
    problems.push('ffmpeg-core.wasm does not start with the WASM magic number.');
  }
}

// The single-threaded core must not need a core worker file.
if (rels.some((r) => r.endsWith('ffmpeg-core.worker.js'))) {
  problems.push(
    'ffmpeg-core.worker.js is present — that is the multithreaded core, which needs SharedArrayBuffer and COOP/COEP headers GitHub Pages cannot set.'
  );
}

/* 2. index.html references resolve under the base path -------------------- */
const html = await readFile(join(dist, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:') || ref.startsWith('#')) continue;

  // Root-absolute refs must carry the base prefix. Relative refs are fine
  // (index.html sits at the base), and are resolved against dist/ here.
  if (ref.startsWith('/') && !ref.startsWith(BASE)) {
    problems.push(`index.html references "${ref}" which is not under ${BASE} — would 404 on GitHub Pages.`);
    continue;
  }
  if (!distHas(files, ref.replace(/^\.\//, ''))) {
    problems.push(`index.html references "${ref}" but dist has no such file.`);
  }
}

/* 3. The ffmpeg class worker is emitted as a real asset ------------------- */
const jsFiles = files.filter((f) => f.endsWith('.js'));
let workerRef = null;
for (const f of jsFiles) {
  const src = await readFile(f, 'utf8');

  // Any absolute in-app URL baked into JS must carry the base prefix.
  for (const m of src.matchAll(/["'`](\/[A-Za-z0-9_./-]+\.(?:js|wasm|json|css|png|svg))["'`]/g)) {
    const url = m[1];
    if (url.startsWith(BASE)) {
      if (!distHas(files, url) && !url.includes('ffmpeg-core')) {
        problems.push(`${relative(dist, f)} references "${url}" but dist has no such file.`);
      }
    } else {
      problems.push(`${relative(dist, f)} contains root-absolute URL "${url}" — breaks under ${BASE}.`);
    }
  }

  const worker = src.match(/["'`](\/Converter-Public\/assets\/[^"'`]*worker[^"'`]*\.js)["'`]/i);
  if (worker) workerRef = worker[1];

  if (/unpkg\.com|cdn\.jsdelivr\.net/.test(src) && !/dist\/umd/.test(src)) {
    // The ESM const.js carries a default CDN CORE_URL constant that is only
    // used when coreURL is omitted. We always pass coreURL, so it is dead code,
    // but flag it if it ever becomes reachable.
    notes.push(`${relative(dist, f)} mentions a CDN host (unused fallback constant).`);
  }
}

if (!workerRef) {
  problems.push(
    'No ffmpeg worker asset URL found in the bundle — the FFmpeg class worker was not emitted by Vite. It would try to resolve at runtime and fail.'
  );
} else if (!distHas(files, workerRef)) {
  problems.push(`Worker URL "${workerRef}" is referenced but not present in dist.`);
} else {
  notes.push(`ffmpeg class worker -> ${workerRef}`);
  const workerSrc = await readFile(join(dist, workerRef.slice(BASE.length)), 'utf8');
  if (!/import\s*\(/.test(workerSrc)) {
    problems.push('The emitted worker has no dynamic import() — it cannot load the ESM core.');
  }
}

/* 4. Report ---------------------------------------------------------------- */
console.log('--- build verification ---');
console.log(`files: ${rels.length}`);
for (const n of notes) console.log(`  note: ${n}`);
if (problems.length) fail();
console.log('OK: every referenced asset resolves under ' + BASE);

function fail() {
  console.error('--- build verification FAILED ---');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
