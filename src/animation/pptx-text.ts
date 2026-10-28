import fs from "node:fs/promises";
import JSZip from "jszip";

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * Text paragraphs of each slide in document order, keyed by the ZIP entry names that
 * parsePptx() reports (ppt/slides/slideN.xml). Read-only; V1's parser is untouched.
 * A soft line break inside a paragraph (<a:br/>, Shift+Enter in PowerPoint) starts a new block, so "Fever + confusion" and
 * "Rapid breathing" never run together into "confusionRapid breathing".
 */
export async function readSlideTexts(pptxFile: string, entries: string[]): Promise<string[][]> {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxFile));
  const out: string[][] = [];
  for (const entry of entries) {
    const xml = (await zip.file(entry)?.async("string")) ?? "";
    const blocks: string[] = [];
    for (const p of xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
      const lines: string[] = [""];
      for (const m of p.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>(?:<\/a:br>)?/g)) {
        if (m[1] === undefined) lines.push("");
        else lines[lines.length - 1] += decodeXml(m[1]);
      }
      for (const line of lines) {
        const t = line.replace(/\s+/g, " ").trim();
        if (t) blocks.push(t);
      }
    }
    out.push(blocks);
  }
  return out;
}
