import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildPlan, catalogEntry, expectedCatalogUrl, findAuth, removeCourse, requireAuth, upsertCourse } from "../src/services/publish.js";

// The serverless functions are plain JS outside the TypeScript project, so load them dynamically.
const API = path.resolve(import.meta.dirname, "..", "api");
const load = async (file: string) => (await import(pathToFileURL(path.join(API, file)).href)) as Record<string, any>;

let root: string;
const SLUG = "sample-course";
const BLOB = "https://abc123.public.blob.vercel-storage.com";

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-publish-"));
  const dir = path.join(root, SLUG);
  await fs.mkdir(path.join(dir, "source"), { recursive: true });
  await fs.writeFile(path.join(dir, "course.json"), JSON.stringify({ courseTitle: "Sample", slideCount: 3, durationSeconds: 10, status: "complete", generatedAt: "2026-10-01T10:00:00.000Z" }));
  await fs.writeFile(path.join(dir, "checkpoint.json"), JSON.stringify({ version: 1, updatedAt: "2026-10-01T10:00:00.000Z", stages: { final_validation: { status: "complete" } }, slides: {} }));
  for (const f of ["final-video.mp4", "thumbnail.jpg", "captions.vtt", "captions.srt", "transcript.txt", "presentation.pptx", "voiceover-script.docx", "source/deck.pptx"]) {
    await fs.writeFile(path.join(dir, f), "data");
  }
  await fs.mkdir(path.join(root, "half"), { recursive: true });
  await fs.writeFile(path.join(root, "half", "checkpoint.json"), JSON.stringify({ version: 1, updatedAt: "x", stages: {}, slides: {} }));
});

after(() => fs.rm(root, { recursive: true, force: true }));

test("publish plan contains only public learner files, never sources or secrets", async () => {
  const plan = await buildPlan(root, SLUG);
  const names = plan.files.map((f) => path.basename(f.localPath)).sort();
  assert.deepEqual(names, ["captions.srt", "captions.vtt", "final-video.mp4", "thumbnail.jpg", "transcript.txt"]);
  assert.ok(plan.files.every((f) => f.blobPath.startsWith(`courses/${SLUG}/`)));
});

test("publish refuses incomplete, unknown and unsafe courses", async () => {
  await assert.rejects(buildPlan(root, "half"), /not complete/);
  await assert.rejects(buildPlan(root, "missing"), /No course folder/);
  await assert.rejects(buildPlan(root, "../etc"), /cannot be published/);
  await fs.rm(path.join(root, SLUG, "captions.vtt"));
  await assert.rejects(buildPlan(root, SLUG), /missing: captions\.vtt/);
  await fs.writeFile(path.join(root, SLUG, "captions.vtt"), "data");
});

test("catalog upsert replaces by slug and removal drops it", async () => {
  const plan = await buildPlan(root, SLUG);
  const urls = { video: `${BLOB}/v.mp4`, thumbnail: `${BLOB}/t.jpg` };
  const first = upsertCourse(null, catalogEntry(plan, urls, "2026-10-02T00:00:00Z"), "2026-10-02T00:00:00Z");
  const second = upsertCourse(first, catalogEntry(plan, urls, "2026-10-03T00:00:00Z"), "2026-10-03T00:00:00Z");
  assert.equal(second.courses.length, 1);
  assert.equal(second.courses[0]!.publishedAt, "2026-10-03T00:00:00Z");
  assert.equal(removeCourse(second, SLUG, "now").courses.length, 0);
});

test("catalog URL is derived from the Blob token or overridden explicitly", async () => {
  const { catalogUrl } = await load("_lib/catalog.js");
  const token = "vercel_blob_rw_AbC123_secretvalue";
  assert.equal(catalogUrl({ BLOB_READ_WRITE_TOKEN: token }), `${BLOB}/library/catalog.json`);
  assert.equal(expectedCatalogUrl(token), `${BLOB}/library/catalog.json`);
  assert.equal(catalogUrl({ LIBRARY_CATALOG_URL: "https://x.example/c.json", BLOB_READ_WRITE_TOKEN: token }), "https://x.example/c.json");
  assert.equal(catalogUrl({}), null);
});

