/**
 * npm run library:rehearse [-- --users-file FILE]
 *
 * Rehearses the library -> full-mode migration against the REAL services without touching anything real:
 *   - Postgres: your Neon DATABASE_URL (direct connection), inside a throw-away schema that is dropped at the end;
 *   - storage : your private Vercel Blob store, inside a throw-away folder (v2-rehearsal-<random>/) that is emptied at the end;
 *   - users   : throw-away accounts with a random password (or the entries of --users-file, still only inside the throw-away schema);
 *   - video   : the finished diabetes course from ./output; its enhanced draft is referenced in place from the library object.
 * It then signs in as a migrated user through the real API, checks Generated Videos, streams a byte range of the library video,
 * rolls the migration back, and proves the library object (size) is unchanged. The public schema and the library are never written.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "../cloud/auth.js";
import { cloudConfig, configProblems } from "../cloud/config.js";
import { createDb } from "../cloud/db.js";
import { LIBRARY_VIDEOS } from "../cloud/library-catalog.js";
import { handleApi, type Ctx } from "../cloud/routes.js";
import { createStorage } from "../cloud/storage.js";
import { LIBRARY_KEY_PREFIX } from "../cloud/storage-blob.js";
import { applyMigration, parseUsersStrict, planMigration, rollbackMigration, verifyMigration, type MigrationInput } from "./migration/library-migration.js";
import { PROJECT_ROOT } from "./utils/config.js";
import { formatError } from "./utils/errors.js";

const rand = Math.random().toString(36).slice(2, 10);
const schema = `reh_${rand}`;
const prefix = `v2-rehearsal-${rand}`;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set: the rehearsal needs your Neon connection string.");
const config = cloudConfig({
  DATABASE_URL: process.env.DATABASE_URL.replace(/-pooler\./, "."),
  DB_SCHEMA: schema,
  STORAGE_DRIVER: "blob",
  BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
  BLOB_PREFIX: prefix,
  APP_SECRET: "r".repeat(40),
});
const problems = configProblems(config);
if (problems.length) throw new Error(`Settings incomplete:\n- ${problems.join("\n- ")}`);

let passed = 0;
const ok = (cond: unknown, what: string): void => {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
  passed++;
  console.log(`  ok: ${what}`);
};

const ctx: Ctx = { config, db: await createDb(config), storage: await createStorage(config) };
const server = http.createServer((req, res) => void handleApi(ctx, req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-rehearse-"));

try {
  console.log(`Migration rehearsal on real services (Neon schema ${schema}, Blob folder ${prefix}/)`);
  const password = randomBytes(9).toString("base64url") + "-Aa1";
  const given = process.argv.includes("--users-file") ? parseUsersStrict(await fs.readFile(process.argv[process.argv.indexOf("--users-file") + 1]!, "utf8")).users : null;
  const users = given ?? new Map([["owner@rehearsal.test", await hashPassword(password)], ["second@rehearsal.test", await hashPassword(password)]]);
  const owner = [...users.keys()][0]!;

  const out = path.resolve(process.env.OUTPUT_DIR ?? path.join(PROJECT_ROOT, "output"));
  let courseDir = "";
  for (const d of await fs.readdir(out).catch(() => [])) {
    const meta = await fs.readFile(path.join(out, d, "course.json"), "utf8").then((t) => JSON.parse(t) as { courseTitle?: string }, () => null);
    if (meta?.courseTitle === LIBRARY_VIDEOS[0]?.title) courseDir = path.join(out, d);
  }
  if (!courseDir) throw new Error(`The diabetes course folder was not found under ${out}.`);
  const input: MigrationInput = { users, owner, share: "owner", admins: [owner], courseDir, cache: false, storageDriver: "blob" };

  console.log("1. plan");
  const plan = await planMigration(ctx, input);
  ok(plan.ok && plan.databaseChecked, "the dry run passes and checked the database");
  ok(plan.findings.some((f) => /referenced where it already is/.test(f.text)), "the enhanced video will be referenced in the library, not uploaded again");
  ok((await ctx.db.query("SELECT count(*)::int AS n FROM users")).rows[0].n === 0, "the dry run wrote nothing");

  console.log("2. apply");
  const manifestPath = path.join(tmp, "manifest.json");
  const t0 = Date.now();
  const manifest = await applyMigration(ctx, input, { manifestPath });
  ok(manifest.users.length === users.size && manifest.courses.length === 1, `${manifest.users.length} accounts and 1 course migrated in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const verify = await verifyMigration(ctx, input);
  ok(!verify.some((f) => f.level === "error"), "verify reports no errors");

  console.log("3. what a migrated user sees");
  const lib = LIBRARY_VIDEOS[0]!.files.animated!;
  if (!given) {
    const login = await fetch(`${base}/api/v3/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "doctyn" }, body: JSON.stringify({ email: owner, password }) });
    ok(login.status === 200, "the migrated account signs in with the library password hash");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const list = (await (await fetch(`${base}/api/v3/courses`, { headers: { cookie, "x-requested-with": "doctyn" } })).json()) as { courses: any[] };
    const c = list.courses[0];
    ok(list.courses.length === 1 && c.title === LIBRARY_VIDEOS[0]!.title && c.status === "complete" && c.hasVideo, "Generated Videos lists the diabetes course as complete");
    ok(c.animatedDraft === true && c.slideCount !== 0 && c.durationSeconds > 900, "it is shown as the enhanced DRAFT with its duration");
    const r = await fetch(`${base}/api/v3/courses/${c.id}/files/animated`, { redirect: "manual", headers: { cookie, "x-requested-with": "doctyn" } });
    ok(r.status === 302, "the enhanced video is served through a signed link");
    const part = await fetch(r.headers.get("location")!, { headers: { range: "bytes=0-1023" } });
    ok(part.status === 206 && part.headers.get("content-range")?.endsWith(`/${lib.bytes}`), `a byte range of the library video streams (${lib.bytes} bytes total, no copy made)`);
    const nobody = await fetch(`${base}/api/v3/courses/${c.id}/files/animated`, { redirect: "manual", headers: { "x-requested-with": "doctyn" } });
    ok(nobody.status === 401, "signed out, the video is not reachable");
    ok(((await ctx.storage.list("users/")).filter((o) => o.key.includes("animated-video"))).length === 0, "no second copy of the enhanced video was stored");
  } else console.log("  (sign-in checks skipped: the passwords of --users-file are not known here)");

  console.log("4. rollback leaves the library alone");
  const dry = await rollbackMigration(ctx, manifestPath, { apply: false });
  ok(dry.removedCourses.length === 1 && (await ctx.db.query("SELECT count(*)::int AS n FROM courses")).rows[0].n === 1, "the rollback dry run removes nothing");
  const done = await rollbackMigration(ctx, manifestPath, { apply: true });
  ok(done.removedUsers.length === users.size && (await ctx.db.query("SELECT count(*)::int AS n FROM users")).rows[0].n === 0, "the real rollback removed the migrated accounts and course");
  ok((await ctx.storage.head(`${LIBRARY_KEY_PREFIX}${lib.pathname}`))?.size === lib.bytes, "the library video is still in Blob with exactly the same size");
  ok((await ctx.storage.list("users/")).length === 0, "nothing of the rehearsal is left in the bucket");
  console.log(`\nREHEARSAL PASS (${passed} checks)`);
} catch (err) {
  console.error(`\nREHEARSAL FAIL: ${formatError(err)}`);
  process.exitCode = 1;
} finally {
  server.close();
  for (const o of await ctx.storage.list("users/").catch(() => [])) await ctx.storage.remove(o.key).catch(() => {});
  await ctx.db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).then(() => console.log(`cleanup: schema ${schema} dropped, folder ${prefix}/ emptied`), (e) => console.error(`cleanup FAILED for schema ${schema}: ${formatError(e)}`));
  await ctx.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
