import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { hashPassword, verifyPassword } from "../cloud/auth.js";
import { cloudConfig } from "../cloud/config.js";
import { createDb } from "../cloud/db.js";
import type { LibraryVideo } from "../cloud/library-catalog.js";
import { libraryModeConfigured, parseLibraryUsers } from "../cloud/library.js";
import { handleApi, type Ctx } from "../cloud/routes.js";
import { createStorage } from "../cloud/storage.js";
import { applyMigration, parseUsersStrict, planMigration, readManifest, rollbackMigration, verifyMigration, type MigrationInput } from "../src/migration/library-migration.js";

const PW = "a long library password";
let tmp = "";
let ctx: Ctx;
let server: http.Server;
let base = "";
let courseDir = "";
let hashes: Record<string, string> = {};

const ENHANCED = Buffer.from("enhanced-draft-video-bytes".repeat(10));
const catalog: LibraryVideo = {
  id: "t",
  title: "Risk Factors for Diabetes – From Genetics to Lifestyle",
  slideCount: 52,
  durationSeconds: 915.2,
  completedAt: "2026-10-24T08:33:43.000Z",
  files: { animated: { pathname: "courses/diabetes/enhanced/animated-video.enhanced.draft.mp4", bytes: ENHANCED.length, draft: true } },
};

async function makeCourse(dir: string, opts: { final?: boolean; skip?: string } = {}): Promise<void> {
  await fs.mkdir(path.join(dir, "animation", "enhanced"), { recursive: true });
  await fs.mkdir(path.join(dir, "audio"), { recursive: true });
  const write = (rel: string, data: string | Buffer): Promise<void> => (opts.skip === rel ? Promise.resolve() : fs.writeFile(path.join(dir, rel), data));
  await write("course.json", JSON.stringify({ courseTitle: catalog.title, courseSlug: "risk-factors", slideCount: 52, durationSeconds: 915.7, generatedAt: "2026-10-22T17:08:35.465Z" }));
  await write("presentation.pptx", "PK-pptx");
  await write("voiceover-script.docx", "PK-docx");
  await write("final-video.mp4", "narrated");
  await write("thumbnail.jpg", "jpg");
  await write("captions.vtt", "WEBVTT");
  await write("captions.srt", "1");
  await write("transcript.txt", "t");
  await write(path.join("audio", "slide-001.mp3"), "mp3");
  await fs.writeFile(path.join(dir, "animation", "enhanced", opts.final ? "animated-video.enhanced.mp4" : "animated-video.enhanced.draft.mp4"), ENHANCED);
}

const input = (over: Partial<MigrationInput> = {}): MigrationInput => ({
  users: new Map(Object.entries(hashes)),
  owner: "owner@example.org",
  share: "owner",
  admins: ["owner@example.org"],
  courseDir,
  video: catalog,
  ...over,
});

async function api(method: string, p: string, body?: unknown, cookie?: string): Promise<{ status: number; body: any; cookie?: string }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "x-requested-with": "doctyn", ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = res.headers.get("set-cookie");
  return { status: res.status, body: await res.json().catch(() => null), ...(set ? { cookie: set.split(";")[0]! } : {}) };
}
const signIn = async (email: string): Promise<string> => {
  const r = await api("POST", "/api/v3/auth/login", { email, password: PW });
  assert.equal(r.status, 200, `${email} signs in with the library password`);
  return r.cookie!;
};

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-migrate-"));
  const config = cloudConfig({ STORAGE_DRIVER: "fs", LOCAL_STORAGE_DIR: path.join(tmp, "storage"), LOCAL_DB_DIR: "memory://", APP_SECRET: "x".repeat(40) });
  ctx = { config, db: await createDb(config), storage: await createStorage(config) };
  server = http.createServer((req, res) => void handleApi(ctx, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  hashes = { "owner@example.org": await hashPassword(PW), "second@example.org": await hashPassword(PW), "third@example.org": await hashPassword(PW) };
  courseDir = path.join(tmp, "output", "risk-factors");
  await makeCourse(courseDir);
});

