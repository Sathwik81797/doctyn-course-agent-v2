import fs from "node:fs/promises";
import path from "node:path";
import { buildEditedPptx, hasDeckEdits } from "../../cloud/editor/pptx-write.js";
import { applyEdit, loadPlan, savePlan } from "../animation/store.js";
import type { CoursePlan } from "../animation/types.js";
import { ensureDir, exists } from "../utils/files.js";
import { slugify } from "../utils/slug.js";
import { buildVoiceoverDocx } from "./docx-builder.js";
import { CancelledError, PermanentJobError, runChild, syncCacheDown, type JobEnv, type WorkerJob } from "./jobs.js";

export interface Workspace {
  root: string;
  inputDir: string;
  outputDir: string;
  tempDir: string;
  slug: string;
  courseDir: string;
  /** Environment that points the unchanged CLI commands at this course's folders. */
  childEnv: Record<string, string>;
}

/** Per-course working folders. The CLI commands run against these through INPUT_DIR / OUTPUT_DIR / COURSE_SLUG. */
export function workspace(workRoot: string, course: { id: string; title: string }): Workspace {
  const root = path.join(workRoot, course.id);
  const inputDir = path.join(root, "input");
  const outputDir = path.join(root, "output");
  const tempDir = path.join(root, "temp");
  const slug = slugify(course.id);
  return {
    root,
    inputDir,
    outputDir,
    tempDir,
    slug,
    courseDir: path.join(outputDir, slug),
    childEnv: { INPUT_DIR: inputDir, OUTPUT_DIR: outputDir, TEMP_DIR: tempDir, COURSE_SLUG: slug, COURSE_TITLE: course.title },
  };
}

/**
 * The presentation the pipeline must read for this course. When the user reordered, added, deleted or changed slides in the editor,
 * the saved edits are written into a COPY of the uploaded PPTX (the upload itself is never modified), so slide rendering, the animation
 * planner, captions and the final video all see exactly what the editor showed. Untouched courses use the upload as it is.
 */
export async function applyDeckEdits(course: any, pptxPath: string): Promise<boolean> {
  const slides = (course.slides ?? []) as Array<{ origin?: { page: number } | null; edits?: unknown }>;
  const originalPages = Number(course.editor_shapes?.pageCount ?? course.validation?.pptxCount ?? 0) || undefined;
  if (!slides.some((s) => s.origin !== undefined) || !hasDeckEdits(slides as never, originalPages)) return false;
  const edited = await buildEditedPptx(await fs.readFile(pptxPath), slides as never, course.editor_shapes ?? undefined);
  await fs.writeFile(pptxPath, edited);
  return true;
}

/** Put the saved (edited) slides into the input folder as the DOCX the pipeline reads. The user's originals are never touched. */
export async function writeInputs(env: JobEnv, course: any, ws: Workspace, pptxSource?: string): Promise<void> {
  await fs.rm(ws.inputDir, { recursive: true, force: true });
  await Promise.all([ensureDir(ws.inputDir), ensureDir(ws.courseDir), ensureDir(ws.tempDir)]);
  const target = path.join(ws.inputDir, "presentation.pptx");
  if (pptxSource) await fs.copyFile(pptxSource, target);
  else await env.ctx.storage.downloadToFile(course.pptx_key, target);
  // (a PPTX passed in by the caller is the freshly parsed upload: there are no edits to apply yet)
  if (!pptxSource) await applyDeckEdits(course, target);
  await fs.writeFile(path.join(ws.inputDir, "voiceover-script.docx"), await buildVoiceoverDocx(course.title, course.slides));
}

/**
 * Build the animation plan from the SAVED slides and narration, then apply every saved animation edit
 * (type, on-screen text, pop-ups, timings). Analysis is always redone from the current narration so timings and
 * cues follow the edited words; the user's edits are layered on top of it.
 */
export async function preparePlan(env: JobEnv, course: any, ws: Workspace): Promise<{ plan: CoursePlan; warnings: string[] }> {
  // Exact narration durations exist only if the video on record was made from this very text.
  if (course.built_hash && course.built_hash === course.content_hash) {
    await syncCacheDown(env, course.owner_id, course.id, ws.courseDir, ["audio"]).catch(() => 0);
  } else {
    await fs.rm(path.join(ws.courseDir, "audio"), { recursive: true, force: true });
  }

  let tail = "";
  // Optional AI planning (paid, off by default). Any per-slide failure falls back to the deterministic planner.
  const useAi = process.env.ANIMATION_AI === "true" && Boolean(process.env.OPENAI_API_KEY?.trim());
  const r = await runChild(env, "src/animate.ts", ["analyze", "--force", ...(useAi ? ["--ai"] : [])], ws.childEnv, {
    onLine: (l) => (tail = (tail + "\n" + l).slice(-1500)),
    snapshot: () => ({ percent: 5, stage: "plan", detail: "Analysing slides and narration…" }),
  });
  if (r.cancelled) throw new CancelledError();
  if (r.hbError) throw r.hbError;
  if (r.code !== 0) throw new PermanentJobError(`The animation analysis failed (exit ${r.code}).\n${tail}`.trim());

  const plan = await loadPlan(ws.courseDir);
  const warnings: string[] = [];
  for (const [n, edit] of Object.entries((course.animation_edits ?? {}) as Record<string, unknown>)) {
    try {
      applyEdit(plan, Number(n), edit);
    } catch (err) {
      warnings.push(`Animation edit for slide ${n} was skipped: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  // Postgres jsonb reorders object keys, which would change per-slide content hashes; save and reload so the plan
  // is in the exact form the CLI reads.
  await savePlan(ws.courseDir, plan);
  return { plan: await loadPlan(ws.courseDir), warnings };
}

/** Stand-alone "refresh animation plan" job (after narration edits). */
export async function runPlan(job: WorkerJob, env: JobEnv): Promise<void> {
  const course = (await env.ctx.db.query("SELECT * FROM courses WHERE id = $1 AND deleted_at IS NULL", [job.course_id])).rows[0];
  if (!course?.pptx_key || !course.slides?.length) throw new PermanentJobError("There is nothing to analyse yet.");
  const ws = workspace(env.workRoot, course);
  await env.progress({ percent: 5, stage: "plan", detail: "Preparing…" });
  await writeInputs(env, course, ws);
  await storePlan(env, course, ws);
  await env.progress({ percent: 100, stage: "plan", detail: "Animation plan ready" });
}

export async function storePlan(env: JobEnv, course: any, ws: Workspace): Promise<CoursePlan> {
  const { plan, warnings } = await preparePlan(env, course, ws);
  const prev = course.animation ?? {};
  await env.ctx.db.query("UPDATE courses SET animation = $2::jsonb, updated_at = now() WHERE id = $1", [
    course.id,
    JSON.stringify({ planned: true, rendered: Boolean(prev.rendered), draft: prev.draft ?? null, plannedAt: new Date().toISOString(), warnings, slides: plan.slides }),
  ]);
  return plan;
}

export async function hasAudio(ws: Workspace): Promise<boolean> {
  return exists(path.join(ws.courseDir, "audio", "slide-001.mp3"));
}
