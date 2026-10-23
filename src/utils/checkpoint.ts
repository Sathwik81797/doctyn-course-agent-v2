import fs from "node:fs/promises";
import path from "node:path";
import { allNonEmpty, exists, pad3, writeFileAtomic } from "./files.js";

export const STAGES = [
  "input_detected",
  "pptx_parsed",
  "docx_parsed",
  "validated",
  "audio_generated",
  "slides_rendered",
  "segments_generated",
  "captions_generated",
  "video_generated",
  "final_validation",
] as const;

export type Stage = (typeof STAGES)[number];

export interface StageRecord {
  status: "complete";
  completedAt: string;
  /** Hash of everything the stage's output depends on. A different key means "redo". */
  key: string;
  /** Output files, relative to the course folder. */
  files: string[];
  data?: Record<string, unknown>;
}

export interface SlideRecord {
  /** TTS provider fingerprint (provider|model|voice|settings) that produced this slide's MP3. */
  audioProvider?: string;
  audioKey?: string;
  audioDurationSeconds?: number;
  segmentKey?: string;
  segmentDurationSeconds?: number;
}

interface CheckpointData {
  version: 1;
  courseSlug: string;
  updatedAt: string;
  stages: Partial<Record<Stage, StageRecord>>;
  slides: Record<string, SlideRecord>;
}

/**
 * checkpoint.json inside the course folder. Every stage stores a content key;
 * a stage is reused only when its key still matches and its files still exist,
 * so a failure late in the pipeline never forces paid TTS to run again.
 */
export class Checkpoint {
  private constructor(
    readonly file: string,
    readonly courseDir: string,
    private data: CheckpointData,
  ) {}

  static async load(courseDir: string, courseSlug: string): Promise<Checkpoint> {
    const file = path.join(courseDir, "checkpoint.json");
    let data: CheckpointData = { version: 1, courseSlug, updatedAt: new Date().toISOString(), stages: {}, slides: {} };
    if (await exists(file)) {
      try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<CheckpointData>;
        if (parsed.version === 1 && parsed.stages && parsed.slides) {
          data = { ...data, stages: parsed.stages, slides: parsed.slides };
        } else {
          console.warn("  ! checkpoint.json has an unknown format; starting fresh.");
        }
      } catch {
        console.warn("  ! checkpoint.json could not be read (corrupt?); starting fresh.");
      }
    }
    return new Checkpoint(file, courseDir, data);
  }

  get(stage: Stage): StageRecord | undefined {
    return this.data.stages[stage];
  }

  /** Stage complete with the same key, and every recorded output file still present. */
  async isReusable(stage: Stage, key: string): Promise<boolean> {
    const rec = this.data.stages[stage];
    if (!rec || rec.status !== "complete" || rec.key !== key) return false;
    return allNonEmpty(rec.files.map((f) => path.join(this.courseDir, f)));
  }

  async complete(stage: Stage, key: string, absFiles: string[], data?: Record<string, unknown>): Promise<void> {
    const rec: StageRecord = {
      status: "complete",
      completedAt: new Date().toISOString(),
      key,
      files: absFiles.map((f) => path.relative(this.courseDir, f).split(path.sep).join("/")),
    };
    if (data) rec.data = data;
    this.data.stages[stage] = rec;
    await this.save();
  }

  async invalidate(stage: Stage): Promise<void> {
    if (this.data.stages[stage]) {
      delete this.data.stages[stage];
      await this.save();
    }
  }

  slide(n: number): SlideRecord {
    const id = pad3(n);
    return (this.data.slides[id] ??= {});
  }

  private saving: Promise<void> = Promise.resolve();

  /** Saves are serialized: parallel workers may call this at the same time. */
  save(): Promise<void> {
    const write = async () => {
      this.data.updatedAt = new Date().toISOString();
      const ordered: CheckpointData = {
        ...this.data,
        stages: Object.fromEntries(STAGES.filter((s) => this.data.stages[s]).map((s) => [s, this.data.stages[s]])),
      };
      await writeFileAtomic(this.file, JSON.stringify(ordered, null, 2) + "\n");
    };
    this.saving = this.saving.then(write, write);
    return this.saving;
  }
}
