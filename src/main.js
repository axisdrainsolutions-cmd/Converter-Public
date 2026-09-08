import './style.css';
import {
  loadEngine,
  convert,
  isLoaded,
  getLogs,
  onLog,
  getDiagnostics,
  ConverterError,
  outputNameFor,
  _rawInstance,
} from './converter.js';
import { initReportUI, openReport, releaseReport, _reportState } from './report-ui.js';

const $ = (id) => document.getElementById(id);

const el = {
  fileInput: $('fileInput'),
  chooseBtn: $('chooseBtn'),
  fileMeta: $('fileMeta'),
  optionsPanel: $('optionsPanel'),
  quality: $('quality'),
  convertBtn: $('convertBtn'),
  progressWrap: $('progressWrap'),
  progressBar: $('progressBar'),
  progressFill: $('progressFill'),
  status: $('status'),
  resultPanel: $('resultPanel'),
  resultMeta: $('resultMeta'),
  shareBtn: $('shareBtn'),
  shareHint: $('shareHint'),
  errorPanel: $('errorPanel'),
  errorText: $('errorText'),
  retryBtn: $('retryBtn'),
  debugPanel: $('debugPanel'),
  debugInfo: $('debugInfo'),
  debugLog: $('debugLog'),
  copyDebugBtn: $('copyDebugBtn'),
  startReportBtn: $('startReportBtn'),
};

const DEBUG = new URLSearchParams(location.search).has('debug');

/** @type {{ source: File|null, output: File|null, objectUrl: string|null, busy: boolean }} */
const state = {
  source: null,
  output: null,
  objectUrl: null,
  busy: false,
};

/* --------------------------------------------------------------- helpers - */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function setStatus(text) {
  el.status.textContent = text || '';
}

function showError(message) {
  el.errorText.textContent = message;
  el.errorPanel.hidden = false;
}

function clearError() {
  el.errorPanel.hidden = true;
  el.errorText.textContent = '';
}

/** Determinate progress. `null` switches the bar to the indeterminate state. */
function setProgress(fraction) {
  el.progressWrap.hidden = false;
  if (fraction === null) {
    el.progressBar.classList.add('indeterminate');
    el.progressBar.removeAttribute('aria-valuenow');
    el.progressFill.style.width = '';
    return;
  }
  el.progressBar.classList.remove('indeterminate');
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  el.progressFill.style.width = `${pct}%`;
  el.progressBar.setAttribute('aria-valuenow', String(pct));
}

function hideProgress() {
  el.progressWrap.hidden = true;
  el.progressBar.classList.remove('indeterminate');
  el.progressFill.style.width = '0%';
}

/** Frees the previous download URL before a new one is made, and on replacement. */
function releaseOutput() {
  // The report is built from the current MP4, so it must not outlive it.
  releaseReport();
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
  state.output = null;
  el.resultPanel.hidden = true;
  el.resultMeta.textContent = '';
  el.shareHint.textContent = '';
}

function setBusy(busy) {
  state.busy = busy;
  el.convertBtn.disabled = busy || !state.source;
  el.quality.disabled = busy;
  el.fileInput.disabled = busy;
  el.chooseBtn.disabled = busy;
  el.chooseBtn.textContent = busy
    ? 'Working…'
    : state.source
      ? 'Choose a Different Video'
      : 'Choose AVI Video';
}

/* ------------------------------------------------------------ file select - */

el.fileInput.addEventListener('change', (event) => {
  const input = event.currentTarget;
  const file = input.files && input.files[0];

  // Clearing the value immediately means picking the SAME file again still
  // fires `change`. The File reference above is already captured, so this is
  // safe. Without it, converting file A twice in a row silently does nothing.
  input.value = '';

  if (!file) return; // user backed out of the picker — not an error

  clearError();
  releaseOutput();
  hideProgress();

  // iOS frequently reports an empty or odd MIME type for AVI, so the extension
  // is the source of truth. MIME is only used as a secondary hint.
  if (!/\.avi$/i.test(file.name)) {
    state.source = null;
    el.fileMeta.hidden = true;
    el.optionsPanel.hidden = true;
    setBusy(false);
    showError(
      `“${file.name}” is not an .AVI file. Please choose the AVI recording from the camera.`
    );
    return;
  }

  state.source = file;
  el.fileMeta.textContent = `${file.name} • ${formatBytes(file.size)}`;
  el.fileMeta.hidden = false;
  el.optionsPanel.hidden = false;
  setBusy(false);
  setStatus('');

  // Warm the engine now so the download overlaps with the user reading the
  // screen and choosing a quality. Failure here is not fatal: the Convert
  // button reports it when it is actually needed.
  if (!isLoaded()) {
    warmEngine();
  }
});

