import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import { run } from "../utils/exec.js";
import { ensureDir, exists, writeFileAtomic } from "../utils/files.js";
import { requireTool } from "../utils/tools.js";

/**
 * Local, offline TTS through Windows' built-in System.Speech (SAPI 5) voices,
 * driven by Windows PowerShell. Text is passed via a UTF-8 file, never on the
 * command line, so quotes, Greek letters and long narration are safe.
 */

export interface WindowsVoice {
  name: string;
  culture: string;
  gender: string;
}

const SCRIPT = `param(
  [string]$Mode = 'list',
  [string]$TextFile = '',
  [string]$OutFile = '',
  [string]$Voice = '',
  [int]$Rate = 0,
  [int]$Volume = 100
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($Mode -eq 'list') {
    $voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
      [pscustomobject]@{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = $_.VoiceInfo.Gender.ToString() }
    })
    ConvertTo-Json -InputObject $voices -Compress
  } else {
    if ($Voice) { $s.SelectVoice($Voice) }
    $s.Rate = $Rate
    $s.Volume = $Volume
    $s.SetOutputToWaveFile($OutFile)
    $s.Speak([System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8))
    $s.SetOutputToNull()
  }
} finally {
  $s.Dispose()
}
`;

function powershellPath(): string {
  const root = process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function scriptFile(config: Config): Promise<string> {
  const file = path.join(config.tempDir, "windows-tts", "speak.ps1");
  const current = (await exists(file)) ? await fs.readFile(file, "utf8") : "";
  if (current !== SCRIPT) await writeFileAtomic(file, SCRIPT);
  return file;
}

async function runScript(config: Config, args: string[], timeoutMs: number) {
  if (process.platform !== "win32") {
    throw new PipelineError(
      "TTS_PROVIDER=windows only works on Windows.",
      "Use TTS_PROVIDER=openai on this machine.",
    );
  }
  const ps = powershellPath();
  if (!(await exists(ps))) {
    throw new PipelineError(
      `Windows PowerShell was not found.\nChecked:\n  ${ps}`,
      "Windows local speech needs Windows PowerShell 5.1 (built into Windows 10/11).",
    );
  }
  return run(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", await scriptFile(config), ...args], {
    label: "Windows speech synthesis (PowerShell)",
    timeoutMs,
  });
}

export async function listWindowsVoices(config: Config): Promise<WindowsVoice[]> {
  const { stdout } = await runScript(config, ["-Mode", "list"], 60_000);
  try {
    const parsed = JSON.parse(stdout.trim() || "[]") as WindowsVoice[] | WindowsVoice;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new PipelineError(`Could not read the list of Windows voices. PowerShell returned:\n${stdout.trim()}`);
  }
}

function describe(v: WindowsVoice): string {
  return `${v.name} (${v.culture}, ${v.gender})`;
}

/** English preference order: British first (the scripts use British spelling), then US, then any English. */
function englishRank(v: WindowsVoice): number {
  const c = v.culture.toLowerCase();
  if (c === "en-gb") return 0;
  if (c === "en-us") return 1;
  if (c.startsWith("en")) return 2;
  return 99;
}

/**
 * The voice to use: WINDOWS_TTS_VOICE (exact, else unique partial match such as "Zira"),
 * or the best installed English voice when it is empty.
 */
export async function resolveWindowsVoice(config: Config): Promise<{ voice: WindowsVoice; automatic: boolean }> {
  const voices = await listWindowsVoices(config);
  const installed = voices.length ? voices.map((v) => `  - ${describe(v)}`).join("\n") : "  (none)";
  if (voices.length === 0) {
    throw new PipelineError(
      "No Windows speech voices are installed or enabled.",
      "Add one in Settings > Time & language > Speech > Manage voices, or use TTS_PROVIDER=openai.",
    );
  }

  const wanted = config.windowsTts.voice;
  if (wanted) {
    const lower = wanted.toLowerCase();
    const exact = voices.find((v) => v.name.toLowerCase() === lower);
    if (exact) return { voice: exact, automatic: false };
    const partial = voices.filter((v) => v.name.toLowerCase().includes(lower));
    if (partial.length === 1) return { voice: partial[0]!, automatic: false };
    throw new PipelineError(
      partial.length > 1
        ? `WINDOWS_TTS_VOICE="${wanted}" matches more than one installed voice.`
        : `WINDOWS_TTS_VOICE="${wanted}" is not an installed Windows voice.`,
      `Installed voices:\n${installed}\n\nSet WINDOWS_TTS_VOICE in .env to one of these names, or leave it empty to choose automatically.`,
    );
  }

  const english = voices.filter((v) => englishRank(v) < 99).sort((a, b) => englishRank(a) - englishRank(b));
  if (!english[0]) {
    throw new PipelineError(
      "No English Windows speech voice is installed.",
      `Installed voices:\n${installed}\n\nInstall an English voice (Settings > Time & language > Speech), or set WINDOWS_TTS_VOICE explicitly.`,
    );
  }
  return { voice: english[0], automatic: true };
}

export function describeWindowsVoice(v: WindowsVoice): string {
  return describe(v);
}

/** Speak `text` with System.Speech to WAV, then convert to MP3 with FFmpeg. */
export async function generateWindowsAudio(opts: {
  config: Config;
  voiceName: string;
  spokenText: string;
  out: string;
  workDir: string;
}): Promise<void> {
  const { config } = opts;
  const base = path.basename(opts.out, path.extname(opts.out));
  await ensureDir(opts.workDir);
  const textFile = path.join(opts.workDir, `${base}.txt`);
  const wav = path.join(opts.workDir, `${base}.wav`);
  await fs.writeFile(textFile, opts.spokenText, "utf8");
  await fs.rm(wav, { force: true });

  await runScript(
    config,
    [
      "-Mode", "speak",
      "-TextFile", textFile,
      "-OutFile", wav,
      "-Voice", opts.voiceName,
      "-Rate", String(config.windowsTts.rate),
      "-Volume", String(config.windowsTts.volume),
    ],
    30 * 60_000,
  );

  const st = await fs.stat(wav).catch(() => null);
  if (!st || st.size <= 44) {
    throw new PipelineError(`Windows speech synthesis produced no audio for ${base}.\nExpected: ${wav}`);
  }

  const partial = opts.out.replace(/\.mp3$/i, ".partial.mp3");
  await ensureDir(path.dirname(opts.out));
  await run(
    requireTool("ffmpeg", config),
    ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", wav, "-c:a", "libmp3lame", "-q:a", "2", partial],
    { label: "FFmpeg (WAV → MP3)", timeoutMs: 10 * 60_000 },
  );
  await fs.rename(partial, opts.out);
  await fs.rm(wav, { force: true });
  await fs.rm(textFile, { force: true });
}
