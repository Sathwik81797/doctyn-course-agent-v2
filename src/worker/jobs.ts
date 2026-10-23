import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { courseKeys, contentHash, OUTPUT_FILES } from "../../cloud/util.js";
import { heartbeat } from "../../cloud/queue.js";
import type { Ctx } from "../../cloud/routes.js";
import { ProgressTracker } from "../server/progress.js";
import { parseDocx } from "../services/parse-docx.js";
import { parsePptx } from "../services/parse-pptx.js";
import { formatValidationReport, validateMapping } from "../services/validation.js";
import { PROJECT_ROOT } from "../utils/config.js";
import { ensureDir, exists } from "../utils/files.js";
import { slugify } from "../utils/slug.js";
import { buildVoiceoverDocx } from "./docx-builder.js";

export interface WorkerJob {
  id: string;
  course_id: string;
  owner_id: string;
  kind: "parse" | "build" | "animate";
  attempt: number;
  max_attempts: number;
}

/** Thrown for problems that retrying cannot fix (bad file, missing narration). */
export class PermanentJobError extends Error {}
/** The user cancelled the job. */
export class CancelledError extends Error {}

export interface JobEnv {
  ctx: Ctx;
  workerId: string;
  workRoot: string;
  /** Called periodically; throws CancelledError when cancellation was requested. */
  progress: (progress: object, log?: string) => Promise<void>;
}

