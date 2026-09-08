import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const bigPath = join(here, 'media', 'big_720p_45s.avi');

/**
 * The real VEVOR file is ~15 MB, but the brief says not to assume that. This
 * builds a deliberately larger 720p/45s AVI (~60 MB) and converts it through
 * the real UI, then reports throughput and peak JS heap.
 *
 * Note: a desktop Chromium has far more headroom than an iPhone. This test
 * exists to prove the file is not copied several times and that the pipeline
 * scales past the sample size — not to certify any particular size on iOS.
 */
test.beforeAll(async () => {
  await mkdir(dirname(bigPath), { recursive: true });
  try {
    await stat(bigPath);
  } catch {
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=45',
      '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=8000:duration=45',
      '-c:v', 'mjpeg', '-q:v', '4', '-c:a', 'pcm_s16le', '-ac', '1',
      bigPath,
    ]);
  }
});

test('a ~60 MB AVI converts, is staged without copying, and does not balloon the JS heap', async ({ page }) => {
  test.setTimeout(600_000);

  await page.goto('./?debug=1');

  await page.setInputFiles('#fileInput', bigPath);
  await expect(page.locator('#fileMeta')).toBeVisible();
  await expect(page.locator('#fileMeta')).toContainText('MB');

  const t0 = Date.now();
  await page.click('#convertBtn');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 540_000 });
  const elapsed = Date.now() - t0;

  const logs = await page.evaluate(() => window.__converter.getLogs().join('\n'));

  // The input must have been exposed through WORKERFS, i.e. read lazily from
  // the File rather than copied into a JS array and then into the wasm heap.
  expect(logs, 'input was copied into MEMFS instead of mounted via WORKERFS').toContain(
    'input staged via WORKERFS (no copy)'
  );

  const out = await page.evaluate(() => ({
    name: window.__converter.state.output.name,
    size: window.__converter.state.output.size,
  }));
  const src = await stat(bigPath);

  expect(out.name).toBe('big_720p_45s_Customer.mp4');
  expect(out.size).toBeGreaterThan(100_000);

  const heap = await page.evaluate(() =>
    performance.memory ? performance.memory.usedJSHeapSize : null
  );

  console.log(
    `  input ${(src.size / 1e6).toFixed(1)} MB -> output ${(out.size / 1e6).toFixed(1)} MB ` +
      `in ${(elapsed / 1000).toFixed(1)}s` +
      (heap ? `, JS heap after ${(heap / 1e6).toFixed(1)} MB` : '')
  );

  // The main thread should not be holding anything like a copy of the input.
  if (heap) expect(heap).toBeLessThan(src.size);
});
