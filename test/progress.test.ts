import assert from "node:assert/strict";
import { test } from "node:test";
import { ProgressTracker } from "../src/server/progress.js";

test("build-course output drives stage status, percent and ETA", () => {
  const t = new ProgressTracker("build-course");
  for (const line of [
    "DOCTYN COURSE BUILD",
    "Course: Risk Factors",
    "Output: C:\\work\\output\\risk-factors",
    "[1/10] input_detected — a.pptx + b.docx",
    "  ✓ Source files copied",
    "[2/10] pptx_parsed",
    "[3/10] docx_parsed",
    "[4/10] validated",
    "[5/10] slides_rendered — LibreOffice → PDF → PNG",
    "  ↺ 52 slide images + thumbnail (reused from checkpoint)",
    "[6/10] audio_generated — Kokoro",
    "    audio/slide-013.mp3  21.40s  (13/52, ~9m 30s left)",
  ]) t.push(line);

  const s = t.snapshot();
  assert.equal(t.outputPath, "C:\\work\\output\\risk-factors");
  assert.equal(s.stage, "audio_generated");
  assert.equal(s.eta, "9m 30s");
  assert.deepEqual(
    s.stages.slice(0, 6).map((x) => x.status),
    ["done", "done", "done", "done", "reused", "running"],
  );
  // 4 small stages + slides (10) done, plus a quarter of audio (50 * 0.25), out of 99.
  assert.equal(s.percent, Math.round(((4 + 10 + 12.5) / 99) * 1000) / 10);
});

test("successful finish closes the last stage and collects the summary", () => {
  const t = new ProgressTracker("build-course");
  t.push("[10/10] final_validation");
  t.push("COURSE BUILD COMPLETE");
  t.push("Duration: 15m 17s");
  t.push("Output:");
  t.push("C:\\out\\final-video.mp4");
  t.push("Validation: PASS");
  t.finish(true);
  const s = t.snapshot();
  assert.equal(s.stages.at(-1)!.status, "done");
  assert.match(t.summary!, /COURSE BUILD COMPLETE/);
  assert.match(t.summary!, /Output: C:\\out\\final-video\.mp4/);
  assert.match(t.summary!, /Validation: PASS/);
  assert.equal(t.outputPath, null, "the final 'Output:' block is not the course folder");
});

test("CLI error block becomes the job error and fails the running stage", () => {
  const t = new ProgressTracker("build-course");
  t.push("[5/10] slides_rendered");
  t.push("");
  t.push("ERROR");
  t.push("-----");
  t.push("LibreOffice was not found.");
  t.push("Install LibreOffice or configure LIBREOFFICE_PATH in .env.");
  t.finish(false);
  assert.equal(t.errorMessage, "LibreOffice was not found.\nInstall LibreOffice or configure LIBREOFFICE_PATH in .env.");
  assert.equal(t.snapshot().stages[4]!.status, "failed");
});

test("preview-tts progress counts finished clips", () => {
  const t = new ProgressTracker("preview-tts");
  t.push("Slides: 1, 2, 3, 4");
  t.push("  ✓ slide-001.mp3  19.5s audio  (17.0s)  Slide 01 — Intro");
  assert.equal(t.snapshot().percent, 25);
  assert.deepEqual(t.snapshot().stages, []);
});

test("validate summary is captured for pass and fail", () => {
  const ok = new ProgressTracker("validate");
  ok.push("VALIDATION PASSED — 52 slides mapped to 52 voiceover sections.");
  assert.match(ok.summary!, /PASSED/);
  assert.equal(ok.snapshot().percent, 100);
  const bad = new ProgressTracker("validate");
  bad.push("VALIDATION FAILED — fix the voiceover document or presentation, then run again.");
  assert.match(bad.summary!, /FAILED/);
});
