/**
 * Copies the ffmpeg.wasm single-threaded ESM core out of node_modules and into
 * public/ffmpeg/ so that Vite ships it as a same-origin static asset.
 *
 * Why same-origin instead of a CDN:
 *   - no CORS preflight / opaque-response problems
 *   - no need for toBlobURL() to launder a cross-origin script
 *   - no CDN outage or stale-cache failure mode
 *   - GitHub Pages serves .wasm as application/wasm, which is what
 *     WebAssembly.instantiateStreaming requires
 *
 * The filenames are read from the installed package rather than hard-coded
 * guesses, and the script fails loudly if the package layout ever changes.
 */
import { createRequire } from 'node:module';
import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destDir = join(root, 'public', 'ffmpeg');

/**
 * These packages restrict `exports`, so `require.resolve('<pkg>/package.json')`
 * throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the package entry point instead
 * and walk up to the directory that owns it. This still reads the *installed*
 * copy rather than assuming a node_modules layout.
 */
function readInstalledPackage(name) {
  let dir = dirname(require.resolve(name));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg.name === name) return { pkg, dir };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the installed package.json for ${name}.`);
}

const { pkg: corePkg, dir: coreRoot } = readInstalledPackage('@ffmpeg/core');
const coreDir = join(coreRoot, 'dist', 'esm');

const { pkg: ffmpegPkg } = readInstalledPackage('@ffmpeg/ffmpeg');
const { pkg: utilPkg } = readInstalledPackage('@ffmpeg/util');

// ESM core, because the FFmpeg class always spawns a `type: "module"` worker
// and that worker loads the core with a dynamic import(), which requires a
// module with a default export. The UMD core has no default export and would
// fail here — this is exactly what the official docs mean by
// "Vite users should use esm in baseURL instead of umd".
const REQUIRED = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

async function main() {
  await mkdir(destDir, { recursive: true });

  const copied = [];
  for (const name of REQUIRED) {
    const from = join(coreDir, name);
    let info;
    try {
      info = await stat(from);
    } catch {
      throw new Error(
        `Expected ${from} to exist in @ffmpeg/core@${corePkg.version}. ` +
          `The package layout changed; update scripts/copy-ffmpeg-core.mjs instead of guessing filenames.`
      );
    }
    await copyFile(from, join(destDir, name));
    copied.push({ name, bytes: info.size });
  }

  // Sanity check: the single-threaded core must NOT need a core worker file.
  // If a future version adds one, we want the build to tell us.
  const mtWorker = join(coreDir, 'ffmpeg-core.worker.js');
  try {
    await stat(mtWorker);
    throw new Error(
      'ffmpeg-core.worker.js appeared in @ffmpeg/core — that means the core is ' +
        'now multithreaded and needs SharedArrayBuffer + COOP/COEP headers. Review before shipping.'
    );
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const manifest = {
    generatedBy: 'scripts/copy-ffmpeg-core.mjs',
    generatedAt: new Date().toISOString(),
    variant: 'single-thread (esm)',
    versions: {
      '@ffmpeg/core': corePkg.version,
      '@ffmpeg/ffmpeg': ffmpegPkg.version,
      '@ffmpeg/util': utilPkg.version,
    },
    files: copied,
  };
  await writeFile(join(destDir, 'core-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
  console.log(`[ffmpeg-core] @ffmpeg/core@${corePkg.version} (single-thread, esm) -> public/ffmpeg/`);
  for (const f of copied) console.log(`[ffmpeg-core]   ${f.name}  ${mb(f.bytes)}`);
}

main().catch((err) => {
  console.error('[ffmpeg-core] ' + err.message);
  process.exit(1);
});
