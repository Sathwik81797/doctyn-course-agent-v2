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
    slideImage: (/** @type {number} */ n) => `${base}/preview/slides/slide-${String(n).padStart(3, "0")}.jpg`,
    voicePreview: (/** @type {number} */ n) => `${base}/preview/voice/slide-${String(n).padStart(3, "0")}.mp3`,
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

/** Fingerprint of one slide's narration (used to tell whether a voice preview is still current). @param {string} text */
export function narrationHash(text) {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

/** "1-3,7" -> [1,2,3,7] or null when malformed. @param {string} text @param {number} max */
export function parseSlideList(text, max) {
  const t = text.replace(/\s+/g, "");
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(t) || t.length > 80) return null;
  const out = new Set();
  for (const part of t.split(",")) {
    const [a, b] = part.split("-").map(Number);
    for (let n = /** @type {number} */ (a); n <= /** @type {number} */ (b ?? a); n++) {
      if (n < 1 || n > max) return null;
      out.add(n);
    }
  }
  return [...out].sort((x, y) => x - y);
}

/** @param {unknown} v @param {number} max */
export function cleanText(v, max) {
  return String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
}

/** Must match TEMPLATES in src/animation/types.ts (a unit test enforces this). */
export const ANIMATION_TEMPLATES = [
  "glucose-uptake", "visceral-fat", "continuum", "pathway", "converge", "balance", "body", "lab-branch",
  "homa", "ogtt", "stagemap", "timeline", "case", "algorithm", "compare", "workflow", "organ-map", "key-points",
];

/**
 * Vercel only routes single-segment paths under /api/v3/ to the catch-all function (checked on the live site: /api/v3/health
 * works, /api/v3/auth/me is a platform 404). The dashboard therefore calls /api/v3/route?p=auth/me&download=1, and this
 * rewrites req.url to the real route (/api/v3/auth/me?download=1) before routing. Multi-segment paths keep working
 * wherever the platform delivers them (tests, local servers).
 * @param {{ url?: string | undefined }} req
 */
export function normalizeRouteUrl(req) {
  const u = new URL(req.url ?? "/", "http://localhost");
  if (u.pathname.replace(/\/+$/, "") !== "/api/v3/route") return;
  const p = (u.searchParams.get("p") ?? "").replace(/^\/+/, "");
  u.searchParams.delete("p");
  const rest = u.searchParams.toString();
  req.url = `/api/v3/${p}${rest ? `?${rest}` : ""}`;
}
