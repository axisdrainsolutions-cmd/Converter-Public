# Drain Video Converter

Converts drain/sewer inspection camera **AVI** recordings into customer-ready
**MP4** files. Everything happens in the browser on the technician's own device —
the AVI is never uploaded anywhere.

Production: <https://axisdrainsolutions-cmd.github.io/Converter-Public/>

> Published from the `axisdrainsolutions-cmd` account. The original
> `axisdrainsolutions` account still hosts the old, broken version at
> <https://axisdrainsolutions.github.io/Converter-Public/> — take that down or
> point it here once access to that account is restored.

---

## Why this was rebuilt

The previous version was a single 1,330-line `index.html` that loaded
`@ffmpeg/ffmpeg@0.12.10` **UMD** from unpkg via a `<script>` tag and pointed
`coreURL`/`wasmURL` at `@ffmpeg/core@0.12.6` on the same CDN, wrapped in
`toBlobURL()`.

That cannot work, for three independent reasons:

1. **Mismatched versions.** `@ffmpeg/ffmpeg` 0.12.10 was paired with
   `@ffmpeg/core` 0.12.6. Nothing pinned them together.
2. **No `classWorkerURL`.** The `FFmpeg` class spawns its own worker. In the UMD
   build that worker is a separate webpack chunk (`814.ffmpeg.js`) whose location
   is inferred at runtime from webpack's automatic `publicPath`. That inference
   is what produces *"Automatic publicPath is not supported in this browser"*.
3. **Cross-origin worker.** Even when the path resolves, browsers refuse to start
   a worker from a different origin. Loading `ffmpeg.js` from `unpkg.com` while
   the page is on `github.io` means the worker script is cross-origin, and Safari
   blocks it.

Blob-wrapping the core did not help, because the failure is in how the *class
worker* is located, not the core.

The rewrite removes the whole category of problem: **every runtime asset is
served from the app's own origin, and Vite resolves the worker URL at build
time.** Nothing is inferred at runtime, nothing is fetched from a CDN, and no
Blob URL is involved.

---

## Architecture

```
index.html            markup only
src/main.js           UI state machine, file picking, sharing, diagnostics
src/converter.js      the only file that touches ffmpeg.wasm
src/report.js         findings vocabulary, frame capture, PDF generation
src/report-ui.js      the report step's DOM, drafts and preview video
src/style.css         mobile-first styling
scripts/
  copy-ffmpeg-core.mjs   copies the pinned core out of node_modules into public/
  verify-build.mjs       post-build gate: asset paths, worker, wasm, no CDN refs
  make-test-media.mjs    generates AVI fixtures with the host's ffmpeg
public/ffmpeg/        ffmpeg-core.js + ffmpeg-core.wasm   (generated, gitignored)
test/                 Playwright suite, runs against the real production build
.github/workflows/deploy.yml
```

No framework. Vanilla JS, ~350 lines of application logic.

### Loading path

```
page  ──▶ new FFmpeg()
          └─ new Worker('/Converter-Public/assets/worker-<hash>.js', { type: 'module' })
                 └─ await import('/Converter-Public/ffmpeg/ffmpeg-core.js')
                        └─ fetch  '/Converter-Public/ffmpeg/ffmpeg-core.wasm'
```

Three things make this work and are easy to break:

- **The core must be the ESM build.** Inside its module worker, ffmpeg's
  `worker.js` first tries `importScripts(coreURL)`. `importScripts` does not
  exist in a module worker, so it throws and falls through to
  `await import(coreURL)` — which needs a module with a default export. The UMD
  core has none. This is what the official docs mean by *"Vite users should use
  `esm` in baseURL instead of `umd`"*.
- **`optimizeDeps.exclude`** for `@ffmpeg/ffmpeg` and `@ffmpeg/util`. esbuild's
  pre-bundling rewrites `import.meta.url`, which breaks the worker lookup in dev.
- **`worker.format: 'es'`** in `vite.config.js`, because the worker is created
  with `{ type: 'module' }`.

`base` is `/Converter-Public/` for dev, preview *and* build, so local testing
uses the same sub-path as production rather than a root-hosted approximation.

### Memory

The AVI is exposed to FFmpeg through **WORKERFS**, which reads the `File` lazily
with `FileReaderSync` inside the worker. The file is never turned into a JS
array, never structured-cloned, and never copied into the wasm heap. Measured on
a 60.8 MB input: JS heap after conversion was **16.7 MB**. If `mount` fails the
code falls back to `fetchFile` + `writeFile`, which costs roughly 3× the file
size.

