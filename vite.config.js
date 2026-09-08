import { defineConfig } from 'vite';

/**
 * The production site lives at https://axisdrainsolutions.github.io/Converter-Public/
 * so every generated asset URL must be prefixed with /Converter-Public/.
 *
 * `base` is set unconditionally (not just for `build`) so that `vite dev` and
 * `vite preview` both serve the app from the same sub-path the production site
 * uses. That means local testing exercises the real path layout instead of a
 * root-hosted approximation, which is how "works locally, 404s on Pages" bugs
 * get through.
 */
export default defineConfig({
  base: '/Converter-Public/',

  /**
   * @ffmpeg/ffmpeg spawns its own module worker with
   *   new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
   *
   * esbuild's dependency pre-bundling rewrites `import.meta.url`, which breaks
   * that lookup in dev. Excluding the packages keeps the ESM sources intact so
   * Vite's own worker-URL plugin can resolve and emit the worker properly.
   */
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },

  /**
   * The worker is instantiated with { type: 'module' }, so the emitted worker
   * bundle has to be an ES module. Inlining dynamic imports keeps it to a
   * single file, so there is no extra chunk to resolve at runtime.
   */
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },

  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    sourcemap: false,
  },

  server: {
    headers: {
      // Not required by the single-threaded core, but harmless and makes the
      // dev server match a cross-origin-isolated deployment if we ever test one.
      'Cache-Control': 'no-store',
    },
  },
});
