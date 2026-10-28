/**
 * PREVIEW_URL=https://<preview>.vercel.app npm run preview:check
 *
 * Tests a deployed Preview of the website end to end against the real Neon database and private Blob store it uses, with the
 * rendering engine of this PC (LibreOffice, Kokoro voice, FFmpeg, V2 animations) running inside this script:
 *   health -> dashboard files -> privacy of the migrated diabetes course -> a throw-away account signs in -> uploads a PPTX + DOCX
 *   straight to Blob -> validation -> edit -> voiceover + enhanced animation -> Generated Videos -> playback and download -> privacy.
 * It never signs in as a real user and never changes the migrated account or course. Everything it creates (account, course,
 * Blob files) is deleted at the end. It prints no secrets.
 */
import "./utils/config.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getContext } from "../cloud/context.js";
import { LIBRARY_VIDEOS } from "../cloud/library-catalog.js";
import { LIBRARY_KEY_PREFIX } from "../cloud/storage-blob.js";
import { loadConfig } from "./utils/config.js";
import { formatError } from "./utils/errors.js";
import { requireTool } from "./utils/tools.js";
import { buildVoiceoverDocx } from "./worker/docx-builder.js";
import { runWorker } from "./worker/loop.js";

const base = (process.env.PREVIEW_URL ?? "").replace(/\/+$/, "");
if (!/^https:\/\/[a-z0-9.-]+\.vercel\.app$/.test(base)) throw new Error("Set PREVIEW_URL to the Preview deployment URL (https://….vercel.app).");
if (process.env.PREVIEW_URL === "https://doctyn-course-agent-v2.vercel.app") throw new Error("That is the Production URL; this check is for Preview deployments only.");

