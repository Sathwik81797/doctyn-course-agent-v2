/**
 * Narration timing. Shared by the Node analyzer/renderer and the browser studio,
 * so it must not import anything Node-specific.
 *
 * Word times are *estimated* by spreading the real audio duration over the words in
 * proportion to their length plus a pause weight for punctuation. They are accurate to
 * roughly a quarter of a second for TTS audio; forced alignment (Whisper) is planned.
 */

export interface WordTiming {
  word: string;
  start: number;
  end: number;
  sentence: number;
}

const WORDS_PER_SECOND = 2.5;
/** Matches V1's SLIDE_LEAD_IN_SECONDS / SLIDE_TAIL_SECONDS defaults. */
export const LEAD_IN = 0.3;
export const TAIL = 0.7;

export function estimateSpeechSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, words / WORDS_PER_SECOND);
}

export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/β/g, "beta")
    .replace(/[^\p{L}\p{N}%]+/gu, "");
}

/** Split narration into words with estimated start/end inside [lead, lead + speechSeconds]. */
export function wordTimings(narration: string, speechSeconds: number, lead = LEAD_IN): WordTiming[] {
  const tokens = narration.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const weights = tokens.map((tok) => {
    const letters = normalizeWord(tok).length || 1;
    let w = 1 + letters * 0.35;
    if (/[,;:]$/.test(tok)) w += 1.2;
    if (/[.!?]["')\]]?$/.test(tok)) w += 2.6;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const out: WordTiming[] = [];
  let acc = 0;
  let sentence = 0;
  tokens.forEach((tok, i) => {
    const start = lead + (acc / total) * speechSeconds;
    acc += weights[i]!;
    const end = lead + (acc / total) * speechSeconds;
    out.push({ word: tok, start, end, sentence });
    if (/[.!?]["')\]]?$/.test(tok)) sentence++;
  });
  return out;
}

/** Start/end of the first occurrence of a phrase in the narration, or null. Case/punctuation-insensitive. */
export function findPhrase(words: WordTiming[], phrase: string): { start: number; end: number } | null {
  const target = phrase.split(/\s+/).map(normalizeWord).filter(Boolean);
  if (target.length === 0) return null;
  const hay = words.map((w) => normalizeWord(w.word));
  for (let i = 0; i + target.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      // prefix match on the last word lets "insulin" find "insulin-resistance"/"insulin,"
      const a = hay[i + j]!;
      const b = target[j]!;
      if (a !== b && !(j === target.length - 1 && a.startsWith(b) && b.length >= 4)) {
        ok = false;
        break;
      }
    }
    if (ok) return { start: words[i]!.start, end: words[i + target.length - 1]!.end };
  }
  return null;
}

/** Sentences with their time windows, for the caption bar. */
export function sentenceWindows(words: WordTiming[]): Array<{ index: number; start: number; end: number; words: WordTiming[] }> {
  const map = new Map<number, WordTiming[]>();
  for (const w of words) {
    const list = map.get(w.sentence) ?? [];
    list.push(w);
    map.set(w.sentence, list);
  }
  return [...map.entries()].map(([index, ws]) => ({ index, start: ws[0]!.start, end: ws[ws.length - 1]!.end, words: ws }));
}

/** Total slide length matching V1's segment: lead-in + narration audio + tail. */
export function slideTotalSeconds(audioSeconds: number): number {
  return LEAD_IN + audioSeconds + TAIL;
}
