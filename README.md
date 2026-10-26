# Doctyn Local Course Video Agent

Turns a PowerPoint deck and a slide-by-slide voiceover script into a narrated
course video — locally, on Windows, from Git Bash.

```
PPTX + DOCX voiceover
→ validate slide mapping
→ render slides (LibreOffice → PDF → 1920x1080 PNG)
→ TTS, one MP3 per slide (Windows local voices or OpenAI)
→ exact durations (ffprobe)
→ one H.264/AAC segment per slide (FFmpeg)
→ final-video.mp4 + captions.vtt/.srt + transcript.txt + thumbnail.jpg + course.json
→ final validation
```

Everything is written to `./output/<course-slug>/`. Nothing is uploaded anywhere.
With `TTS_PROVIDER=windows` the whole build is offline; with `TTS_PROVIDER=openai`
the only network call is OpenAI TTS during `npm run build-course`.

---

## 1. Requirements

| Tool | Notes |
|---|---|
| Node.js 20+ | `node -v` |
| FFmpeg + ffprobe | Must include `libx264`, `aac`, `libmp3lame` (the Gyan "full" build does) |
| LibreOffice | Detected automatically at `C:\Program Files\LibreOffice\program\soffice.exe` |
| TTS | Either Windows built-in voices (free, nothing to install) **or** an OpenAI API key |

PDF → PNG uses `pdftoppm` if it is installed; otherwise the bundled MuPDF npm
package is used. No extra install is required.

Install FFmpeg / LibreOffice if missing (run in Git Bash, then **restart Git Bash**):

```bash
winget install Gyan.FFmpeg
winget install TheDocumentFoundation.LibreOffice
```

## 2. Setup (once)

```bash
cd ~/OneDrive/Desktop/doctyn-course-agent
npm install
cp -n .env.example .env     # skip if .env already exists
```

Then choose a TTS provider in `.env` (section 2a or 2b). All other settings have
defaults — see `.env.example` (lead-in/tail silence per slide, concurrency, tool paths).

### 2a. Windows local voices — free, offline

```
TTS_PROVIDER=windows
WINDOWS_TTS_VOICE=
WINDOWS_TTS_RATE=0
WINDOWS_TTS_VOLUME=100
```

- Uses the built-in Windows speech engine (System.Speech via Windows PowerShell). No API key, no internet, no cost.
- `WINDOWS_TTS_VOICE` empty → an installed English voice is chosen automatically (British English first, then US English), and the build prints which one it is using.
- Set it to an exact or partial name to pick a voice: `WINDOWS_TTS_VOICE=Zira`, `WINDOWS_TTS_VOICE=David`, `WINDOWS_TTS_VOICE=Microsoft Hazel Desktop`.
- `WINDOWS_TTS_RATE`: -10 (slowest) to 10 (fastest), 0 = normal. `WINDOWS_TTS_VOLUME`: 0 to 100.
- Windows writes WAV; FFmpeg converts each one to `audio/slide-NNN.mp3`.
- `npm run test-services` lists the installed voices. More voices: Settings → Time & language → Speech → Manage voices (only voices that appear in `test-services` can be used).

### 2b. OpenAI voices — paid, higher quality

```
TTS_PROVIDER=openai
OPENAI_API_KEY=sk-...
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=alloy
# optional
TTS_INSTRUCTIONS=Speak in a calm, clear, professional tone suitable for a medical education course.
TTS_SPEED=1.0
```

### Switching providers

The provider and voice are part of each slide's audio checkpoint key. Switching
provider or voice and re-running `npm run build-course` regenerates the audio
(and therefore the segments and final video) so voices are never mixed. Slide
images are **not** re-rendered — they only depend on the PPTX.

Tool paths in `.env` may be written Windows style or Git Bash style:

```
LIBREOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.exe
LIBREOFFICE_PATH=/c/Program Files/LibreOffice/program/soffice.exe
```

## 3. Check the machine

```bash
npm run test-services
```

Checks Node, the input/output/temp folders, the TTS setup, FFmpeg (+ encoders),
ffprobe, LibreOffice, the PDF renderer and sharp. It then runs free local smoke
tests: builds a 2-slide PPTX, converts it with LibreOffice, renders PNGs, encodes
a test segment, and synthesizes a short sentence with Windows speech → MP3.

**No OpenAI call is ever made by `test-services`.**

- `TTS_PROVIDER=openai`: `OPENAI_API_KEY` must be set (its quota is not tested). Windows speech is reported as optional.
- `TTS_PROVIDER=windows`: the OpenAI key is not required and never checked against the API; Windows speech must work.

