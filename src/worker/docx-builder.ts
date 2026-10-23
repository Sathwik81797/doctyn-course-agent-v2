import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

export interface SlideText {
  slide: number;
  title: string;
  narration: string;
}

/**
 * Builds the voiceover script in the exact layout the pipeline parses:
 *   Slide 01 — Title / VOICEOVER / narration paragraphs.
 * Dashboard edits live in the database; this turns them back into the DOCX the existing
 * build-course command expects, so the pipeline itself needs no changes.
 */
export async function buildVoiceoverDocx(courseTitle: string, slides: SlideText[]): Promise<Buffer> {
  const width = Math.max(2, String(slides.length).length);
  const children: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(courseTitle)] })];
  for (const s of [...slides].sort((a, b) => a.slide - b.slide)) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun(`Slide ${String(s.slide).padStart(width, "0")} — ${oneLine(s.title)}`)],
      }),
      new Paragraph({ children: [new TextRun({ text: "VOICEOVER", bold: true })] }),
    );
    for (const para of s.narration.split(/\n{2,}/)) {
      const text = para.replace(/\n/g, " ").trim();
      if (text) children.push(new Paragraph({ children: [new TextRun(text)] }));
    }
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
