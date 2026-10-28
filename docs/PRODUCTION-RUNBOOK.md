# Production migration runbook — sathwik.ind@gmail.com, Neon, private Vercel Blob

Everything below runs in **Git Bash** from the project folder. Nothing here changes Vercel Production; the live site stays in
library mode until you do step 8 yourself.

```bash
cd ~/OneDrive/Desktop/doctyn-course-agent-v2
```

## What is already prepared on this PC

* `.env` (git-ignored) has `STORAGE_DRIVER=blob` and a generated `APP_SECRET` (any 32+ character value works on the PC; it does not
  have to equal Vercel's, because the engine never checks sessions). `TTS_PROVIDER=kokoro` was already there.
* `DATABASE_URL` (Neon) comes from your Windows environment; `BLOB_READ_WRITE_TOKEN` comes from `.env.local`.
* `npm run engine:check` → **ENGINE READY** (Neon reachable and empty, Blob reachable with the library video at 82,287,474 bytes,
  FFmpeg, ffprobe, LibreOffice, Kokoro). It only reads.
* The dry run works end to end with a placeholder password hash (Neon stayed at 0 tables). Only the real owner hash is missing.

## 1. Put the owner's existing password hash in a local file (the one manual step)

`LIBRARY_USERS` on Vercel is a hidden secret; it cannot be read back (and I did not try to extract it). Choose one:

**A. You still have the original `email=scrypt$…` line** (printed when you ran `library:hash-password`, or saved in a password manager):
```bash
mkdir -p .data
# single quotes are required: the hash contains $ characters
printf '%s\n' 'sathwik.ind@gmail.com=scrypt$PASTE$THE$REST' > .data/library-users.txt
```
This keeps the *identical* hash.

**B. You only know the password.** Re-hash it (a new salt, so the string differs, but the same password signs in):
```bash
mkdir -p .data
read -s -p "Library password for sathwik.ind@gmail.com: " LIBRARY_PASSWORD; echo; export LIBRARY_PASSWORD
npm run --silent library:hash-password -- sathwik.ind@gmail.com > .data/library-users.txt
```
`.data/` is git-ignored. The file holds a hash, never the password.

## 2. Dry run (reads only — no table, no row, no file is created)

```bash
read -s -p "Library password for sathwik.ind@gmail.com: " LIBRARY_PASSWORD; echo; export LIBRARY_PASSWORD
npm run library:migrate -- plan --users-file .data/library-users.txt \
  --owner sathwik.ind@gmail.com --admin sathwik.ind@gmail.com --no-cache --check-password --check-live
unset LIBRARY_PASSWORD
```
`--check-password` proves the password you typed matches the hash in the file; `--check-live` signs in once on the live library site
with it, proving it is the password you use today. **Do not continue unless every line is `[ok]` and you see:**

* `+ create sathwik.ind@gmail.com (admin)` and `+ import → sathwik.ind@gmail.com` (one account, one course — no duplicates);
* `the enhanced draft video is 82287474 bytes, the same size as the private Blob object`;
* `the enhanced video is referenced where it already is (read-only), not uploaded again` (no second copy of the 82 MB video);
* `The enhanced video will keep its DRAFT status`;
* `Neon … is reachable and has no tables yet` and `the password … matches`, `signs in on the live site`.

`--no-cache` stores only about 46 MB (the narrated video, thumbnail, captions, transcript and the two source files). Without it a
further ~138 MB of reusable audio/segments is stored so an edit re-records only changed slides; with it, the first edit re-records
all slides (free with Kokoro, just slower).

## 3. Real migration (first database write)

```bash
npm run library:migrate -- apply --users-file .data/library-users.txt \
  --owner sathwik.ind@gmail.com --admin sathwik.ind@gmail.com --no-cache --yes
```
It creates the tables in Neon, inserts the one account with the preserved hash, imports the course (≈46 MB into `v2/` in Blob; the
enhanced draft is referenced in `courses/…`), and writes an undo record to `.data/library-migration.json`. It is safe to re-run
(it will not duplicate the account or the video).

## 4. Start the engine and verify ownership and video access

```bash
bash scripts/start-engine.sh        # leave this window open; it re-reads the slides and builds the animation plan (a few minutes)
```
In a second Git Bash window:
```bash
read -s -p "Library password: " LIBRARY_PASSWORD; echo; export LIBRARY_PASSWORD
npm run library:migrate -- verify --users-file .data/library-users.txt \
  --owner sathwik.ind@gmail.com --no-cache --check-password
unset LIBRARY_PASSWORD
```
Expected: account active with the library password hash, the course complete and marked DRAFT, every stored file present, password matches.
`npm run engine:check` again should now show the account count.

## 5. Preview before production (optional but recommended)

Run these yourself; they touch only the **preview** scope and do not deploy until the last line:
```bash
printf '%s' "$DATABASE_URL" | vercel env add DATABASE_URL preview      # the Neon pooled string
printf 'blob' | vercel env add STORAGE_DRIVER preview
openssl rand -hex 32 | tr -d '\n' | vercel env add APP_SECRET preview
printf 'sathwik.ind@gmail.com' | vercel env add ADMIN_EMAILS preview
printf 'approval' | vercel env add REGISTRATION_MODE preview
vercel                                                                 # preview deployment, not production
```
Open the preview URL, sign in as sathwik.ind@gmail.com with the library password, open **Generated Videos**, play the enhanced draft
(it shows as DRAFT), check `/api/v3/health` reports `"mode":"full"`. Preview deployments may sit behind Vercel's own login.

## 6. What is still needed for real use

* A **second person with the reviewer role** (a hosted site refuses self-approval). They register, you approve, then promote them in the admin panel.
* Keep `bash scripts/start-engine.sh` running while anyone should be able to generate videos; uploads and edits still work while it is off and jobs wait.

## 7. Roll back the migration (only if needed)

```bash
npm run library:migrate -- rollback                  # dry run: lists what would be removed
npm run library:migrate -- rollback --apply          # removes only the account/course this migration created
```
The Blob library video is never removed.

## 8. Switching production (do not do this until steps 2–5 are verified)

```bash
printf '%s' "$DATABASE_URL" | vercel env add DATABASE_URL production
printf 'blob' | vercel env add STORAGE_DRIVER production
printf 'sathwik.ind@gmail.com' | vercel env add ADMIN_EMAILS production
printf 'approval' | vercel env add REGISTRATION_MODE production
vercel --prod
curl -s https://doctyn-course-agent-v2.vercel.app/api/v3/health        # must show "mode":"full"
```
`APP_SECRET` and `BLOB_READ_WRITE_TOKEN` already exist on Production and stay as they are. **Rollback to library mode:**
`vercel env rm DATABASE_URL production`, `vercel --prod` — `LIBRARY_USERS` and the Blob video were never touched, so the old logins and
video come straight back.
