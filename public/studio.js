// Doctyn Slide Editor workspace: thumbnails (left), editable slide canvas (centre), formatting / diagram / animation / AI panels (right),
// voiceover and animation timeline (bottom), and the Save / Undo / Redo / Preview / Generate Video toolbar (top).
// Everything edited here is saved to the course (autosave) and used by Generate Video: the engine builds the video from the saved slides.
import { el, formatDuration } from "./ui.js";
import * as M from "./studio-model.js";

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  for (const k of kids) if (k) n.append(k);
  return n;
};
const css = (node, props) => { Object.assign(node.style, props); return node; };
const pct = (v) => `${v * 100}%`;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const ACTIVE = ["parsing", "queued", "rendering"];
const ICONS = {
  undo: "M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62A7.96 7.96 0 0 1 12.5 11c3.04 0 5.67 1.7 7 4.2l2.1-1.2A10.5 10.5 0 0 0 12.5 8z",
  redo: "M18.4 10.6A10.96 10.96 0 0 0 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16a8.002 8.002 0 0 1 7.6-5c1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z",
};
const icon = (d) => svg("svg", { viewBox: "0 0 24 24", width: 18, height: 18, "aria-hidden": "true" }, svg("path", { d, fill: "currentColor" }));

let S = null; // the open editing session

export const studioOpen = () => Boolean(S);

// ================================================================ session

export async function openStudio(host, courseId) {
  if (S) return;
  S = {
    host, id: courseId, course: null, rev: 0, deck: null, versions: [], slides: [], title: "", sel: 0, selKey: null, history: new M.History(),
    save: "saved", saveTimer: 0, chain: Promise.resolve(), dirty: false, anim: {}, suggestions: null, suggesting: false, tab: "format", bottom: "voice",
    root: null, refs: {}, drag: null, playing: 0, pollTimer: 0, error: "",
  };
  buildShell();
  document.body.classList.add("studio-open");
  try {
    await load();
  } catch (e) {
    host.toast(e.message || String(e), true);
    closeStudio(true);
    return;
  }
  renderAll();
}

async function load() {
  const r = await S.host.call("GET", `/courses/${S.id}/editor`);
  S.course = r.course;
  S.rev = r.rev;
  S.deck = r.deck;
  S.versions = r.versions;
  S.deckError = r.deckError;
  S.title = r.course.title;
  S.slides = M.clone(r.course.slides);
  S.sel = Math.min(S.sel, S.slides.length - 1);
  S.selKey = null;
  S.history = new M.History();
  S.dirty = false;
  S.anim = {};
  S.save = "saved";
}

export async function closeStudio(force = false) {
  if (!S) return;
  if (!force) {
    await flush();
    if (S.save === "error" || S.save === "conflict") {
      if (!confirm("Your latest changes could not be saved. Close the editor and discard them?")) return;
    }
  }
  clearTimeout(S.saveTimer);
  clearTimeout(S.pollTimer);
  cancelAnimationFrame(S.playing);
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  S.root?.remove();
  document.body.classList.remove("studio-open");
  const host = S.host;
  S = null;
  host.onClose?.();
}

const busy = () => ACTIVE.includes(S.course?.status);
const cur = () => S.slides[S.sel];
const pageOf = (sl) => (sl?.origin ? S.deck?.pages?.[String(sl.origin.page)] : undefined);
const snapshot = () => JSON.stringify({ title: S.title, slides: S.slides });

/** Apply a change to the slides: remembered for Undo, then autosaved. `tag` merges rapid edits (typing) into one undo step. */
function commit(fn, { tag = "", render = "all" } = {}) {
  if (busy()) return;
  S.history.push(snapshot(), tag);
  fn();
  markDirty();
  if (render === "all") renderAll();
  else if (render === "canvas") { renderCanvas(); renderThumb(S.sel); renderToolbar(); }
  else if (render === "light") { renderThumb(S.sel); renderToolbar(); }
}

function markDirty() {
  S.dirty = true;
  S.save = "dirty";
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => flush(), 1200);
  renderSaveState();
}

const hasAnim = () => Object.values(S.anim).some((e) => Object.keys(e).length);

/** Save everything now (slides first, then animation edits). Resolves when finished. */
export function flush() {
  if (!S) return Promise.resolve();
  clearTimeout(S.saveTimer);
  S.chain = S.chain.then(doSave, doSave);
  return S.chain;
}

async function doSave() {
  if (!S || (!S.dirty && !hasAnim())) return;
  if (busy()) { S.save = "blocked"; renderSaveState(); return; }
  S.save = "saving";
  renderSaveState();
  try {
    if (S.dirty) {
      const sent = snapshot();
      const r = await S.host.call("PUT", `/courses/${S.id}/editor`, { rev: S.rev, title: S.title, slides: S.slides });
      S.rev = r.rev;
      S.course = r.course;
      if (snapshot() === sent) S.dirty = false;
    }
    for (const [uidv, edit] of Object.entries(S.anim)) {
      if (!Object.keys(edit).length) continue;
      const n = S.slides.findIndex((s) => s.uid === uidv) + 1;
      if (!n) { delete S.anim[uidv]; continue; }
      const r = await S.host.call("PATCH", `/courses/${S.id}/animation`, { slide: n, edit });
      S.course = r.course;
      delete S.anim[uidv];
    }
    S.save = S.dirty || hasAnim() ? "dirty" : "saved";
    if (S.save === "dirty") S.saveTimer = setTimeout(() => flush(), 300);
    S.versions = (await S.host.call("GET", `/courses/${S.id}/editor/versions`).catch(() => ({ versions: S.versions }))).versions;
  } catch (e) {
    S.error = e.message || String(e);
    S.save = e.status === 409 && /changed somewhere else/.test(S.error) ? "conflict" : "error";
  }
  if (S) { renderSaveState(); renderToolbar(); if (S.tab === "animation" || S.bottom === "timeline") { renderRight(); renderBottom(); } }
}

// ================================================================ shell

function buildShell() {
  const R = {};
  S.refs = R;
  const btn = (label, onclick, cls = "btn btn-secondary small", attrs = {}) => el("button", { type: "button", class: cls, onclick, ...attrs }, label);
  R.title = el("input", { type: "text", class: "studio-title", maxlength: "200", "aria-label": "Course title" });
  R.title.addEventListener("input", () => commit(() => { S.title = R.title.value; }, { tag: "title", render: "none" }));
  R.state = el("span", { class: "studio-save", role: "status", "aria-live": "polite" });
  R.undo = el("button", { type: "button", class: "btn btn-ghost small icon-text", title: "Undo (Ctrl+Z)", "aria-label": "Undo", onclick: undo }, icon(ICONS.undo), el("span", { text: "Undo" }));
  R.redo = el("button", { type: "button", class: "btn btn-ghost small icon-text", title: "Redo (Ctrl+Y)", "aria-label": "Redo", onclick: redo }, icon(ICONS.redo), el("span", { text: "Redo" }));
  R.saveBtn = btn("Save", () => saveNow(), "btn btn-secondary small");
  R.versionsBtn = btn("Versions", openVersions, "btn btn-ghost small");
  R.previewBtn = btn("Preview", openPreview, "btn btn-secondary small");
  R.genBtn = btn("Generate Video", generate, "btn btn-primary small");
  R.back = btn("← Dashboard", () => closeStudio(), "btn btn-ghost small");
  R.banner = el("div", { class: "studio-banner", role: "alert", hidden: true });

  R.toolbar = el("header", { class: "studio-toolbar" },
    R.back,
    R.title,
    el("div", { class: "studio-tools" }, R.state, R.undo, R.redo, R.saveBtn, R.versionsBtn, R.previewBtn, R.genBtn));

  R.thumbs = el("ol", { class: "studio-thumbs", "aria-label": "Slides" });
  R.thumbBar = el("div", { class: "studio-slidebar" },
    btn("+ Slide", () => structural(() => { const r = M.insertSlide(S.slides, S.sel); S.slides = r.slides; S.sel = r.index; }), "btn btn-secondary small", { title: "Add a slide after this one" }),
    btn("Duplicate", () => structural(() => { const r = M.duplicateSlide(S.slides, S.sel); S.slides = r.slides; S.sel = r.index; }), "btn btn-ghost small"),
    btn("Delete", deleteCurrent, "btn btn-ghost small danger"),
    btn("↑", () => moveBy(-1), "btn btn-ghost small", { "aria-label": "Move slide up", title: "Move slide up" }),
    btn("↓", () => moveBy(1), "btn btn-ghost small", { "aria-label": "Move slide down", title: "Move slide down" }));
  R.left = el("aside", { class: "studio-left" }, R.thumbBar, R.thumbs);

  R.stage = el("div", { class: "stage", tabindex: "0", "aria-label": "Slide canvas" });
  R.stage.addEventListener("pointerdown", (e) => { if (e.target === R.stage || e.target.classList.contains("stage-bg")) { S.selKey = null; renderCanvas(); renderRight(); } });
  R.canvasHint = el("p", { class: "studio-hint small muted" });
  R.center = el("main", { class: "studio-center" }, R.banner, el("div", { class: "stage-wrap" }, R.stage), R.canvasHint);

  R.tabs = el("div", { class: "studio-tabs", role: "tablist" });
  R.rightBody = el("div", { class: "studio-panel" });
  R.right = el("aside", { class: "studio-right" }, R.tabs, R.rightBody);

  R.bTabs = el("div", { class: "studio-tabs studio-btabs", role: "tablist" });
  R.bBody = el("div", { class: "studio-bottom-body" });
  R.bottom = el("section", { class: "studio-bottom" }, R.bTabs, R.bBody);

  S.root = el("div", { class: "studio", role: "dialog", "aria-label": "Slide editor", "aria-modal": "true" }, R.toolbar, R.left, R.center, R.right, R.bottom);
  document.body.append(S.root);
  window.addEventListener("keydown", onKey);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => S && renderCanvas()).observe(R.stage);
}

