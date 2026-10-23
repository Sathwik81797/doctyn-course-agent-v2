import fs from "node:fs/promises";
import path from "node:path";
import type { KokoroTTS } from "kokoro-js";
import type { Config, KokoroDtype } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import { run } from "../utils/exec.js";
import { ensureDir, isNonEmptyFile } from "../utils/files.js";
import { requireTool } from "../utils/tools.js";

/**
 * Local neural TTS with Kokoro-82M (Apache-2.0) through kokoro-js, which runs the
 * ONNX model in-process with onnxruntime-node. Voices ship inside the npm package.
 * The model weights are downloaded once from Hugging Face into KOKORO_MODEL_DIR;
 * after that, synthesis is completely offline. No text is ever sent anywhere.
 */

export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

const MODEL_FILES: Record<KokoroDtype, string> = {
  fp32: "model.onnx",
  fp16: "model_fp16.onnx",
  q8: "model_quantized.onnx",
  q4: "model_q4.onnx",
  q4f16: "model_q4f16.onnx",
};

/**
 * Kokoro is synthesized one sentence at a time: each generation is short, ends on real
 * punctuation and cannot run on. Sentences longer than this are split at clause breaks.
 */
const MAX_CHUNK_CHARS = 260;
/** Sentences with fewer words are merged into the next one; one- or two-word inputs are unstable. */
const MIN_CHUNK_WORDS = 3;
const CLAUSE_GAP_SECONDS = 0.12;
const SENTENCE_GAP_SECONDS = 0.25;
const PARAGRAPH_GAP_SECONDS = 0.4;
/** Clean silence after the final sentence. */
const TAIL_SILENCE_SECONDS = 0.3;
/** Kept around detected speech when trimming each chunk, so consonant onsets/decays are not clipped. */
const TRIM_PAD_START_SECONDS = 0.03;
const TRIM_PAD_END_SECONDS = 0.06;

export interface KokoroVoiceInfo {
  id: string;
  name: string;
  language: string;
  gender: string;
  overallGrade: string;
}

async function loadModule() {
  try {
    return await import("kokoro-js");
  } catch (err) {
    throw new PipelineError(
      `The Kokoro TTS package could not be loaded: ${(err as Error).message}`,
      "Run `npm install` in the project folder.",
    );
  }
}

/** All voices bundled with kokoro-js (read without loading the model). */
export async function listKokoroVoices(): Promise<KokoroVoiceInfo[]> {
  const { KokoroTTS } = await loadModule();
  const getter = Object.getOwnPropertyDescriptor(KokoroTTS.prototype, "voices")?.get;
  const voices = (getter?.call({}) ?? {}) as Record<string, Omit<KokoroVoiceInfo, "id">>;
  return Object.entries(voices).map(([id, v]) => ({ id, name: v.name, language: v.language, gender: v.gender, overallGrade: v.overallGrade }));
}

export function describeKokoroVoice(v: KokoroVoiceInfo): string {
  return `${v.id} (${v.gender}, ${v.language}, quality grade ${v.overallGrade})`;
}

export async function resolveKokoroVoice(config: Config): Promise<KokoroVoiceInfo> {
  const voices = await listKokoroVoices();
  const wanted = config.kokoro.voice.toLowerCase();
  const voice = voices.find((v) => v.id === wanted);
  if (!voice) {
    const english = voices
      .filter((v) => v.language.startsWith("en"))
      .map((v) => `  - ${describeKokoroVoice(v)}`)
      .join("\n");
    throw new PipelineError(
      `KOKORO_VOICE="${config.kokoro.voice}" is not a Kokoro voice.`,
      `Available English voices:\n${english}\n\nRecommended: af_heart (clearest), af_bella, or bf_emma (British).`,
    );
  }
  return voice;
}

export function kokoroModelFile(config: Config): string {
  return path.join(config.kokoro.modelDir, ...KOKORO_MODEL_ID.split("/"), "onnx", MODEL_FILES[config.kokoro.dtype]);
}

export async function isKokoroModelCached(config: Config): Promise<boolean> {
  return isNonEmptyFile(kokoroModelFile(config), 1_000_000);
}

