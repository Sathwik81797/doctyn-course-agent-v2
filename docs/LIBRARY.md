# Private video library (Vercel Blob, no database)

Shows videos that are **already in your private Vercel Blob store** in the dashboard's *Generated Videos*, behind a
sign-in. No Postgres, no S3, nothing is uploaded or regenerated.

```
Browser ──sign in──► /api/v3 (one Vercel function)
   │                    │ invited user list (LIBRARY_USERS, scrypt hashes) → signed HttpOnly cookie
   └── Play / Download ─┤ authenticated stream (Range supported)
                        └──► private Blob store, read with BLOB_READ_WRITE_TOKEN (server side only)
```
The Blob token and the private blob URLs never reach the browser: the function reads the blob and streams the bytes.
The registered video is in `cloud/library-catalog.js` (pathname only):

| | |
|---|---|
| Title | Risk Factors for Diabetes – From Genetics to Lifestyle |
| Blob | `courses/diabetes/enhanced/animated-video.enhanced.draft.mp4` (store `store_aHlRyYRCJqGlD6dT`, 82,287,474 bytes) |
| Registered as | 52 slides · 15:15 · **enhanced DRAFT** (0 of 52 slides clinically approved) — never shown as published |

## What the site needs (Vercel project `doctyn-course-agent-v2`)

| Variable | State today | Purpose |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | already set (Production, Preview, Development) | server-side read of the private store |
| `APP_SECRET` | **missing** | signs the session cookies (32+ random characters) |
| `LIBRARY_USERS` | **missing** | who may sign in: `email=scrypt-hash`, comma separated |
| `DATABASE_URL` | must stay **unset** | when it is set the site runs in full mode instead and the library entry is not shown |

## Authentication setup (Git Bash)

Create a hash for each person (the password is never stored, only the hash):
```bash
cd ~/OneDrive/Desktop/doctyn-course-agent-v2
read -s -p "Password for you@example.com (10+ characters): " LIBRARY_PASSWORD; echo; export LIBRARY_PASSWORD
ENTRY=$(npm run --silent library:hash-password -- you@example.com)        # prints: you@example.com=scrypt$...
unset LIBRARY_PASSWORD
```
For several people, repeat and join the entries with commas.

Put the settings on Vercel:
```bash
printf '%s' "$ENTRY" | vercel env add LIBRARY_USERS production
openssl rand -hex 32 | tr -d '\n' | vercel env add APP_SECRET production
# optional, to test on a preview deployment first:
printf '%s' "$ENTRY" | vercel env add LIBRARY_USERS preview
openssl rand -hex 32 | tr -d '\n' | vercel env add APP_SECRET preview
```
- Add or remove people by changing `LIBRARY_USERS` and redeploying. Removing someone ends their access immediately, even
  with a cookie that has not expired.
- To sign everyone out at once, change `APP_SECRET`. Sessions last 7 days (`SESSION_DAYS`).

## Test it before deploying

```bash
npm run library:check -- --full      # live: real private Blob, real endpoint; compares the full stream with your local MP4
npm test                             # includes the endpoint and dashboard tests

# optional: the dashboard itself against the real Blob at http://127.0.0.1:8791/
printf 'LIBRARY_USERS=%s\n' "$ENTRY" >> .env.local     # .env.local is git-ignored
npm run library:dev
```

## Deploy (only when you decide to)

```bash
vercel            # preview deployment — sign in there first
vercel --prod     # production
```
Then open `https://doctyn-course-agent-v2.vercel.app/api/v3/health` — it must say `"mode":"library"`; sign in on the site and
play the video. A 503 lists exactly which setting is missing.

## Behaviour and limits

- Everything except sign-in needs a valid session; without one the API answers 401 and the Blob store is not read at all.
- The same single library is visible to every invited user (there are no per-user libraries in this mode).
- Responses are `private, no-store`; downloads are named `…-DRAFT-animated-video.mp4`.
- Uploading, editing, rendering and review need the full mode (database + storage + rendering engine); the dashboard says so
  instead of pretending.
- The function is allowed 60 s per request. Playback uses short Range requests; a download over a very slow connection can
  be cut off and must be resumed.
- Sign-in throttling is per warm function instance, in memory (best effort); the password hashing cost is the main brake.
- Sessions are stateless: an individual cookie cannot be revoked, only the user (remove from `LIBRARY_USERS`) or everyone
  (change `APP_SECRET`).
- Only the enhanced video is in the store, so there is no thumbnail, captions or transcript yet. To add them, upload the
  small files to the Blob store and add their pathnames to `cloud/library-catalog.js` (`thumbnail`, `vtt`, `srt`, `transcript`).
- The local workflow (`npm run cloud:dev`, importing `./output/*`) is unchanged and independent of this mode.

## Platform notes (both were found on the live site and are covered by tests)

- **Single-segment API paths only.** On the deployed site only `/api/v3/<one-segment>` reaches the function; `/api/v3/auth/me`
  is a Vercel 404 (`vercel dev` reproduces it). The dashboard therefore calls `/api/v3/route?p=auth/me`, and the server turns
  that back into the real route. A test fails if the page ever requests a multi-segment API path.
- **Request bodies.** The Vercel Node runtime consumes the request stream and gives the function a parsed `req.body`; code
  that only reads the stream sees an empty body (sign-in would always say "incorrect password"). `readJsonBody` handles both.
- After deploying, check with: `curl -s -H 'X-Requested-With: doctyn' 'https://doctyn-course-agent-v2.vercel.app/api/v3/route?p=meta'`
  (must show `"libraryMode":true`), then sign in on the site.
