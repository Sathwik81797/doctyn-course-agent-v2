// @ts-nocheck
// Slide editor: the data operations behind the workspace (no DOM, so they are unit-tested directly in Node).
// A slide is { uid, origin: { page } | null, title, narration, edits, pptxText }.
// edits = { shapes: { [shapeId]: { x,y,w,h,text[],size,font,color,fill,bold,italic,align,deleted } }, added: [ element ], bg }.
// All coordinates are fractions (0..1) of the slide, so they do not depend on screen size.

export const FONT_STACKS = {
  Calibri: 'Calibri, Carlito, "Segoe UI", Arial, sans-serif',
  Arial: "Arial, Helvetica, sans-serif",
  "Segoe UI": '"Segoe UI", system-ui, sans-serif',
  Verdana: "Verdana, Geneva, sans-serif",
  Tahoma: "Tahoma, Geneva, sans-serif",
  Georgia: "Georgia, serif",
  Cambria: "Cambria, Georgia, serif",
  "Times New Roman": '"Times New Roman", Times, serif',
  "Courier New": '"Courier New", monospace',
  "Trebuchet MS": '"Trebuchet MS", sans-serif',
};
export const FONTS = Object.keys(FONT_STACKS);

export const PALETTE = {
  info: { fill: "#E0F2FE", stroke: "#0369A1" },
  decision: { fill: "#FEF3C7", stroke: "#B45309" },
  good: { fill: "#DCFCE7", stroke: "#15803D" },
  warn: { fill: "#FEE2E2", stroke: "#B91C1C" },
  neutral: { fill: "#F1F5F9", stroke: "#475569" },
};

