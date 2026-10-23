/**
 * npm run build-course
 *
 * PPTX + DOCX voiceover -> validated mapping -> per-slide TTS -> LibreOffice slide
 * images -> per-slide H.264/AAC segments -> final-video.mp4 + captions, transcript,
 * thumbnail and course.json. Every stage is checkpointed so re-runs reuse finished work.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { buildCues, toSrt, toTranscript, toVtt, type TimedSlide } from "./services/captions.js";
import { loadCourse, writeValidationFiles, type CoursePaths, type LoadedCourse } from "./services/course.js";
import type { NarrationRecord } from "./services/parse-docx.js";
import { convertPptxToPdf, createThumbnail, rasterizePdf } from "./services/render-slides.js";
import { prepareSpokenText } from "./services/tts.js";
import { createTtsEngine, type TtsEngine } from "./services/tts-engine.js";
import { concatSegments, createSegment, probeDuration, probeMedia } from "./services/video.js";
import { Checkpoint, STAGES } from "./utils/checkpoint.js";
import { loadConfig, type Config } from "./utils/config.js";
import { PipelineError, runMain } from "./utils/errors.js";
import {
  allNonEmpty,
  assertWritableDir,
  copyIfChanged,
  ensureDir,
  exists,
  formatDuration,
  isNonEmptyFile,
  isOfficeTempFile,
  listSlideFiles,
  mapLimit,
  padLabel,
  sha256,
  sha256File,
  slideFile,
  slideNumberOf,
  writeFileAtomic,
} from "./utils/files.js";
import { log } from "./utils/log.js";
import { requireTool } from "./utils/tools.js";

interface SlideState {
  record: NarrationRecord;
  label: string;
  png: string;
  mp3: string;
  segment: string;
  spokenText: string;
  audioKey: string;
  audioSeconds: number;
  segmentKey: string;
  segmentSeconds: number;
}

/** Delete slide-NNN.<ext> files for slide numbers beyond the current deck (left over from an older, longer deck). */
async function removeExtraSlideFiles(dir: string, ext: string, count: number): Promise<void> {
  if (!(await exists(dir))) return;
  for (const name of await fs.readdir(dir)) {
    const n = slideNumberOf(name);
    if (Number.isFinite(n) && name.toLowerCase().endsWith(`.${ext}`) && (n < 1 || n > count)) {
      await fs.rm(path.join(dir, name), { force: true });
    }
  }
  // Also clear interrupted partial outputs.
  for (const name of await fs.readdir(dir)) {
    if (/\.(partial|tmp-\d+)/.test(name)) await fs.rm(path.join(dir, name), { force: true });
  }
}

async function stageInputs(course: LoadedCourse, cp: Checkpoint, hashes: { pptx: string; docx: string }) {
  const { inputs, paths } = course;
  log.stage("input_detected", `${path.basename(inputs.pptx)} + ${path.basename(inputs.docx)}`);
  if (inputs.ignored.length) log.info(`Ignored temporary files: ${inputs.ignored.join(", ")}`);

  await ensureDir(paths.source);
  const keep = new Set([path.basename(inputs.pptx), path.basename(inputs.docx)]);
  for (const name of await fs.readdir(paths.source)) {
    if (!keep.has(name) || isOfficeTempFile(name)) await fs.rm(path.join(paths.source, name), { force: true, recursive: true });
  }
  const sourcePptx = path.join(paths.source, path.basename(inputs.pptx));
  const sourceDocx = path.join(paths.source, path.basename(inputs.docx));
  await copyIfChanged(inputs.pptx, sourcePptx);
  await copyIfChanged(inputs.docx, sourceDocx);
  await copyIfChanged(inputs.pptx, paths.pptxCopy);
  await copyIfChanged(inputs.docx, paths.docxCopy);
  await cp.complete("input_detected", sha256(hashes.pptx, hashes.docx), [sourcePptx, sourceDocx, paths.pptxCopy, paths.docxCopy], {
    pptx: path.basename(inputs.pptx),
    docx: path.basename(inputs.docx),
    pptxSha256: hashes.pptx,
    docxSha256: hashes.docx,
  });
  log.ok("Source files copied to source/, presentation.pptx and voiceover-script.docx");
}

