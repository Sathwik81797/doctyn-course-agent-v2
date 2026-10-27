# Full online workflow on the existing private Vercel Blob store (no Cloudflare R2, no S3)

```
Browser ──presigned PUT (one file, size-capped, 15 min)──────────────► private Blob store  v2/users/<owner>/courses/<course>/…
Browser ◄─presigned GET (one file, 15 min, ranges)──────────────────── private Blob store
Website (Vercel function) ── BLOB_READ_WRITE_TOKEN: signs the links after the ownership check; never sent to a browser
Windows engine ───────────── BLOB_READ_WRITE_TOKEN: downloads sources, uploads audio / previews / captions / MP4s (multipart, streamed)
Neon Postgres ────────────── users, sessions, courses, job queue (DATABASE_URL)
```

The same store still holds the library video under `courses/…` (library mode). Full mode keeps everything under one folder,
`v2/` (`BLOB_PREFIX`); the adapter cannot list, write or delete outside it. The one exception is read-only: a course may point at a
registered library file with a `library:<pathname>` key (the diabetes video is referenced this way instead of being copied).

## Settings (no S3 values, no new credentials)

| Where | Variable | Value |
|---|---|---|
| Vercel (website) and the PC's `.env` | `STORAGE_DRIVER` | `blob` |
| both | `BLOB_READ_WRITE_TOKEN` | the existing token (already set on Vercel; `vercel env pull .env.local` gives the PC a copy) |
| both | `DATABASE_URL` | your Neon connection string (pooled on Vercel; the PC may use either) |
| both | `APP_SECRET` | the same random 32+ character value |
| Vercel | `ADMIN_EMAILS`, `REGISTRATION_MODE` | as in `docs/CLOUD.md` |
| optional | `BLOB_PREFIX` | folder for V2 files, default `v2` (never `courses`) |
| optional | `DB_SCHEMA` | keep the tables in their own Postgres schema (direct connection only) |

Browsers upload straight to Blob, so file size is not limited by the Vercel function (`MAX_UPLOAD_MB`, default 200, is enforced by
the signed URL and again when the upload is registered). The database connection verifies Neon's TLS certificate
(`DATABASE_SSL=no-verify` is the explicit opt-out).

## What is verified (all run against the real services unless marked)

* `npm run blob:check` — live adapter contract on your real store in a throw-away folder: presigned upload, size cap, one-time URL,
  signed ranged download, multipart upload + streamed download with hash comparison, list, delete, and a read-only size check of the
  library video.
* `E2E_DB=neon E2E_STORAGE=blob npm run cloud:e2e` — the whole website workflow on Neon + Blob with the voice from `.env` (Kokoro):
  PPTX + DOCX upload → validation → editing → animation planning → voice preview → generation (voice, V2 animations, FFmpeg) →
  captions/transcript → Generated Videos → edit again (only the changed slide re-recorded) → clinical review → approved render →
  publish → privacy. Uses a throw-away Neon schema and a throw-away Blob folder, both removed at the end.
* `npm run library:rehearse` — the migration on Neon + Blob in throw-away namespaces: accounts keep their password hashes, the
  diabetes video is listed as an enhanced DRAFT and streams from the original library object (no copy), rollback removes only what it made.
* `npm test` — the same flows against an in-memory Blob service that mimics the live one (`test/helpers/fake-blob.ts`).

## Limits

* A downloaded file is named after its stored name (`final-video.mp4`), because Blob sets `Content-Disposition` from the pathname.
* Presigned uploads are limited by what a single browser request can carry; 200 MB PPTX/DOCX files are fine (60 MB measured at about
  3.5 MB/s from this PC).
* Blob storage and transfer quotas are those of your Vercel plan; a full course with cache is roughly 260 MB (about 46 MB without the
  cache and with the enhanced video referenced). Check the plan's current limits.
* The `x-vercel-blob` presigned-URL API is new; the adapter pins `@vercel/blob` 2.8.x and `npm run blob:check` is the quick way to
  re-verify after an upgrade.