let counter = 0;
export function uid(prefix = "n") {
  counter += 1;
  const rnd = (globalThis.crypto?.getRandomValues ? [...globalThis.crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("") : Math.random().toString(16).slice(2, 10));
  return `${prefix}${rnd}${counter.toString(36)}`;
}

export const clone = (v) => JSON.parse(JSON.stringify(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round4 = (v) => Math.round(v * 10000) / 10000;

// ---------------------------------------------------------------- slide list

export function newSlide() {
  return {
    uid: uid("s"),
    origin: null,
    title: "New slide",
    narration: "",
    pptxTitle: "",
    pptxText: [],
    edits: {
      bg: "#FFFFFF",
      added: [
        { id: uid("t"), type: "text", x: 0.06, y: 0.06, w: 0.88, h: 0.12, text: "Slide title", size: 40, bold: true, color: "#0F172A", font: "Calibri", align: "left" },
        { id: uid("t"), type: "text", x: 0.06, y: 0.24, w: 0.88, h: 0.6, text: "• First teaching point\n• Second teaching point", size: 26, color: "#1E293B", font: "Calibri", align: "left" },
      ],
    },
  };
}

/** New slide after position `index` (-1 = at the start). Returns the new list and the index of the new slide. */
export function insertSlide(slides, index, slide = newSlide()) {
  const next = slides.slice();
  next.splice(index + 1, 0, slide);
  return { slides: next, index: index + 1 };
}

export function duplicateSlide(slides, index) {
  const src = slides[index];
  const copy = { ...clone(src), uid: uid("s"), title: /\(copy\)$/.test(src.title) ? src.title : `${src.title} (copy)` };
  return insertSlide(slides, index, copy);
}

export function deleteSlide(slides, index) {
  if (slides.length <= 1) return { slides, index: 0 };
  const next = slides.filter((_, i) => i !== index);
  return { slides: next, index: Math.min(index, next.length - 1) };
}

export function moveSlide(slides, from, to) {
  if (from === to || from < 0 || to < 0 || from >= slides.length || to >= slides.length) return { slides, index: from };
  const next = slides.slice();
  const [s] = next.splice(from, 1);
  next.splice(to, 0, s);
  return { slides: next, index: to };
}

/** Narration is a property of the slide object, so it can only ever move together with its slide. This returns the pairing for display/checks. */
export const pairing = (slides) => slides.map((s, i) => ({ slide: i + 1, uid: s.uid, title: s.title, narration: s.narration }));

// ---------------------------------------------------------------- undo / redo

export class History {
  constructor(limit = 150) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.lastTag = "";
    this.lastAt = 0;
  }
  /** Record the state BEFORE a change. Rapid changes with the same tag (typing) share one step. */
  push(snapshot, tag = "", now = Date.now()) {
    if (tag && tag === this.lastTag && now - this.lastAt < 900) {
      this.lastAt = now;
      return;
    }
    this.lastTag = tag;
    this.lastAt = now;
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  undo(current) {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(current);
    this.lastTag = "";
    return prev;
  }
  redo(current) {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(current);
    this.lastTag = "";
    return next;
  }
}

// ---------------------------------------------------------------- shapes and elements

export const ensureEdits = (slide) => (slide.edits ??= {});

export function shapeGeom(shape, edit) {
  return { x: edit?.x ?? shape.x, y: edit?.y ?? shape.y, w: edit?.w ?? shape.w, h: edit?.h ?? shape.h };
}

/** Merge a change into the edit record of an ORIGINAL shape; empty records are removed. */
export function patchShape(slide, id, patch) {
  const edits = ensureEdits(slide);
  const shapes = (edits.shapes ??= {});
  const next = { ...(shapes[id] ?? {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  if (Object.keys(next).length) shapes[id] = next;
  else delete shapes[id];
  if (!Object.keys(shapes).length) delete edits.shapes;
}

export function findAdded(slide, id) {
  return slide.edits?.added?.find((e) => e.id === id);
}

export function addElement(slide, el) {
  const edits = ensureEdits(slide);
  (edits.added ??= []).push(el);
  return el;
}

export function patchAdded(slide, id, patch) {
  const el = findAdded(slide, id);
  if (!el) return null;
  Object.assign(el, patch);
  for (const k of Object.keys(el)) if (el[k] === undefined) delete el[k];
  reconnect(slide);
  return el;
}

export function removeAdded(slide, id) {
  const edits = ensureEdits(slide);
  edits.added = (edits.added ?? []).filter((e) => e.id !== id).map((e) => ((e.from === id || e.to === id) ? { ...e, from: e.from === id ? undefined : e.from, to: e.to === id ? undefined : e.to } : e));
  for (const e of edits.added) for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  if (!edits.added.length) delete edits.added;
}

export function duplicateAdded(slide, id) {
  const el = findAdded(slide, id);
  if (!el) return null;
  const copy = { ...clone(el), id: uid("e"), x: clamp((el.x ?? 0) + 0.02, -0.5, 1.4), y: clamp((el.y ?? 0) + 0.03, -0.5, 1.4) };
  delete copy.from;
  delete copy.to;
  if (copy.x1 !== undefined) { copy.x1 += 0.02; copy.x2 += 0.02; copy.y1 += 0.03; copy.y2 += 0.03; }
  return addElement(slide, copy);
}

/** The point where a line from the centre of `box` toward (tx,ty) leaves the box. */
export function boundaryPoint(box, tx, ty) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const t = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity);
  return { x: round4(cx + dx * t), y: round4(cy + dy * t) };
}

/** Arrows attached to boxes follow them when the boxes move. */
export function reconnect(slide) {
  const added = slide.edits?.added;
  if (!added) return;
  for (const a of added) {
    if (a.type !== "arrow" && a.type !== "line") continue;
    const from = a.from ? added.find((e) => e.id === a.from) : null;
    const to = a.to ? added.find((e) => e.id === a.to) : null;
    if (!from && !to) continue;
    const start = from ? { x: from.x + from.w / 2, y: from.y + from.h / 2 } : { x: a.x1, y: a.y1 };
    const end = to ? { x: to.x + to.w / 2, y: to.y + to.h / 2 } : { x: a.x2, y: a.y2 };
    if (from) {
      const p = boundaryPoint(from, end.x, end.y);
      a.x1 = p.x;
      a.y1 = p.y;
    }
    if (to) {
      const p = boundaryPoint(to, start.x, start.y);
      a.x2 = p.x;
      a.y2 = p.y;
    }
    a.x = Math.min(a.x1, a.x2);
    a.y = Math.min(a.y1, a.y2);
    a.w = Math.abs(a.x2 - a.x1);
    a.h = Math.abs(a.y2 - a.y1);
  }
}

export function makeArrow(from, to, extra = {}) {
  const a = { id: uid("a"), type: "arrow", x: 0, y: 0, w: 0, h: 0, x1: 0, y1: 0, x2: 0, y2: 0, color: "#334155", lineWidth: 2.5, from: from.id, to: to.id, ...extra };
  return a;
}

const box = (type, label, x, y, w, h, tone = "info", extra = {}) => ({
  id: uid("b"), type, x: round4(x), y: round4(y), w: round4(w), h: round4(h), text: label, size: 20, font: "Calibri", color: "#0F172A", fill: PALETTE[tone].fill, stroke: PALETTE[tone].stroke, align: "center", ...extra,
});

/** Ready-made medical diagrams. Every box and arrow is an ordinary element the user can move, restyle, retype or delete. */
export function diagramTemplate(kind, labels = []) {
  const els = [];
  const L = (i, fallback) => (labels[i] && String(labels[i]).trim()) || fallback;
  if (kind === "flowchart" || kind === "pathway") {
    const n = clamp(labels.length || 4, 2, 6);
    const perRow = n <= 4 ? n : 3;
    const rows = Math.ceil(n / perRow);
    const gap = 0.06;
    const w = (0.88 - gap * (perRow - 1)) / perRow;
    const h = rows > 1 ? 0.18 : 0.22;
    const top = rows > 1 ? 0.3 : 0.4;
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      els.push(box(kind === "pathway" ? "hexagon" : "round", L(i, `Step ${i + 1}`), 0.06 + c * (w + gap), top + r * (h + 0.14), w, h, i === n - 1 ? "good" : "info", { size: n > 4 ? 18 : 20 }));
    }
    for (let i = 0; i < n - 1; i++) els.push(makeArrow(els[i], els[i + 1]));
  } else if (kind === "decision") {
    const q = box("diamond", L(0, "Criterion met?"), 0.34, 0.28, 0.32, 0.24, "decision");
    const yes = box("round", L(1, "Yes: action"), 0.08, 0.66, 0.3, 0.16, "good");
    const no = box("round", L(2, "No: action"), 0.62, 0.66, 0.3, 0.16, "neutral");
    els.push(q, yes, no, makeArrow(q, yes), makeArrow(q, no));
    els.push({ id: uid("t"), type: "text", x: 0.2, y: 0.52, w: 0.1, h: 0.06, text: "Yes", size: 18, bold: true, color: "#15803D", font: "Calibri", align: "center" });
    els.push({ id: uid("t"), type: "text", x: 0.7, y: 0.52, w: 0.1, h: 0.06, text: "No", size: 18, bold: true, color: "#475569", font: "Calibri", align: "center" });
  } else if (kind === "compare") {
    els.push(box("rect", L(0, "Option A"), 0.06, 0.28, 0.41, 0.1, "info", { bold: true, size: 24 }));
    els.push(box("rect", L(1, "Option B"), 0.53, 0.28, 0.41, 0.1, "decision", { bold: true, size: 24 }));
    els.push(box("rect", "Key features", 0.06, 0.4, 0.41, 0.4, "neutral", { fill: "#FFFFFF", align: "left" }));
    els.push(box("rect", "Key features", 0.53, 0.4, 0.41, 0.4, "neutral", { fill: "#FFFFFF", align: "left" }));
  } else if (kind === "cycle") {
    const n = 4;
    const pts = [[0.37, 0.2], [0.65, 0.42], [0.37, 0.64], [0.09, 0.42]];
    for (let i = 0; i < n; i++) els.push(box("ellipse", L(i, `Phase ${i + 1}`), pts[i][0], pts[i][1], 0.26, 0.17, "info", { size: 18 }));
    for (let i = 0; i < n; i++) els.push(makeArrow(els[i], els[(i + 1) % n]));
  } else {
    throw new Error(`Unknown diagram "${kind}"`);
  }
  els.forEach((e) => { if (e.type === "arrow") e.id = e.id; });
  return els;
}

export function insertDiagram(slide, kind, labels) {
  const els = diagramTemplate(kind, labels);
  const edits = ensureEdits(slide);
  (edits.added ??= []).push(...els);
  reconnect(slide);
  return els;
}

export const SHAPE_PRESETS = {
  text: () => ({ id: uid("t"), type: "text", x: 0.3, y: 0.4, w: 0.4, h: 0.1, text: "Text", size: 24, color: "#0F172A", font: "Calibri", align: "left" }),
  rect: () => box("rect", "", 0.35, 0.4, 0.3, 0.16),
  round: () => box("round", "Label", 0.35, 0.4, 0.3, 0.16),
  ellipse: () => box("ellipse", "Label", 0.35, 0.4, 0.3, 0.16),
  diamond: () => box("diamond", "Decision?", 0.35, 0.4, 0.3, 0.2, "decision"),
  hexagon: () => box("hexagon", "Label", 0.35, 0.4, 0.3, 0.16),
  cylinder: () => box("cylinder", "Store", 0.4, 0.38, 0.2, 0.22),
  arrow: () => ({ id: uid("a"), type: "arrow", x: 0.3, y: 0.5, w: 0.3, h: 0, x1: 0.3, y1: 0.5, x2: 0.6, y2: 0.5, color: "#334155", lineWidth: 2.5 }),
  line: () => ({ id: uid("a"), type: "line", x: 0.3, y: 0.5, w: 0.3, h: 0, x1: 0.3, y1: 0.5, x2: 0.6, y2: 0.5, color: "#334155", lineWidth: 2.5 }),
};

// ---------------------------------------------------------------- applying an accepted suggestion

/** Apply one accepted suggestion to a slide. `shapes` are the slide's original shapes (to find the text a suggestion refers to). Returns a short description. */
export function applySuggestion(slide, suggestion, shapes = []) {
  const a = suggestion.apply;
  if (!a) return "";
  if (a.type === "narration") {
    slide.narration = a.text;
    return "Narration updated.";
  }
  if (a.type === "slideText") {
    for (const sh of shapes) {
      if (sh.kind !== "text") continue;
      const edit = slide.edits?.shapes?.[sh.id];
      if (edit?.deleted) continue;
      const paras = edit?.text ?? sh.paras;
      if (paras.some((p) => a.replace.includes(p.trim()))) {
        const bullets = sh.ph && sh.ph !== "title" && sh.ph !== "ctrTitle" ? a.paragraphs : a.paragraphs.map((p) => `• ${p}`);
        patchShape(slide, sh.id, { text: bullets });
        return "Slide text split into bullets.";
      }
    }
    return "That text is no longer on the slide.";
  }
  if (a.type === "diagram") {
    insertDiagram(slide, a.template, a.labels);
    return "Diagram added. Check each box before generating the video.";
  }
  return "";
}
