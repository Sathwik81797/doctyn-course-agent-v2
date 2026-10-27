/**
 * Library mode -> full mode migration (dry-run first).
 *
 * Library mode keeps its invited users in LIBRARY_USERS (email=scrypt hash) and its one video in a private Vercel Blob
 * store. Full mode keeps users in Postgres and videos in the private bucket. This module moves exactly that, and nothing else:
 *
 *   users   every LIBRARY_USERS entry becomes an active account with the SAME password hash, so nobody has to reset a password.
 *           An account that already exists is never touched (its password and role stay as they are).
 *   video   the finished course in ./output/<course>/ (the very file that was uploaded to Blob; verified by size) is imported
 *           into the owner's library, and optionally into every migrated user's library. The enhanced video keeps its DRAFT status.
 *   undo    every row and bucket object created here is recorded in a manifest; rollback removes only those.
 *
 * It never reads from, writes to or deletes anything in the Vercel Blob store, and it never changes Vercel settings: switching
 * the live site to full mode is setting DATABASE_URL, and going back is removing it again (the library variables stay in place).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { cleanEmail } from "../../cloud/auth.js";
import { LIBRARY_VIDEOS, type LibraryVideo } from "../../cloud/library-catalog.js";
import type { Ctx } from "../../cloud/routes.js";
import { courseKeys } from "../../cloud/util.js";
import { LIBRARY_KEY_PREFIX } from "../../cloud/storage-blob.js";
import { importCourse } from "../worker/import-course.js";

export type Level = "error" | "warn" | "info";
export interface Finding {
  level: Level;
  text: string;
}

export interface MigrationInput {
  /** lower-case email -> scrypt hash, exactly as in LIBRARY_USERS */
  users: Map<string, string>;
  /** account that owns the imported video */
  owner: string;
  /** "owner": only the owner gets the video; "all": every migrated user gets their own private copy */
  share: "owner" | "all";
  /** emails that become administrators (only for accounts this migration creates) */
  admins: string[];
  /** ./output/<course> folder holding the finished course */
  courseDir: string;
  /** library catalogue entry the folder must correspond to */
  video?: LibraryVideo;
  /** Keep the reusable audio / slide / segment cache in storage (default true; it is about half of the stored size). */
  cache?: boolean;
  /** storage driver the import will use ("blob" references the library video in place); defaults to the connected one */
  storageDriver?: string;
}

export interface UserPlan {
  email: string;
  action: "create" | "exists" | "exists-different-password";
  role: "user" | "admin";
}
export interface ImportPlan {
  email: string;
  action: "import" | "already-imported";
}
export interface MigrationPlan {
  ok: boolean;
  findings: Finding[];
  users: UserPlan[];
  imports: ImportPlan[];
  video: { title: string; slideCount: number; durationSeconds: number; enhanced: "draft" | "final" | "none"; enhancedBytes: number; totalBytes: number; cacheBytes: number; perCopyBytes: number } | null;
  /** True when no database was consulted (dry run without DATABASE_URL): every account is assumed new. */
  databaseChecked: boolean;
}

export interface Manifest {
  version: 1;
  at: string;
  courseSlug: string;
  users: Array<{ email: string; id: string }>;
  courses: Array<{ email: string; ownerId: string; courseId: string; importKey: string }>;
}

// ---------- parsing ----------

/** Same format as LIBRARY_USERS; reports malformed entries (without echoing any hash) instead of silently skipping them. */
export function parseUsersStrict(text: string): { users: Map<string, string>; skipped: string[] } {
  const users = new Map<string, string>();
  const skipped: string[] = [];
  for (const entry of text.split(/[\n,]+/)) {
    const e = entry.trim();
    if (!e || e.startsWith("#")) continue;
    const i = e.indexOf("=");
    const email = i > 0 ? e.slice(0, i).trim().toLowerCase() : "";
    const hash = i > 0 ? e.slice(i + 1).trim() : "";
    if (!email || !/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(hash)) {
      skipped.push(email || `entry ${skipped.length + 1}`);
      continue;
    }
    try {
      users.set(cleanEmail(email), hash);
    } catch {
      skipped.push(email);
    }
  }
  return { users, skipped };
}