function renderAll() {
  if (!S) return;
  renderToolbar();
  renderThumbs();
  renderCanvas();
  renderRight();
  renderBottom();
  renderSaveState();
}

function renderToolbar() {
  const R = S.refs;
  if (document.activeElement !== R.title) R.title.value = S.title;
  R.title.disabled = busy();
  R.undo.disabled = !S.history.canUndo || busy();
  R.redo.disabled = !S.history.canRedo || busy();
  R.saveBtn.disabled = busy() || (!S.dirty && !hasAnim());
  const empty = S.slides.filter((s) => !s.narration.trim()).length;
  R.genBtn.disabled = busy() || empty > 0 || S.save === "conflict";
  R.genBtn.title = empty ? `${empty} slide(s) still need narration` : "Build the narrated and animated video from your saved edits";
  const banner = R.banner;
  banner.hidden = true;
  if (busy()) {
    banner.hidden = false;
    banner.textContent = "A job is running for this course, so editing is paused until it finishes.";
  } else if (S.save === "conflict") {
    banner.hidden = false;
    banner.replaceChildren(S.error + " ", el("button", { type: "button", class: "link-btn", onclick: reload }, "Reload the latest version"));
  } else if (S.deckError) {
    banner.hidden = false;
    banner.textContent = S.deckError;
  }
}

function renderSaveState() {
  const t = { saved: "All changes saved", dirty: "Unsaved changes…", saving: "Saving…", error: `Not saved: ${S.error}`, conflict: "Not saved (conflict)", blocked: "Paused: a job is running" }[S.save] ?? "";
  S.refs.state.textContent = t;
  S.refs.state.dataset.state = S.save;
  S.refs.saveBtn.disabled = busy() || (!S.dirty && !hasAnim());
}

async function saveNow() {
  await flush();
  if (S.save === "saved") S.host.toast("Saved.");
  else if (S.save === "error") S.host.toast(S.error, true);
}

async function reload() {
  try { await load(); renderAll(); S.host.toast("Reloaded the latest saved version."); } catch (e) { S.host.toast(e.message, true); }
}

function undo() {
  const prev = S.history.undo(snapshot());
  if (prev === null) return;
  restoreSnapshot(prev);
}
function redo() {
  const next = S.history.redo(snapshot());
  if (next === null) return;
  restoreSnapshot(next);
}
function restoreSnapshot(json) {
  const st = JSON.parse(json);
  S.title = st.title;
  S.slides = st.slides;
  S.sel = Math.min(S.sel, S.slides.length - 1);
  S.selKey = null;
  markDirty();
  renderAll();
}

// ================================================================ slide list

function structural(fn) {
  commit(() => { fn(); S.selKey = null; });
}
function deleteCurrent() {
  if (S.slides.length <= 1) { S.host.toast("A course needs at least one slide.", true); return; }
  if (!confirm(`Delete slide ${S.sel + 1} “${cur().title}” and its narration? You can undo this.`)) return;
  structural(() => { const r = M.deleteSlide(S.slides, S.sel); S.slides = r.slides; S.sel = r.index; });
}
function moveBy(d) {
  const to = S.sel + d;
  if (to < 0 || to >= S.slides.length) return;
  structural(() => { const r = M.moveSlide(S.slides, S.sel, to); S.slides = r.slides; S.sel = r.index; });
}

function renderThumbs() {
  const R = S.refs;
  R.thumbs.replaceChildren(...S.slides.map((sl, i) => thumb(sl, i)));
  R.thumbs.children[S.sel]?.scrollIntoView?.({ block: "nearest" });
}

function thumb(sl, i) {
  const box = el("div", { class: "thumb-img" });
  const li = el("li", { class: "thumb-li", draggable: "true" },
    el("button", { type: "button", class: `thumb${i === S.sel ? " selected" : ""}${!sl.narration.trim() ? " missing" : ""}`, "aria-label": `Slide ${i + 1}: ${sl.title}${!sl.narration.trim() ? " (narration needed)" : ""}`, "aria-current": i === S.sel ? "true" : "false",
      onclick: () => { S.sel = i; S.selKey = null; renderAll(); } },
      el("span", { class: "thumb-no", text: String(i + 1) }), box,
      el("span", { class: "thumb-title", text: sl.title })));
  li.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/plain", String(i)); li.classList.add("dragging"); });
  li.addEventListener("dragend", () => li.classList.remove("dragging"));
  li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("drop"); });
  li.addEventListener("dragleave", () => li.classList.remove("drop"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    li.classList.remove("drop");
    const from = Number(e.dataTransfer?.getData("text/plain"));
    if (Number.isInteger(from) && from !== i) structural(() => { const r = M.moveSlide(S.slides, from, i); S.slides = r.slides; S.sel = r.index; });
  });
  drawSlide(box, sl, { width: 168 });
  return li;
}

function renderThumb(i) {
  const li = S.refs.thumbs.children[i];
  if (!li) return;
  const sl = S.slides[i];
  const box = li.querySelector(".thumb-img");
  drawSlide(box, sl, { width: 168 });
  li.querySelector(".thumb-title").textContent = sl.title;
  li.querySelector(".thumb").classList.toggle("missing", !sl.narration.trim());
}

// ================================================================ drawing a slide (canvas and thumbnails)

const imageUrl = (page) => S.host.apiUrl(`/courses/${S.id}/slides/${page}/image`);

/** Effective geometry/format of an original shape. */
function shapeView(sl, def) {
  const e = sl.edits?.shapes?.[def.id];
  return { e, deleted: Boolean(e?.deleted), g: M.shapeGeom(def, e), text: e?.text ?? def.paras, size: e?.size ?? def.size, font: e?.font ?? def.font, bold: e?.bold ?? def.bold, italic: e?.italic ?? def.italic, color: e?.color ?? def.color, fill: e?.fill ?? def.fill, align: e?.align ?? def.align };
}