let loading: Promise<KokoroTTS> | undefined;

/** Load the model once per process (downloads it on first use). */
export function loadKokoro(config: Config, onStatus?: (msg: string) => void): Promise<KokoroTTS> {
  loading ??= (async () => {
    const { KokoroTTS } = await loadModule();
    const { env } = await import("@huggingface/transformers");
    await ensureDir(config.kokoro.modelDir);
    env.cacheDir = config.kokoro.modelDir;

    const cached = await isKokoroModelCached(config);
    onStatus?.(
      cached
        ? `Loading Kokoro model (${config.kokoro.dtype}) from ${config.kokoro.modelDir}...`
        : `Downloading Kokoro model (${config.kokoro.dtype}, one time, ~${config.kokoro.dtype === "fp32" ? "330" : "90-170"} MB) into ${config.kokoro.modelDir}...`,
    );
    let lastPct = -1;
    try {
      return await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: config.kokoro.dtype,
        device: "cpu",
        progress_callback: (p) => {
          if (cached || p.status !== "progress" || !("progress" in p) || !/\.onnx$/.test(p.file)) return;
          const pct = Math.floor(p.progress / 10) * 10;
          if (pct > lastPct) {
            lastPct = pct;
            onStatus?.(`  download ${pct}%`);
          }
        },
      });
    } catch (err) {
      loading = undefined;
      throw new PipelineError(
        `The Kokoro model could not be ${cached ? "loaded" : "downloaded"}: ${(err as Error).message}`,
        cached
          ? `Delete ${path.join(config.kokoro.modelDir, ...KOKORO_MODEL_ID.split("/"))} and run again to re-download it.`
          : "The first Kokoro run needs internet access once to download the model weights from huggingface.co. After that it runs offline.",
      );
    }
  })();
  return loading;
}

export type ChunkBreak = "clause" | "sentence" | "paragraph" | "end";

/**
 * Split sanitized narration into one chunk per sentence. Very long sentences are split
 * at clause punctuation (then words); very short sentences are merged into the next.
 * `after` says what kind of pause follows the chunk.
 */
export function chunkForKokoro(text: string): Array<{ text: string; after: ChunkBreak }> {
  const chunks: Array<{ text: string; after: ChunkBreak }> = [];
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);

  for (const [pi, para] of paragraphs.entries()) {
    // Sentence boundary: . ! ? (optionally followed by a closing quote/bracket) then whitespace.
    const raw = para.split(/(?<=[.!?]["')\]]?)\s+(?=["'(\[]?[\p{Lu}\p{N}])/u).filter(Boolean);

    // Merge very short sentences ("Therefore." / "Yes.") into the following sentence.
    const sentences: string[] = [];
    let carry = "";
    for (const s of raw) {
      const joined = carry ? `${carry} ${s}` : s;
      if (joined.split(" ").length < MIN_CHUNK_WORDS && s !== raw.at(-1)) carry = joined;
      else {
        sentences.push(joined);
        carry = "";
      }
    }
    if (carry) sentences.push(carry);

    const paraChunks: Array<{ text: string; after: ChunkBreak }> = [];
    for (const sentence of sentences) {
      if (sentence.length <= MAX_CHUNK_CHARS) {
        paraChunks.push({ text: sentence, after: "sentence" });
        continue;
      }
      const pieces: string[] = [];
      let part = "";
      for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
        for (const word of clause.length > MAX_CHUNK_CHARS ? clause.split(" ") : [clause]) {
          const next = part ? `${part} ${word}` : word;
          if (next.length > MAX_CHUNK_CHARS && part) {
            pieces.push(part);
            part = word;
          } else part = next;
        }
      }
      if (part) pieces.push(part);
      pieces.forEach((p, i) => paraChunks.push({ text: p, after: i === pieces.length - 1 ? "sentence" : "clause" }));
    }
    const last = paraChunks.at(-1);
    if (last) last.after = pi === paragraphs.length - 1 ? "end" : "paragraph";
    chunks.push(...paraChunks);
  }
  return chunks;
}

const GAP_SECONDS: Record<ChunkBreak, number> = {
  clause: CLAUSE_GAP_SECONDS,
  sentence: SENTENCE_GAP_SECONDS,
  paragraph: PARAGRAPH_GAP_SECONDS,
  end: TAIL_SILENCE_SECONDS,
};

/**
 * Cut leading/trailing silence and low-level noise from one generated chunk so that
 * every chunk ends exactly where its speech ends; pauses are then added explicitly.
 */
export function trimSilence(samples: Float32Array, sampleRate: number): Float32Array {
  const frame = Math.max(1, Math.round(sampleRate * 0.01)); // 10 ms
  const frames = Math.ceil(samples.length / frame);
  const rms = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * frame);
    for (let i = f * frame; i < end; i++) sum += samples[i]! * samples[i]!;
    rms[f] = Math.sqrt(sum / Math.max(1, end - f * frame));
    if (rms[f]! > peak) peak = rms[f]!;
  }
  if (peak === 0) return samples.subarray(0, 0);
  const threshold = Math.max(0.003, peak * 0.03); // ~ -30 dB below the chunk's loudest frame
  let first = 0;
  while (first < frames && rms[first]! < threshold) first++;
  let last = frames - 1;
  while (last > first && rms[last]! < threshold) last--;
  const start = Math.max(0, first * frame - Math.round(TRIM_PAD_START_SECONDS * sampleRate));
  const stop = Math.min(samples.length, (last + 1) * frame + Math.round(TRIM_PAD_END_SECONDS * sampleRate));
  return samples.subarray(start, stop);
}

