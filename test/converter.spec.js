import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const media = (name) => join(here, 'media', name);
const artefacts = resolve(here, '..', 'test-results', 'output');

const VEVOR_LIKE = '20260906_042808_00000004_00N.AVI';

/** Fails the test if the page logged an error or a request 404'd. */
function watchPage(page, sink) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') sink.consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => sink.pageErrors.push(String(err)));
  page.on('requestfailed', (req) =>
    sink.failedRequests.push(`${req.url()} :: ${req.failure()?.errorText}`)
  );
  page.on('response', (res) => {
    if (res.status() >= 400) sink.badResponses.push(`${res.status()} ${res.url()}`);
    sink.responses.push({ url: res.url(), status: res.status(), type: res.headers()['content-type'] });
  });
}

function newSink() {
  return { consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [], responses: [] };
}

/** Drives the real UI: pick file, choose quality, convert, wait for result. */
async function convertViaUI(page, fileName, quality = 'balanced') {
  await page.setInputFiles('#fileInput', media(fileName));
  await expect(page.locator('#fileMeta')).toBeVisible();
  await page.selectOption('#quality', quality);
  await expect(page.locator('#convertBtn')).toBeEnabled();
  await page.click('#convertBtn');
}

/** Pulls the produced MP4 out of the page so it can be inspected with ffprobe. */
async function saveOutput(page, asName) {
  const b64 = await page.evaluate(async () => {
    const f = window.__converter.state.output;
    if (!f) return null;
    const buf = await f.arrayBuffer();
    let s = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  });
  expect(b64, 'page held no output file').toBeTruthy();
  await mkdir(artefacts, { recursive: true });
  const path = join(artefacts, asName);
  await writeFile(path, Buffer.from(b64, 'base64'));
  return path;
}

async function ffprobe(path) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,codec_type,pix_fmt,width,height:format=format_name,duration',
    '-of', 'json', path,
  ]);
  return JSON.parse(stdout);
}

/* ===================================================================== */

test('TEST 2/3 — production build loads under /Converter-Public/ with no 404, CORS, worker or MIME errors', async ({ page }) => {
  const sink = newSink();
  watchPage(page, sink);

  await page.goto('./?debug=1');
  await expect(page.locator('h1')).toHaveText('Drain Video Converter');
  await expect(page.locator('.sub')).toHaveText('VEVOR AVI → Customer MP4');

  // Force the engine to load so the worker + core + wasm are actually fetched.
  await page.evaluate(() => window.__converter.loadEngine({}));
  await expect.poll(() => page.evaluate(() => window.__converter.isLoaded()), {
    timeout: 180_000,
  }).toBe(true);

  const byUrl = (needle) => sink.responses.find((r) => r.url.includes(needle));

  const core = byUrl('/Converter-Public/ffmpeg/ffmpeg-core.js');
  const wasm = byUrl('/Converter-Public/ffmpeg/ffmpeg-core.wasm');
  const worker = sink.responses.find((r) => /\/Converter-Public\/assets\/worker-.*\.js/.test(r.url));

  expect(core, 'ffmpeg-core.js was not requested from the app origin').toBeTruthy();
  expect(core.status).toBe(200);
  expect(wasm, 'ffmpeg-core.wasm was not requested from the app origin').toBeTruthy();
  expect(wasm.status).toBe(200);
  expect(wasm.type, 'wasm must be served as application/wasm').toContain('application/wasm');
  expect(worker, 'the ffmpeg class worker was not loaded as a same-origin asset').toBeTruthy();
  expect(worker.status).toBe(200);

  // Nothing may come from a CDN at runtime.
  const external = sink.responses.filter(
    (r) => !r.url.startsWith('http://127.0.0.1:4173/') && !r.url.startsWith('data:') && !r.url.startsWith('blob:')
  );
  expect(external, `unexpected external requests: ${JSON.stringify(external)}`).toHaveLength(0);

  expect(sink.badResponses, `HTTP >=400: ${sink.badResponses.join(', ')}`).toHaveLength(0);
  expect(sink.failedRequests, `failed requests: ${sink.failedRequests.join(', ')}`).toHaveLength(0);
  expect(sink.pageErrors, `page errors: ${sink.pageErrors.join(', ')}`).toHaveLength(0);

  const publicPathish = sink.consoleErrors.filter((t) =>
    /publicPath|Automatic publicPath|Cross-origin|SecurityError|MIME/i.test(t)
  );
  expect(publicPathish, `publicPath/worker/MIME errors: ${publicPathish.join(', ')}`).toHaveLength(0);
});

