/// <reference lib="dom" />
import { LEAD_IN } from "../scene/timing.js";
import { renderFrame } from "../scene/core.js";
import type { Popup, SlidePlan, TimelineEvent } from "../types.js";

type StudioSlide = SlidePlan & { approved: boolean; elements: Array<{ id: string; label: string; description: string }> };
interface PlanResponse {
  slug: string;
  courseTitle: string;
  review: { approved: number; needs_review: number; rejected: number; draft: number; total: number };
  templates: Array<{ id: string; name: string }>;
  slides: StudioSlide[];
}

// Shown inside the Doctyn dashboard (same server, same page shell) when opened with ?embed=1.
if (new URLSearchParams(location.search).has("embed")) document.documentElement.classList.add("embed");

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const KNOWN_PARAMS: Record<string, string> = { reducedGlut4: "Reduced GLUT4 expression (only 1 of 3 transporters moves)", resistant: "Label the muscle cell as insulin resistant" };

let courses: Array<{ slug: string; title: string }> = [];
let slug = "";
let data: PlanResponse | undefined;
let current = 1;
let t = 0;
let playing = false;
let lastTick = 0;
let tab: "narration" | "text" | "animation" | "review" = "review";
let events: TimelineEvent[] = [];
let popups: Popup[] = [];
let dirty = false;
let selected: { kind: "event" | "popup"; id: string } | undefined;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (typeof v === "boolean") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

function toast(msg: string, err = false): void {
  const el = $("toast");
  el.textContent = msg;
  el.className = err ? "err" : "";
  if (!err) setTimeout(() => el.textContent === msg && (el.textContent = ""), 3500);
}

async function api<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(path, init ? { method: init.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : undefined);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

const slide = (): StudioSlide => data!.slides.find((s) => s.slide === current)!;
const working = (): StudioSlide => ({ ...slide(), events, popups });

function loadSlideState(): void {
  const s = slide();
  events = structuredClone(s.events);
  popups = structuredClone(s.popups);
  dirty = false;
  selected = undefined;
  t = 0;
  playing = false;
  const audio = $<HTMLAudioElement>("audio");
  audio.pause();
  if (s.durationSource === "audio" && !s.audioStale) audio.src = `/media/${slug}/audio/slide-${String(s.slide).padStart(3, "0")}.mp3`;
  else audio.removeAttribute("src");
  $("play").textContent = "▶ Play";
}

function stage(): void {
  $("stage").innerHTML = renderFrame(working(), t);
  const dur = slide().durationSeconds;
  $<HTMLInputElement>("scrub").value = String(Math.round((t / dur) * 1000));
  $("clock").textContent = `${t.toFixed(1)} / ${dur.toFixed(1)} s`;
  const head = document.querySelector<HTMLElement>(".tl-head");
  if (head) head.style.left = `calc(170px + (100% - 170px) * ${t / dur})`;
}

function renderList(): void {
  const nav = $("slides");
  nav.replaceChildren(
    ...data!.slides.map((s) =>
      h("button", { type: "button", class: s.slide === current ? "on" : "", onclick: () => select(s.slide) },
        `${String(s.slide).padStart(2, "0")} ${s.title}`,
        h("small", {}, s.template, h("span", { class: `badge ${s.approved ? "approved" : s.review.status === "approved" ? "needs_review" : s.review.status}` }, s.approved ? "approved" : s.review.status === "approved" ? "edited" : s.review.status.replace("_", " "))),
      ),
    ),
  );
  const r = data!.review;
  $("summary").textContent = `${r.approved}/${r.total} approved · ${r.needs_review} need review${r.rejected ? ` · ${r.rejected} rejected` : ""}`;
}

// ---------- timeline ----------
function timeline(): void {
  const s = working();
  const dur = s.durationSeconds;
  const box = $("timeline");
  const pct = (x: number): string => `${(x / dur) * 100}%`;
  const ruler = h("div", { class: "tl-track tl-ruler" });
  for (let x = 0; x <= dur; x += dur > 40 ? 10 : 2) ruler.append(h("span", { class: "tl-tick", style: `left:${pct(x)}` }, `${x}s`));
  ruler.addEventListener("pointerdown", (e) => seekFrom(e, ruler));
  const rows: HTMLElement[] = [h("div", { class: "tl-row" }, h("div", { class: "tl-name muted" }, "time"), ruler)];

  const bar = (kind: "event" | "popup", id: string, start: number, end: number, cls: string, title: string): HTMLElement => {
    const el = h("div", { class: `tl-bar ${cls}`, style: `left:${pct(start)};width:${pct(end - start)}${selected?.id === id ? ";outline:2px solid var(--warn)" : ""}`, title: `${title}\n${start.toFixed(2)}s → ${end.toFixed(2)}s` });
    el.addEventListener("pointerdown", (e) => dragBar(e, el, kind, id));
    return el;
  };

  for (const el of s.elements) {
    const track = h("div", { class: "tl-track" });
    for (const ev of events.filter((x) => x.element === el.id)) track.append(bar("event", ev.id, ev.start, ev.end, ev.action === "pulse" ? "pulse" : "", `${el.description} (${ev.action})`));
    track.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).classList.contains("tl-bar")) return;
      const r = track.getBoundingClientRect();
      const at = Math.max(0, ((e.clientX - r.left) / r.width) * dur);
      const has = events.some((x) => x.element === el.id && x.action === "show");
      events.push({ id: `ev-${el.id}-${Date.now() % 100000}`, element: el.id, action: has ? "pulse" : "show", start: +at.toFixed(2), end: +Math.min(dur, at + (has ? 1 : 1)).toFixed(2) });
      changed();
    });
    rows.push(h("div", { class: "tl-row" }, h("div", { class: "tl-name", title: el.description }, el.label), track));
  }
  for (const p of popups) {
    const track = h("div", { class: "tl-track" });
    track.append(bar("popup", p.id, p.start, p.end, "popup", `Pop-up: ${p.title}`));
    rows.push(h("div", { class: "tl-row" }, h("div", { class: "tl-name", title: p.title }, `💬 ${p.title}`), track));
  }
  const head = h("div", { class: "tl-head" });
  box.style.position = "relative";
  box.replaceChildren(...rows, head);
  stage();
}