async function stageParsed(course: LoadedCourse, cp: Checkpoint, hashes: { pptx: string; docx: string }) {
  const { pptx, docx } = course;
  log.stage("pptx_parsed");
  await cp.complete("pptx_parsed", hashes.pptx, [], {
    slideCount: pptx.slideCount,
    hiddenSlides: pptx.hiddenSlideNumbers,
  });
  log.ok(`${pptx.slideCount} slides in presentation${pptx.hiddenSlideNumbers.length ? ` (hidden: ${pptx.hiddenSlideNumbers.join(", ")})` : ""}`);

  log.stage("docx_parsed");
  await cp.complete("docx_parsed", hashes.docx, [], { narrationCount: docx.records.length });
  log.ok(`${docx.records.length} voiceover sections in script`);
}

async function stageValidate(course: LoadedCourse, cp: Checkpoint, hashes: { pptx: string; docx: string }): Promise<boolean> {
  const v = course.validation;
  log.stage("validated");
  const report = await writeValidationFiles(course);
  if (!v.ok) {
    await cp.invalidate("validated");
    console.log("");
    console.log(report);
    console.log("");
    log.fail("Slide/voiceover mapping is invalid. The final video was NOT created.");
    log.info(`Details: ${course.paths.validationError}`);
    return false;
  }
  for (const w of v.warnings) log.warn(w);
  await cp.complete("validated", sha256(hashes.pptx, hashes.docx), [course.paths.mappingReport], {
    slideCount: v.pptxCount,
    narrationCount: v.narrationCount,
  });
  log.ok(`PPTX slides (${v.pptxCount}) = voiceover sections (${v.narrationCount})`);
  return true;
}

async function stageSlides(course: LoadedCourse, cp: Checkpoint, config: Config, pptxHash: string, slides: SlideState[]): Promise<string> {
  const { paths, pptx } = course;
  const exportHidden = pptx.hiddenSlideNumbers.length > 0;
  const key = sha256("render-v1", pptxHash, config.video.width, config.video.height, config.video.padColor, exportHidden);
  log.stage("slides_rendered", "LibreOffice → PDF → PNG");
  await removeExtraSlideFiles(paths.slides, "png", slides.length);

  if (await cp.isReusable("slides_rendered", key)) {
    log.reuse(`${slides.length} slide images + thumbnail`);
    return key;
  }

  await cp.invalidate("slides_rendered");
  log.info("Converting PPTX to PDF with headless LibreOffice (this can take a minute)...");
  const pdf = await convertPptxToPdf({ pptx: course.inputs.pptx, workDir: path.join(paths.work, "render"), config, exportHiddenSlides: exportHidden });
  log.ok("PDF exported");

  let lastShown = 0;
  const { pngs, rasterizer } = await rasterizePdf({
    pdf,
    slidesDir: paths.slides,
    workDir: path.join(paths.work, "render"),
    expectedPages: slides.length,
    config,
    onProgress: (done, total) => {
      if (done === total || done - lastShown >= 10) {
        lastShown = done;
        log.info(`rendered ${done}/${total}`);
      }
    },
  });
  log.ok(`${pngs.length} slide images at ${config.video.width}x${config.video.height} (renderer: ${rasterizer})`);

  await createThumbnail(slides[0]!.png, paths.thumbnail, config);
  log.ok("thumbnail.jpg (1280x720) from slide 1");

  await cp.complete("slides_rendered", key, [...slides.map((s) => s.png), paths.thumbnail], { rasterizer });
  return key;
}

