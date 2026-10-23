// Doctyn Course Studio — cloud workspace: accounts, uploads, editing, reviews, generated videos, admin.
// Everything shown here comes from the /api/v3 backend. When it is not reachable the page says so.
import { $, el, formatBytes, formatClock, formatDuration, fullDate, svgPlay, timeAgo, toast } from "./ui.js";

const API = "/api/v3";
const STATUS_LABEL = {
  created: "Needs files", uploaded: "Uploaded", parsing: "Reading files…", parsed: "Ready", invalid: "Needs attention",
  queued: "Queued", rendering: "Generating…", complete: "Complete", failed: "Failed",
};
const STATUS_CLASS = { complete: "badge-complete", failed: "badge-failed", invalid: "badge-cancelled", created: "badge-cancelled" };
const REVIEW_LABEL = { none: "Not reviewed", pending: "Awaiting medical review", approved: "Medically approved", rejected: "Changes requested" };
const JOB_LABEL = { parse: "Reading files", build: "Video generation", animate: "Animation" };

const state = {
  user: null,
  meta: null,
  ready: false,
  unavailable: null,
  courses: [],
  reviews: [],
  admin: null,
  pollTimer: 0,
  editor: null,
  review: null,
  mode: "login",
  adminFilter: "",
};

// ---------- API ----------

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      credentials: "same-origin",
      headers: { "X-Requested-With": "doctyn", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    const e = new Error("The cloud backend could not be reached. Check your internet connection.");
    e.status = 0;
    throw e;
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const e = new Error(data?.error || `Request failed (HTTP ${res.status}).`);
    e.status = res.status;
    e.problems = data?.problems;
    throw e;
  }
  return data ?? {};
}

const errText = (e) => (e?.message || String(e));
const fail = (e) => toast(errText(e), true);

// ---------- session ----------

async function loadSession() {
  try {
    const [{ user }, meta] = await Promise.all([call("GET", "/auth/me"), call("GET", "/meta")]);
    state.user = user;
    state.meta = meta;
    state.unavailable = null;
  } catch (e) {
    state.user = null;
    state.unavailable = e.status === 404 || e.status === 0
      ? "The cloud backend is not available at this address. Open the deployed site, or start the development server with npm run cloud:dev."
      : [errText(e), ...(e.problems ?? [])].join("\n");
  }
  state.ready = true;
  renderAccount();
}

function renderAccount() {
  const box = $("account");
  if (!box) return;
  box.replaceChildren();
  if (state.user) {
    box.append(
      el("span", { class: "account-name small", title: state.user.email, text: `${state.user.name} · ${state.user.role}` }),
      el("button", { class: "btn btn-ghost small", type: "button", onclick: signOut }, "Sign out"),
    );
  } else {
    box.append(el("a", { class: "btn btn-secondary small", href: "#/cloud" }, "Sign in"));
  }
  document.querySelectorAll("[data-needs-role]").forEach((a) => {
    const roles = a.dataset.needsRole.split(",");
    a.hidden = !(state.user && roles.includes(state.user.role));
  });
}

async function signOut() {
  try { await call("POST", "/auth/logout", {}); } catch { /* already signed out */ }
  state.user = null;
  state.courses = [];
  stopPolling();
  renderAccount();
  show();
}

// ---------- routing between cloud views ----------

export function cloudView() {
  const h = location.hash;
  if (h.startsWith("#/review")) return "review";
  if (h.startsWith("#/admin")) return "admin";
  if (h.startsWith("#/cloud")) return "cloud";
  return null;
}

export async function show() {
  const view = cloudView();
  if (!view) { stopPolling(); return; }
  if (!state.ready) await loadSession();
  for (const v of ["cloud", "review", "admin"]) $(`${v}-view`).hidden = v !== view;
  if (view === "cloud") await renderCloud();
  if (view === "review") await renderReviews();
  if (view === "admin") await renderAdmin();
}

function gate(root) {
  // Returns true when the view may render its signed-in content.
  root.replaceChildren();
  if (state.unavailable) {
    root.append(card("Cloud workspace unavailable", el("div", { class: "notice error", text: state.unavailable })));
    return false;
  }
  if (!state.user) {
    root.append(authCard());
    return false;
  }
  return true;
}

const card = (title, ...body) => el("section", { class: "card" }, el("div", { class: "card-head" }, el("div", {}, el("h2", { text: title }))), ...body);

// ---------- sign in / register ----------

