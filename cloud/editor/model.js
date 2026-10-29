// The editor's data model: validation of what the browser sends, renumbering after structural edits, and the rule-based
// "Improve Slide Content" suggestions. Pure functions: no database, no network, no paid services.
// @ts-nocheck
import { HttpError } from "../auth.js";
import { FONTS, SHAPE_KINDS } from "./pptx.js";

export const MAX_SLIDES = 300;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const ALIGN = ["left", "center", "right", "justify"];

const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 10000) / 10000)) : undefined;
};
const text = (v, max) =>
  String(v ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .slice(0, max);

function formatting(src, out) {
  if (src.size !== undefined) {
    const v = num(src.size, 6, 200);
    if (v !== undefined) out.size = v;
  }
  if (typeof src.font === "string" && FONTS.includes(src.font)) out.font = src.font;
  if (typeof src.color === "string" && HEX.test(src.color)) out.color = src.color.toUpperCase();
  if (typeof src.fill === "string" && HEX.test(src.fill)) out.fill = src.fill.toUpperCase();
  if (typeof src.bold === "boolean") out.bold = src.bold;
  if (typeof src.italic === "boolean") out.italic = src.italic;
  if (ALIGN.includes(src.align)) out.align = src.align;
}

/** Clean one slide's visual edits. Anything unknown is dropped, numbers are clamped, sizes are capped. */
export function normalizeEdits(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  if (raw.shapes && typeof raw.shapes === "object") {
    const shapes = {};
    for (const [id, e] of Object.entries(raw.shapes).slice(0, 200)) {
      if (!/^\d{1,9}$/.test(id) || !e || typeof e !== "object") continue;
      const s = {};
      if (e.deleted === true) s.deleted = true;
      if (Array.isArray(e.text)) s.text = e.text.slice(0, 60).map((t) => text(t, 2000));
      for (const k of ["x", "y"]) if (e[k] !== undefined) s[k] = num(e[k], -1, 2);
      for (const k of ["w", "h"]) if (e[k] !== undefined) s[k] = num(e[k], 0.005, 3);
      formatting(e, s);
      for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
      if (Object.keys(s).length) shapes[id] = s;
    }
    if (Object.keys(shapes).length) out.shapes = shapes;
  }
  if (Array.isArray(raw.added)) {
    const seen = new Set();
    const added = [];
    for (const e of raw.added.slice(0, 120)) {
      if (!e || typeof e !== "object") continue;
      const id = text(e.id, 40).replace(/[^\w-]/g, "");
      if (!id || seen.has(id) || !SHAPE_KINDS.includes(e.type)) continue;
      seen.add(id);
      const a = { id, type: e.type, x: num(e.x, -1, 2) ?? 0.1, y: num(e.y, -1, 2) ?? 0.1, w: num(e.w, 0.005, 3) ?? 0.2, h: num(e.h, 0.005, 3) ?? 0.1 };
      if (e.text !== undefined) a.text = text(e.text, 2000);
      if (typeof e.stroke === "string" && HEX.test(e.stroke)) a.stroke = e.stroke.toUpperCase();
      for (const k of ["x1", "y1", "x2", "y2"]) if (e[k] !== undefined) a[k] = num(e[k], -1, 2);
      if (e.lineWidth !== undefined) a.lineWidth = num(e.lineWidth, 0.5, 20);
      if (typeof e.from === "string") a.from = text(e.from, 40).replace(/[^\w-]/g, "");
      if (typeof e.to === "string") a.to = text(e.to, 40).replace(/[^\w-]/g, "");
      if (typeof e.group === "string") a.group = text(e.group, 40).replace(/[^\w-]/g, "");
      formatting(e, a);
      for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
      added.push(a);
    }
    if (added.length) out.added = added;
  }
  if (typeof raw.bg === "string" && HEX.test(raw.bg)) out.bg = raw.bg.toUpperCase();
  return out;
}

/**
 * Validate the slide list sent by the editor.
 * @param {unknown} raw @param {number} pageCount pages in the uploaded presentation
 * @returns {Array<{ uid: string, origin: { page: number } | null, title: string, narration: string, edits: any, pptxTitle: string, pptxText: string[] }>}
 */
export function normalizeDeckSlides(raw, pageCount, previous = []) {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, "A course needs at least one slide.");
  if (raw.length > MAX_SLIDES) throw new HttpError(400, `A course can have at most ${MAX_SLIDES} slides.`);
  const known = new Map(previous.map((s) => [s.uid, s]));
  const seen = new Set();
  return raw.map((s, i) => {
    const uid = text(s?.uid, 40).replace(/[^\w-]/g, "");
    if (!uid || seen.has(uid)) throw new HttpError(400, `Slide ${i + 1} has a missing or repeated id. Reload the editor.`);
    seen.add(uid);
    let origin = null;
    if (s.origin) {
      const page = Number(s.origin.page);
      if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new HttpError(400, `Slide ${i + 1} refers to page ${s.origin.page}, but the presentation has ${pageCount}.`);
      origin = { page };
    }
    const before = known.get(uid);
    return {
      uid,
      origin,
      title: text(s.title, 300).trim() || `Slide ${i + 1}`,
      narration: text(s.narration, 20000),
      edits: normalizeEdits(s.edits),
      // Text read from the upload (used by the animation planner when no edit overrides it).
      pptxTitle: before?.pptxTitle ?? "",
      pptxText: before?.pptxText ?? [],
    };
  });
}