const nameFromEmail = (email: string): string => email.split("@")[0]!.replace(/[._-]+/g, " ").trim().slice(0, 100) || "Library user";

const REQUIRED = ["course.json", "presentation.pptx", "voiceover-script.docx", "final-video.mp4", "thumbnail.jpg", "captions.vtt", "captions.srt", "transcript.txt"];

async function size(file: string): Promise<number | null> {
  return fs.stat(file).then((s) => (s.isFile() ? s.size : null), () => null);
}

/** Total size of the files under a folder (0 when it does not exist). */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirBytes(p) : (await size(p)) ?? 0;
  }
  return total;
}

// ---------- plan (read only) ----------

export async function planMigration(ctx: Ctx | null, input: MigrationInput): Promise<MigrationPlan> {
  const findings: Finding[] = [];
  const add = (level: Level, text: string): void => void findings.push({ level, text });
  const owner = input.owner.toLowerCase();
  const admins = new Set(input.admins.map((a) => a.toLowerCase()));

  if (input.users.size === 0) add("error", "No library users were found. Provide LIBRARY_USERS (email=scrypt-hash, comma separated) in the environment or with --users-file.");
  if (!input.users.has(owner)) add("error", `The owner ${owner} is not one of the library users, so there is no existing account to hand the video to.`);
  for (const a of admins) if (!input.users.has(a)) add("warn", `${a} is listed as an administrator but is not a library user; no account is created for it.`);

  // ---- the course folder must be the video that library mode serves
  let video: MigrationPlan["video"] = null;
  const catalog = input.video ?? LIBRARY_VIDEOS[0];
  let meta: { courseTitle?: string; slideCount?: number; durationSeconds?: number; courseSlug?: string; generatedAt?: string } | null = null;
  try {
    meta = JSON.parse(await fs.readFile(path.join(input.courseDir, "course.json"), "utf8"));
  } catch {
    add("error", `${input.courseDir} has no readable course.json. Point --course-dir at the finished output/<course> folder.`);
  }
  if (meta) {
    let totalBytes = 0;
    for (const f of REQUIRED) {
      const s = await size(path.join(input.courseDir, f));
      if (s === null) add("error", `${f} is missing from ${input.courseDir}; the importer needs it.`);
      else totalBytes += s;
    }
    const enhancedDir = path.join(input.courseDir, "animation", "enhanced");
    const draftBytes = await size(path.join(enhancedDir, "animated-video.enhanced.draft.mp4"));
    const finalBytes = await size(path.join(enhancedDir, "animated-video.enhanced.mp4"));
    const enhanced: "draft" | "final" | "none" = finalBytes !== null ? "final" : draftBytes !== null ? "draft" : "none";
    const enhancedBytes = finalBytes ?? draftBytes ?? 0;
    totalBytes += enhancedBytes;
    // finished audio, slide images and segments are stored too, so a later edit only redoes the slides that changed
    let cacheBytes = 0;
    for (const d of ["audio", "slides", "video-segments", path.join("animation", "enhanced", "segments")]) cacheBytes += await dirBytes(path.join(input.courseDir, d));
    totalBytes += cacheBytes;
    if (catalog) {
      if (meta.courseTitle !== catalog.title) add("warn", `The folder's title "${meta.courseTitle}" differs from the library entry "${catalog.title}".`);
      if (meta.slideCount !== catalog.slideCount) add("warn", `The folder has ${meta.slideCount} slides; the library entry says ${catalog.slideCount}.`);
      const expected = catalog.files.animated;
      if (expected?.draft && enhanced !== "draft") {
        add("error", enhanced === "final" ? "The library entry is an unapproved DRAFT but the folder holds an enhanced video without .draft in its name; it would be imported as final. Refusing." : "The folder has no enhanced draft video, but the library entry serves one.");
      } else if (expected && enhancedBytes !== expected.bytes) {
        add("warn", `The enhanced video here is ${enhancedBytes} bytes; the private Blob object is ${expected.bytes} bytes. They may be different renders.`);
      } else if (expected) {
        add("info", `The enhanced ${enhanced} video is ${enhancedBytes} bytes, the same size as the private Blob object, so it is the video library mode serves.`);
      }
    }
    if (enhanced === "none") add("warn", "The folder has no enhanced animated video.");
    if (enhanced === "draft") add("info", "The enhanced video will keep its DRAFT status and stay private to each account (0 clinically approved slides).");
    const driver = ctx?.storage.driver ?? input.storageDriver;
    // on Vercel Blob the library's own copy of the enhanced video is referenced, not uploaded again
    const referenced = driver === "blob" && enhanced === "draft" && Boolean(catalog?.files.animated) && enhancedBytes === catalog?.files.animated?.bytes;
    const perCopyBytes = totalBytes - (input.cache === false ? cacheBytes : 0) - (referenced ? enhancedBytes : 0);
    if (referenced) add("info", "Vercel Blob storage: the enhanced video is referenced where it already is (read-only), not uploaded again.");
    video = { title: meta.courseTitle ?? "", slideCount: meta.slideCount ?? 0, durationSeconds: meta.durationSeconds ?? 0, enhanced, enhancedBytes, totalBytes, cacheBytes, perCopyBytes };
  }

  // ---- what exists already
  const existing = new Map<string, { id: string; hash: string }>();
  let importedBy = new Set<string>();
  if (ctx) {
    for (const r of (await ctx.db.query("SELECT id, email, password_hash FROM users WHERE email = ANY($1::text[])", [[...input.users.keys()]])).rows) existing.set(r.email, { id: r.id, hash: r.password_hash });
    if (meta?.courseSlug || meta?.courseTitle) {
      const key = importKeyOf(meta, input.courseDir);
      importedBy = new Set((await ctx.db.query("SELECT u.email FROM courses c JOIN users u ON u.id = c.owner_id WHERE c.import_key = $1 AND c.deleted_at IS NULL", [key])).rows.map((r) => r.email));
    }
  } else {
    add("info", "No database is configured, so every account is treated as new. Set DATABASE_URL (and the S3_* settings) to check what already exists.");
  }

  const users: UserPlan[] = [...input.users.entries()].map(([email, hash]) => {
    const e = existing.get(email);
    return { email, action: !e ? "create" : e.hash === hash ? "exists" : "exists-different-password", role: admins.has(email) ? "admin" : "user" };
  });
  for (const u of users) {
    if (u.action === "exists-different-password") add("warn", `${u.email} already has an account with a different password; it is left unchanged.`);
    if (u.action === "exists" && u.role === "admin") add("info", `${u.email} already exists; its role is not changed.`);
  }
  if (!users.some((u) => u.role === "admin")) add("warn", "No account is an administrator. Pass --admin you@example.com, or create one afterwards with npm run cloud:create-admin.");

  const targets = input.share === "all" ? [...input.users.keys()] : input.users.has(owner) ? [owner] : [];
  const imports: ImportPlan[] = targets.map((email) => ({ email, action: importedBy.has(email) ? "already-imported" : "import" }));
  if (input.share === "all" && targets.length > 1 && video) {
    add("info", `${targets.length} private copies of the video will be stored (about ${(video.perCopyBytes / 1048576).toFixed(0)} MB each).`);
  }

  return { ok: !findings.some((f) => f.level === "error"), findings, users, imports, video, databaseChecked: Boolean(ctx) };
}

