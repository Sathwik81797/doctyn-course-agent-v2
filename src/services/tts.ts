import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import type { Config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import { run, toForwardSlashes } from "../utils/exec.js";
import { ensureDir, sha256, writeFileAtomic } from "../utils/files.js";
import { requireTool } from "../utils/tools.js";

/** OpenAI's speech endpoint accepts at most 4096 characters per request. */
const MAX_TTS_CHARS = 4000;

type Rule = [RegExp, string];

/**
 * Spoken forms for medical notation. Applied only to the text sent to TTS;
 * captions and transcript keep the original wording.
 */
const SPEECH_RULES: Rule[] = [
  // Lab tests and terms
  [/\bHbA1c\b/gi, "H B A one C"],
  [/\bA1c\b/g, "A one C"],
  [/\bT2DM\b/g, "type 2 diabetes"],
  [/\bT1DM\b/g, "type 1 diabetes"],
  [/\beGFR\b/g, "e G F R"],

  // Greek letters ("β-cell" -> "beta cell")
  [/β[-‐‑]?(?=[A-Za-z])/g, "beta "],
  [/α[-‐‑]?(?=[A-Za-z])/g, "alpha "],
  [/γ[-‐‑]?(?=[A-Za-z])/g, "gamma "],
  [/δ[-‐‑]?(?=[A-Za-z])/g, "delta "],
  [/κ[-‐‑]?(?=[A-Za-z])/g, "kappa "],
  [/β/g, "beta"],
  [/α/g, "alpha"],
  [/γ/g, "gamma"],
  [/δ/g, "delta"],
  [/κ/g, "kappa"],

  // Compound units (most specific first). "126mg/dL" has no \b between digit and
  // letter, so units are anchored with "not preceded by a letter" instead.
  [/(?<![A-Za-z])mL\/min\/1\.73\s?m(?:²|2|\^2)/g, " millilitres per minute per 1.73 square metres"],
  [/(?<![A-Za-z])kg\/m(?:²|2|\^2)(?!\w)/g, " kilograms per square metre"],
  [/(?<![A-Za-z])mg\/dL\b/gi, " milligrams per decilitre"],
  [/(?<![A-Za-z])g\/dL\b/gi, " grams per decilitre"],
  [/(?<![A-Za-z])mmol\/mol\b/gi, " millimoles per mole"],
  [/(?<![A-Za-z])mmol\/L\b/gi, " millimoles per litre"],
  [/[µμ]mol\/L\b/gi, " micromoles per litre"],
  [/(?<![A-Za-z])mIU\/L\b/g, " milli-international units per litre"],
  [/(?<![A-Za-z])IU\/L\b/g, " international units per litre"],
  [/(?<![A-Za-z])U\/L\b/g, " units per litre"],
  [/(?<![A-Za-z])mg\/kg\b/g, " milligrams per kilogram"],
  [/(?<![A-Za-z])mm\s?Hg\b/g, " millimetres of mercury"],
  [/(?<![A-Za-z])kcal\b/g, " kilocalories"],

  // Simple units, only directly after a number ("5 mg", "90cm")
  [/(?<=\d\s?)[µμ]g\b/g, " micrograms"],
  [/(?<=\d\s?)mcg\b/g, " micrograms"],
  [/(?<=\d\s?)mg\b/g, " milligrams"],
  [/(?<=\d\s?)kg\b/g, " kilograms"],
  [/(?<=\d\s?)cm\b/g, " centimetres"],
  [/(?<=\d\s?)mm\b/g, " millimetres"],
  [/(?<=\d\s?)m[lL]\b/g, " millilitres"],
  [/°\s?C\b/g, " degrees Celsius"],
  [/°\s?F\b/g, " degrees Fahrenheit"],

  // Symbols
  [/\s?≥\s?/g, " greater than or equal to "],
  [/\s?≤\s?/g, " less than or equal to "],
  [/\s?>\s?(?=\d)/g, " greater than "],
  [/\s?<\s?(?=\d)/g, " less than "],
  [/\s?±\s?/g, " plus or minus "],
  [/(?<=\d)\s?[×x]\s?(?=\d)/g, " times "],
  [/(?<=\d)\s?[–—-]\s?(?=\d)/g, " to "],
  [/~\s?(?=\d)/g, "approximately "],

  // Abbreviations
  [/\be\.g\.,?/gi, "for example,"],
  [/\bi\.e\.,?/gi, "that is,"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\bapprox\.(?=\s)/gi, "approximately"],
];

/**
 * Make narration safe to speak: only words and normal punctuation reach the TTS engine.
 * Removes decorative separators (————, ____, ====), control/invisible characters and
 * Markdown markers, normalizes Unicode and quotes, and guarantees each paragraph ends
 * with sentence punctuation (open-ended input is what makes neural TTS ramble).
 */
export function sanitizeForSpeech(text: string): string {
  const paragraphs = text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "") // control characters (keep \t, \n)
    .replace(/[\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff\ue000-\uf8ff]/g, "") // invisible / private-use
    .replace(/[\u00a0\u2007\u202f\t]/g, " ")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, "...")
    .replace(/[-‐‑‒–—―_=*~•·#]{3,}/g, " ") // decorative separator runs
    .replace(/\*\*|__/g, "") // Markdown emphasis
    .replace(/^\s*(?:#{1,6}|>|[-*•·])\s+/gm, "") // Markdown heading / quote / bullet markers
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => /[\p{L}\p{N}]/u.test(p)); // drop paragraphs with nothing speakable

  return paragraphs
    .map((p) => {
      const body = p.replace(/[\s,;:\-–—]+$/, "");
      return /[.!?]["')\]]*$/.test(body) ? body : `${body}.`;
    })
    .join("\n\n");
}

/** Narration text -> exactly what the TTS engine should say. */
export function prepareSpokenText(text: string, normalizeMedical: boolean): string {
  const clean = sanitizeForSpeech(text);
  return normalizeMedical ? sanitizeForSpeech(normalizeForSpeech(clean)) : clean;
}

export function normalizeForSpeech(text: string): string {
  let out = text;
  for (const [re, rep] of SPEECH_RULES) {
    out = out.replace(re, rep);
  }
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?)])/g, "$1")
    .replace(/\( +/g, "(")
    .replace(/,,/g, ",")
    .trim();
}

