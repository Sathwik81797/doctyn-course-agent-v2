import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import { run, toForwardSlashes } from "../utils/exec.js";
import { ensureDir, formatDuration } from "../utils/files.js";
import { requireTool } from "../utils/tools.js";

export interface MediaInfo {
  durationSeconds: number;
  video: { codec: string; width: number; height: number; pixFmt: string } | undefined;
  audio: { codec: string; sampleRate: number; channels: number } | undefined;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    sample_rate?: string;
    channels?: number;
  }>;
}

/** Exact container duration and stream details via ffprobe. */
export async function probeMedia(file: string, config: Config): Promise<MediaInfo> {
  const ffprobe = requireTool("ffprobe", config);
  const { stdout } = await run(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,sample_rate,channels", "-of", "json", file],
    { label: "ffprobe", timeoutMs: 60_000 },
  );
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new PipelineError(`ffprobe returned unreadable output for:\n${file}`);
  }
  const durationSeconds = Number(parsed.format?.duration);
  const v = parsed.streams?.find((s) => s.codec_type === "video");
  const a = parsed.streams?.find((s) => s.codec_type === "audio");
  return {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    video: v ? { codec: v.codec_name ?? "", width: v.width ?? 0, height: v.height ?? 0, pixFmt: v.pix_fmt ?? "" } : undefined,
    audio: a ? { codec: a.codec_name ?? "", sampleRate: Number(a.sample_rate ?? 0), channels: a.channels ?? 0 } : undefined,
  };
}

/** Exact duration in seconds; throws a readable error if the file has none. */
export async function probeDuration(file: string, config: Config): Promise<number> {
  const info = await probeMedia(file, config);
  if (!(info.durationSeconds > 0)) {
    throw new PipelineError(
      `ffprobe could not measure a duration for:\n${file}`,
      "The file is probably empty or corrupt. Delete it and run the build again to regenerate it.",
    );
  }
  return info.durationSeconds;
}

/** Round a duration up to a whole number of video frames so audio and video lengths agree. */
export function frameAlignedDuration(seconds: number, fps: number): number {
  return Math.ceil(seconds * fps - 1e-6) / fps;
}

export function segmentDuration(audioSeconds: number, config: Config): number {
  return frameAlignedDuration(config.video.leadInSeconds + audioSeconds + config.video.tailSeconds, config.video.fps);
}

/**
 * One still slide + its narration -> H.264/AAC MP4. The image stays on screen for
 * lead-in + full narration + tail; audio is delayed by the lead-in and padded with silence.
 */
export async function createSegment(opts: {
  image: string;
  audio: string;
  out: string;
  audioSeconds: number;
  config: Config;
}): Promise<number> {
  const { config } = opts;
  const { width: W, height: H, fps, padColor } = config.video;
  const total = segmentDuration(opts.audioSeconds, config);
  const leadMs = Math.round(config.video.leadInSeconds * 1000);
  const ffmpeg = requireTool("ffmpeg", config);
  const partial = opts.out.replace(/\.mp4$/i, ".partial.mp4");
  await ensureDir(path.dirname(opts.out));

  const filter =
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x${padColor.slice(1)},setsar=1,format=yuv420p[v];` +
    `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `adelay=${leadMs}:all=1,apad[a]`;

  await run(
    ffmpeg,
    [
      "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
      "-loop", "1", "-framerate", String(fps), "-i", opts.image,
      "-i", opts.audio,
      "-filter_complex", filter,
      "-map", "[v]", "-map", "[a]",
      "-t", total.toFixed(6),
      "-r", String(fps),
      "-c:v", "libx264", "-preset", "medium", "-tune", "stillimage", "-crf", "18",
      "-pix_fmt", "yuv420p", "-g", String(fps * 2),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart",
      partial,
    ],
    { label: "FFmpeg (slide segment)", timeoutMs: 30 * 60_000 },
  );
  await fs.rename(partial, opts.out);
  return total;
}

function concatListLine(file: string): string {
  // concat demuxer syntax: file '<path>' with single quotes escaped as '\''
  return `file '${toForwardSlashes(file).replace(/'/g, "'\\''")}'`;
}

/** Concatenate segments in the given order and re-encode to the final learner MP4. */
export async function concatSegments(opts: {
  segments: string[];
  out: string;
  workDir: string;
  expectedSeconds: number;
  config: Config;
}): Promise<void> {
  const { config } = opts;
  const ffmpeg = requireTool("ffmpeg", config);
  await ensureDir(opts.workDir);
  const listFile = path.join(opts.workDir, "concat-list.txt");
  await fs.writeFile(listFile, opts.segments.map(concatListLine).join("\n") + "\n", "utf8");
  const partial = opts.out.replace(/\.mp4$/i, ".partial.mp4");

  let lastPrint = 0;
  const onStdout = (chunk: string) => {
    const m = /out_time_us=(\d+)/.exec(chunk) ?? /out_time_ms=(\d+)/.exec(chunk);
    if (!m) return;
    const done = Number(m[1]) / 1e6;
    const now = Date.now();
    if (now - lastPrint < 5000 || opts.expectedSeconds <= 0) return;
    lastPrint = now;
    const pct = Math.min(100, (done / opts.expectedSeconds) * 100);
    console.log(`    encoding final video: ${pct.toFixed(0)}% (${formatDuration(done)} of ${formatDuration(opts.expectedSeconds)})`);
  };

  await run(
    ffmpeg,
    [
      "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
      "-progress", "pipe:1", "-nostats",
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "libx264", "-preset", "medium", "-tune", "stillimage", "-crf", "18",
      "-pix_fmt", "yuv420p", "-r", String(config.video.fps), "-g", String(config.video.fps * 2),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-af", "aresample=async=1:first_pts=0",
      "-movflags", "+faststart",
      partial,
    ],
    { label: "FFmpeg (final video)", onStdout },
  );
  await fs.rename(partial, opts.out);
}
