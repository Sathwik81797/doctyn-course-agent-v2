import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { ensureDir, exists, writeFileAtomic } from "../utils/files.js";
import { ProgressTracker, type JobKind, type Progress } from "./progress.js";

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface JobRecord {
  id: string;
  kind: JobKind;
  args: string[];
  status: JobStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  summary: string | null;
  error: string | null;
  courseSlug: string | null;
  progress: Progress;
}

export interface UploadRecord {
  id: string;
  kind: "upload";
  at: string;
  files: Array<{ type: "pptx" | "docx"; name: string; bytes: number }>;
  replaced: string[];
}

interface ActivityFile {
  jobs: JobRecord[];
  uploads: UploadRecord[];
}

const SCRIPTS: Record<JobKind, string> = {
  validate: "src/validate.ts",
  "preview-tts": "src/preview-tts.ts",
  "build-course": "src/build-course.ts",
};

const MAX_HISTORY = 50;
const MAX_LOG_LINES = 20000;

interface Running {
  record: JobRecord;
  child: ChildProcess;
  tracker: ProgressTracker;
  lines: string[];
  logStream: WriteStream;
  cancelled: boolean;
}

export class BusyError extends Error {}

/**
 * Runs the existing CLI scripts as child processes, one at a time
 * (Kokoro, LibreOffice and FFmpeg all want the whole machine).
 * History and logs live in <output>/.dashboard/.
 */
export class JobManager {
  private running: Running | null = null;
  private data: ActivityFile = { jobs: [], uploads: [] };
  private readonly stateFile: string;
  private readonly logDir: string;
  /** Log lines of finished jobs kept in memory for quick access. */
  private finishedLines = new Map<string, string[]>();

  constructor(
    private readonly projectRoot: string,
    dashboardDir: string,
    private readonly runner: { command: string; prefixArgs: string[] } = {
      command: process.execPath,
      prefixArgs: [path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs")],
    },
  ) {
    this.stateFile = path.join(dashboardDir, "activity.json");
    this.logDir = path.join(dashboardDir, "logs");
  }

  async load(): Promise<void> {
    await ensureDir(this.logDir);
    if (await exists(this.stateFile)) {
      try {
        const parsed = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as Partial<ActivityFile>;
        this.data = { jobs: parsed.jobs ?? [], uploads: parsed.uploads ?? [] };
      } catch {
        this.data = { jobs: [], uploads: [] };
      }
    }
    // A job still marked running belongs to a previous server process that stopped.
    let changed = false;
    for (const j of this.data.jobs) {
      if (j.status === "running") {
        j.status = "interrupted";
        j.endedAt ??= new Date().toISOString();
        j.error ??= "The dashboard server stopped while this job was running.";
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  private async save(): Promise<void> {
    this.data.jobs = this.data.jobs.slice(0, MAX_HISTORY);
    this.data.uploads = this.data.uploads.slice(0, MAX_HISTORY);
    await writeFileAtomic(this.stateFile, JSON.stringify(this.data, null, 2) + "\n");
  }

  get current(): JobRecord | null {
    return this.running ? this.liveRecord(this.running) : null;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  private liveRecord(r: Running): JobRecord {
    r.record.progress = r.tracker.snapshot();
    return r.record;
  }

  start(kind: JobKind, args: string[] = []): JobRecord {
    if (this.running) throw new BusyError(`A ${this.running.record.kind} job is already running.`);
    const tracker = new ProgressTracker(kind);
    const record: JobRecord = {
      id: `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      kind,
      args,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      courseSlug: null,
      progress: tracker.snapshot(),
    };
    const child = spawn(this.runner.command, [...this.runner.prefixArgs, SCRIPTS[kind], ...args], {
      cwd: this.projectRoot,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logStream = createWriteStream(path.join(this.logDir, `${record.id}.log`), { flags: "w" });
    const r: Running = { record, child, tracker, lines: [], logStream, cancelled: false };
    this.running = r;

    const onLine = (line: string) => {
      if (r.lines.length < MAX_LOG_LINES) r.lines.push(line);
      logStream.write(line + "\n");
      tracker.push(line);
      if (tracker.outputPath && !record.courseSlug) record.courseSlug = path.basename(tracker.outputPath);
    };
    lineReader(child.stdout!, onLine);
    lineReader(child.stderr!, onLine);

    let settled = false;
    const finish = (code: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      const ok = code === 0 && !spawnError;
      tracker.finish(ok);
      record.exitCode = code;
      record.endedAt = new Date().toISOString();
      record.status = r.cancelled ? "cancelled" : ok ? "succeeded" : "failed";
      record.summary = tracker.summary;
      record.error = spawnError
        ? `Could not start ${SCRIPTS[kind]}: ${spawnError.message}`
        : r.cancelled
          ? "Cancelled from the dashboard."
          : ok
            ? null
            : (tracker.errorMessage ?? `The ${kind} command exited with code ${code}. See the log for details.`);
      record.progress = tracker.snapshot();
      logStream.end();
      this.finishedLines.set(record.id, r.lines);
      if (this.finishedLines.size > 5) this.finishedLines.delete(this.finishedLines.keys().next().value!);
      this.running = null;
      this.data.jobs.unshift(record);
      void this.save();
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
    return record;
  }

  cancel(id: string): boolean {
    const r = this.running;
    if (!r || r.record.id !== id) return false;
    r.cancelled = true;
    const pid = r.child.pid;
    if (process.platform === "win32" && pid) {
      // tsx runs the script in a grandchild process; kill the whole tree.
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      r.child.kill("SIGTERM");
    }
    return true;
  }

  get(id: string): JobRecord | null {
    if (this.running?.record.id === id) return this.liveRecord(this.running);
    return this.data.jobs.find((j) => j.id === id) ?? null;
  }

  async lines(id: string, after: number): Promise<string[]> {
    const live = this.running?.record.id === id ? this.running.lines : this.finishedLines.get(id);
    if (live) return live.slice(after);
    if (!/^[\w-]+$/.test(id)) return [];
    const file = path.join(this.logDir, `${id}.log`);
    if (!(await exists(file))) return [];
    const text = await fs.readFile(file, "utf8");
    return text.split("\n").filter((l, i, all) => i < all.length - 1 || l !== "").slice(after);
  }

  async recordUpload(files: UploadRecord["files"], replaced: string[]): Promise<UploadRecord> {
    const rec: UploadRecord = { id: randomUUID(), kind: "upload", at: new Date().toISOString(), files, replaced };
    this.data.uploads.unshift(rec);
    await this.save();
    return rec;
  }

  activity(limit = 30): Array<JobRecord | UploadRecord> {
    const jobs: JobRecord[] = [...(this.running ? [this.liveRecord(this.running)] : []), ...this.data.jobs];
    const items: Array<{ at: string; item: JobRecord | UploadRecord }> = [
      ...jobs.map((j) => ({ at: j.startedAt, item: j as JobRecord | UploadRecord })),
      ...this.data.uploads.map((u) => ({ at: u.at, item: u as JobRecord | UploadRecord })),
    ];
    return items
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit)
      .map((x) => x.item);
  }
}

function lineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    const parts = buf.split(/\r?\n|\r/);
    buf = parts.pop() ?? "";
    for (const p of parts) onLine(p);
  });
  stream.on("end", () => {
    if (buf) onLine(buf);
    buf = "";
  });
}