/** Split long narration at paragraph, then sentence, then word boundaries. */
export function splitForTts(text: string, max = MAX_TTS_CHARS): string[] {
  if (text.length <= max) return [text];
  const pieces: string[] = [];
  const units = text
    .split(/\n{2,}/)
    .flatMap((p) => (p.length <= max ? [p] : p.split(/(?<=[.!?])\s+/)))
    .flatMap((s) => {
      if (s.length <= max) return [s];
      const words: string[] = [];
      let cur = "";
      for (const w of s.split(/\s+/)) {
        if ((cur + " " + w).length > max && cur) {
          words.push(cur);
          cur = w;
        } else cur = cur ? `${cur} ${w}` : w;
      }
      if (cur) words.push(cur);
      return words;
    });
  let cur = "";
  for (const u of units) {
    const joined = cur ? `${cur}\n\n${u}` : u;
    if (joined.length > max && cur) {
      pieces.push(cur);
      cur = u;
    } else cur = joined;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

export function createTtsClient(config: Config): OpenAI {
  if (!config.openaiApiKey) {
    throw new PipelineError(
      "OPENAI_API_KEY is not set.",
      "Add your key to .env in the project folder:\n  OPENAI_API_KEY=sk-...\nThe key is only used by `npm run build-course` to generate narration audio.",
    );
  }
  return new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 5, timeout: 180_000 });
}

