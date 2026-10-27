import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cloudConfig } from "../cloud/config.js";
import { createDb } from "../cloud/db.js";
import { handleApi, type Ctx } from "../cloud/routes.js";
import { createBlobStorage, LIBRARY_KEY_PREFIX } from "../cloud/storage-blob.js";
import { courseKeys } from "../cloud/util.js";
import { importCourse } from "../src/worker/import-course.js";
import { startFakeBlob, type FakeBlob } from "./helpers/fake-blob.js";

const LIB = "courses/diabetes/enhanced/animated-video.enhanced.draft.mp4";
let fake: FakeBlob;
let ctx: Ctx;
let server: http.Server;
let base = "";
let tmp = "";
const bodies: string[] = [];

async function call(method: string, p: string, body?: unknown, cookie?: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    redirect: "manual",
    headers: { "x-requested-with": "doctyn", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...init,
  });
  const text = res.status === 302 ? "" : await res.text();
  bodies.push(text);
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not json */
  }
  const set = res.headers.get("set-cookie");
  return { status: res.status, body: parsed, headers: res.headers, ...(set ? { cookie: set.split(";")[0]! } : {}) };
}

async function user(email: string) {
  const pw = "correct horse battery";
  assert.equal((await call("POST", "/api/v3/auth/register", { email, name: email, password: pw })).status, 201);
  await ctx.db.query("UPDATE users SET status = 'active' WHERE email = $1", [email]);
  const r = await call("POST", "/api/v3/auth/login", { email, password: pw });
  return { cookie: r.cookie!, id: (await ctx.db.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as string };
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-blobflow-"));
  fake = await startFakeBlob();
  fake.store.set(LIB, { buf: Buffer.from("library video"), type: "video/mp4" });
  const config = cloudConfig({ STORAGE_DRIVER: "blob", BLOB_READ_WRITE_TOKEN: fake.token, LOCAL_DB_DIR: "memory://", APP_SECRET: "x".repeat(40) });
  ctx = { config, db: await createDb(config), storage: await createBlobStorage(config, { sdk: fake.sdk, retryDelayMs: 1 }) };
  server = http.createServer((req, res) => void handleApi(ctx, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.close();
  await ctx.db.close();
  await fake.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("the website flow on Vercel Blob storage", () => {
  let alice: Awaited<ReturnType<typeof user>>;
  let bob: Awaited<ReturnType<typeof user>>;
  let courseId = "";
  let pptxKey = "";
  const PPTX = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(3 * 1024 * 1024, 3)]);

  it("reports the storage driver", async () => {
    assert.equal((await call("GET", "/api/v3/health")).body.storage, "blob");
  });

  it("uploads a PPTX straight from the browser to Blob and registers it for its owner", async () => {
    alice = await user("alice@example.org");
    bob = await user("bob@example.org");
    courseId = (await call("POST", "/api/v3/courses", { title: "Cardiology" }, alice.cookie)).body.course.id;
    const up = await call("POST", `/api/v3/courses/${courseId}/upload-url`, { type: "pptx", filename: "deck.pptx", size: PPTX.length }, alice.cookie);
    assert.equal(up.status, 200);
    pptxKey = up.body.key;
    assert.ok(pptxKey.startsWith(`users/${alice.id}/courses/${courseId}/source/pptx-`), "the key is scoped to the owner and course");
    assert.ok(up.body.url.startsWith(fake.origin), "the browser talks to Blob directly, not through the function");
    assert.ok(!up.body.url.includes(fake.token));

    // what the dashboard's XHR does
    const put = await fetch(up.body.url, { method: up.body.method, headers: up.body.headers, body: PPTX });
    assert.equal(put.status, 200);
    const done = await call("POST", `/api/v3/courses/${courseId}/files/complete`, { type: "pptx", key: pptxKey, filename: "deck.pptx" }, alice.cookie);
    assert.equal(done.status, 200);
    assert.equal(done.body.course.files.pptx, "deck.pptx");
    assert.equal(fake.store.get(`v2/${pptxKey}`)!.buf.length, PPTX.length);
  });

  it("refuses an upload that is larger than declared, and a key that belongs to someone else", async () => {
    const up = await call("POST", `/api/v3/courses/${courseId}/upload-url`, { type: "docx", filename: "s.docx", size: 50 }, alice.cookie);
    assert.equal((await fetch(up.body.url, { method: "PUT", headers: up.body.headers, body: Buffer.alloc(51) })).status, 403);
    // bob tries to attach alice's uploaded file to his own course
    const bobCourse = (await call("POST", "/api/v3/courses", { title: "Bob" }, bob.cookie)).body.course.id;
    const steal = await call("POST", `/api/v3/courses/${bobCourse}/files/complete`, { type: "pptx", key: pptxKey, filename: "deck.pptx" }, bob.cookie);
    assert.equal(steal.status, 400);
    assert.equal((await call("GET", `/api/v3/courses/${courseId}`, undefined, bob.cookie)).status, 404);
    assert.equal((await call("POST", `/api/v3/courses/${courseId}/upload-url`, { type: "pptx", filename: "x.pptx", size: 10 }, bob.cookie)).status, 404);
  });

  it("lets the Windows worker download the source and upload its results", async () => {
    const dest = path.join(tmp, "worker", "presentation.pptx");
    await ctx.storage.downloadToFile(pptxKey, dest);
    assert.ok((await fs.readFile(dest)).equals(PPTX));

    const keys = courseKeys(alice.id, courseId);
    const files: Record<string, [string, string, Buffer]> = {
      video: ["final-video.mp4", "video/mp4", Buffer.alloc(6 * 1024 * 1024, 1)],
      animated: ["animated-video.mp4", "video/mp4", Buffer.alloc(5 * 1024 * 1024, 2)],
      thumbnail: ["thumbnail.jpg", "image/jpeg", Buffer.from("jpg")],
      vtt: ["captions.vtt", "text/vtt; charset=utf-8", Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n")],
    };
    const outputs: Record<string, { key: string; bytes: number; draft?: boolean }> = {};
    for (const [name, [file, type, data]] of Object.entries(files)) {
      const local = path.join(tmp, "worker", file);
      await fs.writeFile(local, data);
      const key = keys.output(file);
      outputs[name] = { key, bytes: await ctx.storage.uploadFromFile(key, local, type), ...(name === "animated" ? { draft: true } : {}) };
    }
    // audio / preview / cache files
    await fs.writeFile(path.join(tmp, "worker", "s1.mp3"), "mp3");
    await ctx.storage.uploadFromFile(`${keys.cache}audio/slide-001.mp3`, path.join(tmp, "worker", "s1.mp3"), "audio/mpeg");
    await ctx.storage.uploadFromFile(keys.slideImage(1), path.join(tmp, "worker", "thumbnail.jpg"), "image/jpeg");
    await ctx.db.query("UPDATE courses SET status = 'complete', outputs = $2::jsonb, duration_seconds = 10, completed_at = now() WHERE id = $1", [courseId, JSON.stringify(outputs)]);
  });

  it("plays and downloads only for the owner, through short-lived signed links, with ranges", async () => {
    const r = await call("GET", `/api/v3/courses/${courseId}/files/video`, undefined, alice.cookie);
    assert.equal(r.status, 302);
    const loc = r.headers.get("location")!;
    assert.ok(loc.startsWith(fake.origin) && !loc.includes(fake.token));
    const part = await fetch(loc, { headers: { range: "bytes=0-9" } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(loc)).headers.get("content-length"), String(6 * 1024 * 1024));
    assert.equal((await call("GET", `/api/v3/courses/${courseId}/files/video`, undefined, bob.cookie)).status, 404);
    assert.equal((await call("GET", `/api/v3/courses/${courseId}/files/video`)).status, 401);
    const vtt = await call("GET", `/api/v3/courses/${courseId}/files/vtt`, undefined, alice.cookie);
    assert.match(vtt.body, /WEBVTT/);
    assert.equal((await call("GET", `/api/v3/courses/${courseId}/files/animated`, undefined, alice.cookie)).status, 302);
  });

  it("never returns the Blob token in any response", () => {
    for (const b of bodies) assert.ok(!b.includes(fake.token));
  });

  it("deleting the course removes its files and nothing else in the store", async () => {
    const before = fake.store.size;
    assert.equal((await call("DELETE", `/api/v3/courses/${courseId}`, undefined, alice.cookie)).status, 200);
    assert.deepEqual([...fake.store.keys()].filter((k) => k.startsWith(`v2/users/${alice.id}/courses/${courseId}/`)), []);
    assert.ok(fake.store.has(LIB), "the library video is still there");
    assert.ok(fake.store.size < before);
  });
});

describe("importing the existing diabetes course on Blob storage", () => {
  it("references the library video in place instead of uploading a second copy, keeps it a draft, and rollback leaves it alone", async () => {
    const dir = path.join(tmp, "output", "risk-factors");
    await fs.mkdir(path.join(dir, "animation", "enhanced"), { recursive: true });
    const enhanced = Buffer.from("the library video that is already in Blob".repeat(3));
    fake.store.set(LIB, { buf: enhanced, type: "video/mp4" });
    for (const [f, d] of Object.entries({ "presentation.pptx": "pptx", "voiceover-script.docx": "docx", "final-video.mp4": "narrated", "thumbnail.jpg": "jpg", "captions.vtt": "WEBVTT", "captions.srt": "1", "transcript.txt": "t" })) await fs.writeFile(path.join(dir, f), d);
    await fs.writeFile(path.join(dir, "course.json"), JSON.stringify({ courseTitle: "Risk Factors", courseSlug: "risk", slideCount: 52, durationSeconds: 915.7, generatedAt: "2026-10-22T17:08:35.465Z" }));
    await fs.writeFile(path.join(dir, "animation", "enhanced", "animated-video.enhanced.draft.mp4"), enhanced);
    const owner = await user("owner@example.org");

    const before = fake.store.size;
    const r = await importCourse(ctx, { dir, ownerId: owner.id, finalize: true, cache: false, reuseAnimated: { key: `${LIBRARY_KEY_PREFIX}${LIB}` } });
    assert.ok(r?.created);
    const row = (await ctx.db.query("SELECT outputs, status FROM courses WHERE id = $1", [r!.courseId])).rows[0];
    assert.equal(row.status, "complete");
    assert.deepEqual(row.outputs.animated, { key: `${LIBRARY_KEY_PREFIX}${LIB}`, bytes: enhanced.length, draft: true });
    assert.equal([...fake.store.keys()].filter((k) => k.includes("animated-video.mp4")).length, 0, "no second copy of the enhanced video");
    assert.equal(fake.store.size - before, 6 + 1 + 0, "source pptx/docx + narrated video, thumbnail and captions/transcript only; no cache");

    const url = await call("GET", `/api/v3/courses/${r!.courseId}/files/animated`, undefined, owner.cookie);
    assert.equal(url.status, 302);
    assert.equal(await (await fetch(url.headers.get("location")!)).text(), enhanced.toString(), "the owner plays the very same library file");
    const other = await user("someone@example.org");
    assert.equal((await call("GET", `/api/v3/courses/${r!.courseId}/files/animated`, undefined, other.cookie)).status, 404, "still private to its owner");

    // deleting or rolling back the course never touches the library object
    await call("DELETE", `/api/v3/courses/${r!.courseId}`, undefined, owner.cookie);
    assert.equal(fake.store.get(LIB)!.buf.toString(), enhanced.toString());
  });

  it("can be imported again after the first import was deleted, and uploads its own copy when the stored file differs in size", async () => {
    const dir = path.join(tmp, "output", "risk-factors");
    await fs.writeFile(path.join(dir, "animation", "enhanced", "animated-video.enhanced.draft.mp4"), "different bytes");
    const owner = (await ctx.db.query("SELECT id FROM users WHERE email = 'owner@example.org'")).rows[0].id;
    const r = await importCourse(ctx, { dir, ownerId: owner, finalize: true, cache: false, reuseAnimated: { key: `${LIBRARY_KEY_PREFIX}${LIB}` } });
    assert.equal(r?.created, true);
    const row = (await ctx.db.query("SELECT outputs FROM courses WHERE id = $1", [r!.courseId])).rows[0];
    assert.ok(row.outputs.animated.key.startsWith(`users/${owner}/`), "uploaded its own copy because the library file is a different size");
  });
});
