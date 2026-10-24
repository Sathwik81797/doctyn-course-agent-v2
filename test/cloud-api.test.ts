import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cloudConfig } from "../cloud/config.js";
import { createDb, type Db } from "../cloud/db.js";
import { claim, heartbeat, markFailed, markSucceeded, reapStale, workerGone, workerSeen } from "../cloud/queue.js";
import { handleApi, type Ctx } from "../cloud/routes.js";
import { createStorage } from "../cloud/storage.js";
import { contentHash } from "../cloud/util.js";

let server: http.Server;
let base = "";
let ctx: Ctx;
let tmp = "";

interface Reply {
  status: number;
  body: any;
  headers: Headers;
  cookie?: string;
}

async function call(method: string, p: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${base}${p}`, {
    method,
    redirect: "manual",
    headers: {
      "x-requested-with": "doctyn",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not json */
  }
  const set = res.headers.get("set-cookie");
  return { status: res.status, body: parsed, headers: res.headers, ...(set ? { cookie: set.split(";")[0]! } : {}) };
}

async function signedIn(email: string, name = "Test User"): Promise<string> {
  const pw = "correct horse battery";
  const reg = await call("POST", "/api/v3/auth/register", { email, name, password: pw });
  assert.equal(reg.status, 201);
  const approve = await ctx.db.query("UPDATE users SET status = 'active' WHERE email = $1", [email]);
  assert.equal(approve.rowCount, 1);
  const login = await call("POST", "/api/v3/auth/login", { email, password: pw });
  assert.equal(login.status, 200);
  return login.cookie!;
}

async function uploadFile(cookie: string, courseId: string, type: "pptx" | "docx", content = "PK\u0003\u0004fake") {
  const up = await call("POST", `/api/v3/courses/${courseId}/upload-url`, { type, filename: `deck.${type}`, size: Buffer.byteLength(content) }, cookie);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const put = await fetch(`${base}${up.body.url}`, { method: "PUT", headers: up.body.headers, body: content });
  assert.equal(put.status, 200);
  return call("POST", `/api/v3/courses/${courseId}/files/complete`, { type, key: up.body.key, filename: `deck.${type}` }, cookie);
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-cloud-"));
  const config = cloudConfig({
    STORAGE_DRIVER: "fs",
    LOCAL_STORAGE_DIR: path.join(tmp, "storage"),
    LOCAL_DB_DIR: "memory://",
    APP_SECRET: "x".repeat(40),
    ADMIN_EMAILS: "admin@example.com",
  });
  ctx = { config, db: await createDb(config), storage: await createStorage(config) };
  server = http.createServer((req, res) => void handleApi(ctx, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server.close();
  await ctx.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("accounts", () => {
  it("keeps new accounts pending until an administrator approves them", async () => {
    const reg = await call("POST", "/api/v3/auth/register", { email: "pat@example.com", name: "Pat", password: "long enough password" });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.status, "pending");
    const login = await call("POST", "/api/v3/auth/login", { email: "pat@example.com", password: "long enough password" });
    assert.equal(login.status, 403);
    assert.match(login.body.error, /approval/);
  });

  it("makes an ADMIN_EMAILS address an active administrator", async () => {
    const reg = await call("POST", "/api/v3/auth/register", { email: "admin@example.com", name: "Admin", password: "long enough password" });
    assert.equal(reg.body.user.role, "admin");
    assert.equal(reg.body.user.status, "active");
  });

  it("rejects wrong passwords, weak passwords and duplicates", async () => {
    assert.equal((await call("POST", "/api/v3/auth/register", { email: "weak@example.com", name: "W", password: "short" })).status, 400);
    assert.equal((await call("POST", "/api/v3/auth/register", { email: "admin@example.com", name: "Dup", password: "long enough password" })).status, 409);
    assert.equal((await call("POST", "/api/v3/auth/login", { email: "admin@example.com", password: "nope nope nope" })).status, 401);
  });

  it("requires a session and the CSRF header", async () => {
    assert.equal((await call("GET", "/api/v3/courses")).status, 401);
    const noHeader = await fetch(`${base}/api/v3/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noHeader.status, 403);
    const cross = await call("POST", "/api/v3/auth/logout", {}, undefined, { origin: "https://evil.example" });
    assert.equal(cross.status, 403);
  });

  it("stores only a hash of the session token", async () => {
    const cookie = await signedIn("hash@example.com");
    const token = decodeURIComponent(cookie.split("=")[1]!);
    const rows = (await ctx.db.query("SELECT token_hash FROM sessions")).rows;
    assert.ok(rows.length > 0 && rows.every((r) => r.token_hash !== token));
  });

  it("logs out by deleting the server-side session", async () => {
    const cookie = await signedIn("bye@example.com");
    assert.equal((await call("GET", "/api/v3/courses", undefined, cookie)).status, 200);
    await call("POST", "/api/v3/auth/logout", {}, cookie);
    assert.equal((await call("GET", "/api/v3/courses", undefined, cookie)).status, 401);
  });
});

