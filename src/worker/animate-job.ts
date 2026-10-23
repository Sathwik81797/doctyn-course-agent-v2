import fs from "node:fs/promises";
import path from "node:path";
import { courseKeys, OUTPUT_FILES } from "../../cloud/util.js";
import { applyEdit } from "../animation/store.js";
import { isApproved, loadPlan, savePlan, setReview } from "../animation/store.js";
import { slugify } from "../utils/slug.js";
import { ensureDir, exists } from "../utils/files.js";
import { buildVoiceoverDocx } from "./docx-builder.js";
import { loadCourse, PermanentJobError, CancelledError, runChild, syncCacheDown, syncCacheUp, TRANSIENT, type JobEnv, type WorkerJob } from "./jobs.js";

/**
 * Animation job: build the per-slide animation plan from the user's slides and narration (rule-based,
 * no paid API), carry over unchanged slides from the previous plan, apply the user's staged edits,
 * apply the clinical reviewer's approval if it covers the current content, and render the animated MP4.
 * Without a matching approval the video is a watermarked DRAFT.
 */
export async function runAnimate(job: WorkerJob, env: JobEnv): Promise<void> {
  const { ctx } = env;
  const course = await loadCourse(ctx, job.course_id);
  if (!course.pptx_key || !course.outputs?.video) throw new PermanentJobError("Generate the narrated video before creating animations.");
  const slides = course.slides as Array<{ slide: number; title: string; narration: string }>;
  await ctx.db.query("UPDATE courses SET status = 'rendering', error = NULL, updated_at = now() WHERE id = $1", [course.id]);

  const root = path.join(env.workRoot, course.id);
  const inputDir = path.join(root, "input");
  const outputDir = path.join(root, "output");
  const tempDir = path.join(root, "temp");
  const slug = slugify(course.id);
  const courseDir = path.join(outputDir, slug);
  await fs.rm(inputDir, { recursive: true, force: true });
  await Promise.all([ensureDir(inputDir), ensureDir(courseDir), ensureDir(tempDir)]);
  await env.progress({ percent: 2, stage: "prepare", detail: "Fetching your files and narration audio…" });
  await ctx.storage.downloadToFile(course.pptx_key, path.join(inputDir, "presentation.pptx"));
  await fs.writeFile(path.join(inputDir, "voiceover-script.docx"), await buildVoiceoverDocx(course.title, slides));
  const restored = await syncCacheDown(env, course.owner_id, course.id, courseDir);
  if (!(await exists(path.join(courseDir, "audio", "slide-001.mp3")))) {
    throw new PermanentJobError("The narration audio is not available. Generate the narrated video again, then create animations.");
  }

  const childEnv = { INPUT_DIR: inputDir, OUTPUT_DIR: outputDir, TEMP_DIR: tempDir, COURSE_SLUG: slug, COURSE_TITLE: course.title };
  let detail = "Analysing slides…";
  let percent = 5;
  const total = slides.length;
  const common = {
    snapshot: () => ({ percent, stage: "animate", detail }),
    sync: () => syncCacheUp(env, course.owner_id, course.id, courseDir),
    preamble: restored ? `Restored ${restored} cached files.\n` : "",
  };
  const fail = (what: string, code: number | null, tail: string) => {
    const message = `${what} (exit ${code}).\n${tail}`.trim();
    return TRANSIENT.test(message) ? new Error(message) : new PermanentJobError(message);
  };

  // ---- 1. analyse
  let tail = "";
  let r = await runChild(env, "src/animate.ts", ["analyze", "--force"], childEnv, { ...common, onLine: (l) => (tail = (tail + "\n" + l).slice(-1500)) });
  if (r.cancelled) throw new CancelledError();
  if (r.hbError) throw r.hbError;
  if (r.code !== 0) throw fail("The animation analysis failed", r.code, tail);

  // ---- 2. merge previous plan, staged edits and the clinician's approval
  let plan = await loadPlan(courseDir);
  const previous = (course.animation?.slides ?? []) as typeof plan.slides;
  plan.slides = plan.slides.map((fresh) => {
    const old = previous.find((p) => p.slide === fresh.slide);
    // Same words on the same slide: keep the user's earlier edits and review state.
    return old && old.narration === fresh.narration && old.title === fresh.title ? { ...old, durationSeconds: fresh.durationSeconds, durationSource: fresh.durationSource, audioStale: false } : fresh;
  });
  const edits = (course.animation_edits ?? {}) as Record<string, unknown>;
  for (const [n, edit] of Object.entries(edits)) {
    try {
      applyEdit(plan, Number(n), edit);
    } catch (err) {
      throw new PermanentJobError(`Your animation edit for slide ${n} was rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Postgres jsonb reorders object keys, which changes the per-slide content hash the approvals are bound to.
  // Saving and reloading puts every slide in the exact form the CLI will read.
  await savePlan(courseDir, plan);
  plan = await loadPlan(courseDir);

  const reviewed = course.review_status === "approved" && course.review_hash === course.content_hash && course.review_by;
  let reviewer = "";
  if (reviewed) {
    reviewer = (await ctx.db.query("SELECT name FROM users WHERE id = $1", [course.review_by])).rows[0]?.name ?? "Medical reviewer";
    for (const s of plan.slides) {
      if (!isApproved(s)) setReview(plan, s.slide, { status: "approved", reviewer, acknowledge: "all", notes: course.review_notes ?? "Approved in the Doctyn clinical review." });
    }
  }
  const draft = !reviewed;
  await savePlan(courseDir, plan);

  // ---- 3. render
  percent = 10;
  detail = draft ? "Rendering animations (watermarked draft: awaiting medical review)…" : "Rendering approved animations…";
  tail = "";
  r = await runChild(env, "src/animate.ts", ["render", "--enhanced", ...(draft ? ["--draft"] : []), "--fps", "24"], childEnv, {
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
  if (r.code !== 0) throw fail("The animation render failed", r.code, tail);

  const file = path.join(courseDir, "animation", "enhanced", draft ? "animated-video.enhanced.draft.mp4" : "animated-video.enhanced.mp4");
  if (!(await exists(file))) throw new PermanentJobError("The animation render finished but produced no video.");
  percent = 97;
  detail = "Uploading the animated video…";
  await env.progress({ percent, stage: "animate", detail });
  const key = courseKeys(course.owner_id, course.id).output(OUTPUT_FILES.animated.name);
  const bytes = await ctx.storage.uploadFromFile(key, file, OUTPUT_FILES.animated.type);
  await ctx.db.query(
    `UPDATE courses SET status = 'complete', error = NULL, outputs = outputs || $2::jsonb, animation = $3::jsonb,
            animation_edits = '{}'::jsonb, updated_at = now() WHERE id = $1`,
    [
      course.id,
      JSON.stringify({ animated: { key, bytes, draft } }),
      JSON.stringify({ builtAt: new Date().toISOString(), draft, reviewer: reviewer || null, slides: plan.slides }),
    ],
  );
  await fs.rm(path.join(courseDir, "animation", "enhanced"), { recursive: true, force: true });
  await env.progress({ percent: 100, stage: "animate", detail: "Complete" });
}
