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
 */
export async function readSlideTexts(pptxFile: string, entries: string[]): Promise<string[][]> {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxFile));
  const out: string[][] = [];
  for (const entry of entries) {
    const xml = (await zip.file(entry)?.async("string")) ?? "";
    const blocks: string[] = [];
    for (const p of xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
      const t = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1] ?? "")).join("").replace(/\s+/g, " ").trim();
      if (t) blocks.push(t);
    }
    out.push(blocks);
  }
  return out;
}
