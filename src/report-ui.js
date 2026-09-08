/**
 * UI controller for the inspection report step.
 *
 * Kept separate from main.js so the converter flow stays readable. This module
 * owns the report's DOM, its draft state, and the object URL for the preview
 * video — nothing else touches them.
 */
import {
  FINDING_TAGS,
  LINE_TYPES,
  CONDITIONS,
  emptyReport,
  captureFrame,
  formatTime,
  buildReportPdf,
  saveDraft,
  loadDraft,
} from './report.js';

const $ = (id) => document.getElementById(id);

let el = null;
let report = emptyReport();
let videoUrl = null;
let pdfUrl = null;
let pdfFile = null;
let sourceVideoName = '';
let busy = false;

export function initReportUI() {
  el = {
    panel: $('reportPanel'),
    video: $('reportVideo'),
    captureBtn: $('captureBtn'),
    shotList: $('shotList'),
    address: $('repAddress'),
    customer: $('repCustomer'),
    date: $('repDate'),
    tech: $('repTech'),
    lineTypeChips: $('lineTypeChips'),
    conditionChips: $('conditionChips'),
    rec: $('repRec'),
    makePdfBtn: $('makePdfBtn'),
    closeBtn: $('closeReportBtn'),
    hint: $('reportHint'),
    startBtn: $('startReportBtn'),
    pdfPanel: $('pdfPanel'),
    pdfMeta: $('pdfMeta'),
    sharePdfBtn: $('sharePdfBtn'),
    pdfHint: $('pdfHint'),
  };

  renderChoiceChips(el.lineTypeChips, LINE_TYPES, 'lineType');
  renderChoiceChips(el.conditionChips, CONDITIONS, 'condition');

  el.captureBtn.addEventListener('click', onCapture);
  el.makePdfBtn.addEventListener('click', onMakePdf);
  el.closeBtn.addEventListener('click', closeReport);
  el.sharePdfBtn.addEventListener('click', onSharePdf);

  for (const [node, key] of [
    [el.address, 'address'],
    [el.customer, 'customer'],
    [el.date, 'date'],
    [el.tech, 'technician'],
    [el.rec, 'recommendation'],
  ]) {
    node.addEventListener('input', () => {
      report[key] = node.value;
      saveDraft(report);
    });
  }

  return { openReport, closeReport, releaseReport };
}

/* ------------------------------------------------------------- chips ----- */

/** Single-choice chip row bound to one field on the report. */
function renderChoiceChips(container, options, field) {
  container.innerHTML = '';
  for (const value of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = value;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      // Tapping the selected chip again clears it.
      report[field] = report[field] === value ? '' : value;
      syncChoiceChips(container, field);
      saveDraft(report);
    });
    container.appendChild(b);
  }
}

function syncChoiceChips(container, field) {
  for (const b of container.querySelectorAll('.chip')) {
    b.setAttribute('aria-pressed', String(b.textContent === report[field]));
  }
}

/* ------------------------------------------------------------- open ------ */

