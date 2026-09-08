/**
 * FFmpeg service.
 *
 * Everything that touches ffmpeg.wasm lives here. The UI layer in main.js never
 * imports @ffmpeg/* directly.
 *
 * Loading strategy (this is the part that used to break):
 *
 *   @ffmpeg/ffmpeg@0.12.15 always spawns its own worker as
 *       new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
 *   Vite resolves that URL at build time and emits the worker as a real,
 *   same-origin asset under the site's base path. Nothing is fetched from a CDN,
 *   nothing is wrapped in a Blob URL, and no publicPath is ever inferred at
 *   runtime — which is what the previous UMD-from-unpkg build was doing when it
 *   failed.
 *
 *   Inside that module worker, ffmpeg's own worker.js first tries
 *   importScripts(coreURL). importScripts does not exist in a module worker, so
 *   it throws and the code falls through to `await import(coreURL)`. That is why
 *   coreURL must point at the ESM core (which has `export default
 *   createFFmpegCore`) and not the UMD core.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const BASE = import.meta.env.BASE_URL; // '/Converter-Public/' in production

/** Absolute, same-origin URLs. Resolved once so they appear verbatim in devtools. */
export const CORE_URL = new URL(`${BASE}ffmpeg/ffmpeg-core.js`, location.href).href;
export const WASM_URL = new URL(`${BASE}ffmpeg/ffmpeg-core.wasm`, location.href).href;

const LOAD_TIMEOUT_MS = 180_000; // generous: the wasm core is ~32 MB
const MOUNT_DIR = '/mnt';
const OUTPUT_NAME = 'output.mp4';
const LOG_RING = 400;

export const QUALITY_PRESETS = {
  balanced: { label: 'Customer — Best Balance', crf: '23', preset: 'veryfast', audioBitrate: '128k' },
  high: { label: 'Higher Quality — Larger File', crf: '20', preset: 'faster', audioBitrate: '160k' },
  small: { label: 'Smaller File — Lower Quality', crf: '30', preset: 'veryfast', audioBitrate: '96k' },
};

/* ------------------------------------------------------------------ state - */

let ffmpeg = null;
let loadPromise = null;

/** Last N ffmpeg log lines, for diagnostics and for explaining failures. */
const logBuffer = [];
/** Where progress events go right now (null = ignore them). */
let progressSink = null;
let logListener = null;

function pushLog(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_RING) logBuffer.shift();
  if (logListener) logListener(entry);
}

export function onLog(fn) {
  logListener = fn;
}

export function getLogs() {
  return logBuffer.slice();
}

export function isLoaded() {
  return ffmpeg !== null;
}

/* ------------------------------------------------------------------- load - */

/**
 * Loads the engine at most once. Concurrent callers share one promise, so no
 * amount of button-mashing can start a second 32 MB download.
 * On failure the promise is discarded so the user can retry.
 */
export function loadEngine({ onStatus = () => {} } = {}) {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    onStatus('Preparing video converter…');
    const instance = new FFmpeg();

    instance.on('log', ({ type, message }) => pushLog(`[${type}] ${message}`));
    instance.on('progress', (ev) => {
      if (progressSink) progressSink(ev);
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

    onStatus('Downloading converter engine…');
    try {
      await instance.load({ coreURL: CORE_URL, wasmURL: WASM_URL }, { signal: controller.signal });
    } catch (err) {
      try {
        instance.terminate();
      } catch {
        /* the worker may never have started */
      }
      throw describeLoadFailure(err);
    } finally {
      clearTimeout(timer);
    }

    ffmpeg = instance;
    onStatus('Converter ready.');
    return instance;
  })();

  loadPromise.catch(() => {
    // Allow a retry on the next user action.
    loadPromise = null;
    ffmpeg = null;
  });

  return loadPromise;
}