function authCard() {
  const login = state.mode === "login";
  const msg = el("div", { class: "notice", hidden: true });
  const email = el("input", { type: "email", required: true, autocomplete: "email", placeholder: "you@hospital.org" });
  const name = el("input", { type: "text", required: true, autocomplete: "name", maxlength: "100" });
  const pw = el("input", { type: "password", required: true, minlength: login ? "1" : "10", autocomplete: login ? "current-password" : "new-password" });
  const submit = el("button", { class: "btn btn-primary", type: "submit" }, login ? "Sign in" : "Create account");
  const form = el("form", {
    class: "auth-form",
    onsubmit: async (ev) => {
      ev.preventDefault();
      submit.disabled = true;
      msg.hidden = true;
      try {
        if (login) {
          const { user } = await call("POST", "/auth/login", { email: email.value, password: pw.value });
          state.user = user;
          renderAccount();
          await show();
        } else {
          const r = await call("POST", "/auth/register", { email: email.value, name: name.value, password: pw.value });
          state.mode = "login";
          toast(r.message);
          await show();
        }
      } catch (e) {
        msg.textContent = errText(e);
        msg.className = "notice error";
        msg.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  },
    login ? null : el("label", { class: "field" }, "Your name", name),
    el("label", { class: "field" }, "Email", email),
    el("label", { class: "field" }, login ? "Password" : "Password (at least 10 characters)", pw),
    msg,
    el("div", { class: "row between wrap gap" },
      submit,
      el("button", { class: "link-btn", type: "button", onclick: () => { state.mode = login ? "register" : "login"; show(); } }, login ? "Create an account" : "I already have an account"),
    ),
  );
  return el("section", { class: "card auth-card" },
    el("div", { class: "card-head" }, el("div", {},
      el("h2", { text: login ? "Sign in" : "Create your account" }),
      el("p", { class: "muted", text: "Your presentations, scripts and videos are private to your account." }),
    )),
    form,
    state.meta?.registration === "approval" && !login ? el("p", { class: "muted small", text: "New accounts are approved by an administrator before they can sign in." }) : null,
  );
}

// ---------- My courses ----------

async function loadCourses() {
  const { courses } = await call("GET", "/courses");
  state.courses = courses;
  const active = courses.some((c) => ["parsing", "queued", "rendering"].includes(c.status));
  active ? startPolling() : stopPolling();
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    if (document.hidden || cloudView() !== "cloud") return;
    try { await loadCourses(); renderCourseLists(); refreshEditorIfOpen(); } catch (e) { if (e.status === 401) signOut(); }
  }, 3000);
}
function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = 0; }

async function renderCloud() {
  const root = $("cloud-root");
  if (!gate(root)) return;
  try { await loadCourses(); } catch (e) { fail(e); }
  root.replaceChildren(newCourseCard(), el("section", { class: "card", id: "my-courses" }), el("section", { class: "card library", id: "my-videos" }));
  renderCourseLists();
}

function renderCourseLists() {
  const mine = $("my-courses");
  const vids = $("my-videos");
  if (!mine || !vids) return;
  mine.replaceChildren(
    el("div", { class: "card-head" }, el("div", {}, el("h2", { text: "My courses" }), el("p", { class: "muted", text: "Each course is private to you. Progress updates here automatically while a job runs." }))),
    state.courses.length ? el("div", { class: "course-list" }, state.courses.map(courseRow)) : el("div", { class: "empty" }, el("p", { text: "No courses yet. Add a presentation and a voiceover script above." })),
  );
  const done = state.courses.filter((c) => c.hasVideo);
  vids.replaceChildren(
    el("div", { class: "card-head" }, el("div", {}, el("h2", { text: "Generated videos" }), el("p", { class: "muted", text: "Finished courses appear here automatically and stay available when your computer is off." }))),
    el("div", { class: "grid" }, done.length ? done.map(videoCard) : el("div", { class: "empty" }, el("p", { text: "Your finished videos will appear here." }))),
  );
}

// ---- new course

function newCourseCard() {
  const files = { pptx: null, docx: null };
  const title = el("input", { type: "text", maxlength: "200", placeholder: "e.g. Risk Factors for Diabetes", "aria-label": "Course title" });
  const notice = el("div", { class: "notice", hidden: true });
  const bar = el("span");
  const progress = el("div", { class: "upload-progress", hidden: true }, el("div", { class: "bar" }, bar), el("span", { class: "small muted" }));
  const go = el("button", { class: "btn btn-primary", type: "button", disabled: true }, "Create course & upload");
  const sync = () => { go.disabled = !(files.pptx && files.docx && title.value.trim()); };
  title.addEventListener("input", sync);
  const zone = (type, label) => dropzone(type, label, (f) => {
    files[type] = f;
    if (type === "pptx" && f && !title.value.trim()) title.value = f.name.replace(/\.pptx$/i, "").replace(/[_-]+/g, " ").trim();
    sync();
  });
  go.addEventListener("click", async () => {
    go.disabled = true;
    notice.hidden = true;
    progress.hidden = false;
    try {
      const { course } = await call("POST", "/courses", { title: title.value.trim() });
      await uploadFiles(course.id, files, (pct, text) => { bar.style.width = `${pct}%`; progress.lastChild.textContent = text; });
      toast("Files uploaded. Reading your presentation and script…");
      await renderCloud();
    } catch (e) {
      notice.textContent = errText(e);
      notice.className = "notice error";
      notice.hidden = false;
      progress.hidden = true;
      sync();
    }
  });
  return el("section", { class: "card" },
    el("div", { class: "card-head" }, el("div", {},
      el("h2", {}, el("span", { class: "step", text: "1" }), "New course"),
      el("p", { class: "muted", text: "Upload one presentation and its slide-by-slide voiceover script (Slide 01 — Title, then VOICEOVER). The slide count must match." }),
    )),
    el("label", { class: "field" }, "Course title", title),
    el("div", { class: "dropzones" }, zone("pptx", "Presentation"), zone("docx", "Voiceover script")),
    progress, notice,
    el("div", { class: "row between wrap gap" }, el("span", { class: "muted small", text: `Up to ${state.meta ? Math.round(state.meta.maxUploadBytes / 1048576) : 200} MB per file.` }), go),
  );
}

