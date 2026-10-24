/**
 * npm run cloud:e2e
 *
 * Real end-to-end check of the single-dashboard workflow on this machine, with nothing mocked:
 *   upload -> validate -> fix -> edit slide + voiceover + animation -> save -> voice preview -> generate (voice, animations,
 *   FFmpeg) -> verify the saved edits are in the exported MP4/captions -> edit again (only the changed slide is redone)
 *   -> clinical review -> approved render -> publish -> privacy checks.
 * Uses the voice engine from .env (TTS_PROVIDER=kokoro for the real thing, windows for a quick offline run).
 * E2E_REAL=1 uses DATABASE_URL and S3_* (see docker-compose.dev.yml) instead of the in-process database and disk storage.
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
import { loadConfig } from "./utils/config.js";
import { requireTool } from "./utils/tools.js";
import { buildVoiceoverDocx } from "./worker/docx-builder.js";
import { runWorker } from "./worker/loop.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-e2e-"));
const real = process.env.E2E_REAL === "1";
const config = cloudConfig(
  real
    ? { ...process.env, APP_SECRET: "e".repeat(40), REGISTRATION_MODE: "open", NODE_ENV: "development" }
    : { STORAGE_DRIVER: "fs", LOCAL_STORAGE_DIR: path.join(tmp, "storage"), LOCAL_DB_DIR: "memory://", APP_SECRET: "e".repeat(40), REGISTRATION_MODE: "open" },
);
console.log(`mode: ${real ? "REAL services (Postgres + S3)" : "in-process Postgres + disk storage"}; voice: ${process.env.TTS_PROVIDER ?? "(from .env)"}`);
const ctx: Ctx = { config, db: await createDb(config), storage: await createStorage(config) };
const server = http.createServer((req, res) => void handleApi(ctx, req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const ac = new AbortController();
process.env.TEMP_DIR ??= path.join(tmp, "temp");
const worker = runWorker(ctx, { workRoot: path.join(tmp, "work"), pollMs: 500, signal: ac.signal, log: (m) => console.log(`  worker: ${m}`), info: { tts: process.env.TTS_PROVIDER ?? "kokoro" } });

let cookie = "";
async function api(method: string, p: string, body?: unknown, as = cookie): Promise<any> {
  const res = await fetch(base + p, {
    method,
    redirect: "manual",
    headers: { "x-requested-with": "doctyn", cookie: as, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = res.headers.get("set-cookie");
  if (set && as === cookie) cookie = set.split(";")[0]!;
  if (res.status === 302) return { status: 302, location: res.headers.get("location") };
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  if (res.status >= 400) throw Object.assign(new Error(`${method} ${p} -> ${res.status} ${text}`), { status: res.status });
  return json;
}
async function raw(p: string, as = cookie): Promise<Response> {
  return fetch(base + p, { redirect: "manual", headers: { "x-requested-with": "doctyn", cookie: as } });
}
async function upload(courseId: string, type: "pptx" | "docx", file: string) {
  const buf = await fs.readFile(file);
  const up = await api("POST", `/api/v3/courses/${courseId}/upload-url`, { type, filename: path.basename(file), size: buf.length });
  const put = await fetch(base + up.url, { method: "PUT", headers: up.headers, body: buf });
  if (!put.ok) throw new Error(`storage PUT failed: ${put.status}`);
  return api("POST", `/api/v3/courses/${courseId}/files/complete`, { type, key: up.key, filename: path.basename(file) });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the course reaches one of `want` AND its newest job has finished. */
