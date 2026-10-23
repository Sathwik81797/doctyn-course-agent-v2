import mammoth from "mammoth";
import { PipelineError } from "../utils/errors.js";

export interface NarrationRecord {
  /** Slide number as written in the heading ("Slide 07" -> 7). */
  number: number;
  title: string;
  /** Narration exactly as written (paragraphs separated by blank lines). */
  text: string;
  /** 1-based line of the heading in the extracted document text. */
  line: number;
  heading: string;
}

export interface MalformedHeading {
  line: number;
  text: string;
  reason: string;
}

export interface DocxParseResult {
  file: string;
  records: NarrationRecord[];
  malformedHeadings: MalformedHeading[];
  warnings: string[];
}

/** "Slide 01 — Title", "Slide 1: Title", "Slide #3 - Title", "Slide 04" */
const STRICT_HEADING = /^slide\s*(?:no\.?|number|#)?\s*(\d{1,4})\s*(?:[—–\-:|.)]+\s*(.*))?$/i;
/** "Slide 01   Title" (no separator) — accepted only when a VOICEOVER marker follows. */
const LOOSE_HEADING = /^slide\s*(?:no\.?|number|#)?\s*(\d{1,4})\s+(.+)$/i;
/**
 * "VOICEOVER", "Voice-over:", "VOICEOVER: Welcome to..." — the marker must stand alone
 * (or be followed by a colon), so a document title like "VOICEOVER SCRIPT" is not a marker.
 */
const VOICEOVER_MARKER = /^(?:voice[\s-]?over|narration)\s*(?::\s*(.*))?$/i;
/** Other all-caps section labels inside a slide block (ON-SCREEN TEXT, SPEAKER NOTES, ...). */
const OTHER_MARKER = /^[A-Z][A-Z0-9&/()\- ]{2,40}:?$/;

function cleanLine(line: string): string {
  return line
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u200b\ufeff]/g, "")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "") // control characters
    .replace(/^#{1,6}\s+/, "") // Markdown heading marker
    .replace(/^>\s+/, "") // Markdown quote marker
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2") // Markdown bold
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Decorative separator lines between slide blocks: "————", "----", "____", "====", "* * *", "•••".
 * They contain no letters or digits and are never narration.
 */
export function isSeparatorLine(line: string): boolean {
  return line.length >= 3 && !/[\p{L}\p{N}]/u.test(line) && /^[\s\-‐‑‒–—―_=*~•·.#+]+$/u.test(line);
}

function isOtherMarker(line: string): boolean {
  return OTHER_MARKER.test(line) && line.split(/\s+/).length <= 5 && !VOICEOVER_MARKER.test(line);
}

function nextNonEmpty(lines: string[], from: number): string | undefined {
  for (let i = from; i < lines.length; i++) if (lines[i]) return lines[i];
  return undefined;
}

interface Section {
  number: number;
  title: string;
  line: number;
  heading: string;
  body: Array<{ text: string; line: number }>;
}

function sectionNarration(section: Section, warnings: string[], malformed: MalformedHeading[]): string {
  const paragraphs: string[] = [];
  let sawMarker = false;
  let collecting = !section.body.some((b) => VOICEOVER_MARKER.test(b.text));

  for (const { text, line } of section.body) {
    const vo = VOICEOVER_MARKER.exec(text);
    if (vo) {
      if (sawMarker) {
        malformed.push({
          line,
          text,
          reason: `Second VOICEOVER marker inside Slide ${section.number}. A "Slide NN — Title" heading above it is probably missing or misformatted.`,
        });
      }
      sawMarker = true;
      collecting = true;
      if (vo[1]?.trim()) paragraphs.push(vo[1].trim());
      continue;
    }
    if (sawMarker && isOtherMarker(text)) {
      collecting = false;
      continue;
    }
    if (collecting) paragraphs.push(text);
  }

  if (!sawMarker && section.body.length > 0) {
    warnings.push(`Slide ${section.number} (line ${section.line}) has no VOICEOVER marker; all text under the heading is used as narration.`);
  }
  return paragraphs.join("\n\n").trim();
}

/** Parse "Slide NN — Title / VOICEOVER / text" sections from a DOCX narration script. */
export async function parseDocx(file: string): Promise<DocxParseResult> {
  let raw: string;
  try {
    raw = (await mammoth.extractRawText({ path: file })).value;
  } catch (err) {
    throw new PipelineError(
      `The voiceover document could not be read as a DOCX file:\n${file}`,
      `Details: ${(err as Error).message}\nThe file may be corrupt, password-protected, or an old .doc renamed to .docx. Re-save it from Word as .docx.`,
    );
  }

  const lines = raw.split(/\r?\n/).map(cleanLine);
  const sections: Section[] = [];
  const malformed: MalformedHeading[] = [];
  const warnings: string[] = [];
  let current: Section | undefined;
  /** Inside the body of a malformed heading: skip it rather than reporting its VOICEOVER line again. */
  let discarding = false;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (!text || isSeparatorLine(text)) continue;
    const lineNo = i + 1;
    const followedByMarker = VOICEOVER_MARKER.test(nextNonEmpty(lines, i + 1) ?? "");

    const strict = STRICT_HEADING.exec(text);
    const loose = !strict && followedByMarker ? LOOSE_HEADING.exec(text) : null;
    const m = strict ?? loose;
    // A narration sentence such as "Slide 5 shows..." is only a heading if it looks like one.
    const looksLikeSentence = Boolean(strict && !followedByMarker && /[.!?]$/.test(text) && text.length > 60);

    if (m && !looksLikeSentence) {
      const title = (m[2] ?? "").trim();
      discarding = false;
      current = { number: Number(m[1]), title, line: lineNo, heading: text, body: [] };
      sections.push(current);
      if (!title) warnings.push(`Slide ${current.number} heading on line ${lineNo} has no title.`);
      continue;
    }

    if (/^slide\b/i.test(text) && text.length <= 150 && followedByMarker) {
      malformed.push({
        line: lineNo,
        text,
        reason: 'Looks like a slide heading but does not match "Slide NN — Title" (slide number must be digits).',
      });
      current = undefined; // do not merge this block's narration into the previous slide
      discarding = true;
      continue;
    }

    if (discarding) continue;
    // Text before the first slide heading is document metadata (cover title, author, notes) and is ignored.
    // A genuinely missing "Slide 01" heading is still caught by the missing-slide-number check.
    if (current) current.body.push({ text, line: lineNo });
  }

  const records: NarrationRecord[] = sections.map((s) => ({
    number: s.number,
    title: s.title,
    text: sectionNarration(s, warnings, malformed),
    line: s.line,
    heading: s.heading,
  }));

  malformed.sort((a, b) => a.line - b.line);
  return { file, records, malformedHeadings: malformed, warnings };
}