function describeLoadFailure(err) {
  const raw = String(err && err.message ? err.message : err);

  if (/abort/i.test(raw)) {
    return new ConverterError(
      'The converter engine took too long to download. Check your connection and try again.',
      'ENGINE_TIMEOUT',
      raw
    );
  }
  if (!navigator.onLine) {
    return new ConverterError(
      'You appear to be offline. The converter engine has to download once before the first conversion.',
      'ENGINE_OFFLINE',
      raw
    );
  }
  if (/import|module|worker/i.test(raw)) {
    return new ConverterError(
      'This browser could not start the converter engine. iOS 16.4 or newer is required.',
      'ENGINE_UNSUPPORTED',
      raw
    );
  }
  return new ConverterError(
    'The converter engine failed to load. Please reload the page and try again.',
    'ENGINE_LOAD_FAILED',
    raw
  );
}

/* ------------------------------------------------------------------ errors */

export class ConverterError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'ConverterError';
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------- filesystem */

/**
 * Removes anything a previous conversion left behind. Called before every run
 * so a stale output.mp4 can never be handed back as a fresh result.
 */
async function resetFilesystem() {
  if (!ffmpeg) return;
  try {
    await ffmpeg.unmount(MOUNT_DIR);
  } catch {
    /* not mounted */
  }
  for (const path of [OUTPUT_NAME, 'input.avi']) {
    try {
      await ffmpeg.deleteFile(path);
    } catch {
      /* not present */
    }
  }
}

/**
 * Makes the source readable by FFmpeg.
 *
 * Preferred: WORKERFS, which exposes the File to the wasm filesystem lazily via
 * FileReaderSync. The bytes are read on demand, so a 400 MB AVI never exists as
 * a JS array, a structured-clone copy and a heap copy at the same time — which
 * is the usual way a phone runs out of memory here.
 *
 * Fallback: read the file and write it into MEMFS. Costs roughly 3x the file
 * size in peak memory, but works if WORKERFS is unavailable.
 */
async function stageInput(file, onStatus) {
  onStatus('Reading AVI…');

  try {
    await ffmpeg.createDir(MOUNT_DIR);
  } catch {
    /* already exists */
  }

  let mounted = false;
  try {
    mounted = await ffmpeg.mount('WORKERFS', { files: [file] }, MOUNT_DIR);
  } catch (err) {
    pushLog(`[app] WORKERFS mount threw: ${err && err.message}`);
    mounted = false;
  }

  if (mounted) {
    pushLog('[app] input staged via WORKERFS (no copy)');
    return { path: `${MOUNT_DIR}/${file.name}`, mode: 'WORKERFS' };
  }

  pushLog('[app] WORKERFS unavailable, falling back to MEMFS writeFile');
  const bytes = await fetchFile(file);
  await ffmpeg.writeFile('input.avi', bytes);
  return { path: 'input.avi', mode: 'MEMFS' };
}

/* -------------------------------------------------------------------- probe */

/**
 * Runs `ffmpeg -i <input>` with no output. FFmpeg prints the container and
 * stream layout, then exits non-zero because no output was given — that is
 * expected and not an error. Parsing this is what lets us say "unsupported AVI
 * format" instead of "conversion failed", and lets us report the source codec
 * in diagnostics when a real VEVOR file eventually misbehaves.
 */
async function probeInput(inputPath) {
  const start = logBuffer.length;
  progressSink = null;
  try {
    await ffmpeg.exec(['-hide_banner', '-i', inputPath]);
  } catch (err) {
    pushLog(`[app] probe exec threw: ${err && err.message}`);
  }
  const lines = logBuffer.slice(start);
  return parseProbe(lines);
}