async function waitFor(id: string, want: string[], timeoutMs = 25 * 60_000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const { course } = await api("GET", `/api/v3/courses/${id}`);
    const j = course.job;
    const line = `${course.status}${j ? ` ${j.kind} ${j.status} ${Math.round(j.progress?.percent ?? 0)}% ${j.progress?.detail ?? ""}` : ""}`;
    if (line !== last) console.log(`  course: ${line}`);
    last = line;
    if (j?.status === "failed" || j?.status === "cancelled") throw new Error(`Job ${j.kind} ${j.status}: ${j.error}`);
    if (want.includes(course.status) && (!j || ["succeeded"].includes(j.status))) return course;
    await sleep(800);
  }
  throw new Error(`Timed out waiting for ${want.join("/")}`);
}
async function waitJob(id: string, kind: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60_000) {
    const { course } = await api("GET", `/api/v3/courses/${id}`);
    const j = course.job;
    if (j?.kind === kind && j.status === "succeeded") return course;
    if (j?.kind === kind && ["failed", "cancelled"].includes(j.status)) throw new Error(`${kind} ${j.status}: ${j.error}`);
    await sleep(800);
  }
  throw new Error(`Timed out waiting for ${kind}`);
}
function check(cond: unknown, what: string) {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
  console.log(`  ok: ${what}`);
}
async function download(p: string, file: string, as = cookie) {
  const r = await raw(p, as);
  const url = r.status === 302 ? new URL(r.headers.get("location")!, base).toString() : null;
  const res = url ? await fetch(url) : r;
  if (!res.ok) throw new Error(`download ${p} -> ${res.status}`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
}
const ffprobe = requireTool("ffprobe", loadConfig());
const probe = (file: string) => Number(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
async function jobLog(courseId: string): Promise<string> {
  const { course } = await api("GET", `/api/v3/courses/${courseId}`);
  return (await api("GET", `/api/v3/jobs/${course.job.id}`)).job.log as string;
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
  const pptxBytes = (await fs.stat(pptx)).size;
  const docxBytes = (await fs.stat(shortDocx)).size;

  console.log("1. sign in; the dashboard sees the rendering engine");
  const email = `e2e${Date.now()}@example.com`;
  await api("POST", "/api/v3/auth/register", { email, name: "E2E", password: "an end to end password" });
  await api("POST", "/api/v3/auth/login", { email, password: "an end to end password" });
  let engine = await api("GET", "/api/v3/engine");
  for (let i = 0; i < 10 && !engine.online; i++) { await sleep(500); engine = await api("GET", "/api/v3/engine"); }
  check(engine.online, "engine reported online");

  console.log("2. UPLOAD + VALIDATE: 3-slide deck with a 2-section script must be flagged, not built");
  const { course } = await api("POST", "/api/v3/courses", { title: "Diabetes Risk E2E" });
  const id = course.id as string;
  await upload(id, "pptx", pptx);
  await upload(id, "docx", shortDocx);
  const invalid = await waitFor(id, ["invalid", "parsed"]);
  check(invalid.status === "invalid" && invalid.slideCount === 3, "mismatch reported as invalid with the real slide count (3)");
  const d0 = (await api("GET", `/api/v3/courses/${id}`)).course;
  check(d0.validation.missing.join() === "3", "missing narration for slide 3 identified");
  check(d0.slidePreviews === true, "slide preview images were rendered");
  const img = path.join(tmp, "slide1.jpg");
  await download(`/api/v3/courses/${id}/slides/1/image`, img);
  const head = (await fs.readFile(img)).subarray(0, 2);
  check(head[0] === 0xff && head[1] === 0xd8, "slide preview is a real JPEG");
  check(d0.slides[0].pptxText.some((t: string) => /Risk Factors/.test(t)), "slide text was read from the PPTX");
  let blocked = false;
  try { await api("POST", `/api/v3/courses/${id}/build`, {}); } catch { blocked = true; }
  check(blocked, "build refused while counts differ");

  console.log("3. EDIT: type the missing narration (resolves validation), then prepare animations");
  const fixed = await api("PATCH", `/api/v3/courses/${id}`, { slides: [{ slide: 3, narration: slides[2]!.narration }] });
  check(fixed.course.status === "parsed", "editing the missing narration makes the course buildable");
  check(fixed.course.animationPlan === null, "no animation plan yet");
  await api("POST", `/api/v3/courses/${id}/plan`, {});
  await waitJob(id, "plan");
  const planned = (await api("GET", `/api/v3/courses/${id}`)).course;
  check(planned.animationPlan?.length === 3, "topic animations planned for every slide");
  console.log(`     templates: ${planned.animationPlan.map((p: any) => p.template).join(", ")}`);

  console.log("4. EDIT SLIDE + VOICEOVER + ANIMATION, then SAVE");
  const NEW2 = "Prompt assessment of H b A one C and body mass index helps clinicians act sooner.\n\nIt allows prevention to start before complications develop. Remember the screening pearl.";
  await api("PATCH", `/api/v3/courses/${id}`, { slides: [{ slide: 2, narration: NEW2 }] });
  const events = planned.animationPlan[1].events.map((e: any, i: number) => (i === 0 ? { ...e, start: 0.6, end: 2.4 } : e));
  await api("PATCH", `/api/v3/courses/${id}/animation`, {
    slide: 2,
    edit: {
      slideText: ["Edited overlay line"],
      events,
      popups: [{ id: "custom-e2e", title: "Clinical pearl", text: "Screen early in at-risk patients.", kind: "clinical", start: 1, end: 5, origin: "source" }],
    },
  });
  await api("POST", `/api/v3/courses/${id}/plan`, {});
  await waitJob(id, "plan");
  const edited = (await api("GET", `/api/v3/courses/${id}`)).course;
  const p2 = edited.animationPlan[1];
  check(p2.narration === NEW2, "animation plan follows the EDITED narration");
  check(p2.slideText.join("|") === "Edited overlay line", "overlay text edit applied to the plan");
  check(p2.popups.some((p: any) => p.id === "custom-e2e"), "added medical pop-up is in the plan");
  check(Math.abs(p2.events[0].start - 0.6) < 0.01 && Math.abs(p2.events[0].end - 2.4) < 0.01, "edited animation timing is in the plan");

  console.log("5. PREVIEW the regenerated voiceover of the edited slide");
  await api("POST", `/api/v3/courses/${id}/preview`, { slides: "2" });
  await waitJob(id, "preview");
  const withPreview = (await api("GET", `/api/v3/courses/${id}`)).course;
  check(withPreview.previews["2"] && withPreview.previews["2"].stale === false, "voice preview of slide 2 is current");
  const mp3 = path.join(tmp, "preview2.mp3");
  await download(`/api/v3/courses/${id}/previews/2`, mp3);
  check(probe(mp3) > 3, `preview audio plays (${probe(mp3).toFixed(1)}s)`);

  console.log("6. GENERATE: saved edits -> animations -> voiceover -> FFmpeg -> enhanced MP4");
  await api("POST", `/api/v3/courses/${id}/build`, {});
  const built = await waitFor(id, ["complete"]);
  check(built.available.video && built.available.animated, "original AND enhanced versions exist as separate files");
  const dB = (await api("GET", `/api/v3/courses/${id}`)).course;
  check(built.animatedDraft === true && dB.animation.draft === true, "enhanced version is a DRAFT (no clinical approval yet)");
  check(!built.error, "no warnings from the animation step");
  const log1 = await jobLog(id);
  check(/Generating 3 audio file/.test(log1), "first build recorded all 3 slides");

  console.log("7. PLAY + DOWNLOAD, and verify the exported files contain the saved edits");
  const orig = path.join(tmp, "original.mp4");
  const enh = path.join(tmp, "enhanced.mp4");
  await download(`/api/v3/courses/${id}/files/video?download=1`, orig);
  await download(`/api/v3/courses/${id}/files/animated?download=1`, enh);
  const dOrig = probe(orig);
  const dEnh = probe(enh);
  check(dOrig > 8 && dEnh > 8 && Math.abs(dOrig - dEnh) < 3, `both MP4s play (original ${dOrig.toFixed(1)}s, enhanced ${dEnh.toFixed(1)}s)`);
  const vtt = await (await raw(`/api/v3/courses/${id}/files/vtt`)).text();
  const srt = await (await raw(`/api/v3/courses/${id}/files/srt`)).text();
  const txt = await (await raw(`/api/v3/courses/${id}/files/transcript`)).text();
  check(vtt.startsWith("WEBVTT") && /Prompt assessment/.test(vtt) && !/Early assessment/.test(vtt), "captions (VTT) use the EDITED narration, not the original script");
  check(/Prompt assessment/.test(srt) && /screening pearl/.test(srt), "captions (SRT) contain the edit");
  check(/Prompt assessment/.test(txt) && /screening pearl/.test(txt) && !/Early assessment/.test(txt), "transcript contains the edit only");
  const dEdit = (await api("GET", `/api/v3/courses/${id}`)).course;
  check(dEdit.animationPlan[1].slideText[0] === "Edited overlay line" && dEdit.animationPlan[1].popups.some((p: any) => p.id === "custom-e2e"), "rendered animation plan carries the overlay text and pop-up");

  console.log("8. originals preserved");
  const row = (await ctx.db.query("SELECT pptx_key, docx_key FROM courses WHERE id = $1", [id])).rows[0];
  check((await ctx.storage.head(row.pptx_key))?.size === pptxBytes && (await ctx.storage.head(row.docx_key))?.size === docxBytes, "uploaded PPTX and DOCX are byte-for-byte as uploaded");

  console.log("9. EDIT AGAIN: change only slide 3 -> only slide 3 is re-recorded");
  await api("PATCH", `/api/v3/courses/${id}`, { slides: [{ slide: 3, narration: "In summary, know the risk factors, screen early, and support lasting lifestyle change for every patient." }] });
  await api("POST", `/api/v3/courses/${id}/build`, {});
  await waitFor(id, ["complete"]);
  const log2 = await jobLog(id);
  check(/Generating 1 audio file/.test(log2), "only 1 of 3 audio files was regenerated");
  check(/reused/i.test(log2), "unchanged slides were reused");
  const txt2 = await (await raw(`/api/v3/courses/${id}/files/transcript`)).text();
  check(/lasting lifestyle change for every patient/.test(txt2) && /Prompt assessment/.test(txt2), "new video has both edits");

  console.log("10. CLINICAL REVIEW gates the final version");
  let early = false;
  try { await api("POST", `/api/v3/courses/${id}/publish`, {}); } catch { early = true; }
  check(early, "publish refused before review");
  const owner = cookie;
  await api("POST", `/api/v3/courses/${id}/review/request`, {});
  await api("POST", "/api/v3/auth/register", { email: "doc@example.com", name: "Dr Reviewer", password: "a reviewer password" });
  await ctx.db.query("UPDATE users SET role = 'reviewer' WHERE email = 'doc@example.com'");
  cookie = "";
  await api("POST", "/api/v3/auth/login", { email: "doc@example.com", password: "a reviewer password" });
  const rv = await api("GET", `/api/v3/reviews/${id}`);
  check(rv.course.slides.length === 3 && rv.course.animationPlan.length === 3, "reviewer reads the narration and animation plan");
  await api("POST", `/api/v3/courses/${id}/review`, { decision: "approved", notes: "Content checked." });
  cookie = owner;
  await api("POST", `/api/v3/courses/${id}/animate`, {});
  const finalV = await waitFor(id, ["complete"]);
  check(finalV.animatedDraft === false, "approved render replaced the draft (no watermark)");
  const dF = (await api("GET", `/api/v3/courses/${id}`)).course;
  check(dF.animationPlan.every((p: any) => p.review.status === "approved"), "every slide carries the reviewer's approval");
  await api("POST", `/api/v3/courses/${id}/publish`, {});
  check((await api("GET", `/api/v3/courses/${id}`)).course.publishedAt, "published after approval");

  console.log("11. privacy");
  check((await raw(`/api/v3/courses/${id}/files/animated`, "")).status === 401, "video is not reachable without signing in");
  await api("POST", "/api/v3/auth/register", { email: "other@example.com", name: "Other", password: "another long password" });
  cookie = "";
  await api("POST", "/api/v3/auth/login", { email: "other@example.com", password: "another long password" });
  check((await raw(`/api/v3/courses/${id}/files/video`)).status === 404, "another user cannot open it");
  check((await raw(`/api/v3/courses/${id}/slides/1/image`)).status === 404, "another user cannot see slide previews");

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