The virtual filesystem is wiped before *and* after every run (including failed
runs), so a stale `output.mp4` can never be handed back as a fresh result.

### Conversion: two paths

The app probes the source with `ffmpeg -i` before doing anything, then picks one
of two paths.

**Path 1 — remux (no re-encoding).** Used when the source video is already H.264
in a form iOS plays. The existing frames are moved into an MP4 container:

```
ffmpeg -hide_banner -fflags +genpts -i <input>
       -map 0:v:0 -map 0:a:0?
       -c:v copy
       -movflags +faststart -avoid_negative_ts make_zero
       [-c:a aac -b:a <rate> -ac 2]
       output.mp4
```

**Path 2 — full re-encode.** Everything else (MJPEG, MPEG-4 Part 2, exotic H.264):

```
ffmpeg -hide_banner -fflags +genpts -i <input>
       -map 0:v:0 -map 0:a:0?
       -c:v libx264 -preset <preset> -crf <crf> -pix_fmt yuv420p
       [-vf scale=trunc(iw/2)*2:trunc(ih/2)*2]   # only if a dimension is odd
       -movflags +faststart -avoid_negative_ts make_zero
       [-c:a aac -b:a <rate> -ac 2]
       output.mp4
```

Remuxing is gated deliberately narrowly — codec `h264`, pixel format `yuv420p`,
and profile Baseline / Constrained Baseline / Main / High. Anything else
re-encodes. Copying an MJPEG stream into an MP4 *succeeds* and produces a file
that saves fine and then refuses to play on an iPhone, which is a far worse
failure than being slow; there is a test that specifically prevents it. If a
remux fails for any reason the app silently falls back to re-encoding.

Audio is always re-encoded to AAC, even on the remux path: AVI carries PCM or
MP3 far more often than AAC, and encoding a few minutes of 8–16 kHz mono costs
about a second.

### Why re-encoding is slow, and remuxing is not

Measured in the real engine on 60 seconds of 1280×720 30 fps H.264 at 8.6 Mbps —
i.e. the VEVOR camera's actual output format. Desktop Chromium; an iPhone is
roughly 2× slower.

| Path | Time | Output |
|---|---|---|
| Remux (`-c:v copy`) | **6.9 s** | 63.4 MB |
| Re-encode crf 23, 720p | 100.7 s | 20.5 MB |
| Re-encode crf 30, 720p | 92.8 s | 8.3 MB |
| Re-encode crf 26 `ultrafast`, 720p | 40.4 s | 47.0 MB |
| Re-encode crf 23, downscaled to 854×480 | 70.1 s | 5.7 MB |

The key finding: **re-encoding costs 70–100 s per minute of footage regardless of
preset or output resolution**, because decoding a high-bitrate 720p H.264 stream
in WebAssembly is the floor. Preset tuning buys at most 2.5× and costs a lot of
file size; dropping to 480p barely helps the clock. Remuxing skips decoding
entirely, which is why it is 15× faster than anything else on the table.

| Quality option | Behaviour | 60 s of VEVOR footage |
|---|---|---|
| **Customer — Fast (Original Quality)** *(default)* | remux if H.264, else `veryfast` crf 23 | ~7 s, 63 MB |
| **Smaller File — Slower** | always re-encode, `veryfast` crf 23 | ~101 s, 21 MB |
| **Smallest File — Slowest** | always re-encode, `veryfast` crf 30 | ~93 s, 8 MB |

No option downscales. Inspection footage is examined for cracks and root
intrusion, so resolution is left alone even in the smallest preset.

### Inspection report

After a conversion finishes, the app can build a branded PDF inspection report:
scrub the video, capture stills, tag each one, add a recommendation, share it
through the iOS Share Sheet.

Stills are captured from the **converted MP4**, not the source AVI. The MP4 is
H.264, which an iPhone decodes in hardware, so scrubbing and `drawImage(video)`
are effectively free. Pulling frames back through ffmpeg.wasm would mean
decoding the video a second time in software for no gain.

Design decisions worth knowing:

- **Findings are one-tap chips**, not free text. Typing on a phone in a driveway
  is what makes a tool like this get abandoned; free text is optional per still.