function drawSlide(box, sl, { interactive = false, width = 0 } = {}) {
  const { cx, cy } = S.deck.slideSize;
  const W = width || box.clientWidth || 960;
  const H = (W * cy) / cx;
  const ptPx = W / (cx / 12700);
  const page = pageOf(sl);
  const bg = sl.edits?.bg ?? page?.bg ?? "#FFFFFF";
  const hasImg = Boolean(sl.origin && S.course.slidePreviews);
  const nodes = [];
  box.classList.add("slide-box");
  css(box, { aspectRatio: `${cx} / ${cy}`, background: bg });

  // 1. the slide as uploaded (rendered by the engine), or a plain background for new slides
  if (hasImg && !sl.edits?.bg) {
    const img = el("img", { class: "stage-bg", src: imageUrl(sl.origin.page), alt: "", draggable: "false", loading: interactive ? "eager" : "lazy" });
    nodes.push(img);
  } else {
    nodes.push(el("div", { class: "stage-bg" }));
  }

  const textDiv = (v, g, key, extra = {}) => {
    const d = el("div", { class: "el-text" });
    css(d, {
      left: pct(g.x), top: pct(g.y), width: pct(g.w), height: pct(g.h), fontSize: `${(v.size || 18) * ptPx}px`, fontFamily: M.FONT_STACKS[v.font] ?? M.FONT_STACKS.Calibri,
      fontWeight: v.bold ? "700" : "400", fontStyle: v.italic ? "italic" : "normal", color: v.color || "#0F172A", textAlign: v.align || "left", ...extra,
    });
    d.textContent = Array.isArray(v.text) ? v.text.join("\n") : String(v.text ?? "");
    d.dataset.key = key;
    return d;
  };

  const overlays = [];
  const hits = [];
  // 2. original shapes: untouched ones only need a click target; changed ones are covered and redrawn
  const defs = page?.shapes ?? [];
  for (const def of defs) {
    const v = shapeView(sl, def);
    const key = `s:${def.id}`;
    const changed = Boolean(v.e);
    if (changed) {
      const o = { x: def.x, y: def.y, w: def.w, h: def.h };
      overlays.push(css(el("div", { class: "el-cover" }), { left: pct(o.x), top: pct(o.y), width: pct(o.w), height: pct(o.h), background: page.bg || bg }));
    }
    if (v.deleted) continue;
    if (changed) {
      if (def.kind === "text") {
        const fill = v.fill && !hasFillOnly(def) ? v.fill : def.fill;
        overlays.push(textDiv(v, v.g, key, fill ? { background: fill } : {}));
      } else if (hasImg) {
        const d = el("div", { class: "el-clone" });
        css(d, { left: pct(v.g.x), top: pct(v.g.y), width: pct(v.g.w), height: pct(v.g.h), backgroundImage: `url("${imageUrl(sl.origin.page)}")`, backgroundSize: `${100 / def.w}% ${100 / def.h}%`, backgroundPosition: `${def.w >= 1 ? 0 : (def.x / (1 - def.w)) * 100}% ${def.h >= 1 ? 0 : (def.y / (1 - def.h)) * 100}%` });
        overlays.push(d);
      }
    }
    if (interactive) hits.push({ key, g: v.g, area: v.g.w * v.g.h, label: def.name });
  }

  // 3. elements added in the editor
  const added = sl.edits?.added ?? [];
  const shapeLayer = svg("svg", { class: "el-svg", viewBox: `0 0 ${W} ${H}`, width: "100%", height: "100%" });
  shapeLayer.append(svg("defs", {}, svg("marker", { id: `ah-${interactive ? "m" : "t"}`, viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" }, svg("path", { d: "M0 0L10 5L0 10z", fill: "context-stroke" }))));
  const texts = [];
  for (const a of added) {
    const key = `a:${a.id}`;
    if (a.type === "arrow" || a.type === "line") {
      const ln = svg("line", { x1: a.x1 * W, y1: a.y1 * H, x2: a.x2 * W, y2: a.y2 * H, stroke: a.color || "#334155", "stroke-width": (a.lineWidth || 2.5) * (ptPx), "stroke-linecap": "round" });
      if (a.type === "arrow") ln.setAttribute("marker-end", `url(#ah-${interactive ? "m" : "t"})`);
      shapeLayer.append(ln);
      if (interactive) hits.push({ key, line: a, area: 0.0001 });
      continue;
    }
    const x = a.x * W, y = a.y * H, w = a.w * W, h = a.h * H;
    const attrs = { fill: a.type === "text" ? a.fill || "none" : a.fill || "#E0F2FE", stroke: a.type === "text" && !a.stroke ? "none" : a.stroke || "#0369A1", "stroke-width": 2 * ptPx };
    if (a.type === "rect" || a.type === "text") shapeLayer.append(svg("rect", { x, y, width: w, height: h, ...attrs }));
    else if (a.type === "round") shapeLayer.append(svg("rect", { x, y, width: w, height: h, rx: Math.min(w, h) * 0.18, ...attrs }));
    else if (a.type === "ellipse") shapeLayer.append(svg("ellipse", { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, ...attrs }));
    else if (a.type === "diamond") shapeLayer.append(svg("polygon", { points: `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`, ...attrs }));
    else if (a.type === "hexagon") shapeLayer.append(svg("polygon", { points: `${x + w * 0.2},${y} ${x + w * 0.8},${y} ${x + w},${y + h / 2} ${x + w * 0.8},${y + h} ${x + w * 0.2},${y + h} ${x},${y + h / 2}`, ...attrs }));
    else if (a.type === "cylinder") shapeLayer.append(svg("path", { d: `M${x},${y + h * 0.12} a${w / 2},${h * 0.12} 0 0 1 ${w},0 v${h * 0.76} a${w / 2},${h * 0.12} 0 0 1 ${-w},0 z M${x},${y + h * 0.12} a${w / 2},${h * 0.12} 0 0 0 ${w},0`, ...attrs }));
    if (a.text) texts.push(textDiv({ text: a.text, size: a.size, font: a.font, bold: a.bold, italic: a.italic, color: a.color, align: a.align }, { x: a.x, y: a.y, w: a.w, h: a.h }, key, { display: "flex", alignItems: a.type === "text" ? "flex-start" : "center", justifyContent: a.align === "left" ? "flex-start" : a.align === "right" ? "flex-end" : "center", whiteSpace: "pre-wrap", padding: `${0.4 * ptPx}px ${4 * ptPx}px` }));
    if (interactive) hits.push({ key, g: { x: a.x, y: a.y, w: a.w, h: a.h }, area: a.w * a.h, label: a.type });
  }
  nodes.push(...overlays, shapeLayer, ...texts);

  if (interactive) {
    hits.sort((p, q) => q.area - p.area);
    const hitLayer = el("div", { class: "el-hits" });
    const lineLayer = svg("svg", { class: "el-svg el-lines", viewBox: `0 0 ${W} ${H}`, width: "100%", height: "100%" });
    for (const h of hits) {
      if (h.line) {
        const l = svg("line", { x1: h.line.x1 * W, y1: h.line.y1 * H, x2: h.line.x2 * W, y2: h.line.y2 * H, stroke: "transparent", "stroke-width": 16, "data-key": h.key, class: "el-line-hit" });
        l.addEventListener("pointerdown", (ev) => beginDrag(ev, h.key, "move"));
        lineLayer.append(l);
        continue;
      }
      const d = el("div", { class: `el-hit${S.selKey === h.key ? " selected" : ""}`, title: h.label ?? "", "data-key": h.key });
      css(d, { left: pct(h.g.x), top: pct(h.g.y), width: pct(h.g.w), height: pct(h.g.h) });
      d.addEventListener("pointerdown", (ev) => beginDrag(ev, h.key, "move"));
      d.addEventListener("dblclick", () => { S.tab = "format"; renderRight(); S.refs.rightBody.querySelector("textarea")?.focus(); });
      hitLayer.append(d);
    }
    nodes.push(hitLayer, lineLayer);
    const sel = selection();
    if (sel) nodes.push(selectionBox(sel, W, H));
  }
  box.replaceChildren(...nodes);
}

const hasFillOnly = () => false;

// ---------------------------------------------------------------- selection, move and resize

/** The selected element in a uniform shape: { key, kind, def, get, set } */
function selection() {
  const key = S.selKey;
  if (!key) return null;
  const sl = cur();
  if (key.startsWith("s:")) {
    const def = pageOf(sl)?.shapes.find((s) => s.id === key.slice(2));
    if (!def) return null;
    const v = shapeView(sl, def);
    return { key, orig: true, def, view: v, g: v.g };
  }
  const el_ = M.findAdded(sl, key.slice(2));
  if (!el_) return null;
  return { key, orig: false, el: el_, g: el_.type === "arrow" || el_.type === "line" ? { x: el_.x, y: el_.y, w: el_.w, h: el_.h } : { x: el_.x, y: el_.y, w: el_.w, h: el_.h } };
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
function selectionBox(sel, W, H) {
  const wrap = el("div", { class: "sel-box" });
  const line = sel.el && (sel.el.type === "arrow" || sel.el.type === "line");
  if (line) {
    css(wrap, { left: "0", top: "0", width: "100%", height: "100%", border: "none", pointerEvents: "none" });
    for (const p of ["p1", "p2"]) {
      const pt = p === "p1" ? [sel.el.x1, sel.el.y1] : [sel.el.x2, sel.el.y2];
      const h = el("div", { class: "sel-handle sel-point", "data-h": p, role: "presentation" });
      css(h, { left: pct(pt[0]), top: pct(pt[1]) });
      h.addEventListener("pointerdown", (ev) => beginDrag(ev, sel.key, p));
      wrap.append(h);
    }
    return wrap;
  }
  css(wrap, { left: pct(sel.g.x), top: pct(sel.g.y), width: pct(sel.g.w), height: pct(sel.g.h) });
  for (const h of HANDLES) {
    const d = el("div", { class: `sel-handle h-${h}`, "data-h": h, role: "presentation" });
    d.addEventListener("pointerdown", (ev) => beginDrag(ev, sel.key, h));
    wrap.append(d);
  }
  return wrap;
}

function beginDrag(ev, key, mode) {
  if (busy() || ev.button > 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  const selChanged = S.selKey !== key;
  S.selKey = key;
  const sel = selection();
  if (!sel) return;
  S.history.push(snapshot(), "");
  const r = S.refs.stage.getBoundingClientRect();
  S.drag = { key, mode, sx: ev.clientX, sy: ev.clientY, W: r.width || 1, H: r.height || 1, g0: { ...sel.g }, line0: sel.el && sel.el.x1 !== undefined ? { x1: sel.el.x1, y1: sel.el.y1, x2: sel.el.x2, y2: sel.el.y2 } : null, moved: false, selChanged };
  renderCanvas();
  renderRight();
}

let frame = 0;
function onPointerMove(ev) {
  const d = S?.drag;
  if (!d) return;
  const dx = (ev.clientX - d.sx) / d.W;
  const dy = (ev.clientY - d.sy) / d.H;
  if (!d.moved && Math.abs(dx * d.W) + Math.abs(dy * d.H) < 3) return;
  d.moved = true;
  const sl = cur();
  const snap = (v) => Math.round(v * 400) / 400;
  if (d.line0) {
    const a = M.findAdded(sl, d.key.slice(2));
    if (d.mode === "move") Object.assign(a, { x1: snap(d.line0.x1 + dx), y1: snap(d.line0.y1 + dy), x2: snap(d.line0.x2 + dx), y2: snap(d.line0.y2 + dy), from: undefined, to: undefined });
    else if (d.mode === "p1") Object.assign(a, { x1: snap(d.line0.x1 + dx), y1: snap(d.line0.y1 + dy), from: undefined });
    else Object.assign(a, { x2: snap(d.line0.x2 + dx), y2: snap(d.line0.y2 + dy), to: undefined });
    Object.assign(a, { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) });
    for (const k of ["from", "to"]) if (a[k] === undefined) delete a[k];
  } else {
    let { x, y, w, h } = d.g0;
    const m = d.mode;
    if (m === "move") { x += dx; y += dy; }
    else {
      if (m.includes("e")) w += dx;
      if (m.includes("s")) h += dy;
      if (m.includes("w")) { x += dx; w -= dx; }
      if (m.includes("n")) { y += dy; h -= dy; }
    }
    w = Math.max(0.01, w);
    h = Math.max(0.01, h);
    const g = { x: snap(x), y: snap(y), w: snap(w), h: snap(h) };
    if (d.key.startsWith("s:")) M.patchShape(sl, d.key.slice(2), g);
    else M.patchAdded(sl, d.key.slice(2), g);
  }
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (S) renderCanvas(); });
}

function onPointerUp() {
  const d = S?.drag;
  if (!d) return;
  S.drag = null;
  if (d.moved) {
    markDirty();
    renderCanvas();
    renderThumb(S.sel);
    renderRight();
    renderToolbar();
  } else {
    S.history.undoStack.pop(); // a click, not a change
  }
}

// ================================================================ canvas

function renderCanvas() {
  if (!S || !S.deck) return;
  const sl = cur();
  const R = S.refs;
  if (!sl) return;
  drawSlide(R.stage, sl, { interactive: true });
  const page = pageOf(sl);
  R.canvasHint.textContent = S.course.slidePreviews || !sl.origin
    ? `Slide ${S.sel + 1} of ${S.slides.length}. Click an item to select it, drag to move, drag the handles to resize. The editor is a close preview; the video is rendered from your saved edits.`
    : "The slide image is not ready yet, so only outlines are shown. Editing still works.";
  if (!page && sl.origin) R.canvasHint.textContent = "The shapes of this slide could not be read. You can still edit narration, title and slide order.";
}

// ================================================================ right panel

const TABS = [["format", "Format"], ["diagram", "Diagram"], ["animation", "Animation"], ["ai", "Improve"]];

function renderRight() {
  if (!S) return;
  const R = S.refs;
  R.tabs.replaceChildren(...TABS.map(([id, label]) => el("button", { type: "button", role: "tab", class: `studio-tab${S.tab === id ? " active" : ""}`, "aria-selected": String(S.tab === id), onclick: () => { S.tab = id; renderRight(); renderBottom(); } }, label)));
  const body = S.tab === "format" ? formatPanel() : S.tab === "diagram" ? diagramPanel() : S.tab === "animation" ? animationPanel() : improvePanel();
  const keep = R.rightBody.scrollTop;
  R.rightBody.replaceChildren(body);
  R.rightBody.scrollTop = keep;
}

const field = (label, input, cls = "") => el("label", { class: `field ${cls}` }, label, input);
const num2 = (v) => Math.round(v * 1000) / 10;

function formatPanel() {
  const sl = cur();
  const dis = busy();
  const box = el("div", { class: "stack" });
  const title = el("input", { type: "text", maxlength: "300", value: sl.title, disabled: dis, "aria-label": "Slide title (script heading)" });
  title.addEventListener("input", () => commit(() => { sl.title = title.value; }, { tag: "stitle", render: "light" }));
  box.append(field("Slide title (heading in the script and transcript)", title));

  const sel = selection();
  if (!sel) {
    box.append(el("p", { class: "muted small", text: "Select text, a picture or a shape on the slide to format it. Double-click text to start typing." }));
    const bg = el("input", { type: "color", value: sl.edits?.bg ?? pageOf(sl)?.bg ?? "#ffffff", disabled: dis, "aria-label": "Slide background colour" });
    bg.addEventListener("input", () => commit(() => { M.ensureEdits(sl).bg = bg.value.toUpperCase(); }, { tag: "bg", render: "canvas" }));
    box.append(el("div", { class: "row gap wrap" }, field("Background", bg), sl.edits?.bg && sl.origin ? el("button", { type: "button", class: "btn btn-ghost small", disabled: dis, onclick: () => commit(() => { delete sl.edits.bg; }) }, "Use original background") : null));
    box.append(itemList());
    return box;
  }

  const isLine = sel.el && (sel.el.type === "arrow" || sel.el.type === "line");
  const get = (k, d) => (sel.orig ? sel.view[k] : sel.el[k]) ?? d;
  const set = (patch, tag = "fmt") => commit(() => {
    if (sel.orig) M.patchShape(sl, sel.def.id, patch);
    else M.patchAdded(sl, sel.el.id, patch);
  }, { tag, render: "canvas" });
  const title2 = sel.orig ? `${sel.def.kind === "text" ? "Text" : sel.def.kind}: ${sel.def.name}` : `${sel.el.type} (added)`;
  box.append(el("h4", { class: "studio-h", text: title2 }));

  const hasText = sel.orig ? sel.def.kind === "text" : !isLine;
  if (hasText) {
    const ta = el("textarea", { rows: "5", maxlength: "2000", disabled: dis, "aria-label": "Text of the selected item" });
    ta.value = sel.orig ? sel.view.text.join("\n") : (sel.el.text ?? "");
    ta.addEventListener("input", () => set(sel.orig ? { text: ta.value.split("\n") } : { text: ta.value }, "text"));
    box.append(field("Text (one paragraph per line)", ta));
    const font = el("select", { disabled: dis, "aria-label": "Font" }, el("option", { value: "", text: sel.orig && !sel.def.font ? "Deck default" : "Default" }), M.FONTS.map((f) => el("option", { value: f, text: f, selected: get("font") === f })));
    font.addEventListener("change", () => set({ font: font.value || undefined }));
    const size = el("input", { type: "number", min: "6", max: "200", step: "1", value: String(Math.round(num(get("size", 18)))), disabled: dis, "aria-label": "Font size in points" });
    size.addEventListener("input", () => { const v = num(size.value); if (v >= 6 && v <= 200) set({ size: v }, "size"); });
    box.append(el("div", { class: "row gap wrap" }, field("Font", font), field("Size (pt)", size, "narrow")));
    const tog = (label, prop, aria) => el("button", { type: "button", class: `btn btn-secondary small tog${get(prop) ? " on" : ""}`, "aria-pressed": String(Boolean(get(prop))), "aria-label": aria, disabled: dis, onclick: () => set({ [prop]: !get(prop) }) }, label);
    const al = (v, label) => el("button", { type: "button", class: `btn btn-secondary small tog${get("align", "left") === v ? " on" : ""}`, "aria-label": `Align ${v}`, "aria-pressed": String(get("align", "left") === v), disabled: dis, onclick: () => set({ align: v }) }, label);
    box.append(el("div", { class: "row gap wrap" }, tog("B", "bold", "Bold"), tog("I", "italic", "Italic"), al("left", "⯇"), al("center", "≡"), al("right", "⯈")));
    const color = el("input", { type: "color", value: get("color") || "#0f172a", disabled: dis, "aria-label": "Text colour" });
    color.addEventListener("input", () => set({ color: color.value.toUpperCase() }, "color"));
    box.append(el("div", { class: "row gap wrap" }, field("Text colour", color)));
  }
  if ((sel.orig && (get("fill") || sel.def.kind === "shape")) || (!sel.orig && !isLine)) {
    const fill = el("input", { type: "color", value: get("fill") || "#ffffff", disabled: dis, "aria-label": "Fill colour" });
    fill.addEventListener("input", () => set({ fill: fill.value.toUpperCase() }, "fill"));
    const row = el("div", { class: "row gap wrap" }, field("Fill", fill));
    if (!sel.orig) {
      const stroke = el("input", { type: "color", value: sel.el.stroke || "#0369a1", disabled: dis, "aria-label": "Outline colour" });
      stroke.addEventListener("input", () => set({ stroke: stroke.value.toUpperCase() }, "stroke"));
      row.append(field("Outline", stroke));
    }
    box.append(row);
  }
  if (isLine) {
    const c = el("input", { type: "color", value: sel.el.color || "#334155", disabled: dis, "aria-label": "Line colour" });
    c.addEventListener("input", () => set({ color: c.value.toUpperCase() }, "color"));
    const w = el("input", { type: "number", min: "0.5", max: "20", step: "0.5", value: String(sel.el.lineWidth ?? 2.5), disabled: dis, "aria-label": "Line width" });
    w.addEventListener("input", () => set({ lineWidth: num(w.value, 2.5) }, "lw"));
    const type = el("select", { disabled: dis, "aria-label": "Line type" }, el("option", { value: "arrow", text: "Arrow", selected: sel.el.type === "arrow" }), el("option", { value: "line", text: "Line", selected: sel.el.type === "line" }));
    type.addEventListener("change", () => set({ type: type.value }));
    box.append(el("div", { class: "row gap wrap" }, field("Colour", c), field("Width", w, "narrow"), field("Style", type)));
    box.append(el("p", { class: "muted small", text: "Drag the round handles to re-point the arrow. Arrows joined to boxes follow them when the boxes move." }));
  } else {
    const geo = (label, k) => {
      const i = el("input", { type: "number", min: "-50", max: "200", step: "0.5", value: String(num2(sel.g[k])), disabled: dis, "aria-label": `${label} as percent of the slide` });
      i.addEventListener("input", () => { const v = num(i.value) / 100; set({ [k]: v }, `geo-${k}`); });
      return field(`${label} %`, i, "narrow");
    };
    box.append(el("div", { class: "row gap wrap" }, geo("X", "x"), geo("Y", "y"), geo("W", "w"), geo("H", "h")));
  }
  const actions = el("div", { class: "row gap wrap" });
  if (!sel.orig) actions.append(el("button", { type: "button", class: "btn btn-secondary small", disabled: dis, onclick: () => commit(() => { const n = M.duplicateAdded(sl, sel.el.id); S.selKey = n ? `a:${n.id}` : null; }) }, "Duplicate"));
  if (sel.orig && sl.edits?.shapes?.[sel.def.id]) actions.append(el("button", { type: "button", class: "btn btn-ghost small", disabled: dis, onclick: () => commit(() => { M.patchShape(sl, sel.def.id, Object.fromEntries(Object.keys(sl.edits.shapes[sel.def.id]).map((k) => [k, undefined]))); }) }, "Restore original"));
  actions.append(el("button", { type: "button", class: "btn btn-ghost small danger", disabled: dis, onclick: deleteSelected }, "Delete item"));
  box.append(actions, itemList());
  return box;
}

function deleteSelected() {
  const sel = selection();
  if (!sel || busy()) return;
  commit(() => {
    const sl = cur();
    if (sel.orig) M.patchShape(sl, sel.def.id, { deleted: true });
    else M.removeAdded(sl, sel.el.id);
    S.selKey = null;
  });
}

/** Every item on the slide (also reaches items hidden behind others), and a way back for deleted ones. */
function itemList() {
  const sl = cur();
  const wrap = el("details", { class: "item-list" }, el("summary", { text: "All items on this slide" }));
  const ul = el("ul", { class: "items" });
  for (const def of pageOf(sl)?.shapes ?? []) {
    const v = shapeView(sl, def);
    const label = def.kind === "text" ? `${v.text.join(" ").slice(0, 46) || def.name}` : def.name;
    ul.append(el("li", {}, el("button", { type: "button", class: `link-btn${S.selKey === `s:${def.id}` ? " on" : ""}`, onclick: () => { if (!v.deleted) { S.selKey = `s:${def.id}`; renderCanvas(); renderRight(); } } }, `${v.deleted ? "(deleted) " : ""}${label}`),
      v.deleted ? el("button", { type: "button", class: "link-btn", onclick: () => commit(() => M.patchShape(sl, def.id, { deleted: undefined })) }, " restore") : null));
  }
  for (const a of sl.edits?.added ?? []) ul.append(el("li", {}, el("button", { type: "button", class: "link-btn", onclick: () => { S.selKey = `a:${a.id}`; renderCanvas(); renderRight(); } }, `${a.type}${a.text ? `: ${a.text.slice(0, 40)}` : ""} (added)`)));
  if (!ul.children.length) ul.append(el("li", { class: "muted small", text: "Nothing yet." }));
  wrap.append(ul);
  return wrap;
}

function diagramPanel() {
  const sl = cur();
  const dis = busy();
  const add = (kind) => commit(() => { const e = M.SHAPE_PRESETS[kind](); M.addElement(sl, e); S.selKey = `a:${e.id}`; });
  const tpl = (kind, label, hint) => el("button", { type: "button", class: "tpl", disabled: dis, onclick: () => commit(() => { M.insertDiagram(sl, kind); S.selKey = null; }) }, el("strong", { text: label }), el("span", { class: "muted small", text: hint }));
  return el("div", { class: "stack" },
    el("h4", { class: "studio-h", text: "Add to the slide" }),
    el("div", { class: "palette" }, [["text", "Text box"], ["rect", "Rectangle"], ["round", "Rounded"], ["ellipse", "Ellipse"], ["diamond", "Decision"], ["hexagon", "Hexagon"], ["cylinder", "Store"], ["arrow", "Arrow"], ["line", "Line"]].map(([k, l]) => el("button", { type: "button", class: "btn btn-secondary small", disabled: dis, onclick: () => add(k) }, l))),
    el("h4", { class: "studio-h", text: "Clinical diagrams" }),
    tpl("flowchart", "Clinical flowchart", "Boxes joined by arrows, in order"),
    tpl("decision", "Decision tree", "Question with Yes and No outcomes"),
    tpl("pathway", "Pathophysiology pathway", "Chain of hexagons: cause to effect"),
    tpl("compare", "Comparison", "Two columns side by side"),
    tpl("cycle", "Cycle", "Four phases that repeat"),
    el("p", { class: "muted small", text: "Every box and arrow can be selected, retyped, recoloured, moved and deleted. Diagrams you add are part of the slide in the generated video." }));
}

// ================================================================ improve slide content (AI-assisted, nothing applied automatically)

function improvePanel() {
  const sl = cur();
  const box = el("div", { class: "stack" });
  const texts = () => (pageOf(sl)?.shapes ?? []).filter((d) => d.kind === "text").flatMap((d) => shapeView(sl, d).text).concat((sl.edits?.added ?? []).filter((a) => a.text).map((a) => a.text)).map((t) => t.trim()).filter(Boolean);
  box.append(
    el("p", { class: "muted small", text: "Suggests clearer wording, bullet points, a diagram and an animation for this slide. Suggestions are made on this site from the slide's own text; nothing is sent to a paid service and nothing changes until you accept it." }),
    el("button", { type: "button", class: "btn btn-primary small", disabled: busy() || S.suggesting, onclick: async () => {
      S.suggesting = true;
      renderRight();
      try {
        const r = await S.host.call("POST", `/courses/${S.id}/editor/suggest`, { title: sl.title, narration: sl.narration, texts: texts() });
        S.suggestions = { uid: sl.uid, list: r.suggestions, note: r.note };
      } catch (e) { S.host.toast(e.message, true); }
      S.suggesting = false;
      renderRight();
    } }, S.suggesting ? "Thinking…" : "Improve Slide Content"));
  const s = S.suggestions;
  if (s && s.uid === sl.uid) {
    if (!s.list.length) box.append(el("p", { class: "notice success", text: "No improvements suggested for this slide." }));
    for (const sug of s.list) box.append(suggestionCard(sl, sug));
  }
  return box;
}

function suggestionCard(sl, sug) {
  const card = el("article", { class: `sug${sug.clinical ? " clinical" : ""}` },
    el("header", {}, el("strong", { text: sug.title }), sug.clinical ? el("span", { class: "badge badge-failed", title: "Touches medically important content. Check it against your source before accepting.", text: "Clinical check" }) : null),
    el("p", { class: "muted small", text: sug.rationale }));
  if (sug.before) card.append(el("div", { class: "sug-diff" }, el("div", {}, el("span", { class: "small muted", text: "Now" }), el("pre", { text: sug.before.slice(0, 700) })), sug.after ? el("div", {}, el("span", { class: "small muted", text: "Suggested" }), el("pre", { text: sug.after.slice(0, 700) })) : null));
  else if (sug.after) card.append(el("pre", { class: "sug-after", text: sug.after.slice(0, 700) }));
  const drop = () => { S.suggestions.list = S.suggestions.list.filter((x) => x !== sug); renderRight(); };
  if (sug.apply) {
    card.append(el("div", { class: "row gap" },
      el("button", { type: "button", class: "btn btn-primary small", disabled: busy(), onclick: () => {
        if (sug.clinical && !confirm("This suggestion adds or changes medically important content.\n\nHave you checked it against your clinical source and do you want to keep it?")) return;
        if (sug.apply.type === "animationTemplate") { animDraft(sl).template = sug.apply.template; markDirty(); S.host.toast(`Animation set to “${sug.apply.template}”. Preview it in the Animation tab.`); drop(); return; }
        let msg = "";
        commit(() => { msg = M.applySuggestion(sl, sug, pageOf(sl)?.shapes ?? []); });
        S.host.toast(msg || "Applied.");
        drop();
      } }, "Accept"),
      el("button", { type: "button", class: "btn btn-ghost small", onclick: drop }, "Reject")));
  } else {
    card.append(el("button", { type: "button", class: "btn btn-ghost small", onclick: drop }, "Dismiss"));
  }
  return card;
}

// ================================================================ animation (preview, type, labels, highlights, timing)

const animDraft = (sl) => (S.anim[sl.uid] ??= {});
const planOf = (sl) => S.course.animationPlan?.find((p) => p.slide === S.slides.indexOf(sl) + 1);

function effective(sl) {
  const plan = planOf(sl);
  if (!plan) return null;
  const n = S.slides.indexOf(sl) + 1;
  const saved = S.course.animationEdits?.[String(n)] ?? {};
  const d = S.anim[sl.uid] ?? {};
  return {
    plan,
    template: d.template ?? saved.template ?? plan.template,
    slideText: d.slideText ?? saved.slideText ?? plan.slideText,
    popups: d.popups ?? saved.popups ?? plan.popups,
    events: d.events ?? saved.events ?? plan.events,
    labels: { ...(plan.labels ?? {}), ...(saved.labels ?? {}), ...(d.labels ?? {}) },
  };
}

function sceneNode(eff, t, watermark = "DRAFT PREVIEW") {
  if (!window.DoctynScene) return el("p", { class: "muted small", text: "The animation preview could not be loaded." });
  try {
    const s = window.DoctynScene.renderFrame({ ...eff.plan, slideText: eff.slideText, labels: eff.labels, events: eff.events, popups: eff.popups }, t, { watermark });
    return document.importNode(new DOMParser().parseFromString(s, "image/svg+xml").documentElement, true);
  } catch { return el("p", { class: "muted small", text: "This slide could not be previewed." }); }
}

/** Scene preview with a time slider and a Play button. Reused by the Animation tab and the Preview window. */
function scenePlayer(sl, { watermark } = {}) {
  const eff = effective(sl);
  const wrap = el("div", { class: "scene-preview" });
  if (!eff) return wrap;
  const dur = eff.plan.durationSeconds;
  const stage = el("div", { class: "scene-stage", role: "img", "aria-label": "Animation preview" });
  const slider = el("input", { type: "range", min: "0", max: String(dur), step: "0.05", value: String(Math.round(dur * 0.8 * 10) / 10), "aria-label": "Preview time in seconds" });
  const clock = el("span", { class: "small muted" });
  const draw = () => { stage.replaceChildren(sceneNode(effective(sl) ?? eff, num(slider.value), watermark)); clock.textContent = `${num(slider.value).toFixed(1)} / ${dur.toFixed(1)} s`; };
  let raf = 0;
  const play = el("button", { type: "button", class: "btn btn-secondary small" }, "▶ Play");
  const stop = () => { cancelAnimationFrame(raf); raf = 0; play.textContent = "▶ Play"; };
  play.addEventListener("click", () => {
    if (raf) { stop(); return; }
    play.textContent = "❚❚ Pause";
    let t0 = performance.now() - (num(slider.value) >= dur - 0.1 ? 0 : num(slider.value) * 1000);
    const tick = (now) => {
      const t = (now - t0) / 1000;
      slider.value = String(Math.min(t, dur));
      draw();
      if (t >= dur) { stop(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
  slider.addEventListener("input", () => { stop(); draw(); });
  draw();
  wrap.append(stage, el("div", { class: "row gap" }, play, slider, clock));
  wrap.stop = stop;
  return wrap;
}

function animationPanel() {
  const sl = cur();
  const dis = busy();
  const box = el("div", { class: "stack" });
  const eff = effective(sl);
  const n = S.slides.indexOf(sl) + 1;
  if (!eff) {
    box.append(
      el("p", { class: "muted small", text: S.course.animation ? "The animation plan does not cover this slide yet (new, duplicated or moved slides need a fresh plan). Save, then prepare animations." : "The animation plan for this course is not ready yet." }),
      el("button", { type: "button", class: "btn btn-secondary small", disabled: dis || S.dirty || ACTIVE.includes(S.course.job?.status) || S.course.job?.status === "queued", onclick: refreshPlan }, "Prepare animations"));
    if (S.dirty) box.append(el("p", { class: "muted small", text: "Saving your latest changes first…" }));
    return box;
  }
  const { plan } = eff;
  if (sl.narration.trim() !== plan.narration.trim()) {
    box.append(el("div", { class: "notice" }, "The narration changed after this animation was planned. Refresh the plan so cues and timings follow the new words. ", el("button", { type: "button", class: "link-btn", disabled: dis || S.dirty, onclick: refreshPlan }, "Refresh animation plan")));
  }
  const tmpl = el("select", { disabled: dis, "aria-label": "Animation type" }, (S.host.meta()?.animationTemplates ?? [plan.template]).map((t) => el("option", { value: t, text: t, selected: eff.template === t })));
  tmpl.addEventListener("change", () => { animDraft(sl).template = tmpl.value; markDirty(); renderRight(); });
  box.append(field("Animation type", tmpl), el("p", { class: "muted small", text: plan.rationale }));
  box.append(scenePlayer(sl));
  if (eff.template !== plan.template) box.append(el("p", { class: "small muted", text: "The preview shows the planned type. Save, then refresh the plan to preview the new type." }));

  if (plan.items?.length) {
    const fields = el("div", { class: "scene-labels" });
    for (const it of plan.items) {
      const input = el("input", { type: "text", maxlength: "120", disabled: dis, "aria-label": `Label ${it.id}`, value: eff.labels[it.id] ?? it.label });
      input.addEventListener("input", () => { animDraft(sl).labels = { ...eff.labels, ...(S.anim[sl.uid]?.labels ?? {}), [it.id]: input.value }; markDirty(); });
      fields.append(el("label", {}, it.description ?? it.id, input));
    }
    box.append(el("details", { class: "scene-label-edit", open: true }, el("summary", { text: "Labels (use | to split a heading from its detail)" }), fields));
  }
  const over = el("textarea", { rows: "3", disabled: dis, "aria-label": "On-screen text of the animation" });
  over.value = eff.slideText.join("\n");
  over.addEventListener("input", () => { animDraft(sl).slideText = over.value.split("\n").map((t) => t.trim()).filter(Boolean); markDirty(); });
  box.append(field("On-screen text in the animation (one line each)", over));

  // highlights / call-outs
  const pops = eff.popups;
  const setPops = (next) => { animDraft(sl).popups = next; markDirty(); renderRight(); renderBottom(); };
  const pb = el("div", { class: "popups" }, el("h4", { class: "studio-h", text: "Highlights and call-outs" }));
  pops.forEach((p, i) => {
    const upd = (patch) => { animDraft(sl).popups = pops.map((x, j) => (j === i ? { ...x, ...patch } : x)); markDirty(); renderBottom(); };
    const t = el("input", { type: "text", maxlength: "80", value: p.title, disabled: dis, "aria-label": "Call-out title" });
    t.addEventListener("input", () => upd({ title: t.value }));
    const body = el("textarea", { rows: "2", maxlength: "400", disabled: dis, "aria-label": "Call-out text" });
    body.value = p.text;
    body.addEventListener("input", () => upd({ text: body.value }));
    const kind = el("select", { disabled: dis, "aria-label": "Call-out kind" }, ["definition", "clinical", "warning"].map((k) => el("option", { value: k, text: k, selected: p.kind === k })));
    kind.addEventListener("change", () => upd({ kind: kind.value }));
    pb.append(el("div", { class: "popup-edit" }, el("div", { class: "row gap wrap" }, t, kind, el("button", { type: "button", class: "btn btn-ghost danger small", disabled: dis, onclick: () => setPops(pops.filter((_, j) => j !== i)) }, "Remove")), body,
      p.origin !== "source" ? el("span", { class: "small muted", text: `Origin: ${p.origin}. Needs clinician sign-off.` }) : null));
  });
  pb.append(el("button", { type: "button", class: "btn btn-secondary small", disabled: dis || pops.length >= 20, onclick: () => {
    const start = Math.min(1, Math.max(0, plan.durationSeconds - 3));
    setPops([...pops, { id: `custom-${Date.now().toString(36)}`, title: "Note", text: "", kind: "clinical", start, end: Math.min(plan.durationSeconds, start + 5), origin: "source" }]);
  } }, "Add call-out"));
  box.append(pb);
  const unack = plan.flags.filter((f) => !f.acknowledged);
  if (unack.length) box.append(el("ul", { class: "flags" }, unack.map((f) => el("li", {}, el("strong", { text: f.kind }), `: ${f.text}`))));
  box.append(el("p", { class: "muted small", text: "When you generate the video, only scenes whose slide, narration or animation changed are re-rendered; the rest are reused." }));
  if (S.course.animationEdits?.[String(n)] || S.anim[sl.uid]) {
    box.append(el("button", { type: "button", class: "btn btn-ghost small", disabled: dis, onclick: async () => {
      try { await flush(); const r = await S.host.call("PATCH", `/courses/${S.id}/animation`, { slide: S.slides.indexOf(sl) + 1, reset: true }); S.course = r.course; delete S.anim[sl.uid]; renderRight(); renderBottom(); S.host.toast("Animation edits for this slide were reset."); } catch (e) { S.host.toast(e.message, true); }
    } }, "Reset animation edits for this slide"));
  }
  return box;
}

async function refreshPlan() {
  try { await flush(); await S.host.call("POST", `/courses/${S.id}/plan`, {}); S.host.toast("Refreshing the animation plan…"); await pollCourse(); } catch (e) { S.host.toast(e.message, true); }
}

// ================================================================ bottom panel: voiceover and timeline

function renderBottom() {
  if (!S) return;
  const R = S.refs;
  R.bTabs.replaceChildren(...[["voice", "Voiceover script"], ["timeline", "Animation timeline"]].map(([id, label]) => el("button", { type: "button", role: "tab", class: `studio-tab${S.bottom === id ? " active" : ""}`, "aria-selected": String(S.bottom === id), onclick: () => { S.bottom = id; renderBottom(); } }, label)));
  R.bBody.replaceChildren(S.bottom === "voice" ? voicePanel() : timelinePanel());
}

function voicePanel() {
  const sl = cur();
  const n = S.sel + 1;
  const dis = busy();
  const ta = el("textarea", { rows: "5", maxlength: "20000", disabled: dis, "aria-label": `Narration for slide ${n}`, placeholder: "Narration for this slide…" });
  ta.value = sl.narration;
  const count = el("span", { class: "small muted" });
  const upd = () => { const w = ta.value.split(/\s+/).filter(Boolean).length; count.textContent = `${w} words · about ${formatDuration(w / 2.6)} spoken`; };
  upd();
  ta.addEventListener("input", () => { commit(() => { sl.narration = ta.value; }, { tag: "narr", render: "light" }); upd(); });
  const p = S.course.previews?.[String(n)];
  const voice = el("div", { class: "voice-row" },
    el("button", { type: "button", class: "btn btn-secondary small", disabled: dis || !sl.narration.trim() || ACTIVE.includes(S.course.job?.status) || ["queued", "running"].includes(S.course.job?.status), onclick: previewVoice }, p ? "Regenerate voice preview" : "Preview voice"),
    ["queued", "running"].includes(S.course.job?.status) ? el("span", { class: "small muted", text: `Engine: ${S.course.job.kind} ${S.course.job.status}…` }) : null);
  if (S.dirty) voice.append(el("span", { class: "small muted", text: "Your latest edit is saved first." }));
  if (p) voice.append(el("audio", { controls: true, preload: "none", src: S.host.apiUrl(`/courses/${S.id}/previews/${n}?v=${encodeURIComponent(p.at)}`) }), p.stale ? el("span", { class: "badge badge-cancelled", text: "older narration" }) : el("span", { class: "badge badge-complete", text: "current" }));
  return el("div", { class: "voice" },
    el("div", { class: "voice-head" }, el("span", { class: "pair", title: "The narration belongs to this slide and moves with it", text: `Slide ${n} ↔ narration ${n}` }), el("strong", { text: sl.title }), count),
    ta, voice,
    el("p", { class: "muted small", text: "Narration stays attached to its slide when you reorder, duplicate or delete slides. The voice is recorded with the engine's voice (Kokoro or the configured provider); the full video only re-records slides whose narration changed." }));
}

async function previewVoice() {
  try {
    await flush();
    if (S.save === "error" || S.save === "conflict") return;
    await S.host.call("POST", `/courses/${S.id}/preview`, { slides: String(S.sel + 1) });
    S.host.toast(`Voice preview for slide ${S.sel + 1} queued.`);
    await pollCourse();
  } catch (e) { S.host.toast(e.message, true); }
}

/** Follow the engine's job for this course until it finishes (voice preview / animation plan), then refresh previews and plans. */
async function pollCourse() {
  clearTimeout(S.pollTimer);
  const one = async () => {
    if (!S) return;
    try {
      const r = await S.host.call("GET", `/courses/${S.id}`);
      const wasAnim = S.course.animationPlan;
      S.course = { ...S.course, previews: r.course.previews, job: r.course.job, status: r.course.status, animationPlan: r.course.animationPlan ?? S.course.animationPlan, animationEdits: r.course.animationEdits, animation: r.course.animation, slidePreviews: r.course.slidePreviews };
      void wasAnim;
      renderBottom();
      renderToolbar();
      if (["queued", "running"].includes(r.course.job?.status) || ACTIVE.includes(r.course.status)) S.pollTimer = setTimeout(one, 3000);
      else { renderRight(); }
    } catch { S.pollTimer = setTimeout(one, 6000); }
  };
  await one();
}

function timelinePanel() {
  const sl = cur();
  const eff = effective(sl);
  const dis = busy();
  if (!eff) return el("p", { class: "muted small pad", text: "The animation timeline appears once the animation plan covers this slide (Animation tab → Prepare animations)." });
  const dur = eff.plan.durationSeconds;
  const wrap = el("div", { class: "timeline" });
  wrap.append(el("div", { class: "tl-scale small muted" }, ...[0, 0.25, 0.5, 0.75, 1].map((f) => el("span", { text: `${(dur * f).toFixed(1)}s` }))));
  const rows = [
    ...eff.events.map((e, i) => ({ kind: "event", i, label: `${eff.labels[e.element] ?? e.element} · ${e.action}`, start: e.start, end: e.end })),
    ...eff.popups.map((p, i) => ({ kind: "popup", i, label: `Call-out: ${p.title}`, start: p.start, end: p.end })),
  ];
  const write = (r, start, end) => {
    const list = r.kind === "event" ? eff.events : eff.popups;
    const next = list.map((x, j) => (j === r.i ? { ...x, start, end } : x));
    animDraft(sl)[r.kind === "event" ? "events" : "popups"] = next;
    markDirty();
  };
  for (const r of rows) {
    const bar = el("div", { class: `tl-bar${r.kind === "popup" ? " popup" : ""}`, tabindex: dis ? "-1" : "0", role: "slider", "aria-label": `${r.label} timing`, "aria-valuetext": `${r.start.toFixed(1)} to ${r.end.toFixed(1)} seconds` });
    const track = el("div", { class: "tl-track" }, bar);
    const place = (s, e) => css(bar, { left: pct(s / dur), width: pct(Math.max(0.01, (e - s) / dur)) });
    place(r.start, r.end);
    let cur_ = { start: r.start, end: r.end };
    bar.addEventListener("pointerdown", (ev) => {
      if (dis) return;
      ev.preventDefault();
      const rect = track.getBoundingClientRect();
      const x0 = ev.clientX;
      const edge = ev.offsetX < 8 ? "l" : ev.offsetX > bar.clientWidth - 8 ? "r" : "m";
      const s0 = cur_.start, e0 = cur_.end;
      bar.setPointerCapture?.(ev.pointerId);
      const mv = (m) => {
        const d = ((m.clientX - x0) / rect.width) * dur;
        let s = s0, e = e0;
        if (edge === "m") { const len = e0 - s0; s = Math.min(Math.max(0, s0 + d), dur - len); e = s + len; }
        else if (edge === "l") s = Math.min(Math.max(0, s0 + d), e0 - 0.1);
        else e = Math.max(s0 + 0.1, Math.min(dur, e0 + d));
        cur_ = { start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 };
        place(cur_.start, cur_.end);
      };
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); write(r, cur_.start, cur_.end); renderRight(); };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
    });
    bar.addEventListener("keydown", (ev) => {
      if (dis || !/^Arrow(Left|Right)$/.test(ev.key)) return;
      ev.preventDefault();
      const d = (ev.key === "ArrowLeft" ? -0.1 : 0.1) * (ev.shiftKey ? 5 : 1);
      const len = cur_.end - cur_.start;
      const s = Math.min(Math.max(0, cur_.start + d), dur - len);
      cur_ = { start: Math.round(s * 100) / 100, end: Math.round((s + len) * 100) / 100 };
      place(cur_.start, cur_.end);
      write(r, cur_.start, cur_.end);
    });
    wrap.append(el("div", { class: "tl-row" }, el("span", { class: "tl-label", title: r.label, text: r.label }), track));
  }
  if (!rows.length) wrap.append(el("p", { class: "muted small", text: "This animation has no timed elements." }));
  wrap.append(el("p", { class: "muted small", text: `Slide lasts ${dur.toFixed(1)} s${eff.plan.durationSource === "estimated" ? " (estimated until the video is generated)" : ""}. Drag a bar to move it, drag its edges to change the timing, or use the arrow keys.` }));
  return wrap;
}

// ================================================================ preview, versions, generate

function openPreview() {
  const dlg = el("dialog", { class: "modal studio-modal studio-preview" });
  let idx = S.sel;
  const body = el("div", { class: "studio-preview-body" });
  let player = null;
  const render = () => {
    player?.stop?.();
    const sl = S.slides[idx];
    const eff = effective(sl);
    const view = el("div", { class: "preview-slide" });
    drawSlide(view, sl, { width: 640 });
    player = eff ? scenePlayer(sl, { watermark: "DRAFT PREVIEW" }) : el("p", { class: "muted small", text: "No animation plan for this slide yet. Save, then prepare animations in the Animation tab." });
    const p = S.course.previews?.[String(idx + 1)];
    body.replaceChildren(
      el("div", { class: "row between wrap gap" }, el("strong", { text: `Slide ${idx + 1} of ${S.slides.length}: ${sl.title}` }), el("div", { class: "row gap" },
        el("button", { type: "button", class: "btn btn-secondary small", disabled: idx === 0, onclick: () => { idx--; render(); } }, "← Previous"),
        el("button", { type: "button", class: "btn btn-secondary small", disabled: idx === S.slides.length - 1, onclick: () => { idx++; render(); } }, "Next →"))),
      el("div", { class: "preview-cols" }, el("div", {}, el("h4", { class: "studio-h", text: "Slide" }), view), el("div", {}, el("h4", { class: "studio-h", text: "Animation" }), player)),
      el("p", { class: "narr", text: sl.narration || "(no narration yet)" }),
      p ? el("audio", { controls: true, preload: "none", src: S.host.apiUrl(`/courses/${S.id}/previews/${idx + 1}?v=${encodeURIComponent(p.at)}`) }) : el("p", { class: "muted small", text: "Voice preview: use “Preview voice” in the Voiceover panel." }));
  };
  dlg.append(el("div", { class: "modal-head" }, el("h2", { text: "Preview" }), el("button", { type: "button", class: "icon-btn", "aria-label": "Close preview", onclick: () => { player?.stop?.(); dlg.close(); dlg.remove(); } }, "✕")), body);
  document.body.append(dlg);
  dlg.addEventListener("close", () => { player?.stop?.(); dlg.remove(); });
  render();
  dlg.showModal?.() ?? dlg.setAttribute("open", "");
}

async function openVersions() {
  await flush();
  const dlg = el("dialog", { class: "modal studio-modal" });
  const list = el("ul", { class: "versions" });
  const draw = () => {
    list.replaceChildren(...S.versions.map((v) => el("li", {},
      el("div", {}, el("strong", { text: v.label || v.kind }), el("span", { class: "muted small", text: ` · ${v.slideCount} slides · ${new Date(v.createdAt).toLocaleString()}` })),
      el("button", { type: "button", class: "btn btn-secondary small", disabled: busy(), onclick: async () => {
        if (!confirm(`Return to “${v.label || v.kind}”? Your current version is kept in this list, so you can come back to it.`)) return;
        try { await S.host.call("POST", `/courses/${S.id}/editor/versions/${v.id}/restore`, {}); await load(); renderAll(); dlg.close(); S.host.toast("Version restored."); } catch (e) { S.host.toast(e.message, true); }
      } }, "Restore"))));
  };
  const label = el("input", { type: "text", maxlength: "80", placeholder: "Name this version (optional)", "aria-label": "Version name" });
  dlg.append(el("div", { class: "modal-head" }, el("h2", { text: "Saved versions" }), el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => dlg.close() }, "✕")),
    el("div", { class: "modal-body stack" },
      el("div", { class: "row gap wrap" }, label, el("button", { type: "button", class: "btn btn-primary small", onclick: async () => {
        try { const r = await S.host.call("POST", `/courses/${S.id}/editor/versions`, { label: label.value }); S.versions = r.versions; label.value = ""; draw(); S.host.toast("Version saved."); } catch (e) { S.host.toast(e.message, true); }
      } }, "Save a version now")),
      list,
      el("p", { class: "muted small" }, "Your uploaded files are never changed. ",
        el("a", { href: S.host.apiUrl(`/courses/${S.id}/editor/original/pptx`), class: "link-btn" }, "Download original PPTX"), " · ",
        el("a", { href: S.host.apiUrl(`/courses/${S.id}/editor/original/docx`), class: "link-btn" }, "Download original DOCX"))));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  draw();
  dlg.showModal?.() ?? dlg.setAttribute("open", "");
}

async function generate() {
  await flush();
  if (S.save === "error" || S.save === "conflict" || S.dirty) { S.host.toast("Fix the save problem first, then generate the video.", true); return; }
  if (!confirm("Generate the video from your saved edits? Slides, narration and animations are rebuilt where they changed.")) return;
  try {
    await S.host.generate();
    await closeStudio(true);
  } catch (e) { S.host.toast(e.message || String(e), true); }
}

// ================================================================ keyboard

function onKey(ev) {
  if (!S) return;
  const t = ev.target;
  const typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === "z" && !typing) { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && ev.key.toLowerCase() === "y" && !typing) { ev.preventDefault(); redo(); return; }
  if (mod && ev.key.toLowerCase() === "s") { ev.preventDefault(); saveNow(); return; }
  if (ev.key === "Escape" && !document.querySelector("dialog[open]")) { if (S.selKey) { S.selKey = null; renderCanvas(); renderRight(); } return; }
  if (typing || busy() || !S.selKey) return;
  if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); deleteSelected(); return; }
  const step = ev.shiftKey ? 0.02 : 0.005;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
  if (!d) return;
  ev.preventDefault();
  const sel = selection();
  if (!sel) return;
  commit(() => {
    const sl = cur();
    if (sel.orig) M.patchShape(sl, sel.def.id, { x: sel.g.x + d[0], y: sel.g.y + d[1] });
    else if (sel.el.x1 !== undefined) M.patchAdded(sl, sel.el.id, { x1: sel.el.x1 + d[0], x2: sel.el.x2 + d[0], y1: sel.el.y1 + d[1], y2: sel.el.y2 + d[1], x: sel.el.x + d[0], y: sel.el.y + d[1], from: undefined, to: undefined });
    else M.patchAdded(sl, sel.el.id, { x: sel.g.x + d[0], y: sel.g.y + d[1] });
  }, { tag: "nudge", render: "canvas" });
  renderRight();
}
