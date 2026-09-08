import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const media = (name) => join(here, 'media', name);
const artefacts = resolve(here, '..', 'test-results', 'output');

const VEVOR_LIKE = '20260906_042808_00000004_00N.AVI';

/** Does this browser have an H.264 decoder at all? */
async function canPlayH264(page) {
  return page.evaluate(
    () => !!document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')
  );
}

/**
 * Convert through the UI, then open the report step.
 *
 * Playwright's Chromium is built without proprietary codecs, so it cannot
 * decode the H.264 MP4 the app produces. Frame capture itself is codec
 * agnostic — it is `drawImage(video)` — so where H.264 is unavailable the same
 * entry point is re-opened with a VP8 stand-in, which exercises every line of
 * the report code. That the real MP4 decodes is asserted separately, and only
 * where the browser can actually do it.
 */
async function toReportStep(page, fileName = VEVOR_LIKE) {
  await page.goto('./');
  await page.setInputFiles('#fileInput', media(fileName));
  await expect(page.locator('#fileMeta')).toBeVisible();
  await page.click('#convertBtn');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  await page.click('#startReportBtn');
  await expect(page.locator('#reportPanel')).toBeVisible();

  const nativeH264 = await canPlayH264(page);
  if (!nativeH264) {
    const b64 = (await readFile(media('preview_stand_in.webm'))).toString('base64');
    await page.evaluate((data) => {
      const bin = atob(data);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
      window.__report.openReport(new File([u8], 'preview.webm', { type: 'video/webm' }));
    }, b64);
  }

  await page.waitForFunction(
    () => {
      const v = document.getElementById('reportVideo');
      return v && v.readyState >= 2 && v.videoWidth > 0;
    },
    null,
    { timeout: 30_000 }
  );
  return nativeH264;
}

/** Seek the preview video and capture a still through the real button. */
async function captureAt(page, seconds) {
  await page.evaluate(async (t) => {
    const v = document.getElementById('reportVideo');
    v.currentTime = t;
    await new Promise((r) => {
      if (Math.abs(v.currentTime - t) < 0.05 && v.readyState >= 2) return r();
      v.addEventListener('seeked', r, { once: true });
      setTimeout(r, 3000);
    });
  }, seconds);
  const before = await page.locator('.shot').count();
  await page.click('#captureBtn');
  await expect(page.locator('.shot')).toHaveCount(before + 1);
}