let warmed = false;
function warmEngine() {
  if (warmed) return;
  warmed = true;
  setProgress(null);
  loadEngine({ onStatus: setStatus })
    .then(() => {
      hideProgress();
      setStatus('Converter ready.');
      refreshDebug();
    })
    .catch((err) => {
      warmed = false;
      hideProgress();
      setStatus('');
      console.error('[converter] engine load failed', err);
      // Not surfaced as a blocking error yet — the user may not press Convert.
      refreshDebug();
    });
}

/* ---------------------------------------------------------------- convert - */

el.convertBtn.addEventListener('click', async () => {
  if (state.busy || !state.source) return;

  clearError();
  releaseOutput();
  setBusy(true);
  setProgress(null);

  try {
    if (!isLoaded()) {
      warmed = true;
      await loadEngine({ onStatus: setStatus });
    }

    setProgress(0);
    const result = await convert(state.source, {
      quality: el.quality.value,
      onStatus: setStatus,
      onProgress: (p) => setProgress(p),
    });

    // Only now is the job actually finished — the bar is never driven to 100%
    // by a progress event.
    setProgress(1);
    state.output = result.file;
    el.resultMeta.textContent = `${result.file.name} • ${formatBytes(result.file.size)}`;
    el.shareHint.textContent =
      result.mode === 'copy'
        ? 'Already H.264 — repackaged without re-encoding, so it kept full original quality.'
        : '';
    el.resultPanel.hidden = false;
    setStatus('Complete.');
    console.info('[converter] done in %dms (%s)', result.durationMs, result.mode, result.info);
  } catch (err) {
    hideProgress();
    setStatus('');
    const message =
      err instanceof ConverterError
        ? err.message
        : 'Something went wrong during conversion. Please try again.';
    showError(message);
    console.error('[converter] conversion failed', err);
  } finally {
    setBusy(false);
    refreshDebug();
  }
});

el.retryBtn.addEventListener('click', () => {
  clearError();
  setStatus('');
  hideProgress();
});

/* ------------------------------------------------------------------ share - */

el.shareBtn.addEventListener('click', async () => {
  const file = state.output;
  if (!file) return;

  const canShareFiles =
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] });

  if (canShareFiles) {
    try {
      await navigator.share({ files: [file], title: file.name });
      el.shareHint.textContent = '';
      return;
    } catch (err) {
      // AbortError means the user dismissed the Share Sheet. That is a normal
      // outcome, not a conversion failure — the MP4 is still available.
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
        el.shareHint.textContent = 'Sharing cancelled. The MP4 is still ready.';
        return;
      }
      console.warn('[converter] share failed, falling back to download', err);
    }
  }

  downloadFallback(file);
});

function downloadFallback(file) {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);

  const a = document.createElement('a');
  a.href = state.objectUrl;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();

  el.shareHint.textContent =
    typeof navigator.share === 'function'
      ? 'Saved via download. If nothing happened, long-press the button and choose Download.'
      : 'Your MP4 is downloading.';
}

/* ------------------------------------------------------------ diagnostics - */

async function refreshDebug() {
  if (!DEBUG) return;
  el.debugPanel.hidden = false;
  const info = await getDiagnostics();
  info.selectedFile = state.source
    ? { name: state.source.name, bytes: state.source.size, type: state.source.type || '(none)' }
    : null;
  info.outputFile = state.output
    ? { name: state.output.name, bytes: state.output.size }
    : null;
  el.debugInfo.textContent = JSON.stringify(info, null, 2);
  el.debugLog.textContent = getLogs().slice(-120).join('\n');
}

if (DEBUG) {
  onLog(() => {
    el.debugLog.textContent = getLogs().slice(-120).join('\n');
  });
  el.copyDebugBtn.addEventListener('click', async () => {
    const text = `${el.debugInfo.textContent}\n\n--- FFmpeg log ---\n${el.debugLog.textContent}`;
    try {
      await navigator.clipboard.writeText(text);
      el.copyDebugBtn.textContent = 'Copied';
      setTimeout(() => (el.copyDebugBtn.textContent = 'Copy diagnostics'), 1500);
    } catch {
      el.copyDebugBtn.textContent = 'Copy failed — select the text above';
    }
  });
  refreshDebug();
}

/* ---------------------------------------------------------------- cleanup - */

window.addEventListener('pagehide', () => {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
});

initReportUI();
el.startReportBtn.addEventListener('click', () => {
  if (state.output) openReport(state.output);
});

// Test hook. Only used by the Playwright suite; harmless in production.
window.__converter = { convert, loadEngine, outputNameFor, getLogs, onLog, isLoaded, state };
window.__report = { openReport, state: _reportState };
Object.defineProperty(window, '__ff', { get: () => _rawInstance() });

setBusy(false);