function explainOpenAIError(err: unknown, slideLabel: string): PipelineError {
  const prefix = `OpenAI TTS failed for ${slideLabel}.`;
  if (err instanceof OpenAI.AuthenticationError) {
    return new PipelineError(`${prefix}\nOpenAI rejected the API key (401).`, "Check OPENAI_API_KEY in .env.");
  }
  if (err instanceof OpenAI.PermissionDeniedError) {
    return new PipelineError(`${prefix}\nAccess denied (403): ${err.message}`, "Your OpenAI project may not have access to this TTS model.");
  }
  if (err instanceof OpenAI.RateLimitError) {
    const quota = /quota|billing/i.test(err.message);
    return new PipelineError(
      `${prefix}\n${quota ? "Your OpenAI account has run out of quota." : "Rate limit reached after several retries."}\n${err.message}`,
      quota
        ? "Add credit at https://platform.openai.com/settings/organization/billing, then re-run. Audio already generated is reused."
        : "Lower TTS_CONCURRENCY in .env and re-run. Audio already generated is reused.",
    );
  }
  if (err instanceof OpenAI.NotFoundError || err instanceof OpenAI.BadRequestError) {
    return new PipelineError(`${prefix}\n${err.message}`, "Check TTS_MODEL, TTS_VOICE and TTS_SPEED in .env.");
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new PipelineError(`${prefix}\nCould not reach the OpenAI API: ${err.message}`, "Check your internet connection and re-run. Audio already generated is reused.");
  }
  if (err instanceof OpenAI.APIError) {
    return new PipelineError(`${prefix}\nOpenAI API error ${err.status ?? ""}: ${err.message}`, "Re-run the build; completed slides are reused.");
  }
  return new PipelineError(`${prefix}\n${(err as Error)?.message ?? String(err)}`);
}

async function speak(client: OpenAI, config: Config, input: string, slideLabel: string): Promise<Buffer> {
  const params: OpenAI.Audio.SpeechCreateParams = {
    model: config.tts.model,
    voice: config.tts.voice,
    input,
    response_format: "mp3",
  };
  if (config.tts.speed !== 1) params.speed = config.tts.speed;
  // `instructions` is not supported by the older tts-1 / tts-1-hd models.
  if (config.tts.instructions && !/^tts-1/.test(config.tts.model)) params.instructions = config.tts.instructions;
  try {
    const res = await client.audio.speech.create(params);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error(`OpenAI returned only ${buf.length} bytes of audio.`);
    return buf;
  } catch (err) {
    throw explainOpenAIError(err, slideLabel);
  }
}

/**
 * Generate one MP3 for a slide. Long narration is synthesized in chunks and
 * joined losslessly-enough with FFmpeg into a single file.
 */
export async function generateSlideAudio(opts: {
  client: OpenAI;
  config: Config;
  spokenText: string;
  out: string;
  workDir: string;
  slideLabel: string;
}): Promise<void> {
  const chunks = splitForTts(opts.spokenText);
  if (chunks.length === 1) {
    await writeFileAtomic(opts.out, await speak(opts.client, opts.config, chunks[0]!, opts.slideLabel));
    return;
  }

  const dir = path.join(opts.workDir, path.basename(opts.out, ".mp3"));
  await ensureDir(dir);
  const parts: string[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const part = path.join(dir, `part-${String(i + 1).padStart(2, "0")}.mp3`);
    await writeFileAtomic(part, await speak(opts.client, opts.config, chunk, `${opts.slideLabel} (part ${i + 1}/${chunks.length})`));
    parts.push(part);
  }
  const list = path.join(dir, "parts.txt");
  await fs.writeFile(list, parts.map((p) => `file '${toForwardSlashes(p).replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const partial = opts.out.replace(/\.mp3$/i, ".partial.mp3");
  await run(
    requireTool("ffmpeg", opts.config),
    ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "libmp3lame", "-q:a", "2", partial],
    { label: "FFmpeg (joining TTS audio)", timeoutMs: 10 * 60_000 },
  );
  await fs.rename(partial, opts.out);
  await fs.rm(dir, { recursive: true, force: true });
}