async function savePdf(page, name) {
  const b64 = await page.evaluate(async () => {
    const f = window.__report.state().pdfFile;
    if (!f) return null;
    const b = new Uint8Array(await f.arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  });
  expect(b64, 'no PDF was produced').toBeTruthy();
  await mkdir(artefacts, { recursive: true });
  const p = join(artefacts, name);
  await writeFile(p, Buffer.from(b64, 'base64'));
  return p;
}

/** Extracts text with pdftotext if present, otherwise falls back to raw bytes. */
async function pdfText(path) {
  try {
    const { stdout } = await run('pdftotext', ['-layout', path, '-']);
    return stdout;
  } catch {
    return (await readFile(path)).toString('latin1');
  }
}

/* ===================================================================== */

test('the report step opens from a finished conversion, previewing from memory', async ({ page }) => {
  const nativeH264 = await toReportStep(page);
  const dims = await page.evaluate(() => {
    const v = document.getElementById('reportVideo');
    return { w: v.videoWidth, h: v.videoHeight, dur: +v.duration.toFixed(1), src: v.currentSrc.slice(0, 5) };
  });
  expect(dims.w).toBe(640);
  expect(dims.h).toBe(480);
  expect(dims.dur).toBeGreaterThan(3);
  // The preview comes from the file held in memory, never from a server.
  expect(dims.src).toBe('blob:');

  if (!nativeH264) {
    test.info().annotations.push({
      type: 'note',
      description:
        'This browser has no H.264 decoder, so the preview used a VP8 stand-in. ' +
        'MP4 playback is verified on a real browser instead.',
    });
  }
});

test('a preview the browser cannot decode disables capture and explains why', async ({ page }) => {
  await page.goto('./');
  await page.setInputFiles('#fileInput', media(VEVOR_LIKE));
  await expect(page.locator('#fileMeta')).toBeVisible();
  await page.click('#convertBtn');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  await page.click('#startReportBtn');

  // Hand the report a file no browser can decode.
  await page.evaluate(() => {
    window.__report.openReport(new File([new Uint8Array([1, 2, 3, 4, 5])], 'broken.mp4', { type: 'video/mp4' }));
  });

  await expect(page.locator('#captureBtn')).toBeDisabled({ timeout: 15_000 });
  await expect(page.locator('#reportHint')).toContainText('cannot play the converted video');

  // The rest of the report must still work — the text fields are the valuable part.
  await page.fill('#repAddress', '1 Undecodable Way');
  await page.click('#makePdfBtn');
  await expect(page.locator('#pdfPanel')).toBeVisible({ timeout: 60_000 });
});

test('capturing stills produces real, distinct images from the chosen moments', async ({ page }) => {
  await toReportStep(page);
  await captureAt(page, 0.5);
  await captureAt(page, 2.5);

  const shots = await page.evaluate(() =>
    window.__report.state().report.findings.map((f) => ({
      t: +f.timeSec.toFixed(2),
      w: f.width,
      h: f.height,
      isJpeg: f.dataUrl.startsWith('data:image/jpeg;base64,'),
      len: f.dataUrl.length,
    }))
  );

  expect(shots).toHaveLength(2);
  for (const s of shots) {
    expect(s.isJpeg).toBe(true);
    expect(s.w).toBe(640);
    expect(s.h).toBe(480);
    // A blank/black frame compresses to almost nothing; real content does not.
    expect(s.len).toBeGreaterThan(5000);
  }
  expect(shots[1].t).toBeGreaterThan(shots[0].t);

  // Two different moments must not yield an identical image — that would mean
  // the seek/draw race is capturing a stale frame, which is the classic iOS bug.
  const identical = await page.evaluate(() => {
    const f = window.__report.state().report.findings;
    return f[0].dataUrl === f[1].dataUrl;
  });
  expect(identical, 'both captures returned the same frame').toBe(false);
});

test('a full report generates a valid, readable PDF containing the entered details', async ({ page }) => {
  await toReportStep(page);
  await captureAt(page, 1.0);
  await captureAt(page, 3.0);

  await page.fill('#repAddress', '742 Evergreen Terrace, Winter Park FL');
  await page.fill('#repCustomer', 'M. Simpson');
  await page.fill('#repTech', 'A. Wilson');
  await page.fill('#repRec', 'Roots re-entering at the clay joint. Recommend hydro-jetting and a follow-up camera run in 12 months.');
  await page.click('#lineTypeChips .chip:has-text("Main sewer line")');
  await page.click('#conditionChips .chip:has-text("Repair recommended")');
  await page.click('.shot:first-child .chip:has-text("Roots")');
  await page.click('.shot:first-child .chip:has-text("Offset joint")');
  await page.fill('.shot:first-child .shot-note', 'Approx 42 ft from cleanout.');

  await page.click('#makePdfBtn');
  await expect(page.locator('#pdfPanel')).toBeVisible({ timeout: 60_000 });

  const path = await savePdf(page, 'inspection-report.pdf');
  const head = (await readFile(path)).subarray(0, 5).toString('latin1');
  expect(head, 'not a PDF').toBe('%PDF-');

  const text = await pdfText(path);
  expect(text).toContain('Axis Drain Solutions');
  expect(text).toContain('407-630-1264');
  expect(text).toContain('742 Evergreen Terrace');
  expect(text).toContain('M. Simpson');
  expect(text).toContain('Main sewer line');
  expect(text).toContain('Repair recommended');
  expect(text).toContain('Roots');
  expect(text).toContain('Offset joint');
  expect(text).toContain('42 ft from cleanout');
  expect(text).toMatch(/Sewer & Drain Camera Inspection|Sewer .{0,3} Drain Camera Inspection/);

  // It must NOT claim a licence Andrew does not yet hold.
  expect(text).toContain('Insured');
  expect(text, 'the report must not claim to be licensed').not.toMatch(/\blicen[cs]ed\b/i);

  const meta = await page.locator('#pdfMeta').textContent();
  expect(meta).toContain('Inspection Report.pdf');
});

test('a report with no stills still produces a valid PDF', async ({ page }) => {
  await toReportStep(page);
  await page.fill('#repAddress', '11 Cleanout Way');
  await page.click('#conditionChips .chip:has-text("Clear")');
  await page.click('#makePdfBtn');
  await expect(page.locator('#pdfPanel')).toBeVisible({ timeout: 60_000 });

  const path = await savePdf(page, 'report-no-stills.pdf');
  expect((await readFile(path)).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const text = await pdfText(path);
  expect(text).toContain('11 Cleanout Way');
  expect(text).toContain('Clear');
});

test('the report refuses to build with no address or customer, and says why', async ({ page }) => {
  await toReportStep(page);
  await page.click('#makePdfBtn');
  await expect(page.locator('#reportHint')).toContainText('service address or customer');
  await expect(page.locator('#pdfPanel')).toBeHidden();

  // ...and works as soon as one is supplied.
  await page.fill('#repCustomer', 'J. Doe');
  await page.click('#makePdfBtn');
  await expect(page.locator('#pdfPanel')).toBeVisible({ timeout: 60_000 });
});

test('stills can be removed, and removal is reflected in the PDF', async ({ page }) => {
  await toReportStep(page);
  await captureAt(page, 1.0);
  await captureAt(page, 2.0);
  await expect(page.locator('.shot')).toHaveCount(2);

  await page.click('.shot:first-child .shot-remove');
  await expect(page.locator('.shot')).toHaveCount(1);

  await page.fill('#repAddress', '9 Removal Road');
  await page.click('#makePdfBtn');
  await expect(page.locator('#pdfPanel')).toBeVisible({ timeout: 60_000 });

  const count = await page.evaluate(() => window.__report.state().report.findings.length);
  expect(count).toBe(1);
});

test('job details persist between reports, but findings never do', async ({ page }) => {
  await toReportStep(page);
  await page.fill('#repAddress', '5 Repeat Street');
  await page.fill('#repTech', 'A. Wilson');
  await captureAt(page, 1.0);
  await expect(page.locator('.shot')).toHaveCount(1);

  // Convert a different file, which tears the report down, then reopen.
  await page.setInputFiles('#fileInput', media('video_only.avi'));
  await expect(page.locator('#reportPanel')).toBeHidden();
  await page.click('#convertBtn');
  await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 240_000 });
  await page.click('#startReportBtn');
  await expect(page.locator('#reportPanel')).toBeVisible();

  // Retyping the technician on every job would be maddening; carrying stills
  // from a different pipe into a new report would be wrong.
  await expect(page.locator('#repTech')).toHaveValue('A. Wilson');
  await expect(page.locator('#repAddress')).toHaveValue('5 Repeat Street');
  await expect(page.locator('.shot')).toHaveCount(0);
});