function importKeyOf(meta: { courseSlug?: string; generatedAt?: string }, dir: string): string {
  return `${meta.courseSlug ?? path.basename(dir)}@${meta.generatedAt ?? "unknown"}`;
}

// ---------- apply ----------

export async function applyMigration(ctx: Ctx, input: MigrationInput, opts: { manifestPath: string; log?: (m: string) => void }): Promise<Manifest> {
  const log = opts.log ?? (() => {});
  const plan = await planMigration(ctx, input);
  if (!plan.ok) throw new Error(`The migration cannot start:\n- ${plan.findings.filter((f) => f.level === "error").map((f) => f.text).join("\n- ")}`);

  const meta = JSON.parse(await fs.readFile(path.join(input.courseDir, "course.json"), "utf8")) as { courseSlug?: string; generatedAt?: string };
  const manifest: Manifest = (await readManifest(opts.manifestPath)) ?? { version: 1, at: new Date().toISOString(), courseSlug: meta.courseSlug ?? path.basename(input.courseDir), users: [], courses: [] };
  const save = async (): Promise<void> => {
    await fs.mkdir(path.dirname(opts.manifestPath), { recursive: true });
    await fs.writeFile(`${opts.manifestPath}.tmp`, JSON.stringify(manifest, null, 2) + "\n");
    await fs.rename(`${opts.manifestPath}.tmp`, opts.manifestPath);
  };

  // 1. accounts: insert only the missing ones
  const ids = new Map<string, string>();
  for (const u of plan.users) {
    const hash = input.users.get(u.email)!;
    const res = await ctx.db.query(
      "INSERT INTO users(email, name, password_hash, role, status) VALUES ($1,$2,$3,$4,'active') ON CONFLICT (email) DO NOTHING RETURNING id",
      [u.email, nameFromEmail(u.email), hash, u.role],
    );
    if (res.rows[0]) {
      ids.set(u.email, res.rows[0].id);
      manifest.users.push({ email: u.email, id: res.rows[0].id });
      await ctx.db.query("INSERT INTO audit_log(user_id, action, target, meta) VALUES (NULL, 'migration.library.user', $1, $2::jsonb)", [u.email, JSON.stringify({ role: u.role })]);
      log(`  account created: ${u.email} (${u.role})`);
      await save();
    } else {
      ids.set(u.email, (await ctx.db.query("SELECT id FROM users WHERE email = $1", [u.email])).rows[0].id);
      log(`  account kept as it was: ${u.email}`);
    }
  }

  // 2. the video, for the owner and (optionally) everyone. On Vercel Blob storage the enhanced video that library mode serves is
  //    referenced in place (read-only) instead of being uploaded again, when the stored object is the same size as the local file.
  const animatedPath = (input.video ?? LIBRARY_VIDEOS[0])?.files.animated?.pathname;
  const reference = ctx.storage.driver === "blob" && animatedPath ? { reuseAnimated: { key: `${LIBRARY_KEY_PREFIX}${animatedPath}` } } : {};
  for (const imp of plan.imports) {
    const ownerId = ids.get(imp.email)!;
    const r = await importCourse(ctx, { dir: input.courseDir, ownerId, log, finalize: true, cache: input.cache !== false, ...reference });
    if (r?.created) {
      manifest.courses.push({ email: imp.email, ownerId, courseId: r.courseId, importKey: importKeyOf(meta, input.courseDir) });
      await ctx.db.query("INSERT INTO audit_log(user_id, action, target, meta) VALUES ($1, 'migration.library.course', $2, $3::jsonb)", [ownerId, r.courseId, JSON.stringify({ title: r.title })]);
      await save();
      log(`  video imported for ${imp.email}`);
    } else log(`  video already present for ${imp.email}`);
  }
  await save();
  return manifest;
}