function dropzone(type, label, onPick) {
  const ext = `.${type}`;
  const selected = el("span", { class: "dz-selected" });
  const input = el("input", { type: "file", accept: ext });
  const box = el("label", { class: "dropzone" },
    input,
    el("span", { class: `file-badge ${type}`, "aria-hidden": "true", text: type.toUpperCase() }),
    el("span", { class: "dz-title", text: label }),
    el("span", { class: "dz-hint" }, `Drop a ${ext} here or `, el("u", { text: "browse" })),
    selected,
  );
  const pick = (f) => {
    if (f && !f.name.toLowerCase().endsWith(ext)) { toast(`"${f.name}" is not a ${ext} file.`, true); return; }
    selected.textContent = f ? `${f.name} · ${formatBytes(f.size)}` : "";
    box.classList.toggle("has-file", Boolean(f));
    onPick(f);
  };
  input.addEventListener("change", () => pick(input.files[0] ?? null));
  for (const t of ["dragenter", "dragover"]) box.addEventListener(t, (e) => { e.preventDefault(); box.classList.add("drag"); });
  for (const t of ["dragleave", "drop"]) box.addEventListener(t, (e) => { e.preventDefault(); box.classList.remove("drag"); });
  box.addEventListener("drop", (e) => pick(e.dataTransfer.files[0] ?? null));
  return box;
}

function putFile(url, headers, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`The upload was rejected by storage (HTTP ${xhr.status}). If this keeps happening, the storage bucket CORS settings may be missing.`)));
    xhr.onerror = () => reject(new Error("The upload could not reach storage. Check your connection and the bucket CORS settings."));
    xhr.send(file);
  });
}

async function uploadFiles(courseId, files, report) {
  const list = ["pptx", "docx"].filter((t) => files[t]);
  for (const [i, type] of list.entries()) {
    const file = files[type];
    const up = await call("POST", `/courses/${courseId}/upload-url`, { type, filename: file.name, size: file.size });
    await putFile(up.url, up.headers, file, (f) => report(Math.round(((i + f) / list.length) * 100), `Uploading ${file.name}… ${Math.round(f * 100)}%`));
    await call("POST", `/courses/${courseId}/files/complete`, { type, key: up.key, filename: file.name });
  }
  report(100, "Upload complete.");
}

// ---- course rows

function badge(c) {
  return el("span", { class: `badge ${STATUS_CLASS[c.status] ?? ""}`, text: STATUS_LABEL[c.status] ?? c.status });
}

