# Production activation checklist — full online generation

Status when written (2026-10-26): inspection only. Nothing was deployed, no environment variable was changed or created, and no
external service was contacted except two read-only GETs of the live `/api/v3` health/meta endpoints and `vercel env ls`.

## 0. Second pass (same day): what is now built

| Item | State |
|---|---|
| Topic-independent animation planner (8 reusable medical components, categories, objectives, optional AI, deterministic fallback) | Built and tested — `docs/ANIMATION-PLANNER.md`. Resolves the gap in section 5. |
| Dashboard preview + label editing for animation choices | Built (`public/scene.js` bundle; `npm run build:preview`) |
| Non-diabetes quality test (acute coronary syndromes deck, real PPTX/DOCX through the real parsers, 4 slides rendered to a real MP4) | Passing |
| `npm run library:migrate` (plan / apply / verify / rollback; dry run by default) | Built and tested — `docs/MIGRATION.md`. Closes the user-migration gap in section 2.1 |
| Test suite | 162 / 162 pass; `TTS_PROVIDER=windows npm run cloud:e2e` passes (real LibreOffice, voice, FFmpeg) |
| Production, Vercel settings, Blob store | **Untouched.** Still library mode; nothing deployed, committed or deleted |

Still open: the external services (section 3), a run against the real Postgres/S3 drivers (docker compose or Neon/R2), the
second reviewer account, committing the working tree, and a preview deployment before `DATABASE_URL` goes on Production.

## 1. Where things stand (first pass)

| Item | State |
|---|---|
| Live site mode | **library mode** (`/api/v3/health` → `"mode":"library"`; meta → `"libraryMode":true, "maxUploadBytes":0`) |
| Vercel env (Production) | `APP_SECRET`, `LIBRARY_USERS`, `BLOB_READ_WRITE_TOKEN` (also Preview/Development). **No** `DATABASE_URL`, `S3_*`, `ADMIN_EMAILS`, `REGISTRATION_MODE` |
| Full platform code (upload, edit, voice preview, plan, build, animate, review, publish, queue, worker) | Implemented, same single dashboard |
| `npm run typecheck` | clean |
| `npm test` | 126 / 126 pass (full API + queue + access control + review gate + dashboard JS run on in-process Postgres and disk storage) |
| Library-mode work (`cloud/library*.js`, `api/v3`, `public/app.js` edits, tests, docs) | **uncommitted** in the working tree; the live site was deployed from it |
| Not yet exercised | real Postgres + S3 drivers, `npm run cloud:e2e` (real render), browser → bucket upload with CORS on the live origin |

## 2. The cutover is atomic — this is the main risk

`libraryModeConfigured()` is true only while `DATABASE_URL` is **unset**. The moment `DATABASE_URL` is set, `api/v3` serves full mode
and the library entry, the `LIBRARY_USERS` accounts and the Blob-hosted diabetes video are no longer reachable. Full mode has its
own `users` table and bucket. So requirements 7–9 need a migration *before* `DATABASE_URL` goes on production:

1. Users: `LIBRARY_USERS` stores `email=scrypt$salt$hash` produced by the same `hashPassword()` that full mode uses, so the hashes can
   be inserted into `users` (`role='user'`, `status='active'`) as-is and people keep their passwords. **No script for this exists yet.**
2. Diabetes video: `npm run cloud:import-course -- output/risk-factors-for-diabetes-from-genetics-to-lifestyle --email <owner>` copies the
   original MP4, captions, transcript, thumbnail, the enhanced **draft** MP4 (stays a draft), sources and the audio/segment cache into
   the bucket under that owner and queues a parse (no re-render). It exists and is tested; it reads the local `output/` folder, which is present.
3. Everyone who could previously see the shared diabetes video must be given it individually: full mode has per-user libraries
   (library mode showed one shared video to all invited users). Decide the owner, and whether others get a copy or a reviewer/admin role.
4. Rollback: remove `DATABASE_URL` and redeploy. Keep `LIBRARY_USERS` and `BLOB_READ_WRITE_TOKEN`; do not delete the Blob video.

Recommended order: commit → create services → test full mode locally against the real services (below) → preview deployment with
its own preview-scoped env vars (Preview currently has no `APP_SECRET`/`DATABASE_URL`) → migrate users + video → set production env → `vercel --prod`.

## 3. External services and credentials still required (none created)

