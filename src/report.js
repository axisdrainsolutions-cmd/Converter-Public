/**
 * Inspection report builder.
 *
 * Stills are captured from the *converted MP4*, not from the source AVI. That
 * matters: the MP4 is H.264, which the iPhone decodes in hardware, so scrubbing
 * and grabbing a frame is instant and needs no WebAssembly at all. Pulling
 * frames back out through ffmpeg.wasm would mean decoding the video a second
 * time in software for no benefit.
 *
 * The PDF is generated on the device. Nothing here uploads anything, same as
 * the converter.
 */

import LOGO_URL from './assets/logo.jpg';

/** One-tap findings. Typing on a phone in a driveway is the thing that kills
 *  adoption, so the common cases are all chips and free text is optional. */
export const FINDING_TAGS = [
  'Roots',
  'Grease',
  'Belly / standing water',
  'Offset joint',
  'Separated joint',
  'Crack / fracture',
  'Scale build-up',
  'Foreign object',
  'Collapsed section',
  'Blockage cleared',
  'Normal / clear',
];

export const LINE_TYPES = [
  'Main sewer line',
  'Kitchen line',
  'Laundry line',
  'Bathroom line',
  'Downspout / storm',
  'Other',
];

export const CONDITIONS = [
  'Clear — no defects found',
  'Minor build-up',
  'Monitor — early signs of wear',
  'Repair recommended',
  'Urgent repair needed',
];

/** Brand palette (from the Axis Drain Solutions logo). */
const BRAND = {
  ink: [15, 23, 42],
  green: [92, 209, 15],
  blue: [56, 145, 212],
  grey: [110, 120, 135],
  light: [235, 238, 243],
};

const COMPANY = {
  name: 'Axis Drain Solutions',
  tagline: 'Drain Cleaning  |  Camera Inspections  |  Hydro-Jetting',
  phone: '407-630-1264',
  // Deliberately NOT "Licensed" — a Florida plumbing licence claim is not one
  // to make on a customer-facing document until the CFC is actually held.
  credentials: 'Insured  •  24 Hour Service  •  Orlando, Florida',
};

/* ------------------------------------------------------------- state ----- */

export function emptyReport() {
  return {
    customer: '',
    address: '',
    date: new Date().toISOString().slice(0, 10),
    technician: '',
    lineType: '',
    condition: '',
    recommendation: '',
    findings: [], // { id, dataUrl, timeSec, width, height, tags[], note }
  };
}

/* ------------------------------------------------------ frame capture ---- */

/**
 * Grabs the frame currently shown by `video` as a JPEG data URL.
 *
 * iOS Safari will happily hand back the *previous* frame if you draw
 * immediately after a seek, so callers must wait for `seeked` first; this
 * function additionally waits one animation frame, which in testing is what
 * makes it reliable on a real device.
 */
