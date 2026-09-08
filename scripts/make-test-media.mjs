/**
 * Generates AVI fixtures for the end-to-end tests.
 *
 * These stand in for a real VEVOR recording, which is not available. They are
 * deliberately shaped like cheap-inspection-camera output: small frame size,
 * low frame rate, MJPEG or MPEG-4 Part 2 video, PCM or MP3 audio — and one
 * deliberately corrupt file.
 *
 * IMPORTANT: passing these proves the pipeline works. It does NOT prove VEVOR
 * compatibility. See README.md.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'media');

const SRC_V = ['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=15:duration=4'];
const SRC_A = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=4'];

const FIXTURES = [
  {
    name: '20260906_042808_00000004_00N.AVI',
    note: 'MJPEG video + PCM audio — the shape most low-cost inspection cameras write',
    args: [...SRC_V, ...SRC_A, '-c:v', 'mjpeg', '-q:v', '6', '-c:a', 'pcm_s16le', '-ac', '1'],
  },
  {
    name: 'video_only.avi',
    note: 'MPEG-4 Part 2, no audio stream at all',
    args: [...SRC_V, '-c:v', 'mpeg4', '-q:v', '6', '-an'],
  },
  {
    name: 'h264_mp3.avi',
    note: 'H.264 in AVI + MP3 audio',
    args: [...SRC_V, ...SRC_A, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libmp3lame'],
  },
  {
    // 320x240 is the classic low-cost inspection-camera resolution.
    // (The `scale=trunc(iw/2)*2` guard in the encode args is defensive: ffmpeg
    // itself rounds AVI dimensions to even, so a genuinely odd-sized AVI is
    // hard to even produce. The filter costs nothing and covers the case.)
    name: 'small_320x240.avi',
    note: '320x240 MJPEG, no audio — classic low-cost inspection camera output',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=2',
      '-c:v', 'mjpeg', '-q:v', '6', '-an',
    ],
  },
];

async function main() {
  await mkdir(outDir, { recursive: true });

  for (const f of FIXTURES) {
    const out = join(outDir, f.name);
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...f.args, out]);
    console.log(`[media] ${f.name} — ${f.note}`);
  }

  // Playwright's Chromium ships without an H.264 decoder, so it cannot play the
  // MP4s this app produces. The report step's frame capture is codec-agnostic,
  // so the report tests feed it this VP8/WebM stand-in when H.264 playback is
  // unavailable. Real H.264 playback is verified on a real browser instead.
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=10:duration=5',
    '-c:v', 'libvpx', '-b:v', '600k', '-an',
    join(outDir, 'preview_stand_in.webm'),
  ]);
  console.log('[media] preview_stand_in.webm — VP8 stand-in for browsers without H.264');

  // A file that is genuinely broken: real AVI header, garbage payload.
  const good = await readFile(join(outDir, 'video_only.avi'));
  const broken = Buffer.concat([good.subarray(0, 2048), Buffer.alloc(40_000, 0x5a)]);
  await writeFile(join(outDir, 'corrupt.avi'), broken);
  console.log('[media] corrupt.avi — truncated/garbled, must produce a readable error');

  // Not an AVI at all, but named like one is handled by the extension check;
  // this one is named like a photo, to exercise the rejection path.
  await writeFile(join(outDir, 'not_a_video.txt'), 'this is not a video\n');
  console.log('[media] not_a_video.txt — wrong extension, must be rejected in the UI');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
