/**
 * Topic analysis: slide text + voiceover -> which medical explainer to draw, when each
 * step appears (anchored to narration phrases), pop-ups, and clinical-review flags.
 *
 * The default analyzer is rule-based and fully offline. An optional AI pass (ai.ts) can
 * override the template choice and add pop-ups; its output is validated and the timeline
 * is still resolved by the code below, so the model never sets timestamps directly.
 */
import { createHash } from "node:crypto";
import { DRUG_TERMS, GLOSSARY } from "./glossary.js";
import { authoredFor, TEMPLATE_ASSUMPTIONS } from "./scene/content.js";
import { elementSpecs, type ElementSpec, type SceneInput } from "./scene/core.js";
import { DERIVABLE, deriveFor, deriveScene, type Derived } from "./scene/derive.js";
import { findPhrase, LEAD_IN, TAIL, wordTimings, type WordTiming } from "./scene/timing.js";
import type { Analysis, ClinicalFlag, Popup, SlidePlan, TemplateId, TimelineEvent } from "./types.js";

export interface SlideSource {
  slide: number;
  title: string;
  narration: string;
  slideText: string[];
  /** Total slide seconds (lead-in + audio + tail). */
  durationSeconds: number;
  durationSource: "audio" | "estimated";
}

interface Rule {
  template: TemplateId;
  /** [regex, weight] pairs scored against title + slide text + narration. */
  signals: Array<[RegExp, number]>;
}

const RULES: Rule[] = [
  {
    template: "glucose-uptake",
    signals: [
      [/glut-?4/i, 3],
      [/glucose uptake/i, 3],
      [/skeletal muscle/i, 2],
      [/muscle mass/i, 2],
      [/glucose (sink|disposal)/i, 3],
      [/insulin receptor/i, 3],
      [/physical inactivity/i, 2],
    ],
  },
  {
    template: "visceral-fat",
    signals: [
      [/visceral (fat|adipos)/i, 3],
      [/portal circulation/i, 3],
      [/free fatty acids?/i, 2],
      [/central adiposity/i, 2],
      [/hepatic gluconeogenesis/i, 2],
    ],
  },
  {
    template: "continuum",
    signals: [
      [/continuum/i, 4],
      [/normal glucose tolerance/i, 2],
      [/overt diabetes/i, 2],
      [/insulin-dependent diabetes/i, 2],
    ],
  },
];

const MIN_SCORE = 5;

export interface TemplateChoice {
  template: TemplateId;
  rationale: string;
}

export function chooseTemplate(src: Pick<SlideSource, "title" | "narration" | "slideText"> & { slide?: number }): TemplateChoice {
  const authored = src.slide === undefined ? undefined : authoredFor(src.slide, src.title);
  if (authored) return { template: authored.template, rationale: `Topic-specific "${authored.template}" scene authored for this slide from its own text and narration.` };
  const hay = [src.title, ...src.slideText, src.narration].join("\n");
  let best: { rule: Rule; score: number; hits: string[] } | undefined;
  for (const rule of RULES) {
    let score = 0;
    const hits: string[] = [];
    for (const [re, weight] of rule.signals) {
      if (re.test(hay)) {
        score += weight;
        hits.push(re.source.replace(/\\|\?/g, ""));
      }
    }
    if (score >= MIN_SCORE && (!best || score > best.score)) best = { rule, score, hits };
  }
  if (!best) return { template: "key-points", rationale: "No specialised medical mechanism recognised; showing the slide's key concepts in step with the narration." };
  return { template: best.rule.template, rationale: `Matched ${best.rule.template} (score ${best.score}) on: ${best.hits.join(", ")}.` };
}

function defaultParams(template: TemplateId, src: SlideSource): SlidePlan["params"] {
  const authored = authoredFor(src.slide, src.title);
  if (authored && authored.template === template) return { ...authored.params };
  const hay = `${src.title} ${src.narration}`;
  if (template === "glucose-uptake") {
    const params: SlidePlan["params"] = {};
    if (/reduces?\s+glut-?4/i.test(hay)) params["reducedGlut4"] = true;
    if (/insulin resistance/i.test(hay) && /inactivity/i.test(hay)) params["resistant"] = true;
    return params;
  }
  return {};
}