export async function captureFrame(video, quality = 0.85) {
  if (!video || !video.videoWidth) {
    throw new Error('The video is not ready yet. Give it a moment and try again.');
  }

  // Let the freshly-seeked frame settle before drawing, or iOS hands back the
  // previous one. This MUST NOT depend on rendering: requestAnimationFrame
  // never fires while the page is hidden (backgrounded tab, app switch, Share
  // Sheet), which would hang the capture forever with no error. So whichever
  // signal arrives first wins, and a timer guarantees one always does.
  // drawImage() works on a paused video regardless of whether frames are being
  // painted, so falling through on the timer is safe.
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      try {
        video.requestVideoFrameCallback(finish);
      } catch {
        /* fall through to the timer */
      }
    } else {
      requestAnimationFrame(finish);
    }
    setTimeout(finish, 250);
  });

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  // Free the backing store promptly; several 720p canvases add up on a phone.
  canvas.width = 0;
  canvas.height = 0;

  if (!dataUrl || dataUrl.length < 1000) {
    throw new Error('That frame could not be captured. Try scrubbing slightly and again.');
  }

  return {
    id: `f${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    dataUrl,
    timeSec: video.currentTime || 0,
    width: video.videoWidth,
    height: video.videoHeight,
    tags: [],
    note: '',
  };
}

export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------- naming ---- */

export function reportFileName(report, videoName) {
  const base = (report.address || report.customer || '').trim();
  const stem = base
    ? base.replace(/[\u0000-\u001f<>:"|?*\\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    : (videoName || 'Inspection').replace(/\.[^.]*$/, '');
  return `${stem || 'Inspection'} — Inspection Report.pdf`.replace(/\s+/g, ' ');
}

/* ---------------------------------------------------------------- PDF ---- */

/**
 * jsPDF is ~336 KB, which is not worth adding to first paint for a page whose
 * main job is converting video. It is imported the first time a report is
 * actually generated.
 */
let jsPDFPromise = null;
function loadJsPDF() {
  if (!jsPDFPromise) {
    jsPDFPromise = import('jspdf').then((m) => m.jsPDF);
    jsPDFPromise.catch(() => {
      jsPDFPromise = null;
    });
  }
  return jsPDFPromise;
}

const PAGE = { w: 215.9, h: 279.4 }; // US Letter, mm
const M = 15; // margin
const CONTENT_W = PAGE.w - M * 2;

/**
 * The badge is loaded once and reused. It is imported as an asset rather than
 * inlined as base64: base64 is a third larger, and it would sit in the main
 * bundle and be downloaded by everyone who merely converts a video.
 */
let badgePromise = null;

/**
 * Loads the badge as a base64 data URL.
 *
 * It is a baseline JPEG already composited onto the header colour, not a
 * transparent PNG. jsPDF renders alpha by generating a soft mask, which is the
 * most fragile part of its image pipeline; the badge only ever sits on one
 * colour, so transparency bought nothing and cost compatibility.
 *
 * A data URL is handed to jsPDF rather than an <img> element because it is the
 * best-supported input it takes — no canvas round-trip, no re-encoding.
 * Anything that goes wrong resolves to null, and the report is built without
 * the badge rather than not at all.
 */
function loadBadge() {
  if (!badgePromise) {
    badgePromise = (async () => {
      try {
        const res = await fetch(LOGO_URL, { cache: 'force-cache' });
        if (!res.ok) return null;
        const blob = await res.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(fr.error || new Error('badge read failed'));
          fr.readAsDataURL(blob);
        });
        const size = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => resolve(null);
          img.src = dataUrl;
        });
        if (!size || !size.w) return null;
        return { dataUrl, ...size };
      } catch {
        return null;
      }
    })();
  }
  return badgePromise;
}

/**
 * Page 1 carries the full badge; continuation pages get a slim text band.
 * That is how letterhead normally behaves, and it keeps the badge embedded
 * once rather than on every page.
 */
function header(doc, pageNo, badge) {
  const tall = pageNo === 1 && badge;
  const bandH = tall ? 37 : 18;

  doc.setFillColor(...BRAND.ink);
  doc.rect(0, 0, PAGE.w, bandH, 'F');
  doc.setFillColor(...BRAND.green);
  doc.rect(0, bandH, PAGE.w, 1.4, 'F');
  doc.setFillColor(...BRAND.blue);
  doc.rect(0, bandH + 1.4, PAGE.w, 0.8, 'F');

  let textX = M;

  if (tall) {
    const badgeH = 30;
    const badgeW = (badgeH * badge.w) / badge.h;
    doc.addImage(badge.dataUrl, 'JPEG', M, (bandH - badgeH) / 2, badgeW, badgeH, 'logo', 'FAST');
    textX = M + badgeW + 7;
  }

  // The company name is kept as real text as well as artwork, so the PDF stays
  // searchable and selectable rather than hiding its identity inside an image.
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(tall ? 15 : 11);
  doc.text(COMPANY.name, textX, tall ? 15 : 8.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(tall ? 8 : 7.5);
  doc.setTextColor(190, 200, 214);
  if (tall) {
    doc.text(COMPANY.tagline, textX, 21);
    doc.text(COMPANY.credentials, textX, 26);
  } else {
    doc.text(COMPANY.credentials, textX, 13);
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(tall ? 13 : 10);
  doc.setTextColor(255, 255, 255);
  doc.text(COMPANY.phone, PAGE.w - M, tall ? 15 : 8.5, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(190, 200, 214);
  doc.text(`Page ${pageNo}`, PAGE.w - M, tall ? 26 : 13, { align: 'right' });

  return bandH + 12;
}

function footer(doc) {
  const y = PAGE.h - 12;
  doc.setDrawColor(...BRAND.light);
  doc.setLineWidth(0.3);
  doc.line(M, y - 4, PAGE.w - M, y - 4);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...BRAND.grey);
  doc.text(
    'Camera inspection findings are limited to what is visible from the access point used. Full video recording available on request.',
    M,
    y,
    { maxWidth: CONTENT_W }
  );
}

function sectionTitle(doc, text, y) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...BRAND.ink);
  doc.text(text.toUpperCase(), M, y);
  doc.setDrawColor(...BRAND.green);
  doc.setLineWidth(0.8);
  doc.line(M, y + 1.6, M + 18, y + 1.6);
  return y + 8;
}

function labelledRow(doc, pairs, y) {
  const colW = CONTENT_W / 2;
  pairs.forEach((pair, i) => {
    const x = M + (i % 2) * colW;
    const row = Math.floor(i / 2);
    const yy = y + row * 11;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...BRAND.grey);
    doc.text(pair[0].toUpperCase(), x, yy);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...BRAND.ink);
    doc.text(pair[1] || '—', x, yy + 5, { maxWidth: colW - 6 });
  });
  return y + Math.ceil(pairs.length / 2) * 11 + 3;
}

/**
 * Builds the PDF and returns it as a File, ready for navigator.share().
 */
export async function buildReportPdf(report, opts = {}) {
  const badge = await loadBadge();
  try {
    return await renderPdf(report, opts, badge);
  } catch (err) {
    if (!badge) throw err;
    // The badge is decoration; the findings are the point. Never lose a whole
    // report because the artwork would not embed.
    console.warn('[report] PDF build failed with the badge, retrying without it', err);
    return renderPdf(report, opts, null);
  }
}

async function renderPdf(report, { videoName } = {}, badge) {
  const JsPDF = await loadJsPDF();
  const doc = new JsPDF({ unit: 'mm', format: 'letter', compress: true });

  let page = 1;
  let y = header(doc, page, badge);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(...BRAND.ink);
  doc.text('Sewer & Drain Camera Inspection', M, y);
  y += 10;

  y = sectionTitle(doc, 'Job details', y);
  y = labelledRow(
    doc,
    [
      ['Date', formatDate(report.date)],
      ['Customer', report.customer],
      ['Service address', report.address],
      ['Line inspected', report.lineType],
      ['Technician', report.technician],
      ['Findings recorded', String(report.findings.length)],
    ],
    y
  );

  y += 4;
  y = sectionTitle(doc, 'Overall condition', y);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...(/urgent|repair/i.test(report.condition) ? [200, 40, 40] : BRAND.ink));
  doc.text(report.condition || 'Not assessed', M, y);
  y += 7;

  if (report.recommendation) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...BRAND.ink);
    const lines = doc.splitTextToSize(report.recommendation, CONTENT_W);
    doc.text(lines, M, y);
    y += lines.length * 5 + 3;
  }

  // --- findings ---------------------------------------------------------
  if (report.findings.length) {
    y += 3;

    // Cap height as well as width. Inspection cameras shoot 4:3 as often as
    // 16:9, and a width-only cap makes a 4:3 still 112mm tall, which pushes the
    // page count up for no benefit. Fitting inside a box keeps two per page
    // whatever the aspect ratio.
    const IMG_MAX_W = 145;
    const IMG_MAX_H = 78;
    const gap = 8;

    const fitImage = (f) => {
      const ar = f.width && f.height ? f.width / f.height : 16 / 9;
      let w = IMG_MAX_W;
      let h = w / ar;
      if (h > IMG_MAX_H) {
        h = IMG_MAX_H;
        w = h * ar;
      }
      return { w, h };
    };

    const blockHeight = (f) => {
      const { h } = fitImage(f);
      const noteLines = f.note ? doc.splitTextToSize(f.note, CONTENT_W) : [];
      return h + 12 + noteLines.length * 4.6 + gap;
    };

    // Never leave the heading stranded at the foot of a page with its first
    // finding overleaf.
    const TITLE_H = 8;
    if (y + TITLE_H + blockHeight(report.findings[0]) > PAGE.h - 20) {
      footer(doc);
      doc.addPage();
      page += 1;
      y = header(doc, page, badge);
    }
    y = sectionTitle(doc, 'What the camera found', y);

    for (let i = 0; i < report.findings.length; i += 1) {
      const f = report.findings[i];
      const { w: imgW, h: imgH } = fitImage(f);
      const noteLines = f.note ? doc.splitTextToSize(f.note, CONTENT_W) : [];
      const blockH = blockHeight(f);

      if (y + blockH > PAGE.h - 20) {
        footer(doc);
        doc.addPage();
        page += 1;
        y = header(doc, page, badge);
        y = sectionTitle(doc, 'What the camera found (continued)', y);
      }

      doc.setDrawColor(...BRAND.light);
      doc.setLineWidth(0.4);
      doc.rect(M, y, imgW, imgH);
      try {
        doc.addImage(f.dataUrl, 'JPEG', M, y, imgW, imgH, undefined, 'FAST');
      } catch {
        doc.setFontSize(9);
        doc.setTextColor(...BRAND.grey);
        doc.text('[image could not be embedded]', M + 4, y + 8);
      }

      let ty = y + imgH + 5.5;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...BRAND.ink);
      const tags = f.tags && f.tags.length ? f.tags.join(' · ') : 'Observation';
      doc.text(`${i + 1}.  ${tags}`, M, ty);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...BRAND.grey);
      doc.text(`at ${formatTime(f.timeSec)} in recording`, PAGE.w - M, ty, { align: 'right' });
      ty += 5;

      if (noteLines.length) {
        doc.setFontSize(9.5);
        doc.setTextColor(...BRAND.ink);
        doc.text(noteLines, M, ty);
        ty += noteLines.length * 4.6;
      }

      y = ty + gap;
    }
  }

  footer(doc);

  const blob = doc.output('blob');
  return new File([blob], reportFileName(report, videoName), { type: 'application/pdf' });
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/* --------------------------------------------------------- draft save ---- */

const DRAFT_KEY = 'axis.report.draft.v1';

/**
 * Saves the typed fields only. Captured stills are deliberately excluded —
 * several 720p JPEGs blow past the localStorage quota, and losing photos is
 * recoverable (scrub and re-capture) while retyping an address is the annoying
 * part. Every access is guarded: Safari throws outright in some privacy modes.
 */
export function saveDraft(report) {
  try {
    const { findings, ...rest } = report;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(rest));
  } catch {
    /* private mode, quota, or blocked site data — drafts are a convenience */
  }
}

export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
