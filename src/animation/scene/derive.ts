/**
 * Topic-independent scene derivation: slide text + narration -> which reusable medical visual to draw and what goes
 * in it. Pure and deterministic (no network, no Node APIs), shared by the analyzer, the AI planner's validation and
 * the editor.
 *
 * Nothing here writes new medical content. Every on-screen string is a fragment of the slide's own text or narration
 * (shortened at clause boundaries); what the scene adds is structure: sequence, contrast, time, position. Anything
 * the reviewer should look at is returned as `assumptions` and becomes a clinical flag.
 */
import type { Analysis, Category, SlidePlan, TemplateId } from "../types.js";
import { analyzeSlideText, type SlideStructure } from "./structure.js";
import { findPhrase, normalizeWord, wordTimings } from "./timing.js";

export interface DeriveSource {
  slide: number;
  title: string;
  narration: string;
  slideText: string[];
  /** Normalised lines that repeat across the deck (header / footer / brand line): ignored as content. */
  boilerplate?: string[];
}

const structures = new WeakMap<DeriveSource, SlideStructure>();
/** The slide's layout read from its text (cached per source object). */
export function structureOf(src: DeriveSource): SlideStructure {
  let s = structures.get(src);
  if (!s) {
    s = analyzeSlideText(src.title, src.slideText, src.boilerplate ?? []);
    structures.set(src, s);
  }
  return s;
}

/** Pictograms available to the scenes, chosen from a label's own words. Symbolic only: no anatomy is implied. */
export const ICONS: Array<[id: string, match: RegExp]> = [
  ["infection", /\b(infect\w*|bacteri\w*|microb\w*|pathogen\w*|sepsis|source of)\b/i],
  ["inflammation", /\b(inflamm\w*|cytokine\w*|immune|host response|dysregulat\w*)\b/i],
  ["alert", /\b(deteriorat\w*|escalat\w*|urgent\w*|alert\w*|warning|red flag|emergenc\w*)\b/i],
  ["brain", /\b(mental|confus\w*|brain|neuro\w*|conscious\w*|alertness|delirium)\b/i],
  ["lungs", /\b(oxygen\w*|respirat\w*|breath\w*|tachypn\w*|lung\w*|airway|ventilat\w*)\b/i],
  ["kidney", /\b(urine|urinary|kidney\w*|renal)\b/i],
  ["heart", /\b(heart|cardiac|rhythm|cardio\w*)\b/i],
  ["pressure", /\b(hypotens\w*|blood pressure|perfusion|circulat\w*|shock)\b/i],
  ["vessel", /\b(vascul\w*|endotheli\w*|microcircul\w*|microvascul\w*|capillar\w*|vessel\w*)\b/i],
  ["flask", /\b(lab\w*|lactate|blood test\w*|samples?|cultures?|microbiolog\w*|investigat\w*|tests?)\b/i],
  ["thermometer", /\b(fever|temperature|febrile)\b/i],
  ["drop", /\b(fluids?|antimicrob\w*|antibiotic\w*|treatment|therapy|intervention\w*|drug\w*|medication)\b/i],
  ["pulse", /\b(monitor\w*|reassess\w*|trends?|observation\w*|vital signs|review)\b/i],
  ["person", /\b(patients?|clinician\w*|history|examination)\b/i],
];

export function iconFor(label: string): string | undefined {
  const text = label.replace("|", " ");
  return ICONS.find(([, re]) => re.test(text))?.[0];
}

export interface DerivedItem {
  id: string;
  label: string;
  cues: string[];
  free?: boolean;
  frac?: number;
  description?: string;
}

export interface Derived {
  template: TemplateId;
  params: SlidePlan["params"];
  items: DerivedItem[];
  analysis: Analysis;
  /** Visual devices the template adds that are not source content. */
  assumptions: string[];
  rationale: string;
  score: number;
}

// ---------- text helpers ----------

const BULLET = /^[\s•▪◦‣⁃*\-–—·●■□▪]+|^\(?\d{1,2}[.)]\s+/;

