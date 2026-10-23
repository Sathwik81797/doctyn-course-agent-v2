import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createDashboardServer, originMatcher } from "../src/server/app.js";
import { safeUploadName } from "../src/server/library.js";

let root: string;
let base: string;
let server: http.Server;
const SLUG = "sample-course";
const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-dashboard-"));
  const course = path.join(root, "output", SLUG);
  const preview = path.join(course, "qa", "tts-preview", "kokoro-af_heart-1x");
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(
    path.join(course, "course.json"),
    JSON.stringify({ courseTitle: "Sample Course", slideCount: 3, durationSeconds: 42.5, status: "complete", generatedAt: "2026-10-01T10:00:00.000Z" }),
  );
  await fs.writeFile(
    path.join(course, "checkpoint.json"),
    JSON.stringify({ version: 1, updatedAt: "2026-10-01T10:00:00.000Z", stages: { final_validation: { status: "complete" } }, slides: {} }),
  );
  await fs.writeFile(path.join(course, "final-video.mp4"), VIDEO);
  await fs.writeFile(path.join(course, "thumbnail.jpg"), "jpg");
  await fs.writeFile(path.join(course, "captions.vtt"), "WEBVTT\n");
  await fs.writeFile(path.join(course, "checkpoint.secret"), "nope");
  await fs.writeFile(path.join(preview, "slide-001.mp3"), "mp3");
  await fs.writeFile(
    path.join(preview, "preview.txt"),
    "TTS preview\nGenerated: 2026-10-02T08:00:00.000Z\n\nslide-001.mp3  19.50s  Slide 01 — Welcome\n",
  );
  // An incomplete build: checkpoint only.
  await fs.mkdir(path.join(root, "output", "half-built"), { recursive: true });
  await fs.writeFile(path.join(root, "output", "half-built", "checkpoint.json"), JSON.stringify({ version: 1, stages: {}, slides: {} }));

  await fs.mkdir(path.join(root, "input"), { recursive: true });
  await fs.writeFile(path.join(root, "input", "old.pptx"), "PK\x03\x04old");
  await fs.mkdir(path.join(root, "public"), { recursive: true });
  await fs.writeFile(path.join(root, "public", "index.html"), "<!doctype html><title>t</title>");

  // Stand-in CLI scripts (Node runs these .ts files directly via type stripping).
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "build-course.ts"),
    [
      `console.log("DOCTYN COURSE BUILD");`,
      `console.log("Output: " + ${JSON.stringify(course)});`,
      `const stages = ["input_detected","pptx_parsed","docx_parsed","validated","slides_rendered","audio_generated","segments_generated","captions_generated","video_generated","final_validation"];`,
      `stages.forEach((s, i) => console.log("[" + (i + 1) + "/10] " + s));`,
      `setTimeout(() => { console.log("COURSE BUILD COMPLETE"); console.log("Validation: PASS"); }, 400);`,
    ].join("\n"),
  );
  await fs.writeFile(path.join(root, "src", "validate.ts"), `console.error("\\nERROR\\n-----\\nInput folder problem."); process.exitCode = 1;`);

  ({ server } = await createDashboardServer({
    projectRoot: root,
    inputDir: path.join(root, "input"),
    outputDir: path.join(root, "output"),
    publicDir: path.join(root, "public"),
    allowedOrigins: ["https://doctyn-course-ai-agent.vercel.app", "https://doctyn-course-ai-agent-*.vercel.app"],
    tts: { provider: "kokoro", voice: "af_heart", speed: 1 },
    maxUploadBytes: 1024 * 1024,
    jobRunner: { command: process.execPath, prefixArgs: [] },
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.rm(root, { recursive: true, force: true });
});

async function json(url: string, init?: RequestInit) {
  const res = await fetch(base + url, init);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

async function waitForJob(id: string) {
  for (let i = 0; i < 100; i++) {
    const { body } = await json(`/api/jobs/${id}`);
    if (body.job.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("job did not finish");
}

test("health reports the service and TTS settings", async () => {
  const { status, body } = await json("/api/health");
  assert.equal(status, 200);
  assert.equal(body.service, "doctyn-course-agent");
  assert.equal(body.tts.voice, "af_heart");
  assert.equal(body.currentJob, null);
});

test("requests to a non-localhost Host are refused", async () => {
  const port = (server.address() as AddressInfo).port;
  const status = await new Promise<number>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/api/health", headers: { host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      })
      .on("error", reject);
  });
  assert.equal(status, 421);
});

test("CORS: Vercel origins allowed, others rejected, private-network preflight answered", async () => {
  const ok = await fetch(`${base}/api/health`, { headers: { origin: "https://doctyn-course-ai-agent.vercel.app" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://doctyn-course-ai-agent.vercel.app");
  await ok.text();
  const preview = await fetch(`${base}/api/health`, { headers: { origin: "https://doctyn-course-ai-agent-git-main-team.vercel.app" } });
  assert.equal(preview.status, 200);
  await preview.text();
  const bad = await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(bad.status, 403);
  await bad.text();
  const pre = await fetch(`${base}/api/jobs`, {
    method: "OPTIONS",
    headers: {
      origin: "https://doctyn-course-ai-agent.vercel.app",
      "access-control-request-method": "POST",
      "access-control-request-private-network": "true",
    },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-private-network"), "true");
});

test("originMatcher wildcard only matches one host-label fragment", () => {
  const m = originMatcher(["https://app-*.vercel.app"]);
  assert.ok(m("https://app-abc123.vercel.app"));
  assert.ok(!m("https://app-abc.evil.com/.vercel.app"));
  assert.ok(!m("https://app-x.vercel.app.evil.com"));
});

test("course library reflects what is on disk", async () => {
  const { body } = await json("/api/courses");
  const sample = body.courses.find((c: any) => c.slug === SLUG);
  assert.equal(sample.title, "Sample Course");
  assert.equal(sample.status, "complete");
  assert.equal(sample.files.video.bytes, VIDEO.length);
  assert.equal(sample.files.srt, null);
  const half = body.courses.find((c: any) => c.slug === "half-built");
  assert.equal(half.status, "incomplete");
  assert.equal(half.files.video, null);
});

test("voice previews are listed with titles from preview.txt", async () => {
  const { body } = await json("/api/previews");
  assert.equal(body.previews.length, 1);
  assert.equal(body.previews[0].clips[0].title, "Slide 01 — Welcome");
  assert.equal(body.previews[0].clips[0].seconds, 19.5);
});

test("media supports byte ranges and downloads", async () => {
  const res = await fetch(`${base}/media/${SLUG}/final-video.mp4`, { headers: { range: "bytes=10-19" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 10-19/${VIDEO.length}`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), VIDEO.subarray(10, 20));
  const dl = await fetch(`${base}/media/${SLUG}/final-video.mp4?download=1`);
  assert.match(dl.headers.get("content-disposition") ?? "", /attachment; filename="sample-course-final-video.mp4"/);
  await dl.arrayBuffer();
});

test("media refuses traversal and unlisted file types", async () => {
  for (const p of [
    `/media/${SLUG}/%2e%2e/%2e%2e/input/old.pptx`,
    `/media/${SLUG}/checkpoint.secret`,
    `/media/.dashboard/activity.json`,
    `/media/${SLUG}/..%5c..%5cinput%5cold.pptx`,
  ]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
    await res.arrayBuffer();
  }
});

test("upload rejects non-Office files and replaces the previous PPTX safely", async () => {
  const bad = await json(`/api/inputs/pptx?filename=deck.pptx`, { method: "PUT", body: "not a zip" });
  assert.equal(bad.status, 400);
  const wrongExt = await json(`/api/inputs/pptx?filename=notes.docx`, { method: "PUT", body: "PK\x03\x04" });
  assert.equal(wrongExt.status, 400);

  const good = await json(`/api/inputs/pptx?filename=${encodeURIComponent("New Deck.pptx")}`, { method: "PUT", body: "PK\x03\x04new" });
  assert.equal(good.status, 201);
  assert.deepEqual(good.body.replaced, ["old.pptx"]);
  assert.deepEqual(good.body.inputs.pptx.map((f: any) => f.name), ["New Deck.pptx"]);
  const archived = await fs.readdir(path.join(root, "input", ".replaced"));
  assert.equal(archived.length, 1);
  assert.deepEqual(await fs.readdir(path.join(root, "input", ".replaced", archived[0]!)), ["old.pptx"]);
  const leftovers = (await fs.readdir(path.join(root, "input"))).filter((n) => n.startsWith(".uploading"));
  assert.deepEqual(leftovers, []);
});

test("build job streams progress, blocks a second job, and records activity", async () => {
  const start = await json("/api/jobs", { method: "POST", body: JSON.stringify({ kind: "build-course" }) });
  assert.equal(start.status, 202);
  const busy = await json("/api/jobs", { method: "POST", body: JSON.stringify({ kind: "validate" }) });
  assert.equal(busy.status, 409);
  const upload = await json(`/api/inputs/docx?filename=s.docx`, { method: "PUT", body: "PK\x03\x04" });
  assert.equal(upload.status, 409);

  const done = await waitForJob(start.body.job.id);
  assert.equal(done.job.status, "succeeded");
  assert.equal(done.job.courseSlug, SLUG);
  assert.equal(done.job.progress.percent, 100);
  assert.ok(done.job.progress.stages.every((s: any) => s.status === "done"));
  assert.match(done.job.summary, /COURSE BUILD COMPLETE/);
  assert.ok(done.lines.includes("[6/10] audio_generated"));

  const tail = await json(`/api/jobs/${start.body.job.id}?after=${done.nextLine - 1}`);
  assert.equal(tail.body.lines.length, 1);

  const { body } = await json("/api/activity");
  assert.equal(body.activity[0].id, start.body.job.id);
  assert.ok(body.activity.some((a: any) => a.kind === "upload"));
});

test("failed job surfaces the CLI's readable error", async () => {
  const start = await json("/api/jobs", { method: "POST", body: JSON.stringify({ kind: "validate" }) });
  const done = await waitForJob(start.body.job.id);
  assert.equal(done.job.status, "failed");
  assert.equal(done.job.error, "Input folder problem.");
});

test("job requests are validated", async () => {
  assert.equal((await json("/api/jobs", { method: "POST", body: JSON.stringify({ kind: "rm -rf" }) })).status, 400);
  assert.equal((await json("/api/jobs", { method: "POST", body: JSON.stringify({ kind: "preview-tts", slides: "1; calc" }) })).status, 400);
  assert.equal((await json("/api/jobs", { method: "POST", body: "{" })).status, 400);
});

test("static UI is served and dotfiles are not", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  await res.text();
  const env = await fetch(`${base}/.env`);
  assert.equal(env.status, 404);
  await env.text();
});

test("safeUploadName keeps names readable and Windows-safe", () => {
  assert.equal(safeUploadName("C:\\fakepath\\My Deck.pptx", ".pptx"), "My Deck.pptx");
  assert.equal(safeUploadName("~$lock.pptx", ".pptx"), "lock.pptx");
  assert.equal(safeUploadName('a<b>:"c".docx', ".docx"), "a_b___c_.docx");
  assert.equal(safeUploadName("CON.pptx", ".pptx"), "_CON.pptx");
});