function seekFrom(e: PointerEvent, ruler: HTMLElement): void {
  const move = (ev: PointerEvent): void => {
    const r = ruler.getBoundingClientRect();
    t = Math.min(slide().durationSeconds, Math.max(0, ((ev.clientX - r.left) / r.width) * slide().durationSeconds));
    syncAudio(true);
    stage();
  };
  move(e);
  const up = (): void => window.removeEventListener("pointermove", move);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}

function dragBar(e: PointerEvent, el: HTMLElement, kind: "event" | "popup", id: string): void {
  e.preventDefault();
  selected = { kind, id };
  const item = (kind === "event" ? events : popups).find((x) => x.id === id)!;
  const track = el.parentElement!;
  const r = track.getBoundingClientRect();
  const dur = slide().durationSeconds;
  const rel = e.clientX - el.getBoundingClientRect().left;
  const w = el.getBoundingClientRect().width;
  const mode = rel < 7 ? "left" : rel > w - 7 ? "right" : "move";
  const s0 = item.start;
  const e0 = item.end;
  const x0 = e.clientX;
  const move = (ev: PointerEvent): void => {
    const dt = ((ev.clientX - x0) / r.width) * dur;
    if (mode === "move") {
      const len = e0 - s0;
      item.start = +Math.min(dur - len, Math.max(0, s0 + dt)).toFixed(2);
      item.end = +(item.start + len).toFixed(2);
    } else if (mode === "left") item.start = +Math.min(e0 - 0.1, Math.max(0, s0 + dt)).toFixed(2);
    else item.end = +Math.min(dur, Math.max(s0 + 0.1, e0 + dt)).toFixed(2);
    delete (item as { cue?: string }).cue; // a hand-placed item no longer follows a narration phrase
    dirty = true;
    timeline();
    $("timeline-help").textContent = `${kind === "event" ? "Step" : "Pop-up"} ${item.start.toFixed(2)}s → ${item.end.toFixed(2)}s`;
  };
  const up = (): void => window.removeEventListener("pointermove", move);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
  timeline();
}

function changed(): void {
  dirty = true;
  timeline();
}

