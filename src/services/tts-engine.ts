import type OpenAI from "openai";
import type { Config, TtsProvider } from "../utils/config.js";
import { sha256 } from "../utils/files.js";
import { createTtsClient, generateSlideAudio } from "./tts.js";
import { describeKokoroVoice, generateKokoroAudio, KOKORO_MODEL_ID, resolveKokoroVoice } from "./tts-kokoro.js";
import { describeWindowsVoice, generateWindowsAudio, resolveWindowsVoice } from "./tts-windows.js";

/**
 * One interface over the three TTS providers.
 *
 * `fingerprint` identifies provider + model + voice + settings in readable form and
 * is stored per slide in checkpoint.json. `keyFor(text)` hashes fingerprint-level
 * settings together with the spoken text; a slide's audio is reused only when its
 * stored key matches, so audio from one provider/voice is never silently reused
 * for another.
 */
export interface TtsEngine {
  provider: TtsProvider;
  fingerprint: string;
  /** Human-readable, for logs. */
  description: string;
  /** Short folder-safe label, e.g. "kokoro-af_heart-1.0x". */
  label: string;
  concurrency: number;
  /** True when each generate() call costs money. */
  paid: boolean;
  keyFor(spokenText: string): string;
  generate(opts: { spokenText: string; out: string; workDir: string; slideLabel: string; onStatus?: (msg: string) => void }): Promise<void>;
}

export async function createTtsEngine(config: Config): Promise<TtsEngine> {
  switch (config.tts.provider) {
    case "openai": {
      const t = config.tts;
      let client: OpenAI | undefined; // created on first use, so fully-cached builds need no key
      return {
        provider: "openai",
        fingerprint: `openai|${t.model}|${t.voice}|speed=${t.speed}|instructions=${t.instructions ? sha256(t.instructions).slice(0, 12) : "none"}`,
        description: `OpenAI ${t.model}, voice ${t.voice}`,
        label: `openai-${t.model}-${t.voice}`,
        concurrency: t.concurrency,
        paid: true,
        // Unchanged from earlier versions so existing OpenAI audio checkpoints stay valid.
        keyFor: (text) => sha256("tts-v1", t.provider, t.model, t.voice, t.instructions, t.speed, text),
        generate: async (o) => {
          client ??= createTtsClient(config);
          await generateSlideAudio({ client, config, spokenText: o.spokenText, out: o.out, workDir: o.workDir, slideLabel: o.slideLabel });
        },
      };
    }

    case "windows": {
      const { voice, automatic } = await resolveWindowsVoice(config);
      const w = config.windowsTts;
      return {
        provider: "windows",
        fingerprint: `windows|${voice.name}|rate=${w.rate}|volume=${w.volume}`,
        description: `Windows local speech, voice ${describeWindowsVoice(voice)}${automatic ? " [chosen automatically]" : ""}, rate ${w.rate}, volume ${w.volume}`,
        label: `windows-${voice.name.replace(/^Microsoft\s+|\s+Desktop$/gi, "").replace(/\W+/g, "_")}-rate${w.rate}`,
        concurrency: config.tts.concurrency,
        paid: false,
        // Unchanged from earlier versions so existing Windows audio checkpoints stay valid.
        keyFor: (text) => sha256("tts-windows-v1", voice.name, w.rate, w.volume, text),
        generate: (o) => generateWindowsAudio({ config, voiceName: voice.name, spokenText: o.spokenText, out: o.out, workDir: o.workDir }),
      };
    }

    case "kokoro": {
      const voice = await resolveKokoroVoice(config);
      const k = config.kokoro;
      const speed = k.speed.toFixed(2).replace(/0$/, "");
      return {
        provider: "kokoro",
        fingerprint: `kokoro|${KOKORO_MODEL_ID}|${k.dtype}|${voice.id}|speed=${k.speed}`,
        description: `Kokoro-82M local neural TTS (${k.dtype}), voice ${describeKokoroVoice(voice)}, speed ${speed}`,
        label: `kokoro-${voice.id}-${speed}x`,
        // One in-process model; ONNX Runtime already uses all CPU cores.
        concurrency: 1,
        paid: false,
        keyFor: (text) => sha256("tts-kokoro-v1", KOKORO_MODEL_ID, k.dtype, voice.id, k.speed, text),
        generate: (o) =>
          generateKokoroAudio({
            config,
            spokenText: o.spokenText,
            out: o.out,
            workDir: o.workDir,
            ...(o.onStatus ? { onStatus: o.onStatus } : {}),
          }),
      };
    }
  }
}