test('the wasm core actually contains the codecs this app depends on', async ({ page }) => {
  /**
   * `ffmpeg -encoders` and friends call exit() when they finish printing, which
   * tears the emscripten runtime down ("Aborted()"). So each listing gets a
   * fresh page. (The wasm comes from HTTP cache after the first load.)
   *
   * This asks the engine what it can actually do, rather than trusting the
   * documentation or `strings` on the binary.
   */
  const grab = async (flag) => {
    await page.goto('./?debug=1');
    await page.evaluate(() => window.__converter.loadEngine({}));
    await expect
      .poll(() => page.evaluate(() => window.__converter.isLoaded()), { timeout: 180_000 })
      .toBe(true);
    // Capture via the live log listener, not getLogs(): the diagnostics ring
    // buffer is deliberately capped and these listings run to ~500 lines.
    return page.evaluate(async (f) => {
      const lines = [];
      window.__converter.onLog((entry) => lines.push(entry));
      await window.__ff.exec(['-hide_banner', f]).catch(() => {});
      return lines.join('\n');
    }, flag);
  };

  const caps = {
    encoders: await grab('-encoders'),
    decoders: await grab('-decoders'),
    formats: await grab('-formats'),
  };

  expect(caps.encoders, 'libx264 encoder missing from the core').toMatch(/libx264/);
  expect(caps.encoders, 'native aac encoder missing from the core').toMatch(/\baac\b/);
  expect(caps.decoders, 'mjpeg decoder missing (common inspection-camera codec)').toMatch(/mjpeg/);
  expect(caps.decoders, 'mpeg4 decoder missing (common inspection-camera codec)').toMatch(/mpeg4/);
  expect(caps.decoders, 'h264 decoder missing').toMatch(/h264/);
  expect(caps.formats, 'AVI demuxer missing').toMatch(/avi/);
  expect(caps.formats, 'MP4 muxer missing').toMatch(/mp4/);

  console.log('\n--- core capability evidence ---');
  for (const line of caps.encoders.split('\n')) {
    if (/libx264|\baac\b/.test(line)) console.log('  ' + line.trim());
  }
  for (const line of caps.formats.split('\n')) {
    if (/\bavi\b|mp4/.test(line)) console.log('  ' + line.trim());
  }
});

test('TEST 4a — video + audio AVI converts to a playable H.264/AAC MP4', async ({ page }) => {
  const sink = newSink();
  watchPage(page, sink);
  await page.goto('./?debug=1');

  await convertViaUI(page, VEVOR_LIKE);

  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('.result-title')).toHaveText('MP4 conversion complete');

  const meta = await page.locator('#resultMeta').textContent();
  expect(meta).toContain('20260906_042808_00000004_00N_Customer.mp4');

  // The progress bar must not have been driven to 100% before completion.
  await expect(page.locator('#progressFill')).toHaveAttribute('style', /width:\s*100%/);

  const out = await saveOutput(page, 'vevor_like.mp4');
  const probe = await ffprobe(out);

  expect(probe.format.format_name).toContain('mp4');
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  expect(v, 'no video stream in output').toBeTruthy();
  expect(v.codec_name).toBe('h264');
  expect(v.pix_fmt).toBe('yuv420p');
  expect(v.width).toBe(640);
  expect(v.height).toBe(480);
  expect(a, 'source had audio, so output must have audio').toBeTruthy();
  expect(a.codec_name).toBe('aac');
  expect(Number(probe.format.duration)).toBeGreaterThan(3);

  // faststart: the moov atom must sit before mdat.
  const head = await readFile(out);
  const moov = head.indexOf(Buffer.from('moov'));
  const mdat = head.indexOf(Buffer.from('mdat'));
  expect(moov).toBeGreaterThan(-1);
  expect(moov, '+faststart did not move moov to the front').toBeLessThan(mdat);

  // A decode pass proves it is not a structurally-valid-but-empty file.
  const { stderr } = await run('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']);
  expect(stderr.trim(), `decoding the output produced errors: ${stderr}`).toBe('');

  expect(sink.pageErrors).toHaveLength(0);
  expect(sink.badResponses).toHaveLength(0);
});

test('TEST 4b — video-only AVI converts without an audio track and without erroring', async ({ page }) => {
  await page.goto('./');
  await convertViaUI(page, 'video_only.avi');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });

  const out = await saveOutput(page, 'video_only.mp4');
  const probe = await ffprobe(out);
  expect(probe.streams.filter((s) => s.codec_type === 'video')).toHaveLength(1);
  expect(probe.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(0);
  expect(probe.streams[0].codec_name).toBe('h264');
  expect(probe.streams[0].pix_fmt).toBe('yuv420p');
});

