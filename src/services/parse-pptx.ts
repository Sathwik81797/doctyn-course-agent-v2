import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { PipelineError } from "../utils/errors.js";

export interface PptxSlide {
  /** 1-based position in the presentation's slide order. */
  number: number;
  /** ZIP entry, e.g. ppt/slides/slide3.xml */
  entry: string;
  title: string;
  hidden: boolean;
}

export interface PptxInfo {
  file: string;
  slideCount: number;
  slides: PptxSlide[];
  hiddenSlideNumbers: number[];
  /** Slide size in EMU, if declared. */
  slideSize: { cx: number; cy: number } | undefined;
}

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

function attributes(tag: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    map.set(m[1]!, decodeXml(m[3] ?? m[4] ?? ""));
  }
  return map;
}

function extractTitle(slideXml: string): string {
  for (const sp of slideXml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? []) {
    const ph = /<p:ph\b[^>]*>/.exec(sp)?.[0];
    if (!ph) continue;
    const type = attributes(ph).get("type");
    if (type !== "title" && type !== "ctrTitle") continue;
    const paragraphs = (sp.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []).map((p) =>
      [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXml(t[1] ?? "")).join(""),
    );
    const title = paragraphs.join(" ").replace(/\s+/g, " ").trim();
    if (title) return title;
  }
  return "";
}

function resolveTarget(target: string): string {
  // Targets are relative to ppt/ ("slides/slide1.xml") or absolute ("/ppt/slides/slide1.xml").
  return target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join("ppt", target));
}

/** Count slides in the order PowerPoint presents them, using the PPTX ZIP/XML structure. */
export async function parsePptx(file: string): Promise<PptxInfo> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await fs.readFile(file));
  } catch (err) {
    throw new PipelineError(
      `The presentation could not be opened as a PPTX file:\n${file}`,
      `Details: ${(err as Error).message}\nThe file may be corrupt, password-protected, or an old .ppt renamed to .pptx. Re-save it from PowerPoint as .pptx.`,
    );
  }

  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  if (!presentationXml) {
    throw new PipelineError(
      `The PPTX has no ppt/presentation.xml, so it is not a valid PowerPoint presentation:\n${file}`,
      "Re-save the file from PowerPoint (File > Save As > PowerPoint Presentation).",
    );
  }

  const relsXml = (await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")) ?? "";
  const rels = new Map<string, string>();
  for (const tag of relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const a = attributes(tag);
    const id = a.get("Id");
    const target = a.get("Target");
    if (id && target && /\/slide$/.test(a.get("Type") ?? "")) rels.set(id, resolveTarget(target));
  }

  const entries: string[] = [];
  const sldIdList = /<(?:\w+:)?sldIdLst\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sldIdLst>/.exec(presentationXml)?.[1] ?? "";
  for (const tag of sldIdList.match(/<(?:\w+:)?sldId\b[^>]*>/g) ?? []) {
    const a = attributes(tag);
    const relId = [...a.entries()].find(([k]) => /:id$/.test(k))?.[1];
    const entry = relId ? rels.get(relId) : undefined;
    if (entry && zip.file(entry)) entries.push(entry);
  }

  if (entries.length === 0) {
    // Fallback for unusual writers: count slide parts directly.
    const parts = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    parts.sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
    entries.push(...parts);
  }

  const slides: PptxSlide[] = [];
  for (const [i, entry] of entries.entries()) {
    const xml = (await zip.file(entry)?.async("string")) ?? "";
    const sldTag = /<(?:\w+:)?sld\b[^>]*>/.exec(xml)?.[0] ?? "";
    const show = attributes(sldTag).get("show");
    slides.push({ number: i + 1, entry, title: extractTitle(xml), hidden: show === "0" || show === "false" });
  }

  const sz = /<(?:\w+:)?sldSz\b[^>]*>/.exec(presentationXml)?.[0];
  const szAttr = sz ? attributes(sz) : undefined;
  const cx = Number(szAttr?.get("cx"));
  const cy = Number(szAttr?.get("cy"));

  return {
    file,
    slideCount: slides.length,
    slides,
    hiddenSlideNumbers: slides.filter((s) => s.hidden).map((s) => s.number),
    slideSize: cx > 0 && cy > 0 ? { cx, cy } : undefined,
  };
}