export function parseProbe(lines) {
  const text = lines.join('\n');
  const info = {
    container: null,
    durationSeconds: null,
    video: null,
    audio: null,
    hasVideo: false,
    hasAudio: false,
    raw: text,
  };

  const container = text.match(/Input #0,\s*([^,]+),\s*from/);
  if (container) info.container = container[1].trim();

  const duration = text.match(/Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  if (duration) {
    info.durationSeconds =
      Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  }

  for (const m of text.matchAll(/Stream #\d+:\d+[^:]*:\s*(Video|Audio):\s*([^\s,(]+)([^\n]*)/g)) {
    const kind = m[1];
    const codec = m[2];
    const rest = m[3] || '';
    if (kind === 'Video' && !info.video) {
      info.hasVideo = true;
      const size = rest.match(/(\d{2,5})x(\d{2,5})/);
      const fps = rest.match(/([\d.]+)\s*fps/);
      info.video = {
        codec,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        fps: fps ? Number(fps[1]) : null,
      };
    } else if (kind === 'Audio' && !info.audio) {
      info.hasAudio = true;
      const rate = rest.match(/(\d{3,6})\s*Hz/);
      info.audio = { codec, sampleRate: rate ? Number(rate[1]) : null };
    }
  }

  // Failure signatures worth translating into plain language.
  if (/Invalid data found when processing input/i.test(text)) info.fatal = 'INVALID_DATA';
  else if (/moov atom not found/i.test(text)) info.fatal = 'TRUNCATED';
  else if (/(Decoder .* not found|Unknown decoder|Decoder not found)/i.test(text))
    info.fatal = 'NO_DECODER';
  else if (/No such file or directory/i.test(text)) info.fatal = 'NO_FILE';

  return info;
}

function probeToError(info) {
  switch (info.fatal) {
    case 'INVALID_DATA':
    case 'TRUNCATED':
      return new ConverterError(
        'This file could not be read. It may be incomplete or corrupted — try copying it off the camera again.',
        'CORRUPT_INPUT',
        info.raw.slice(-2000)
      );
    case 'NO_DECODER':
      return new ConverterError(
        `Unsupported AVI format${info.video ? ` (video codec: ${info.video.codec})` : ''}. This converter cannot decode this recording.`,
        'UNSUPPORTED_CODEC',
        info.raw.slice(-2000)
      );
    case 'NO_FILE':
      return new ConverterError(
        'The selected file could not be opened. Please choose it again.',
        'INPUT_UNREADABLE',
        info.raw.slice(-2000)
      );
    default:
      break;
  }
  if (!info.hasVideo) {
    return new ConverterError(
      'No video track was found in this file. Please choose a different recording.',
      'NO_VIDEO_STREAM',
      info.raw.slice(-2000)
    );
  }
  return null;
}

/* ------------------------------------------------------------------ convert */

function buildArgs(inputPath, info, quality) {
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced;

  const args = [
    '-hide_banner',
    // INPUT options must precede -i. Cheap cameras often write sloppy or
    // missing presentation timestamps; regenerating them here stops players
    // from reporting a bogus duration or stalling on the first frames.
    '-fflags',
    '+genpts',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    // The '?' makes the audio map optional, so a video-only AVI is not an error.
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    preset.preset,
    '-crf',
    preset.crf,
    '-pix_fmt',
    'yuv420p',
    // yuv420p needs even dimensions. Some inspection cameras record odd sizes,
    // which otherwise fails with "width not divisible by 2".
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-movflags',
    '+faststart',
    '-avoid_negative_ts',
    'make_zero',
  ];

  if (info.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', preset.audioBitrate, '-ac', '2');
  }

  args.push(OUTPUT_NAME);
  return args;
}

/**
 * Full pipeline: stage -> probe -> encode -> read -> clean up.
 * Returns { file, info, args, durationMs }.
 */
export async function convert(file, { quality = 'balanced', onStatus = () => {}, onProgress = () => {} } = {}) {
  if (!ffmpeg) throw new ConverterError('The converter engine is not loaded.', 'NOT_LOADED');

  const started = Date.now();
  await resetFilesystem();

  let staged = null;
  try {
    staged = await stageInput(file, onStatus);

    onStatus('Checking video…');
    const info = await probeInput(staged.path);
    const probeError = probeToError(info);
    if (probeError) throw probeError;

    const args = buildArgs(staged.path, info, quality);
    pushLog(`[app] ffmpeg ${args.join(' ')}`);

    onStatus('Converting video…');
    // Progress is documented as experimental, so it is treated as decoration:
    // it is clamped below 100% and the UI never uses it to decide completion.
    progressSink = ({ progress }) => {
      if (typeof progress === 'number' && isFinite(progress)) {
        onProgress(Math.max(0, Math.min(0.99, progress)));
      }
    };

    const exitCode = await ffmpeg.exec(args);
    progressSink = null;

    if (exitCode !== 0) {
      throw explainExecFailure(exitCode, info);
    }

    onStatus('Preparing MP4…');
    const data = await ffmpeg.readFile(OUTPUT_NAME);
    if (!data || data.length === 0) {
      throw new ConverterError(
        'The conversion produced an empty file. The source recording may be unreadable.',
        'EMPTY_OUTPUT'
      );
    }

    const outputFile = new File([data], outputNameFor(file.name), { type: 'video/mp4' });
    return { file: outputFile, info, args, durationMs: Date.now() - started };
  } finally {
    progressSink = null;
    // Always clean up, including on failure, so the next run starts empty and
    // the wasm heap is not holding a copy of the last video.
    await resetFilesystem();
    if (staged) staged = null;
  }
}

function explainExecFailure(exitCode, info) {
  const tail = logBuffer.slice(-60).join('\n');

  if (/Unknown encoder 'libx264'|Unknown encoder "libx264"/.test(tail)) {
    return new ConverterError(
      'This build of the converter is missing the H.264 encoder. Please report this.',
      'NO_X264',
      tail
    );
  }
  if (/Invalid data found when processing input/i.test(tail)) {
    return new ConverterError(
      'The recording could not be decoded — the file may be incomplete or corrupted.',
      'CORRUPT_INPUT',
      tail
    );
  }
  if (/(Decoder .* not found|Unknown decoder|Automatic encoder selection failed|Could not find codec)/i.test(tail)) {
    return new ConverterError(
      `Unsupported AVI format${info && info.video ? ` (video codec: ${info.video.codec})` : ''}.`,
      'UNSUPPORTED_CODEC',
      tail
    );
  }
  if (/(out of memory|Cannot enlarge memory|allocation failed|OOM)/i.test(tail)) {
    return new ConverterError(
      'This device ran out of memory converting this video. Try a shorter recording.',
      'OUT_OF_MEMORY',
      tail
    );
  }
  return new ConverterError(
    `Conversion failed (FFmpeg exit code ${exitCode}).`,
    'EXEC_FAILED',
    tail
  );
}

/* ----------------------------------------------------------------- naming - */

/**
 * "20260906_042808_00000004_00N.AVI" -> "20260906_042808_00000004_00N_Customer.mp4"
 * Handles no-extension, multi-dot, path-ish and empty names without producing
 * something the Share Sheet or Files app will choke on.
 */
export function outputNameFor(inputName) {
  const base = String(inputName || 'video')
    .split(/[\\/]/)
    .pop();
  const stem = base.replace(/\.[^.]*$/, '') || 'video';
  const safe = stem
    .replace(/[ -<>:"|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return `${safe || 'video'}_Customer.mp4`;
}

/* ------------------------------------------------------------ diagnostics - */

export async function getDiagnostics() {
  let coreManifest = null;
  try {
    const res = await fetch(`${BASE}ffmpeg/core-manifest.json`, { cache: 'no-store' });
    if (res.ok) coreManifest = await res.json();
  } catch {
    /* optional */
  }
  return {
    userAgent: navigator.userAgent,
    baseUrl: BASE,
    coreURL: CORE_URL,
    wasmURL: WASM_URL,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : null,
    moduleWorkers: supportsModuleWorker(),
    wasmSimd: null, // filled in by the caller if probed
    engineLoaded: isLoaded(),
    canShareFiles: typeof navigator.canShare === 'function',
    coreManifest,
  };
}

function supportsModuleWorker() {
  let ok = false;
  try {
    const url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
    // Reading `type` is enough: browsers that ignore module workers never read it.
    new Worker(url, {
      get type() {
        ok = true;
        return 'module';
      },
    }).terminate();
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
  return ok;
}

/** Test-only escape hatch: the raw FFmpeg instance, for capability probing. */
export function _rawInstance() {
  return ffmpeg;
}

/** Exposed for the failure-path test: forget the loaded engine. */
export function _resetForTests() {
  try {
    if (ffmpeg) ffmpeg.terminate();
  } catch {
    /* ignore */
  }
  ffmpeg = null;
  loadPromise = null;
  logBuffer.length = 0;
}