async function stageAudio(course: LoadedCourse, cp: Checkpoint, config: Config, slides: SlideState[], engine: TtsEngine) {
  const { paths } = course;
  log.stage("audio_generated", engine.description);
  await ensureDir(paths.audio);
  await removeExtraSlideFiles(paths.audio, "mp3", slides.length);

  // Decide per slide whether existing audio can be reused: same provider fingerprint + text => same key.
  const todo: SlideState[] = [];
  const reasons = { providerChanged: new Map<string, number>(), settingsOrTextChanged: 0, missing: 0 };
  for (const s of slides) {
    const rec = cp.slide(s.record.number);
    if (rec.audioKey === s.audioKey && (await isNonEmptyFile(s.mp3, 1000))) {
      try {
        s.audioSeconds = await probeDuration(s.mp3, config);
        rec.audioProvider = engine.fingerprint; // backfill for checkpoints written before fingerprints existed
        continue;
      } catch {
        // unreadable: regenerate below
      }
    }
    if (!rec.audioKey || !(await isNonEmptyFile(s.mp3))) reasons.missing++;
    else if (rec.audioProvider && rec.audioProvider !== engine.fingerprint) {
      reasons.providerChanged.set(rec.audioProvider, (reasons.providerChanged.get(rec.audioProvider) ?? 0) + 1);
    } else reasons.settingsOrTextChanged++;
    todo.push(s);
  }

  await writeFileAtomic(
    path.join(paths.qa, "tts-script.txt"),
    slides.map((s) => `Slide ${s.label} — ${s.record.title}\n\n${s.spokenText}\n`).join("\n"),
  );

  const reused = slides.length - todo.length;
  if (todo.length === 0) {
    log.reuse(`all ${slides.length} audio files (${engine.fingerprint})`);
  } else {
    for (const [old, n] of reasons.providerChanged) log.warn(`${n} audio file(s) were made with a different TTS voice/provider (${old}); regenerating.`);
    if (reasons.settingsOrTextChanged) log.warn(`${reasons.settingsOrTextChanged} audio file(s) have changed narration or TTS settings; regenerating.`);
    if (reasons.missing) log.info(`${reasons.missing} audio file(s) not generated yet.`);
    if (reused) log.reuse(`${reused} audio files`);

    // Everything downstream of audio is now stale. Slide images, parsing and validation are not.
    for (const stage of ["audio_generated", "segments_generated", "captions_generated", "video_generated", "final_validation"] as const) {
      await cp.invalidate(stage);
    }
    log.info(`Generating ${todo.length} audio file(s)${engine.concurrency > 1 ? `, ${engine.concurrency} at a time` : ""}...`);
    let done = 0;
    const started = Date.now();
    await mapLimit(todo, engine.concurrency, async (s) => {
      await engine.generate({
        spokenText: s.spokenText,
        out: s.mp3,
        workDir: path.join(paths.work, `tts-${engine.provider}`),
        slideLabel: `slide ${s.label}`,
        onStatus: (msg) => log.info(msg),
      });
      s.audioSeconds = await probeDuration(s.mp3, config);
      const rec = cp.slide(s.record.number);
      rec.audioProvider = engine.fingerprint;
      rec.audioKey = s.audioKey;
      rec.audioDurationSeconds = s.audioSeconds;
      await cp.save(); // persist after every file so a crash never loses finished (possibly paid) audio
      done++;
      const eta = done < todo.length ? `, ~${formatDuration(((Date.now() - started) / done) * (todo.length - done) / 1000)} left` : "";
      log.info(`audio/${path.basename(s.mp3)}  ${s.audioSeconds.toFixed(2)}s  (${done}/${todo.length}${eta})`);
    });
  }

  for (const s of slides) cp.slide(s.record.number).audioDurationSeconds = s.audioSeconds;
  await cp.complete("audio_generated", sha256(...slides.map((s) => s.audioKey)), slides.map((s) => s.mp3), {
    provider: engine.fingerprint,
    generated: todo.length,
    reused,
    totalAudioSeconds: slides.reduce((a, s) => a + s.audioSeconds, 0),
  });
  log.ok(`${slides.length} MP3 files; durations measured with ffprobe`);
}