function courseRow(c) {
  const job = c.job;
  const active = ["parsing", "queued", "rendering"].includes(c.status);
  const meta = [c.slideCount && `${c.slideCount} slides`, c.files.pptx, c.durationSeconds && formatDuration(c.durationSeconds), `updated ${timeAgo(c.updatedAt)}`].filter(Boolean);
  const buttons = [];
  const act = (label, cls, fn, disabled = false) => buttons.push(el("button", { class: `btn ${cls} small`, type: "button", disabled, onclick: fn }, label));

  if (c.status === "parsed") act("Generate video", "btn-primary", () => start(c, "build"));
  if (c.status === "complete") {
    act("Play", "btn-primary", () => openPlayer(c));
    act(c.animation ? "Re-create animations" : "Create animations", "btn-secondary", () => start(c, "animate"), c.stale);
  }
  if (c.status === "complete" && c.stale) act("Regenerate video (edited)", "btn-secondary", () => start(c, "build"));
  if (c.status === "failed" || (job && ["failed", "cancelled"].includes(job.status) && c.status !== "complete" && c.status !== "invalid")) {
    act("Retry", "btn-secondary", async () => { try { await call("POST", `/jobs/${job.id}/retry`, {}); await renderCloud(); } catch (e) { fail(e); } });
  }
  if (active && job && ["queued", "running"].includes(job.status)) {
    act(job.cancelRequested ? "Cancelling…" : "Cancel", "btn-ghost danger", async () => { try { await call("POST", `/jobs/${job.id}/cancel`, {}); await loadCourses(); renderCourseLists(); } catch (e) { fail(e); } }, job.cancelRequested);
  }
  act("Open", "btn-ghost", () => openEditor(c.id), false);
  act("Delete", "btn-ghost danger", async () => {
    if (!confirm(`Delete "${c.title}" and all of its files? This cannot be undone.`)) return;
    try { await call("DELETE", `/courses/${c.id}`); await renderCloud(); } catch (e) { fail(e); }
  }, active);

  const pct = Math.round(job?.progress?.percent ?? 0);
  return el("article", { class: "course-row" },
    el("div", { class: "row between gap wrap" },
      el("h3", { class: "video-title", text: c.title }),
      el("div", { class: "row gap" }, badge(c), reviewBadge(c)),
    ),
    el("div", { class: "video-meta" }, meta.map((m) => el("span", { text: m }))),
    active && job ? el("div", { class: "job-mini" },
      el("div", { class: "bar big", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" }, el("span", { style: `width:${pct}%` })),
      el("span", { class: "small muted", text: `${JOB_LABEL[job.kind] ?? job.kind}: ${job.status === "queued" ? "waiting for a worker…" : job.progress?.detail ?? "Starting…"}${job.attempt > 1 ? ` (attempt ${job.attempt}/${job.maxAttempts})` : ""}` }),
    ) : null,
    c.error && c.status !== "complete" ? el("div", { class: "notice error", text: c.error }) : null,
    c.status === "complete" && job?.status === "failed" ? el("div", { class: "notice error", text: `${JOB_LABEL[job.kind] ?? "The last job"} failed: ${job.error}` }) : null,
    el("div", { class: "video-actions" }, buttons),
  );
}

function reviewBadge(c) {
  if (c.publishedAt) return el("span", { class: "badge badge-complete", text: "Published" });
  if (c.review.status === "none" && !c.hasVideo) return null;
  const cls = c.review.status === "approved" ? "badge-complete" : c.review.status === "rejected" ? "badge-failed" : "badge-cancelled";
  return el("span", { class: `badge ${cls}`, text: REVIEW_LABEL[c.review.status] });
}

async function start(c, kind) {
  try {
    await call("POST", `/courses/${c.id}/${kind === "build" ? "build" : "animate"}`, {});
    toast(kind === "build" ? "Video generation queued." : "Animation job queued.");
    await loadCourses();
    renderCourseLists();
    startPolling();
  } catch (e) { fail(e); }
}

// ---- generated videos

const fileUrl = (c, name, download = false) => `${API}/courses/${c.id}/files/${name}${download ? "?download=1" : ""}`;

function videoCard(c) {
  const thumb = el("button", { class: "thumb", type: "button", "aria-label": `Play ${c.title}`, onclick: () => openPlayer(c) },
    c.available.thumbnail ? el("img", { src: fileUrl(c, "thumbnail"), alt: "", loading: "lazy", width: "1280", height: "720" }) : el("span", { class: "noimg", text: "No thumbnail" }),
    el("span", { class: "play", "aria-hidden": "true" }, svgPlay()),
    c.durationSeconds ? el("span", { class: "duration", text: formatClock(c.durationSeconds) }) : null,
  );
  const meta = [c.slideCount && `${c.slideCount} slides`, c.durationSeconds && formatDuration(c.durationSeconds), c.videoBytes && formatBytes(c.videoBytes), `built ${timeAgo(c.completedAt)}`].filter(Boolean);
  return el("article", { class: "video-card" },
    thumb,
    el("div", { class: "video-body" },
      el("div", { class: "row between gap" }, el("h3", { class: "video-title", text: c.title }), c.publishedAt ? el("span", { class: "badge badge-complete", text: "Published" }) : el("span", { class: "badge badge-cancelled", text: "Draft" })),
      el("div", { class: "video-meta" }, meta.map((m) => el("span", { text: m }))),
      c.stale ? el("div", { class: "video-meta" }, el("span", { text: "Edited since this video was made" })) : null,
    ),
    el("div", { class: "video-actions" }, el("button", { class: "btn btn-primary small", type: "button", onclick: () => openPlayer(c) }, "Play"), downloadLinks(c)),
  );
}

function downloadLinks(c) {
  const defs = [["video", "Download MP4"], ["animated", "Animated MP4"], ["vtt", "VTT"], ["srt", "SRT"], ["transcript", "Transcript"]];
  return defs.filter(([k]) => c.available[k]).map(([k, label]) =>
    el("a", { class: "btn btn-ghost small", href: fileUrl(c, k, true), title: `Download ${label}` }, `↓ ${label}`));
}

function openPlayer(c, which = "video") {
  const video = $("player-video");
  video.replaceChildren();
  video.removeAttribute("crossorigin"); // same-origin API that redirects to a signed storage URL
  video.src = fileUrl(c, which);
  if (c.available.thumbnail) video.poster = fileUrl(c, "thumbnail"); else video.removeAttribute("poster");
  if (c.available.vtt) video.append(el("track", { kind: "captions", label: "English", srclang: "en", src: fileUrl(c, "vtt"), default: true }));
  $("player-title").textContent = which === "animated" ? `${c.title} (animated)` : c.title;
  $("player-meta").textContent = [c.slideCount && `${c.slideCount} slides`, c.durationSeconds && formatDuration(c.durationSeconds), c.completedAt && `built ${fullDate(c.completedAt)}`, !c.publishedAt && "draft: not yet medically approved and published"].filter(Boolean).join(" · ");
  const extra = c.available.animated && which !== "animated" ? [el("button", { class: "btn btn-secondary small", type: "button", onclick: () => openPlayer(c, "animated") }, "Watch animated version")] : [];
  if (which === "animated") extra.push(el("button", { class: "btn btn-secondary small", type: "button", onclick: () => openPlayer(c, "video") }, "Watch narrated slides"));
  $("player-downloads").replaceChildren(...extra, ...downloadLinks(c));
  $("player").showModal();
}

// ---------- editor dialog ----------

async function openEditor(id, tab = "slides") {
  try {
    const { course, jobs } = await call("GET", `/courses/${id}`);
    state.editor = { course, jobs, tab, drafts: {}, animDrafts: {} };
    renderEditor();
    if (!$("editor").open) $("editor").showModal();
  } catch (e) { fail(e); }
}

async function refreshEditorIfOpen() {
  if (!state.editor || !$("editor").open) return;
  if (document.activeElement && $("editor").contains(document.activeElement) && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  try {
    const { course, jobs } = await call("GET", `/courses/${state.editor.course.id}`);
    state.editor.course = course;
    state.editor.jobs = jobs;
    renderEditor();
  } catch { /* closed or removed */ }
}

function closeEditor() { $("editor").close(); state.editor = null; renderCloud(); }

function renderEditor() {
  const { course: c, tab } = state.editor;
  $("editor-title").textContent = c.title;
  const busy = ["parsing", "queued", "rendering"].includes(c.status);
  const tabs = [["slides", "Slides & narration"], ["animations", "Animations"], ["review", "Medical review"], ["files", "Files"]];
  $("editor-tabs").replaceChildren(...tabs.map(([k, label]) =>
    el("button", { class: "tab", type: "button", "aria-selected": String(tab === k), onclick: () => { state.editor.tab = k; renderEditor(); } }, label)));
  const body = $("editor-body");
  const scroll = body.scrollTop;
  body.replaceChildren(
    el("div", { class: "row gap wrap" }, badge(c), reviewBadge(c), busy ? el("span", { class: "small muted", text: "Editing is paused while a job is running." }) : null),
    c.error && c.status !== "complete" ? el("div", { class: "notice error", text: c.error }) : null,
    tab === "slides" ? slidesTab(c, busy) : tab === "animations" ? animationsTab(c, busy) : tab === "review" ? reviewTab(c) : filesTab(c, busy),
  );
  body.scrollTop = scroll;
}

function slidesTab(c, busy) {
  if (!c.slides?.length) return el("div", { class: "empty" }, el("p", { text: c.status === "parsing" ? "Reading your files…" : "Upload a presentation and a script (Files tab) to see the slides." }));
  const v = c.validation;
  const drafts = state.editor.drafts;
  const parts = [];
  if (v && v.ok === false) {
    parts.push(el("div", { class: "notice error" },
      `The presentation has ${v.pptxCount ?? c.slideCount} slides and the script has ${v.narrationCount ?? "?"} sections.`,
      v.missing?.length ? `\nMissing narration: slide ${v.missing.join(", ")}.` : "",
      v.duplicates?.length ? `\nDuplicate sections: ${v.duplicates.map((d) => d.number).join(", ")}.` : "",
      v.malformed?.length ? `\nUnreadable headings: ${v.malformed.map((m) => `"${m.text}"`).join(", ")}.` : "",
      "\nWrite the missing narration below and save — or upload a corrected script on the Files tab.",
    ));
  } else if (v?.warnings?.length) {
    parts.push(el("div", { class: "notice", text: v.warnings.join("\n") }));
  }
  const save = el("button", { class: "btn btn-primary", type: "button", disabled: busy, onclick: async () => {
    const edits = Object.entries(drafts).map(([slide, d]) => ({ slide: Number(slide), ...d }));
    if (!edits.length) return toast("No changes to save.");
    try {
      const { course } = await call("PATCH", `/courses/${c.id}`, { slides: edits });
      state.editor.course = course;
      state.editor.drafts = {};
      toast(course.review.status === "none" ? "Saved. Any earlier medical approval no longer applies." : "Saved.");
      renderEditor();
    } catch (e) { fail(e); }
  } }, "Save changes");
  parts.push(
    el("div", { class: "row between wrap gap" },
      el("p", { class: "muted small", text: "Changes apply to the next video you generate. Editing narration reopens medical review." }),
      save,
    ),
    ...c.slides.map((s) => {
      const empty = !s.narration.trim();
      const title = el("input", { type: "text", value: s.title, maxlength: "300", disabled: busy, "aria-label": `Slide ${s.slide} title` });
      const text = el("textarea", { rows: "5", maxlength: "20000", disabled: busy, "aria-label": `Slide ${s.slide} narration`, placeholder: "Narration for this slide…" });
      text.value = s.narration;
      const count = el("span", { class: "small muted" });
      const upd = () => { count.textContent = `${text.value.split(/\s+/).filter(Boolean).length} words`; };
      upd();
      const note = (key, val) => { (drafts[s.slide] ??= {})[key] = val; };
      title.addEventListener("input", () => note("title", title.value));
      text.addEventListener("input", () => { note("narration", text.value); upd(); });
      if (drafts[s.slide]?.title !== undefined) title.value = drafts[s.slide].title;
      if (drafts[s.slide]?.narration !== undefined) { text.value = drafts[s.slide].narration; upd(); }
      return el("div", { class: `slide-edit${empty ? " missing" : ""}` },
        el("div", { class: "row between gap" }, el("strong", { text: `Slide ${s.slide}` }), empty ? el("span", { class: "badge badge-failed", text: "No narration" }) : count),
        title, text,
      );
    }),
  );
  return el("div", { class: "stack" }, parts);
}

function animationsTab(c, busy) {
  const plan = c.animationPlan;
  const parts = [];
  parts.push(el("p", { class: "muted small", text: "Each slide gets a topic-specific explainer animation built only from your slide text and narration. Wording the system derived is flagged for the medical reviewer; nothing is shown as approved until a reviewer signs off." }));
  const staged = Object.keys(c.animationEdits ?? {});
  if (staged.length) parts.push(el("div", { class: "notice", text: `Edits staged for slide${staged.length > 1 ? "s" : ""} ${staged.join(", ")}. They are applied the next time you create animations.` }));
  parts.push(el("div", { class: "row gap wrap" },
    el("button", { class: "btn btn-primary", type: "button", disabled: busy || c.status !== "complete" || c.stale, onclick: async () => {
      try { await call("POST", `/courses/${c.id}/animate`, {}); toast("Animation job queued."); closeEditor(); startPolling(); } catch (e) { fail(e); }
    } }, plan ? "Re-create animations" : "Create animations"),
    c.available.animated ? el("button", { class: "btn btn-secondary", type: "button", onclick: () => openPlayer(c, "animated") }, "Watch animated version") : null,
    c.animation ? el("span", { class: `badge ${c.animation.draft ? "badge-cancelled" : "badge-complete"}`, text: c.animation.draft ? "Draft: watermarked until medically approved" : "Approved version" }) : null,
  ));
  if (c.status !== "complete") parts.push(el("div", { class: "notice", text: "Generate the narrated video first; animations are timed to the finished narration audio." }));
  if (!plan) return el("div", { class: "stack" }, parts);

  for (const s of plan) {
    const staged1 = c.animationEdits?.[String(s.slide)] ?? {};
    const draft = (state.editor.animDrafts[s.slide] ??= {});
    const tmpl = el("select", { disabled: busy, "aria-label": `Slide ${s.slide} animation type` },
      (state.meta?.animationTemplates ?? [s.template]).map((t) => el("option", { value: t, text: t, selected: (draft.template ?? staged1.template ?? s.template) === t })));
    tmpl.addEventListener("change", () => (draft.template = tmpl.value));
    const texts = el("textarea", { rows: "3", disabled: busy, "aria-label": `Slide ${s.slide} on-screen text` });
    texts.value = (draft.slideText ?? staged1.slideText ?? s.slideText).join("\n");
    texts.addEventListener("input", () => (draft.slideText = texts.value.split("\n").map((t) => t.trim()).filter(Boolean)));
    const popups = (staged1.popups ?? s.popups).map((p, i) => {
      const area = el("textarea", { rows: "2", maxlength: "400", disabled: busy, "aria-label": `Slide ${s.slide} callout ${i + 1}` });
      area.value = draft.popups?.[i]?.text ?? p.text;
      area.addEventListener("input", () => {
        draft.popups ??= (staged1.popups ?? s.popups).map((x) => ({ ...x }));
        draft.popups[i] = { ...draft.popups[i], text: area.value };
      });
      return el("label", { class: "field" }, `Callout: ${p.title} (${p.kind}, ${p.origin})`, area);
    });
    const flags = s.flags.filter((f) => !f.acknowledged);
    parts.push(el("details", { class: "anim-slide" },
      el("summary", {}, el("strong", { text: `Slide ${s.slide}` }), ` ${s.title} `, el("span", { class: "badge", text: s.template }), flags.length ? el("span", { class: "badge badge-cancelled", text: `${flags.length} flag${flags.length > 1 ? "s" : ""}` }) : null),
      el("div", { class: "stack" },
        el("p", { class: "muted small", text: s.rationale }),
        el("label", { class: "field" }, "Animation type", tmpl),
        el("label", { class: "field" }, "On-screen text (one line each)", texts),
        ...popups,
        flags.length ? el("ul", { class: "flags" }, flags.map((f) => el("li", {}, el("strong", { text: f.kind }), `: ${f.text}`))) : null,
        el("button", { class: "btn btn-secondary small", type: "button", disabled: busy, onclick: async () => {
          const edit = {};
          if (draft.template) edit.template = draft.template;
          if (draft.slideText) edit.slideText = draft.slideText;
          if (draft.popups) edit.popups = draft.popups;
          if (!Object.keys(edit).length) return toast("No changes on this slide.");
          try {
            const { course } = await call("PATCH", `/courses/${c.id}/animation`, { slide: s.slide, edit });
            state.editor.course = course;
            state.editor.animDrafts[s.slide] = {};
            toast("Animation edit staged. Medical review is required again.");
            const { course: full } = await call("GET", `/courses/${c.id}`);
            state.editor.course = full;
            renderEditor();
          } catch (e) { fail(e); }
        } }, "Stage edit for this slide"),
      ),
    ));
  }
  return el("div", { class: "stack" }, parts);
}

function reviewTab(c) {
  const r = c.review;
  const parts = [
    el("p", { class: "muted", text: "AI-assisted clinical content (narration wording, derived callouts and animations) must be approved by a medical reviewer before the course is published. Any later edit to the text or animations reopens the review." }),
    el("div", { class: "notice", text: `Status: ${REVIEW_LABEL[r.status]}${r.matchesCurrentContent ? "" : r.status === "approved" ? " (content changed since)" : ""}${r.at ? ` · ${fullDate(r.at)}` : ""}${r.notes ? `\nReviewer notes: ${r.notes}` : ""}` }),
  ];
  const row = el("div", { class: "row gap wrap" });
  row.append(
    el("button", { class: "btn btn-primary", type: "button", disabled: !c.slides?.length || r.status === "pending", onclick: async () => {
      try { await call("POST", `/courses/${c.id}/review/request`, {}); toast("Sent to the medical reviewers."); await openEditor(c.id, "review"); } catch (e) { fail(e); }
    } }, r.status === "pending" ? "Review requested" : "Request medical review"),
    el("button", { class: "btn btn-secondary", type: "button", disabled: Boolean(c.publishedAt) || r.status !== "approved" || !r.matchesCurrentContent || c.status !== "complete" || c.stale, onclick: async () => {
      try { await call("POST", `/courses/${c.id}/publish`, {}); toast("Published."); await openEditor(c.id, "review"); } catch (e) { fail(e); }
    } }, c.publishedAt ? "Published" : "Publish"),
    c.publishedAt ? el("button", { class: "btn btn-ghost", type: "button", onclick: async () => { try { await call("POST", `/courses/${c.id}/unpublish`, {}); await openEditor(c.id, "review"); } catch (e) { fail(e); } } }, "Unpublish") : null,
  );
  parts.push(row);
  if (r.status === "approved" && c.animation?.draft) parts.push(el("div", { class: "notice", text: "Your animated video is still a watermarked draft. Create animations again to render the approved version." }));
  return el("div", { class: "stack" }, parts);
}

function filesTab(c, busy) {
  const files = { pptx: null, docx: null };
  const bar = el("span");
  const progress = el("div", { class: "upload-progress", hidden: true }, el("div", { class: "bar" }, bar), el("span", { class: "small muted" }));
  const go = el("button", { class: "btn btn-primary", type: "button", disabled: true, onclick: async () => {
    go.disabled = true; progress.hidden = false;
    try {
      await uploadFiles(c.id, files, (p, t) => { bar.style.width = `${p}%`; progress.lastChild.textContent = t; });
      toast("Uploaded. Reading the files…");
      closeEditor();
    } catch (e) { fail(e); progress.hidden = true; go.disabled = false; }
  } }, "Upload & replace");
  const sync = () => (go.disabled = busy || !(files.pptx || files.docx));
  return el("div", { class: "stack" },
    el("p", { class: "muted", text: `Current files: ${c.files.pptx ?? "no presentation"} · ${c.files.docx ?? "no script"}. Replacing a file re-reads the course and reopens medical review.` }),
    el("div", { class: "dropzones" }, dropzone("pptx", "Presentation", (f) => { files.pptx = f; sync(); }), dropzone("docx", "Voiceover script", (f) => { files.docx = f; sync(); })),
    progress, go,
  );
}

// ---------- medical review queue ----------

async function renderReviews() {
  const root = $("review-root");
  if (!gate(root)) return;
  if (!["reviewer", "admin"].includes(state.user.role)) {
    root.append(card("Medical review", el("div", { class: "notice", text: "This area is for medical reviewers. Ask an administrator for the reviewer role." })));
    return;
  }
  let courses = [];
  try { courses = (await call("GET", "/reviews")).courses; } catch (e) { fail(e); }
  root.append(el("section", { class: "card" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", { text: "Waiting for medical review" }), el("p", { class: "muted", text: "Read the exact narration and animation content, then approve or request changes. Approval covers this version only." }))),
    courses.length ? el("div", { class: "course-list" }, courses.map((c) => el("article", { class: "course-row" },
      el("div", { class: "row between gap wrap" }, el("h3", { class: "video-title", text: c.title }), el("span", { class: "muted small", text: `${c.ownerName} · ${c.slideCount} slides · requested ${timeAgo(c.updatedAt)}` })),
      el("div", { class: "video-actions" }, el("button", { class: "btn btn-primary small", type: "button", onclick: () => openReview(c.id) }, "Review")),
    ))) : el("div", { class: "empty" }, el("p", { text: "Nothing is waiting for review." })),
  ));
}

async function openReview(id) {
  try {
    const { course } = await call("GET", `/reviews/${id}`);
    const notes = el("textarea", { rows: "3", maxlength: "4000", placeholder: "Notes (required when requesting changes)", "aria-label": "Review notes" });
    const decide = (decision) => async () => {
      try {
        await call("POST", `/courses/${id}/review`, { decision, notes: notes.value });
        toast(decision === "approved" ? "Approved." : "Changes requested.");
        $("review-dialog").close();
        renderReviews();
      } catch (e) { fail(e); }
    };
    const plan = course.animationPlan ?? [];
    $("review-title").textContent = course.title;
    $("review-body").replaceChildren(
      el("p", { class: "muted small", text: "You are approving the text below and, where present, the animation callouts and flagged items." }),
      ...course.slides.map((s) => {
        const a = plan.find((p) => p.slide === s.slide);
        const open = a ? a.flags.filter((f) => !f.acknowledged) : [];
        return el("details", { class: "anim-slide", open: false },
          el("summary", {}, el("strong", { text: `Slide ${s.slide}` }), ` ${s.title}`, open.length ? el("span", { class: "badge badge-cancelled", text: `${open.length} flag${open.length > 1 ? "s" : ""}` }) : null),
          el("div", { class: "stack" },
            el("p", { class: "narration", text: s.narration }),
            a ? el("p", { class: "muted small", text: `Animation: ${a.template}. ${a.rationale}` }) : null,
            a?.slideText?.length ? el("p", { class: "small", text: `On screen: ${a.slideText.join(" / ")}` }) : null,
            ...(a?.popups ?? []).map((p) => el("p", { class: "small" }, el("strong", { text: `${p.title} (${p.kind}, ${p.origin}): ` }), p.text)),
            open.length ? el("ul", { class: "flags" }, open.map((f) => el("li", {}, el("strong", { text: f.kind }), `: ${f.text}`))) : null,
          ),
        );
      }),
      notes,
      el("div", { class: "row gap wrap right" },
        el("button", { class: "btn btn-ghost danger", type: "button", onclick: decide("rejected") }, "Request changes"),
        el("button", { class: "btn btn-primary", type: "button", onclick: decide("approved") }, "Approve this version"),
      ),
    );
    $("review-dialog").showModal();
  } catch (e) { fail(e); }
}

// ---------- administration ----------

async function renderAdmin() {
  const root = $("admin-root");
  if (!gate(root)) return;
  if (state.user.role !== "admin") {
    root.append(card("Administration", el("div", { class: "notice", text: "Administrators only." })));
    return;
  }
  try {
    const [overview, users, jobs, courses] = await Promise.all([
      call("GET", "/admin/overview"),
      call("GET", "/admin/users"),
      call("GET", `/admin/jobs${state.adminFilter ? `?status=${state.adminFilter}` : ""}`),
      call("GET", "/admin/courses"),
    ]);
    root.append(adminOverview(overview), adminUsers(users.users), adminJobs(jobs.jobs), adminCourses(courses.courses));
  } catch (e) { root.append(el("div", { class: "notice error", text: errText(e) })); }
}

const stat = (label, value) => el("div", { class: "stat" }, el("strong", { text: String(value) }), el("span", { class: "muted small", text: label }));

function adminOverview(o) {
  const n = (obj, k) => obj?.[k] ?? 0;
  return el("section", { class: "card" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", { text: "Overview" }), el("p", { class: "muted", text: "Users, jobs and storage across the platform. Administrators manage accounts and jobs; they cannot open other users' course content." }))),
    el("div", { class: "stats" },
      stat("Active users", n(o.users, "active")), stat("Awaiting approval", n(o.users, "pending")),
      stat("Courses", Object.values(o.courses).reduce((a, b) => a + b, 0)), stat("Jobs running", n(o.jobs, "running")),
      stat("Jobs queued", n(o.jobs, "queued")), stat("Jobs failed", n(o.jobs, "failed")), stat("Stored", formatBytes(o.storageBytes) || "0 B"),
    ),
  );
}

function adminUsers(users) {
  const sel = (u, field, options) => {
    const s = el("select", { disabled: u.id === state.user.id, "aria-label": `${field} for ${u.email}` }, options.map((o) => el("option", { value: o, text: o, selected: u[field] === o })));
    s.addEventListener("change", async () => {
      try { await call("PATCH", `/admin/users/${u.id}`, { [field]: s.value }); toast("Updated."); renderAdminRefresh(); } catch (e) { fail(e); renderAdminRefresh(); }
    });
    return s;
  };
  return el("section", { class: "card" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", { text: "Users" }))),
    el("div", { class: "table-wrap" }, el("table", { class: "table" },
      el("thead", {}, el("tr", {}, ["Name", "Email", "Status", "Role", "Courses", "Storage", "Last sign-in"].map((h) => el("th", { text: h })))),
      el("tbody", {}, users.map((u) => el("tr", {},
        el("td", { text: u.name }), el("td", { text: u.email }),
        el("td", {}, sel(u, "status", ["pending", "active", "disabled"])),
        el("td", {}, sel(u, "role", ["user", "reviewer", "admin"])),
        el("td", { text: String(u.courses) }), el("td", { text: formatBytes(u.storageBytes) || "0 B" }), el("td", { text: u.lastLoginAt ? timeAgo(u.lastLoginAt) : "never" }),
      ))),
    )),
  );
}

function adminJobs(jobs) {
  const filter = el("select", { "aria-label": "Filter jobs by status" }, ["", "queued", "running", "failed", "cancelled", "succeeded"].map((s) => el("option", { value: s, text: s || "all", selected: state.adminFilter === s })));
  filter.addEventListener("change", () => { state.adminFilter = filter.value; renderAdminRefresh(); });
  return el("section", { class: "card" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", { text: "Jobs" }), el("p", { class: "muted", text: "Cancel stuck jobs and retry failed renders." })), filter),
    el("div", { class: "table-wrap" }, el("table", { class: "table" },
      el("thead", {}, el("tr", {}, ["Course", "Kind", "Status", "Attempt", "Started", "Error", ""].map((h) => el("th", { text: h })))),
      el("tbody", {}, jobs.length ? jobs.map((j) => el("tr", {},
        el("td", { text: j.courseTitle ?? j.courseId }), el("td", { text: j.kind }),
        el("td", {}, el("span", { class: `badge badge-${j.status}`, text: j.status })),
        el("td", { text: `${j.attempt}/${j.maxAttempts}` }), el("td", { text: j.startedAt ? timeAgo(j.startedAt) : "—" }),
        el("td", { class: "err-cell", title: j.error ?? "", text: (j.error ?? "").split("\n")[0].slice(0, 90) }),
        el("td", { class: "row gap" },
          ["queued", "running"].includes(j.status) ? el("button", { class: "btn btn-ghost danger small", type: "button", onclick: async () => { try { await call("POST", `/admin/jobs/${j.id}/cancel`, {}); renderAdminRefresh(); } catch (e) { fail(e); } } }, "Cancel") : null,
          ["failed", "cancelled"].includes(j.status) ? el("button", { class: "btn btn-secondary small", type: "button", onclick: async () => { try { await call("POST", `/admin/jobs/${j.id}/retry`, {}); renderAdminRefresh(); } catch (e) { fail(e); } } }, "Retry") : null,
        ),
      )) : [el("tr", {}, el("td", { colspan: "7", class: "muted", text: "No jobs." }))]),
    )),
  );
}

function adminCourses(courses) {
  return el("section", { class: "card" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", { text: "Courses and storage" }))),
    el("div", { class: "table-wrap" }, el("table", { class: "table" },
      el("thead", {}, el("tr", {}, ["Title", "Owner", "Status", "Video", "Updated", ""].map((h) => el("th", { text: h })))),
      el("tbody", {}, courses.length ? courses.map((c) => el("tr", {},
        el("td", { text: c.title }), el("td", { text: `${c.ownerName} (${c.ownerEmail})` }), el("td", {}, badge(c)),
        el("td", { text: c.videoBytes ? formatBytes(c.videoBytes) : "—" }), el("td", { text: timeAgo(c.updatedAt) }),
        el("td", {}, el("button", { class: "btn btn-ghost danger small", type: "button", onclick: async () => {
          if (!confirm(`Delete "${c.title}" for ${c.ownerEmail} and remove its files from storage?`)) return;
          try { await call("DELETE", `/admin/courses/${c.id}`); renderAdminRefresh(); } catch (e) { fail(e); }
        } }, "Delete")),
      )) : [el("tr", {}, el("td", { colspan: "6", class: "muted", text: "No courses." }))]),
    )),
  );
}

function renderAdminRefresh() { $("admin-root").replaceChildren(); renderAdmin(); }

// ---------- boot ----------

export function setupCloud() {
  $("editor-close").addEventListener("click", closeEditor);
  $("editor").addEventListener("cancel", (e) => { e.preventDefault(); closeEditor(); });
  $("review-close").addEventListener("click", () => $("review-dialog").close());
  loadSession().then(show);
}
