import { spawn } from "node:child_process";
import path from "node:path";
import { PipelineError } from "./errors.js";

export interface RunOptions {
  /** Human name used in error messages, e.g. "FFmpeg". */
  label: string;
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Called with each stdout chunk (e.g. FFmpeg -progress output). */
  onStdout?: (chunk: string) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE = 2 * 1024 * 1024;

function quoteForDisplay(arg: string): string {
  return /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function tail(text: string, lines: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

/**
 * Run an executable without a shell (no quoting problems with spaces in
 * Windows paths) and capture its output. Failures become PipelineErrors
 * that include the command and the last lines of stderr.
 */
export function run(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      opts.onStdout?.(d);
      if (stdout.length < MAX_CAPTURE) stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr = (stderr + d).slice(-MAX_CAPTURE);
    });

    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, opts.timeoutMs)
        : undefined;

    const display = [command, ...args].map(quoteForDisplay).join(" ");

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new PipelineError(
            `${opts.label} could not be started: executable not found.\nTried: ${command}`,
            `Install ${opts.label} or set its path in .env.`,
          ),
        );
      } else {
        reject(new PipelineError(`${opts.label} could not be started: ${err.message}\nCommand: ${display}`));
      }
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(
          new PipelineError(
            `${opts.label} did not finish within ${Math.round((opts.timeoutMs ?? 0) / 1000)} seconds and was stopped.\nCommand: ${display}`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const output = tail(stderr || stdout, 25);
      reject(
        new PipelineError(
          `${opts.label} failed (${signal ? `signal ${signal}` : `exit code ${code}`}).\n` +
            `Command:\n  ${display}\n` +
            (output ? `\nLast output from ${opts.label}:\n${output}` : `\n${opts.label} produced no output.`),
        ),
      );
    });
  });
}

/** Forward-slash path, which FFmpeg and LibreOffice accept on every platform. */
export function toForwardSlashes(p: string): string {
  return p.split(path.sep).join("/");
}

/** file:/// URL for LibreOffice's -env:UserInstallation. */
export function toFileUrl(p: string): string {
  const abs = toForwardSlashes(path.resolve(p));
  const encoded = abs
    .split("/")
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}