export function openReport(mp4File) {
  releaseVideoUrl();
  videoUrl = URL.createObjectURL(mp4File);
  sourceVideoName = mp4File.name;

  // If the browser cannot decode the preview there is nothing to scrub, so say
  // so and disable capture rather than leaving a dead player on screen. Every
  // iPhone decodes H.264 in hardware; this is for everything else.
  el.captureBtn.disabled = false;
  el.video.onerror = () => {
    el.captureBtn.disabled = true;
    el.hint.textContent =
      'This browser cannot play the converted video, so stills are unavailable here. ' +
      'You can still fill in the report, or build it on your phone.';
  };
  el.video.onloadeddata = () => {
    el.captureBtn.disabled = false;
  };

  el.video.src = videoUrl;
  el.video.load();

  // Carry over the fields that repeat across jobs in a day; findings never
  // carry over, because those belong to one specific pipe.
  const draft = loadDraft();
  report = { ...emptyReport(), ...(draft || {}), findings: [] };
  if (!report.date) report.date = new Date().toISOString().slice(0, 10);

  el.address.value = report.address || '';
  el.customer.value = report.customer || '';
  el.date.value = report.date;
  el.tech.value = report.technician || '';
  el.rec.value = report.recommendation || '';
  syncChoiceChips(el.lineTypeChips, 'lineType');
  syncChoiceChips(el.conditionChips, 'condition');

  renderShots();
  hidePdf();
  el.hint.textContent = '';
  el.panel.hidden = false;
  el.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function closeReport() {
  el.panel.hidden = true;
  hidePdf();
}

/** Called when a new conversion replaces the current one. */
export function releaseReport() {
  // main.js calls this from releaseOutput(), which can fire before the report
  // UI has been initialised. Nothing to tear down in that case.
  if (!el) return;
  closeReport();
  releaseVideoUrl();
  report = emptyReport();
  renderShots();
}

function releaseVideoUrl() {
  if (el && el.video) {
    el.video.pause();
    el.video.removeAttribute('src');
    el.video.load();
  }
  if (videoUrl) {
    URL.revokeObjectURL(videoUrl);
    videoUrl = null;
  }
}

function hidePdf() {
  el.pdfPanel.hidden = true;
  el.pdfMeta.textContent = '';
  el.pdfHint.textContent = '';
  if (pdfUrl) {
    URL.revokeObjectURL(pdfUrl);
    pdfUrl = null;
  }
  pdfFile = null;
}

/* ----------------------------------------------------------- capture ----- */

async function onCapture() {
  if (busy) return;
  try {
    const shot = await captureFrame(el.video);
    report.findings.push(shot);
    renderShots();
    el.hint.textContent = `${report.findings.length} still${report.findings.length === 1 ? '' : 's'} captured.`;
  } catch (err) {
    el.hint.textContent = err.message || 'That frame could not be captured.';
    console.error('[report] capture failed', err);
  }
}

function renderShots() {
  if (!el) return;
  el.shotList.innerHTML = '';

  for (const shot of report.findings) {
    const li = document.createElement('li');
    li.className = 'shot';

    const left = document.createElement('div');
    const img = document.createElement('img');
    img.src = shot.dataUrl;
    img.alt = `Frame at ${formatTime(shot.timeSec)}`;
    const time = document.createElement('span');
    time.className = 'shot-time';
    time.textContent = formatTime(shot.timeSec);
    left.append(img, time);

    const right = document.createElement('div');

    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const tag of FINDING_TAGS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-sm';
      b.textContent = tag;
      b.setAttribute('aria-pressed', String(shot.tags.includes(tag)));
      b.addEventListener('click', () => {
        const i = shot.tags.indexOf(tag);
        if (i >= 0) shot.tags.splice(i, 1);
        else shot.tags.push(tag);
        b.setAttribute('aria-pressed', String(shot.tags.includes(tag)));
      });
      chips.appendChild(b);
    }

    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'input shot-note';
    note.placeholder = 'Note (optional)';
    note.value = shot.note || '';
    note.addEventListener('input', () => {
      shot.note = note.value;
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'shot-remove';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      const i = report.findings.indexOf(shot);
      if (i >= 0) report.findings.splice(i, 1);
      renderShots();
    });

    right.append(chips, note, remove);
    li.append(left, right);
    el.shotList.appendChild(li);
  }
}

/* --------------------------------------------------------------- PDF ----- */

async function onMakePdf() {
  if (busy) return;

  if (!report.address && !report.customer) {
    el.hint.textContent = 'Add a service address or customer name first.';
    el.address.focus();
    return;
  }

  busy = true;
  el.makePdfBtn.disabled = true;
  el.hint.textContent = 'Building report…';
  hidePdf();

  try {
    pdfFile = await buildReportPdf(report, { videoName: sourceVideoName });
    el.pdfMeta.textContent = `${pdfFile.name} • ${formatBytes(pdfFile.size)}`;
    el.pdfPanel.hidden = false;
    el.hint.textContent = '';
    el.pdfPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error('[report] pdf failed', err);
    el.hint.textContent =
      'The report could not be built. Please try again, or remove a still and retry.';
  } finally {
    busy = false;
    el.makePdfBtn.disabled = false;
  }
}

async function onSharePdf() {
  if (!pdfFile) return;

  const canShare =
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [pdfFile] });

  if (canShare) {
    try {
      await navigator.share({ files: [pdfFile], title: pdfFile.name });
      el.pdfHint.textContent = '';
      return;
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
        el.pdfHint.textContent = 'Sharing cancelled. The report is still ready.';
        return;
      }
      console.warn('[report] share failed, falling back to download', err);
    }
  }

  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = URL.createObjectURL(pdfFile);
  const a = document.createElement('a');
  a.href = pdfUrl;
  a.download = pdfFile.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  el.pdfHint.textContent = 'Your report is downloading.';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Test hook, mirroring the converter's. */
export function _reportState() {
  return { report, pdfFile };
}
