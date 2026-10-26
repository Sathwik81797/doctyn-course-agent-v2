import fs from "node:fs/promises";
import path from "node:path";
import { enqueue } from "../../cloud/queue.js";
import type { Ctx } from "../../cloud/routes.js";
import { courseKeys, OUTPUT_FILES } from "../../cloud/util.js";
import { exists } from "../utils/files.js";
import { syncCacheUp, type JobEnv } from "./jobs.js";

export interface ImportResult {
  courseId: string;
  created: boolean;
  title: string;
}

const IMPORT_FILES: Array<{ name: keyof typeof OUTPUT_FILES; rel: string }> = [
  { name: "video", rel: "final-video.mp4" },
  { name: "thumbnail", rel: "thumbnail.jpg" },
  { name: "vtt", rel: "captions.vtt" },
  { name: "srt", rel: "captions.srt" },
  { name: "transcript", rel: "transcript.txt" },
];

/**
 * Register a course that was already built by the local pipeline (output/<slug>/) in the dashboard:
 * its original video, captions, transcript, thumbnail and any enhanced animated video become private files of
 * `ownerId`, and its source PPTX/DOCX are re-read so the course can be edited again. Nothing is re-rendered; the
 * finished audio and video segments go into the course cache so a later edit only redoes the slides that changed.
 *
 * The enhanced video keeps its status: a ".draft." file (or any plan with unapproved slides) is imported as an
 * unapproved DRAFT and stays private to the owner.
 */
export async function importCourse(ctx: Ctx, opts: { dir: string; ownerId: string; log?: (m: string) => void; finalize?: boolean }): Promise<ImportResult | null> {
  const log = opts.log ?? (() => {});
  const dir = path.resolve(opts.dir);
  const metaFile = path.join(dir, "course.json");
  if (!(await exists(metaFile))) return null;
  const meta = JSON.parse(await fs.readFile(metaFile, "utf8")) as { courseTitle: string; courseSlug?: string; generatedAt?: string; durationSeconds?: number };
  const importKey = `${meta.courseSlug ?? path.basename(dir)}@${meta.generatedAt ?? "unknown"}`;

  const found = (await ctx.db.query("SELECT id FROM courses WHERE owner_id = $1 AND import_key = $2 AND deleted_at IS NULL", [opts.ownerId, importKey])).rows[0];
  if (found) return { courseId: found.id, created: false, title: meta.courseTitle };

  const pptx = path.join(dir, "presentation.pptx");
  const docx = path.join(dir, "voiceover-script.docx");
  for (const f of [pptx, docx, ...IMPORT_FILES.map((x) => path.join(dir, x.rel))]) {
    if (!(await exists(f))) throw new Error(`Cannot import ${dir}: ${path.basename(f)} is missing.`);
  }

  const row = (await ctx.db.query("INSERT INTO courses(owner_id, title, status, import_key) VALUES ($1,$2,'parsing',$3) RETURNING id", [opts.ownerId, meta.courseTitle, importKey])).rows[0];
  const id: string = row.id;
  const keys = courseKeys(opts.ownerId, id);
  try {
    log(`Importing "${meta.courseTitle}" …`);
    const pptxKey = keys.source("pptx", "import");
    const docxKey = keys.source("docx", "import");
    const pptxBytes = await ctx.storage.uploadFromFile(pptxKey, pptx, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    const docxBytes = await ctx.storage.uploadFromFile(docxKey, docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await ctx.db.query("UPDATE courses SET pptx_key=$2, pptx_name=$3, pptx_bytes=$4, docx_key=$5, docx_name=$6, docx_bytes=$7 WHERE id=$1", [
      id, pptxKey, "presentation.pptx", pptxBytes, docxKey, "voiceover-script.docx", docxBytes,
    ]);

    const outputs: Record<string, { key: string; bytes: number; draft?: boolean }> = {};
    for (const f of IMPORT_FILES) {
      const key = keys.output(OUTPUT_FILES[f.name].name);
      outputs[f.name] = { key, bytes: await ctx.storage.uploadFromFile(key, path.join(dir, f.rel), OUTPUT_FILES[f.name].type) };
      log(`  ${f.rel}`);
    }
    // Enhanced animated video, if one exists. Draft unless its file name says it was rendered after approval.
    const enhanced = path.join(dir, "animation", "enhanced");
    const finalFile = path.join(enhanced, "animated-video.enhanced.mp4");
    const draftFile = path.join(enhanced, "animated-video.enhanced.draft.mp4");
    const animFile = (await exists(finalFile)) ? finalFile : (await exists(draftFile)) ? draftFile : null;
    let animatedDraft: boolean | null = null;
    if (animFile) {
      animatedDraft = animFile === draftFile || (await planHasUnapproved(dir));
      const key = keys.output(OUTPUT_FILES.animated.name);
      outputs.animated = { key, bytes: await ctx.storage.uploadFromFile(key, animFile, OUTPUT_FILES.animated.type), draft: animatedDraft };
      log(`  ${path.relative(dir, animFile)} (${animatedDraft ? "draft" : "final"})`);
    }

    // Finished audio, slide images and segments: later edits reuse everything that did not change.
    log("  caching audio and segments for reuse…");
    await syncCacheUp({ ctx } as JobEnv, opts.ownerId, id, dir);

    const completedAt = meta.generatedAt ?? new Date().toISOString();
    if (opts.finalize) {
      // The videos are already known, so make them playable now instead of when the engine has re-read the sources.
      await ctx.db.query("UPDATE courses SET status = 'complete', outputs = $2::jsonb, duration_seconds = $3, completed_at = $4, updated_at = now() WHERE id = $1", [id, JSON.stringify(outputs), meta.durationSeconds ?? 0, completedAt]);
    }
    // The parse job re-reads the sources (slide text, previews, plan) and then marks the course complete with these outputs.
    await enqueue(ctx.db, {
      courseId: id,
      ownerId: opts.ownerId,
      kind: "parse",
      maxAttempts: ctx.config.jobMaxAttempts,
      payload: { import: { outputs, durationSeconds: meta.durationSeconds ?? 0, completedAt, animatedDraft } },
    });
    log("  queued for validation (no video is regenerated)");
    return { courseId: id, created: true, title: meta.courseTitle };
  } catch (err) {
    await ctx.db.query("DELETE FROM courses WHERE id = $1", [id]);
    await ctx.storage.removePrefix(`${keys.base}/`).catch(() => 0);
    throw err;
  }
}

async function planHasUnapproved(dir: string): Promise<boolean> {
  try {
    const plan = JSON.parse(await fs.readFile(path.join(dir, "animation", "plan.json"), "utf8")) as { slides: Array<{ review?: { status?: string } }> };
    return plan.slides.some((s) => s.review?.status !== "approved");
  } catch {
    return true;
  }
}