async function stageSegments(course: LoadedCourse, cp: Checkpoint, config: Config, renderKey: string, slides: SlideState[]) {
  const { paths } = course;
  const v = config.video;
  log.stage("segments_generated", `H.264/AAC ${v.width}x${v.height} @ ${v.fps}fps`);
  await ensureDir(paths.segments);
  await removeExtraSlideFiles(paths.segments, "mp4", slides.length);

  const todo: SlideState[] = [];
  for (const s of slides) {
    s.segmentKey = sha256("segment-v1", renderKey, await sha256File(s.png), s.audioKey, v.width, v.height, v.fps, v.leadInSeconds, v.tailSeconds, v.padColor);
    const rec = cp.slide(s.record.number);
    if (rec.segmentKey === s.segmentKey && (await isNonEmptyFile(s.segment, 1000))) {
      try {
        s.segmentSeconds = await probeDuration(s.segment, config);
        continue;
      } catch {
        // unreadable: re-encode below
      }
    }
    todo.push(s);
  }

  if (todo.length === 0) {
    log.reuse(`all ${slides.length} video segments`);
  } else {
    if (todo.length < slides.length) log.reuse(`${slides.length - todo.length} video segments`);
    await cp.invalidate("segments_generated");
    let done = 0;
    await mapLimit(todo, v.segmentConcurrency, async (s) => {
      await createSegment({ image: s.png, audio: s.mp3, out: s.segment, audioSeconds: s.audioSeconds, config });
      s.segmentSeconds = await probeDuration(s.segment, config);
      if (s.segmentSeconds + 0.05 < s.audioSeconds + v.leadInSeconds) {
        throw new PipelineError(
          `Video segment for slide ${s.label} is shorter than its narration ` +
            `(${s.segmentSeconds.toFixed(2)}s video vs ${s.audioSeconds.toFixed(2)}s audio).`,
          `Delete ${s.segment} and run the build again.`,
        );
      }
      const rec = cp.slide(s.record.number);
      rec.segmentKey = s.segmentKey;
      rec.segmentDurationSeconds = s.segmentSeconds;
      await cp.save();
      done++;
      log.info(`video-segments/${path.basename(s.segment)}  ${s.segmentSeconds.toFixed(2)}s  (${done}/${todo.length})`);
    });
  }

  await cp.complete("segments_generated", sha256(...slides.map((s) => s.segmentKey)), slides.map((s) => s.segment));
  log.ok(`${slides.length} synchronized slide segments`);
}

function buildTimeline(slides: SlideState[], config: Config): TimedSlide[] {
  let t = 0;
  return slides.map((s) => {
    const segmentStart = t;
    const segmentEnd = t + s.segmentSeconds;
    const narrationStart = Math.min(segmentStart + config.video.leadInSeconds, segmentEnd);
    const narrationEnd = Math.min(narrationStart + s.audioSeconds, segmentEnd);
    t = segmentEnd;
    return { number: s.record.number, title: s.record.title, text: s.record.text, segmentStart, segmentEnd, narrationStart, narrationEnd };
  });
}

async function stageCaptions(course: LoadedCourse, cp: Checkpoint, timeline: TimedSlide[]) {
  const { paths, identity } = course;
  log.stage("captions_generated", "VTT, SRT, transcript");
  const key = sha256(
    "captions-v1",
    identity.title,
    ...timeline.map((t) => `${t.number}|${t.title}|${t.text}|${t.narrationStart.toFixed(3)}|${t.narrationEnd.toFixed(3)}`),
  );
  if (await cp.isReusable("captions_generated", key)) {
    log.reuse("captions.vtt, captions.srt, transcript.txt");
    return;
  }
  const cues = buildCues(timeline);
  await writeFileAtomic(paths.vtt, toVtt(cues, identity.title));
  await writeFileAtomic(paths.srt, toSrt(cues));
  await writeFileAtomic(paths.transcript, toTranscript(timeline));
  await cp.complete("captions_generated", key, [paths.vtt, paths.srt, paths.transcript], { cues: cues.length });
  log.ok(`${cues.length} caption cues aligned to measured audio windows`);
}