describe("courses, uploads and isolation", () => {
  let alice = "";
  let bob = "";
  let courseId = "";

  before(async () => {
    alice = await signedIn("alice@example.com", "Alice");
    bob = await signedIn("bob@example.com", "Bob");
  });

  it("creates a course and accepts uploads through signed storage links", async () => {
    const created = await call("POST", "/api/v3/courses", { title: "Diabetes risk" }, alice);
    assert.equal(created.status, 201);
    courseId = created.body.course.id;

    const first = await uploadFile(alice, courseId, "pptx");
    assert.equal(first.body.course.status, "created");
    const second = await uploadFile(alice, courseId, "docx");
    assert.equal(second.body.course.status, "parsing");
    const jobs = (await ctx.db.query("SELECT kind, status FROM jobs WHERE course_id = $1", [courseId])).rows;
    assert.deepEqual(jobs, [{ kind: "parse", status: "queued" }]);
  });

  it("rejects wrong file types, oversize files and foreign keys", async () => {
    const fresh = (await call("POST", "/api/v3/courses", { title: "Fresh" }, alice)).body.course.id;
    const bad = await call("POST", `/api/v3/courses/${fresh}/upload-url`, { type: "pptx", filename: "x.pdf", size: 10 }, alice);
    assert.equal(bad.status, 400);
    const big = await call("POST", `/api/v3/courses/${fresh}/upload-url`, { type: "pptx", filename: "x.pptx", size: 10 * 1024 ** 3 }, alice);
    assert.equal(big.status, 413);
    const foreign = await call("POST", `/api/v3/courses/${fresh}/files/complete`, { type: "pptx", key: `users/someone/courses/${courseId}/source/pptx-aa.pptx` }, alice);
    assert.equal(foreign.status, 400);
  });

  it("hides one user's courses and files from another user", async () => {
    assert.equal((await call("GET", `/api/v3/courses/${courseId}`, undefined, bob)).status, 404);
    assert.equal((await call("PATCH", `/api/v3/courses/${courseId}`, { title: "hijack" }, bob)).status, 404);
    assert.equal((await call("DELETE", `/api/v3/courses/${courseId}`, undefined, bob)).status, 404);
    assert.equal((await call("POST", `/api/v3/courses/${courseId}/build`, {}, bob)).status, 404);
    const list = await call("GET", "/api/v3/courses", undefined, bob);
    assert.equal(list.body.courses.length, 0);
  });

  it("does not let an administrator read someone else's course content", async () => {
    await call("POST", "/api/v3/auth/register", { email: "admin@example.com", name: "Admin", password: "long enough password" }).catch(() => {});
    const admin = (await call("POST", "/api/v3/auth/login", { email: "admin@example.com", password: "long enough password" })).cookie!;
    assert.equal((await call("GET", `/api/v3/courses/${courseId}`, undefined, admin)).status, 404);
    assert.equal((await call("GET", "/api/v3/admin/overview", undefined, admin)).status, 200);
    assert.equal((await call("GET", "/api/v3/admin/overview", undefined, alice)).status, 403);
  });

  it("refuses tampered, expired or wrong-method storage links", async () => {
    const fresh = (await call("POST", "/api/v3/courses", { title: "Links" }, alice)).body.course.id;
    const up = await call("POST", `/api/v3/courses/${fresh}/upload-url`, { type: "docx", filename: "a.docx", size: 4 }, alice);
    const tampered = up.body.url.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"));
    assert.equal((await fetch(`${base}${tampered}`, { method: "PUT", body: "abcd" })).status, 403);
    assert.equal((await fetch(`${base}${up.body.url}`, { method: "GET" })).status, 405);
    const tooBig = await fetch(`${base}${up.body.url}`, { method: "PUT", body: "this is more than four bytes" });
    assert.notEqual(tooBig.status, 200);
  });
});

