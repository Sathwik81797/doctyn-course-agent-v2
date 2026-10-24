/**
 * MP4 rendering of the animated explainers: SVG frame -> sharp (raw RGB) -> FFmpeg stdin.
 * Output stays inside <course>/animation/. Nothing is uploaded anywhere.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import { ensureDir, exists, pad3, sha256File, writeFileAtomic } from "../utils/files.js";
import { requireTool } from "../utils/tools.js";
import { contentHash } from "./analyzer.js";
import { H, renderFrame, W } from "./scene/core.js";
import { LEAD_IN } from "./scene/timing.js";
import { isApproved } from "./store.js";
import type { CoursePlan, SlidePlan } from "./types.js";

export const DRAFT_WATERMARK = "DRAFT — NOT CLINICALLY APPROVED";

export interface RenderSettings {
  fps: number;
  /** Raster scale: 0.5 renders 960x540 and upscales (fast drafts); 1 renders 1920x1080. */
  scale: number;
  /** Allow slides that are not approved (burns in a DRAFT banner). */
  draft: boolean;
  concurrency?: number;
  log?: (message: string) => void;
}

export function animationPaths(courseRoot: string) {
  const root = path.join(courseRoot, "animation");
  return { root, segments: path.join(root, "segments"), stills: path.join(root, "stills"), demos: path.join(root, "demos") };
}

/** Rasterise one frame to raw RGB at the given scale. */
export async function rasterFrame(slide: SlidePlan, t: number, settings: Pick<RenderSettings, "scale">, watermark?: string): Promise<Buffer> {
  const svg = renderFrame(slide, t, watermark ? { watermark } : {});
  return sharp(Buffer.from(svg), { density: 72 * settings.scale }).removeAlpha().raw().toBuffer();
}

export async function renderStill(slide: SlidePlan, t: number, out: string, scale = 1, watermark?: string): Promise<void> {
  const svg = renderFrame(slide, t, watermark ? { watermark } : {});
  await ensureDir(path.dirname(out));
  await sharp(Buffer.from(svg), { density: 72 * scale }).png().toFile(out);
}

function tailLines(text: string, n = 8): string {
  return text.trimEnd().split(/\r?\n/).slice(-n).join("\n");
}

/** Check that every slide being rendered may be rendered; throws a readable list otherwise. */
export function assertRenderable(slides: SlidePlan[], draft: boolean): void {
  if (draft) return;
  const unapproved = slides.filter((s) => !isApproved(s));
  if (unapproved.length) {
    throw new PipelineError(
      `${unapproved.length} slide(s) are not clinically approved, so the video was not rendered:\n` +
        unapproved.slice(0, 20).map((s) => `  - Slide ${s.slide} (${s.review.status}${s.review.status === "approved" ? ", edited since approval" : ""})`).join("\n"),
      "Approve them in the studio (npm run dashboard, then open /studio/), or render a watermarked preview with --draft.",
    );
  }
  const stale = slides.filter((s) => s.audioStale);
  if (stale.length) {
    throw new PipelineError(
      `Narration was edited after its audio was generated for slide(s): ${stale.map((s) => s.slide).join(", ")}.`,
      "Regenerate the audio (npm run build-course or npm run preview-tts) so the voice matches the edited script, then re-run analyze.",
    );
  }
}

function segmentKey(slide: SlidePlan, settings: RenderSettings, audioStamp: string, watermark: string): string {
  return createHash("sha256").update([contentHash(slide), slide.durationSeconds, settings.fps, settings.scale, audioStamp, watermark].join("|")).digest("hex").slice(0, 16);
}