test("cleanCatalog drops malformed entries and non-Blob URLs", async () => {
  const { cleanCatalog } = await load("_lib/catalog.js");
  const courses = cleanCatalog({
    courses: [
      { slug: "good", title: "Good", files: { video: { url: `${BLOB}/a.mp4`, bytes: 5 }, vtt: { url: "https://evil.example/x.vtt" } } },
      { slug: "../bad", title: "Bad", files: { video: { url: `${BLOB}/b.mp4` } } },
      { slug: "no-video", title: "No video", files: {} },
      { slug: "http-only", title: "HTTP", files: { video: { url: "http://abc.public.blob.vercel-storage.com/c.mp4" } } },
    ],
  });
  assert.equal(courses.length, 1);
  assert.equal(courses[0].slug, "good");
  assert.deepEqual(Object.keys(courses[0].files), ["video"]);
});

function fakeRes() {
  const res: any = { headers: {} as Record<string, string>, code: 0, body: undefined };
  res.setHeader = (k: string, v: string) => ((res.headers[k] = v), res);
  res.status = (c: number) => ((res.code = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.send = (b: unknown) => ((res.body = b), res);
  return res;
}

test("/api/library reports unconfigured storage and lists published courses", async () => {
  const { default: handler } = await load("library.js");
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  try {
    delete process.env["BLOB_READ_WRITE_TOKEN"];
    delete process.env["LIBRARY_CATALOG_URL"];
    let res = fakeRes();
    await handler({ method: "GET", query: {} }, res);
    assert.deepEqual(res.body, { configured: false, courses: [] });

    process.env["BLOB_READ_WRITE_TOKEN"] = "vercel_blob_rw_abc123_x";
    globalThis.fetch = (async () => new Response(JSON.stringify({ courses: [{ slug: SLUG, title: "T", files: { video: { url: `${BLOB}/v.mp4`, bytes: 1 } } }] }))) as typeof fetch;
    res = fakeRes();
    await handler({ method: "GET", query: {} }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.courses[0].slug, SLUG);

    res = fakeRes();
    await handler({ method: "POST", query: {} }, res);
    assert.equal(res.code, 405);
  } finally {
    globalThis.fetch = savedFetch;
    process.env = saved;
  }
});

test("/api/course-file only serves files listed in the catalog", async () => {
  const { default: handler } = await load("course-file.js");
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  const requested: string[] = [];
  try {
    process.env["BLOB_READ_WRITE_TOKEN"] = "vercel_blob_rw_abc123_x";
    globalThis.fetch = (async (url: string) => {
      requested.push(String(url));
      return String(url).includes("catalog.json")
        ? new Response(JSON.stringify({ courses: [{ slug: SLUG, title: "T", files: { video: { url: `${BLOB}/v.mp4` }, vtt: { url: `${BLOB}/c.vtt` } } }] }))
        : new Response("WEBVTT\n");
    }) as typeof fetch;

    let res = fakeRes();
    await handler({ method: "GET", query: { slug: SLUG, file: "vtt", download: "1" } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.headers["Content-Type"], "text/vtt; charset=utf-8");
    assert.match(res.headers["Content-Disposition"], /attachment; filename="sample-course-captions\.vtt"/);
    assert.equal(String(res.body), "WEBVTT\n");

    res = fakeRes();
    await handler({ method: "GET", query: { slug: SLUG, file: "srt" } }, res);
    assert.equal(res.code, 404);
    res = fakeRes();
    await handler({ method: "GET", query: { slug: SLUG, file: "video" } }, res);
    assert.equal(res.code, 400);
    assert.ok(requested.every((u) => u.includes("catalog.json") || u.startsWith(BLOB)));
  } finally {
    globalThis.fetch = savedFetch;
    process.env = saved;
  }
});

test("Blob credentials: OIDC works without BLOB_READ_WRITE_TOKEN and needs a store id", () => {
  const oidc = { VERCEL_OIDC_TOKEN: "oidc-secret", BLOB_STORE_ID: "store_AbC123" };
  assert.deepEqual(findAuth(oidc), { oidcToken: "oidc-secret", storeId: "store_AbC123" });
  assert.equal(expectedCatalogUrl(findAuth(oidc)!), `${BLOB}/library/catalog.json`);
  assert.deepEqual(findAuth({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_AbC123_x" }), { token: "vercel_blob_rw_AbC123_x" });
  assert.equal(findAuth({}), null);
  assert.throws(() => requireAuth({ VERCEL_OIDC_TOKEN: "oidc-secret" }), (e: Error) => /BLOB_STORE_ID/.test(e.message + String((e as any).hint ?? "")) && !e.message.includes("oidc-secret"));
  assert.throws(() => requireAuth({}), /No Vercel Blob credentials/);
});