export function clean(s: string): string {
  return s.replace(BULLET, "").replace(/\s+/g, " ").trim();
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["')\]]?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const trimEnd = (s: string): string => s.replace(/[\s.,;:!?]+$/g, "");
const wc = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** Cut at a word boundary; adds an ellipsis only when something was removed. */
function clip(s: string, max: number): string {
  const t = trimEnd(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${trimEnd(sp > max * 0.5 ? cut.slice(0, sp) : cut)}…`;
}

/** "Head|sub" label from one source line: split at a colon or dash, else at the first clause break of a long line. */
export function headSub(raw: string, headMax = 46, subMax = 120): string {
  const s = trimEnd(clean(raw));
  const m = /^(.{3,60}?)\s*(?::|\s[–—-]\s)\s*(.{3,})$/.exec(s);
  if (m && m[1]!.length <= headMax) return `${cap(m[1]!.trim())}|${clip(cap(m[2]!.trim()), subMax)}`;
  if (s.length <= headMax) return cap(s);
  const c = /^(.{12,58}?)(?:,|;|\s(?:which|that|because|and|so|as|while|when|where)\s)\s*(.{6,})$/.exec(s);
  if (c) return `${cap(c[1]!.trim())}|${clip(cap(c[2]!.trim()), subMax)}`;
  return clip(cap(s), headMax + subMax);
}

const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "is", "are", "was", "were", "by", "as", "at", "from", "that", "this", "it", "its", "be", "can", "may"]);

/** Narration phrases (1-4 words) that identify a label in the voiceover, longest first. Empty when none occurs. */
export function cuesFor(label: string, narration: string, from: "head" | "sub" | "both" = "both"): string[] {
  const probe = wordTimings(narration, 10);
  const hay = probe.map((w) => normalizeWord(w.word));
  const occurrences = (phrase: string): number => {
    const target = phrase.split(/\s+/).map(normalizeWord).filter(Boolean);
    let n = 0;
    for (let i = 0; i + target.length <= hay.length; i++) {
      if (target.every((t, j) => hay[i + j] === t || (j === target.length - 1 && t.length >= 4 && hay[i + j]!.startsWith(t)))) n++;
    }
    return n;
  };
  const [head = "", sub = ""] = label.split("|");
  const source = from === "head" ? head : from === "sub" ? sub || head : `${head} ${sub}`;
  const toks = source.replace(/[→↑↓~%…]/g, " ").split(/\s+/).filter(Boolean);
  const found: Array<{ phrase: string; n: number; at: number; times: number }> = [];
  for (const n of [4, 3, 2, 1]) {
    for (let i = 0; i + n <= toks.length; i++) {
      const win = toks.slice(i, i + n);
      const first = normalizeWord(win[0]!);
      const last = normalizeWord(win[n - 1]!);
      if (STOP.has(first) || STOP.has(last)) continue;
      const phrase = win.join(" ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, "");
      if (n === 1 && last.length < 5 && !/^[A-Z0-9-]{3,}$/.test(phrase)) continue;
      const times = occurrences(phrase);
      if (times > 0 && !found.some((f) => f.phrase === phrase)) found.push({ phrase, n, at: i, times });
    }
  }
  // A phrase that occurs once pins the element to the right moment; then prefer longer phrases, then earlier ones in the label.
  found.sort((a, b) => Number(b.times === 1) - Number(a.times === 1) || b.n - a.n || a.at - b.at);
  return found.slice(0, 3).map((f) => f.phrase);
}

function sourceLines(src: DeriveSource): string[] {
  const title = clean(src.title).toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  // the slide's own content lines: no header/footer, counters, step numbers, arrows, section headings or subtitle
  for (const raw of structureOf(src).items) {
    const t = clean(raw);
    const k = t.toLowerCase();
    if (t.length < 4 || t.length > 260 || k === title || /^[\d\s./-]+$/.test(t) || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

const item = (id: string, label: string, narration: string, more: Partial<DerivedItem> = {}, from: "head" | "sub" | "both" = "both"): DerivedItem => ({
  id,
  label,
  cues: cuesFor(label, narration, from),
  ...more,
});

/** True when `a` says (nearly) the same as `b`: most of its content words appear in `b`. */
function similar(a: string, b: string): boolean {
  const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
  const wa = words(a);
  const wb = new Set(words(b));
  return wa.length > 0 && wa.filter((w) => wb.has(w)).length / wa.length >= 0.75;
}

const takeaway = (s: string): boolean => /^(remember|therefore|in summary|to summari[sz]e|key|the key|overall|in short|in conclusion|take[- ]home|importantly|so,)/i.test(s);
const lastTakeaway = (sents: string[]): string | undefined => [...sents].reverse().find((s) => takeaway(s) && s.length <= 170);

// ---------- vocab ----------

const CAUSAL = /(?:,?\s*which (?:then |in turn |eventually )?|\bleads? to\b|\bleading to\b|\bresults? in\b|\bresulting in\b|\bcauses?\b|\bcausing\b|\btriggers?\b|\bpromotes?\b|\bactivates?\b|\bfollowed by\b|\bprogress(?:es)? to\b|\bevolves? into\b|→|\bthen\b)/i;
const CAUSAL_COUNT = /\b(leads? to|leading to|results? in|resulting in|causes?|causing|triggers?|promotes?|activates?|followed by|progress(?:es)? to|evolves? into|in turn|cascade)\b|→/gi;
const TIME_EXPR =
  /\b(?:within\s+)?\d+(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?)?\s*(?:hours?|hrs?|days?|weeks?|months?|years?|minutes?|mins?)\b|\b(?:first|second|third|next)\s+(?:few\s+)?(?:hours?|days?|weeks?|months?|years?)\b|\bwithin\s+(?:a few\s+|several\s+)?(?:minutes|hours|days|weeks|months|years)\b|\b(?:over|in) the (?:following|next) (?:minutes|hours|days|weeks|months|years)\b|\b(?:acute|subacute|chronic|early|late|long[- ]term|short[- ]term|postpartum|follow[- ]up|baseline|at diagnosis|lifelong|neonatal|adolescen\w+|childhood|adulthood|old age)\b|\bphase\s+(?:[ivx]+|\d+|\w+)\b|\bstage\s+(?:[ivx]+|\d+)\b/gi;
const CONTRAST = /\b(?:whereas|while|in contrast|by contrast|on the other hand|versus|vs\.?|compared (?:with|to)|unlike)\b/i;
const HIGH = /\b(high|elevated|raised|increased|above|positive|rising|supranormal|abnormally high)\b/i;
const LOW = /\b(low|reduced|decreased|below|negative|suppressed|falling|deficien\w+|absent)\b/i;
const INTERPRET = /\b(suggests?|indicates?|points to|consistent with|reflects?|means|implies|supports|raises concern for|seen in|typical of|signals?|identifies)\b/i;
const LAB_WORDS = /\b(test|level|levels|serum|plasma|assay|marker|biomarker|troponin|creatinine|egfr|hba1c|ferritin|bnp|crp|esr|haemoglobin|hemoglobin|sodium|potassium|inr|tsh|ldl|hdl|cholesterol|glucose|urea|bilirubin|albumin|d-dimer|lactate|ph|result|reading|count|titre|titer)\b/i;
const WORKFLOW = /\b(step\s*\d|first[- ]line|second[- ]line|algorithm|stepwise|step-by-step|work-?up|approach to|flow ?chart|initial (?:evaluation|assessment|management)|next step|escalate|refer(?:ral)?|order(?:ing)?\b|then (?:start|add|order|refer|consider|give|repeat)|if\b[^.]{3,80}?,\s*(?:then\s+)?(?:start|order|refer|consider|treat|give|repeat|admit))/gi;
const CASE = /\b(\d{1,3}[- ]year[- ]old|presents? with|presented with|presenting with|case \d|clinical scenario|a (?:man|woman|patient|child|boy|girl|infant) (?:with|who|presents))\b/i;
const LIST_CUE = /\b(risk factors|causes include|contributors?|factors include|common causes|etiolog\w+|differential|includes?|including|such as|several|multiple|categories|types of)\b/i;
const FINDING = /\b(ecg|ekg|x-ray|radiograph\w*|ct|mri|ultrasound|echo\w*|scan|shows?|reveals?|demonstrates?|on examination|examination|blood pressure|heart rate|auscultation)\b/i;
const ANAT = /\b(anatom\w*|located|location|lies|situated|structure|chambers?|lobes?|arter(?:y|ies)|veins?|vessels?|valves?|wall|layers?|regions?|surface|position|organ|nephron|alveol\w+|cortex|medulla)\b/i;

/** Organs the schematic body map can mark, with a frontal-view position (patient facing the viewer). */
export const ORGANS: Record<string, { match: RegExp; name: string; at: Array<[number, number]> }> = {
  brain: { match: /\bbrain\b|\bcerebr\w+|\bcerebell\w+/i, name: "Brain", at: [[960, 190]] },
  thyroid: { match: /\bthyroid\b/i, name: "Thyroid", at: [[960, 292]] },
  heart: { match: /\bheart\b|\bcardiac\b|\bmyocardi\w+|\bcoronary\b|\bventricl\w+|\batri(?:um|al)\b/i, name: "Heart", at: [[985, 372]] },
  lungs: { match: /\blungs?\b|\bpulmonary\b|\balveol\w+|\bbronch\w+/i, name: "Lungs", at: [[893, 360], [1027, 360]] },
  liver: { match: /\bliver\b|\bhepat\w+/i, name: "Liver", at: [[915, 438]] },
  stomach: { match: /\bstomach\b|\bgastric\b/i, name: "Stomach", at: [[1010, 440]] },
  spleen: { match: /\bspleen\b|\bsplenic\b/i, name: "Spleen", at: [[1050, 430]] },
  pancreas: { match: /\bpancrea\w+|\bislets?\b/i, name: "Pancreas", at: [[968, 470]] },
  kidneys: { match: /\bkidneys?\b|\brenal\b|\bnephr\w+|\bglomerul\w+/i, name: "Kidneys", at: [[905, 488], [1015, 488]] },
  intestines: { match: /\bintestin\w+|\bbowel\b|\bcolon\b|\bcolonic\b|\bileum\b|\bjejun\w+/i, name: "Intestines", at: [[960, 540]] },
  bladder: { match: /\bbladder\b/i, name: "Bladder", at: [[960, 566]] },
};

function organsIn(text: string): string[] {
  return Object.entries(ORGANS)
    .map(([id, o]) => ({ id, at: text.search(o.match) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.id);
}

// ---------- per-template derivation (each returns null when the content cannot fill it) ----------

const PROCEDURAL = /\b(assess\w*|manag\w+|approach|steps?|workflow|protocol|algorithm|treat\w*|escalat\w*|reassess\w*|investigat\w*|diagnos\w+|screen\w*|resuscitat\w*|checklist|bundle)\b/i;
const PARALLEL = /\b(parallel|simultaneous\w*|at the same time|concurrent\w*|together)\b/i;
const GENERIC_TITLE = /^(introduction|welcome|overview|agenda|objectives|learning objectives|outline|thank you|questions|references|disclaimer|contents)\b/i;

/** Numbered boxes / arrows on a slide can mean cause → effect, ordered steps, or things done at the same time. */
function sequenceKind(src: DeriveSource): "parallel" | "workflow" | "pathway" {
  const st = structureOf(src);
  if (PARALLEL.test(`${src.title} ${st.subtitle ?? ""}`) || /\b(in parallel|simultaneous\w*|at the same time|concurrent\w*)\b/i.test(src.narration)) return "parallel";
  if (PROCEDURAL.test(src.title)) return "workflow";
  return "pathway";
}

/** A title / opening slide: no list of items on it is a pathway or a set of contributors. */
function isCover(src: DeriveSource): boolean {
  return GENERIC_TITLE.test(src.title.trim()) || (src.slide === 1 && /^(welcome|hello|in this (module|lesson|course|session)|this (module|lesson|course|session))\b/i.test(src.narration.trim()));
}

type Out = { params: SlidePlan["params"]; items: DerivedItem[]; assumptions: string[]; analysis: Pick<Analysis, "mechanism" | "objective"> } | null;

function pathwayOut(src: DeriveSource, min: number): Out {
  const sents = splitSentences(src.narration);
  let nodes: string[] = [];
  const bullets = sourceLines(src);
  if (bullets.length >= 3 && bullets.length <= 5) nodes = bullets;
  else {
    // Clauses of the causal sentences, split where the narration itself chains them (", which", ", resulting in", ", and then").
    for (const s of sents) {
      if (!CAUSAL.test(s) || takeaway(s)) continue;
      const clauses = trimEnd(s)
        .split(/,\s*(?:which (?:then |in turn |eventually )?|resulting in |leading to |followed by |and then |and (?:eventually |ultimately ))/i)
        .map((f) => trimEnd(clean(f).replace(/^(and|but|eventually|this|that|it|these|then|also|so)\s+/i, "")))
        .filter((f) => f.length >= 6 && f.length <= 120);
      for (const f of clauses) if (!nodes.some((n) => n.toLowerCase() === cap(f).toLowerCase())) nodes.push(cap(f));
      if (nodes.length >= 5) break;
    }
  }
  nodes = nodes.slice(0, 5);
  if (nodes.length < min) return null;
  const items: DerivedItem[] = nodes.map((n, i) => item(`n${i + 1}`, headSub(n, 56, 100), src.narration, { description: `Step ${i + 1}: ${clip(n, 40)}` }));
  const tk = lastTakeaway(splitSentences(src.narration));
  const sub = structureOf(src).subtitle;
  if (tk) items.push(item("note", clip(tk, 150), src.narration, { free: true, description: "Take-home note" }));
  else if (sub) items.push(item("note", clip(sub, 150), src.narration, { free: true, description: "Slide subtitle" }));
  const escalate = /\b(worsen|progress|severe|complication|failure|irreversible|advanced|damage)\w*/i.test(src.narration);
  return {
    params: { escalate },
    items,
    assumptions: ["The arrows link the slide's own phrases in the order they are narrated; they are a visual device, not an added causal claim. Confirm each step follows from the previous one."],
    analysis: { mechanism: nodes.map((n) => clip(n, 60)).join(" → ").slice(0, 300), objective: `Follow the sequence from "${clip(nodes[0]!, 50)}" to "${clip(nodes[nodes.length - 1]!, 50)}".` },
  };
}

function listFrom(src: DeriveSource): string[] {
  const bullets = sourceLines(src);
  if (bullets.length >= 3 && bullets.length <= 6) return bullets;
  const m = /(?:includes?|including|such as|are|factors?|causes?|contributors?|categories|types)\s*:?\s*([^.]{12,240})\./i.exec(src.narration);
  if (!m) return [];
  const parts = m[1]!
    .split(/,\s*(?:and\s+|or\s+)?|\s+and\s+|;\s*/i)
    .map((p) => trimEnd(clean(p)))
    .filter((p) => p.length >= 3 && p.length <= 60);
  return parts.length >= 3 && parts.length <= 6 ? parts : [];
}

function convergeOut(src: DeriveSource, min: number): Out {
  const list = listFrom(src);
  if (list.length < min) return null;
  const sents = splitSentences(src.narration);
  const concl = structureOf(src).subtitle ?? lastTakeaway(sents) ?? sents[sents.length - 1] ?? src.title;
  const items: DerivedItem[] = list.map((l, i) => item(`s${i + 1}`, headSub(l, 56, 60), src.narration, { free: true, description: `Contributor ${i + 1}: ${clip(l, 36)}` }));
  const head = trimEnd(clean(src.title));
  items.push(item("out", `${clip(head, 44)}|${clip(cap(trimEnd(concl)), 120)}`, src.narration, { free: true, description: "Conclusion" }, "sub"));
  return {
    params: {},
    items,
    assumptions: [sequenceKind(src) === "parallel" ? "The items are drawn side by side and feed one outcome because the slide says they happen together; no order or priority is implied." : "The arrows show the listed items feeding the stated conclusion; they illustrate the slide's wording, not additional mechanism."],
    analysis: { mechanism: list.map((l) => clip(l, 40)).join(" + ").slice(0, 300), objective: `Recognise the factors that together explain "${clip(head, 60)}".` },
  };
}

function timelineOut(src: DeriveSource, min: number): Out {
  const sents = splitSentences(src.narration);
  const marks: Array<{ head: string; sub: string; sent: string }> = [];
  for (const s of sents) {
    const m = [...s.matchAll(TIME_EXPR)][0];
    if (!m) continue;
    const comma = s.indexOf(",");
    const lead = comma > 0 && comma <= 44 && (m.index ?? 0) < comma ? trimEnd(s.slice(0, comma)) : "";
    const head = cap(lead || trimEnd(m[0].trim()));
    let rest = lead ? trimEnd(s.slice(comma + 1)) : trimEnd(s.replace(m[0], " ").replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").replace(/^[\s,;:–—-]+/, ""));
    rest = rest.replace(/^(?:at|in|by|after|during|within|over|and|the)\s+/i, "");
    if (head.length > 36 || rest.length < 6) continue;
    if (marks.some((x) => x.head.toLowerCase() === head.toLowerCase())) continue;
    marks.push({ head, sub: clip(cap(rest.trim()), 120), sent: s });
  }
  if (marks.length < min) return null;
  let pick = marks;
  if (marks.length > 4) pick = [marks[0]!, marks[Math.floor((marks.length - 1) / 3)]!, marks[Math.floor(((marks.length - 1) * 2) / 3)]!, marks[marks.length - 1]!];
  const items = pick.map((m, i) => item(`m${i + 1}`, `${m.head}|${m.sub}`, src.narration, { free: true, description: `Time point ${i + 1}: ${m.head}` }));
  const tk = lastTakeaway(sents);
  if (tk) items.push(item("note", clip(tk, 150), src.narration, { free: true, description: "Take-home note" }));
  return {
    params: {},
    items,
    assumptions: ["Timeline spacing is schematic; the time points are the narration's own wording and are placed in the order narrated, not to scale."],
    analysis: { mechanism: pick.map((m) => m.head).join(" → "), objective: `Place the key events on the time course: ${pick.map((m) => m.head.toLowerCase()).join(", ")}.` },
  };
}

function labOut(src: DeriveSource, min: number): Out {
  const sents = splitSentences(src.narration);
  const split = (re: RegExp): { head: string; sub: string } | null => {
    for (const s of sents) {
      if (!re.test(s) || !INTERPRET.test(s)) continue;
      const m = INTERPRET.exec(s)!;
      const head = trimEnd(clean(s.slice(0, m.index)).replace(/\b(?:a|an|the)\s+/i, ""));
      const sub = trimEnd(
        (s.slice(m.index).split(/,\s+(?:and|but|which|so)\s/i)[0] ?? "").replace(/[\s.]+$/, "").replace(/\s+in (?:the|this|an?) [\w\s-]{0,40}(?:context|setting)$/i, "").replace(/^(\w+)\s+that\s+/i, "$1 "),
      );
      if (head.length >= 5 && head.length <= 90 && sub.length >= 8) return { head: cap(clip(head, 70)), sub: clip(cap(sub), 120) };
    }
    return null;
  };
  const hi = split(HIGH);
  const lo = split(LOW);
  const have = [hi, lo].filter(Boolean).length;
  if (have < min) return null;
  const test = clip(cap(trimEnd(clean(src.title)).replace(/\s*[–—:-]\s*(?:interpretation|results?|overview|and (?:its )?interpretation).*$/i, "").replace(/\s+(?:interpretation|results?|overview|testing)$/i, "")), 40);
  const what = sents.find((s) => !INTERPRET.test(s) && s.length <= 140 && s.length >= 20);
  const items: DerivedItem[] = [item("test", test, src.narration, { free: true, description: "Test name" })];
  if (what) items.push(item("what", clip(what, 140), src.narration, { free: true, description: "What the test shows" }));
  if (hi) items.push(item("hi", `${hi.head}|${hi.sub}`, src.narration, { free: true, description: "High result" }));
  if (lo) items.push(item("lo", `${lo.head}|${lo.sub}`, src.narration, { free: true, description: "Low result" }));
  return {
    params: {},
    items,
    assumptions: ["The gauge needle is a metaphor for high versus low; no numeric scale or reference range is drawn. Interpretations are the narration's own sentences."],
    analysis: { mechanism: [hi && `${hi.head} ${hi.sub}`, lo && `${lo.head} ${lo.sub}`].filter(Boolean).join(" / ").slice(0, 300), objective: `Interpret ${test}: what a high and a low result mean.` },
  };
}

function compareOut(src: DeriveSource, min: number): Out {
  const sents = splitSentences(src.narration);
  const rows: Array<[string, string]> = [];
  for (const s of sents) {
    const m = /^(.{12,150}?),?\s*(?:whereas|while|in contrast,?|by contrast,?|on the other hand,?|unlike)\s+(.{8,170})$/i.exec(trimEnd(s));
    if (m) rows.push([trimEnd(m[1]!), trimEnd(m[2]!)]);
  }
  const t = /^(.{3,45}?)\s+(?:vs\.?|versus|or|and)\s+(.{3,45}?)(?:\s*[:–—-].*)?$/i.exec(trimEnd(clean(src.title)));
  const sides = /\b(vs\.?|versus)\b/i.test(src.title) && t ? [cap(t[1]!.trim()), cap(t[2]!.trim())] : null;
  if (rows.length < min && !(sides && rows.length >= 1)) return null;
  if (!rows.length) return null;
  const subject = (c: string): string => cap(clip(c.split(/\s+(?:is|are|has|have|shows?|presents?|causes?|results?|occurs?|affects?|tends?|usually|typically)\b/i)[0] ?? c, 34));
  const A = sides?.[0] ?? subject(rows[0]![0]);
  const B = sides?.[1] ?? subject(rows[0]![1]);
  const take = rows.slice(0, 4);
  const items: DerivedItem[] = [
    { id: "A", label: A, cues: [], free: true, frac: 0, description: "Left side" },
    { id: "B", label: B, cues: [], free: true, frac: 0.03, description: "Right side" },
  ];
  take.forEach(([a, b], i) => {
    items.push(item(`a${i + 1}`, clip(cap(a), 100), src.narration, { free: true, description: `Left ${i + 1}` }));
    items.push(item(`b${i + 1}`, clip(cap(b), 100), src.narration, { free: true, description: `Right ${i + 1}` }));
  });
  const tk = lastTakeaway(sents);
  if (tk) items.push(item("verdict", clip(tk, 150), src.narration, { free: true, description: "Take-home note" }));
  return {
    params: {},
    items,
    assumptions: ["The two sides are split at the narration's own contrast words (whereas / while / unlike). Confirm each statement is on the correct side."],
    analysis: { mechanism: `${A} vs ${B}`, objective: `Distinguish ${A} from ${B}.` },
  };
}

function workflowOut(src: DeriveSource, min: number): Out {
  const sents = splitSentences(src.narration);
  const bullets = sourceLines(src);
  const steps: string[] = [];
  if (bullets.length >= 3 && bullets.length <= 8 && (count(WORKFLOW, src.title + " " + bullets.join(" ")) > 0 || /\bstep\s*\d/i.test(bullets.join(" ")) || structureOf(src).sequence || PROCEDURAL.test(src.title))) steps.push(...bullets);
  else {
    for (const s of sents) {
      if (takeaway(s)) continue;
      const hit = /\b(first|then|next|finally|step\s*\d|if\b|start|order|refer|consider|begin|initial|repeat|escalate|confirm)\b/i.test(s);
      if (hit && s.length >= 12 && s.length <= 190) steps.push(trimEnd(s));
    }
  }
  const picked = steps.slice(0, 6);
  if (picked.length < min) return null;
  const params: SlidePlan["params"] = {};
  const conditional = sents.filter((x) => /^(?:if|when|once)\b/i.test(x));
  const items = picked.map((s, i) => {
    const kind = /^(if|when|in patients? (?:with|who)|whether|where)\b/i.test(clean(s)) || /\bif\b.{3,80},/i.test(s) || conditional.some((x) => similar(s, x)) ? "decision" : i === 0 ? "start" : "action";
    params[`w${i + 1}.kind`] = kind;
    const body = clean(s).replace(/^(first|then|next|finally|also|after that)[,:]?\s+/i, "");
    return item(`w${i + 1}`, headSub(body, 60, 90), src.narration, { description: `Step ${i + 1}: ${clip(body, 40)}` });
  });
  return {
    params,
    items,
    assumptions: ["The workflow shows the steps in narrated order; decision shapes mark steps that begin with a condition (if / when). The tool does not add branches, thresholds or drugs."],
    analysis: { mechanism: picked.map((p) => clip(clean(p), 40)).join(" → ").slice(0, 300), objective: `Follow the approach step by step: ${clip(clean(picked[0]!), 50)} … ${clip(clean(picked[picked.length - 1]!), 50)}.` },
  };
}

function organOut(src: DeriveSource, min: number): Out {
  const all = `${src.title}\n${src.slideText.join("\n")}\n${src.narration}`;
  const found = organsIn(all).slice(0, 6);
  if (found.length < min) return null;
  const sents = splitSentences(src.narration);
  const params: SlidePlan["params"] = {};
  const used = new Set<string>();
  const items = found.map((id, i) => {
    const o = ORGANS[id]!;
    params[`o${i + 1}.organ`] = id;
    const s = sents.find((x) => o.match.test(x));
    const clause = s ? trimEnd(s).split(/,\s+/).find((c) => o.match.test(c)) ?? trimEnd(s) : "";
    const sub = clause && !used.has(clause) ? clip(cap(clause), 100) : "";
    if (sub) used.add(clause);
    const cue = (/[a-z]+/i.exec(s?.match(o.match)?.[0] ?? o.name) ?? [o.name])[0]!;
    return { id: `o${i + 1}`, label: sub ? `${o.name}|${sub}` : o.name, cues: [cue], free: true, description: `Organ: ${o.name}` };
  });
  return {
    params,
    items,
    assumptions: ["Organ markers sit at standard schematic positions on a body outline (patient facing the viewer); the outline is not an anatomical drawing and no sizes or relationships are implied beyond the label."],
    analysis: { mechanism: found.map((id) => ORGANS[id]!.name).join(", "), objective: `Locate and name the organs discussed: ${found.map((id) => ORGANS[id]!.name.toLowerCase()).join(", ")}.` },
  };
}

const PANEL_KIND: Array<[RegExp, string]> = [
  [/present|history|patient|scenario|complaint|background/i, "profile"],
  [/finding|investigat|exam|lab|result|vital|observ/i, "labs"],
  [/interpret|diagnos|impression/i, "interp"],
  [/respon|manag|plan|pathway|treat|action|next/i, "plan"],
];
const titleCase = (s: string): string => cap(s.toLowerCase());

/** A case laid out by the slide itself: each ALL-CAPS heading is a panel and the lines under it are its lines. */
function caseFromSections(src: DeriveSource, min: number): Out {
  const st = structureOf(src);
  const panels = st.sections.filter((s) => s.lines.length > 0).slice(0, 3);
  if (panels.length < Math.max(1, min)) return null;
  const params: SlidePlan["params"] = { panels: panels.length, build: /\b(obes\w+|overweight)\b/i.test(src.narration) ? "obese" : /\b(lean|thin|underweight)\b/i.test(src.narration) ? "lean" : "average" };
  const items: DerivedItem[] = [];
  panels.forEach((sec, i) => {
    const p = `p${i + 1}`;
    const kind = PANEL_KIND.find(([re]) => re.test(sec.header))?.[1] ?? (i === 0 ? "profile" : "labs");
    params[`${p}.kind`] = kind;
    items.push(item(p, titleCase(sec.header), src.narration, { description: `Panel: ${titleCase(sec.header)}` }));
    sec.lines.slice(0, 4).forEach((l, j) => items.push(item(`${p}.l${j + 1}`, clip(cap(trimEnd(l)), 86), src.narration, { description: `${titleCase(sec.header)}: ${clip(l, 36)}` })));
  });
  return {
    params,
    items,
    assumptions: ["The patient figure is a generic body-build icon. The panels and their lines are the slide's own headings and wording; confirm each line is under the right heading."],
    analysis: { mechanism: panels.map((p) => titleCase(p.header)).join(" → "), objective: "Apply the approach to the case on the slide." },
  };
}

function caseOut(src: DeriveSource, min: number): Out {
  const fromSections = caseFromSections(src, min);
  if (fromSections) return fromSections;
  const sents = splitSentences(src.narration);
  const bullets = sourceLines(src);
  const profile: string[] = [];
  const findings: string[] = [];
  const interp: string[] = [];
  const clauses = [...sents, ...bullets].flatMap((s) => trimEnd(s).split(/,\s+(?:and|but|so)\s+|;\s*/i));
  for (const s of clauses) {
    const t = trimEnd(clean(s).replace(/^(and|but|so)\s+/i, ""));
    if (t.length < 6 || t.length > 150) continue;
    if (CASE.test(t) || /\b(history of|symptoms?|complains?|presents?|bmi|smok\w+|family history)\b/i.test(t)) profile.push(t);
    else if (INTERPRET.test(t) || /\b(diagnos\w+|likely|probable|consistent with)\b/i.test(t)) interp.push(t);
    else if (/\d/.test(t) || LAB_WORDS.test(t) || FINDING.test(t)) findings.push(t);
  }
  const taken: string[] = [];
  const uniq = (a: string[]): string[] => {
    const out: string[] = [];
    for (const x of a) {
      if (taken.some((y) => similar(x, y) || similar(y, x))) continue;
      taken.push(x);
      out.push(x);
    }
    return out;
  };
  const split = (a: string[]): string[] =>
    a.flatMap((x) => {
      if (x.length <= 64) return [x];
      const k = x.lastIndexOf(" and ", 64);
      return k > 20 && x.length - k - 5 >= 6 && x.length - k - 5 <= 64 ? [x.slice(0, k), cap(x.slice(k + 5))] : [x];
    });
  const p1 = split(uniq(profile)).slice(0, 4);
  const p2 = split(uniq(findings)).slice(0, 4);
  const p3 = split(uniq(interp)).slice(0, 3);
  const panels = [p1.length ? (["profile", "Patient", p1] as const) : null, p2.length ? (["labs", "Findings", p2] as const) : null, p3.length ? (["interp", "Interpretation", p3] as const) : null].filter(Boolean) as Array<readonly [string, string, string[]]>;
  if (panels.length < min || !p1.length) return null;
  const params: SlidePlan["params"] = { panels: panels.length, build: /\b(obes\w+|overweight|bmi (?:of )?(?:3\d|4\d))\b/i.test(src.narration) ? "obese" : /\b(lean|thin|underweight|bmi (?:of )?(?:1\d|2[0-2]))\b/i.test(src.narration) ? "lean" : "average" };
  const items: DerivedItem[] = [];
  panels.forEach(([kind, title, lines], i) => {
    const p = `p${i + 1}`;
    params[`${p}.kind`] = kind;
    items.push(item(p, title, src.narration, { description: `Panel: ${title}` }));
    lines.forEach((l, j) => {
      const kv = /^(?:(?:his|her|their|the)\s+)?(.{3,34}?)\s+(?:is|was|of|=|:)\s+((?:[<>≥≤~]\s*)?\d[\d.,]*\s*[A-Za-z/%µ²]{0,10})$/i.exec(l);
      const label = kv ? `${cap(kv[1]!.trim())}: ${kv[2]!.trim()}` : clip(cap(l), 86);
      items.push(item(`${p}.l${j + 1}`, label, src.narration, { description: `${title}: ${clip(label, 36)}` }));
    });
  });
  return {
    params,
    items,
    assumptions: ["The patient figure is a generic body-build icon; lab values and findings are shown exactly as written in the narration or slide, with no added reference ranges. Confirm each line is under the right panel."],
    analysis: { mechanism: panels.map((p) => p[1]).join(" → "), objective: "Work through the case: presentation, findings, interpretation." },
  };
}

function balanceOut(src: DeriveSource, min: number): Out {
  const c = compareOut(src, min);
  if (!c) return null;
  const map = (id: string): string => (id === "A" ? "L" : id === "B" ? "R" : id.replace(/^a/, "l").replace(/^b/, "r"));
  return { ...c, params: { tilt: "level" }, items: c.items.map((i) => ({ ...i, id: map(i.id) })), assumptions: ["The scale is a metaphor for two opposing factors; it does not weigh them quantitatively.", ...c.assumptions] };
}

const DERIVERS: Partial<Record<TemplateId, (src: DeriveSource, min: number) => Out>> = {
  pathway: pathwayOut,
  converge: convergeOut,
  timeline: timelineOut,
  "lab-branch": labOut,
  compare: compareOut,
  workflow: workflowOut,
  "organ-map": organOut,
  case: caseOut,
  balance: balanceOut,
};

/** Templates the deriver can fill for an arbitrary slide. */
export const DERIVABLE: TemplateId[] = Object.keys(DERIVERS) as TemplateId[];

const CATEGORY: Partial<Record<TemplateId, Category>> = {
  pathway: "pathophysiology",
  converge: "physiology",
  timeline: "timeline",
  "lab-branch": "laboratory",
  compare: "comparison",
  workflow: "treatment-algorithm",
  "organ-map": "anatomy",
  case: "clinical-case",
  balance: "physiology",
};

function analysisOf(template: TemplateId, src: DeriveSource, o: NonNullable<Out>): Analysis {
  let category: Category = CATEGORY[template] ?? "general";
  const hay = `${src.title} ${src.narration}`;
  if (template === "workflow") category = /\b(diagnos|work-?up|investigat|evaluation|screen)\w*/i.test(hay) && !/\b(treat|therapy|manage|start|drug)\w*/i.test(hay) ? "diagnostic-workflow" : "treatment-algorithm";
  if (template === "converge" && /\b(recogni\w+|signs?|symptoms?|presentation|deteriorat\w*|takeaways?|summary|response|priorit\w+)\b/i.test(hay)) category = "clinical-pathway";
  if (template === "pathway") category = /\b(normal|physiolog\w+|regulat\w+|homeostasis)\b/i.test(hay) && !/\b(disease|damage|failure|injury|pathophys\w+|complication)\b/i.test(hay) ? "physiology" : /\b(patient|presents?|referral|care pathway)\b/i.test(hay) && count(CAUSAL_COUNT, hay) === 0 ? "clinical-pathway" : "pathophysiology";
  return { category, topic: clip(clean(src.title), 120), objective: (o.analysis.objective ?? "").slice(0, 300), ...(o.analysis.mechanism ? { mechanism: o.analysis.mechanism.slice(0, 300) } : {}) };
}

/**
 * Chained steps appear one after another. When the voice mentions them in a different order than the slide lists them
 * (the slide says infection → response → dysfunction, the narration starts from dysfunction), anchoring each step to its cue
 * would pile all of them at the end. Then the cues are dropped and the steps are spread evenly over the first part of the
 * narration, in the slide's order.
 */
function spreadIfOutOfOrder(items: DerivedItem[], idPattern: RegExp, narration: string): void {
  const chain = items.filter((i) => idPattern.test(i.id));
  if (chain.length < 2) return;
  const words = wordTimings(narration, 100);
  const at = chain.map((i) => {
    const hits = i.cues.map((c) => findPhrase(words, c)?.start).filter((v): v is number => v !== undefined);
    return hits.length ? Math.min(...hits) : null;
  });
  const known = at.filter((v): v is number => v !== null);
  const ordered = known.every((v, k) => k === 0 || v >= known[k - 1]!);
  if (ordered && known.length === chain.length) return;
  chain.forEach((i, k) => {
    i.cues = [];
    i.frac = Math.round((0.06 + (0.62 * k) / Math.max(1, chain.length - 1)) * 100) / 100;
  });
}

/**
 * Fill one template from this slide. `lenient` (used when a person or the AI picked the template) accepts thinner
 * content than automatic selection does. Null when the slide cannot fill it at all.
 */
export function deriveFor(template: TemplateId, src: DeriveSource, lenient = false): Derived | null {
  const fn = DERIVERS[template];
  if (!fn) return null;
  const min = lenient ? 1 : MIN_UNITS[template] ?? 2;
  const o = fn(src, min);
  if (!o || o.items.length === 0) return null;
  if (template === "pathway" || template === "workflow") spreadIfOutOfOrder(o.items, /^(n|w)\d+$/, src.narration);
  if (template === "pathway" || template === "converge" || template === "workflow") {
    for (const it of o.items) {
      const icon = /^(n|s|w)\d+$/.test(it.id) ? iconFor(it.label) : undefined;
      if (icon) o.params[`${it.id}.icon`] = icon;
    }
  }
  return {
    template,
    params: o.params,
    items: o.items,
    analysis: analysisOf(template, src, o),
    assumptions: o.assumptions,
    rationale: "",
    score: 0,
  };
}

const MIN_UNITS: Partial<Record<TemplateId, number>> = { pathway: 3, converge: 3, timeline: 3, "lab-branch": 1, compare: 2, workflow: 3, "organ-map": 1, case: 2, balance: 2 };

// ---------- automatic selection ----------

interface Candidate {
  template: TemplateId;
  score: number;
  why: string;
}

function count(re: RegExp, s: string): number {
  return [...s.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))].length;
}

/** Score every reusable template against the slide. Highest first; ties resolved by clinical specificity. */
export function rank(src: DeriveSource): Candidate[] {
  const title = src.title;
  const narr = src.narration;
  const all = `${title}\n${src.slideText.join("\n")}\n${narr}`;
  const c: Candidate[] = [];
  const add = (template: TemplateId, score: number, why: string): void => {
    if (score > 0) c.push({ template, score, why });
  };

  if (CASE.test(all) || (/\b(case|scenario)\b/i.test(title) && structureOf(src).sections.length >= 1)) add("case", 6 + count(CASE, all) * 2 + (/\b(case|scenario)\b/i.test(title) ? 3 : 0) + (structureOf(src).sections.length ? 2 : 0), "patient case wording");

  const organs = organsIn(all);
  const anat = count(ANAT, all);
  if (organs.length) add("organ-map", (organs.length >= 2 ? 3 : 1) * (anat ? 2 : 1) + anat + (/\b(anatomy|structure|location)\b/i.test(title) ? 4 : 0), `organs named (${organs.slice(0, 3).join(", ")}) with anatomical wording`);

  if (LAB_WORDS.test(title + " " + narr) && INTERPRET.test(narr) && (HIGH.test(narr) || LOW.test(narr))) {
    const both = HIGH.test(narr) && LOW.test(narr);
    add("lab-branch", 5 + (both ? 3 : 0) + (/\b(test|level|marker|interpretation|result)\b/i.test(title) ? 3 : 0), "a test result is interpreted as high or low");
  }

  const contrast = count(CONTRAST, narr) + (/\b(vs\.?|versus)\b/i.test(title) ? 3 : 0);
  if (contrast >= 1) add("compare", 4 + contrast * 2, "contrast wording (whereas / versus / unlike)");

  const time = new Set([...all.matchAll(TIME_EXPR)].map((m) => m[0].toLowerCase())).size;
  if (time >= 3) add("timeline", 3 + time + (/\b(time ?course|timeline|natural history|progression|phase|stages?|follow-?up|course of)\b/i.test(title) ? 4 : 0), `${time} distinct time points`);

  const sequenced = splitSentences(narr).filter((x) => /^(?:first|second|third|next|then|after that|finally|lastly|if|when|once)\b/i.test(x)).length;
  const wf = count(WORKFLOW, all) + (sequenced >= 3 ? sequenced : 0);
  if (wf >= 3 || (/\b(algorithm|approach|management|work-?up|steps?|pathway|protocol)\b/i.test(title) && wf >= 1)) add("workflow", 3 + wf * 2 + (/\b(algorithm|approach|work-?up|steps?|protocol)\b/i.test(title) ? 4 : 0), "ordered steps or decisions");

  const causal = count(CAUSAL_COUNT, narr);
  if (causal >= 2) add("pathway", 3 + causal * 2 + (/\b(patho\w+|mechanism|cascade|how|why|effect)\b/i.test(title) ? 3 : 0), `${causal} cause → effect links`);

  if (LIST_CUE.test(all) && listFrom(src).length >= 3) add("converge", 5 + (/\b(risk factors|causes|etiolog\w+|contributors|differential|types)\b/i.test(title) ? 3 : 0), "a list of contributors to one conclusion");

  // The slide's own layout (numbered boxes, arrows, a short list under a heading) is stronger evidence than narration wording.
  const st = structureOf(src);
  const nodes = st.items.length;
  if (!isCover(src)) {
    if (st.sequence && nodes >= 3 && nodes <= 5) {
      const kind = sequenceKind(src);
      add(kind === "parallel" ? "converge" : kind, 12, kind === "parallel" ? "numbered boxes for actions that happen together" : kind === "workflow" ? "numbered steps of a process" : "numbered boxes linked by arrows");
    } else if (nodes >= 3 && nodes <= 6) {
      if (PROCEDURAL.test(src.title)) add("workflow", 8, "a short list of steps under a process heading");
      else add("converge", 6.5, "a short list of items under one heading");
    }
  }

  const tie: TemplateId[] = ["case", "organ-map", "lab-branch", "compare", "timeline", "workflow", "pathway", "converge"];
  return c.sort((a, b) => b.score - a.score || tie.indexOf(a.template) - tie.indexOf(b.template));
}

const MIN_SCORE = 6;

/** Best reusable scene for a slide, or null when only the generic key-points layout fits. */
export function deriveScene(src: DeriveSource): Derived | null {
  for (const cand of rank(src)) {
    if (cand.score < MIN_SCORE) continue;
    const d = deriveFor(cand.template, src, false);
    if (d) return { ...d, score: cand.score, rationale: `Reusable "${cand.template}" scene (score ${cand.score}): ${cand.why}.` };
  }
  return null;
}
