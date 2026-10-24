import fs from "node:fs/promises";
import path from "node:path";
import { courseKeys, OUTPUT_FILES } from "../../cloud/util.js";
import { isApproved, savePlan, setReview } from "../animation/store.js";
import { exists } from "../utils/files.js";
import { loadCourse, PermanentJobError, CancelledError, runChild, syncCacheDown, syncCacheUp, TRANSIENT, type JobEnv, type WorkerJob } from "./jobs.js";
import { hasAudio, preparePlan, workspace, writeInputs } from "./plan.js";

/**
 * Animation job: rebuild the plan from the saved narration (with the user's saved animation edits applied),
 * apply the clinical reviewer's approval if it covers the current content, and render the animated MP4.
 * Without a matching approval the video is a watermarked DRAFT ("enhanced draft").
 */
export async function runAnimate(job: WorkerJob, env: JobEnv): Promise<void> {
  const { ctx } = env;
  const course = await loadCourse(ctx, job.course_id);
  if (!course.pptx_key || !course.outputs?.video) throw new PermanentJobError("Generate the narrated video before creating animations.");
  const total = (course.slides as unknown[]).length;
  await ctx.db.query("UPDATE courses SET status = 'rendering', error = NULL, updated_at = now() WHERE id = $1", [course.id]);

  const ws = workspace(env.workRoot, course);
  await env.progress({ percent: 2, stage: "prepare", detail: "Fetching your files and narration audio…" });
  await writeInputs(env, course, ws);
  const restored = await syncCacheDown(env, course.owner_id, course.id, ws.courseDir);
  if (!(await hasAudio(ws))) throw new PermanentJobError("The narration audio is not available. Generate the narrated video again, then create animations.");

  let detail = "Analysing slides…";
  let percent = 5;
  const common = {
    snapshot: () => ({ percent, stage: "animate", detail }),
    sync: () => syncCacheUp(env, course.owner_id, course.id, ws.courseDir),
    preamble: restored ? `Restored ${restored} cached files.\n` : "",
  };

  // ---- 1. plan = fresh analysis of the saved narration + every saved animation edit
  const { plan, warnings } = await preparePlan(env, course, ws);

  // ---- 2. the clinician's approval, if it covers exactly this content
  const reviewed = Boolean(course.review_status === "approved" && course.review_hash === course.content_hash && course.review_by);
  let reviewer = "";
  if (reviewed) {
    reviewer = (await ctx.db.query("SELECT name FROM users WHERE id = $1", [course.review_by])).rows[0]?.name ?? "Medical reviewer";
    for (const s of plan.slides) {
      if (!isApproved(s)) setReview(plan, s.slide, { status: "approved", reviewer, acknowledge: "all", notes: course.review_notes ?? "Approved in the Doctyn clinical review." });
    }
  }
  const draft = !reviewed;
  await savePlan(ws.courseDir, plan);

  // ---- 3. render
  percent = 10;
  detail = draft ? "Rendering animations (watermarked draft: awaiting medical review)…" : "Rendering approved animations…";
  let tail = "";
  const r = await runChild(env, "src/animate.ts", ["render", "--enhanced", ...(draft ? ["--draft"] : []), "--fps", "24"], ws.childEnv, {
    ...common,
    onLine: (l) => {
      tail = (tail + "\n" + l).slice(-1500);
      const m = /slide (\d+)/.exec(l);
      if (m) {
        percent = Math.min(95, 10 + Math.round((Number(m[1]) / total) * 85));
        detail = `Rendering animation for slide ${Number(m[1])} of ${total}`;
      }
    },
  });
  if (r.cancelled) throw new CancelledError();
  if (r.hbError) throw r.hbError;
  if (r.code !== 0) {
    const message = `The animation render failed (exit ${r.code}).\n${tail}`.trim();
    throw TRANSIENT.test(message) ? new Error(message) : new PermanentJobError(message);
  }

  const file = path.join(ws.courseDir, "animation", "enhanced", draft ? "animated-video.enhanced.draft.mp4" : "animated-video.enhanced.mp4");
  if (!(await exists(file))) throw new PermanentJobError("The animation render finished but produced no video.");
  percent = 97;
  detail = "Uploading the animated video…";
  await env.progress({ percent, stage: "animate", detail });
  const key = courseKeys(course.owner_id, course.id).output(OUTPUT_FILES.animated.name);
  const bytes = await ctx.storage.uploadFromFile(key, file, OUTPUT_FILES.animated.type);
  // animation_edits stay: they are re-applied on every analysis, so they survive narration edits.
  await ctx.db.query(
    `UPDATE courses SET status = 'complete', error = NULL, outputs = outputs || $2::jsonb, animation = $3::jsonb, updated_at = now() WHERE id = $1`,
    [
      course.id,
      JSON.stringify({ animated: { key, bytes, draft } }),
      JSON.stringify({ planned: true, rendered: true, draft, builtAt: new Date().toISOString(), reviewer: reviewer || null, warnings, slides: plan.slides }),
    ],
  );
  // Keep the per-slide animation segments (cached for reuse); drop only the joined video.
  await syncCacheUp(env, course.owner_id, course.id, ws.courseDir).catch(() => {});
  await fs.rm(file, { force: true });
  await env.progress({ percent: 100, stage: "animate", detail: "Complete" });
}
