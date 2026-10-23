import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { PipelineError } from "./errors.js";

export type ToolName = "ffmpeg" | "ffprobe" | "libreoffice" | "pdftoppm";

export interface ToolLocation {
  path: string;
  source: "env" | "known-location" | "PATH";
}

interface ToolSpec {
  label: string;
  envVar: string;
  commands: string[];
  knownLocations: string[];
  installHint: string;
}

const programFiles = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"]
  .filter((p): p is string => Boolean(p))
  .filter((p, i, all) => all.indexOf(p) === i);

const SPECS: Record<ToolName, ToolSpec> = {
  ffmpeg: {
    label: "FFmpeg",
    envVar: "FFMPEG_PATH",
    commands: ["ffmpeg"],
    knownLocations:
      process.platform === "win32"
        ? ["C:\\ffmpeg\\bin\\ffmpeg.exe", ...programFiles.map((p) => path.join(p, "ffmpeg", "bin", "ffmpeg.exe"))]
        : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"],
    installHint: "Install FFmpeg (Git Bash / PowerShell: winget install Gyan.FFmpeg), restart the terminal, or set FFMPEG_PATH in .env.",
  },
  ffprobe: {
    label: "ffprobe",
    envVar: "FFPROBE_PATH",
    commands: ["ffprobe"],
    knownLocations:
      process.platform === "win32"
        ? ["C:\\ffmpeg\\bin\\ffprobe.exe", ...programFiles.map((p) => path.join(p, "ffmpeg", "bin", "ffprobe.exe"))]
        : ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe", "/opt/homebrew/bin/ffprobe"],
    installHint: "ffprobe ships with FFmpeg (winget install Gyan.FFmpeg). Restart the terminal, or set FFPROBE_PATH in .env.",
  },
  libreoffice: {
    label: "LibreOffice",
    envVar: "LIBREOFFICE_PATH",
    commands: ["soffice", "libreoffice"],
    knownLocations:
      process.platform === "win32"
        ? programFiles.map((p) => path.join(p, "LibreOffice", "program", "soffice.exe"))
        : process.platform === "darwin"
          ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
          : ["/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice"],
    installHint: "Install LibreOffice (https://www.libreoffice.org/download/) or configure LIBREOFFICE_PATH in .env.",
  },
  pdftoppm: {
    label: "pdftoppm (Poppler)",
    envVar: "PDFTOPPM_PATH",
    commands: ["pdftoppm"],
    knownLocations: process.platform === "win32" ? [] : ["/usr/bin/pdftoppm", "/usr/local/bin/pdftoppm", "/opt/homebrew/bin/pdftoppm"],
    installHint: "Optional. The built-in MuPDF renderer is used when pdftoppm is not installed.",
  },
};

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function pathCandidates(command: string): string[] {
  const dirs = (process.env["PATH"] ?? process.env["Path"] ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((e) => e.toLowerCase())
      : [""];
  const out: string[] = [];
  for (const dir of dirs) {
    const clean = dir.replace(/^"|"$/g, "");
    for (const ext of exts) out.push(path.join(clean, command + ext));
  }
  return out;
}

const cache = new Map<ToolName, ToolLocation | null>();

export function locateTool(name: ToolName, config: Config): { found: ToolLocation | null; checked: string[] } {
  const spec = SPECS[name];
  const checked: string[] = [];

  const fromEnv = config.toolPaths[name];
  if (fromEnv) {
    checked.push(`${fromEnv}  (${spec.envVar})`);
    if (isFile(fromEnv)) return { found: { path: fromEnv, source: "env" }, checked };
  }
  for (const loc of spec.knownLocations) {
    checked.push(loc);
    if (isFile(loc)) return { found: { path: loc, source: "known-location" }, checked };
  }
  checked.push(`PATH (${spec.commands.join(", ")})`);
  for (const cmd of spec.commands) {
    const hit = pathCandidates(cmd).find(isFile);
    if (hit) return { found: { path: hit, source: "PATH" }, checked };
  }
  return { found: null, checked };
}

/** Resolve a tool or throw a readable error listing every place that was checked. */
export function requireTool(name: ToolName, config: Config): string {
  const cached = cache.get(name);
  if (cached) return cached.path;
  const spec = SPECS[name];
  const { found, checked } = locateTool(name, config);
  if (!found) {
    throw new PipelineError(
      `${spec.label} was not found.\nChecked:\n${checked.map((c) => `  ${c}`).join("\n")}`,
      spec.installHint,
    );
  }
  if (config.toolPaths[name] && found.source !== "env") {
    console.warn(`  ! ${spec.envVar} in .env does not point to a file; using ${found.path} instead.`);
  }
  cache.set(name, found);
  return found.path;
}

export function findOptionalTool(name: ToolName, config: Config): string | null {
  return locateTool(name, config).found?.path ?? null;
}

export function toolLabel(name: ToolName): string {
  return SPECS[name].label;
}

export function toolInstallHint(name: ToolName): string {
  return SPECS[name].installHint;
}
