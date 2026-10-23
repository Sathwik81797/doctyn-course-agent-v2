// @ts-check
import { createHash } from "node:crypto";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fingerprint of everything a viewer hears or reads: course title, slide titles and narration.
 * A clinical approval is only valid for the exact hash it was given for.
 * @param {string} title
 * @param {Array<{ slide: number, title: string, narration: string }>} slides
 */
export function contentHash(title, slides) {
  const canon = JSON.stringify([title.trim(), slides.map((s) => [s.slide, s.title.trim(), s.narration.trim()])]);
  return createHash("sha256").update(canon).digest("hex");
}

/** Object-storage layout. Every key starts with the owner and course ids. @param {string} ownerId @param {string} courseId */
export function courseKeys(ownerId, courseId) {
  const base = `users/${ownerId}/courses/${courseId}`;
  return {
    base,
    source: (/** @type {"pptx" | "docx"} */ type, /** @type {string} */ nonce) => `${base}/source/${type}-${nonce}.${type}`,
    output: (/** @type {string} */ name) => `${base}/output/${name}`,
    cache: `${base}/cache/`,
  };
}

export const OUTPUT_FILES = /** @type {const} */ ({
  video: { name: "final-video.mp4", type: "video/mp4" },
  thumbnail: { name: "thumbnail.jpg", type: "image/jpeg" },
  vtt: { name: "captions.vtt", type: "text/vtt; charset=utf-8" },
  srt: { name: "captions.srt", type: "application/x-subrip; charset=utf-8" },
  transcript: { name: "transcript.txt", type: "text/plain; charset=utf-8" },
  animated: { name: "animated-video.mp4", type: "video/mp4" },
});

/** @param {unknown} v @param {number} max */
export function cleanText(v, max) {
  return String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
}

/** Must match TEMPLATES in src/animation/types.ts (a unit test enforces this). */
export const ANIMATION_TEMPLATES = [
  "glucose-uptake", "visceral-fat", "continuum", "pathway", "converge", "balance", "body", "lab-branch",
  "homa", "ogtt", "stagemap", "timeline", "case", "algorithm", "key-points",
];