/** Give slides saved before the editor existed a stable id and their page of origin. */
export function withIdentity(slides) {
  return slides.map((s) => (s.uid ? s : { ...s, uid: `p${s.slide}`, origin: { page: s.slide } }));
}

/** Old and new slide numbers of the slides that survive an edit, matched by id. */
export function renumber(oldSlides, newSlides) {
  const oldNo = new Map(oldSlides.map((s, i) => [s.uid, i + 1]));
  return newSlides.map((s, i) => ({ uid: s.uid, from: oldNo.get(s.uid) ?? null, to: i + 1 }));
}

/** Re-key per-slide data (animation edits, plan, previews) after slides moved. `keep` filters entries that must not follow a slide. */
export function remapByNumber(map, moves) {
  const out = {};
  for (const m of moves) if (m.from !== null && map?.[String(m.from)] !== undefined) out[String(m.to)] = map[String(m.from)];
  return out;
}

// ---------------------------------------------------------------- Improve Slide Content (rule-based, runs here, costs nothing)

const FILLERS = [
  [/\bin order to\b/gi, "to"],
  [/\bit is important to note that\s+/gi, ""],
  [/\bit should be noted that\s+/gi, ""],
  [/\bplease note that\s+/gi, ""],
  [/\bbasically,?\s+/gi, ""],
  [/\bessentially,?\s+/gi, ""],
  [/\bvery\s+/gi, ""],
  [/\breally\s+/gi, ""],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\ba large number of\b/gi, "many"],
  [/\bin the event that\b/gi, "if"],
];

/** Numbers, units and drug-like words: anything a rewrite must not change. */
const CRITICAL = /\b\d+(?:[.,]\d+)?\s*(?:%|mg|mcg|µg|ug|g|kg|ml|mL|l|L|mmol|mmHg|mEq|units?|IU|bpm|hours?|hrs?|h|minutes?|min|days?|weeks?|years?)?\b|\b[A-Z][a-z]+(?:mycin|cillin|olol|pril|sartan|statin|azole|vir|mab|tide|gliptin|gliflozin|formin|parin|oxacin|cycline)\b|\b(?:insulin|metformin|heparin|warfarin|digoxin|epinephrine|adrenaline|noradrenaline|norepinephrine|vasopressin|hydrocortisone|aspirin)\b/gi;

export const criticalTokens = (s) => [...String(s).matchAll(CRITICAL)].map((m) => m[0].toLowerCase().replace(/\s+/g, "")).sort();
const sameCritical = (a, b) => JSON.stringify(criticalTokens(a)) === JSON.stringify(criticalTokens(b));

const sentences = (s) => String(s).split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).map((t) => t.trim()).filter(Boolean);
const words = (s) => String(s).split(/\s+/).filter(Boolean).length;

const TEMPLATE_HINTS = [
  ["algorithm", /\b(algorithm|if\b.+\bthen\b|decision|escalat|criteria|threshold)\b/i],
  ["workflow", /\b(workflow|first,|then,|next,|finally|step \d|steps?)\b/i],
  ["timeline", /\b(timeline|within \d+|hours?|days?|weeks?|onset|phase)\b/i],
  ["compare", /\b(compare|versus|\bvs\.?\b|difference between|whereas|in contrast)\b/i],
  ["pathway", /\b(pathway|cascade|mechanism|leads to|results in|causes)\b/i],
  ["stagemap", /\b(stage|stages|grade|class|category)\b/i],
  ["organ-map", /\b(heart|lung|kidney|liver|brain|pancreas|organ)\b/i],
  ["balance", /\b(balance|imbalance|homeostasis)\b/i],
];

/** Split a list-like slide text into the steps a flowchart would show. */
function stepsOf(texts, narration) {
  const fromSlide = texts.map((t) => t.trim()).filter((t) => t && t.length <= 70);
  if (fromSlide.length >= 3) return fromSlide.slice(0, 6);
  const parts = sentences(narration).map((s) => s.replace(/^(first|then|next|finally|after that|also)[, ]+/i, "").replace(/[.!?]$/, "")).filter((s) => s.length <= 70 && words(s) >= 2);
  return parts.slice(0, 6);
}

/**
 * Suggestions for one slide. Nothing here is applied automatically: each suggestion is a proposal the faculty member accepts or rejects,
 * and any suggestion that touches numbers, doses or drug names is marked `clinical` so it is never accepted by accident.
 * @param {{ title: string, narration: string, texts: string[] }} slide
 */