- **jsPDF is dynamically imported**, so its ~387 KB never touches first paint.
  A test asserts it is not fetched until a report is actually built.
- **Job details persist between reports; findings never do.** Retyping the
  technician on every job is maddening, but carrying a still from one pipe into
  another customer's report would be wrong. Drafts are text-only — several 720p
  JPEGs would blow the `localStorage` quota, and re-capturing a still is easy
  while retyping an address is not.
- **The report never claims a licence.** It says "Insured"; it does not say
  "Licensed", because the Florida CFC is still in progress. There is a test that
  fails if the word ever appears.
- **If the browser cannot decode the preview**, capture is disabled with an
  explanation and the rest of the report still works, rather than leaving a dead
  player on screen.

---

## Versions

| Package | Version | Notes |
|---|---|---|
| `@ffmpeg/ffmpeg` | **0.12.15** | exact, ESM build |
| `@ffmpeg/util` | **0.12.2** | exact |
| `@ffmpeg/core` | **0.12.10** | exact, **single-threaded**, ESM |
| `jspdf` | **4.2.1** | exact, lazy-loaded |
| `vite` | 7.3.6 | Rollup-based; Vite 8 switches to Rolldown and changes worker emission |
| `@playwright/test` | 1.63.0 | dev only |

All three `@ffmpeg` packages are pinned to exact versions and `npm ci` is used in
CI, so the deployed core can never drift from the tested one.

**Single-threaded on purpose.** The multithreaded core (`@ffmpeg/core-mt`) needs
`SharedArrayBuffer`, which needs COOP/COEP headers, which GitHub Pages cannot
set. `scripts/copy-ffmpeg-core.mjs` and `scripts/verify-build.mjs` both fail the
build if a `ffmpeg-core.worker.js` ever appears, which would mean the core
silently became multithreaded.

### Core build configuration

Read out of the shipped `ffmpeg-core.wasm`:

```
--enable-gpl --enable-libx264 --enable-libx265 --enable-libvpx
--enable-libmp3lame --enable-libtheora --enable-libvorbis --enable-libopus
--enable-zlib --enable-libwebp --enable-libfreetype --enable-libfribidi
--enable-libass --enable-libzimg
--disable-pthreads --disable-w32threads --disable-os2threads
--extra-cflags='-I/opt/include -O3 -msimd128'
```

`-msimd128` means the core **requires WebAssembly SIMD**.

Codec support is not assumed — a test runs `-encoders`, `-decoders` and
`-formats` inside the actual browser engine and asserts on the result:
`libx264` and `aac` encoders, `mjpeg` / `mpeg4` / `h264` decoders, AVI demuxer,
MP4 muxer.

---

## Browser support

**Minimum: iOS 16.4 / Safari 16.4** (March 2023). Two independent hard
requirements land on the same version:

- dynamic `import()` inside a Worker (Safari 16.4)
- WebAssembly SIMD, required by the `-msimd128` core (Safari 16.4)

Below that the app shows *"This browser could not start the converter engine.
iOS 16.4 or newer is required."* rather than hanging. Desktop Chrome, Edge and
Safari are all well past this.

---

## Development

```bash
npm install
npm run dev        # http://localhost:5173/Converter-Public/
npm run build      # -> dist/
npm run preview    # serves dist/ at the real sub-path
node scripts/verify-build.mjs
```

Add `?debug=1` to any URL for a diagnostics panel: user agent, base URL, core and
wasm URLs, `SharedArrayBuffer` / `crossOriginIsolated` / module-worker support,
package versions, selected file, and the live FFmpeg log with a copy button.

### Tests

```bash
npx playwright install chromium     # once
npm run test:e2e
```

The suite builds the app, serves the **production** bundle at
`/Converter-Public/`, and drives the real UI. It generates its own AVI fixtures
with the host's `ffmpeg` (MJPEG+PCM, MPEG-4 video-only, H.264+MP3, 320×240, and a
deliberately corrupt file), and inspects each produced MP4 with `ffprobe`.

---

## Deployment

GitHub Pages is published by `.github/workflows/deploy.yml` (Actions, not a
branch). It runs `npm ci`, `npm run build`, then `scripts/verify-build.mjs`,
and uploads `dist/`.

**Repository → Settings → Pages → Source must be set to "GitHub Actions".**

`verify-build.mjs` fails the deploy if any of these is true:

- an asset URL is root-absolute instead of `/Converter-Public/…`
- a referenced file is missing from `dist/` (the classic Pages 404)
- `ffmpeg-core.js` / `.wasm` are missing, or the wasm is truncated or lacks the
  `\0asm` magic number
- the FFmpeg class worker was not emitted as a real same-origin asset
- a `ffmpeg-core.worker.js` appeared (multithreaded core)

The 32 MB wasm is **not** committed. CI regenerates it from `package-lock.json`
on every build, which keeps clones small and makes drift impossible.

---

## Test results

Chromium, production build served at `/Converter-Public/`. **20 of 20 passing**, plus a separate large-file stress test.

| Area | Result |
|---|---|
| Build | `npm install`, `npm run build`, `verify-build` — clean, zero errors |
| Assets under `/Converter-Public/` | core, wasm and worker all 200; wasm served as `application/wasm` |
| External requests during a full conversion | **0** — nothing leaves the origin, no POST/PUT/PATCH |
| Codec support | asserted against the live engine, not documentation |
| MJPEG + PCM AVI | → H.264 / AAC / yuv420p / 640×480, moov before mdat, decodes clean |
| MPEG-4 video-only AVI | → single H.264 stream, no audio track, no error |
| H.264 + MP3 AVI | → H.264 / AAC |
| 320×240 MJPEG AVI | → correct dimensions preserved |
| Quality presets | 178 KB / 347 KB / 456 KB from the same source |
| Repeat A → B → A | identical output for identical input; no stale `output.mp4` in the VFS |
| Wrong extension | rejected in the UI, recovers on next pick |
| Corrupt AVI | *"may be incomplete or corrupted"*, not *"Conversion failed"*; UI recovers |
| Cancelled picker | no state change |
| Engine load failure | readable error, no permanent spinner, retry succeeds |
| Concurrent load calls | wasm downloaded exactly **once** |
| Output filenames | 8 awkward inputs, all safe |
| Object URLs | previous URL revoked before replacement |
| 60.8 MB / 720p / 45 s | → 13.7 MB in 70 s; **JS heap 16.7 MB**; WORKERFS confirmed |
| H.264 source | remuxed, not re-encoded; output decodes clean |
| MJPEG source | **never** remuxed — re-encoded to H.264 (copying it would make an unplayable MP4) |
| "Smaller"/"Smallest" on H.264 | forced re-encode, both genuinely smaller than the remux |
| Remux reported in the UI | hint shown on the copy path, absent on a real re-encode |
| Live production origin | engine loaded in 1.3 s; full conversion; MP4 played back; `application/wasm` confirmed; zero off-origin requests |
| Report — stills | captured from two different moments, real JPEGs at source resolution, provably not the same frame |
| Report — PDF | valid `%PDF-`, opens, contains every entered field; page breaks never strand a heading |
| Report — no stills | still produces a valid PDF |
| Report — missing address | refuses with a specific message, then works once supplied |
| Report — undecodable preview | capture disabled with an explanation; the rest of the report still works |
| Report — draft behaviour | job details carry over between reports; findings never do |
| Report — teardown | preview video object URL revoked when a new conversion starts |
| Report — lazy loading | jsPDF not fetched until a report is built |
| Report — privacy | zero off-origin requests while building a report |
| Report — licence wording | fails if the PDF ever claims to be "Licensed" |

### The VEVOR camera's actual format — confirmed

A real recording (`20260906_042808_00000004_00N.AVI`) was inspected by parsing
its RIFF/AVI headers and H.264 SPS directly. The video itself was never copied
off the owner's machine.

| Property | Value |
|---|---|
| Container | AVI (RIFF) |
| Video codec | **H.264**, FourCC `H264` |
| Profile / level | **High, Level 4.0** (`profile_idc` 100) |
| Resolution / rate | 1280×720, 30 fps |
| Audio | PCM signed 16-bit, mono, 16 kHz (`wFormatTag` 0x0001) |
| Segment size | exactly 15 MiB — 14.37 s, ≈8.4 Mbps |

Two consequences:

1. **The remux path applies.** High profile is on the safe list, so these files
   convert in seconds rather than minutes.
2. **The camera appears to segment at a fixed 15 MiB**, so individual files stay
   short. Combined with remuxing, a typical file should convert in a few seconds
   on an iPhone.

### Verified with test media vs. verified with a VEVOR AVI