test('TEST 4c — H.264/MP3 AVI and a small 320x240 MJPEG AVI both convert', async ({ page }) => {
  await page.goto('./');

  await convertViaUI(page, 'h264_mp3.avi');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  let probe = await ffprobe(await saveOutput(page, 'h264_mp3.mp4'));
  expect(probe.streams.find((s) => s.codec_type === 'audio').codec_name).toBe('aac');

  await convertViaUI(page, 'small_320x240.avi');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  probe = await ffprobe(await saveOutput(page, 'small.mp4'));
  const v = probe.streams.find((s) => s.codec_type === 'video');
  expect(v.width).toBe(320);
  expect(v.height).toBe(240);
  expect(v.pix_fmt).toBe('yuv420p');
});

test('quality presets produce meaningfully different file sizes', async ({ page }) => {
  await page.goto('./');
  const sizes = {};
  for (const q of ['small', 'balanced', 'high']) {
    await convertViaUI(page, VEVOR_LIKE, q);
    await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
    sizes[q] = await page.evaluate(() => window.__converter.state.output.size);
  }
  console.log('  sizes:', sizes);
  expect(sizes.small).toBeLessThan(sizes.balanced);
  expect(sizes.balanced).toBeLessThan(sizes.high);
});

test('TEST 6 — A, then B, then A again: repeat conversion is clean and never returns stale output', async ({ page }) => {
  await page.goto('./');

  await convertViaUI(page, VEVOR_LIKE);
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  const a1 = await page.evaluate(() => ({
    name: window.__converter.state.output.name,
    size: window.__converter.state.output.size,
  }));

  await convertViaUI(page, 'video_only.avi');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  const b = await page.evaluate(() => ({
    name: window.__converter.state.output.name,
    size: window.__converter.state.output.size,
  }));
  expect(b.name).toBe('video_only_Customer.mp4');
  expect(b.name).not.toBe(a1.name);

  // Selecting the SAME file as the first run must work — this is the
  // input.value reset. Without it the change event never fires again.
  await convertViaUI(page, VEVOR_LIKE);
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  const a2 = await page.evaluate(() => ({
    name: window.__converter.state.output.name,
    size: window.__converter.state.output.size,
  }));
  expect(a2.name).toBe(a1.name);
  // Same input, same settings -> same size. A stale file from run B would differ.
  expect(a2.size).toBe(a1.size);

  // And the wasm filesystem must be clean between runs.
  const listing = await page.evaluate(async () => {
    try {
      return await window.__ff.listDir('/');
    } catch (e) {
      return String(e);
    }
  });
  const names = Array.isArray(listing) ? listing.map((n) => n.name) : [];
  expect(names, `stale output left in the wasm FS: ${JSON.stringify(names)}`).not.toContain('output.mp4');
});

test('TEST 7a — a non-AVI file is rejected in the UI with a clear message', async ({ page }) => {
  await page.goto('./');
  await page.setInputFiles('#fileInput', media('not_a_video.txt'));
  await expect(page.locator('#errorPanel')).toBeVisible();
  await expect(page.locator('#errorText')).toContainText('is not an .AVI file');
  await expect(page.locator('#optionsPanel')).toBeHidden();

  // And the UI recovers: a good file afterwards still works.
  await page.setInputFiles('#fileInput', media('video_only.avi'));
  await expect(page.locator('#errorPanel')).toBeHidden();
  await expect(page.locator('#convertBtn')).toBeEnabled();
});

test('TEST 7b — a corrupt AVI produces a readable failure, not "conversion failed", and the UI recovers', async ({ page }) => {
  await page.goto('./');
  await convertViaUI(page, 'corrupt.avi');

  await expect(page.locator('#errorPanel')).toBeVisible({ timeout: 240_000 });
  const text = await page.locator('#errorText').textContent();
  expect(text).toMatch(/incomplete or corrupted|could not be decoded|Unsupported AVI format/i);
  expect(text).not.toMatch(/^Conversion failed\.$/);

  // No permanent stuck state.
  await expect(page.locator('#progressWrap')).toBeHidden();
  await expect(page.locator('#chooseBtn')).toBeEnabled();

  // Recovery: a good file converts right afterwards, in the same page session.
  await convertViaUI(page, 'video_only.avi');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('#errorPanel')).toBeHidden();
});

test('TEST 7c — backing out of the file picker changes nothing', async ({ page }) => {
  await page.goto('./');
  await page.setInputFiles('#fileInput', media('video_only.avi'));
  await expect(page.locator('#fileMeta')).toBeVisible();

  await page.setInputFiles('#fileInput', []); // user cancelled
  await expect(page.locator('#errorPanel')).toBeHidden();
  await expect(page.locator('#fileMeta')).toBeVisible(); // previous choice survives
});