async function saveTimeline(): Promise<void> {
  await saveEdit({ events, popups }, "Timeline saved.");
}

async function saveEdit(edit: Record<string, unknown>, msg: string): Promise<void> {
  try {
    const { slide: updated } = await api<{ slide: StudioSlide }>(`/api/v2/${slug}/slides/${current}`, { method: "PUT", body: edit });
    replaceSlide(updated);
    toast(msg);
  } catch (err) {
    toast((err as Error).message, true);
  }
}

function replaceSlide(updated: StudioSlide): void {
  const i = data!.slides.findIndex((s) => s.slide === updated.slide);
  data!.slides[i] = updated;
  recount();
  if (updated.slide === current) loadSlideState();
  renderAll();
}

function recount(): void {
  const r = { approved: 0, needs_review: 0, rejected: 0, draft: 0, total: data!.slides.length };
  for (const s of data!.slides) r[s.approved ? "approved" : s.review.status === "approved" ? "needs_review" : s.review.status]++;
  data!.review = r;
}

// ---------- panel tabs ----------
function renderTabs(): void {
  const names: Array<[typeof tab, string]> = [["review", "Review"], ["narration", "Voiceover"], ["text", "Slide text"], ["animation", "Animation"]];
  $("tabs").replaceChildren(...names.map(([id, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(tab === id), onclick: () => { tab = id; renderTabs(); } }, label)));
  const body = $("tabbody");
  const s = slide();
  body.replaceChildren();
  if (tab === "narration") {
    const ta = h("textarea", { "aria-label": "Voiceover script" });
    ta.value = s.narration;
    body.append(
      h("div", { class: "note" }, s.durationSource === "audio"
        ? "Audio exists for this slide. Editing the script marks the audio stale; regenerate it before final render."
        : "Timing is estimated from word count until audio is generated. Editing re-times cue-linked animation steps."),
      ta,
      h("button", { type: "button", onclick: () => saveEdit({ narration: ta.value }, "Voiceover saved — review reset.") }, "Save voiceover"),
      h("div", { class: "note" }, "Edits are stored in the animation plan only. The source DOCX is not changed."),
    );
    if (s.audioStale) body.append(h("div", { class: "warn" }, "Audio is out of date with this script."));
  } else if (tab === "text") {
    const inputs = s.slideText.map((x) => { const i = h("input", { type: "text", "aria-label": "Slide text block" }); i.value = x; return i; });
    body.append(
      h("div", { class: "note" }, "Text blocks read from the PPTX. They drive the card layout of key-concept slides. The PPTX file itself is not changed."),
      ...inputs.map((i, n) => h("div", { class: "row2", style: "grid-template-columns:1fr auto" }, i, h("button", { type: "button", class: "secondary", "aria-label": `Remove block ${n + 1}`, onclick: () => saveEdit({ slideText: s.slideText.filter((_, k) => k !== n) }, "Block removed.") }, "✕"))),
      h("button", { type: "button", class: "secondary", onclick: () => saveEdit({ slideText: [...s.slideText, "New text"] }, "Block added.") }, "+ Add block"),
      h("button", { type: "button", onclick: () => saveEdit({ slideText: inputs.map((i) => i.value) }, "Slide text saved.") }, "Save slide text"),
    );
  } else if (tab === "animation") {
    const sel = h("select", { "aria-label": "Animation template" }, ...data!.templates.map((tp) => h("option", { value: tp.id, ...(tp.id === s.template ? { selected: true } : {}) }, tp.name)));
    const labelInputs = s.elements.map((el) => { const i = h("input", { type: "text", "aria-label": `Label for ${el.description}` }); i.value = s.labels[el.id] ?? ""; i.placeholder = el.label; return [el, i] as const; });
    const paramBoxes = Object.entries(KNOWN_PARAMS).filter(() => s.template === "glucose-uptake").map(([k, text]) => { const c = h("input", { type: "checkbox", ...(s.params[k] === true ? { checked: true } : {}) }); return [k, c, text] as const; });
    body.append(
      h("div", { class: "note" }, `Why this animation: ${s.rationale}`),
      h("label", {}, "Animation template", sel),
      h("button", { type: "button", class: "secondary", onclick: () => saveEdit({ template: sel.value }, "Template changed — timeline rebuilt, review reset.") }, "Apply template (rebuilds timeline)"),
      h("strong", {}, "Labels (blank = default)"),
      ...labelInputs.map(([el, i]) => h("label", {}, el.description, i)),
      ...paramBoxes.map(([, c, text]) => h("label", { class: "inline" }, c, text)),
      h("button", { type: "button", onclick: () => {
        const labels: Record<string, string> = {};
        for (const [el, i] of labelInputs) if (i.value.trim()) labels[el.id] = i.value.trim();
        const params = { ...s.params };
        for (const [k, c] of paramBoxes) { if (c.checked) params[k] = true; else delete params[k]; }
        void saveEdit({ labels, params }, "Labels saved.");
      } }, "Save labels & options"),
      h("strong", {}, "Clinical pop-ups"),
      ...popups.map((p, n) => popupEditor(p, n)),
      h("button", { type: "button", class: "secondary", onclick: () => { popups.push({ id: `pop-${Date.now() % 100000}`, title: "New pop-up", text: "Text", kind: "clinical", start: +t.toFixed(2), end: +Math.min(s.durationSeconds, t + 5).toFixed(2), origin: "source" }); dirty = true; renderAll(); } }, "+ Add pop-up at playhead"),
      h("div", { class: "note" }, "Pop-up edits are saved with “Save timeline”. Typed text is marked as your own (source) content."),
    );
  } else {
    const approvedBy = s.approved ? `Approved by ${s.review.reviewer ?? "?"} on ${(s.review.updatedAt ?? "").slice(0, 10)}` : s.review.status === "approved" ? "Edited since approval — needs re-approval." : `Status: ${s.review.status.replace("_", " ")}`;
    const reviewer = h("input", { type: "text", "aria-label": "Reviewer name", placeholder: "Clinician name" });
    reviewer.value = s.review.reviewer ?? "";
    const notes = h("textarea", { "aria-label": "Review notes", style: "min-height:70px" });
    notes.value = s.review.notes ?? "";
    const boxes = s.flags.map((f) => { const c = h("input", { type: "checkbox", ...(f.acknowledged ? { checked: true } : {}) }); return [f, c] as const; });
    const submit = (status: string): void => {
      const acknowledge = boxes.filter(([, c]) => c.checked).map(([f]) => f.id);
      api<{ slide: StudioSlide }>(`/api/v2/${slug}/slides/${current}/review`, { method: "POST", body: { status, reviewer: reviewer.value, notes: notes.value, acknowledge } })
        .then((r) => { replaceSlide(r.slide); toast(`Slide ${current}: ${status.replace("_", " ")}.`); })
        .catch((err: Error) => toast(err.message, true));
    };
    body.append(
      h("div", {}, h("strong", {}, approvedBy)),
      h("div", { class: "note" }, `Analyzer: ${s.analyzer === "ai" ? "AI-assisted" : "rule-based"} · timing ${s.durationSource}`),
      h("strong", {}, `Clinical checks (${s.flags.filter((f) => f.acknowledged).length}/${s.flags.length})`),
      ...(boxes.length ? boxes.map(([f, c]) => h("label", { class: `inline flag${f.acknowledged ? " done" : ""}` }, c, f.text)) : [h("div", { class: "note" }, "No automatic flags for this slide.")]),
      h("label", {}, "Reviewer", reviewer),
      h("label", {}, "Notes", notes),
      h("div", { class: "row2" }, h("button", { type: "button", onclick: () => submit("approved") }, "Approve slide"), h("button", { type: "button", class: "danger", onclick: () => submit("rejected") }, "Reject")),
      h("button", { type: "button", class: "secondary", onclick: () => submit("needs_review") }, "Mark as needs review"),
      h("div", { class: "note" }, "Final MP4 rendering only includes slides that are approved and unchanged since approval. Drafts are rendered with a watermark."),
    );
  }
}