/** Render one slide's animation (with its narration audio if present) to a 1920x1080 H.264/AAC MP4. */
export async function renderSlideSegment(opts: {
  slide: SlidePlan;
  courseRoot: string;
  out: string;
  config: Config;
  settings: RenderSettings;
}): Promise<{ reused: boolean; seconds: number }> {
  const { slide, settings, config } = opts;
  const audio = path.join(opts.courseRoot, "audio", `slide-${pad3(slide.slide)}.mp3`);
  const useAudio = slide.durationSource === "audio" && !slide.audioStale && (await exists(audio));
  const audioStamp = useAudio ? await sha256File(audio) : "silent";
  const watermark = isApproved(slide) ? "" : DRAFT_WATERMARK;
  const key = segmentKey(slide, settings, audioStamp, watermark);
  const keyFile = `${opts.out}.key`;
  if ((await exists(opts.out)) && (await fs.readFile(keyFile, "utf8").catch(() => "")) === key) return { reused: true, seconds: slide.durationSeconds };

  const ffmpeg = requireTool("ffmpeg", config);
  const total = slide.durationSeconds;
  const frames = Math.ceil(total * settings.fps);
  const rw = Math.round(W * settings.scale);
  const rh = Math.round(H * settings.scale);
  await ensureDir(path.dirname(opts.out));
  const partial = opts.out.replace(/\.mp4$/i, ".partial.mp4");

  const args = [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${rw}x${rh}`, "-framerate", String(settings.fps), "-i", "pipe:0",
    ...(useAudio ? ["-i", audio] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
    "-filter_complex",
    `[0:v]scale=${W}:${H}:flags=bicubic,format=yuv420p[v];` +
      (useAudio
        ? `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${Math.round(LEAD_IN * 1000)}:all=1,apad[a]`
        : `[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a]`),
    "-map", "[v]", "-map", "[a]", "-t", total.toFixed(3),
    "-r", String(settings.fps),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-g", String(settings.fps * 2),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", partial,
  ];

  const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8000)));
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", (e) => reject(new PipelineError(`FFmpeg could not be started (${ffmpeg}): ${e.message}`)));
    child.on("close", (code) => resolve(code ?? -1));
  });
  // A dead FFmpeg makes stdin writes fail with EPIPE; surface FFmpeg's own message instead.
  child.stdin.on("error", () => undefined);

  const conc = Math.max(1, settings.concurrency ?? 4);
  for (let i = 0; i < frames; i += conc) {
    const batch = await Promise.all(Array.from({ length: Math.min(conc, frames - i) }, (_, j) => rasterFrame(slide, (i + j) / settings.fps, settings, watermark)));
    for (const buf of batch) {
      if (!child.stdin.write(buf)) await new Promise<void>((r) => child.stdin.once("drain", () => r()));
    }
  }
  child.stdin.end();
  const code = await exited;
  if (code !== 0) {
    await fs.rm(partial, { force: true });
    throw new PipelineError(`FFmpeg failed while rendering the animation for slide ${slide.slide} (exit ${code}).`, tailLines(stderr));
  }
  await fs.rename(partial, opts.out);
  await writeFileAtomic(keyFile, key);
  return { reused: false, seconds: total };
}

/** Concatenate identical-format segments without re-encoding. */
export async function concatSegments(segments: string[], out: string, workDir: string, config: Config): Promise<void> {
  const ffmpeg = requireTool("ffmpeg", config);
  await ensureDir(workDir);
  await ensureDir(path.dirname(out));
  const list = path.join(workDir, "animation-concat.txt");
  await fs.writeFile(list, segments.map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
  const partial = out.replace(/\.mp4$/i, ".partial.mp4");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", partial], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new PipelineError(`FFmpeg could not join the animated segments (exit ${code}).`, tailLines(err)))));
  });
  await fs.rename(partial, out);
}

/** Render the chosen slides (all by default) and join them into one MP4. */
export async function renderAnimatedVideo(opts: {
  plan: CoursePlan;
  courseRoot: string;
  config: Config;
  settings: RenderSettings;
  slides?: number[];
  out?: string;
  /** Where slide segments are written (default <course>/animation/segments). */
  segmentsDir?: string;
}): Promise<{ file: string; seconds: number; segments: number; reused: number }> {
  const { plan, settings } = opts;
  const chosen = plan.slides.filter((s) => !opts.slides || opts.slides.includes(s.slide)).sort((a, b) => a.slide - b.slide);
  if (chosen.length === 0) throw new PipelineError("No slides matched the selection.");
  assertRenderable(chosen, settings.draft);
  const dirs = animationPaths(opts.courseRoot);
  const files: string[] = [];
  let seconds = 0;
  let reused = 0;
  for (const slide of chosen) {
    const out = path.join(opts.segmentsDir ?? dirs.segments, `slide-${pad3(slide.slide)}.mp4`);
    const t0 = Date.now();
    const r = await renderSlideSegment({ slide, courseRoot: opts.courseRoot, out, config: opts.config, settings });
    if (r.reused) reused++;
    seconds += r.seconds;
    files.push(out);
    settings.log?.(`  slide ${pad3(slide.slide)} ${slide.template.padEnd(14)} ${slide.durationSeconds.toFixed(1)}s ${r.reused ? "(reused)" : `rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`}`);
  }
  const file = opts.out ?? path.join(dirs.root, settings.draft ? "animated-video.draft.mp4" : "animated-video.mp4");
  await concatSegments(files, file, path.join(opts.config.tempDir, plan.slug), opts.config);
  return { file, seconds, segments: files.length, reused };
}
