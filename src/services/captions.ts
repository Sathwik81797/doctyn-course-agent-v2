import { padLabel } from "../utils/files.js";

export interface TimedSlide {
  number: number;
  title: string;
  text: string;
  /** Segment start in the final video (seconds). */
  segmentStart: number;
  segmentEnd: number;
  /** Narration window inside the segment: start + lead-in .. + audio duration. */
  narrationStart: number;
  narrationEnd: number;
}

export interface Cue {
  index: number;
  start: number;
  end: number;
  text: string;
  slide: number;
}

const MAX_LINE = 42;
const MAX_CUE_CHARS = MAX_LINE * 2;

/** Split narration into caption-sized phrases at sentence, then clause, then word boundaries. */
export function splitIntoPhrases(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…])\s+(?=["'“‘(]?[A-Z0-9])/)
    .filter(Boolean);

  const phrases: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= MAX_CUE_CHARS) {
      phrases.push(sentence);
      continue;
    }
    // Break long sentences at clause punctuation, merging small clauses back together.
    const clauses = sentence.split(/(?<=[,;:—–])\s+/);
    let cur = "";
    for (const clause of clauses) {
      const joined = cur ? `${cur} ${clause}` : clause;
      if (joined.length <= MAX_CUE_CHARS) {
        cur = joined;
        continue;
      }
      if (cur) phrases.push(cur);
      if (clause.length <= MAX_CUE_CHARS) {
        cur = clause;
        continue;
      }
      // Still too long: break by words.
      cur = "";
      for (const word of clause.split(" ")) {
        const next = cur ? `${cur} ${word}` : word;
        if (next.length > MAX_CUE_CHARS && cur) {
          phrases.push(cur);
          cur = word;
        } else cur = next;
      }
    }
    if (cur) phrases.push(cur);
  }
  return phrases;
}

/** Wrap a cue into at most two balanced lines. */
export function wrapCue(text: string): string {
  if (text.length <= MAX_LINE) return text;
  const words = text.split(" ");
  let best = text;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const over = Math.max(0, a.length - MAX_LINE) + Math.max(0, b.length - MAX_LINE);
    const score = over * 1000 + Math.abs(a.length - b.length);
    if (score < bestScore) {
      bestScore = score;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

/**
 * Cues for every slide, constrained to that slide's narration window. Within a window,
 * time is shared between phrases in proportion to their length; window edges come from
 * the measured audio durations, so captions never drift across slides.
 */
export function buildCues(slides: TimedSlide[]): Cue[] {
  const cues: Cue[] = [];
  for (const slide of slides) {
    const phrases = splitIntoPhrases(slide.text);
    if (phrases.length === 0) continue;
    const span = slide.narrationEnd - slide.narrationStart;
    const weights = phrases.map((p) => p.length + 8);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let t = slide.narrationStart;
    phrases.forEach((phrase, i) => {
      const end = i === phrases.length - 1 ? slide.narrationEnd : t + (span * weights[i]!) / totalWeight;
      cues.push({ index: cues.length + 1, start: t, end, text: wrapCue(phrase), slide: slide.number });
      t = end;
    });
  }
  return cues;
}

function timestamp(seconds: number, sep: "." | ","): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

export function toVtt(cues: Cue[], title: string): string {
  const header = `WEBVTT - ${title.replace(/-->/g, "→").replace(/\n/g, " ")}\n\n`;
  return (
    header +
    cues.map((c) => `${c.index}\n${timestamp(c.start, ".")} --> ${timestamp(c.end, ".")}\n${c.text.replace(/-->/g, "→")}\n`).join("\n")
  );
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c) => `${c.index}\n${timestamp(c.start, ",")} --> ${timestamp(c.end, ",")}\n${c.text}\n`).join("\n");
}

export function toTranscript(slides: Array<{ number: number; title: string; text: string }>): string {
  const total = slides.length;
  return slides
    .map((s) => {
      const heading = s.title ? `Slide ${padLabel(s.number, total)} — ${s.title}` : `Slide ${padLabel(s.number, total)}`;
      return `${heading}\n\n${s.text.trim()}\n`;
    })
    .join("\n");
}