**Verified end to end with a real VEVOR AVI on a real iPhone:** file picking
through the iOS Files picker, engine load, conversion, the iOS Share Sheet, Save
to Files, and playback of the result. Reported working by the device owner.

**Verified by direct inspection of a real VEVOR AVI:** container, video codec,
profile, level, resolution, frame rate, audio format, segment size (table above).

**Verified with synthetic test media only:**

- the remux path itself, exercised against a synthetic H.264 AVI and against a
  synthetic file built to match the VEVOR parameters above — but not yet against
  a real VEVOR file end to end since the remux path was added
- MJPEG, MPEG-4 Part 2 and corrupt-file handling
- the timing table above (synthetic 720p30 H.264 at 8.6 Mbps)

**Still unverified:**

- conversion time for a real VEVOR file on the technician's actual iPhone with
  remuxing enabled
- whether every VEVOR recording uses the same profile, or whether settings on the
  camera can produce something else. The app handles that safely either way —
  anything outside the safe list re-encodes — but it would be slower.

If a file ever fails, open the app with `?debug=1`, reproduce, and use **Copy
diagnostics**. The probe pass captures the exact container and codec names.

## Privacy

The AVI never leaves the device. There is no server, no analytics, no tracking,
no telemetry and no third-party runtime request — the only network traffic is
fetching this app's own static files from its own origin. Verified by a test that
fails if any request goes off-origin or any upload-shaped request is made during
a full conversion.

Offline is **not** claimed and no service worker is implemented. The engine
downloads once per browser cache lifetime. The project is structured so a service
worker could be added later.

---

## Licensing

Documented for review, not legal advice. Have counsel review before any
commercial or App Store distribution.

- **FFmpeg** — the shipped `ffmpeg-core.wasm` is built `--enable-gpl
  --enable-libx264 --enable-libx265`. Enabling GPL components makes the resulting
  binary **GPL-2.0-or-later**, not LGPL.
- **libx264** — GPL-2.0-or-later. Commercial use without GPL compliance requires
  a separate license from VideoLAN. This is the main item to review.
- **libx265** — GPL-2.0-or-later, same situation (present in the build; unused by
  this app).
- **`@ffmpeg/ffmpeg`, `@ffmpeg/util`, `@ffmpeg/core`** — MIT (the JS wrappers;
  the compiled core carries FFmpeg's licensing above).
- **Vite, Playwright** — MIT / Apache-2.0, build and test only, not shipped.
- **Icons** — original to this repository.

Practical implication: distributing this app distributes GPL-licensed x264. For a
free, publicly-hosted tool that generally means making the corresponding source
available — which this public repository does. Selling it, bundling it into a
paid product, or shipping it as a native app is a different question and needs
review.

A build that avoided GPL entirely would need an FFmpeg core compiled without
`libx264` and `libx265`, using FFmpeg's native H.264 encoder — which does not
exist. There is no drop-in non-GPL replacement for H.264 encoding here.

---

## Known limitations

- **Speed, when re-encoding is unavoidable.** Single-threaded wasm software
  encoding costs 70–100 s per minute of 720p footage on desktop, roughly 2× that
  on an iPhone. Sources that are already H.264 avoid this entirely by remuxing;
  MJPEG and MPEG-4 sources cannot. The only remaining lever that would not cost
  file size is multithreading, which needs `SharedArrayBuffer` and therefore
  COOP/COEP headers that GitHub Pages cannot set — reachable via a
  service-worker workaround, deliberately not attempted yet.
- **Remuxed files are large.** The remux path preserves the camera's ~8.4 Mbps
  bitrate, so output is roughly the same size as the input (~64 MB per minute).
  Fine for the camera's ~14 s segments; use "Smaller File" for anything long
  that has to go out by email.
- **First run downloads ~32 MB.** Cached afterwards, but the first conversion on
  a new device needs a connection.
- **Large files on iPhone.** WORKERFS keeps the input out of memory, but the
  output MP4 is still held in the wasm heap and then as a Blob. Very long
  recordings can still hit iOS memory limits; the app reports this as a
  memory error rather than crashing silently.
- **Progress is approximate.** ffmpeg.wasm documents its progress event as
  experimental. It is clamped below 100% and never used to decide completion.
- **No offline support**, no PWA caching. The manifest allows Add to Home Screen,
  which is not the same thing.
- **iOS Share Sheet** is used when `navigator.canShare({ files })` allows it;
  otherwise the app falls back to a normal download.