| # | Need | Why | Where it goes |
|---|---|---|---|
| 1 | Hosted Postgres (Neon / Supabase / RDS) | users, sessions, courses, job queue | `DATABASE_URL` (pooled string) in Vercel **and** the PC `.env` |
| 2 | Private S3-compatible bucket (Cloudflare R2 / Backblaze B2 / S3) | source files, audio cache, videos | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`; ideally two key pairs (Vercel, PC) |
| 3 | Bucket CORS | direct browser uploads/downloads | origin `https://doctyn-course-agent-v2.vercel.app`, methods `PUT, GET, HEAD`, headers `*` |
| 4 | `APP_SECRET` | already set in Production but hidden; the PC needs the same value | If the value is not saved elsewhere, rotate it (signs out library sessions, which are replaced anyway) |
| 5 | `ADMIN_EMAILS`, `REGISTRATION_MODE=approval` | first administrator; invite-style sign-up | Vercel |
| 6 | First admin password | `ADMIN_PASSWORD=… npm run cloud:create-admin -- <email> "<name>"` | run once against the production DB |
| 7 | A **second person** with the reviewer role | hosted sites refuse self-approval unless `ALLOW_SELF_REVIEW=true` | admin sets role in the dashboard |
| 8 | Windows PC engine | LibreOffice, FFmpeg, Kokoro (model already in `models/`), animation renderer | `.env` on the PC with items 1, 2, 4; `TTS_PROVIDER=kokoro` (free); run `npm run test-services` then `bash scripts/start-engine.sh` |
| 9 | `OPENAI_API_KEY` | **optional**: only for the AI animation planner (`gpt-4o-mini`) or `TTS_PROVIDER=openai` | PC `.env` only |

Credentials are not needed for: LibreOffice, Kokoro, FFmpeg, the rule-based animation planner.

## 4. Requirement-by-requirement

| # | Requirement | Status |
|---|---|---|
| 1–2 | Same single dashboard, no second site | Met — one `public/` page, one `api/v3` function |
| 3, 9 | Preserve library and diabetes video during transition | Met **only if** section 2 is followed; at cutover it is otherwise lost from view |
| 4–5 | Reuse LibreOffice/Kokoro/FFmpeg/templates, Postgres jobs, Windows worker | Implemented (`src/worker/*`, `cloud/queue.js`) |
| 6 | Upload, validation, editing, voice previews, planning, generation, progress, review, Generated Videos | Implemented and covered by tests; not yet run end to end against real services |
| 7 | Private, authenticated, user-scoped storage | Implemented: ownership checks, 15-min signed URLs, admins cannot read others' files. Needs a **private** bucket |
| 8 | Existing users preserved | Not implemented — migration script needed (section 2.1) |
| 10 | Worker offline → jobs stay queued | Implemented: `workers` heartbeat table, "engine offline" banner, stale jobs re-queued after 120 s. Note validation (parse) also needs the worker, so a fresh upload shows "waiting for engine" until the PC is on |
| 11 | No V1 rendering as final | Final output is the `animate` job (`--enhanced`). The narrated V1 video is still built first (it supplies audio/timing) and is shown as "original"; it is never labelled as the enhanced result |
| 12 | Animations chosen from each video's own content | **Partly met — see section 5** |
| 13 | Tests | 126 pass; real-service E2E still to run (section 6) |
| 14 | Services/credentials | Section 3 |
| 15 | No automatic deploy/env changes | Honoured |

## 5. Decision needed: "same standard as the diabetes video"

The diabetes video's richness comes from hand-authored scenes for 48 of 52 slides (`src/animation/scene/content.ts`), matched by
slide number **and** a title pattern (a guard stops them appearing on other courses — tested). For any other course:

- the rule-based analyzer only recognises diabetes-specific signals (GLUT-4, visceral fat, continuum of stages);
- everything else becomes the generic `key-points` card scene (concepts appear in step with narration, pop-ups for glossary terms);
- the other templates (`pathway`, `converge`, `balance`, `body`, `lab-branch`, `homa`, `ogtt`, `case`, `algorithm`, …) are never chosen for a new topic.

So a new cardiology or renal deck would render as enhanced key-point cards, which is content-driven and safe but not the same standard.
Options: (a) accept it and label it honestly; (b) enable the optional AI planner, which can pick any catalogue template per slide and
add pop-ups (needs `OPENAI_API_KEY`, small cost, its picks are flagged for clinician review); (c) build topic-agnostic structural rules
(for example: sequence language → `pathway`, "contributes to / leads to" → `converge`, lab-value lists → `lab-branch`). (c) is real work and I would
test it on a non-diabetes sample deck.

## 6. Verification still to do (in this order, all before any deploy)

1. Commit the current working tree.
2. Add and test the user-migration script (insert from `LIBRARY_USERS`, idempotent, dry-run first).
3. `docker compose -f docker-compose.dev.yml up -d`, then the `E2E_REAL=1 … npm run cloud:e2e` command from that file (real Postgres + S3 drivers, real render).
4. Same E2E against the real Neon/R2 pair using a throwaway test user, then delete the test course.
5. Upload a non-diabetes deck and confirm the plan, template choices and the review flags look right.
6. Preview deployment; check `/api/v3/health` says `"mode":"full"`, upload from the browser (CORS), sign in as a migrated user, play the diabetes draft.
7. With the PC engine switched off, confirm a build stays `queued`; switch it on and confirm it completes.

## 7. Known limits (from `docs/CLOUD.md`)

No password reset, email verification or MFA; rate limiting only on sign-in; no virus scanning of uploads; CSP allows `https:` media until
the bucket host is known (tighten `vercel.json`); the engine runs LibreOffice on user-supplied files, so use an isolated machine; the
software flags AI-derived wording and gates publication on a reviewer, but it cannot judge clinical correctness.