const clampT = (x: number, max: number): number => Math.min(Math.max(0, x), max);

/** Resolve template elements to timeline events using narration cues, chains and fallbacks. */
export function buildEvents(plan: SceneInput, words: WordTiming[]): TimelineEvent[] {
  const specs = elementSpecs(plan);
  const total = plan.durationSeconds;
  const speech = Math.max(0.5, total - LEAD_IN - TAIL);
  const placed = new Map<string, { start: number; end: number }>();
  const events: TimelineEvent[] = [];

  for (const spec of specs) {
    let hit: { start: number; end: number } | null = null;
    let cue: string | undefined;
    for (const c of spec.cues) {
      hit = findPhrase(words, c);
      if (hit) {
        cue = c;
        break;
      }
    }
    if (spec.optional && !hit) continue;

    const prev = spec.after ? placed.get(spec.after) : undefined;
    if (hit && prev && !spec.optional && hit.start > prev.end + (spec.maxGap ?? 2.5)) {
      hit = null;
      cue = undefined;
    }
    let start: number;
    if (hit) {
      start = hit.start - 0.12;
      if (prev) start = Math.max(start, prev.start + 0.4);
    } else if (prev) {
      start = prev.end + (spec.gap ?? 0.3);
    } else if (spec.frac !== undefined) {
      start = LEAD_IN + spec.frac * speech;
    } else {
      start = 0.1;
    }
    start = clampT(start, total - 0.6);
    const end = clampT(start + spec.dur, total - 0.1);
    placed.set(spec.id, { start, end });
    events.push({ id: `ev-${spec.id}`, element: spec.id, action: "show", start: round(start), end: round(end), ...(cue ? { cue } : {}) });
  }

  // Emphasise a concept again when the narration returns to it (generic cards only).
  if (plan.template === "key-points") {
    for (const spec of specs) {
      const shown = placed.get(spec.id);
      if (!shown) continue;
      for (const c of spec.cues) {
        const hit = findPhrase(words, c);
        if (hit && hit.start > shown.end) {
          events.push({ id: `pulse-${spec.id}`, element: spec.id, action: "pulse", start: round(hit.start), end: round(hit.end + 0.6), cue: c });
          break;
        }
      }
    }
  }
  return events;
}

const round = (n: number): number => Math.round(n * 100) / 100;

const NUMERIC_CLAIM =
  /\b\d+(?:\.\d+)?(?:\s*(?:to|-|–)\s*\d+(?:\.\d+)?)?\s*(?:percent|%|mg\/dl|mmol\/l|kg\/m|kilograms|centimetres?|milligrams?|years?|micro-international|units?|hours?|hrs?|minutes?|mins?|days?|weeks?|months?|ng\/l|ng\/ml|pg\/ml|mmhg|bpm|mmol|[µu]mol|g\/dl|iu|mg|mcg|ml)\b/gi;

