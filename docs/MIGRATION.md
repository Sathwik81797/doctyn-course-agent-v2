# Library mode → full mode: safe migration

The live site today runs in **library mode** (`LIBRARY_USERS` + one private Blob video, no database). Full mode (upload, edit,
generate) uses Postgres + a private bucket. Setting `DATABASE_URL` on Vercel flips the site from one to the other at once, so the
accounts and the video must already exist in the new place before that happens. `npm run library:migrate` does that — as a dry
run first — without touching the live site.

## What it does and does not do

| It does | It never does |
|---|---|
| Creates a Postgres account for each `LIBRARY_USERS` entry with the **same scrypt hash** (same passwords) | Write or delete anything in the private Vercel Blob store (on Blob storage it only reads the size of the library video and references it read-only) |
| Leaves an account that already exists exactly as it is (password and role) | Change Vercel settings, redeploy, or switch the live site's mode |
| Imports the finished course from `output/<course>/` (the file whose size matches the Blob object) into the owner's library — or each user's, with `--share all` | Re-render, re-record or publish anything |
| Keeps the enhanced video a **DRAFT** (0 of 52 slides approved), private to each account | Approve or publish a video |
| Makes the video playable at once (status `complete`); the engine later re-reads the sources so it can be edited | Overwrite an existing account |
| Records everything it created in `.data/library-migration.json`, so it can be undone | Remove anything it did not create |

## Steps (nothing here changes the live site until step 6)

0. Have the target services ready (Neon Postgres and the private Vercel Blob store) — see `docs/BLOB-STORAGE.md`. The PC needs
   `DATABASE_URL`, `STORAGE_DRIVER=blob`, `BLOB_READ_WRITE_TOKEN` and any 32+ character `APP_SECRET` (never in the repo).
   `npm run engine:check` verifies all of it read-only. The exact commands for the real run are in `docs/PRODUCTION-RUNBOOK.md`.
1. Collect the library users. The production `LIBRARY_USERS` is a hidden Vercel secret and cannot be read back; put the same
   `email=scrypt$…` entries in a file (one per line) — your password manager or the shell where you created them. Lost them?
   create new ones with `npm run library:hash-password`.
2. **Dry run** (read-only: with `DATABASE_URL` it inspects Neon with SELECTs and never creates tables; add `--check-password` and
   `--check-live` to prove the hash/password):
   ```bash
   npm run library:migrate -- plan --users-file users.txt --owner you@example.com --admin you@example.com
   # add --share all to give every migrated user a private copy (about 260 MB each, including the reusable audio/segment cache)
   ```
3. **Apply** (writes to the database and bucket in `.env`; refuses without `--yes`):
   ```bash
   npm run library:migrate -- apply --users-file users.txt --owner you@example.com --admin you@example.com --yes
   ```
4. Start the engine so it finishes reading the sources: `bash scripts/start-engine.sh`, then
   ```bash
   npm run library:migrate -- verify --users-file users.txt --owner you@example.com
   ```
   (accounts active with the library password, the enhanced video is marked DRAFT, every stored file is in the bucket).
5. Test on a **preview** deployment with its own preview-scoped variables; sign in as a migrated user and play the draft.
6. Only then set `DATABASE_URL`, `STORAGE_DRIVER=blob`, `ADMIN_EMAILS`, `REGISTRATION_MODE` on Production and redeploy.
   `/api/v3/health` must say `"mode":"full"`.

## Rollback

* **Back to library mode (fast, nothing deleted):** remove `DATABASE_URL` from Vercel Production and redeploy. `LIBRARY_USERS`,
  `APP_SECRET`, `BLOB_READ_WRITE_TOKEN` and the Blob video are untouched, so the site serves the library again, same logins.
  Anything people created in full mode stays in Postgres/the bucket for when you switch back.
* **Undo the migration itself:** `npm run library:migrate -- rollback` (dry run), then `… rollback --apply`. It removes only the
  accounts and courses recorded in the manifest. An account that has since created its own courses is kept and reported. Stop the
  engine first if a parse job is running.

## Facts worth knowing

* Library mode showed one shared video to everyone. In full mode each account has its own library: with the default
  `--share owner` only the owner sees the diabetes video. Use `--share all` (or copy it later) for the others.
* Hosted full mode refuses self-approval: a **different** account must hold the reviewer role to approve a course.
* Until the engine has finished its first job for the imported course, the card says the video is "out of date" (its content hash is
  not computed yet); the video itself plays.
* Sessions: library cookies are not valid in full mode; everyone signs in once.
* The migration reads `./output/…` on this PC. If that folder is gone, import from a backup copy with `--course-dir`.
