/**
 * npm run preview-tts                      first 3 slides with the configured TTS provider
 * npm run preview-tts -- --count 5         first 5 slides
 * npm run preview-tts -- --slides 1,12,24  specific slides
 *
 * Generates sample narration into output/<course>/qa/tts-preview/<voice-label>/ so a
 * voice can be judged before the full build. Does not touch audio/, checkpoint.json
 * or any other build output.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadCourse } from "./services/course.js";
import { createTtsEngine } from "./services/tts-engine.js";
import { prepareSpokenText } from "./services/tts.js";
import { probeDuration } from "./services/video.js";
import { loadConfig } from "./utils/config.js";
import { PipelineError, runMain } from "./utils/errors.js";
import { ensureDir, padLabel, slideFile, writeFileAtomic } from "./utils/files.js";
import { requireTool } from "./utils/tools.js";

function parseArgs(argv: string[], slideCount: number): number[] {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const slidesArg = value("--slides");
  if (slidesArg) {
    const nums = slidesArg.split(",").flatMap((part) => {
      const range = /^(\d+)-(\d+)$/.exec(part.trim());
      if (range) {
        const [a, b] = [Number(range[1]), Number(range[2])];
        return Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
      }
      return [Number(part.trim())];
    });
    const bad = nums.filter((n) => !Number.isInteger(n) || n < 1 || n > slideCount);
    if (bad.length || nums.length === 0) {
      throw new PipelineError(`Invalid --slides "${slidesArg}". Use slide numbers between 1 and ${slideCount}, e.g. --slides 1,12,24 or --slides 1-3.`);
    }
    return [...new Set(nums)].sort((a, b) => a - b);
  }
  const count = Number(value("--count") ?? 3);
  if (!Number.isInteger(count) || count < 1) throw new PipelineError(`Invalid --count. Use a whole number, e.g. --count 3.`);
  return Array.from({ length: Math.min(count, slideCount) }, (_, i) => i + 1);
}

runMain(async () => {
  const config = loadConfig();
  console.log("DOCTYN TTS PREVIEW");
  requireTool("ffmpeg", config);
  requireTool("ffprobe", config);

  const course = await loadCourse(config);
  const { validation: v, paths, identity } = course;
  if (!v.ok) {
    throw new PipelineError(
      "The slide/voiceover mapping does not validate, so slide numbers cannot be trusted for a preview.",
      "Run `npm run validate` and fix the reported problems first.",
    );
  }
  const numbers = parseArgs(process.argv.slice(2), v.pptxCount);

  const engine = await createTtsEngine(config);
  console.log(`Course: ${identity.title}`);
  console.log(`TTS:    ${engine.description}`);
  if (engine.paid) console.log(`Note:   this makes ${numbers.length} paid OpenAI API request(s).`);
  console.log(`Slides: ${numbers.join(", ")}`);
  console.log("");

  const outDir = path.join(paths.qa, "tts-preview", engine.label);
  await ensureDir(outDir);
  const workDir = path.join(paths.work, "tts-preview");
  const lines: string[] = [`TTS preview — ${identity.title}`, `Provider: ${engine.description}`, `Fingerprint: ${engine.fingerprint}`, `Generated: ${new Date().toISOString()}`, ""];

  const started = Date.now();
  let total = 0;
  for (const n of numbers) {
    const record = v.ordered.find((r) => r.number === n)!;
    const spoken = prepareSpokenText(record.text, config.tts.normalizeMedical);
    const out = path.join(outDir, slideFile(n, "mp3"));
    const t0 = Date.now();
    await engine.generate({ spokenText: spoken, out, workDir, slideLabel: `slide ${n}`, onStatus: (m) => console.log(`    ${m}`) });
    const seconds = await probeDuration(out, config);
    total += seconds;
    const label = `Slide ${padLabel(n, v.pptxCount)} — ${record.title}`;
    console.log(`  ✓ ${path.basename(out)}  ${seconds.toFixed(1)}s audio  (${((Date.now() - t0) / 1000).toFixed(1)}s)  ${label}`);
    lines.push(`${path.basename(out)}  ${seconds.toFixed(2)}s  ${label}`, "", spoken, "");
  }
  await writeFileAtomic(path.join(outDir, "preview.txt"), lines.join("\n"));
  await fs.rm(workDir, { recursive: true, force: true });

  console.log("");
  console.log(`PREVIEW READY — ${numbers.length} file(s), ${total.toFixed(1)}s of audio in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log(outDir);
  console.log("");
  console.log("Listen in Git Bash:");
  console.log(`  start "" "${path.join(outDir, slideFile(numbers[0]!, "mp3"))}"`);
  console.log(`  explorer "${outDir}"`);
  console.log("");
  console.log("Nothing in audio/ or checkpoint.json was changed. If you like this voice: npm run build-course");
  return 0;
});