describe("editing, clinical review and publication", () => {
  let owner = "";
  let reviewer = "";
  let id = "";
  const slides = [
    { slide: 1, title: "Intro", narration: "Welcome to the module." },
    { slide: 2, title: "Risk", narration: "Obesity raises risk." },
  ];

  before(async () => {
    owner = await signedIn("owner@example.com", "Owner");
    reviewer = await signedIn("doc@example.com", "Dr Reviewer");
    await ctx.db.query("UPDATE users SET role = 'reviewer' WHERE email = 'doc@example.com'");
    id = (await call("POST", "/api/v3/courses", { title: "Review me" }, owner)).body.course.id;
    // State the worker's parse job would leave behind.
    await ctx.db.query(
      `UPDATE courses SET status = 'parsed', slide_count = 2, slides = $2::jsonb, content_hash = $3, validation = '{"ok":true}'::jsonb WHERE id = $1`,
      [id, JSON.stringify(slides), contentHash("Review me", slides)],
    );
  });

  it("blocks publication until a reviewer approves the current content", async () => {
    await ctx.db.query(
      `UPDATE courses SET status = 'complete', built_hash = content_hash, outputs = '{"video":{"key":"k","bytes":1}}'::jsonb WHERE id = $1`,
      [id],
    );
    assert.equal((await call("POST", `/api/v3/courses/${id}/publish`, {}, owner)).status, 409);
    assert.equal((await call("POST", `/api/v3/courses/${id}/review/request`, {}, owner)).status, 200);
    assert.equal((await call("POST", `/api/v3/courses/${id}/review`, { decision: "approved" }, owner)).status, 403, "authors cannot approve their own course");
    const queue = await call("GET", "/api/v3/reviews", undefined, reviewer);
    assert.equal(queue.body.courses.length, 1);
    assert.equal((await call("POST", `/api/v3/courses/${id}/review`, { decision: "rejected" }, reviewer)).status, 400, "rejection needs a reason");
    assert.equal((await call("POST", `/api/v3/courses/${id}/review`, { decision: "approved" }, reviewer)).status, 200);
    assert.equal((await call("POST", `/api/v3/courses/${id}/publish`, {}, owner)).status, 200);
  });

  it("resets approval and publication when narration is edited", async () => {
    const edit = await call("PATCH", `/api/v3/courses/${id}`, { slides: [{ slide: 2, narration: "Obesity and inactivity raise risk." }] }, owner);
    assert.equal(edit.status, 200);
    assert.equal(edit.body.course.review.status, "none");
    assert.equal(edit.body.course.publishedAt, null);
    assert.equal(edit.body.course.stale, true);
    assert.equal((await call("POST", `/api/v3/courses/${id}/publish`, {}, owner)).status, 409);
  });

  it("rejects edits to slides that do not exist and blank narration builds", async () => {
    assert.equal((await call("PATCH", `/api/v3/courses/${id}`, { slides: [{ slide: 99, narration: "x" }] }, owner)).status, 400);
    await call("PATCH", `/api/v3/courses/${id}`, { slides: [{ slide: 1, narration: "   " }] }, owner);
    const build = await call("POST", `/api/v3/courses/${id}/build`, {}, owner);
    assert.equal(build.status, 409);
    assert.match(build.body.error, /Slides without narration: 1/);
  });
});

