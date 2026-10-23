/**
 * Verification of a rendered animated course video against its plan: total duration, stream
 * format, audible narration in every slide window, and topic-specific animation coverage.
 */
import { probeMedia } from "../services/video.js";
import type { Config } from "../utils/config.js";
import { run } from "../utils/exec.js";
import { formatDuration, pad3 } from "../utils/files.js";
import { requireTool } from "../utils/tools.js";
import { reviewSummary } from "./store.js";
import type { CoursePlan } from "./types.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Mean volume (dB) of a time window of the audio track, or null if it cannot be measured. */
async function meanVolume(file: string, start: number, length: number, config: Config): Promise<number | null> {
  const ffmpeg = requireTool("ffmpeg", config);
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-nostdin", "-ss", start.toFixed(3), "-t", length.toFixed(3), "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { label: "FFmpeg", timeoutMs: 120_000 });
  const m = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(stderr);
  if (!m) return null;
  return m[1] === "-inf" ? -120 : Number(m[1]);
}

export async function verifyVideo(file: string, plan: CoursePlan, config: Config): Promise<Check[]> {
  const checks: Check[] = [];
  const info = await probeMedia(file, config);
  const expected = plan.slides.reduce((a, s) => a + s.durationSeconds, 0);
  checks.push({
    name: "Duration matches the narrated slide timings",
    ok: info.durationSeconds > 0 && Math.abs(info.durationSeconds - expected) <= 1.5,
    detail: `video ${formatDuration(info.durationSeconds)} (${info.durationSeconds.toFixed(2)} s) vs plan ${expected.toFixed(2)} s`,
  });
  const v = info.video;
  checks.push({
    name: "Video is 1920x1080 H.264 yuv420p",
    ok: !!v && v.width === 1920 && v.height === 1080 && v.codec === "h264" && v.pixFmt === "yuv420p",
    detail: v ? `${v.width}x${v.height} ${v.codec} ${v.pixFmt}` : "no video stream",
  });
  const a = info.audio;
  checks.push({ name: "Audio track present (AAC)", ok: !!a && a.codec === "aac", detail: a ? `${a.codec} ${a.sampleRate} Hz, ${a.channels} ch` : "no audio stream" });

  const silent: number[] = [];
  let t = 0;
  for (const s of plan.slides) {
    const vol = a ? await meanVolume(file, t + 0.4, Math.max(0.5, s.durationSeconds - 1.2), config) : null;
    if (vol === null || vol < -55) silent.push(s.slide);
    t += s.durationSeconds;
  }
  checks.push({
    name: "Narration is audible in every slide window",
    ok: silent.length === 0,
    detail: silent.length ? `silent or unmeasurable: slides ${silent.map(pad3).join(", ")}` : `${plan.slides.length}/${plan.slides.length} slide windows have audio`,
  });

  const generic = plan.slides.filter((s) => s.template === "key-points");
  checks.push({
    name: "Every slide has a topic-specific animation",
    ok: generic.length === 0,
    detail: generic.length ? `${plan.slides.length - generic.length}/${plan.slides.length}; generic key-points on slides ${generic.map((s) => pad3(s.slide)).join(", ")}` : `${plan.slides.length}/${plan.slides.length} slides`,
  });
  const noEvents = plan.slides.filter((s) => s.events.length === 0);
  checks.push({
    name: "Every slide has narration-timed animation events",
    ok: noEvents.length === 0,
    detail: noEvents.length ? `no events on slides ${noEvents.map((s) => pad3(s.slide)).join(", ")}` : `${plan.slides.reduce((n, s) => n + s.events.length, 0)} events across ${plan.slides.length} slides`,
  });
  const r = reviewSummary(plan);
  checks.push({
    name: "Clinical approval status (informational)",
    ok: true,
    detail: `${r.approved}/${r.total} slides approved` + (r.approved < r.total ? " — video is a DRAFT until all are approved" : ""),
  });
  return checks;
}
