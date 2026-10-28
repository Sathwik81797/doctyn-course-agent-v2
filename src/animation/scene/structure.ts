/**
 * Reading a slide's own layout. A PPTX gives the planner a flat list of text blocks; a designed slide encodes more than that:
 * a repeated header and footer, a "01 → 02 → 03" sequence drawn as boxes, ALL-CAPS section headings, a one-line subtitle.
 * This turns the flat list into that structure so the planner can recognise a pathway, a workflow or a case from the slide itself
 * and never mistakes a footer or a page counter for medical content. Pure: shared by Node and the browser.
 */

export interface SlideStructure {
  /** One line under the title, when the slide has one. */
  subtitle?: string;
  /** Content lines in reading order: no title, header/footer, counters, step numbers, arrows, section headings or subtitle. */
  items: string[];
  /** The slide draws numbered steps or arrows between its items. */
  sequence: boolean;
  /** ALL-CAPS headings with the lines under them (e.g. CLINICAL PRESENTATION). */
  sections: Array<{ header: string; lines: string[] }>;
  /** "A → B → C" written in one line, split into its parts. */
  chains: string[][];
  /** Lines that were removed as repeated header/footer text or counters. */
  dropped: string[];
}

const ARROWS = /^[\s→➜➔⇒>›»–—\-]{1,4}$/;
const STEP_NO = /^\(?0?\d{1,2}\)?[.)]?$/;
const COUNTER = /^\d{1,3}\s*(\/|of)\s*\d{1,3}$/i;
const CAPS_HEADER = /^[A-Z][A-Z0-9 &/+:'-]{4,}$/;

const norm = (s: string): string => s.toLowerCase().replace(/[0-9]+/g, "").replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Lines that repeat on at least 40% of the slides (header, footer, brand line): they are layout, not content. */
export function findBoilerplate(slides: string[][]): string[] {
  if (slides.length < 3) return [];
  const seen = new Map<string, number>();
  for (const lines of slides) for (const key of new Set(lines.map(norm).filter((k) => k.length >= 4))) seen.set(key, (seen.get(key) ?? 0) + 1);
  const min = Math.max(2, Math.ceil(slides.length * 0.4));
  return [...seen.entries()].filter(([, n]) => n >= min).map(([k]) => k);
}

export function analyzeSlideText(title: string, lines: string[], boilerplate: string[] = []): SlideStructure {
  const bp = new Set(boilerplate);
  const titleKey = norm(title);
  const dropped: string[] = [];
  const kept: string[] = [];
  let numbered = 0;
  let arrows = 0;
  for (const raw of lines) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (COUNTER.test(t) || bp.has(norm(t)) && norm(t).length >= 4) {
      dropped.push(t);
      continue;
    }
    if (STEP_NO.test(t)) {
      numbered++;
      continue;
    }
    if (ARROWS.test(t)) {
      arrows++;
      continue;
    }
    if (norm(t) === titleKey) continue;
    kept.push(t);
  }
  const sequence = arrows >= 2 || numbered >= 3;

  // "A → B → C" inside one line
  const chains: string[][] = [];
  for (const t of kept) {
    const parts = t.split(/\s*(?:→|➜|➔|⇒)\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) chains.push(parts);
  }

  // sections: ALL-CAPS headings and what follows them
  const sections: SlideStructure["sections"] = [];
  const free: string[] = [];
  let current: SlideStructure["sections"][number] | null = null;
  for (const t of kept) {
    if (CAPS_HEADER.test(t) && t === t.toUpperCase() && !/\d{3,}/.test(t)) {
      current = { header: t, lines: [] };
      sections.push(current);
    } else if (current) current.lines.push(t);
    else free.push(t);
  }

  // a one-line subtitle: the first free line when enough content follows it
  let subtitle: string | undefined;
  let items = free;
  const first = free[0];
  if (first && first.length <= 90) {
    const designed = sections.length > 0 || (sequence && free.length >= 4);
    // On a plain bullet list the first line is a subtitle only when it reads like a sentence rather than another bullet.
    const words = (s: string): number => s.split(/\s+/).length;
    const rest = free.slice(1);
    const sentenceLike = /[,.;:]/.test(first.replace(/[.]$/, "")) || /\.$/.test(first);
    const longer = rest.length >= 3 && words(first) >= 6 && words(first) >= Math.max(...rest.map(words)) + 1;
    if (designed || (rest.length >= 3 && (sentenceLike || longer))) {
      subtitle = first;
      items = rest;
    }
  }
  return { ...(subtitle ? { subtitle } : {}), items, sequence, sections, chains, dropped };
}
