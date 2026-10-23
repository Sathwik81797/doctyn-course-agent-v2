/**
 * Turns the CLI's console output into structured progress for the dashboard.
 * The CLI scripts stay the single source of truth; this only reads what they print.
 */
export const JOB_KINDS = ["validate", "preview-tts", "build-course"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type StageStatus = "pending" | "running" | "done" | "reused" | "failed";

export interface StageProgress {
  name: string;
  label: string;
  status: StageStatus;
  detail: string;
}

export interface Progress {
  percent: number;
  stage: string | null;
  detail: string;
  eta: string | null;
  stages: StageProgress[];
}

/** Build stages in the order build-course runs them, with rough relative cost for the progress bar. */
const BUILD_STAGES: Array<{ name: string; label: string; weight: number }> = [
  { name: "input_detected", label: "Inputs detected", weight: 1 },
  { name: "pptx_parsed", label: "Presentation parsed", weight: 1 },
  { name: "docx_parsed", label: "Voiceover script parsed", weight: 1 },
  { name: "validated", label: "Slides matched to narration", weight: 1 },
  { name: "slides_rendered", label: "Slides rendered", weight: 10 },
  { name: "audio_generated", label: "Narration audio", weight: 50 },
  { name: "segments_generated", label: "Video segments", weight: 20 },
  { name: "captions_generated", label: "Captions & transcript", weight: 1 },
  { name: "video_generated", label: "Final MP4", weight: 12 },
  { name: "final_validation", label: "Final validation", weight: 2 },
];

const STAGE_LINE = /^\[(\d+)\/(\d+)\] (\w+)(?: — (.*))?$/;
const COUNTER = /\((\d+)\/(\d+)(?:, ~(.+?) left)?\)\s*$/;
const RENDERED = /^rendered (\d+)\/(\d+)$/;

export class ProgressTracker {
  private stages: StageProgress[];
  private current = -1;
  private sub = 0;
  private reusedInStage = false;
  private eta: string | null = null;
  private detail = "Starting…";
  private previewTotal = 0;
  private previewDone = 0;
  private inErrorBlock = false;
  private errorLines: string[] = [];
  private failLines: string[] = [];
  private summaryLines: string[] = [];
  private awaitingOutputPath = false;
  /** Course output folder, as printed by build-course ("Output: <path>"). */
  outputPath: string | null = null;

  constructor(readonly kind: JobKind) {
    this.stages =
      kind === "build-course"
        ? BUILD_STAGES.map((s) => ({ name: s.name, label: s.label, status: "pending", detail: "" }))
        : [];
  }

  push(rawLine: string): void {
    const line = rawLine.replace(/\s+$/, "");
    const text = line.trim();
    if (!text) return;

    if (text === "ERROR") {
      this.inErrorBlock = true;
      return;
    }
    if (this.inErrorBlock) {
      if (!/^-+$/.test(text)) this.errorLines.push(text);
      return;
    }

    if (this.awaitingOutputPath) {
      this.awaitingOutputPath = false;
      this.summaryLines.push(`Output: ${text}`);
      return;
    }

    const stage = STAGE_LINE.exec(text);
    if (stage && this.kind === "build-course") {
      this.enterStage(stage[3]!, stage[4] ?? "");
      return;
    }

    if (this.kind === "build-course") {
      if (text.startsWith("Output: ") && !this.outputPath) {
        this.outputPath = text.slice("Output: ".length).trim();
        return;
      }
      if (text === "Output:") {
        this.awaitingOutputPath = true;
        return;
      }
      if (/^(COURSE BUILD|Course:|Slides:|Voiceovers:|Audio files:|Video segments:|Duration:|Build time:|Validation:)/.test(text)) {
        this.summaryLines.push(text);
      }
    }

    if (this.kind === "preview-tts") {
      const slides = /^Slides: (.+)$/.exec(text);
      if (slides) this.previewTotal = slides[1]!.split(",").length;
      if (/^✓ slide-\d+\.mp3/.test(text)) this.previewDone++;
      if (text.startsWith("PREVIEW READY")) this.summaryLines.push(text);
    }

    if (this.kind === "validate" && /^VALIDATION (PASSED|FAILED)/.test(text)) {
      this.summaryLines.push(text);
    }

    if (text.startsWith("✗ ")) this.failLines.push(text.slice(2));
    if (text.startsWith("↺ ")) this.reusedInStage = true;

    const counter = COUNTER.exec(text) ?? RENDERED.exec(text);
    if (counter) {
      const done = Number(counter[1]);
      const total = Number(counter[2]);
      if (total > 0) this.sub = Math.min(1, done / total);
      this.eta = counter[3] ?? null;
    }

    this.detail = text.replace(/^[✓↺!✗]\s*/, "");
    const cur = this.stages[this.current];
    if (cur) cur.detail = this.detail;
  }

  private enterStage(name: string, detail: string): void {
    const idx = this.stages.findIndex((s) => s.name === name);
    if (idx < 0) return;
    this.closeCurrent();
    this.current = idx;
    this.sub = 0;
    this.eta = null;
    this.reusedInStage = false;
    const s = this.stages[idx]!;
    s.status = "running";
    s.detail = detail;
    this.detail = `${s.label}${detail ? ` — ${detail}` : ""}`;
  }

  private closeCurrent(): void {
    const cur = this.stages[this.current];
    if (cur && cur.status === "running") cur.status = this.reusedInStage ? "reused" : "done";
  }

  /** Called when the process exits. */
  finish(succeeded: boolean): void {
    if (succeeded) {
      this.closeCurrent();
      this.sub = 1;
      this.eta = null;
    } else {
      const cur = this.stages[this.current];
      if (cur && cur.status === "running") cur.status = "failed";
    }
  }

  get errorMessage(): string | null {
    if (this.errorLines.length) return this.errorLines.join("\n");
    if (this.failLines.length) return this.failLines.join("\n");
    return null;
  }

  get summary(): string | null {
    return this.summaryLines.length ? this.summaryLines.join("\n") : null;
  }

  snapshot(): Progress {
    let percent = 0;
    if (this.kind === "build-course") {
      const total = BUILD_STAGES.reduce((a, s) => a + s.weight, 0);
      let done = 0;
      BUILD_STAGES.forEach((s, i) => {
        const st = this.stages[i]!.status;
        if (st === "done" || st === "reused") done += s.weight;
        else if (i === this.current) done += s.weight * this.sub;
      });
      percent = (done / total) * 100;
    } else if (this.kind === "preview-tts") {
      percent = this.previewTotal ? (this.previewDone / this.previewTotal) * 100 : 0;
    } else {
      percent = this.summaryLines.length ? 100 : 0;
    }
    const cur = this.stages[this.current];
    return {
      percent: Math.round(Math.min(100, percent) * 10) / 10,
      stage: cur ? cur.name : null,
      detail: this.detail,
      eta: this.eta,
      stages: this.stages.map((s) => ({ ...s })),
    };
  }
}