export function suggestForSlide({ title, narration, texts }) {
  const out = [];
  const narr = String(narration ?? "");
  const lines = (texts ?? []).map((t) => String(t)).filter((t) => t.trim());

  // 1. Concise narration (filler words only).
  let tight = narr;
  for (const [re, rep] of FILLERS) tight = tight.replace(re, rep);
  tight = tight.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;])/g, "$1");
  // Removing a leading filler ("In order to ...", "Basically, ...") must not leave a sentence starting in lower case.
  const starts = [...narr.matchAll(/(^|[.!?]\s+)([A-Za-z])/g)].map((m) => m[2] === m[2].toUpperCase());
  let at = 0;
  tight = tight.replace(/(^|[.!?]\s+)([a-z])/g, (m, lead, ch) => (starts[at++] ? lead + ch.toUpperCase() : m));
  if (tight !== narr && sameCritical(narr, tight)) {
    out.push({
      id: "narration-tighten", kind: "narration", title: "Tighten the narration",
      rationale: "Removes filler words (for example “in order to”, “basically”, “it is important to note that”). Numbers, doses and drug names are unchanged.",
      before: narr, after: tight, apply: { type: "narration", text: tight }, clinical: false,
    });
  }

  // 2. Long sentences in the narration.
  const long = sentences(narr).filter((s) => words(s) > 38);
  if (long.length) {
    out.push({
      id: "narration-long", kind: "clarity", title: `${long.length} very long sentence${long.length > 1 ? "s" : ""} in the narration`,
      rationale: "Sentences over about 38 words are hard to follow when spoken. Consider splitting them at the marked points.",
      before: long[0], after: long[0].replace(/(;|, which|, and|, but|, while)\s/g, (m) => `${m.startsWith(";") ? "." : ","}\n`).slice(0, 600),
      apply: null, clinical: false,
    });
  }

  // 3. Dense slide text -> bullets (split only; wording is not changed).
  const dense = lines.filter((t) => t.length > 150);
  if (dense.length) {
    const bullets = dense.flatMap((t) => sentences(t).map((s) => s.replace(/[.]$/, "")));
    if (bullets.length >= 2 && bullets.every((b) => b.length <= 140)) {
      out.push({
        id: "slide-bullets", kind: "bullets", title: "Turn dense paragraphs into bullet points",
        rationale: "Long paragraphs on a slide compete with the voiceover. Each sentence becomes its own bullet; the wording is unchanged.",
        before: dense.join("\n"), after: bullets.map((b) => `• ${b}`).join("\n"),
        apply: { type: "slideText", paragraphs: bullets, replace: dense }, clinical: !sameCritical(dense.join(" "), bullets.join(" ")),
      });
    }
  }

  // 4. Diagram suggestion.
  const steps = stepsOf(lines, narr);
  const hay = `${title}\n${lines.join("\n")}\n${narr}`;
  if (steps.length >= 3 && /\b(step|steps|first|then|next|finally|stage|stages|workflow|algorithm|pathway|process|assess|manage|treat|escalat)\b/i.test(hay)) {
    out.push({
      id: "diagram-flow", kind: "diagram", title: `Add a ${steps.length}-step clinical flowchart`,
      rationale: "The content describes a sequence. A flowchart shows the order at a glance. The boxes use the text already on the slide or in the narration; check each box before keeping it.",
      before: "", after: steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
      apply: { type: "diagram", template: "flowchart", labels: steps }, clinical: true,
    });
  } else if (/\b(compare|versus|\bvs\.?\b|difference between)\b/i.test(hay) && lines.length >= 2) {
    out.push({
      id: "diagram-compare", kind: "diagram", title: "Add a two-column comparison",
      rationale: "The slide compares two things. Side-by-side boxes make the contrast clearer.",
      before: "", after: lines.slice(0, 2).join("\n"),
      apply: { type: "diagram", template: "compare", labels: lines.slice(0, 2).map((l) => l.slice(0, 120)) }, clinical: true,
    });
  }

  // 5. Animation type.
  const hint = TEMPLATE_HINTS.find(([, re]) => re.test(hay));
  if (hint) {
    out.push({
      id: "animation-template", kind: "animation", title: `Use the “${hint[0]}” animation`,
      rationale: "The wording of this slide matches that animation type. You can preview it and change it again before generating the video.",
      before: "", after: hint[0], apply: { type: "animationTemplate", template: hint[0] }, clinical: false,
    });
  }

  // 6. Heads-up for reviewers: figures that must stay verified.
  const crit = [...new Set(criticalTokens(`${lines.join(" ")} ${narr}`))];
  if (crit.length) {
    out.push({
      id: "clinical-check", kind: "check", title: "Check these figures against the source",
      rationale: "Numbers, doses and drug names are never changed by suggestions. Confirm they are still correct whenever you edit this slide.",
      before: "", after: crit.slice(0, 12).join(", "), apply: null, clinical: true,
    });
  }
  return out;
}