// ---------- verify ----------

export async function verifyMigration(ctx: Ctx, input: MigrationInput): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (level: Level, text: string): void => void out.push({ level, text });
  const rows = (await ctx.db.query("SELECT id, email, password_hash, status FROM users WHERE email = ANY($1::text[])", [[...input.users.keys()]])).rows;
  const byEmail = new Map(rows.map((r) => [r.email as string, r]));
  for (const [email, hash] of input.users) {
    const r = byEmail.get(email);
    if (!r) add("error", `${email} has no account in the database.`);
    else if (r.status !== "active") add("error", `${email} exists but is ${r.status}.`);
    else if (r.password_hash !== hash) add("warn", `${email} exists with a different password than library mode (an earlier account was kept).`);
    else add("info", `${email}: account active, same password as library mode.`);
  }
  const meta = JSON.parse(await fs.readFile(path.join(input.courseDir, "course.json"), "utf8")) as { courseSlug?: string; generatedAt?: string };
  const key = importKeyOf(meta, input.courseDir);
  const targets = input.share === "all" ? [...input.users.keys()] : [input.owner.toLowerCase()];
  for (const email of targets) {
    const u = byEmail.get(email);
    const c = u ? (await ctx.db.query("SELECT * FROM courses WHERE owner_id = $1 AND import_key = $2 AND deleted_at IS NULL", [u.id, key])).rows[0] : null;
    if (!c) {
      add("error", `${email} has no imported course.`);
      continue;
    }
    const o = c.outputs ?? {};
    if (!o.video || !o.animated) add("error", `${email}: the course has no ${!o.video ? "narrated" : "enhanced"} video recorded.`);
    else if (o.animated.draft !== true) add("error", `${email}: the enhanced video is not marked DRAFT.`);
    else {
      let missing = 0;
      for (const f of Object.values(o) as Array<{ key: string }>) if (!(await ctx.storage.head(f.key))) missing++;
      add(missing ? "error" : "info", missing ? `${email}: ${missing} stored file(s) are missing from the bucket.` : `${email}: course ${c.status}, narrated and enhanced DRAFT videos are in the bucket.`);
    }
    if (c.status !== "complete") add("warn", `${email}: course status is "${c.status}"; the engine has not finished reading the sources yet.`);
  }
  return out;
}

