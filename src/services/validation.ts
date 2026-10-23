import path from "node:path";
import type { Config } from "../utils/config.js";
import { padLabel } from "../utils/files.js";
import { slugify } from "../utils/slug.js";
import type { DocxParseResult, MalformedHeading, NarrationRecord } from "./parse-docx.js";
import type { PptxInfo } from "./parse-pptx.js";

export interface MappingRow {
  number: number;
  pptxTitle: string;
  narrationTitle: string | undefined;
  words: number;
  hidden: boolean;
}

export interface ValidationResult {
  ok: boolean;
  pptxCount: number;
  narrationCount: number;
  missing: number[];
  duplicates: Array<{ number: number; lines: number[] }>;
  outOfRange: number[];
  emptyNarration: number[];
  malformed: MalformedHeading[];
  outOfOrder: boolean;
  warnings: string[];
  mapping: MappingRow[];
  /** Narration records sorted by slide number, one per slide (only meaningful when ok). */
  ordered: NarrationRecord[];
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function validateMapping(pptx: PptxInfo, docx: DocxParseResult): ValidationResult {
  const byNumber = new Map<number, NarrationRecord[]>();
  for (const r of docx.records) {
    const list = byNumber.get(r.number) ?? [];
    list.push(r);
    byNumber.set(r.number, list);
  }

  const missing: number[] = [];
  for (let n = 1; n <= pptx.slideCount; n++) if (!byNumber.has(n)) missing.push(n);

  const duplicates = [...byNumber.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([number, list]) => ({ number, lines: list.map((r) => r.line) }))
    .sort((a, b) => a.number - b.number);

  const outOfRange = [...byNumber.keys()].filter((n) => n < 1 || n > pptx.slideCount).sort((a, b) => a - b);
  const emptyNarration = docx.records.filter((r) => !r.text.trim()).map((r) => r.number);
  const outOfOrder = docx.records.some((r, i) => i > 0 && r.number < docx.records[i - 1]!.number);

  const warnings = [...docx.warnings];
  if (outOfOrder) warnings.push("Voiceover sections are not in ascending slide order; they are mapped by slide number.");
  if (pptx.hiddenSlideNumbers.length) {
    warnings.push(
      `PPTX contains hidden slides (${pptx.hiddenSlideNumbers.join(", ")}). They are counted and will be rendered into the video.`,
    );
  }

  const mapping: MappingRow[] = pptx.slides.map((s) => {
    const rec = byNumber.get(s.number)?.[0];
    return { number: s.number, pptxTitle: s.title, narrationTitle: rec?.title, words: rec ? wordCount(rec.text) : 0, hidden: s.hidden };
  });

  const ok =
    pptx.slideCount > 0 &&
    pptx.slideCount === docx.records.length &&
    missing.length === 0 &&
    duplicates.length === 0 &&
    outOfRange.length === 0 &&
    emptyNarration.length === 0 &&
    docx.malformedHeadings.length === 0;

  const ordered = [...docx.records].sort((a, b) => a.number - b.number);

  return {
    ok,
    pptxCount: pptx.slideCount,
    narrationCount: docx.records.length,
    missing,
    duplicates,
    outOfRange,
    emptyNarration,
    malformed: docx.malformedHeadings,
    outOfOrder,
    warnings,
    mapping,
    ordered,
  };
}

const list = (nums: number[]) => (nums.length ? nums.join(", ") : "none");

export function formatValidationReport(v: ValidationResult, pptxFile: string, docxFile: string): string {
  const out: string[] = [];
  out.push(`Validation: ${v.ok ? "PASS" : "FAIL"}`);
  out.push("");
  out.push(`PPTX:  ${pptxFile}`);
  out.push(`DOCX:  ${docxFile}`);
  out.push("");
  out.push(`PPTX slide count:      ${v.pptxCount}`);
  out.push(`Narration count:       ${v.narrationCount}`);
  out.push(`Missing slide numbers: ${list(v.missing)}`);
  out.push(
    `Duplicate slide numbers: ${v.duplicates.length ? v.duplicates.map((d) => `${d.number} (lines ${d.lines.join(", ")})`).join("; ") : "none"}`,
  );
  out.push(`Narration for slides not in PPTX: ${list(v.outOfRange)}`);
  out.push(`Empty narration:       ${list(v.emptyNarration)}`);
  out.push(`Malformed headings:    ${v.malformed.length ? "" : "none"}`);
  for (const m of v.malformed) out.push(`  line ${m.line}: "${m.text}"\n    ${m.reason}`);
  if (v.warnings.length) {
    out.push("");
    out.push("Warnings:");
    for (const w of v.warnings) out.push(`  - ${w}`);
  }
  return out.join("\n");
}

export function formatMappingTable(v: ValidationResult): string {
  const rows = v.mapping.map((m) => {
    const label = padLabel(m.number, v.pptxCount);
    const pptx = (m.pptxTitle || "(no title placeholder)").slice(0, 45).padEnd(45);
    const docx = m.narrationTitle === undefined ? "!! MISSING NARRATION" : (m.narrationTitle || "(untitled)").slice(0, 45);
    return `${label}  ${pptx}  ${String(m.words).padStart(5)}w  ${docx}${m.hidden ? "  [hidden slide]" : ""}`;
  });
  const header = `${"#".padEnd(Math.max(2, String(v.pptxCount).length))}  ${"PPTX slide title".padEnd(45)}  ${"words".padStart(6)}  Voiceover heading`;
  return [header, "-".repeat(header.length + 10), ...rows].join("\n");
}

export interface CourseIdentity {
  title: string;
  slug: string;
}

export function resolveCourseIdentity(config: Config, pptx: PptxInfo, docx: DocxParseResult): CourseIdentity {
  const first = [...docx.records].sort((a, b) => a.number - b.number).find((r) => r.number === 1);
  const title =
    config.courseTitleOverride ??
    (first?.title || pptx.slides[0]?.title || path.basename(docx.file, path.extname(docx.file)));
  return { title, slug: config.courseSlugOverride ? slugify(config.courseSlugOverride) : slugify(title) };
}
