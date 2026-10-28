/**
 * npm run cloud:demo -- <slides.pptx> <voiceover.docx> [--out output/<folder>]
 *
 * Runs ONE real deck through the whole website pipeline on this PC with nothing mocked (in-process Postgres + disk storage, so
 * nothing is written to Neon or Blob): upload -> validation -> animation planning -> Kokoro voiceover -> narrated MP4 -> enhanced
 * animated MP4 (rendered automatically) -> Generated Videos listing -> playback and download. Then it proves the enhanced video
 * really contains animation: it samples frames inside every slide's time window and measures how much the picture changes,
 * for the enhanced video and for the narrated-slides video (which is static by design), and writes contact sheets of the frames.
 *
 * Output (default output/<deck-name>-demo/): enhanced-animated-draft.mp4, original-narrated-slides.mp4, captions, transcript,
 * animation-plan.json, report.json and frames/ (contact sheets). Voice: TTS_PROVIDER from .env (kokoro).
 */
import "./utils/config.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { cloudConfig } from "../cloud/config.js";
import { createDb } from "../cloud/db.js";
import { handleApi, type Ctx } from "../cloud/routes.js";
import { createStorage } from "../cloud/storage.js";
import { loadConfig, PROJECT_ROOT } from "./utils/config.js";
import { formatError } from "./utils/errors.js";
import { requireTool } from "./utils/tools.js";
import { runWorker } from "./worker/loop.js";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--") && a !== args[args.indexOf("--out") + 1]);
const [pptx, docx] = files;
if (!pptx || !docx) {
  console.error("Usage: npm run cloud:demo -- <slides.pptx> <voiceover.docx> [--out output/<folder>]");
  process.exit(2);
}
const outDir = path.resolve(PROJECT_ROOT, args.includes("--out") ? args[args.indexOf("--out") + 1]! : path.join("output", `${path.basename(pptx, path.extname(pptx)).replace(/[^\w.-]+/g, "-")}-demo`));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-demo-"));
const config = cloudConfig({ STORAGE_DRIVER: "fs", LOCAL_STORAGE_DIR: path.join(tmp, "storage"), LOCAL_DB_DIR: "memory://", APP_SECRET: "d".repeat(40), REGISTRATION_MODE: "open" });
const ctx: Ctx = { config, db: await createDb(config), storage: await createStorage(config) };
const server = http.createServer((req, res) => void handleApi(ctx, req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const ac = new AbortController();
process.env.TEMP_DIR ??= path.join(tmp, "temp");
const worker = runWorker(ctx, { workRoot: path.join(tmp, "work"), pollMs: 500, signal: ac.signal, log: (m) => console.log(`  engine: ${m}`), info: { tts: process.env.TTS_PROVIDER ?? "kokoro" } });
const ffmpeg = requireTool("ffmpeg", loadConfig());
const ffprobe = requireTool("ffprobe", loadConfig());
const probe = (f: string): number => Number(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim());
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let cookie = "";

async function http_(method: string, p: string, body?: unknown): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(base + p, { method, redirect: "manual", headers: { "x-requested-with": "doctyn", cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (err) {
      if (attempt >= 4 || method !== "GET") throw err;
      await sleep(300 * attempt);
    }
  }
}
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await http_(method, p, body);
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  if (res.status >= 400) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}
async function waitFor(id: string, want: string[]): Promise<any> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < 45 * 60_000) {
    const { course } = await api("GET", `/api/v3/courses/${id}`);
    const j = course.job;
    const line = `${course.status}${j ? ` ${j.kind} ${j.status} ${Math.round(j.progress?.percent ?? 0)}% ${j.progress?.detail ?? ""}` : ""}`;
    if (line !== last) console.log(`  course: ${line}`);
    last = line;
    if (j?.status === "failed" || j?.status === "cancelled") throw new Error(`Job ${j.kind} ${j.status}: ${j.error}`);
    if (want.includes(course.status) && (!j || j.status === "succeeded")) return course;
    await sleep(1500);
  }
  throw new Error("Timed out");
}
async function download(p: string, dest: string): Promise<void> {
  const r = await http_("GET", p);
  const loc = r.status === 302 ? new URL(r.headers.get("location")!, base).toString() : null;
  const res = loc ? await fetch(loc) : r;
  if (!res.ok) throw new Error(`${p} -> ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** Grey 160x90 frame at time t (seconds) as raw bytes. */
function frame(video: string, t: number): Buffer {
  return execFileSync(ffmpeg, ["-v", "error", "-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 24 });
}
const meanDiff = (a: Buffer, b: Buffer): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};

try {
  console.log(`Demo: ${path.basename(pptx)} + ${path.basename(docx)}  ->  ${outDir}`);
  await fs.mkdir(path.join(outDir, "frames"), { recursive: true });
  await api("POST", "/api/v3/auth/register", { email: "demo@example.com", name: "Demo", password: "a demo run password" });
  await api("POST", "/api/v3/auth/login", { email: "demo@example.com", password: "a demo run password" });
  const id = (await api("POST", "/api/v3/courses", { title: path.basename(pptx, path.extname(pptx)) })).course.id as string;
  for (const [type, file] of [["pptx", pptx], ["docx", docx]] as const) {
    const buf = await fs.readFile(file);
    const up = await api("POST", `/api/v3/courses/${id}/upload-url`, { type, filename: path.basename(file), size: buf.length });
    const put = await fetch(new URL(up.url, base), { method: "PUT", headers: up.headers, body: buf });
    if (!put.ok) throw new Error(`upload failed (${put.status})`);
    await api("POST", `/api/v3/courses/${id}/files/complete`, { type, key: up.key, filename: path.basename(file) });
  }
  console.log("1. validation + animation planning");
  const parsed = await waitFor(id, ["parsed"]);
  const detail = (await api("GET", `/api/v3/courses/${id}`)).course;
  console.log(`  ${parsed.slideCount} slides; plan: ${detail.animationPlan.map((p: any) => `${p.slide}:${p.template}`).join("  ")}`);
  console.log("2. generate (Kokoro voice -> narrated MP4 -> enhanced animated MP4, automatically)");
  const t0 = Date.now();
  await api("POST", `/api/v3/courses/${id}/build`, {});
  const built = await waitFor(id, ["complete"]);
  console.log(`  finished in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  if (!built.available.video || !built.available.animated) throw new Error("The enhanced animated video was not produced.");

  console.log("3. Generated Videos + download");
  const list = (await api("GET", "/api/v3/courses")).courses.find((c: any) => c.id === id);
  const enh = path.join(outDir, "enhanced-animated-draft.mp4");
  const orig = path.join(outDir, "original-narrated-slides.mp4");
  await download(`/api/v3/courses/${id}/files/animated?download=1`, enh);
  await download(`/api/v3/courses/${id}/files/video?download=1`, orig);
  for (const [k, name] of [["vtt", "captions.vtt"], ["srt", "captions.srt"], ["transcript", "transcript.txt"]] as const) await download(`/api/v3/courses/${id}/files/${k}?download=1`, path.join(outDir, name));
  const final = (await api("GET", `/api/v3/courses/${id}`)).course;
  await fs.writeFile(path.join(outDir, "animation-plan.json"), JSON.stringify(final.animationPlan, null, 2));
  console.log(`  listed: status=${list.status} enhanced=${list.available.animated} draft=${list.animatedDraft} default version=${list.animatedDraft === false ? "approved" : "enhanced animated draft"}; ${probe(enh).toFixed(1)} s enhanced, ${probe(orig).toFixed(1)} s narrated`);

  console.log("4. is it animated? sampling frames inside every slide's time window");
  const plan = final.animationPlan as Array<{ slide: number; title: string; template: string; durationSeconds: number }>;
  let start = 0;
  const rows: Array<{ slide: number; title: string; template: string; enhancedMotion: number; originalMotion: number; animated: boolean }> = [];
  const tiles: Buffer[] = [];
  for (const p of plan) {
    const end = start + p.durationSeconds;
    const times = [0.15, 0.35, 0.55, 0.75, 0.95].map((f) => start + p.durationSeconds * f);
    const motion = (video: string): number => {
      const frames = times.map((t) => frame(video, t));
      const d = frames.slice(1).map((f, i) => meanDiff(frames[i]!, f));
      return d.reduce((a, b) => a + b, 0) / d.length;
    };
    const e = motion(enh);
    const o = motion(orig);
    rows.push({ slide: p.slide, title: p.title, template: p.template, enhancedMotion: Math.round(e * 100) / 100, originalMotion: Math.round(o * 100) / 100, animated: e > 1.0 && e > o * 3 });
    // a frame near the end of the slide's window: the scene built up
    const png = execFileSync(ffmpeg, ["-v", "error", "-ss", (start + p.durationSeconds * 0.85).toFixed(2), "-i", enh, "-frames:v", "1", "-vf", "scale=960:540", "-f", "image2pipe", "-vcodec", "png", "-"], { maxBuffer: 1 << 25 });
    await fs.writeFile(path.join(outDir, "frames", `slide-${String(p.slide).padStart(2, "0")}.png`), png);
    tiles.push(png);
    start = end;
  }
  for (let k = 0; k < tiles.length; k += 4) {
    await fs.writeFile(
      path.join(outDir, "frames", `sheet-${k / 4 + 1}.png`),
      await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#000" } }).composite(tiles.slice(k, k + 4).map((input, j) => ({ input, left: (j % 2) * 960, top: Math.floor(j / 2) * 540 }))).png().toBuffer(),
    );
  }
  console.log("  slide  scene        enhanced-motion  narrated-motion  animated?");
  for (const r of rows) console.log(`  ${String(r.slide).padStart(3)}    ${r.template.padEnd(12)} ${String(r.enhancedMotion).padStart(8)}         ${String(r.originalMotion).padStart(8)}         ${r.animated ? "yes" : "NO"}`);
  const generic = rows.filter((r) => r.template === "key-points").map((r) => r.slide);
  await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify({ deck: path.basename(pptx), slides: plan.length, genericSlides: generic, rows, enhancedSeconds: probe(enh), narratedSeconds: probe(orig), listedAs: { status: list.status, animatedDraft: list.animatedDraft, hasBoth: list.available.video && list.available.animated } }, null, 2));
  const stat = rows.filter((r) => !r.animated);
  console.log(`\nDEMO ${stat.length ? "FINISHED WITH STATIC SLIDES" : "PASS"}: ${rows.length - stat.length}/${rows.length} slides contain on-screen animation; generic key-point slides: ${generic.length ? generic.join(", ") : "none"}`);
  console.log(`Enhanced animated draft: ${enh}`);
  console.log(`Original narrated slides: ${orig}`);
  if (stat.length) process.exitCode = 1;
} catch (err) {
  console.error(`\nDEMO FAIL: ${formatError(err)}`);
  process.exitCode = 1;
} finally {
  ac.abort();
  await worker;
  server.close();
  await ctx.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
