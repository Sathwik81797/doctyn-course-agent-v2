/**
 * npm run test-services            (full check incl. local LibreOffice + FFmpeg smoke tests)
 * npm run test-services -- --quick (skip smoke tests)
 *
 * Verifies the local toolchain. Never calls the OpenAI API (no cost).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { convertPptxToPdf, countPdfPages, rasterizePdf } from "./services/render-slides.js";
import { normalizeForSpeech, prepareSpokenText } from "./services/tts.js";
import { describeWindowsVoice, generateWindowsAudio, listWindowsVoices, resolveWindowsVoice } from "./services/tts-windows.js";
import { describeKokoroVoice, generateKokoroAudio, isKokoroModelCached, kokoroModelFile, resolveKokoroVoice } from "./services/tts-kokoro.js";
import { createSegment, probeMedia } from "./services/video.js";
import { loadConfig, type Config } from "./utils/config.js";
import { formatError, runMain } from "./utils/errors.js";
import { run } from "./utils/exec.js";
import { assertWritableDir, ensureDir, exists, isOfficeTempFile } from "./utils/files.js";
import { findOptionalTool, locateTool, toolInstallHint, toolLabel, type ToolName } from "./utils/tools.js";

type Status = "PASS" | "WARN" | "FAIL";
const results: Array<{ status: Status; name: string; detail: string }> = [];

function report(status: Status, name: string, detail: string) {
  results.push({ status, name, detail });
  const icon = status === "PASS" ? "✓" : status === "WARN" ? "!" : "✗";
  console.log(`  ${icon} ${status}  ${name}`);
  for (const line of detail.split("\n")) console.log(`           ${line}`);
}

async function check(name: string, fn: () => Promise<{ status?: Status; detail: string }>) {
  try {
    const r = await fn();
    report(r.status ?? "PASS", name, r.detail);
  } catch (err) {
    report("FAIL", name, formatError(err));
  }
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0] ?? "";
}

async function toolCheck(tool: ToolName, config: Config, versionArgs: string[] | null) {
  await check(toolLabel(tool), async () => {
    const { found, checked } = locateTool(tool, config);
    if (!found) {
      return {
        status: "FAIL",
        detail: `${toolLabel(tool)} was not found.\nChecked:\n${checked.map((c) => `  ${c}`).join("\n")}\n\n${toolInstallHint(tool)}`,
      };
    }
    let version = "";
    if (versionArgs) {
      const { stdout, stderr } = await run(found.path, versionArgs, { label: toolLabel(tool), timeoutMs: 60_000 });
      version = firstLine(stdout || stderr);
    }
    return { detail: `${found.path}  [found via ${found.source}]${version ? `\n${version}` : ""}` };
  });
}

async function libreOfficeVersion(sofficePath: string): Promise<string> {
  // soffice.exe is a GUI binary on Windows; soffice.com next to it prints to the console.
  const com = sofficePath.replace(/soffice\.exe$/i, "soffice.com");
  if (process.platform === "win32" && com !== sofficePath && (await exists(com))) {
    try {
      const { stdout } = await run(com, ["--version"], { label: "LibreOffice", timeoutMs: 60_000 });
      if (stdout.trim()) return firstLine(stdout);
    } catch {
      // fall through to version.ini
    }
  }
  if (process.platform !== "win32") {
    const { stdout } = await run(sofficePath, ["--version"], { label: "LibreOffice", timeoutMs: 60_000 });
    return firstLine(stdout);
  }
  return "";
}

async function smokeTests(config: Config) {
  const dir = path.join(config.tempDir, "test-services");
  await fs.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
  let png: string | undefined;

  await check("Smoke test: LibreOffice PPTX → PDF → PNG", async () => {
    // pptxgenjs's typings describe the CJS shape (default.default); at runtime under ESM the class is `default`.
    const mod = await import("pptxgenjs");
    const PptxGenJS = (mod.default.default ?? mod.default) as unknown as typeof mod.default.default;
    const deck = new PptxGenJS();
    deck.layout = "LAYOUT_WIDE";
    for (const title of ["Doctyn test slide 1", "Doctyn test slide 2"]) {
      const slide = deck.addSlide();
      slide.background = { color: "FFFFFF" };
      slide.addText(title, { x: 0.5, y: 2.5, w: 12.3, h: 1.5, fontSize: 40, bold: true, align: "center", color: "1F4E79" });
    }
    const pptxFile = path.join(dir, "smoke.pptx");
    await deck.writeFile({ fileName: pptxFile });

    const t0 = Date.now();
    const pdf = await convertPptxToPdf({ pptx: pptxFile, workDir: path.join(dir, "render"), config, exportHiddenSlides: false });
    const pages = await countPdfPages(pdf);
    if (pages !== 2) throw new Error(`Expected 2 PDF pages, got ${pages}.`);
    const { pngs, rasterizer } = await rasterizePdf({
      pdf,
      slidesDir: path.join(dir, "slides"),
      workDir: path.join(dir, "render"),
      expectedPages: 2,
      config,
    });
    png = pngs[0];
    const { default: sharp } = await import("sharp");
    const meta = await sharp(pngs[0]!).metadata();
    if (meta.width !== config.video.width || meta.height !== config.video.height) {
      throw new Error(`Rendered PNG is ${meta.width}x${meta.height}, expected ${config.video.width}x${config.video.height}.`);
    }
    return { detail: `2 slides → 2 PDF pages → 2 PNGs at ${meta.width}x${meta.height} (renderer: ${rasterizer}, ${((Date.now() - t0) / 1000).toFixed(1)}s)` };
  });

  await check("Smoke test: FFmpeg slide segment (H.264/AAC/yuv420p)", async () => {
    if (!png) return { status: "WARN", detail: "Skipped: no slide image (LibreOffice smoke test failed)." };
    const mp3 = path.join(dir, "tone.mp3");
    await run(
      findOptionalTool("ffmpeg", config)!,
      ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-c:a", "libmp3lame", "-q:a", "4", mp3],
      { label: "FFmpeg", timeoutMs: 60_000 },
    );
    const audio = await probeMedia(mp3, config);
    const out = path.join(dir, "segment.mp4");
    const expected = await createSegment({ image: png, audio: mp3, out, audioSeconds: audio.durationSeconds, config });
    const info = await probeMedia(out, config);
    const v = info.video;
    const ok =
      v?.codec === "h264" && v.pixFmt === "yuv420p" && v.width === config.video.width && v.height === config.video.height && info.audio?.codec === "aac";
    if (!ok) throw new Error(`Unexpected output streams: ${JSON.stringify(info)}`);
    return {
      detail: `MP3 ${audio.durationSeconds.toFixed(3)}s (ffprobe) → segment ${info.durationSeconds.toFixed(3)}s (expected ${expected.toFixed(3)}s), ${v.codec} ${v.width}x${v.height} ${v.pixFmt} + ${info.audio?.codec}`,
    };
  });

  if (config.tts.provider === "kokoro") {
    await check("Smoke test: Kokoro → MP3 (local, offline)", async () => {
      if (!(await isKokoroModelCached(config))) {
        return { status: "WARN", detail: "Skipped: the Kokoro model is not downloaded yet (run `npm run preview-tts`, which downloads it once)." };
      }
      try {
        const text = prepareSpokenText("This is a local test. An HbA1c of 6.5% or 126 mg/dL supports the diagnosis.", true);
        const mp3 = path.join(dir, "kokoro.mp3");
        const t0 = Date.now();
        await generateKokoroAudio({ config, spokenText: text, out: mp3, workDir: path.join(dir, "tts-kokoro") });
        const info = await probeMedia(mp3, config);
        if (!(info.durationSeconds > 0) || info.audio?.codec !== "mp3") throw new Error(`Unexpected MP3: ${JSON.stringify(info)}`);
        return {
          detail: `${config.kokoro.voice}: ${info.durationSeconds.toFixed(2)}s MP3 (ffprobe), ${info.audio.sampleRate} Hz, model load + synthesis ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        };
      } catch (err) {
        return { status: "FAIL", detail: formatError(err) };
      }
    });
  }

  if (process.platform === "win32") {
    await check("Smoke test: Windows speech → WAV → MP3", async () => {
      try {
        const { voice } = await resolveWindowsVoice(config);
        const text = prepareSpokenText("This is a local test. An HbA1c of 6.5% or 126 mg/dL supports the diagnosis.", true);
        const mp3 = path.join(dir, "windows-tts.mp3");
        const t0 = Date.now();
        await generateWindowsAudio({ config, voiceName: voice.name, spokenText: text, out: mp3, workDir: path.join(dir, "tts-windows") });
        const info = await probeMedia(mp3, config);
        if (!(info.durationSeconds > 0) || info.audio?.codec !== "mp3") throw new Error(`Unexpected MP3: ${JSON.stringify(info)}`);
        return {
          detail: `${voice.name}: ${info.durationSeconds.toFixed(2)}s MP3 (ffprobe), ${info.audio.sampleRate} Hz, generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        };
      } catch (err) {
        return { status: config.tts.provider === "windows" ? "FAIL" : "WARN", detail: formatError(err) };
      }
    });
  }

  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

runMain(async () => {
  const quick = process.argv.includes("--quick");
  console.log("DOCTYN SERVICE CHECK (no OpenAI API calls are made)");
  console.log("");

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    report("FAIL", ".env configuration", formatError(err));
    return 1;
  }

  await check("Node.js", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    return major >= 20
      ? { detail: `v${process.versions.node} (${process.platform} ${process.arch})` }
      : { status: "FAIL", detail: `v${process.versions.node} — Node 20 or newer is required.` };
  });

  await check("Input folder", async () => {
    if (!(await exists(config.inputDir))) {
      return { status: "FAIL", detail: `Missing: ${config.inputDir}\nCreate it with: mkdir -p input` };
    }
    const names = (await fs.readdir(config.inputDir)).filter((n) => !n.startsWith("."));
    const usable = names.filter((n) => !isOfficeTempFile(n));
    const pptx = usable.filter((n) => /\.pptx$/i.test(n));
    const docx = usable.filter((n) => /\.docx$/i.test(n));
    const temp = names.filter(isOfficeTempFile);
    const lines = [config.inputDir, `PPTX: ${pptx.length ? pptx.join(", ") : "none"}`, `DOCX: ${docx.length ? docx.join(", ") : "none"}`];
    if (temp.length) lines.push(`Ignored temp files: ${temp.join(", ")}`);
    if (pptx.length === 1 && docx.length === 1) return { detail: lines.join("\n") };
    lines.push("The folder is reachable, but `npm run validate` / `build-course` need exactly one .pptx and one .docx here.");
    return { status: "WARN", detail: lines.join("\n") };
  });

  await check("Output folder", async () => {
    await assertWritableDir(config.outputDir, "output");
    return { detail: `${config.outputDir} (writable)` };
  });

  await check("Temp folder", async () => {
    await assertWritableDir(config.tempDir, "temp");
    return { detail: `${config.tempDir} (writable)` };
  });

  const usingOpenAI = config.tts.provider === "openai";
  console.log(`  TTS_PROVIDER=${config.tts.provider}`);

  await check(`OpenAI environment (OPENAI_API_KEY)${usingOpenAI ? "" : " — not required"}`, async () => {
    const key = config.openaiApiKey;
    if (!usingOpenAI) {
      // Informational only: the OpenAI key/quota is irrelevant to the local Windows provider.
      return { detail: `Not used: TTS_PROVIDER=${config.tts.provider}. ${key ? "A key is set but will not be called." : "No key set (fine)."}` };
    }
    const tts = `TTS_MODEL=${config.tts.model}  TTS_VOICE=${config.tts.voice}`;
    if (!key) return { status: "FAIL", detail: `OPENAI_API_KEY is empty in .env.\nAdd: OPENAI_API_KEY=sk-...  or switch to TTS_PROVIDER=windows\n${tts}` };
    const looksValid = /^sk-[A-Za-z0-9_-]{20,}$/.test(key);
    const masked = `${key.slice(0, 7)}…${key.slice(-4)}`;
    return {
      status: looksValid ? "PASS" : "WARN",
      detail: `${masked} (set; not tested — no paid API call is made here)${looksValid ? "" : "\nKey format looks unusual; OpenAI keys start with sk-."}\n${tts}`,
    };
  });

  const usingWindows = config.tts.provider === "windows";
  const usingKokoro = config.tts.provider === "kokoro";

  await check(`Kokoro local neural TTS${usingKokoro ? "" : " — optional"}`, async () => {
    const fail: Status = usingKokoro ? "FAIL" : "WARN";
    try {
      const voice = await resolveKokoroVoice(config);
      const cached = await isKokoroModelCached(config);
      const lines = [
        `Package: kokoro-js (ONNX, runs in-process; no Python needed)`,
        `Voice: ${describeKokoroVoice(voice)}  KOKORO_SPEED=${config.kokoro.speed}  KOKORO_DTYPE=${config.kokoro.dtype}`,
        cached
          ? `Model: cached at ${kokoroModelFile(config)} (works offline)`
          : `Model: not downloaded yet. The first \`npm run preview-tts\` or build downloads it once (~${config.kokoro.dtype === "fp32" ? "330" : "90-170"} MB) into ${config.kokoro.modelDir}.`,
      ];
      return { status: cached ? "PASS" : "WARN", detail: lines.join("\n") };
    } catch (err) {
      return { status: fail, detail: formatError(err) };
    }
  });

  await check(`Windows local speech (System.Speech)${usingWindows ? "" : " — optional"}`, async () => {
    const fail: Status = usingWindows ? "FAIL" : "WARN";
    if (process.platform !== "win32") return { status: fail, detail: "Not available: not running on Windows." };
    try {
      const voices = await listWindowsVoices(config);
      const { voice, automatic } = await resolveWindowsVoice(config);
      return {
        detail:
          `Installed voices: ${voices.map(describeWindowsVoice).join("; ")}\n` +
          `Voice for TTS_PROVIDER=windows: ${describeWindowsVoice(voice)}${automatic ? " [chosen automatically]" : " [WINDOWS_TTS_VOICE]"}\n` +
          `WINDOWS_TTS_RATE=${config.windowsTts.rate}  WINDOWS_TTS_VOLUME=${config.windowsTts.volume}`,
      };
    } catch (err) {
      return { status: fail, detail: formatError(err) };
    }
  });

  await toolCheck("ffmpeg", config, ["-hide_banner", "-version"]);
  await check("FFmpeg encoders (libx264, aac, libmp3lame)", async () => {
    const ffmpeg = findOptionalTool("ffmpeg", config);
    if (!ffmpeg) return { status: "FAIL", detail: "Skipped: FFmpeg not found." };
    const { stdout } = await run(ffmpeg, ["-hide_banner", "-encoders"], { label: "FFmpeg", timeoutMs: 60_000 });
    const missing = ["libx264", "aac", "libmp3lame"].filter((e) => !new RegExp(`\\s${e}\\s`).test(stdout));
    return missing.length
      ? { status: "FAIL", detail: `Missing encoders: ${missing.join(", ")}. Install a full FFmpeg build (winget install Gyan.FFmpeg).` }
      : { detail: "libx264, aac, libmp3lame available" };
  });
  await toolCheck("ffprobe", config, ["-hide_banner", "-version"]);

  await check("LibreOffice", async () => {
    const { found, checked } = locateTool("libreoffice", config);
    if (!found) {
      return {
        status: "FAIL",
        detail: `LibreOffice was not found.\nChecked:\n${checked.map((c) => `  ${c}`).join("\n")}\n\n${toolInstallHint("libreoffice")}`,
      };
    }
    const version = await libreOfficeVersion(found.path);
    return { detail: `${found.path}  [found via ${found.source}]${version ? `\n${version}` : ""}` };
  });

  await check("PDF → PNG renderer", async () => {
    const pdftoppm = findOptionalTool("pdftoppm", config);
    if (pdftoppm) return { detail: `pdftoppm: ${pdftoppm}` };
    await import("mupdf");
    return { detail: "MuPDF (bundled npm package; pdftoppm not installed, which is fine)" };
  });

  await check("sharp (image resizing)", async () => {
    const { default: sharp } = await import("sharp");
    return { detail: `libvips ${sharp.versions.vips}` };
  });

  await check("Medical speech normalization", async () => {
    const sample = "β-cell HbA1c ≥6.5%, 126 mg/dL, BMI 30 kg/m²";
    return { detail: `"${sample}"\n→ "${normalizeForSpeech(sample)}"` };
  });

  if (quick) {
    console.log("");
    console.log("  (smoke tests skipped: --quick)");
  } else if (results.some((r) => r.status === "FAIL" && /FFmpeg|ffprobe|LibreOffice/.test(r.name))) {
    report("WARN", "Smoke tests", "Skipped because a required tool is missing.");
  } else {
    console.log("");
    console.log("  Running local smoke tests (no API calls)...");
    await smokeTests(config);
  }

  const fails = results.filter((r) => r.status === "FAIL");
  const warns = results.filter((r) => r.status === "WARN");
  console.log("");
  console.log(`RESULT: ${fails.length ? "FAIL" : "PASS"}  (${results.length - fails.length - warns.length} passed, ${warns.length} warnings, ${fails.length} failed)`);
  if (fails.length) {
    console.log("");
    console.log("Fix the failed checks above:");
    for (const f of fails) console.log(`  - ${f.name}`);
  }
  return fails.length ? 1 : 0;
});