```bash
npm run test-services -- --quick    # skip the smoke tests
```

Exit code is non-zero if any check fails.

## 4. Add the course files

Put **exactly one** `.pptx` and **exactly one** `.docx` in `./input`:

```bash
cp "/c/path/to/Risk Factors for Diabetes.pptx" input/
cp "/c/path/to/Risk Factors for Diabetes - Voiceover.docx" input/
ls input
```

Office lock files such as `~$Risk Factors.docx` are ignored automatically.

### Voiceover DOCX format

```
Slide 01 — Risk Factors for Diabetes
VOICEOVER

Welcome to this module...

Slide 02 — Why Risk Factor Assessment Is Critical
VOICEOVER

Diabetes is not an on-and-off disease...
```

- Headings: `Slide NN — Title` (em dash, en dash, `-`, or `:` all work; `Slide 3` with no title is accepted with a warning).
- Everything after `VOICEOVER` up to the next slide heading is narration. Multiple paragraphs are kept.
- Other all-caps labels inside a slide block (e.g. `ON-SCREEN TEXT`, `SPEAKER NOTES`) end the narration, so their content is not spoken.
- If a block has no `VOICEOVER` marker, all text under the heading is used (with a warning).
- Text before the first `Slide` heading is ignored.

## 5. Validate (free, no API calls)

```bash
npm run validate
```

Reports PPTX slide count, narration count, missing / duplicate / out-of-range
slide numbers, empty narration, malformed headings, and a slide-by-slide
mapping table. Writes `output/<slug>/qa/slide-mapping.txt`, and on failure
`output/<slug>/qa/validation-error.txt`. Exits non-zero on failure.

## 6. Build the course

```bash
npm run build-course
```

If validation fails, the build stops **before** any TTS or video work, writes
`qa/validation-error.txt` and exits non-zero.

On success it prints:

```
COURSE BUILD COMPLETE

Course: Risk Factors for Diabetes
Slides: 52
Voiceovers: 52
Audio files: 52
Video segments: 52
Duration: 24m 31s

Output:
C:\...\output\risk-factors-for-diabetes\final-video.mp4

Validation: PASS
```

Open the result:

```bash
start output/risk-factors-for-diabetes/final-video.mp4
explorer "$(cygpath -w output/risk-factors-for-diabetes)"
```

### Resume / re-run

Every stage is recorded in `output/<slug>/checkpoint.json` with a content hash.
Re-running `npm run build-course` reuses anything whose inputs did not change
and whose files still exist:

- Edit one slide's narration → only that slide's MP3 is regenerated (one TTS job), then its segment, captions and the final video.
- Change `SLIDE_TAIL_SECONDS` → segments/captions/video are rebuilt; **no TTS calls**.
- A crash during FFmpeg → audio is never regenerated; each MP3 is checkpointed the moment it is written.

To force a full rebuild of one course:

```bash
rm -rf output/risk-factors-for-diabetes
```

To force regeneration of just one slide's audio, delete its file:

```bash
rm output/risk-factors-for-diabetes/audio/slide-007.mp3
npm run build-course
```

## 7. Output

```
output/<course-slug>/
├── final-video.mp4          learner-facing video (H.264 / AAC / yuv420p / +faststart)
├── thumbnail.jpg            1280x720 from slide 1
├── captions.vtt
├── captions.srt
├── transcript.txt
├── course.json
├── presentation.pptx        copy of the input deck
├── voiceover-script.docx    copy of the input script
├── checkpoint.json          resume state
├── slides/slide-001.png …   1920x1080, aspect ratio preserved (padded if needed)
├── audio/slide-001.mp3 …
├── video-segments/slide-001.mp4 …
├── source/                  original input files with their original names
└── qa/
    ├── slide-mapping.txt     validation report + mapping table
    ├── validation-error.txt  only when validation fails
    ├── tts-script.txt        exact text sent to TTS (after notation normalization)
    └── final-validation.txt  final PASS/FAIL checklist
```

### Timing

Each segment = `SLIDE_LEAD_IN_SECONDS` + measured MP3 duration + `SLIDE_TAIL_SECONDS`,
rounded up to a whole video frame. The slide image is on screen for the whole
segment. Captions for a slide are placed inside its narration window, computed
from the ffprobe-measured durations; within the window, cues are split by
sentence and timed in proportion to their length.

### Medical notation for speech

