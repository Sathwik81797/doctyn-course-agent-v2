# Doctyn Course Studio — one dashboard, local or hosted

One page (`public/`) does everything: upload PPTX + DOCX, validation, slide / narration / animation editing, voice
previews, video generation with progress, clinical review, and **Generated Videos** with playback and downloads.
The same page runs locally (`npm run cloud:dev`) and on Vercel; only where the data and the rendering live differs.

```
Browser ──► the dashboard  (public/ + one API function: api/v3/[...path].js)
              │  accounts, uploads, edits, signed download URLs, review, admin
              ├──► Postgres  (users, sessions, courses, job queue, audit log)
              └──► Private bucket  (users/<user>/courses/<course>/{source,output,cache,preview}/…)
                         ▲
Rendering engine ────────┘  claims jobs from Postgres (FOR UPDATE SKIP LOCKED); LibreOffice + Kokoro/OpenAI/Windows
 (your Windows PC, or Docker)  voice + FFmpeg + the V2 animation engine, via the unchanged build-course / animate commands
```

Local mode replaces Postgres with an in-process Postgres (PGlite), the bucket with a folder, and runs the engine inside the
same process. See `docs/ENGINE.md` for running the engine on your own Windows PC against a hosted database and bucket.

## Local use (nothing to configure)

```bash
cd ~/OneDrive/Desktop/doctyn-course-agent-v2
npm install
bash scripts/start-local-site.sh        # = npm run cloud:dev  →  http://127.0.0.1:8790/
```
- No sign-in screen: you are the single local user (admin and reviewer, and you may approve your own review).
- Data lives in `%LOCALAPPDATA%\Doctyn\data` and working files in `%LOCALAPPDATA%\Doctyn\work` — outside OneDrive, so
  private draft videos are not synced to a cloud drive.
- Courses already built into `./output/*` (for example the 52-slide diabetes course with its enhanced draft video) are
  added to **Generated Videos** on start. Nothing is re-rendered and the `output/` folder is only read.
  `DEV_IMPORT_OUTPUT=false` turns this off.
- The voice comes from `.env` (`TTS_PROVIDER=kokoro` for the local model, `windows` is free/offline, `openai` is paid).

Checks:
```bash
npm run typecheck
npm test                                  # API, queue, access control, review gate, and the real dashboard JS against the real API
npm run cloud:e2e                         # real upload → LibreOffice → voice → animations → FFmpeg → edit → re-generate → review → publish
```

## Hosted (Vercel) — what you must provide; nothing is created for you

| Need | Options | Notes |
|---|---|---|
| Postgres | Neon, Supabase, RDS, … | `DATABASE_URL` (pooled string for Vercel). Free tiers exist. |
| Private bucket | Cloudflare R2, AWS S3, Backblaze B2, MinIO | Keep it **private**. CORS rule: origin `https://doctyn-course-agent-v2.vercel.app`, methods `PUT, GET, HEAD`, headers `*`. |
| Rendering engine | Your Windows PC (`npm run engine`) or any Docker host (`Dockerfile.worker`) | While it is off, uploads and edits still work and jobs wait; the dashboard says "engine offline". |
| Vercel env vars | below | The project `doctyn-course-agent-v2` already exists. |

```bash
# Generate a secret:  openssl rand -hex 32
vercel env add APP_SECRET production
vercel env add DATABASE_URL production
vercel env add S3_BUCKET production
vercel env add S3_ACCESS_KEY_ID production
vercel env add S3_SECRET_ACCESS_KEY production
vercel env add S3_ENDPOINT production        # R2/B2/MinIO only
vercel env add ADMIN_EMAILS production       # your email: becomes administrator when you register
vercel env add REGISTRATION_MODE production  # approval (recommended) or open

vercel                  # preview deployment first
vercel --prod           # production — only when you decide to
```
Check `https://doctyn-course-agent-v2.vercel.app/api/v3/health`; a 503 lists exactly which settings are missing.
Move an existing local course into a hosted account:
`npm run cloud:import-course -- output/<course-folder> --email you@example.com` (uses the `.env` database/bucket).

## The workflow (all on the one page)

1. **Course files** — title, PPTX, DOCX. Shows the file names, validation status and slide count. Originals are never changed.
2. The engine validates: slide count must equal narration sections; missing slides are named. It also renders slide
   previews and plans a topic-specific animation for every slide (rule-based, no paid API).
3. **Edit Course** opens the editor inside the page: pick a slide; see its image and text; edit title and narration;
   edit the on-screen overlay text; add/remove medical explanation pop-ups; edit animation timings; hear a voice preview
   of the saved narration. **Save edits** stores them; any edit reopens medical review.
4. **Generate Video** uses the latest saved edits only: narration → voice → FFmpeg → *original* MP4 (+captions, transcript,
   thumbnail), then animations → *enhanced* MP4. Progress, stages and the engine log are live. Only slides whose
   text changed are re-recorded and re-rendered (audio and segments are cached).
5. **Clinical review**: a medical reviewer (a different person on a hosted site) approves the exact content. Until then the
   enhanced video is a watermarked **draft**; after approval, **Render approved video** produces the final, and **Publish**
   is allowed only for an approved, current video.
6. **Generated Videos** — thumbnail, title, slides, duration, status, versions (original / enhanced draft / clinically
   approved final), Play (inside the page), Download MP4, VTT, SRT, Transcript, **Edit Again**.

## Security model and limits

- Passwords: scrypt. Sessions: random 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie, only its SHA-256 stored. Sign-in is throttled per email and IP.
- Every course query is scoped to its owner. **Admins can manage users and jobs but the API never returns other users' slides, narration or files.** Reviewers can read only courses with a pending review.
- Storage is private; the app hands out 15-minute signed URLs after an ownership check. Draft (unapproved) videos are owner-only like everything else; nothing is public.
- State-changing requests require `X-Requested-With: doctyn` and a same-origin `Origin`.
- The Content-Security-Policy allows `https:` for media/images/uploads because signed storage URLs use your bucket's host; tighten `vercel.json` to that host once known.
- Local mode (`DEV_AUTO_LOGIN`) is refused whenever `VERCEL`/`NODE_ENV=production` is set.
- Not implemented: password reset, email verification, MFA, rate limiting beyond sign-in, virus scanning of uploads, in-browser editing of slide *visuals* (the PPTX itself is never edited — overlays and pop-ups are added to the animated version).
- Captions are timed to the original narrated video; the enhanced video's slide boundaries differ by a fraction of a second.
- The engine runs LibreOffice on user-supplied Office files: run it on an isolated machine or container.
- The software flags AI-derived wording and gates publication on a reviewer's approval; it cannot judge clinical correctness.