export async function loadCourse(ctx: Ctx, id: string) {
  const row = (await ctx.db.query("SELECT * FROM courses WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
  if (!row) throw new PermanentJobError("The course was deleted.");
  return row;
}

// ---------------------------------------------------------------- parse

export async function runParse(job: WorkerJob, env: JobEnv): Promise<void> {
  const { ctx } = env;
  const course = await loadCourse(ctx, job.course_id);
  if (!course.pptx_key || !course.docx_key) throw new PermanentJobError("Both a PPTX and a DOCX are needed.");
  await ctx.db.query("UPDATE courses SET status = 'parsing', error = NULL, updated_at = now() WHERE id = $1", [course.id]);

  const dir = path.join(env.workRoot, course.id, "parse");
  await fs.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
  const pptxFile = path.join(dir, "presentation.pptx");
  const docxFile = path.join(dir, "voiceover.docx");
  await ctx.storage.downloadToFile(course.pptx_key, pptxFile);
  await ctx.storage.downloadToFile(course.docx_key, docxFile);
  await env.progress({ percent: 30, stage: "parse", detail: "Reading the presentation and script…" });

  try {
    const pptx = await parsePptx(pptxFile);
    const docx = await parseDocx(docxFile);
    const v = validateMapping(pptx, docx);

    // One editable record per real slide. Narration is taken by slide number; gaps stay empty for the user to fill.
    const byNumber = new Map(v.ordered.map((r) => [r.number, r]));
    const slides = pptx.slides.map((s) => {
      const rec = byNumber.get(s.number) ?? docx.records.find((r) => r.number === s.number);
      return { slide: s.number, title: rec?.title || s.title || `Slide ${s.number}`, narration: rec?.text ?? "", pptxTitle: s.title };
    });
    const emptyNow = slides.filter((s) => !s.narration.trim()).map((s) => s.slide);
    const validation = {
      ok: v.ok,
      pptxCount: v.pptxCount,
      narrationCount: v.narrationCount,
      missing: v.missing,
      duplicates: v.duplicates,
      outOfRange: v.outOfRange,
      emptyNarration: emptyNow,
      malformed: v.malformed,
      warnings: v.warnings,
      report: v.ok ? null : formatValidationReport(v, course.pptx_name ?? "presentation.pptx", course.docx_name ?? "voiceover.docx"),
    };
    const hash = contentHash(course.title, slides);
    await ctx.db.query(
      `UPDATE courses SET status = $2, slide_count = $3, slides = $4::jsonb, validation = $5::jsonb, content_hash = $6,
              error = $7, updated_at = now() WHERE id = $1`,
      [
        course.id,
        v.ok ? "parsed" : "invalid",
        pptx.slideCount,
        JSON.stringify(slides),
        JSON.stringify(validation),
        hash,
        v.ok ? null : `The presentation has ${v.pptxCount} slides but the script has ${v.narrationCount} narration sections. Fix the narration below or upload a corrected script.`,
      ],
    );
  } catch (err) {
    // Unreadable or malformed files are the user's to fix; do not retry.
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db.query("UPDATE courses SET status = 'invalid', error = $2, validation = $3::jsonb, updated_at = now() WHERE id = $1", [
      course.id,
      message.split("\n")[0]?.slice(0, 400) ?? "The files could not be read.",
      JSON.stringify({ ok: false, report: message.slice(0, 4000) }),
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await env.progress({ percent: 100, stage: "parse", detail: "Done" });
}

// ---------------------------------------------------------------- build

/** Files worth keeping between attempts so a crash never re-runs paid or slow TTS. */
const CACHE_DIRS = ["audio", "slides"] as const;

export async function syncCacheUp(env: JobEnv, ownerId: string, courseId: string, courseDir: string): Promise<void> {
  const { storage } = env.ctx;
  const prefix = courseKeys(ownerId, courseId).cache;
  const remote = new Map((await storage.list(prefix)).map((o) => [o.key, o.size]));
  const files: string[] = [];
  for (const d of CACHE_DIRS) {
    for (const name of await fs.readdir(path.join(courseDir, d)).catch(() => [])) files.push(`${d}/${name}`);
  }
  if (await exists(path.join(courseDir, "checkpoint.json"))) files.push("checkpoint.json");
  for (const rel of files) {
    const local = path.join(courseDir, rel);
    const st = await fs.stat(local);
    if (rel === "checkpoint.json" || remote.get(prefix + rel) !== st.size) {
      await storage.uploadFromFile(prefix + rel, local, rel.endsWith(".mp3") ? "audio/mpeg" : rel.endsWith(".png") ? "image/png" : "application/json");
    }
  }
}

export async function syncCacheDown(env: JobEnv, ownerId: string, courseId: string, courseDir: string): Promise<number> {
  const { storage } = env.ctx;
  const prefix = courseKeys(ownerId, courseId).cache;
  let restored = 0;
  for (const o of await storage.list(prefix)) {
    const rel = o.key.slice(prefix.length);
    const local = path.join(courseDir, ...rel.split("/"));
    const st = await fs.stat(local).catch(() => null);
    if (!st || (st.size !== o.size && rel !== "checkpoint.json")) {
      await storage.downloadToFile(o.key, local);
      restored++;
    }
  }
  return restored;
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

interface ChildHooks {
  onLine: (line: string) => void;
  snapshot: () => object;
  preamble?: string;
  /** Called about every 90 s while the child runs. */
  sync?: () => Promise<void>;
}

/** Run one of the project's CLI scripts with heartbeats, log streaming and cancellation. */
export async function runChild(
  env: JobEnv,
  script: string,
  args: string[],
  extraEnv: Record<string, string>,
  hooks: ChildHooks,
): Promise<{ code: number | null; cancelled: boolean; hbError: unknown }> {
  let logBuf = hooks.preamble ?? "";
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), script, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv, FORCE_COLOR: "0", NO_COLOR: "1" },
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onData = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    logBuf += text;
    for (const line of text.split(/\r?\n|\r/)) if (line) hooks.onLine(line);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  let cancelled = false;
  let hbError: unknown = null;
  let lastSync = Date.now();
  const timer = setInterval(() => {
    void (async () => {
      const log = logBuf;
      logBuf = "";
      try {
        await env.progress(hooks.snapshot(), log);
        if (hooks.sync && Date.now() - lastSync > 90_000) {
          lastSync = Date.now();
          await hooks.sync().catch(() => {});
        }
      } catch (err) {
        if (err instanceof CancelledError) cancelled = true;
        else hbError = err;
        killTree(child);
      }
    })();
  }, 3000);
  const code: number | null = await new Promise((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", resolve);
  });
  clearInterval(timer);
  await env.progress(hooks.snapshot(), logBuf).catch(() => {});
  return { code, cancelled, hbError };
}

export const TRANSIENT = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|\b429\b|\b50[0234]\b|rate limit|network/i;

export async function runBuild(job: WorkerJob, env: JobEnv): Promise<void> {
  const { ctx } = env;
  const course = await loadCourse(ctx, job.course_id);
  if (!course.pptx_key) throw new PermanentJobError("The presentation is missing.");
  const slides = course.slides as Array<{ slide: number; title: string; narration: string }>;
  if (!slides.length) throw new PermanentJobError("The course has no slides.");
  const startHash: string = course.content_hash;

  await ctx.db.query("UPDATE courses SET status = 'rendering', error = NULL, updated_at = now() WHERE id = $1", [course.id]);

  const root = path.join(env.workRoot, course.id);
  const inputDir = path.join(root, "input");
  const outputDir = path.join(root, "output");
  const tempDir = path.join(root, "temp");
  const slug = slugify(course.id);
  const courseDir = path.join(outputDir, slug);
  await fs.rm(inputDir, { recursive: true, force: true });
  await Promise.all([ensureDir(inputDir), ensureDir(courseDir), ensureDir(tempDir)]);

  await env.progress({ percent: 1, stage: "prepare", detail: "Fetching your presentation…" });
  await ctx.storage.downloadToFile(course.pptx_key, path.join(inputDir, "presentation.pptx"));
  await fs.writeFile(path.join(inputDir, "voiceover-script.docx"), await buildVoiceoverDocx(course.title, slides));
  const restored = await syncCacheDown(env, course.owner_id, course.id, courseDir).catch(() => 0);

  const tracker = new ProgressTracker("build-course");
  const { code, cancelled, hbError } = await runChild(
    env,
    "src/build-course.ts",
    [],
    { INPUT_DIR: inputDir, OUTPUT_DIR: outputDir, TEMP_DIR: tempDir, COURSE_SLUG: slug, COURSE_TITLE: course.title },
    {
      onLine: (l) => tracker.push(l),
      snapshot: () => tracker.snapshot(),
      preamble: restored ? `Restored ${restored} cached files from an earlier attempt.
` : "",
      sync: () => syncCacheUp(env, course.owner_id, course.id, courseDir),
    },
  );
  tracker.finish(code === 0);

  // Keep finished audio/slides even when this attempt failed, so the retry resumes.
  await syncCacheUp(env, course.owner_id, course.id, courseDir).catch(() => {});

  if (cancelled) throw new CancelledError();
  if (hbError) throw hbError;
  if (code !== 0) {
    const message = tracker.errorMessage ?? `The video build exited with code ${code}.`;
    if (TRANSIENT.test(message)) throw new Error(message);
    throw new PermanentJobError(message);
  }

  // ---- publish results to private storage
  await env.progress({ ...tracker.snapshot(), percent: 98, detail: "Uploading the finished video…" });
  const keys = courseKeys(course.owner_id, course.id);
  const outputs: Record<string, { key: string; bytes: number }> = {};
  const sources: Record<Exclude<keyof typeof OUTPUT_FILES, "animated">, string> = {
    video: path.join(courseDir, "final-video.mp4"),
    thumbnail: path.join(courseDir, "thumbnail.jpg"),
    vtt: path.join(courseDir, "captions.vtt"),
    srt: path.join(courseDir, "captions.srt"),
    transcript: path.join(courseDir, "transcript.txt"),
  };
  for (const [name, file] of Object.entries(sources) as Array<[Exclude<keyof typeof OUTPUT_FILES, "animated">, string]>) {
    if (!(await exists(file))) throw new PermanentJobError(`The build finished but ${path.basename(file)} is missing.`);
    const key = keys.output(OUTPUT_FILES[name].name);
    outputs[name] = { key, bytes: await ctx.storage.uploadFromFile(key, file, OUTPUT_FILES[name].type) };
  }
  const meta = JSON.parse(await fs.readFile(path.join(courseDir, "course.json"), "utf8")) as { durationSeconds?: number };
  const duration = Number(meta.durationSeconds ?? 0);
  if (!(duration > 0)) throw new PermanentJobError("The finished video has no duration.");

  await ctx.db.query(
    `UPDATE courses SET status = 'complete', outputs = $2::jsonb, duration_seconds = $3, built_hash = $4, error = NULL,
            completed_at = now(), updated_at = now() WHERE id = $1`,
    [course.id, JSON.stringify(outputs), duration, startHash],
  );
  // Drop bulky, re-creatable files; audio/slide caches stay for the next edit.
  await Promise.all(["video-segments", "source"].map((d) => fs.rm(path.join(courseDir, d), { recursive: true, force: true })));
  await fs.rm(sources.video, { force: true });
  await env.progress({ ...tracker.snapshot(), percent: 100, detail: "Complete" });
}

/** Mark the course after a job ended without success. */
export async function settleCourseAfterFailure(ctx: Ctx, job: WorkerJob, outcome: "failed" | "cancelled" | "requeued", message: string): Promise<void> {
  if (outcome === "requeued") {
    await ctx.db.query("UPDATE courses SET status = $2, error = $3, updated_at = now() WHERE id = $1", [job.course_id, job.kind === "parse" ? "parsing" : job.kind === "animate" ? "rendering" : "queued", message]);
    return;
  }
  if (outcome === "cancelled") {
    await ctx.db.query(
      `UPDATE courses SET status = CASE WHEN $2 = 'parse' THEN 'uploaded' WHEN outputs ? 'video' THEN 'complete' ELSE 'parsed' END, error = NULL, updated_at = now() WHERE id = $1`,
      [job.course_id, job.kind],
    );
    return;
  }
  await ctx.db.query(
    `UPDATE courses SET status = CASE WHEN $2 = 'parse' THEN 'invalid' WHEN $2 = 'animate' THEN 'complete' ELSE 'failed' END, error = $3, updated_at = now() WHERE id = $1`,
    [job.course_id, job.kind, message.slice(0, 2000)],
  );
}

export async function sendHeartbeat(env: JobEnv, job: WorkerJob, progress?: object, log?: string): Promise<void> {
  const r = await heartbeat(env.ctx.db, job.id, env.workerId, { ...(progress ? { progress } : {}), ...(log ? { log } : {}) });
  if (r.lost) throw new CancelledError("The job was taken away from this worker.");
  if (r.cancel) throw new CancelledError("Cancelled.");
}