function popupEditor(p: Popup, n: number): HTMLElement {
  const title = h("input", { type: "text", "aria-label": "Pop-up title" });
  title.value = p.title;
  const text = h("textarea", { "aria-label": "Pop-up text", style: "min-height:60px" });
  text.value = p.text;
  const kind = h("select", { "aria-label": "Pop-up kind" }, ...["definition", "clinical", "warning"].map((k) => h("option", { value: k, ...(k === p.kind ? { selected: true } : {}) }, k)));
  const sync = (): void => { p.title = title.value; p.text = text.value || "…"; p.kind = kind.value as Popup["kind"]; if (p.origin !== "source") p.origin = "source"; dirty = true; timeline(); };
  for (const el of [title, text, kind]) el.addEventListener("input", sync);
  return h("div", { class: "card" },
    h("span", { class: "note" }, `${p.origin === "source" ? "your text / source" : `generated (${p.origin})`} · ${p.start.toFixed(1)}–${p.end.toFixed(1)}s`),
    title, text, kind,
    h("button", { type: "button", class: "secondary", onclick: () => { popups.splice(n, 1); dirty = true; renderAll(); } }, "Remove pop-up"),
  );
}

// ---------- playback ----------
function syncAudio(seek: boolean): void {
  const audio = $<HTMLAudioElement>("audio");
  if (!audio.getAttribute("src") || !$<HTMLInputElement>("useAudio").checked) return;
  if (!playing) { audio.pause(); return; }
  if (t >= LEAD_IN) {
    if (seek || audio.paused) audio.currentTime = Math.max(0, t - LEAD_IN);
    if (audio.paused) void audio.play().catch(() => undefined);
  } else audio.pause();
}