Only the TTS input is normalized; captions and transcript keep the original text.
Examples: `β-cell` → "beta cell", `HbA1c` → "H B A one C", `mg/dL` →
"milligrams per decilitre", `kg/m²` → "kilograms per square metre", `mmol/L`,
`mmHg`, `≥`, `≤`, `±`, `e.g.`. Review `qa/tts-script.txt` to see exactly what was
spoken. Disable with `TTS_NORMALIZE_MEDICAL=false`.

## 8. Troubleshooting

| Message | Fix |
|---|---|
| `LibreOffice was not found. Checked: …` | Install LibreOffice or set `LIBREOFFICE_PATH` in `.env` |
| `LibreOffice conversion attempt 1 failed; retrying...` | Normal on the very first run (LibreOffice initialises its private profile in `temp/`) |
| `LibreOffice did not produce a PDF …` | Close all LibreOffice windows and `soffice.bin` in Task Manager; check the PPTX opens in Impress |
| `LibreOffice exported N PDF pages, but the PPTX has M slides` | Re-save the deck from PowerPoint; check for corrupt slides |
| `OpenAI rejected the API key (401)` | Fix `OPENAI_API_KEY` in `.env`, or use `TTS_PROVIDER=windows` |
| `Your OpenAI account has run out of quota` | Add billing credit, or set `TTS_PROVIDER=windows` and re-run (slide images are reused) |
| `WINDOWS_TTS_VOICE="…" is not an installed Windows voice` | Use a name listed by `npm run test-services`, or leave it empty |
| `No English Windows speech voice is installed` | Add one in Settings → Time & language → Speech, or set `WINDOWS_TTS_VOICE` |
| `Rate limit reached` | Lower `TTS_CONCURRENCY`, re-run |
| `FFmpeg was not found` | `winget install Gyan.FFmpeg`, restart Git Bash, or set `FFMPEG_PATH` |
| `The … folder is not writable` | Pause OneDrive sync or close the video player holding the file |

## Web dashboard

A browser dashboard (upload, validate, voice preview, generate, live progress, video
library with playback and downloads) runs on top of the same CLI scripts.

```bash
npm run dashboard        # local engine + dashboard at http://127.0.0.1:8788
```

- **The engine (`src/dashboard.ts`) runs on your computer.** Kokoro, LibreOffice and
  FFmpeg never run on Vercel. It listens on `127.0.0.1` only, runs one job at a time,
  and keeps history and logs in `output/.dashboard/`.
- **The UI (`public/`) is static** and can be hosted on Vercel. The page then calls
  the engine at `http://127.0.0.1:8788` from your browser. Chrome may ask to allow
  access to local network devices — allow it. If the engine is not running, the page
  says so and disables every action; it never shows placeholder videos.
- Uploading a PPTX/DOCX moves the previous file of that type to `input/.replaced/<time>/`.
- Allowed web origins: `https://doctyn-course-ai-agent.vercel.app` and its preview
  deployments. Add others (a custom domain) with
  `DASHBOARD_ALLOWED_ORIGINS=https://studio.example.com` in `.env`. Port: `DASHBOARD_PORT`.
- Builds started from the terminal (`npm run build-course`) are not tracked live in the
  dashboard, but their finished videos appear in the library.

Tests: `npm test` (dashboard server and progress parsing).

## Publishing to Vercel

The website's **Generated videos** library shows only courses you have published. Publishing is
explicit and manual; building a course never uploads anything.

What is stored (Vercel Blob, **public**: anyone with a link can watch):
`courses/<slug>/final-video.mp4`, `thumbnail.jpg`, `captions.vtt`, `captions.srt`, `transcript.txt`,
plus `library/catalog.json`. Source PPTX/DOCX, `presentation.pptx`, `voiceover-script.docx`, audio,
slides, segments, `qa/`, `checkpoint.json` and `.env` are never uploaded.

```bash
npm run publish-course                               # list local courses (and publish status if a token is set)
npm run publish-course -- <slug>                     # DRY RUN: shows exactly which files would be uploaded
npm run publish-course -- <slug> --yes               # approve and upload
npm run publish-course -- --unpublish <slug> --yes   # remove from the website (local files untouched)
```

One-time setup:

1. Vercel dashboard -> your project -> **Storage** -> create a **Blob** store with **Public** access and
   connect it to the project (this adds `BLOB_READ_WRITE_TOKEN` to the project's environment).
2. Copy that token into your local `.env` as `BLOB_READ_WRITE_TOKEN=...` (`.env` is git-ignored).
3. Deploy the site so `api/library.js` and `api/course-file.js` are live.

The site reads `/api/library`, which fetches `library/catalog.json` from the store. If the publish command
prints a `LIBRARY_CATALOG_URL` note, add that variable to the Vercel project and redeploy.

## Project layout

```
src/
├── build-course.ts         full pipeline (npm run build-course)
├── validate.ts             mapping check   (npm run validate)
├── test-services.ts        environment check (npm run test-services)
├── dashboard.ts            local web dashboard engine (npm run dashboard)
├── server/                 dashboard HTTP API, job runner, progress parsing, library
├── services/
│   ├── inputs.ts           find the one PPTX + one DOCX, ignore ~$ files
│   ├── parse-pptx.ts       slide count/order/titles from the PPTX ZIP/XML
│   ├── parse-docx.ts       "Slide NN — Title / VOICEOVER" sections (mammoth)
│   ├── validation.ts       slide ↔ narration mapping rules and reports
│   ├── course.ts           output paths, shared load + validation files
│   ├── render-slides.ts    LibreOffice → PDF → PNG, thumbnail
│   ├── tts.ts              OpenAI TTS, chunking, medical speech normalization, audio keys
│   ├── tts-windows.ts      Windows System.Speech TTS (PowerShell) → WAV → MP3
│   ├── video.ts            ffprobe, per-slide segments, final concat
│   └── captions.ts         VTT / SRT / transcript
└── utils/                  config (.env), checkpoint, exec, tool discovery, files, slug, log, errors
public/                     static dashboard UI (deployed to Vercel)
test/                       npm test
```

Type-check: `npx tsc --noEmit` (or `npm run typecheck`).

---

# V2: Topic-aware medical animation engine

Adds an explainer animation to every slide, driven by the slide's PPTX text and its voiceover.
Local only; V1 commands are unchanged. Details: `docs/npm-audit-review.md` for dependency findings.

```bash
npm run animate -- analyze          # PPTX + DOCX -> output/<slug>/animation/plan.json (offline, rule-based)
npm run animate -- demo             # 3 diabetes examples (slides 3, 12, 14) -> animation/demos/*.mp4 + stills/
npm run dashboard                   # then open http://127.0.0.1:8788/#/studio  (preview, timeline editor, review)
npm run animate -- status           # template + approval state of every slide
npm run animate -- approve --slide 14 --reviewer "Dr Name"
npm run animate -- render [--slides 3,12,14] [--draft] [--quality draft|final] [--fps 24]
```

### Topic-specific scenes (enhanced animations)

Each slide of the Risk Factors for Diabetes course has an authored scene (pathway, converge, balance, body map, lab gauge,
HOMA-IR, OGTT panels, stage map, timeline, case board, algorithm rail) built from the slide's own wording and anchored to
phrases in its narration (`src/animation/scene/content.ts`). Content only applies when the slide title matches, so other
courses are unaffected and fall back to the generic key-points scene.

```bash
npm run animate -- analyze --force            # rebuild the plan (back up plan.json first; this resets reviews)
npm run animate -- preview                    # stills + contact sheets in animation/preview/
npm run animate -- preview --clips --slides 4,26   # short watermarked draft clips with narration
npm run animate -- review-pack                # animation/review-pack.md for the clinician
npm run animate -- render --enhanced --draft  # animation/enhanced/animated-video.enhanced.draft.mp4 (never overwrites the earlier video)
npm run animate -- render --enhanced          # final: refused until every slide is approved
npm run animate -- verify                     # duration, audio per slide, 1920x1080, topic-specific coverage
```

* Final renders include only slides that are **approved and unchanged since approval**; `--draft` renders everything with a "DRAFT — NOT CLINICALLY APPROVED" banner.
* Exact timing needs audio: run `npm run build-course` (or `preview-tts`) first, then `npm run animate -- analyze --force`. Without audio, durations are estimated from word count.
* `analyze --ai` optionally asks OpenAI to choose the template and write pop-ups (paid, needs `OPENAI_API_KEY`; `ANIMATION_AI_MODEL` to override the model). Nothing else calls an API.
* Edits made in the studio live in `animation/plan.json`; the source PPTX/DOCX are never modified.

---

## Cloud platform (multi-user)

The dashboard is one page (`public/`): upload, validate, edit slides/narration/animations, generate, review and watch.
See [docs/CLOUD.md](docs/CLOUD.md). Run it locally with `npm run cloud:dev` (http://127.0.0.1:8790/).
The previous local-engine page is kept, unlinked, at `public/legacy/` and still served by `npm run dashboard`.
Rendering on your own Windows PC instead of a cloud server: see [docs/ENGINE.md](docs/ENGINE.md) (`npm run engine`).

A video that is already in a private Vercel Blob store can be shown (play + download, sign-in required) without any database: see [docs/LIBRARY.md](docs/LIBRARY.md).