describe("job queue", () => {
  let owner = "";
  let id = "";
  let ownerId = "";

  before(async () => {
    owner = await signedIn("queue@example.com", "Queue");
    ownerId = (await ctx.db.query("SELECT id FROM users WHERE email = 'queue@example.com'")).rows[0].id;
    id = (await call("POST", "/api/v3/courses", { title: "Queue" }, owner)).body.course.id;
    const slides = [{ slide: 1, title: "A", narration: "Hello." }];
    await ctx.db.query("UPDATE courses SET status='parsed', slide_count=1, slides=$2::jsonb, content_hash=$3, validation='{\"ok\":true}'::jsonb WHERE id=$1", [id, JSON.stringify(slides), contentHash("Queue", slides)]);
  });

  async function onlyJob(): Promise<any> {
    return (await ctx.db.query("SELECT * FROM jobs WHERE course_id = $1 ORDER BY created_at DESC LIMIT 1", [id])).rows[0];
  }

  it("allows one active job per course and claims jobs exactly once", async () => {
    const queued = await call("POST", `/api/v3/courses/${id}/build`, {}, owner);
    assert.equal(queued.status, 202);
    assert.equal((await call("POST", `/api/v3/courses/${id}/build`, {}, owner)).status, 409);
    await ctx.db.query("UPDATE jobs SET status = 'cancelled' WHERE course_id <> $1 AND status = 'queued'", [id]);
    const [a, b] = await Promise.all([claim(ctx.db, "w1"), claim(ctx.db, "w2")]);
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.equal((await onlyJob()).status, "running");
  });

  it("delivers a cancel request to the running worker through its heartbeat", async () => {
    const job = await onlyJob();
    const hb = await heartbeat(ctx.db, job.id, job.locked_by, { progress: { percent: 40 }, log: "hello\n" });
    assert.deepEqual(hb, { lost: false, cancel: false });
    const cancel = await call("POST", `/api/v3/jobs/${job.id}/cancel`, {}, owner);
    assert.equal(cancel.body.result, "cancelling");
    assert.equal((await heartbeat(ctx.db, job.id, job.locked_by)).cancel, true);
    assert.equal((await heartbeat(ctx.db, job.id, "someone-else")).lost, true);
    const view = await call("GET", `/api/v3/jobs/${job.id}`, undefined, owner);
    assert.equal(view.body.job.progress.percent, 40);
    assert.match(view.body.job.log, /hello/);
  });

  it("requeues transient failures with backoff and fails permanent ones", async () => {
    const job = await onlyJob();
    assert.equal(await markFailed(ctx.db, job, job.locked_by, "network blip", true), "requeued");
    assert.equal(await claim(ctx.db, "w3"), null, "backoff keeps it out of the queue for now");
    await ctx.db.query("UPDATE jobs SET run_after = now() WHERE id = $1", [job.id]);
    const again = await claim(ctx.db, "w3");
    assert.equal(again.attempt, 2);
    assert.equal(await markFailed(ctx.db, again, "w3", "bad PPTX", false), "failed");
  });

  it("retries a failed job and reaps jobs whose worker died", async () => {
    const job = await onlyJob();
    const retried = await call("POST", `/api/v3/jobs/${job.id}/retry`, {}, owner);
    assert.equal(retried.status, 202);
    const running = await claim(ctx.db, "w4");
    await ctx.db.query("UPDATE jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [running.id]);
    assert.equal(await reapStale(ctx.db, 120), 1);
    assert.equal((await onlyJob()).status, "queued");
    const final = await claim(ctx.db, "w5");
    await markSucceeded(ctx.db, final.id, "w5");
    assert.equal((await onlyJob()).status, "succeeded");
  });

  it("cancels queued jobs immediately and lets other users' jobs stay private", async () => {
    await ctx.db.query("UPDATE courses SET status='parsed' WHERE id=$1", [id]);
    const q = await call("POST", `/api/v3/courses/${id}/build`, {}, owner);
    const other = await signedIn("nosy@example.com");
    assert.equal((await call("GET", `/api/v3/jobs/${q.body.job.id}`, undefined, other)).status, 404);
    assert.equal((await call("POST", `/api/v3/jobs/${q.body.job.id}/cancel`, {}, other)).status, 404);
    assert.equal((await call("POST", `/api/v3/jobs/${q.body.job.id}/cancel`, {}, owner)).body.result, "cancelled");
    assert.equal(ownerId.length > 10, true);
  });
});

describe("Windows engine presence", () => {
  it("reports the engine offline until a worker checks in, online while it does, offline after it stops", async () => {
    const cookie = await signedIn("engine@example.com");
    assert.equal((await call("GET", "/api/v3/engine")).status, 401);
    assert.equal((await call("GET", "/api/v3/engine", undefined, cookie)).body.online, false);

    await workerSeen(ctx.db, { id: "pc-1", hostname: "DESKTOP-PC", info: { tts: "kokoro" } });
    const on = (await call("GET", "/api/v3/engine", undefined, cookie)).body;
    assert.equal(on.online, true);
    assert.equal(on.tts, "kokoro");

    await ctx.db.query("UPDATE workers SET last_seen = now() - interval '5 minutes' WHERE id = 'pc-1'");
    assert.equal((await call("GET", "/api/v3/engine", undefined, cookie)).body.online, false, "a PC that stopped beating is offline");

    await workerSeen(ctx.db, { id: "pc-1", hostname: "DESKTOP-PC" });
    await workerGone(ctx.db, "pc-1");
    assert.equal((await call("GET", "/api/v3/engine", undefined, cookie)).body.online, false);
  });

  it("frees a job held by a PC that was switched off so it resumes when the PC returns", async () => {
    const cookie = await signedIn("offpc@example.com");
    const id = (await call("POST", "/api/v3/courses", { title: "PC off" }, cookie)).body.course.id;
    const slides = [{ slide: 1, title: "A", narration: "Hello." }];
    await ctx.db.query("UPDATE courses SET status='parsed', slide_count=1, slides=$2::jsonb, content_hash=$3, validation='{\"ok\":true}'::jsonb WHERE id=$1", [id, JSON.stringify(slides), contentHash("PC off", slides)]);
    await ctx.db.query("UPDATE jobs SET status = 'cancelled' WHERE status = 'queued'");
    await call("POST", `/api/v3/courses/${id}/build`, {}, cookie);
    const job = await claim(ctx.db, "pc-off");
    assert.ok(job);
    await ctx.db.query("UPDATE jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [job.id]);
    await call("GET", "/api/v3/engine", undefined, cookie); // the website notices; no worker needed
    const after = (await ctx.db.query("SELECT status, locked_by FROM jobs WHERE id = $1", [job.id])).rows[0];
    assert.deepEqual(after, { status: "queued", locked_by: null });
  });
});
