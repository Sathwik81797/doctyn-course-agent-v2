/**
 * npm run cloud:e2e
 *
 * Real end-to-end check of the cloud workflow on this machine: API + Postgres (PGlite) + storage (disk)
 * + the worker running LibreOffice, TTS and FFmpeg. Uses a generated 3-slide deck and the TTS provider
 * from .env (set TTS_PROVIDER=windows for a free, offline run). Nothing is mocked.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { cloudConfig } from "../cloud/config.js";
import { createDb } from "../cloud/db.js";
import { handleApi, type Ctx } from "../cloud/routes.js";
import { createStorage } from "../cloud/storage.js";
import { runWorker } from "./worker/loop.js";
import { buildVoiceoverDocx } from "./worker/docx-builder.js";
import { loadConfig } from "./utils/config.js";
import { requireTool } from "./utils/tools.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-e2e-"));
const config = cloudConfig({ STORAGE_DRIVER: "fs", LOCAL_STORAGE_DIR: path.join(tmp, "storage"), LOCAL_DB_DIR: "memory://", APP_SECRET: "e".repeat(40), REGISTRATION_MODE: "open" });
const ctx: Ctx = { config, db: await createDb(config), storage: await createStorage(config) };
const server = http.createServer((req, res) => void handleApi(ctx, req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const ac = new AbortController();
const worker = runWorker(ctx, { workRoot: path.join(tmp, "work"), pollMs: 500, signal: ac.signal, log: (m) => console.log(`  worker: ${m}`) });

let cookie = "";
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(base + p, {
    method,
    redirect: "manual",
    headers: { "x-requested-with": "doctyn", cookie, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  if (res.status === 302) return { status: 302, location: res.headers.get("location") };
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  if (res.status >= 400) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  return json;
}
async function upload(courseId: string, type: "pptx" | "docx", file: string) {
  const buf = await fs.readFile(file);
  const up = await api("POST", `/api/v3/courses/${courseId}/upload-url`, { type, filename: path.basename(file), size: buf.length });
  const put = await fetch(base + up.url, { method: "PUT", headers: up.headers, body: buf });
  if (!put.ok) throw new Error(`storage PUT failed: ${put.status}`);
  return api("POST", `/api/v3/courses/${courseId}/files/complete`, { type, key: up.key, filename: path.basename(file) });
}
async function waitFor(courseId: string, want: string[], timeoutMs = 20 * 60_000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const { course } = await api("GET", `/api/v3/courses/${courseId}`);
    const line = `${course.status}${course.job ? ` ${course.job.status} ${Math.round(course.job.progress?.percent ?? 0)}% ${course.job.progress?.detail ?? ""}` : ""}`;
    if (line !== last) console.log(`  course: ${line}`);
    last = line;
    if (course.status === "failed") throw new Error(`Build failed: ${course.error}`);
    if (course.job?.status === "failed" || course.job?.status === "cancelled") throw new Error(`Job ${course.job.status}: ${course.job.error}`);
    if (want.includes(course.status)) return course;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${want.join("/")}`);
}
function check(cond: unknown, what: string) {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
  console.log(`  ok: ${what}`);
}

try {
  const slides = [
    { slide: 1, title: "Risk Factors for Diabetes", narration: "Welcome to this module on risk factors for diabetes." },
    { slide: 2, title: "Why Assessment Matters", narration: "Early assessment of H b A one C and body mass index helps clinicians act sooner.\n\nIt allows prevention to start before complications develop." },
    { slide: 3, title: "Summary", narration: "In summary, know the risk factors, screen early, and support lifestyle change." },
  ];
  const mod = await import("pptxgenjs");
  const PptxGenJS = (mod.default.default ?? mod.default) as unknown as typeof mod.default.default;
  const deck = new PptxGenJS();
  for (const s of slides) {
    const sl = deck.addSlide();
    sl.addText(s.title, { x: 0.8, y: 1, w: 8.4, h: 1, fontSize: 32, bold: true });
    sl.addText(s.narration.split("\n")[0]!, { x: 0.8, y: 2.4, w: 8.4, h: 1.5, fontSize: 18 });
  }
  const pptx = path.join(tmp, "deck.pptx");
  await deck.writeFile({ fileName: pptx });
  const shortDocx = path.join(tmp, "short.docx");
  await fs.writeFile(shortDocx, await buildVoiceoverDocx("Diabetes", slides.slice(0, 2)));
  const fullDocx = path.join(tmp, "full.docx");
  await fs.writeFile(fullDocx, await buildVoiceoverDocx("Diabetes", slides));

  console.log("1. register + sign in");
  await api("POST", "/api/v3/auth/register", { email: "e2e@example.com", name: "E2E", password: "an end to end password" });
  await api("POST", "/api/v3/auth/login", { email: "e2e@example.com", password: "an end to end password" });

  console.log("2. upload a 3-slide deck with a 2-section script -> must be flagged, not built");
  const { course } = await api("POST", "/api/v3/courses", { title: "Diabetes Risk E2E" });
  await upload(course.id, "pptx", pptx);
  await upload(course.id, "docx", shortDocx);
  const invalid = await waitFor(course.id, ["invalid", "parsed"]);
  check(invalid.status === "invalid", "mismatched counts are reported as invalid");
  check(invalid.slideCount === 3, "PPTX slide count read as 3");
  const detail = (await api("GET", `/api/v3/courses/${course.id}`)).course;
  check(detail.validation.missing.join() === "3", "missing narration for slide 3 identified");
  let blocked = false;
  try { await api("POST", `/api/v3/courses/${course.id}/build`, {}); } catch { blocked = true; }
  check(blocked, "build refused while counts differ");

  console.log("3. fix it in the dashboard (add the missing narration), then build");
  const fixed = await api("PATCH", `/api/v3/courses/${course.id}`, { slides: [{ slide: 3, narration: slides[2]!.narration }] });
  check(fixed.course.status === "parsed", "editing the missing narration makes the course buildable");
  await api("POST", `/api/v3/courses/${course.id}/build`, {});
  const done = await waitFor(course.id, ["complete"]);
  check(done.hasVideo && done.durationSeconds > 0, `video built (${Math.round(done.durationSeconds)}s)`);

  console.log("4. download and verify the artifacts through the API");
  const v = await api("GET", `/api/v3/courses/${course.id}/files/video`);
  check(v.status === 302, "video link redirects to a signed URL");
  const mp4 = path.join(tmp, "out.mp4");
  const vr = await fetch(base + v.location);
  check(vr.ok, "signed video URL downloads");
  await fs.writeFile(mp4, Buffer.from(await vr.arrayBuffer()));
  const ffprobe = requireTool("ffprobe", loadConfig());
  {
    const dur = Number(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], { encoding: "utf8" }).trim());
    check(dur > 3, `downloaded MP4 is playable media (${dur.toFixed(1)}s per ffprobe)`);
  }
  for (const f of ["vtt", "srt", "transcript"]) {
    const r = await fetch(base + `/api/v3/courses/${course.id}/files/${f}`, { headers: { cookie } });
    const text = await r.text();
    check(r.ok && text.length > 20, `${f} downloads (${text.length} bytes)`);
    if (f === "vtt") check(text.startsWith("WEBVTT"), "VTT header present");
    if (f === "transcript") check(/Welcome to this module/.test(text) && /know the risk factors/.test(text), "transcript contains the edited narration");
  }
  const unauth = await fetch(base + `/api/v3/courses/${course.id}/files/video`);
  check(unauth.status === 401, "video is not reachable without signing in");

  console.log("5. publication is gated by clinical review");
  let early = false;
  try { await api("POST", `/api/v3/courses/${course.id}/publish`, {}); } catch { early = true; }
  check(early, "publish refused before review");

  console.log("6. animations stay a watermarked draft until a medical reviewer approves");
  const id = course.id as string;
  await api("POST", `/api/v3/courses/${id}/animate`, {});
  const a1 = await waitFor(id, ["complete"]);
  check(a1.available.animated, "animated video produced");
  const d1 = (await api("GET", `/api/v3/courses/${id}`)).course;
  check(d1.animation?.draft === true, "animated video is a DRAFT before review");
  check(Array.isArray(d1.animationPlan) && d1.animationPlan.length === 3, "animation plan has one entry per slide");

  console.log("7. edit an animation, review, re-render as approved, publish");
  await api("PATCH", `/api/v3/courses/${id}/animation`, { slide: 2, edit: { slideText: ["Edited on-screen text"] } });
  const owner = cookie;
  await api("POST", `/api/v3/courses/${id}/review/request`, {});
  await api("POST", "/api/v3/auth/register", { email: "doc@example.com", name: "Dr Reviewer", password: "a reviewer password" });
  await ctx.db.query("UPDATE users SET role = 'reviewer' WHERE email = 'doc@example.com'");
  cookie = "";
  await api("POST", "/api/v3/auth/login", { email: "doc@example.com", password: "a reviewer password" });
  const queue = await api("GET", "/api/v3/reviews");
  check(queue.courses.length === 1, "reviewer sees the course in the review queue");
  const rv = await api("GET", `/api/v3/reviews/${id}`);
  check(rv.course.slides.length === 3 && rv.course.animationPlan.length === 3, "reviewer can read narration and the animation plan");
  await api("POST", `/api/v3/courses/${id}/review`, { decision: "approved", notes: "Content checked." });
  cookie = owner;
  await api("POST", `/api/v3/courses/${id}/animate`, {});
  const a2 = await waitFor(id, ["complete"]);
  const d2 = (await api("GET", `/api/v3/courses/${id}`)).course;
  check(d2.animation.draft === false, "animated video is final (no watermark) after approval");
  check(d2.animationPlan[1].slideText[0] === "Edited on-screen text", "staged animation edit was applied");
  check(d2.animationPlan.every((p: any) => p.review.status === "approved"), "every slide carries the reviewer's approval");
  check(a2.review.matchesCurrentContent, "review matches current content");
  await api("POST", `/api/v3/courses/${id}/publish`, {});
  check((await api("GET", `/api/v3/courses/${id}`)).course.publishedAt, "course published after approval");

  console.log("\nCLOUD E2E PASS");
} catch (err) {
  console.error("\nCLOUD E2E FAIL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  ac.abort();
  await worker;
  server.close();
  await ctx.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
