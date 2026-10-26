import fs from "node:fs/promises";
import path from "node:path";
import { PipelineError } from "../utils/errors.js";
import { ensureDir, writeFileAtomic } from "../utils/files.js";
import { analyzeSlide, contentHash, reanchor } from "./analyzer.js";
import { estimateSpeechSeconds, slideTotalSeconds } from "./scene/timing.js";
import { CoursePlanSchema, SlideEditSchema, type CoursePlan, type ReviewStatus, type SlidePlan } from "./types.js";

export function animationDir(courseRoot: string): string {
  return path.join(courseRoot, "animation");
}

export function planPath(courseRoot: string): string {
  return path.join(animationDir(courseRoot), "plan.json");
}

export async function loadPlan(courseRoot: string): Promise<CoursePlan> {
  let raw: string;
  try {
    raw = await fs.readFile(planPath(courseRoot), "utf8");
  } catch {
    throw new PipelineError(`No animation plan exists yet at ${planPath(courseRoot)}.`, "Run: npm run animate -- analyze");
  }
  const parsed = CoursePlanSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new PipelineError(
      `The animation plan is not valid: ${planPath(courseRoot)}`,
      parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
    );
  }
  return parsed.data;
}

export async function savePlan(courseRoot: string, plan: CoursePlan): Promise<void> {
  plan.updatedAt = new Date().toISOString();
  await ensureDir(animationDir(courseRoot));
  await writeFileAtomic(planPath(courseRoot), JSON.stringify(plan, null, 2) + "\n");
}

export function getSlide(plan: CoursePlan, n: number): SlidePlan {
  const s = plan.slides.find((x) => x.slide === n);
  if (!s) throw new PipelineError(`Slide ${n} is not in the animation plan (it has ${plan.slides.length} slides).`);
  return s;
}

function clampEvent(max: number) {
  return <T extends { start: number; end: number }>(e: T): T => {
    const start = Math.min(Math.max(0, e.start), Math.max(0, max - 0.1));
    const end = Math.min(Math.max(start + 0.1, e.end), max);
    return { ...e, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 };
  };
}

/** Validate and apply an editor change. Anything that alters content resets an earlier approval. */
export function applyEdit(plan: CoursePlan, n: number, rawEdit: unknown): SlidePlan {
  const parsed = SlideEditSchema.safeParse(rawEdit);
  if (!parsed.success) {
    throw new PipelineError("The edit was rejected.", parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
  }
  const edit = parsed.data;
  const slide = getSlide(plan, n);
  const before = contentHash(slide);

  if (edit.template !== undefined && edit.template !== slide.template) {
    // A different diagram has different elements: rebuild the timeline for it and keep the narration.
    const fresh = analyzeSlide(
      {
        slide: slide.slide,
        title: slide.title,
        narration: edit.narration ?? slide.narration,
        slideText: edit.slideText ?? slide.slideText,
        durationSeconds: slide.durationSeconds,
        durationSource: slide.durationSource,
      },
      { template: edit.template, rationale: "Chosen manually in the studio." },
    );
    Object.assign(slide, { template: fresh.template, rationale: fresh.rationale, params: fresh.params, labels: {}, events: fresh.events, popups: fresh.popups, flags: fresh.flags });
    if (fresh.items) slide.items = fresh.items;
    else delete slide.items;
    if (fresh.analysis) slide.analysis = fresh.analysis;
    else delete slide.analysis;
  }
  if (edit.slideText !== undefined) slide.slideText = edit.slideText;
  if (edit.params !== undefined) slide.params = edit.params;
  if (edit.labels !== undefined) slide.labels = edit.labels;
  if (edit.events !== undefined) slide.events = edit.events.map(clampEvent(slide.durationSeconds));
  if (edit.popups !== undefined) slide.popups = edit.popups.map(clampEvent(slide.durationSeconds));

  if (edit.narration !== undefined && edit.narration !== slide.narration) {
    slide.narration = edit.narration;
    if (slide.durationSource === "audio") {
      // The MP3 on disk no longer matches the text. Keep its duration for timing until audio is regenerated.
      slide.audioStale = true;
    } else {
      slide.durationSeconds = Math.round(slideTotalSeconds(estimateSpeechSeconds(slide.narration)) * 100) / 100;
    }
    reanchor(slide);
  }

  if (contentHash(slide) !== before && slide.review.status !== "draft") {
    slide.review = { ...slide.review, status: "needs_review", updatedAt: new Date().toISOString() };
    delete slide.review.approvedHash;
  }
  return slide;
}

export interface ReviewRequest {
  status: ReviewStatus;
  reviewer?: string | undefined;
  notes?: string | undefined;
  /** Flag ids the reviewer confirms, or "all". */
  acknowledge?: string[] | "all" | undefined;
}

export function setReview(plan: CoursePlan, n: number, req: ReviewRequest): SlidePlan {
  const slide = getSlide(plan, n);
  if (req.status === "approved") {
    if (!req.reviewer?.trim()) {
      throw new PipelineError("Approval needs a reviewer name.", "Enter the clinician's name so the approval is attributable.");
    }
    const ack = req.acknowledge === "all" ? slide.flags.map((f) => f.id) : (req.acknowledge ?? []);
    const open = slide.flags.filter((f) => !f.acknowledged && !ack.includes(f.id));
    if (open.length) {
      throw new PipelineError(
        `Slide ${n} cannot be approved: ${open.length} clinical flag(s) have not been acknowledged.`,
        open.map((f) => `- ${f.text}`).join("\n"),
      );
    }
    for (const f of slide.flags) if (ack.includes(f.id)) f.acknowledged = true;
  } else if (Array.isArray(req.acknowledge)) {
    for (const f of slide.flags) if (req.acknowledge.includes(f.id)) f.acknowledged = true;
  }
  const reviewer = req.reviewer?.trim() || slide.review.reviewer;
  const notes = req.notes ?? slide.review.notes;
  slide.review = {
    status: req.status,
    ...(reviewer ? { reviewer } : {}),
    ...(notes ? { notes } : {}),
    updatedAt: new Date().toISOString(),
    ...(req.status === "approved" ? { approvedHash: contentHash(slide) } : {}),
  };
  return slide;
}

/** A slide counts as approved only if its content is unchanged since approval. */
export function isApproved(slide: SlidePlan): boolean {
  return slide.review.status === "approved" && slide.review.approvedHash === contentHash(slide);
}

export function reviewSummary(plan: CoursePlan): Record<ReviewStatus, number> & { total: number } {
  const out = { draft: 0, needs_review: 0, approved: 0, rejected: 0, total: plan.slides.length };
  for (const s of plan.slides) out[isApproved(s) ? "approved" : s.review.status === "approved" ? "needs_review" : s.review.status]++;
  return out;
}