after(async () => {
  server.close();
  await ctx.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("reading LIBRARY_USERS", () => {
  it("accepts the library format, reports malformed entries without echoing hashes", () => {
    const { users, skipped } = parseUsersStrict(`A@x.org=${hashes["owner@example.org"]},bad-entry,b@x.org=plaintext-password,\n# comment\nc@x.org=${hashes["second@example.org"]}`);
    assert.deepEqual([...users.keys()], ["a@x.org", "c@x.org"]);
    assert.deepEqual(skipped, ["entry 1", "b@x.org"], "an entry without an email is never echoed back");
    assert.ok(!JSON.stringify(skipped).includes("plaintext"));
    assert.equal(parseLibraryUsers(`A@x.org=${hashes["owner@example.org"]}`).size, 1, "same format the live library mode reads");
  });
});

describe("dry run", () => {
  it("reports exactly what would happen without a database and writes nothing", async () => {
    const before = await fs.readdir(tmp);
    const plan = await planMigration(null, input({ share: "all" }));
    assert.equal(plan.ok, true);
    assert.equal(plan.databaseChecked, false);
    assert.deepEqual(plan.users.map((u) => [u.email, u.action, u.role]), [["owner@example.org", "create", "admin"], ["second@example.org", "create", "user"], ["third@example.org", "create", "user"]]);
    assert.deepEqual(plan.imports.map((i) => i.email), ["owner@example.org", "second@example.org", "third@example.org"]);
    assert.equal(plan.video?.enhanced, "draft");
    assert.ok(plan.findings.some((f) => /same size as the private Blob object/.test(f.text)));
    assert.deepEqual(await fs.readdir(tmp), before, "no manifest, no storage");
  });

  it("refuses an unknown owner, a missing file, and a folder that would import the video as final", async () => {
    assert.equal((await planMigration(null, input({ owner: "ghost@example.org" }))).ok, false);
    const broken = path.join(tmp, "broken");
    await makeCourse(broken, { skip: "captions.srt" });
    const p = await planMigration(null, input({ courseDir: broken }));
    assert.equal(p.ok, false);
    assert.ok(p.findings.some((f) => /captions\.srt is missing/.test(f.text)));
    const final = path.join(tmp, "final");
    await makeCourse(final, { final: true });
    const f = await planMigration(null, input({ courseDir: final }));
    assert.equal(f.ok, false);
    assert.ok(f.findings.some((x) => /imported as final/.test(x.text)));
  });

  it("warns when the local enhanced video is not the file in Blob (size differs)", async () => {
    const p = await planMigration(null, input({ video: { ...catalog, files: { animated: { ...catalog.files.animated!, bytes: 123 } } } }));
    assert.ok(p.findings.some((f) => f.level === "warn" && /different renders/.test(f.text)));
  });
});

describe("apply", () => {
  let owner = "";
  let second = "";

  it("creates the accounts with the SAME password hashes, so existing passwords keep working", async () => {
    // pre-existing account with a different password must be left alone
    await ctx.db.query("INSERT INTO users(email,name,password_hash,role,status) VALUES ('third@example.org','Third',$1,'user','active')", [await hashPassword("another password entirely")]);
    const plan = await planMigration(ctx, input({ share: "all" }));
    assert.equal(plan.users.find((u) => u.email === "third@example.org")?.action, "exists-different-password");

    const manifest = await applyMigration(ctx, input({ share: "all" }), { manifestPath: path.join(tmp, "m.json") });
    assert.deepEqual(manifest.users.map((u) => u.email).sort(), ["owner@example.org", "second@example.org"]);
    const rows = (await ctx.db.query("SELECT email, role, status, password_hash FROM users ORDER BY email")).rows;
    assert.equal(rows.find((r) => r.email === "owner@example.org").role, "admin");
    assert.equal(rows.find((r) => r.email === "second@example.org").role, "user");
    assert.ok(rows.every((r) => r.status === "active"));
    assert.equal(rows.find((r) => r.email === "owner@example.org").password_hash, hashes["owner@example.org"]);
    assert.ok(await verifyPassword(PW, rows.find((r) => r.email === "second@example.org").password_hash));
    assert.ok(!(await verifyPassword(PW, rows.find((r) => r.email === "third@example.org").password_hash)), "the existing account was not overwritten");
    owner = await signIn("owner@example.org");
    second = await signIn("second@example.org");
  });

  it("puts the current enhanced video, still a DRAFT, into each account's own library and nobody else's", async () => {
    for (const cookie of [owner, second]) {
      const { body } = await api("GET", "/api/v3/courses", undefined, cookie);
      assert.equal(body.courses.length, 1);
      const c = body.courses[0];
      assert.equal(c.title, catalog.title);
      assert.equal(c.status, "complete", "playable immediately, not only after the engine has run");
      assert.equal(c.hasVideo, true);
      assert.equal(c.animatedDraft, true, "Draft status is preserved");
      assert.equal(c.publishedAt, null, "never published automatically");
      assert.equal(c.durationSeconds, 915.7);
    }
    const mine = (await api("GET", "/api/v3/courses", undefined, owner)).body.courses[0].id;
    const theirs = (await api("GET", "/api/v3/courses", undefined, second)).body.courses[0].id;
    assert.notEqual(mine, theirs);
    assert.equal((await api("GET", `/api/v3/courses/${mine}`, undefined, second)).status, 404, "private to its owner");
    const queued = (await ctx.db.query("SELECT kind, status FROM jobs ORDER BY created_at")).rows;
    assert.ok(queued.length >= 2 && queued.every((j) => j.kind === "parse" && j.status === "queued"), "the engine will re-read the sources when it is online; nothing is re-rendered");
  });

  it("downloads the stored enhanced draft byte for byte", async () => {
    const id = (await api("GET", "/api/v3/courses", undefined, owner)).body.courses[0].id;
    const redirect = await fetch(`${base}/api/v3/courses/${id}/files/animated`, { redirect: "manual", headers: { cookie: owner, "x-requested-with": "doctyn" } });
    assert.equal(redirect.status, 302);
    const loc = redirect.headers.get("location")!;
    const bytes = Buffer.from(await (await fetch(loc.startsWith("http") ? loc : `${base}${loc}`)).arrayBuffer());
    assert.ok(bytes.equals(ENHANCED));
  });

  it("is idempotent: running it again changes nothing", async () => {
    const m1 = await readManifest(path.join(tmp, "m.json"));
    const again = await applyMigration(ctx, input({ share: "all" }), { manifestPath: path.join(tmp, "m.json") });
    assert.equal(again.courses.length, m1!.courses.length);
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM courses")).rows[0].n, 3, "one per library user, the pre-existing account included");
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 3);
  });

  it("verify passes, and fails loudly if the Draft marker is lost", async () => {
    const ok = await verifyMigration(ctx, input({ share: "all" }));
    assert.ok(!ok.some((f) => f.level === "error"), JSON.stringify(ok));
    await ctx.db.query("UPDATE courses SET outputs = jsonb_set(outputs, '{animated,draft}', 'false') WHERE owner_id = (SELECT id FROM users WHERE email='owner@example.org')");
    const bad = await verifyMigration(ctx, input({ share: "all" }));
    assert.ok(bad.some((f) => f.level === "error" && /not marked DRAFT/.test(f.text)));
    await ctx.db.query("UPDATE courses SET outputs = jsonb_set(outputs, '{animated,draft}', 'true') WHERE owner_id = (SELECT id FROM users WHERE email='owner@example.org')");
  });
});

describe("rollback", () => {
  it("is a dry run by default and then removes only what the migration created", async () => {
    const mp = path.join(tmp, "m.json");
    // an account that appeared after the migration and owns its own course must survive
    const second = (await ctx.db.query("SELECT id FROM users WHERE email='second@example.org'")).rows[0].id;
    await ctx.db.query("INSERT INTO courses(owner_id, title) VALUES ($1,'My own new course')", [second]);

    const dry = await rollbackMigration(ctx, mp, { apply: false });
    assert.equal(dry.applied, false);
    assert.equal(dry.removedCourses.length, 3);
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM courses")).rows[0].n, 4, "nothing deleted in the dry run");
    assert.ok(await readManifest(mp));

    const done = await rollbackMigration(ctx, mp, { apply: true });
    assert.equal(done.removedCourses.length, 3);
    assert.deepEqual(done.removedUsers, ["owner@example.org"]);
    assert.deepEqual(done.keptUsers.map((k) => k.email), ["second@example.org"]);
    const left = (await ctx.db.query("SELECT email FROM users ORDER BY email")).rows.map((r) => r.email);
    assert.deepEqual(left, ["second@example.org", "third@example.org"], "the pre-existing account and the one with its own course remain");
    assert.deepEqual((await ctx.db.query("SELECT title FROM courses")).rows.map((r) => r.title), ["My own new course"]);
    assert.equal((await ctx.storage.list("users/")).filter((o) => o.key.includes("/output/")).length, 0, "imported files were removed from the bucket");
    assert.equal(await readManifest(mp), null, "the manifest is archived so a second rollback cannot run twice");
  });
});

describe("the live site and the Blob store are never touched", () => {
  it("going back to library mode is just removing DATABASE_URL; the library settings stay valid", () => {
    const env = { BLOB_READ_WRITE_TOKEN: "t", LIBRARY_USERS: `owner@example.org=${hashes["owner@example.org"]}`, APP_SECRET: "x".repeat(40) };
    assert.equal(libraryModeConfigured(env), true, "today");
    assert.equal(libraryModeConfigured({ ...env, DATABASE_URL: "postgres://x" }), false, "full mode takes over when DATABASE_URL is set");
    assert.equal(libraryModeConfigured(env), true, "rollback: unset DATABASE_URL and redeploy");
  });

  it("the migration code has no Blob, Vercel or deletion-of-library access", async () => {
    for (const f of ["src/migration/library-migration.ts", "src/library-migrate.ts"]) {
      const code = (await fs.readFile(path.join(process.cwd(), f), "utf8")).split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
      assert.ok(!/@vercel\/blob|BLOB_READ_WRITE_TOKEN|vercelBlobReader|child_process|vercel env/.test(code), `${f} must not reach Vercel or Blob`);
    }
  });

  it("makes no network request to Vercel Blob during a full migration", async () => {
    const real = globalThis.fetch;
    const hosts: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      hosts.push(String(url));
      return real(url as string, init);
    }) as typeof fetch;
    try {
      const dir = path.join(tmp, "second-run");
      await makeCourse(dir);
      await applyMigration(ctx, input({ courseDir: dir, users: new Map([["fresh@example.org", await hashPassword(PW)]]), owner: "fresh@example.org", admins: [] }), { manifestPath: path.join(tmp, "m2.json") });
    } finally {
      globalThis.fetch = real;
    }
    assert.deepEqual(hosts.filter((h) => /blob|vercel/i.test(h)), []);
  });
});
