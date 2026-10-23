import path from "node:path";
import dotenv from "dotenv";
import { PipelineError } from "./errors.js";

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
// Vercel CLI (`vercel env pull`) writes VERCEL_OIDC_TOKEN here; existing values from .env win.
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.local"), quiet: true });

/**
 * Convert a path that may be written Git Bash style (/c/Program Files/...)
 * or quoted into a native absolute path.
 */
export function normalizeUserPath(value: string, base = PROJECT_ROOT): string {
  let p = value.trim().replace(/^["']|["']$/g, "");
  if (process.platform === "win32") {
    const msys = /^\/([a-zA-Z])(\/|$)(.*)$/.exec(p);
    if (msys) p = `${msys[1]!.toUpperCase()}:\\${msys[3] ?? ""}`;
    p = p.replace(/\//g, "\\");
  }
  return path.resolve(base, p);
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : fallback;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new PipelineError(
      `Invalid value in .env: ${name}=${raw}`,
      `${name} must be a number between ${min} and ${max}.`,
    );
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(raw);
}

export const TTS_PROVIDERS = ["openai", "windows", "kokoro"] as const;
export const KOKORO_DTYPES = ["fp32", "fp16", "q8", "q4", "q4f16"] as const;
export type KokoroDtype = (typeof KOKORO_DTYPES)[number];
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

function ttsProvider(): TtsProvider {
  const raw = str("TTS_PROVIDER", "openai").toLowerCase();
  if ((TTS_PROVIDERS as readonly string[]).includes(raw)) return raw as TtsProvider;
  throw new PipelineError(
    `Invalid value in .env: TTS_PROVIDER=${raw}`,
    "Use TTS_PROVIDER=kokoro (local neural voice, free), TTS_PROVIDER=windows (built-in Windows speech, free) " +
      "or TTS_PROVIDER=openai (OpenAI API, paid).",
  );
}

function kokoroDtype(): KokoroDtype {
  const raw = str("KOKORO_DTYPE", "fp32").toLowerCase();
  if ((KOKORO_DTYPES as readonly string[]).includes(raw)) return raw as KokoroDtype;
  throw new PipelineError(`Invalid value in .env: KOKORO_DTYPE=${raw}`, `Use one of: ${KOKORO_DTYPES.join(", ")} (fp32 recommended).`);
}

export interface Config {
  inputDir: string;
  outputDir: string;
  tempDir: string;
  openaiApiKey: string | undefined;
  tts: {
    provider: TtsProvider;
    model: string;
    voice: string;
    instructions: string | undefined;
    speed: number;
    concurrency: number;
    normalizeMedical: boolean;
  };
  kokoro: {
    /** Kokoro voice id, e.g. af_heart, af_bella, bf_emma. */
    voice: string;
    /** 0.5 .. 2.0 */
    speed: number;
    /** ONNX weights precision. fp32 = best quality (and fastest on most desktop CPUs). */
    dtype: KokoroDtype;
    /** Local cache for the downloaded model weights. */
    modelDir: string;
  };
  windowsTts: {
    /** Exact or partial voice name; undefined = pick an installed English voice. */
    voice: string | undefined;
    /** System.Speech rate, -10 (slowest) .. 10 (fastest). */
    rate: number;
    /** 0 .. 100 */
    volume: number;
  };
  video: {
    width: number;
    height: number;
    fps: number;
    leadInSeconds: number;
    tailSeconds: number;
    padColor: string;
    segmentConcurrency: number;
  };
  courseTitleOverride: string | undefined;
  courseSlugOverride: string | undefined;
  toolPaths: {
    libreoffice: string | undefined;
    ffmpeg: string | undefined;
    ffprobe: string | undefined;
    pdftoppm: string | undefined;
  };
}

export function loadConfig(): Config {
  const toolPath = (name: string) => {
    const v = optional(name);
    return v === undefined ? undefined : normalizeUserPath(v);
  };
  const padColor = str("SLIDE_PAD_COLOR", "#000000");
  if (!/^#[0-9a-fA-F]{6}$/.test(padColor)) {
    throw new PipelineError(
      `Invalid value in .env: SLIDE_PAD_COLOR=${padColor}`,
      "Use a hex colour such as #000000 or #FFFFFF.",
    );
  }
  return {
    inputDir: normalizeUserPath(str("INPUT_DIR", "./input")),
    outputDir: normalizeUserPath(str("OUTPUT_DIR", "./output")),
    tempDir: normalizeUserPath(str("TEMP_DIR", "./temp")),
    openaiApiKey: optional("OPENAI_API_KEY"),
    tts: {
      provider: ttsProvider(),
      model: str("TTS_MODEL", "gpt-4o-mini-tts"),
      voice: str("TTS_VOICE", "alloy"),
      instructions: optional("TTS_INSTRUCTIONS"),
      speed: num("TTS_SPEED", 1, 0.25, 4),
      concurrency: Math.round(num("TTS_CONCURRENCY", 3, 1, 16)),
      normalizeMedical: bool("TTS_NORMALIZE_MEDICAL", true),
    },
    windowsTts: {
      voice: optional("WINDOWS_TTS_VOICE"),
      rate: Math.round(num("WINDOWS_TTS_RATE", 0, -10, 10)),
      volume: Math.round(num("WINDOWS_TTS_VOLUME", 100, 0, 100)),
    },
    kokoro: {
      voice: str("KOKORO_VOICE", "af_heart"),
      speed: num("KOKORO_SPEED", 1, 0.5, 2),
      dtype: kokoroDtype(),
      modelDir: normalizeUserPath(str("KOKORO_MODEL_DIR", "./models")),
    },
    video: {
      width: Math.round(num("VIDEO_WIDTH", 1920, 320, 7680)),
      height: Math.round(num("VIDEO_HEIGHT", 1080, 240, 4320)),
      fps: Math.round(num("VIDEO_FPS", 30, 1, 120)),
      leadInSeconds: num("SLIDE_LEAD_IN_SECONDS", 0.3, 0, 10),
      tailSeconds: num("SLIDE_TAIL_SECONDS", 0.7, 0, 10),
      padColor,
      segmentConcurrency: Math.round(num("SEGMENT_CONCURRENCY", 2, 1, 16)),
    },
    courseTitleOverride: optional("COURSE_TITLE"),
    courseSlugOverride: optional("COURSE_SLUG"),
    toolPaths: {
      libreoffice: toolPath("LIBREOFFICE_PATH"),
      ffmpeg: toolPath("FFMPEG_PATH"),
      ffprobe: toolPath("FFPROBE_PATH"),
      pdftoppm: toolPath("PDFTOPPM_PATH"),
    },
  };
}