/** Split on sentence-ending punctuation followed by whitespace, so decimals such as "6.0" stay intact. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["')\]]?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pop-ups: one clinical pearl lifted from the narration plus up to two glossary definitions. */
export function buildPopups(src: SlideSource, words: WordTiming[]): Popup[] {
  const popups: Popup[] = [];
  const total = src.durationSeconds;

  // Clinical pearl: the first sentence that states a number or an instruction. Text comes straight from the source.
  const pearl = sentences(src.narration).find((s) => /\b\d/.test(s) || /\b(always|should|must|not exclude|do not)\b/i.test(s));
  if (pearl && pearl.length <= 220) {
    const lead = findPhrase(words, pearl.split(/\s+/).slice(0, 4).join(" "));
    const start = lead ? Math.max(0.4, lead.start) : LEAD_IN + 1;
    popups.push({
      id: "pop-pearl",
      title: /\b(always|should|must|do not|not exclude)\b/i.test(pearl) ? "Clinical practice point" : "Key figure",
      text: pearl,
      kind: "clinical",
      start: round(start),
      end: round(Math.min(total - 0.2, start + 6)),
      origin: "source",
    });
  }

  // Glossary: first mention of up to two known terms; skipped when it would overlap the pearl.
  let added = 0;
  const used = new Set<string>();
  const found = GLOSSARY.flatMap((g) => {
    for (const term of g.terms) {
      const hit = findPhrase(words, term);
      if (hit) return [{ g, hit, term }];
    }
    return [];
  }).sort((a, b) => a.hit.start - b.hit.start);

  for (const { g, hit, term } of found) {
    if (added >= 2 || used.has(g.title)) continue;
    // a longer glossary term already covered this mention ("insulin resistance" inside "compensated insulin resistance")
    if (found.some((o) => o.g !== g && o.g.title.length > g.title.length && o.g.title.toLowerCase().includes(g.title.toLowerCase()) && Math.abs(o.hit.start - hit.start) < 1.5)) continue;
    const start = Math.max(0.4, hit.start - 0.1);
    const end = Math.min(total - 0.2, start + 5);
    if (end - start < 2) continue;
    if (popups.some((p) => start < p.end && end > p.start)) continue;
    used.add(g.title);
    added++;
    popups.push({ id: `pop-${g.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, title: g.title, text: g.text, kind: "definition", start: round(start), end: round(end), cue: term, origin: "glossary" });
  }
  return popups.sort((a, b) => a.start - b.start);
}

const flagId = (kind: string, text: string): string => `flag-${createHash("sha1").update(`${kind}|${text}`).digest("hex").slice(0, 8)}`;

/** Things a clinician must look at before the slide can be approved. */
export function buildFlags(src: SlideSource, template: TemplateId, popups: Popup[], derived?: Pick<Derived, "assumptions">): ClinicalFlag[] {
  const flags: ClinicalFlag[] = [];
  const add = (kind: ClinicalFlag["kind"], text: string): void => {
    const id = flagId(kind, text);
    if (!flags.some((f) => f.id === id)) flags.push({ id, kind, text, acknowledged: false });
  };
  for (const m of src.narration.matchAll(NUMERIC_CLAIM)) add("numeric-claim", `Narration states "${m[0].trim()}" — confirm it matches the source and current guidance.`);
  const lower = src.narration.toLowerCase();
  for (const d of DRUG_TERMS) if (lower.includes(d)) add("drug", `Narration mentions "${d}" — confirm the management statement.`);
  for (const p of popups) if (p.origin !== "source") add("ai-content", `Pop-up "${p.title}" was written by the tool (${p.origin}), not taken from the course source.`);
  const authored = authoredFor(src.slide, src.title);
  if (authored && authored.template === template) {
    const generic = TEMPLATE_ASSUMPTIONS[template];
    if (generic) add("template-assumption", generic);
    for (const f of authored.flags ?? []) add("template-assumption", f);
  }
  if (derived) {
    for (const text of derived.assumptions) add("template-assumption", text);
    add("template-assumption", "On-screen labels were selected automatically from this slide's text and narration (shortened at clause boundaries). Check each label, its order and its wording against the source before approving.");
  }
  if (template === "continuum") add("template-assumption", "Continuum curves and laboratory tags are illustrative template content, not data from the source.");
  if (template === "glucose-uptake" && !/glut-?4/i.test(src.narration)) add("template-assumption", "Receptor → GLUT4 → glucose-entry mechanism is standard physiology added by the template; the narration does not describe it.");
  if (template === "visceral-fat") add("template-assumption", "The cytokine → blocked insulin-signalling step is drawn as a general mechanism for this slide.");
  return flags;
}

export function contentHash(p: Pick<SlidePlan, "narration" | "template" | "params" | "labels" | "events" | "popups" | "slideText"> & { items?: SlidePlan["items"] }): string {
  const parts: unknown[] = [p.narration, p.template, p.params, p.labels, p.events, p.popups, p.slideText];
  // Derived scene items are part of what a reviewer approved; authored scenes (no items) hash exactly as before.
  if (p.items?.length) parts.push(p.items);
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

export interface AnalysisOverride {
  template?: TemplateId;
  rationale?: string;
  params?: SlidePlan["params"];
  extraPopups?: Popup[];
  analyzer?: "rules" | "ai";
  /** What the AI understood about the slide (shown to the reviewer; never used to place anything on screen). */
  analysis?: Partial<Analysis>;
}

interface SceneChoice {
  template: TemplateId;
  rationale: string;
  derived?: Derived | undefined;
  analyzer: "rules" | "ai";
}

/**
 * Which scene a slide gets. Order: scene authored for this exact course > a strongly matching specialised mechanism >
 * a reusable medical component filled from the slide's own words > the generic key-points cards (last resort).
 * A template chosen by a person or by the AI is honoured when the slide can fill it; otherwise the deterministic choice stands.
 */
export function chooseScene(src: SlideSource, override: AnalysisOverride = {}): SceneChoice {
  const analyzer = override.analyzer ?? "rules";
  if (override.template) {
    const authored = authoredFor(src.slide, src.title);
    if (authored && authored.template === override.template) return { template: override.template, rationale: override.rationale ?? "Chosen by the reviewer.", analyzer };
    if (DERIVABLE.includes(override.template)) {
      const d = deriveFor(override.template, src, analyzer !== "ai");
      if (d) return { template: override.template, rationale: override.rationale ?? "Chosen by the reviewer.", derived: d, analyzer };
      if (analyzer === "ai") {
        const fallback = chooseScene(src);
        return { ...fallback, rationale: `The AI suggested "${override.template}" but this slide has too little matching text for it. ${fallback.rationale}` };
      }
    }
    return { template: override.template, rationale: override.rationale ?? "Chosen by the reviewer.", analyzer };
  }
  const base = chooseTemplate(src);
  if (base.template !== "key-points") return { ...base, analyzer };
  const d = deriveScene(src);
  if (d) return { template: d.template, rationale: d.rationale, derived: d, analyzer };
  return { ...base, analyzer };
}

export function analyzeSlide(src: SlideSource, override: AnalysisOverride = {}): SlidePlan {
  const choice = chooseScene(src, override);
  const speech = Math.max(0.5, src.durationSeconds - LEAD_IN - TAIL);
  const words = wordTimings(src.narration, speech);
  const scene: SceneInput = {
    slide: src.slide,
    title: src.title,
    narration: src.narration,
    slideText: src.slideText,
    template: choice.template,
    params: { ...defaultParams(choice.template, src), ...choice.derived?.params, ...override.params },
    ...(choice.derived ? { items: choice.derived.items } : {}),
    labels: {},
    events: [],
    popups: [],
    durationSeconds: src.durationSeconds,
  };
  const events = buildEvents(scene, words);
  const popups = [...buildPopups(src, words), ...(override.extraPopups ?? [])].sort((a, b) => a.start - b.start);
  const plan: SlidePlan = {
    ...scene,
    rationale: choice.rationale,
    analyzer: choice.analyzer,
    ...(choice.derived || override.analysis ? { analysis: mergeAnalysis(choice.derived?.analysis, override.analysis, src) } : {}),
    durationSource: src.durationSource,
    audioStale: false,
    events,
    popups,
    flags: buildFlags(src, choice.template, popups, choice.derived),
    review: { status: "needs_review" },
  };
  return plan;
}

function mergeAnalysis(derived: Analysis | undefined, ai: Partial<Analysis> | undefined, src: SlideSource): Analysis {
  const mechanism = ai?.mechanism ?? derived?.mechanism;
  return {
    category: ai?.category ?? derived?.category ?? "general",
    topic: (ai?.topic ?? derived?.topic ?? src.title).slice(0, 200),
    objective: (ai?.objective ?? derived?.objective ?? "").slice(0, 300),
    ...(mechanism ? { mechanism: mechanism.slice(0, 300) } : {}),
  };
}

/** Re-resolve cue-anchored events and pop-ups after narration or duration changes (keeps manual times for un-cued items). */
export function reanchor(plan: SlidePlan): void {
  const speech = Math.max(0.5, plan.durationSeconds - LEAD_IN - TAIL);
  const words = wordTimings(plan.narration, speech);
  for (const e of plan.events) {
    if (!e.cue) continue;
    const hit = findPhrase(words, e.cue);
    if (!hit) continue;
    const len = e.end - e.start;
    e.start = round(Math.max(0, hit.start - 0.12));
    e.end = round(Math.min(plan.durationSeconds, e.start + len));
  }
  for (const p of plan.popups) {
    if (!p.cue) continue;
    const hit = findPhrase(words, p.cue);
    if (!hit) continue;
    const len = p.end - p.start;
    p.start = round(Math.max(0.2, hit.start - 0.1));
    p.end = round(Math.min(plan.durationSeconds, p.start + len));
  }
}

export type { ElementSpec };