function tick(now: number): void {
  if (playing) {
    t += (now - lastTick) / 1000;
    const dur = slide().durationSeconds;
    if (t >= dur) { t = dur; playing = false; $("play").textContent = "▶ Play"; $<HTMLAudioElement>("audio").pause(); }
    else syncAudio(false);
    stage();
  }
  lastTick = now;
  requestAnimationFrame(tick);
}

function renderAll(): void {
  renderList();
  renderTabs();
  timeline();
}

function select(n: number): void {
  if (dirty && !confirm("You have unsaved timeline changes on this slide. Discard them?")) return;
  current = n;
  loadSlideState();
  renderAll();
}

async function loadCourse(next: string): Promise<void> {
  slug = next;
  data = await api<PlanResponse>(`/api/v2/${slug}/plan`);
  current = data.slides[0]?.slide ?? 1;
  loadSlideState();
  renderAll();
}

async function init(): Promise<void> {
  try {
    courses = (await api<{ courses: Array<{ slug: string; title: string }> }>("/api/v2/courses")).courses;
  } catch (err) {
    toast((err as Error).message, true);
    return;
  }
  if (courses.length === 0) {
    $("stage").textContent = "No animation plan found. In Git Bash run: npm run animate -- analyze";
    return;
  }
  const sel = $<HTMLSelectElement>("course");
  sel.replaceChildren(...courses.map((c) => h("option", { value: c.slug }, c.title)));
  sel.addEventListener("change", () => void loadCourse(sel.value));
  $("play").addEventListener("click", () => {
    if (t >= slide().durationSeconds - 0.05) t = 0;
    playing = !playing;
    $("play").textContent = playing ? "❚❚ Pause" : "▶ Play";
    syncAudio(true);
  });
  $<HTMLInputElement>("scrub").addEventListener("input", (e) => {
    t = (Number((e.target as HTMLInputElement).value) / 1000) * slide().durationSeconds;
    syncAudio(true);
    stage();
  });
  $("save-timeline").addEventListener("click", () => void saveTimeline());
  $("reanalyze").addEventListener("click", () => {
    if (!confirm("Re-run topic analysis for this slide? Timeline, pop-ups and review for this slide will be replaced.")) return;
    api<{ slide: StudioSlide }>(`/api/v2/${slug}/slides/${current}/reanalyze`, { method: "POST", body: {} })
      .then((r) => { replaceSlide(r.slide); toast("Slide re-analysed."); })
      .catch((err: Error) => toast(err.message, true));
  });
  document.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      if (selected.kind === "event") events = events.filter((x) => x.id !== selected!.id);
      else popups = popups.filter((x) => x.id !== selected!.id);
      selected = undefined;
      changed();
      renderTabs();
    }
    if (e.key === " ") { e.preventDefault(); $("play").click(); }
  });
  await loadCourse(courses[0]!.slug);
  requestAnimationFrame(tick);
}

void init();
