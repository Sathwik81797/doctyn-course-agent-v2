import fs from "node:fs/promises";
import path from "node:path";
import { narrationHash, courseKeys } from "../../cloud/util.js";
import { ProgressTracker } from "../server/progress.js";
import { loadCourse, CancelledError, PermanentJobError, runChild, type JobEnv, type WorkerJob } from "./jobs.js";
import { workspace, writeInputs } from "./plan.js";

/**
 * Voice preview: speak the SAVED narration of the chosen slides with the configured voice and store the clips
 * privately, so an edit can be heard before the full video is rendered. The build outputs are not touched.
 */
export async function runPreview(job: WorkerJob, env: JobEnv): Promise<void> {
  const { ctx } = env;
  const course = await loadCourse(ctx, job.course_id);
  const slides: number[] = job.payload?.slides ?? [];
  if (!course.pptx_key || !slides.length) throw new PermanentJobError("Choose at least one slide to preview.");

  const ws = workspace(env.workRoot, course);
  await env.progress({ percent: 3, stage: "prepare", detail: "Preparing…" });
  await writeInputs(env, course, ws);
  await fs.rm(path.join(ws.courseDir, "qa", "tts-preview"), { recursive: true, force: true });

  const tracker = new ProgressTracker("preview-tts");
  const r = await runChild(env, "src/preview-tts.ts", ["--slides", slides.join(",")], ws.childEnv, {
    onLine: (l) => tracker.push(l),
    snapshot: () => tracker.snapshot(),
  });
  tracker.finish(r.code === 0);
  if (r.cancelled) throw new CancelledError();
  if (r.hbError) throw r.hbError;
  if (r.code !== 0) throw new PermanentJobError(tracker.errorMessage ?? `The voice preview failed (exit ${r.code}).`);

  const base = path.join(ws.courseDir, "qa", "tts-preview");
  const labels = await fs.readdir(base);
  const dir = path.join(base, labels[0] ?? "");
  const keys = courseKeys(course.owner_id, course.id);
  const meta: Record<string, { at: string; hash: string; bytes: number }> = {};
  for (const n of slides) {
    const file = path.join(dir, `slide-${String(n).padStart(3, "0")}.mp3`);
    const bytes = await ctx.storage.uploadFromFile(keys.voicePreview(n), file, "audio/mpeg");
    const narration = String((course.slides as Array<{ slide: number; narration: string }>).find((s) => s.slide === n)?.narration ?? "");
    meta[String(n)] = { at: new Date().toISOString(), hash: narrationHash(narration), bytes };
  }
  await ctx.db.query("UPDATE courses SET previews = previews || $2::jsonb WHERE id = $1", [course.id, JSON.stringify(meta)]);
  await fs.rm(base, { recursive: true, force: true });
  await env.progress({ ...tracker.snapshot(), percent: 100, detail: "Preview ready" });
}