/** Synthesize one slide's narration to WAV with Kokoro, then convert to MP3 with FFmpeg. */
export async function generateKokoroAudio(opts: {
  config: Config;
  spokenText: string;
  out: string;
  workDir: string;
  onStatus?: (msg: string) => void;
}): Promise<void> {
  const { config } = opts;
  const tts = await loadKokoro(config, opts.onStatus);
  const chunks = chunkForKokoro(opts.spokenText);
  if (chunks.length === 0) throw new PipelineError(`No narration text to synthesize for ${path.basename(opts.out)}.`);

  const parts: Float32Array[] = [];
  let sampleRate = 24_000;
  for (const chunk of chunks) {
    // One bounded generation per sentence: the model only ever sees this sentence.
    const audio = await tts.generate(chunk.text, {
      // Validated against the bundled voice list by resolveKokoroVoice().
      voice: config.kokoro.voice.toLowerCase() as NonNullable<NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"]>,
      speed: config.kokoro.speed,
    });
    sampleRate = audio.sampling_rate;
    const speech = trimSilence(audio.audio, sampleRate);

    // Plausibility guard: natural speech is ~12-18 characters/second at speed 1.0.
    const seconds = speech.length / sampleRate;
    const maxExpected = Math.max(2.5, (chunk.text.length / 8) / config.kokoro.speed);
    if (seconds > maxExpected) {
      opts.onStatus?.(
        `! ${path.basename(opts.out)}: ${seconds.toFixed(1)}s of audio for ${chunk.text.length} characters (expected ≤ ${maxExpected.toFixed(1)}s) — listen to: "${chunk.text.slice(0, 60)}${chunk.text.length > 60 ? "…" : ""}"`,
      );
    }

    parts.push(speech, new Float32Array(Math.round(GAP_SECONDS[chunk.after] * sampleRate)));
  }

  const total = parts.reduce((n, p) => n + p.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    samples.set(p, offset);
    offset += p.length;
  }

  const base = path.basename(opts.out, path.extname(opts.out));
  await ensureDir(opts.workDir);
  const wav = path.join(opts.workDir, `${base}.wav`);
  await fs.writeFile(wav, encodeWav16(samples, sampleRate));

  const partial = opts.out.replace(/\.mp3$/i, ".partial.mp3");
  await ensureDir(path.dirname(opts.out));
  await run(
    requireTool("ffmpeg", config),
    ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", wav, "-c:a", "libmp3lame", "-q:a", "2", partial],
    { label: "FFmpeg (WAV → MP3)", timeoutMs: 10 * 60_000 },
  );
  await fs.rename(partial, opts.out);
  await fs.rm(wav, { force: true });
}

/** 16-bit PCM mono WAV. */
function encodeWav16(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}
