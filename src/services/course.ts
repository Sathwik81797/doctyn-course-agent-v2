import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../utils/config.js";
import { ensureDir, exists, writeFileAtomic } from "../utils/files.js";
import { detectInputs, type InputFiles } from "./inputs.js";
import { parseDocx, type DocxParseResult } from "./parse-docx.js";
import { parsePptx, type PptxInfo } from "./parse-pptx.js";
import {
  formatMappingTable,
  formatValidationReport,
  resolveCourseIdentity,
  validateMapping,
  type CourseIdentity,
  type ValidationResult,
} from "./validation.js";

export interface CoursePaths {
  root: string;
  slides: string;
  audio: string;
  segments: string;
  source: string;
  qa: string;
  work: string;
  finalVideo: string;
  thumbnail: string;
  vtt: string;
  srt: string;
  transcript: string;
  courseJson: string;
  pptxCopy: string;
  docxCopy: string;
  validationError: string;
  mappingReport: string;
}

export function coursePaths(config: Config, slug: string): CoursePaths {
  const root = path.join(config.outputDir, slug);
  const qa = path.join(root, "qa");
  return {
    root,
    slides: path.join(root, "slides"),
    audio: path.join(root, "audio"),
    segments: path.join(root, "video-segments"),
    source: path.join(root, "source"),
    qa,
    work: path.join(config.tempDir, slug),
    finalVideo: path.join(root, "final-video.mp4"),
    thumbnail: path.join(root, "thumbnail.jpg"),
    vtt: path.join(root, "captions.vtt"),
    srt: path.join(root, "captions.srt"),
    transcript: path.join(root, "transcript.txt"),
    courseJson: path.join(root, "course.json"),
    pptxCopy: path.join(root, "presentation.pptx"),
    docxCopy: path.join(root, "voiceover-script.docx"),
    validationError: path.join(qa, "validation-error.txt"),
    mappingReport: path.join(qa, "slide-mapping.txt"),
  };
}

export interface LoadedCourse {
  inputs: InputFiles;
  pptx: PptxInfo;
  docx: DocxParseResult;
  identity: CourseIdentity;
  validation: ValidationResult;
  paths: CoursePaths;
}

/** Detect inputs, parse both documents and compare the slide/narration mapping. */
export async function loadCourse(config: Config): Promise<LoadedCourse> {
  const inputs = await detectInputs(config.inputDir);
  const pptx = await parsePptx(inputs.pptx);
  const docx = await parseDocx(inputs.docx);
  const identity = resolveCourseIdentity(config, pptx, docx);
  const validation = validateMapping(pptx, docx);
  return { inputs, pptx, docx, identity, validation, paths: coursePaths(config, identity.slug) };
}

/**
 * Write qa/slide-mapping.txt always, and qa/validation-error.txt on failure
 * (removing a stale one on success). Returns the human-readable report.
 */
export async function writeValidationFiles(course: LoadedCourse): Promise<string> {
  const { validation: v, paths, inputs } = course;
  const report = formatValidationReport(v, inputs.pptx, inputs.docx);
  const table = formatMappingTable(v);
  await ensureDir(paths.qa);
  await writeFileAtomic(paths.mappingReport, `${report}\n\nSlide mapping\n\n${table}\n`);
  if (v.ok) {
    await fs.rm(paths.validationError, { force: true });
  } else {
    await writeFileAtomic(
      paths.validationError,
      `VALIDATION FAILED — the final video was not created.\n` +
        `Generated: ${new Date().toISOString()}\n\n${report}\n\nSlide mapping\n\n${table}\n`,
    );
    // Do not let an older course.json claim a complete build for inputs that no longer validate.
    if (await exists(paths.courseJson)) {
      try {
        const json = JSON.parse(await fs.readFile(paths.courseJson, "utf8")) as Record<string, unknown>;
        json["status"] = "validation_failed";
        await writeFileAtomic(paths.courseJson, JSON.stringify(json, null, 2) + "\n");
      } catch {
        // unreadable course.json: leave it alone
      }
    }
  }
  return `${report}\n\n${table}`;
}