test('starting a new conversion tears the report down and frees its video URL', async ({ page }) => {
  await toReportStep(page);
  await page.evaluate(() => {
    window.__revoked = [];
    const real = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u) => {
      window.__revoked.push(u);
      return real(u);
    };
  });
  const url = await page.evaluate(() => document.getElementById('reportVideo').currentSrc);

  await page.setInputFiles('#fileInput', media('video_only.avi'));
  await expect(page.locator('#reportPanel')).toBeHidden();

  const revoked = await page.evaluate(() => window.__revoked);
  expect(revoked, 'the report video URL was leaked').toContain(url);
});

test('the PDF library is not downloaded until a report is actually built', async ({ page }) => {
  const asked = [];
  page.on('request', (r) => {
    if (/jspdf/i.test(r.url())) asked.push(r.url());
  });

  await toReportStep(page);
  expect(asked, 'jsPDF loaded before it was needed').toHaveLength(0);

  await page.fill('#repAddress', '1 Lazy Load Lane');
  await page.click('#makePdfBtn');
  await expect(page.locator('#pdfPanel')).toBeVisible({ timeout: 60_000 });
  expect(asked.length, 'jsPDF was never fetched').toBeGreaterThan(0);
});

test('privacy — building a report sends nothing off-origin', async ({ page }) => {
  const external = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('http://127.0.0.1:4173/') && !u.startsWith('blob:') && !u.startsWith('data:')) {
      external.push(`${r.method()} ${u}`);
    }
  });

  await toReportStep(page);
  await captureAt(page, 1.0);
  await page.fill('#repAddress', '3 Private Close');
  await page.click('#makePdfBtn');
  await expect(page.locator('#pdfPanel')).toBeVisible({ timeout: 60_000 });

  expect(external, `report step made off-origin requests: ${external.join(', ')}`).toHaveLength(0);
});

test('capture still works when the page is hidden — it must never hang silently', async ({ page }) => {
  await toReportStep(page);

  // requestAnimationFrame does not fire while a page is hidden. captureFrame
  // used to await one, which hung forever with no error and no message.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    window.requestAnimationFrame = () => 0; // never calls back, exactly as when hidden
    const v = document.getElementById('reportVideo');
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback = () => 0;
  });

  await page.click('#captureBtn');
  await expect(page.locator('.shot')).toHaveCount(1, { timeout: 10_000 });

  const shot = await page.evaluate(() => {
    const f = window.__report.state().report.findings[0];
    return { isJpeg: f.dataUrl.startsWith('data:image/jpeg'), len: f.dataUrl.length, w: f.width };
  });
  expect(shot.isJpeg).toBe(true);
  expect(shot.w).toBe(640);
  expect(shot.len).toBeGreaterThan(5000);
});