const ctx = await getContext();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-preview-"));
const ffprobe = requireTool("ffprobe", loadConfig());
const probe = (file: string): number => Number(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const results: Array<[boolean, string]> = [];
const check = (cond: unknown, what: string): void => {
  results.push([Boolean(cond), what]);
  console.log(`  ${cond ? "ok" : "FAIL"}: ${what}`);
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
};

const ac = new AbortController();
process.env.TEMP_DIR ??= path.join(tmp, "temp");
const worker = runWorker(ctx, { workRoot: path.join(tmp, "work"), pollMs: 800, signal: ac.signal, log: (m) => console.log(`  engine: ${m}`), info: { tts: process.env.TTS_PROVIDER ?? "kokoro" } });

let cookie = "";
/** Vercel only routes single-segment paths under /api/v3 to the function, so (like the dashboard) call /api/v3/route?p=<path>. */
function viaRoute(p: string): string {
  const [pathname = "", query] = p.split("?");
  const rest = pathname.replace(/^\/api\/v3\//, "");
  if (!pathname.startsWith("/api/v3/") || rest === "route" || rest === "health") return p;
  return `/api/v3/route?p=${rest}${query ? `&${query}` : ""}`;
}
async function http(method: string, p: string, body?: unknown, as = cookie, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(base + viaRoute(p), {
        method,
        redirect: "manual",
        headers: { "x-requested-with": "doctyn", origin: base, ...(as ? { cookie: as } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...init,
      });
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(500 * attempt);
    }
  }
}
async function api(method: string, p: string, body?: unknown, as = cookie): Promise<any> {
  const res = await http(method, p, body, as);
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  if (res.status >= 400) throw Object.assign(new Error(`${method} ${p} -> ${res.status} ${typeof json === "string" ? json.slice(0, 200) : JSON.stringify(json).slice(0, 300)}`), { status: res.status });
  json.__cookie = res.headers.get("set-cookie");
  return json;
}
async function waitFor(id: string, want: string[], timeoutMs = 30 * 60_000): Promise<any> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const { course } = await api("GET", `/api/v3/courses/${id}`);
    const j = course.job;
    const line = `${course.status}${j ? ` ${j.kind} ${j.status} ${Math.round(j.progress?.percent ?? 0)}% ${j.progress?.detail ?? ""}` : ""}`;
    if (line !== last) console.log(`  course: ${line}`);
    last = line;
    if (j?.status === "failed" || j?.status === "cancelled") throw new Error(`Job ${j.kind} ${j.status}: ${j.error}`);
    if (want.includes(course.status) && (!j || j.status === "succeeded")) return course;
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for ${want.join("/")}`);
}
async function download(p: string, dest: string): Promise<number> {
  const r = await http("GET", p);
  if (r.status !== 302) throw new Error(`${p} did not redirect to a signed link (HTTP ${r.status})`);
  const loc = r.headers.get("location")!;
  const file = await fetch(loc);
  if (!file.ok) throw new Error(`signed link answered ${file.status}`);
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf.length;
}

const email = `preview-check-${randomBytes(4).toString("hex")}@example.com`;
const other = `preview-check-${randomBytes(4).toString("hex")}@example.com`;
const password = randomBytes(12).toString("base64url") + "-Aa1";
let courseId = "";
const created: string[] = [];

try {
  console.log(`Preview check: ${base}`);

  console.log("1. the deployment");
  const health = await (await http("GET", "/api/v3/health", undefined, "")).json() as any;
  check(health.ok && health.db === "pg" && health.storage === "blob", "full mode on Neon Postgres + private Vercel Blob");
  check(health.registration === "approval", "new accounts need approval");
  const meta = await (await http("GET", "/api/v3/route?p=meta", undefined, "")).json() as any;
  check(meta.libraryMode !== true && meta.maxUploadBytes > 0 && meta.animationTemplates.includes("workflow"), "the dashboard API offers uploads and the V2 animation templates");
  const page = await fetch(`${base}/`);
  const html = await page.text();
  check(page.ok && /Doctyn/i.test(html) && /app\.js/.test(html) && /scene\.js/.test(html), "the single dashboard page is served");
  check((await fetch(`${base}/scene.js`)).ok, "the animation preview bundle is served");

  console.log("2. the migrated diabetes course (account and video are not touched)");
  const owner = (await ctx.db.query("SELECT c.id, c.status, c.slide_count, c.outputs FROM courses c JOIN users u ON u.id = c.owner_id WHERE u.email = 'sathwik.ind@gmail.com' AND c.deleted_at IS NULL")).rows;
  check(owner.length === 1, "exactly one diabetes course exists for the owner (no duplicate)");
  const dia = owner[0];
  check(dia.status === "complete" && dia.slide_count === 52 && dia.outputs.animated?.draft === true, "52 slides, complete, enhanced video still a DRAFT");
  const lib = LIBRARY_VIDEOS[0]!.files.animated!;
  check(dia.outputs.animated.key === `${LIBRARY_KEY_PREFIX}${lib.pathname}`, "its enhanced video is the original library object (no second copy)");
  const signed = await ctx.storage.presignGet(dia.outputs.animated.key, {});
  const slice = await fetch(signed, { headers: { range: "bytes=0-4095" } });
  check(slice.status === 206 && slice.headers.get("content-range")?.endsWith(`/${lib.bytes}`), `the video streams from private Blob (${lib.bytes} bytes)`);
  check((await fetch(signed.split("?")[0]!)).status === 403, "without its signed link the video is refused");
  check((await http("GET", "/api/v3/courses", undefined, "")).status === 401, "signed out, the course list needs a sign-in");
  check((await http("GET", `/api/v3/courses/${dia.id}/files/animated`, undefined, "")).status === 401, "signed out, the video needs a sign-in");

  console.log("3. sign-in with a throw-away account (approval workflow)");
  for (const e of [email, other]) {
    const reg = await http("POST", "/api/v3/auth/register", { email: e, name: "Preview Check", password }, "");
    check(reg.status === 201, `registration works (${e.split("@")[0]})`);
    created.push(e);
  }
  const before = await http("POST", "/api/v3/auth/login", { email, password }, "");
  check(before.status === 403 || before.status === 401, "an unapproved account cannot sign in");
  await ctx.db.query("UPDATE users SET status = 'active' WHERE email = ANY($1::text[])", [created]);
  const login = await http("POST", "/api/v3/auth/login", { email, password }, "");
  check(login.status === 200, "after approval the account signs in");
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const otherLogin = await http("POST", "/api/v3/auth/login", { email: other, password }, "");
  const otherCookie = otherLogin.headers.get("set-cookie")!.split(";")[0]!;
  check((await api("GET", "/api/v3/auth/me")).user.email === email, "the session identifies the account");
  check((await api("GET", "/api/v3/courses")).courses.length === 0, "a new account starts with an empty library");
  check((await http("GET", `/api/v3/courses/${dia.id}`)).status === 404, "another account cannot open the migrated diabetes course");
  check((await http("GET", `/api/v3/courses/${dia.id}/files/animated`)).status === 404, "…nor play its video");

  console.log("4. upload a new PPTX + DOCX (browser -> Blob direct)");
  const slides = [
    { slide: 1, title: "Hypertension Overview", narration: "Welcome to this short module on hypertension. We will cover how it develops and how it is measured." },
    { slide: 2, title: "How Hypertension Damages the Heart", narration: "Persistent high blood pressure leads to left ventricular hypertrophy, which causes diastolic dysfunction and eventually heart failure. Remember that control reduces this risk." },
    { slide: 3, title: "Measuring Blood Pressure", narration: "First, rest the patient for five minutes. Next, use a validated cuff of the correct size. If the reading is high, repeat it. Finally, record the result." },
  ];
  const mod = await import("pptxgenjs");
  const Pptx = (mod.default.default ?? mod.default) as unknown as typeof mod.default.default;
  const deck = new Pptx();
  for (const s of slides) {
    const sl = deck.addSlide();
    sl.addText(s.title, { x: 0.6, y: 0.5, w: 8.8, h: 1, fontSize: 30, bold: true });
    sl.addText(s.narration.split(/(?<=\.)\s/).map((t) => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.8, y: 1.8, w: 8.4, h: 3.5, fontSize: 18 });
  }
  const pptxFile = path.join(tmp, "hypertension.pptx");
  await deck.writeFile({ fileName: pptxFile });
  const docxFile = path.join(tmp, "hypertension-voiceover.docx");
  await fs.writeFile(docxFile, await buildVoiceoverDocx("Hypertension", slides));
  courseId = (await api("POST", "/api/v3/courses", { title: "Hypertension (preview check)" })).course.id;
  for (const [type, file] of [["pptx", pptxFile], ["docx", docxFile]] as const) {
    const buf = await fs.readFile(file);
    const up = await api("POST", `/api/v3/courses/${courseId}/upload-url`, { type, filename: path.basename(file), size: buf.length });
    check(!up.url.startsWith(base) && up.key.startsWith("users/"), `${type.toUpperCase()}: the browser is told to upload straight to storage, not through the website`);
    const put = await fetch(up.url, { method: up.method, headers: up.headers, body: buf });
    check(put.ok, `${type.toUpperCase()}: stored in the private Blob store`);
    await api("POST", `/api/v3/courses/${courseId}/files/complete`, { type, key: up.key, filename: path.basename(file) });
  }
  check((await http("POST", `/api/v3/courses/${courseId}/upload-url`, { type: "pptx", filename: "x.pptx", size: 10 }, otherCookie)).status === 404, "another account cannot upload into this course");

  console.log("5. validation by the rendering engine, then an edit");
  const parsed = await waitFor(courseId, ["parsed"]);
  check(parsed.slideCount === 3 && parsed.validation?.ok !== false, "3 slides read from the PPTX and matched to 3 narration sections");
  const detail = (await api("GET", `/api/v3/courses/${courseId}`)).course;
  check(detail.slidePreviews === true && detail.animationPlan?.length === 3, "slide previews rendered and an animation plan was prepared");
  check(detail.animationPlan.some((p: any) => p.template !== "key-points") && detail.animationPlan.every((p: any) => p.review.status === "needs_review"), `topic-driven scenes chosen (${detail.animationPlan.map((p: any) => p.template).join(", ")}), all awaiting clinical review`);
  const img = await http("GET", `/api/v3/courses/${courseId}/slides/1/image`);
  check(img.status === 302 || img.status === 200, "a slide image is served for the editor");
  const edited = "Welcome to this short module on hypertension. We will cover how it develops, how it is measured, and why control matters.";
  await api("PATCH", `/api/v3/courses/${courseId}`, { slides: [{ slide: 1, narration: edited }] });

  console.log("6. voiceover (Kokoro), V2 enhanced animation and MP4 generation");
  await api("POST", `/api/v3/courses/${courseId}/build`, {});
  const built = await waitFor(courseId, ["complete"]);
  check(built.available.video && built.available.animated, "narrated MP4 and enhanced animated MP4 were produced");
  check(built.animatedDraft === true, "the enhanced video is a DRAFT until a clinician approves it");
  const log = (await api("GET", `/api/v3/courses/${courseId}`)).course.job;
  check(log?.status === "succeeded", "the generation job finished without errors");

  console.log("7. Generated Videos, playback and download");
  const listed = (await api("GET", "/api/v3/courses")).courses.find((c: any) => c.id === courseId);
  check(listed?.status === "complete" && listed.hasVideo && listed.available.animated && listed.durationSeconds > 0, "the course appears in Generated Videos with both versions");
  const orig = path.join(tmp, "original.mp4");
  const enh = path.join(tmp, "enhanced.mp4");
  const nOrig = await download(`/api/v3/courses/${courseId}/files/video?download=1`, orig);
  const nEnh = await download(`/api/v3/courses/${courseId}/files/animated?download=1`, enh);
  check(nOrig === listed.videoBytes && probe(orig) > 10, `the narrated MP4 downloads completely and plays (${probe(orig).toFixed(1)} s)`);
  check(nEnh > 100_000 && Math.abs(probe(enh) - probe(orig)) < 3, `the enhanced MP4 downloads and plays (${probe(enh).toFixed(1)} s, same length as the narration)`);
  const redirect = (await http("GET", `/api/v3/courses/${courseId}/files/video`)).headers.get("location")!;
  const range = await fetch(redirect, { headers: { range: "bytes=0-1023" } });
  check(range.status === 206, "the video supports seeking (byte ranges)");
  const vtt = await (await http("GET", `/api/v3/courses/${courseId}/files/vtt`)).text();
  const txt = await (await http("GET", `/api/v3/courses/${courseId}/files/transcript`)).text();
  check(/WEBVTT/.test(vtt) && txt.includes("why control matters"), "captions and transcript contain the edited narration");
  check((await http("GET", `/api/v3/courses/${courseId}/files/video`, undefined, otherCookie)).status === 404, "another account cannot play or download it");
  check((await http("GET", `/api/v3/courses/${courseId}/files/video`, undefined, "")).status === 401, "signed out, it cannot be played");
  const unsigned = await fetch(redirect.split("?")[0]!);
  check(unsigned.status === 403, "the storage link does not work without its signature");

  console.log(`\nPREVIEW CHECK PASS (${results.length} checks)`);
} catch (err) {
  console.error(`\nPREVIEW CHECK FAIL: ${formatError(err)}`);
  process.exitCode = 1;
} finally {
  ac.abort();
  await worker;
  try {
    if (courseId) await http("DELETE", `/api/v3/courses/${courseId}`).catch(() => {});
    const ids = (await ctx.db.query("SELECT id FROM users WHERE email = ANY($1::text[])", [[email, other]])).rows.map((r) => r.id as string);
    for (const id of ids) {
      await ctx.storage.removePrefix(`users/${id}/`).catch(() => 0);
      await ctx.db.query("DELETE FROM users WHERE id = $1", [id]);
    }
    const left = (await ctx.db.query("SELECT count(*)::int AS n FROM users WHERE email LIKE 'preview-check-%'")).rows[0].n;
    console.log(`cleanup: ${ids.length} test account(s), their course and Blob files removed; ${left} test account(s) left`);
  } catch (err) {
    console.error(`cleanup problem: ${formatError(err)}`);
  }
  await ctx.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
