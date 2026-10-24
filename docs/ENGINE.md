# Connecting the website to your Windows PC

```
Browser ─► https://doctyn-course-agent-v2.vercel.app          (Vercel: pages + /api/v3, stateless)
                │                                  ▲
                ▼                                  │ progress, results
        Postgres (jobs, users)  +  private bucket (files, videos)     ◄── free-tier hosted services
                ▲                                  ▲
                └──────── outbound HTTPS only ─────┘
                            Your Windows PC:  npm run engine
                            LibreOffice · AI voice (Kokoro/OpenAI/Windows) · FFmpeg · animation engine
```

**How the connection is secured.** The PC never accepts inbound connections: no tunnel, no open port, no public address.
The engine dials *out* to the database and bucket with credentials that only live in your PC's `.env` and in Vercel's
environment. Users never talk to your PC; they talk to the website, which queues work. If the PC is off, uploads and
edits still work, jobs wait ("Windows engine offline" banner), and rendering starts when you run the engine. A job
interrupted by a shutdown is detected within ~2 minutes and resumed (audio already made is reused).

## One-time external setup (needs your accounts; I have not created anything)

You need a hosted **Postgres** and a **private S3-compatible bucket**. Both have free tiers; check current limits and
whether a card is required.

| Service | Use | Notes |
|---|---|---|
| Neon (Postgres) or Supabase (Postgres) | `DATABASE_URL` | Prefer the pooled connection string for Vercel. |
| Cloudflare R2 (S3 API) | `S3_*` | 10 GB free at time of writing; R2 asks for a payment method. Backblaze B2 is an alternative. |

1. Create the database and bucket (bucket **private**).
2. Bucket CORS: origin `https://doctyn-course-agent-v2.vercel.app`, methods `PUT, GET, HEAD`, allowed headers `*`.
3. Create **two** bucket API keys if the service allows: one for Vercel, one for the PC (revoke either independently).
4. Put the settings in Vercel (Production) — see `docs/CLOUD.md` — and in the PC's `.env`:

```
APP_SECRET=<same value as Vercel>
DATABASE_URL=postgres://...
S3_BUCKET=...  S3_ACCESS_KEY_ID=...  S3_SECRET_ACCESS_KEY=...  S3_ENDPOINT=https://<id>.r2.cloudflarestorage.com
TTS_PROVIDER=kokoro        # or openai (paid) / windows (free)
```

## Launch (Git Bash)

```bash
cd ~/OneDrive/Desktop/doctyn-course-agent-v2
npm install
npm run test-services          # LibreOffice, FFmpeg, voice engine
bash scripts/start-engine.sh   # leave this window open while you want videos generated
```
Create the first administrator (once; uses the production database from `.env`):
```bash
ADMIN_PASSWORD="a long password" npm run cloud:create-admin -- you@example.com "Your Name"
```
The engine refuses to start (with a readable message) if LibreOffice/FFmpeg are missing, the OpenAI key is missing
for `TTS_PROVIDER=openai`, or the database/bucket settings are incomplete.

## Test everything on this PC first (no accounts needed)

```bash
bash scripts/start-local-site.sh      # http://127.0.0.1:8790/  (the dashboard + DB + storage + engine in one process)
TTS_PROVIDER=windows npm run cloud:e2e   # scripted upload -> render -> download -> review -> publish
```
With Docker Desktop running you can also test the production Postgres and S3 drivers (see `docker-compose.dev.yml`).

## Things to know
- Do not deploy until the services above exist; nothing in this repo deploys automatically.
- Keep `.env` private (it is git-ignored). The engine's work folder is `%LOCALAPPDATA%\Doctyn\work`, outside OneDrive.
- If several people submit jobs, they run one at a time on your PC, oldest first.
- Anyone who obtains the PC's `.env` has database and bucket access; treat that machine accordingly.
