import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cloudConfig, configProblems } from "../cloud/config.js";
import { createStorage } from "../cloud/storage.js";
import { createBlobStorage, LIBRARY_KEY_PREFIX } from "../cloud/storage-blob.js";
import type { Storage } from "../cloud/storage.js";
import { startFakeBlob, type FakeBlob } from "./helpers/fake-blob.js";

const LIB = "courses/diabetes/enhanced/animated-video.enhanced.draft.mp4";
let fake: FakeBlob;
let tmp = "";
let storage: Storage;

const cfg = (extra: Record<string, string> = {}) =>
  cloudConfig({ STORAGE_DRIVER: "blob", BLOB_READ_WRITE_TOKEN: fake.token, APP_SECRET: "x".repeat(40), ...extra });

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-blob-"));
  fake = await startFakeBlob();
  fake.store.set(LIB, { buf: Buffer.from("the library video that must never be touched"), type: "video/mp4" });
  storage = await createBlobStorage(cfg(), { sdk: fake.sdk, retryDelayMs: 1 });
});
after(async () => {
  await fake.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const KEY = "users/u1/courses/c1";
const put = async (url: string, body: BodyInit, type = "application/octet-stream") => fetch(url, { method: "PUT", headers: { "content-type": type }, body });

describe("configuration", () => {
  it("is chosen with STORAGE_DRIVER=blob and needs only the existing token (no S3 credentials)", () => {
    const c = cfg();
    assert.equal(c.storageDriver, "blob");
    assert.deepEqual(configProblems(c), []);
    assert.deepEqual(configProblems(cloudConfig({ STORAGE_DRIVER: "blob", APP_SECRET: "x".repeat(40) })), ["BLOB_READ_WRITE_TOKEN is not set (the read-write token of your private Vercel Blob store)."]);
  });
  it("refuses a folder that would overlap the video library, and points S3 users at Blob", () => {
    assert.match(configProblems(cfg({ BLOB_PREFIX: "courses" })).join(), /BLOB_PREFIX/);
    assert.match(configProblems(cfg({ BLOB_PREFIX: "../x" })).join(), /BLOB_PREFIX/);
    assert.equal(cfg({ BLOB_PREFIX: "/v2/" }).blob.prefix, "v2");
    assert.match(configProblems(cloudConfig({ APP_SECRET: "x".repeat(40) })).join(), /STORAGE_DRIVER=blob/);
  });
  it("database settings: TLS is verified by default, a schema needs a direct connection", () => {
    assert.equal(cfg().dbSslVerify, true);
    assert.equal(cfg({ DATABASE_SSL: "no-verify" }).dbSslVerify, false);
    assert.deepEqual(configProblems(cfg({ DB_SCHEMA: "doctyn", DATABASE_URL: "postgresql://u:p@ep-x.c-2.aws.neon.tech/db" })), []);
    assert.match(configProblems(cfg({ DB_SCHEMA: "doctyn", DATABASE_URL: "postgresql://u:p@ep-x-pooler.c-2.aws.neon.tech/db" })).join(), /non-pooled/);
    assert.match(configProblems(cfg({ DB_SCHEMA: "Bad-Name" })).join(), /DB_SCHEMA/);
  });
  it("createStorage returns the Blob driver and fails readably without a token", async () => {
    await assert.rejects(() => createStorage(cloudConfig({ STORAGE_DRIVER: "blob", APP_SECRET: "x".repeat(40) })), /BLOB_READ_WRITE_TOKEN/);
  });
});

describe("worker-side operations (token stays on the server)", () => {
  it("uploads a file, reports its size, reads it back as a buffer and as a file", async () => {
    const src = path.join(tmp, "a.txt");
    await fs.writeFile(src, "hello blob");
    assert.equal(await storage.uploadFromFile(`${KEY}/output/a.txt`, src, "text/plain"), 10);
    assert.deepEqual(await storage.head(`${KEY}/output/a.txt`), { size: 10 });
    assert.equal((await storage.readBuffer(`${KEY}/output/a.txt`, 1000)).toString(), "hello blob");
    const dest = path.join(tmp, "deep", "dir", "copy.txt");
    await storage.downloadToFile(`${KEY}/output/a.txt`, dest);
    assert.equal(await fs.readFile(dest, "utf8"), "hello blob");
    assert.deepEqual((await fs.readdir(path.dirname(dest))), ["copy.txt"], "no temporary file is left behind");
    assert.equal(fake.store.has(`v2/${KEY}/output/a.txt`), true, "stored under the v2 folder");
  });
  it("answers null for a missing file, throws readably for a missing download, and enforces the memory cap", async () => {
    assert.equal(await storage.head(`${KEY}/nope`), null);
    await assert.rejects(() => storage.downloadToFile(`${KEY}/nope`, path.join(tmp, "x")), /not found/i);
    await assert.rejects(() => storage.readBuffer(`${KEY}/output/a.txt`, 3), /too large/);
  });
  it("treats the live SDK's plain 'does not exist' error as a missing file (its error name is not always set)", async () => {
    const real = { ...fake.sdk, head: async () => { throw new Error("Vercel Blob: The requested blob does not exist"); } };
    const s = await createBlobStorage(cfg(), { sdk: real, retryDelayMs: 1 });
    assert.equal(await s.head(`${KEY}/gone`), null);
    const other = await createBlobStorage(cfg(), { sdk: { ...fake.sdk, head: async () => { throw new Error("Vercel Blob: Access denied, please provide a valid token"); } }, retryDelayMs: 1 });
    await assert.rejects(() => other.head(`${KEY}/x`), /Access denied/);
  });
  it("sends large files as multipart and overwrites an earlier version of the same key", async () => {
    const big = path.join(tmp, "big.bin");
    await fs.writeFile(big, Buffer.alloc(9 * 1024 * 1024, 1));
    await storage.uploadFromFile(`${KEY}/output/final-video.mp4`, big, "video/mp4");
    await fs.writeFile(big, Buffer.alloc(5 * 1024 * 1024, 2));
    await storage.uploadFromFile(`${KEY}/output/final-video.mp4`, big, "video/mp4");
    const last = fake.puts.filter((p) => p.pathname.endsWith("final-video.mp4"));
    assert.deepEqual(last.map((p) => p.opts.multipart), [true, true]);
    assert.equal(last[0]!.opts.access, "private");
    assert.equal(last[0]!.opts.token, fake.token, "the token is used server-side");
    assert.equal((await storage.head(`${KEY}/output/final-video.mp4`))?.size, 5 * 1024 * 1024);
  });
  it("lists, deletes one file and deletes a whole course folder, with pagination", async () => {
    for (let i = 0; i < 1203; i++) fake.store.set(`v2/${KEY}/cache/audio/slide-${i}.mp3`, { buf: Buffer.from("x"), type: "audio/mpeg" });
    fake.store.set(`v2/users/u2/courses/c9/output/other.txt`, { buf: Buffer.from("other owner"), type: "text/plain" });
    const listed = await storage.list(`${KEY}/cache/`);
    assert.equal(listed.length, 1203);
    assert.ok(listed[0]!.key.startsWith(`${KEY}/cache/`), "keys are returned without the v2 folder");
    await storage.remove(`${KEY}/output/a.txt`);
    assert.equal(await storage.head(`${KEY}/output/a.txt`), null);
    assert.equal(await storage.removePrefix(`${KEY}/`), 1204);
    assert.equal((await storage.list(`${KEY}/`)).length, 0);
    assert.equal(fake.store.has(`v2/users/u2/courses/c9/output/other.txt`), true, "another owner's files are untouched");
  });
  it("retries transient service errors but not real ones", async () => {
    const src = path.join(tmp, "r.txt");
    await fs.writeFile(src, "retry");
    fake.failNext("put", 2, Object.assign(new Error("Blob service not available"), { name: "BlobServiceNotAvailable" }));
    assert.equal(await storage.uploadFromFile(`${KEY}/cache/r.txt`, src, "text/plain"), 5);
    fake.failNext("put", 1, Object.assign(new Error("store suspended"), { name: "BlobStoreSuspendedError" }));
    await assert.rejects(() => storage.uploadFromFile(`${KEY}/cache/r2.txt`, src, "text/plain"), /suspended/);
    fake.failNext("put", 9, Object.assign(new Error("fetch failed"), { name: "TypeError" }));
    await assert.rejects(() => storage.uploadFromFile(`${KEY}/cache/r3.txt`, src, "text/plain"), /fetch failed/, "gives up after a few attempts");
    fake.failNext("put", 0, new Error("reset"));
  });
});

describe("browser-side presigned URLs", () => {
  const key = `${KEY}/source/pptx-abc123.pptx`;
  it("uploads straight to Blob with a URL that carries no credentials", async () => {
    const url = await storage.presignPut(key, { contentType: "application/octet-stream", size: 2000 });
    assert.ok(!url.includes(fake.token), "the read-write token never appears in a URL");
    const r = await put(url, Buffer.alloc(2000, 5));
    assert.equal(r.status, 200);
    assert.deepEqual(await storage.head(key), { size: 2000 });
    assert.equal(fake.store.get(`v2/${key}`)!.buf.length, 2000);
  });
  it("is scoped to one file, one size and one use", async () => {
    const k2 = `${KEY}/source/docx-111.docx`;
    const url = await storage.presignPut(k2, { contentType: "application/octet-stream", size: 100 });
    assert.equal((await put(url, Buffer.alloc(101))).status, 403, "one byte over the declared size is refused");
    assert.equal((await put(url.replace("docx-111.docx", "docx-222.docx"), Buffer.alloc(10))).status, 403, "a different file name is refused");
    assert.equal((await put(url.replace("users%2Fu1", "users%2Fu2").replace("users/u1", "users/u2"), Buffer.alloc(10))).status, 403, "another owner's folder is refused");
    assert.equal((await put(url, Buffer.alloc(100))).status, 200);
    assert.equal((await put(url, Buffer.alloc(100, 9))).status, 400, "the same URL cannot overwrite the file");
    assert.equal(fake.store.get(`v2/${k2}`)!.buf[0], 0, "the first upload is intact");
  });
  it("downloads with a signed GET (ranges work) and refuses an unsigned or altered one", async () => {
    const get = await storage.presignGet(key, {});
    assert.ok(!get.includes(fake.token));
    const full = await fetch(get);
    assert.equal(full.status, 200);
    assert.equal((await full.arrayBuffer()).byteLength, 2000);
    const part = await fetch(get, { headers: { range: "bytes=10-19" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 10-19/2000");
    assert.equal((await fetch(get.split("?")[0]!)).status, 403, "no signature, no file");
    assert.equal((await fetch(get.replace("pptx-abc123", "pptx-zzz"))).status, 403);
  });
  it("expires", async () => {
    const quick = await createBlobStorage(cfg({ SIGNED_URL_SECONDS: "1" }), { sdk: fake.sdk });
    const url = await quick.presignGet(key, {});
    assert.equal((await fetch(url)).status, 200);
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal((await fetch(url)).status, 403);
  });
});

describe("the private video library in the same store is never touched", () => {
  it("lists, reads and deletes only inside the v2 folder", async () => {
    const before = fake.store.get(LIB)!.buf.toString();
    assert.deepEqual(await storage.list("courses/"), [], "the library is not visible as a V2 key");
    await storage.removePrefix("courses/x/y/").catch(() => {});
    await assert.rejects(() => storage.removePrefix("users/"), /Refusing/);
    await assert.rejects(() => storage.removePrefix("users/u1/courses/c1"), /Refusing/);
    for (const bad of ["../courses/diabetes/x.mp4", "/courses/x", "a//b", "a/./b"]) await assert.rejects(() => storage.remove(bad), /Unsafe/);
    await assert.rejects(() => storage.head(`${LIBRARY_KEY_PREFIX}courses/other/video.mp4`), /registered/);
    assert.equal(fake.store.get(LIB)!.buf.toString(), before);
  });
  it("lets a registered library file be read — and only read — through a library: key", async () => {
    const k = `${LIBRARY_KEY_PREFIX}${LIB}`;
    assert.equal((await storage.head(k))?.size, fake.store.get(LIB)!.buf.length);
    assert.match((await storage.readBuffer(k, 1000)).toString(), /library video/);
    const url = await storage.presignGet(k, {});
    assert.equal((await fetch(url)).status, 200);
    await assert.rejects(() => storage.remove(k), /read-only/);
    await assert.rejects(() => storage.uploadFromFile(k, path.join(tmp, "a.txt"), "text/plain"), /read-only/);
    await assert.rejects(() => storage.presignPut(k, { contentType: "video/mp4", size: 1 }), /read-only/);
    assert.ok(fake.store.has(LIB));
  });
});