// ---------- rollback ----------

export interface RollbackReport {
  applied: boolean;
  removedCourses: string[];
  removedUsers: string[];
  keptUsers: Array<{ email: string; reason: string }>;
}

export async function readManifest(file: string): Promise<Manifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(file, "utf8")) as Manifest;
    return m.version === 1 ? m : null;
  } catch {
    return null;
  }
}

/** Remove only what this migration created. Accounts that now own other courses are kept. Nothing in Vercel Blob is touched. */
export async function rollbackMigration(ctx: Ctx, manifestPath: string, opts: { apply: boolean; log?: (m: string) => void }): Promise<RollbackReport> {
  const log = opts.log ?? (() => {});
  const manifest = await readManifest(manifestPath);
  if (!manifest) throw new Error(`No migration manifest at ${manifestPath}; there is nothing to roll back.`);
  const report: RollbackReport = { applied: opts.apply, removedCourses: [], removedUsers: [], keptUsers: [] };

  for (const c of manifest.courses) {
    const row = (await ctx.db.query("SELECT id, owner_id FROM courses WHERE id = $1 AND owner_id = $2 AND import_key = $3", [c.courseId, c.ownerId, c.importKey])).rows[0];
    if (!row) continue;
    report.removedCourses.push(`${c.email}: ${c.courseId}`);
    if (opts.apply) {
      await ctx.db.query("DELETE FROM courses WHERE id = $1", [c.courseId]);
      await ctx.storage.removePrefix(`${courseKeys(c.ownerId, c.courseId).base}/`);
      await ctx.db.query("INSERT INTO audit_log(user_id, action, target, meta) VALUES (NULL, 'migration.library.rollback.course', $1, '{}'::jsonb)", [c.courseId]);
    }
    log(`  ${opts.apply ? "removed" : "would remove"} imported course ${c.courseId} of ${c.email}`);
  }
  for (const u of manifest.users) {
    const own = (await ctx.db.query("SELECT count(*)::int AS n FROM courses WHERE owner_id = $1 AND id <> ALL($2::uuid[])", [u.id, manifest.courses.filter((c) => c.ownerId === u.id).map((c) => c.courseId)])).rows[0].n as number;
    const exists = (await ctx.db.query("SELECT 1 FROM users WHERE id = $1", [u.id])).rows[0];
    if (!exists) continue;
    if (own > 0) {
      report.keptUsers.push({ email: u.email, reason: `owns ${own} other course(s) created after the migration` });
      continue;
    }
    report.removedUsers.push(u.email);
    if (opts.apply) {
      await ctx.db.query("DELETE FROM users WHERE id = $1", [u.id]);
      await ctx.db.query("INSERT INTO audit_log(user_id, action, target, meta) VALUES (NULL, 'migration.library.rollback.user', $1, '{}'::jsonb)", [u.email]);
    }
    log(`  ${opts.apply ? "removed" : "would remove"} account ${u.email}`);
  }
  if (opts.apply) await fs.rename(manifestPath, `${manifestPath}.rolled-back-${Date.now()}`);
  return report;
}
