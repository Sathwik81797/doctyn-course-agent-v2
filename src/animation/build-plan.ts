import path from "node:path";
import { loadCourse } from "../services/course.js";
import { probeDuration } from "../services/video.js";
import type { Config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import { exists, pad3 } from "../utils/files.js";
import { analyzeSlide, type AnalysisOverride, type SlideSource } from "./analyzer.js";
import { readSlideTexts } from "./pptx-text.js";
import { estimateSpeechSeconds, slideTotalSeconds } from "./scene/timing.js";
import type { CoursePlan } from "./types.js";

export type AiAnalyzer = (src: SlideSource) => Promise<AnalysisOverride | null>;

/**
 * Build the animation plan for the course in ./input. Reuses V1's loader and validation
 * (read-only): if slide count and narration count differ, no plan is produced.
 * Slide durations come from existing audio (ffprobe) when available, else a word-count estimate.
 */
export async function buildCoursePlan(
  config: Config,
  opts: { ai?: AiAnalyzer; log?: (m: string) => void } = {},
): Promise<{ plan: CoursePlan; courseRoot: string }> {
  const course = await loadCourse(config);
  const v = course.validation;
  if (!v.ok) {
    throw new PipelineError(
      `Slide count (${v.pptxCount}) and voiceover count (${v.narrationCount}) do not match, or the script is malformed.`,
      "Run: npm run validate — and fix the script before creating animations.",
    );
  }
  const texts = await readSlideTexts(course.inputs.pptx, course.pptx.slides.map((s) => s.entry));
  const slides = [];
  for (const rec of v.ordered) {
    const pptxSlide = course.pptx.slides[rec.number - 1]!;
    const audio = path.join(course.paths.audio, `slide-${pad3(rec.number)}.mp3`);
    let durationSeconds: number;
    let durationSource: "audio" | "estimated";
    if (await exists(audio)) {
      durationSeconds = slideTotalSeconds(await probeDuration(audio, config));
      durationSource = "audio";
    } else {
      durationSeconds = slideTotalSeconds(estimateSpeechSeconds(rec.text));
      durationSource = "estimated";
    }
    const src: SlideSource = {
      slide: rec.number,
      title: rec.title || pptxSlide.title,
      narration: rec.text,
      slideText: texts[rec.number - 1] ?? [],
      durationSeconds: Math.round(durationSeconds * 100) / 100,
      durationSource,
    };
    let override: AnalysisOverride | null = null;
    if (opts.ai) {
      try {
        override = await opts.ai(src);
      } catch (err) {
        opts.log?.(`  slide ${rec.number}: AI analysis failed (${(err as Error).message}); using rule-based analysis.`);
      }
    }
    slides.push(analyzeSlide(src, override ?? {}));
  }
  const now = new Date().toISOString();
  return {
    courseRoot: course.paths.root,
    plan: { version: 1, courseTitle: course.identity.title, slug: course.identity.slug, createdAt: now, updatedAt: now, slides },
  };
}
