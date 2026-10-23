import fs from "node:fs/promises";
import path from "node:path";
import { exists, isOfficeTempFile } from "../utils/files.js";

export interface FileInfo {
  path: string;
  bytes: number;
}

export interface CourseSummary {
  slug: string;
  title: string;
  /** complete = final validation passed and final-video.mp4 is present. */
  status: "complete" | "failed" | "incomplete";
  slideCount: number | null;
  durationSeconds: number | null;
  generatedAt: string | null;
  updatedAt: string | null;
  tts: string | null;
  files: {
    video: FileInfo | null;
    thumbnail: FileInfo | null;
    vtt: FileInfo | null;
    srt: FileInfo | null;
    transcript: FileInfo | null;
  };
}

export interface PreviewSet {
  slug: string;
  voice: string;
  generatedAt: string;
  clips: Array<{ path: string; slide: number; seconds: number | null; title: string | null; bytes: number }>;
}

export interface InputSummary {
  pptx: Array<{ name: string; bytes: number; modifiedAt: string }>;
  docx: Array<{ name: string; bytes: number; modifiedAt: string }>;
}

async function fileInfo(root: string, rel: string): Promise<FileInfo | null> {
  try {
    const st = await fs.stat(path.join(root, rel));
    return st.isFile() && st.size > 0 ? { path: rel, bytes: st.size } : null;
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function courseDirs(outputDir: string): Promise<string[]> {
  if (!(await exists(outputDir))) return [];
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
}

function humanize(slug: string): string {
  const s = slug.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Every course folder in the output directory, described only by what is actually on disk. */
export async function listCourses(outputDir: string): Promise<CourseSummary[]> {
  const out: CourseSummary[] = [];
  for (const slug of await courseDirs(outputDir)) {
    const root = path.join(outputDir, slug);
    const course = await readJson(path.join(root, "course.json"));
    const checkpoint = await readJson(path.join(root, "checkpoint.json"));
    if (!course && !checkpoint) continue;

    const files = {
      video: await fileInfo(root, "final-video.mp4"),
      thumbnail: await fileInfo(root, "thumbnail.jpg"),
      vtt: await fileInfo(root, "captions.vtt"),
      srt: await fileInfo(root, "captions.srt"),
      transcript: await fileInfo(root, "transcript.txt"),
    };
    const stages = (checkpoint?.stages ?? {}) as Record<string, unknown>;
    const finalPassed = Boolean(stages["final_validation"]);
    let status: CourseSummary["status"] = "incomplete";
    if (course?.status === "complete" && finalPassed && files.video) status = "complete";
    else if (course?.status === "failed") status = "failed";

    const tts = course?.tts as { description?: string } | undefined;
    out.push({
      slug,
      title: typeof course?.courseTitle === "string" && course.courseTitle ? course.courseTitle : humanize(slug),
      status,
      slideCount: typeof course?.slideCount === "number" ? course.slideCount : null,
      durationSeconds: typeof course?.durationSeconds === "number" ? course.durationSeconds : null,
      generatedAt: typeof course?.generatedAt === "string" ? course.generatedAt : null,
      updatedAt: typeof checkpoint?.updatedAt === "string" ? checkpoint.updatedAt : null,
      tts: tts?.description ?? null,
      files,
    });
  }
  return out.sort((a, b) => (b.generatedAt ?? b.updatedAt ?? "").localeCompare(a.generatedAt ?? a.updatedAt ?? ""));
}

/** Voice previews written by `npm run preview-tts` (output/<course>/qa/tts-preview/<voice>/). */
export async function listPreviews(outputDir: string): Promise<PreviewSet[]> {
  const sets: PreviewSet[] = [];
  for (const slug of await courseDirs(outputDir)) {
    const base = path.join(outputDir, slug, "qa", "tts-preview");
    if (!(await exists(base))) continue;
    for (const voice of await fs.readdir(base, { withFileTypes: true })) {
      if (!voice.isDirectory()) continue;
      const dir = path.join(base, voice.name);
      const meta = new Map<string, { seconds: number; title: string }>();
      let generatedAt: string | null = null;
      try {
        const text = await fs.readFile(path.join(dir, "preview.txt"), "utf8");
        generatedAt = /^Generated: (.+)$/m.exec(text)?.[1]?.trim() ?? null;
        for (const m of text.matchAll(/^(slide-\d+\.mp3)\s+([\d.]+)s\s+(.+)$/gm)) {
          meta.set(m[1]!, { seconds: Number(m[2]), title: m[3]!.trim() });
        }
      } catch {
        // preview.txt is optional
      }
      const clips: PreviewSet["clips"] = [];
      let newest = 0;
      for (const name of (await fs.readdir(dir)).sort()) {
        const m = /^slide-(\d+)\.mp3$/i.exec(name);
        if (!m) continue;
        const st = await fs.stat(path.join(dir, name));
        newest = Math.max(newest, st.mtimeMs);
        const info = meta.get(name);
        clips.push({
          path: `qa/tts-preview/${voice.name}/${name}`,
          slide: Number(m[1]),
          seconds: info?.seconds ?? null,
          title: info?.title ?? null,
          bytes: st.size,
        });
      }
      if (clips.length) {
        sets.push({ slug, voice: voice.name, generatedAt: generatedAt ?? new Date(newest).toISOString(), clips });
      }
    }
  }
  return sets.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export async function listInputs(inputDir: string): Promise<InputSummary> {
  const result: InputSummary = { pptx: [], docx: [] };
  if (!(await exists(inputDir))) return result;
  for (const e of await fs.readdir(inputDir, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith(".") || isOfficeTempFile(e.name)) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (ext !== ".pptx" && ext !== ".docx") continue;
    const st = await fs.stat(path.join(inputDir, e.name));
    result[ext === ".pptx" ? "pptx" : "docx"].push({ name: e.name, bytes: st.size, modifiedAt: st.mtime.toISOString() });
  }
  return result;
}

/** A filename safe on Windows that keeps the user's name recognisable. */
export function safeUploadName(raw: string, ext: ".pptx" | ".docx"): string {
  let name = path.basename(raw.replace(/\\/g, "/"));
  name = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/^[.\s~$]+/, "").trim();
  if (!name.toLowerCase().endsWith(ext)) name = `${name || "upload"}${ext}`;
  if (name.length > 180) name = name.slice(0, 180 - ext.length) + ext;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