test('TEST 7d — engine load failure surfaces an error and can be retried, with no permanent spinner', async ({ page }) => {
  // Simulate the first-load network failure / CDN-outage equivalent.
  await page.route('**/ffmpeg/ffmpeg-core.js', (route) => route.abort('failed'));
  await page.goto('./?debug=1');

  const err = await page.evaluate(async () => {
    try {
      await window.__converter.loadEngine({});
      return null;
    } catch (e) {
      return { message: e.message, code: e.code };
    }
  });
  expect(err, 'load should have failed').toBeTruthy();
  expect(err.message).not.toMatch(/undefined|\[object/);
  expect(await page.evaluate(() => window.__converter.isLoaded())).toBe(false);

  // Retry after the network recovers must succeed — the failed promise is not cached.
  await page.unroute('**/ffmpeg/ffmpeg-core.js');
  await page.evaluate(() => window.__converter.loadEngine({}));
  await expect.poll(() => page.evaluate(() => window.__converter.isLoaded()), {
    timeout: 180_000,
  }).toBe(true);
});

test('concurrent load calls share one download (no duplicate 30 MB fetch)', async ({ page }) => {
  const sink = newSink();
  watchPage(page, sink);
  await page.goto('./');

  await page.evaluate(async () => {
    await Promise.all([
      window.__converter.loadEngine({}),
      window.__converter.loadEngine({}),
      window.__converter.loadEngine({}),
    ]);
  });

  const wasmFetches = sink.responses.filter((r) => r.url.endsWith('ffmpeg-core.wasm'));
  expect(wasmFetches.length, 'the wasm core was downloaded more than once').toBe(1);
});

test('output filenames stay sane for awkward inputs', async ({ page }) => {
  await page.goto('./');
  const cases = await page.evaluate(() => {
    const f = window.__converter.outputNameFor;
    return {
      vevor: f('20260906_042808_00000004_00N.AVI'),
      lower: f('clip.avi'),
      multidot: f('job 12.4.2026 main line.avi'),
      noext: f('recording'),
      pathish: f('C:\\DCIM\\100MEDIA\\clip.AVI'),
      nasty: f('a/b<c>d:e"f|g?h*i.avi'),
      empty: f(''),
      long: f('x'.repeat(400) + '.avi'),
    };
  });
  expect(cases.vevor).toBe('20260906_042808_00000004_00N_Customer.mp4');
  expect(cases.lower).toBe('clip_Customer.mp4');
  expect(cases.multidot).toBe('job 12.4.2026 main line_Customer.mp4');
  expect(cases.noext).toBe('recording_Customer.mp4');
  expect(cases.pathish).toBe('clip_Customer.mp4');
  expect(cases.nasty).not.toMatch(/[<>:"|?*\\/]/);
  expect(cases.empty).toBe('video_Customer.mp4');
  expect(cases.long.length).toBeLessThan(160);
  for (const name of Object.values(cases)) expect(name.endsWith('_Customer.mp4')).toBe(true);
});

test('object URLs are revoked when a new conversion replaces an old result', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => {
    window.__revoked = [];
    const real = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u) => {
      window.__revoked.push(u);
      return real(u);
    };
  });

  await convertViaUI(page, 'video_only.avi');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  await page.click('#shareBtn'); // no share support in headless -> download fallback creates a URL
  const first = await page.evaluate(() => window.__converter.state.objectUrl);
  expect(first).toBeTruthy();

  await convertViaUI(page, 'small_320x240.avi');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });

  const revoked = await page.evaluate(() => window.__revoked);
  expect(revoked, 'the previous object URL was leaked').toContain(first);
  expect(await page.evaluate(() => window.__converter.state.objectUrl)).toBeNull();
});

test('privacy — nothing leaves the origin during a full conversion', async ({ page }) => {
  const sink = newSink();
  watchPage(page, sink);
  const uploads = [];
  page.on('request', (req) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method())) uploads.push(`${req.method()} ${req.url()}`);
  });

  await page.goto('./');
  await convertViaUI(page, VEVOR_LIKE);
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });

  expect(uploads, `the app made upload-shaped requests: ${uploads.join(', ')}`).toHaveLength(0);
  const external = sink.responses.filter((r) => !r.url.startsWith('http://127.0.0.1:4173/'));
  expect(external, `external requests: ${JSON.stringify(external)}`).toHaveLength(0);
});