async function stageVideo(course: LoadedCourse, cp: Checkpoint, config: Config, slides: SlideState[], expectedSeconds: number) {
  const { paths } = course;
  log.stage("video_generated", "concatenating segments → final-video.mp4");
  const key = sha256("final-v1", config.video.fps, ...slides.map((s) => s.segmentKey));
  if (await cp.isReusable("video_generated", key)) {
    log.reuse("final-video.mp4");
    return;
  }
  await cp.invalidate("video_generated");
  log.info(`Encoding ${formatDuration(expectedSeconds)} of video...`);
  await concatSegments({
    segments: slides.map((s) => s.segment), // already in exact numerical order
    out: paths.finalVideo,
    workDir: paths.work,
    expectedSeconds,
    config,
  });
  const seconds = await probeDuration(paths.finalVideo, config);
  await cp.complete("video_generated", key, [paths.finalVideo], { durationSeconds: seconds });
  log.ok(`final-video.mp4 (${formatDuration(seconds)})`);
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function stageFinalValidation(
  course: LoadedCourse,
  cp: Checkpoint,
  config: Config,
  slides: SlideState[],
  timeline: TimedSlide[],
  engine: TtsEngine,
) {
  const { paths, identity, validation: v } = course;
  log.stage("final_validation");
  const checks: CheckResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  const pngCount = (await listSlideFiles(paths.slides, "png")).length;
  const mp3Count = (await listSlideFiles(paths.audio, "mp3")).length;
  const segCount = (await listSlideFiles(paths.segments, "mp4")).length;
  const counts = [v.pptxCount, v.narrationCount, pngCount, mp3Count, segCount];
  check(
    "slide count = narration count = PNG count = MP3 count = segment count",
    counts.every((c) => c === v.pptxCount) && v.pptxCount > 0,
    `slides ${v.pptxCount}, narration ${v.narrationCount}, PNG ${pngCount}, MP3 ${mp3Count}, segments ${segCount}`,
  );

  const finalExists = await isNonEmptyFile(paths.finalVideo);
  check("final-video.mp4 exists", finalExists, paths.finalVideo);
  let finalSeconds = 0;
  if (finalExists) {
    const info = await probeMedia(paths.finalVideo, config);
    finalSeconds = info.durationSeconds;
    check("final-video.mp4 duration > 0", finalSeconds > 0, `${finalSeconds.toFixed(3)}s`);
    const vid = info.video;
    check(
      "final video stream is H.264 yuv420p at target size",
      Boolean(vid && vid.codec === "h264" && vid.pixFmt === "yuv420p" && vid.width === config.video.width && vid.height === config.video.height),
      vid ? `${vid.codec} ${vid.width}x${vid.height} ${vid.pixFmt}` : "no video stream",
    );
    check("final audio stream is AAC", info.audio?.codec === "aac", info.audio ? info.audio.codec : "no audio stream");
    const expected = timeline.at(-1)?.segmentEnd ?? 0;
    const tolerance = Math.max(1, expected * 0.005);
    check(
      "final duration matches sum of segments",
      Math.abs(finalSeconds - expected) <= tolerance,
      `final ${finalSeconds.toFixed(2)}s vs segments ${expected.toFixed(2)}s (tolerance ±${tolerance.toFixed(2)}s)`,
    );
  }
  check("captions.vtt exists", await isNonEmptyFile(paths.vtt), paths.vtt);
  check("captions.srt exists", await isNonEmptyFile(paths.srt), paths.srt);
  check("transcript.txt exists", await isNonEmptyFile(paths.transcript), paths.transcript);
  check("thumbnail.jpg exists", await isNonEmptyFile(paths.thumbnail), paths.thumbnail);

  const allPass = checks.every((c) => c.pass);
  const courseJson = {
    courseTitle: identity.title,
    slideCount: v.pptxCount,
    durationSeconds: Math.round(finalSeconds * 1000) / 1000,
    video: "final-video.mp4",
    thumbnail: "thumbnail.jpg",
    captions: { vtt: "captions.vtt", srt: "captions.srt" },
    transcript: "transcript.txt",
    status: allPass ? "complete" : "failed",
    courseSlug: identity.slug,
    generatedAt: new Date().toISOString(),
    source: {
      presentation: "presentation.pptx",
      voiceoverScript: "voiceover-script.docx",
      originalPresentation: `source/${path.basename(course.inputs.pptx)}`,
      originalVoiceoverScript: `source/${path.basename(course.inputs.docx)}`,
    },
    tts: { provider: engine.provider, fingerprint: engine.fingerprint, description: engine.description },
    videoFormat: { width: config.video.width, height: config.video.height, fps: config.video.fps, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" },
    slides: slides.map((s, i) => ({
      number: s.record.number,
      title: s.record.title,
      image: `slides/${path.basename(s.png)}`,
      audio: `audio/${path.basename(s.mp3)}`,
      segment: `video-segments/${path.basename(s.segment)}`,
      startSeconds: round3(timeline[i]!.segmentStart),
      endSeconds: round3(timeline[i]!.segmentEnd),
      audioDurationSeconds: round3(s.audioSeconds),
    })),
  };
  await writeFileAtomic(paths.courseJson, JSON.stringify(courseJson, null, 2) + "\n");
  check("course.json exists", await isNonEmptyFile(paths.courseJson), paths.courseJson);

  const passed = checks.every((c) => c.pass);
  const report = [
    `Final validation: ${passed ? "PASS" : "FAIL"}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    ...checks.map((c) => `[${c.pass ? "PASS" : "FAIL"}] ${c.name}\n       ${c.detail}`),
  ].join("\n");
  await writeFileAtomic(path.join(paths.qa, "final-validation.txt"), report + "\n");
  for (const c of checks) (c.pass ? log.ok : log.fail)(`${c.name} — ${c.detail}`);

  if (passed) {
    await cp.complete("final_validation", sha256(...checks.map((c) => c.detail)), [paths.finalVideo, paths.courseJson], { durationSeconds: finalSeconds });
  } else {
    await cp.invalidate("final_validation");
  }
  return { passed, finalSeconds, pngCount, mp3Count, segCount };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function buildSlideStates(paths: CoursePaths, ordered: NarrationRecord[], config: Config, engine: TtsEngine): SlideState[] {
  return ordered.map((record) => {
    const spokenText = prepareSpokenText(record.text, config.tts.normalizeMedical);
    return {
      record,
      label: padLabel(record.number, ordered.length),
      png: path.join(paths.slides, slideFile(record.number, "png")),
      mp3: path.join(paths.audio, slideFile(record.number, "mp3")),
      segment: path.join(paths.segments, slideFile(record.number, "mp4")),
      spokenText,
      audioKey: engine.keyFor(spokenText),
      audioSeconds: 0,
      segmentKey: "",
      segmentSeconds: 0,
    };
  });
}

runMain(async () => {
  const started = Date.now();
  const config = loadConfig();
  console.log("DOCTYN COURSE BUILD");
  log.setStageTotal(STAGES.length);

  // Fail fast on missing local tools, before any TTS work.
  requireTool("ffmpeg", config);
  requireTool("ffprobe", config);
  requireTool("libreoffice", config);

  const course = await loadCourse(config);
  const { paths, identity, validation } = course;
  console.log(`Course: ${identity.title}`);
  console.log(`Output: ${paths.root}`);

  await assertWritableDir(paths.root, "course output");
  await ensureDir(paths.qa);
  await ensureDir(paths.work);
  const cp = await Checkpoint.load(paths.root, identity.slug);
  const hashes = { pptx: await sha256File(course.inputs.pptx), docx: await sha256File(course.inputs.docx) };

  await stageInputs(course, cp, hashes);
  await stageParsed(course, cp, hashes);
  if (!(await stageValidate(course, cp, hashes))) return 1;

  // The TTS fingerprint (provider + voice + settings) is part of every slide's audio key,
  // so resolve the engine (and validate its voice) before building slide state.
  const engine = await createTtsEngine(config);
  console.log(`TTS: ${engine.description}`);

  const slides = buildSlideStates(paths, validation.ordered, config, engine);

  // Rendering runs before TTS: it is free and local, so a broken deck is caught before any paid API call.
  const renderKey = await stageSlides(course, cp, config, hashes.pptx, slides);
  await stageAudio(course, cp, config, slides, engine);
  await stageSegments(course, cp, config, renderKey, slides);

  const timeline = buildTimeline(slides, config);
  await stageCaptions(course, cp, timeline);
  await stageVideo(course, cp, config, slides, timeline.at(-1)?.segmentEnd ?? 0);
  const result = await stageFinalValidation(course, cp, config, slides, timeline, engine);

  console.log("");
  console.log(result.passed ? "COURSE BUILD COMPLETE" : "COURSE BUILD FAILED FINAL VALIDATION");
  console.log("");
  console.log(`Course: ${identity.title}`);
  console.log(`Slides: ${validation.pptxCount}`);
  console.log(`Voiceovers: ${validation.narrationCount}`);
  console.log(`Slide images: ${result.pngCount}`);
  console.log(`Audio files: ${result.mp3Count}`);
  console.log(`Video segments: ${result.segCount}`);
  console.log(`Duration: ${formatDuration(result.finalSeconds)}`);
  console.log(`Build time: ${formatDuration((Date.now() - started) / 1000)}`);
  console.log("");
  console.log("Output:");
  console.log(paths.finalVideo);
  console.log("");
  console.log(`Validation: ${result.passed ? "PASS" : "FAIL"}`);
  if (!result.passed) console.log(`See ${path.join(paths.qa, "final-validation.txt")}`);
  if (!(await allNonEmpty([paths.finalVideo]))) return 1;
  return result.passed ? 0 : 1;
});
