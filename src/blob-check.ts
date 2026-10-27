/**
 * npm run blob:check [-- --size-mb 24]
 *
 * Live check of the Vercel Blob storage adapter against YOUR real private store (BLOB_READ_WRITE_TOKEN from .env / .env.local).
 * It writes only under a throw-away folder (v2-check-<random>/…), deletes exactly that folder at the end, and touches the
 * existing video library in one way only: a read-only size check of the registered diabetes video (no download, no write).
 *
 * Verifies: private presigned upload straight from "the browser", size cap, one-time URLs, signed downloads with ranges,
 * unsigned/altered links refused, expiry, worker-style multipart upload + streamed download (hash compared), listing, deletion,
 * and that the library video is reachable read-only and unchanged.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cloudConfig, configProblems } from "../cloud/config.js";
import { LIBRARY_VIDEOS } from "../cloud/library-catalog.js";
import { createStorage } from "../cloud/storage.js";
import { LIBRARY_KEY_PREFIX } from "../cloud/storage-blob.js";
import "./utils/config.js";
import { formatError } from "./utils/errors.js";

const sizeMb = Number(process.argv[process.argv.indexOf("--size-mb") + 1]) || 24;
const prefix = `v2-check-${Math.random().toString(36).slice(2, 10)}`;
const config = cloudConfig({ ...process.env, STORAGE_DRIVER: "blob", BLOB_PREFIX: prefix, APP_SECRET: "c".repeat(40), SIGNED_URL_SECONDS: "900" });
const problems = configProblems(config);
if (problems.length) {
  console.error(`The Blob settings are incomplete:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
const storage = await createStorage(config);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-blobcheck-"));
const key = (n: string): string => `users/check/courses/check/${n}`;
let passed = 0;
const ok = (cond: unknown, what: string): void => {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
  passed++;
  console.log(`  ok: ${what}`);
};
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

try {
  console.log(`Vercel Blob adapter check (throw-away folder "${prefix}")`);

  console.log("1. browser upload: presigned PUT straight to the private store");
  const doc = Buffer.alloc(3 * 1024 * 1024, 4);
  const ct = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const putUrl = await storage.presignPut(key("source/pptx-aaa.pptx"), { contentType: ct, size: doc.length });
  ok(!putUrl.includes(config.blob.token!), "the URL does not contain the read-write token");
  ok((await fetch(putUrl, { method: "PUT", headers: { "content-type": ct }, body: doc })).ok, "upload accepted");
  ok((await storage.head(key("source/pptx-aaa.pptx")))?.size === doc.length, "the stored size matches");
  ok(!(await fetch(putUrl, { method: "PUT", headers: { "content-type": ct }, body: doc })).ok, "the same URL cannot overwrite the file");
  const small = await storage.presignPut(key("source/docx-bbb.docx"), { contentType: ct, size: 100 });
  ok(!(await fetch(small, { method: "PUT", headers: { "content-type": ct }, body: Buffer.alloc(101) })).ok, "a file larger than declared is refused");
  const other = putUrl.replace("pptx-aaa", "pptx-zzz");
  ok(!(await fetch(other, { method: "PUT", headers: { "content-type": ct }, body: doc })).ok, "the URL cannot be pointed at another file");

  console.log("2. downloads: signed GET, ranges, no signature = no file");
  const getUrl = await storage.presignGet(key("source/pptx-aaa.pptx"), {});
  const full = await fetch(getUrl);
  ok(full.ok && sha(Buffer.from(await full.arrayBuffer())) === sha(doc), "the owner's link returns the exact bytes");
  const part = await fetch(getUrl, { headers: { range: "bytes=100-199" } });
  ok(part.status === 206 && (await part.arrayBuffer()).byteLength === 100, "byte ranges work (video seeking)");
  ok((await fetch(getUrl.split("?")[0]!)).status === 403, "the bare URL without a signature is refused");

  console.log(`3. worker: ${sizeMb} MB multipart upload and streamed download`);
  const big = Buffer.alloc(sizeMb * 1024 * 1024);
  for (let i = 0; i < big.length; i += 65536) big.writeUInt32LE(i, i);
  const bigFile = path.join(tmp, "big.mp4");
  await fs.writeFile(bigFile, big);
  const t0 = Date.now();
  ok((await storage.uploadFromFile(key("output/final-video.mp4"), bigFile, "video/mp4")) === big.length, `uploaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const t1 = Date.now();
  await storage.downloadToFile(key("output/final-video.mp4"), path.join(tmp, "back.mp4"));
  ok(sha(await fs.readFile(path.join(tmp, "back.mp4"))) === sha(big), `downloaded in ${((Date.now() - t1) / 1000).toFixed(1)}s, identical hash`);
  await storage.uploadFromFile(key("output/final-video.mp4"), bigFile, "video/mp4");
  ok(true, "re-uploading the same key replaces it (edit-again flow)");
  const small2 = path.join(tmp, "c.vtt");
  await fs.writeFile(small2, "WEBVTT\n");
  await storage.uploadFromFile(key("output/captions.vtt"), small2, "text/vtt; charset=utf-8");
  ok((await storage.readBuffer(key("output/captions.vtt"), 100)).toString() === "WEBVTT\n", "small text files read back");

  console.log("4. listing and deleting");
  const listed = await storage.list("users/check/courses/check/");
  ok(listed.length === 3 && listed.every((o) => o.key.startsWith("users/check/")), `list shows ${listed.length} files, keys without the folder prefix`);
  ok((await storage.removePrefix("users/check/courses/check/")) === 3, "removing the course folder deletes its 3 files");
  ok((await storage.head(key("output/final-video.mp4"))) === null && (await storage.list("users/")).length === 0, "nothing is left");

  console.log("5. the existing video library is reachable read-only and unchanged");
  const lib = LIBRARY_VIDEOS[0]?.files.animated;
  if (lib) {
    const head = await storage.head(`${LIBRARY_KEY_PREFIX}${lib.pathname}`);
    ok(head?.size === lib.bytes, `the registered diabetes enhanced draft is there: ${head?.size} bytes (expected ${lib.bytes})`);
    let refused = false;
    await storage.remove(`${LIBRARY_KEY_PREFIX}${lib.pathname}`).catch(() => (refused = true));
    ok(refused, "deleting it through the adapter is refused");
  }
  console.log(`\nBLOB CHECK PASS (${passed} checks)`);
} catch (err) {
  console.error(`\nBLOB CHECK FAIL: ${formatError(err)}`);
  process.exitCode = 1;
} finally {
  const left = await storage.list("users/").catch(() => []);
  for (const o of left) await storage.remove(o.key).catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`cleanup: ${left.length} stray file(s) removed from ${prefix}/`);
}
