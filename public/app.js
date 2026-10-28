// Doctyn Course Studio — the single dashboard.
// Upload, validate, edit slides / narration / animations, generate, review and watch — all on this page.
// Everything shown comes from the /api/v3 backend; when it (or the rendering engine) is not available the page says so.
import { $, el, formatBytes, formatClock, formatDuration, fullDate, svgPlay, timeAgo, toast } from "./ui.js";

const API = "/api/v3";
/**
 * Every API URL is a single path segment under /api/v3/ (…/route?p=auth/me): that is the only shape the Vercel
 * deployment routes to the API function. The server turns it back into the real route.
 */
function apiUrl(path) {
  const [p, query = ""] = path.replace(/^\/+/, "").split("?");
  return `${API}/route?p=${encodeURIComponent(p)}${query ? `&${query}` : ""}`;
}
const STORE_KEY = "doctyn.course";

const STATUS_LABEL = {
  created: "Needs files", uploaded: "Uploaded", parsing: "Validating…", parsed: "Validated", invalid: "Needs attention",
  queued: "Queued", rendering: "Generating…", complete: "Complete", failed: "Failed",
};
const STATUS_CLASS = { complete: "badge-complete", failed: "badge-failed", invalid: "badge-cancelled", created: "badge-cancelled", parsed: "badge-complete" };
const REVIEW_LABEL = { none: "Not reviewed", pending: "Awaiting medical review", approved: "Medically approved", rejected: "Changes requested" };
const JOB_LABEL = { parse: "Validation", plan: "Animation plan", preview: "Voice preview", build: "Video generation", animate: "Animation render" };
const JOB_ICON = { parse: "✓", plan: "◇", preview: "♪", build: "▶", animate: "▶" };
const JOB_STATUS_LABEL = { queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled" };
const ACTIVE_STATUS = ["parsing", "queued", "rendering"];

const state = {
  user: null,
  meta: null,
  unavailable: null,
  engine: null,
  courses: [],
  currentId: null,
  course: null,
  jobs: [],
  activity: [],
  log: "",
  logJob: null,
  selected: { pptx: null, docx: null },
  uploading: false,
  editor: { open: false, slide: 1, drafts: {}, anim: {} },
  mode: "login",
  timer: 0,
  tickBusy: false,
  adminFilter: "",
};

// ---------- backend calls ----------

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: "same-origin",
      headers: { "X-Requested-With": "doctyn", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    const e = new Error("The Doctyn backend could not be reached. Check your internet connection.");
    e.status = 0;
    throw e;
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const e = new Error(data?.error || `The server answered HTTP ${res.status} for ${path.split("?")[0]}.`);
    e.status = res.status;
    e.problems = data?.problems;
    throw e;
  }
  return data ?? {};
}
const errText = (e) => e?.message || String(e);
const fail = (e) => toast(errText(e), true);

const storageGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const storageSet = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

const courseBusy = (c) => Boolean(c) && ACTIVE_STATUS.includes(c.status);
const jobActive = (j) => Boolean(j) && ["queued", "running"].includes(j.status);
const dirty = () => Object.keys(state.editor.drafts).length > 0 || Object.keys(state.editor.anim).length > 0;
const fileUrl = (c, name, download = false) => apiUrl(`/courses/${c.id}/files/${name}${download ? "?download=1" : ""}`);

// ---------- session and boot ----------

async function loadSession() {
  try {
    const [{ user }, meta] = await Promise.all([call("GET", "/auth/me"), call("GET", "/meta")]);
    state.user = user;
    state.meta = meta;
    state.unavailable = null;
  } catch (e) {
    state.user = null;
    state.unavailable = e.status === 404 || e.status === 0
      ? ["The Doctyn backend is not available at this address.", "Run the dashboard with npm run cloud:dev, or open the deployed site once its backend is configured."]
      : [errText(e), ...(e.problems ?? [])];
  }
}

function renderAccount() {
  const box = $("account");
  box.replaceChildren();
  if (!state.user) return;
  if (state.meta?.localMode) {
    box.append(el("span", { class: "account-name small", title: "No sign-in on this computer", text: "Local mode" }));
    return;
  }
  box.append(
    el("span", { class: "account-name small", title: state.user.email, text: `${state.user.name} · ${state.user.role}` }),
    el("button", { class: "btn btn-ghost small", type: "button", onclick: signOut }, "Sign out"),
  );
}

async function signOut() {
  try { await call("POST", "/auth/logout", {}); } catch { /* already signed out */ }
  location.reload();
}

function showBanner(title, text, cmd) {
  $("banner-title").textContent = title;
  $("banner-text").textContent = text ?? "";
  const pre = $("banner-cmd");
  pre.hidden = !cmd;
  if (cmd) pre.querySelector("code").textContent = cmd;
  $("offline-banner").hidden = false;
}

async function boot() {
  setupStatic();
  await loadSession();
  renderAccount();
  if (state.unavailable) {
    showBanner("The Doctyn backend is not reachable.", state.unavailable.join("\n"));
    $("app-main").hidden = false;
    setPill("offline", "Backend unavailable");
    renderAll();
    return;
  }
  if (!state.user) {
    $("auth-gate").hidden = false;
    $("auth-gate").replaceChildren(authCard());
    setPill("checking", "Sign in to continue");
    return;
  }
  $("auth-gate").hidden = true;
  $("app-main").hidden = false;
  await refreshAll();
  scheduleTick();
}

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
          await call("POST", "/auth/login", { email: email.value, password: pw.value });
          location.reload();
        } else {
          const r = await call("POST", "/auth/register", { email: email.value, name: name.value, password: pw.value });
          state.mode = "login";
          $("auth-gate").replaceChildren(authCard());
          toast(r.message);
        }
      } catch (e) {
        msg.textContent = errText(e);
        msg.className = "notice error";
        msg.hidden = false;
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
      state.meta?.registration === "closed" ? null : el("button", { class: "link-btn", type: "button", onclick: () => { state.mode = login ? "register" : "login"; $("auth-gate").replaceChildren(authCard()); } }, login ? "Create an account" : "I already have an account"),
    ),
  );
  return el("section", { class: "card auth-card" },
    el("div", { class: "card-head" }, el("div", {},
      el("h2", { text: login ? "Sign in" : "Create your account" }),
      el("p", { class: "muted", text: state.meta?.registration === "closed" ? "Access is by invitation. Your videos are private and only shown after you sign in." : "Your presentations, scripts and videos are private to your account." }),
    )),
    form,
    state.meta?.registration === "approval" && !login ? el("p", { class: "muted small", text: "New accounts are approved by an administrator before they can sign in." }) : null,
  );
}

// ---------- loading data ----------

async function loadCourses() {
  const { courses } = await call("GET", "/courses");
  state.courses = courses;
  const stored = storageGet(STORE_KEY);
  if (state.currentId === null && stored !== "new") {
    const pick = courses.find((c) => c.id === stored) ?? courses[0];
    state.currentId = pick?.id ?? null;
  }
  if (state.currentId && !courses.some((c) => c.id === state.currentId)) state.currentId = courses[0]?.id ?? null;
  await loadCurrent();
}

async function loadCurrent() {
  if (!state.currentId) { state.course = null; state.jobs = []; return; }
  const { course, jobs } = await call("GET", `/courses/${state.currentId}`);
  state.course = course;
  state.jobs = jobs;
}

async function loadEngine() {
  try { state.engine = await call("GET", "/engine"); } catch { state.engine = null; }
}

async function loadActivity() {
  try { state.activity = (await call("GET", "/activity")).activity; } catch { state.activity = []; }
}

async function loadLog() {
  const job = state.course?.job;
  if (!job || !$("log-details").open && !jobActive(job)) return;
  try {
    const { job: full } = await call("GET", `/jobs/${job.id}`);
    state.log = full.log ?? "";
    state.logJob = job.id;
  } catch { /* job gone */ }
}

async function refreshAll() {
  try {
    await loadCourses();
  } catch (e) {
    if (e.status === 401) { location.reload(); return; }
    fail(e);
  }
  await Promise.all([loadEngine(), loadActivity()]);
  await loadLog();
  renderAll();
}

// ---------- polling ----------

function scheduleTick() {
  clearTimeout(state.timer);
  const fast = courseBusy(state.course) || state.courses.some((c) => courseBusy(c));
  state.timer = setTimeout(tick, fast ? 2500 : 10000);
}

async function tick() {
  if (!document.hidden && !state.tickBusy && !state.uploading) {
    state.tickBusy = true;
    try {
      const before = state.course?.updatedAt;
      await loadCourses();
      await Promise.all([loadEngine(), loadActivity()]);
      await loadLog();
      renderAll({ editorRefresh: before !== state.course?.updatedAt });
    } catch (e) {
      if (e.status === 401) { location.reload(); return; }
    } finally {
      state.tickBusy = false;
    }
  }
  scheduleTick();
}

// ---------- rendering everything ----------

function renderAll(opts = {}) {
  renderPill();
  renderCoursePicker();
  renderFiles();
  renderProduce();
  renderProgress();
  renderPreviews();
  renderActivity();
  renderVideos();
  renderRoleAreas();
  if (state.editor.open && (opts.editorRefresh || opts.force) && !dirty() && !editorHasFocus()) renderEditor();
  else if (state.editor.open) renderEditorChrome();
}

function setPill(stateName, text) {
  $("status-pill").dataset.state = stateName;
  $("status-text").textContent = text;
}

function renderPill() {
  // Library mode: a private video library without a rendering engine (nothing to render here).
  if (state.meta?.libraryMode) {
    setPill("online", "Video library");
    showBanner("Video library mode.", "This site shows videos that are already stored privately. Uploading, editing and rendering need the rendering engine, a database and storage, which are not enabled here yet.");
    return;
  }
  const e = state.engine;
  if (!e) return setPill("offline", "Engine status unknown");
  if (e.online) {
    setPill(e.busy ? "busy" : "online", `Engine online${e.tts ? ` · voice ${e.tts}` : ""}${e.busy ? " · rendering" : ""}`);
    $("offline-banner").hidden = true;
  } else {
    setPill("offline", "Engine offline");
    if (state.meta?.localMode) {
      showBanner("The rendering engine is not running.", "Jobs wait in the queue. In local mode the engine starts together with the dashboard; check the terminal where you ran npm run cloud:dev for errors, then retry.");
    } else {
      showBanner("The Windows rendering engine is offline.", "You can still upload and edit. Jobs wait in the queue and start automatically when the engine is running on the Windows PC. To start it, run in Git Bash:", "bash scripts/start-engine.sh");
    }
  }
}

function renderCoursePicker() {
  const sel = $("course-select");
  const want = state.currentId ?? "__new__";
  sel.replaceChildren(
    ...state.courses.map((c) => el("option", { value: c.id, text: `${c.title} · ${STATUS_LABEL[c.status] ?? c.status}` })),
    el("option", { value: "__new__", text: "＋ New course" }),
  );
  sel.value = want;
}

// ---------- 1. course files ----------

function renderFiles() {
  const c = state.course;
  const isNew = !c;
  const busy = courseBusy(c);
  const titleInput = $("course-title");
  if (document.activeElement !== titleInput) titleInput.value = isNew ? titleInput.value : c.title;
  titleInput.disabled = busy;
  $("files-title").lastChild.textContent = isNew ? "New course files" : "Course files";

  const chips = [];
  if (c) {
    for (const [type, name] of [["PPTX", c.files.pptx], ["DOCX", c.files.docx]]) {
      chips.push(el("span", { class: "chip", title: name ?? "" }, el("span", { class: "chip-label", text: type }), name ? el("span", { text: name }) : el("span", { class: "muted", text: "none" })));
    }
    chips.push(el("span", { class: `badge ${STATUS_CLASS[c.status] ?? ""}`, text: STATUS_LABEL[c.status] ?? c.status }));
    if (c.slideCount) chips.push(el("span", { class: "chip" }, el("span", { class: "chip-label", text: "SLIDES" }), el("span", { text: String(c.slideCount) })));
  } else {
    chips.push(el("span", { class: "muted", text: "Add a presentation and a script to begin." }));
  }
  $("current-inputs").replaceChildren(...chips);

  const edit = $("edit-btn");
  edit.hidden = !(c && c.slides?.length);
  edit.textContent = state.editor.open ? "Hide editor" : "Edit Course";

  const up = $("upload-btn");
  const { pptx, docx } = state.selected;
  up.textContent = isNew ? "Upload files" : "Replace files";
  up.disabled = state.uploading || busy || (isNew ? !(pptx && docx) : !(pptx || docx));
  if (state.meta?.libraryMode) {
    up.disabled = true;
    const n = $("upload-notice");
    if (!state.uploading) {
      n.textContent = "Uploading is not enabled on this site yet (video library mode). Your private videos are listed under Generated Videos.";
      n.hidden = false;
    }
  }

  // validation box
  const box = $("validation-box");
  box.className = "notice";
  box.hidden = true;
  if (c) {
    const v = c.validation;
    if (c.status === "parsing") {
      box.hidden = false;
      box.textContent = state.engine && !state.engine.online
        ? "Files uploaded. Validation will start when the rendering engine is online."
        : "Reading your presentation and script…";
    } else if (c.status === "invalid") {
      box.hidden = false;
      box.className = "notice error";
      box.textContent = [
        c.error,
        v?.missing?.length ? `Missing narration: slide ${v.missing.join(", ")}.` : "",
        v?.duplicates?.length ? `Duplicate sections: ${v.duplicates.map((d) => d.number).join(", ")}.` : "",
        v?.malformed?.length ? `Unreadable headings: ${v.malformed.map((m) => `"${m.text}"`).join(", ")}.` : "",
        "Open Edit Course to type the missing narration, or upload a corrected script.",
      ].filter(Boolean).join("\n");
    } else if (c.slides?.length) {
      box.hidden = false;
      box.className = "notice success";
      box.textContent = `Validated: ${c.slideCount} slides and ${c.slideCount} narration sections match.${v?.warnings?.length ? `\n${v.warnings.join("\n")}` : ""}`;
    }
  }
}

function setSelected(type, file) {
  state.selected[type] = file;
  const zone = $(`drop-${type}`);
  zone.classList.toggle("has-file", Boolean(file));
  zone.querySelector("[data-role=selected]").textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "";
  if (type === "pptx" && file && !state.currentId && !$("course-title").value.trim()) {
    $("course-title").value = file.name.replace(/\.pptx$/i, "").replace(/[_-]+/g, " ").replace(/\s*\(\d+\)\s*$/, "").trim();
  }
  renderFiles();
}

function setupDropzones() {
  for (const type of ["pptx", "docx"]) {
    const zone = $(`drop-${type}`);
    const input = zone.querySelector("input");
    const ext = `.${type}`;
    const pick = (f) => {
      if (f && !f.name.toLowerCase().endsWith(ext)) { toast(`"${f.name}" is not a ${ext} file.`, true); return; }
      setSelected(type, f ?? null);
    };
    input.addEventListener("change", () => pick(input.files[0] ?? null));
    for (const t of ["dragenter", "dragover"]) zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("drag"); });
    for (const t of ["dragleave", "drop"]) zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove("drag"); });
    zone.addEventListener("drop", (e) => pick(e.dataTransfer.files[0] ?? null));
  }
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

async function uploadSelected() {
  const notice = $("upload-notice");
  notice.hidden = true;
  if (state.unavailable) {
    notice.textContent = `Cannot upload: ${state.unavailable[0]}`;
    notice.className = "notice error";
    notice.hidden = false;
    return;
  }
  const types = ["pptx", "docx"].filter((t) => state.selected[t]);
  if (!types.length) return;
  state.uploading = true;
  renderFiles();
  const progress = $("upload-progress");
  progress.hidden = false;
  const report = (pct, text) => { $("upload-bar").style.width = `${pct}%`; $("upload-text").textContent = text; };
  try {
    let id = state.currentId;
    if (!id) {
      const title = $("course-title").value.trim() || state.selected.pptx.name.replace(/\.pptx$/i, "");
      id = (await call("POST", "/courses", { title })).course.id;
    }
    for (const [i, type] of types.entries()) {
      const file = state.selected[type];
      const up = await call("POST", `/courses/${id}/upload-url`, { type, filename: file.name, size: file.size });
      await putFile(up.url, up.headers, file, (f) => report(Math.round(((i + f) / types.length) * 100), `Uploading ${file.name}… ${Math.round(f * 100)}%`));
      await call("POST", `/courses/${id}/files/complete`, { type, key: up.key, filename: file.name });
    }
    report(100, "Upload complete.");
    state.currentId = id;
    storageSet(STORE_KEY, id);
    state.selected = { pptx: null, docx: null };
    for (const t of ["pptx", "docx"]) { setSelected(t, null); $(`drop-${t}`).querySelector("input").value = ""; }
    state.editor = { open: false, slide: 1, drafts: {}, anim: {} };
    await loadEngine();
    notice.textContent = state.engine && !state.engine.online
      ? "Files uploaded. The rendering engine is offline, so validation will begin as soon as it is running."
      : "Files uploaded. Validating…";
    notice.className = "notice success";
    notice.hidden = false;
    await refreshAll();
    scheduleTick();
  } catch (e) {
    notice.textContent = errText(e);
    notice.className = "notice error";
    notice.hidden = false;
  } finally {
    state.uploading = false;
    setTimeout(() => (progress.hidden = true), 1200);
    renderFiles();
  }
}

// ---------- 2. produce ----------

function renderProduce() {
  const c = state.course;
  const busyNow = courseBusy(c) || jobActive(c?.job);
  const ready = c && c.slides?.length && c.validation?.ok !== false && ["parsed", "complete", "failed"].includes(c.status);

  $("preview-btn").disabled = !(c && c.slides?.length) || busyNow;
  const gen = $("generate-btn");
  gen.disabled = !ready || busyNow;
  gen.textContent = c?.hasVideo ? "Regenerate Video" : "Generate Video";
  $("generate-desc").textContent = c?.stale
    ? "Your saved edits are newer than the last video. Generating uses the latest saved edits only; narration for unchanged slides is reused."
    : "Uses your latest saved edits: slide images, voiceover, topic-specific medical animations, captions, transcript and the enhanced MP4. Can take a long time for large decks.";

  const r = c?.review;
  const approvedNow = Boolean(r && r.status === "approved" && r.matchesCurrentContent);
  $("review-btn").disabled = !c || !c.slides?.length || busyNow || r.status === "pending" || approvedNow;
  $("review-btn").textContent = r?.status === "pending" ? "Review requested" : approvedNow ? "Approved" : "Request review";
  const fin = $("render-final-btn");
  fin.hidden = !(approvedNow && c.status === "complete" && !c.stale && c.animatedDraft !== false);
  fin.disabled = busyNow;
  const pub = $("publish-btn");
  pub.textContent = c?.publishedAt ? "Unpublish" : "Publish";
  pub.disabled = !c || busyNow || (c.publishedAt ? false : !(approvedNow && c.status === "complete" && !c.stale));
  $("review-desc").textContent = !c
    ? "AI-assisted medical content must be approved by a medical reviewer before the final version is published."
    : c.publishedAt ? "Published: the clinically approved version is final."
    : approvedNow ? `Approved${r.at ? ` ${fullDate(r.at)}` : ""}${r.notes ? ` — ${r.notes}` : ""}. ${c.animatedDraft === false ? "Publish when ready." : "Render the approved video to remove the draft watermark, then publish."}`
    : r.status === "pending" ? "Waiting for a medical reviewer. Any edit you make reopens the review."
    : r.status === "rejected" ? `Changes requested${r.notes ? `: ${r.notes}` : ""}. Edit, then request review again.`
    : "AI-assisted medical content must be approved by a medical reviewer before the final version is published.";
}

async function startGenerate() {
  const c = state.course;
  if (!c) return;
  if (dirty()) {
    if (!confirm("You have unsaved edits. Save them and generate the video from the saved version?")) return;
    if (!(await saveEdits())) return;
  }
  try {
    await call("POST", `/courses/${c.id}/build`, { animate: true });
    toast("Video generation queued.");
    await refreshAll();
    scheduleTick();
  } catch (e) { fail(e); }
}

async function startPreview() {
  const c = state.course;
  if (!c) return;
  if (dirty() && !confirm("Voice previews use your saved narration. Save your edits first?")) return;
  if (dirty() && !(await saveEdits())) return;
  try {
    await call("POST", `/courses/${c.id}/preview`, { slides: $("preview-slides").value || "1-3" });
    toast("Voice preview queued.");
    await refreshAll();
    scheduleTick();
  } catch (e) { fail(e); }
}

async function reviewAction() {
  const c = state.course;
  try { await call("POST", `/courses/${c.id}/review/request`, {}); toast("Sent to the medical reviewers."); await refreshAll(); } catch (e) { fail(e); }
}
async function renderFinal() {
  const c = state.course;
  try { await call("POST", `/courses/${c.id}/animate`, {}); toast("Rendering the approved video."); await refreshAll(); scheduleTick(); } catch (e) { fail(e); }
}
async function publishAction() {
  const c = state.course;
  try { await call("POST", `/courses/${c.id}/${c.publishedAt ? "unpublish" : "publish"}`, {}); toast(c.publishedAt ? "Unpublished." : "Published."); await refreshAll(); } catch (e) { fail(e); }
}

// ---------- build progress ----------

function renderProgress() {
  const job = state.course?.job;
  const empty = $("job-empty");
  const panel = $("job-panel");
  const cancel = $("cancel-btn");
  const retry = $("retry-btn");
  if (!job) {
    empty.hidden = false;
    panel.hidden = true;
    cancel.hidden = true;
    retry.hidden = true;
    $("job-subtitle").textContent = "No job running.";
    return;
  }
  empty.hidden = true;
  panel.hidden = false;
  const active = jobActive(job);
  const p = job.progress ?? {};
  const pct = job.status === "succeeded" ? 100 : Math.round(p.percent ?? 0);
  const offline = state.engine && !state.engine.online;

  $("job-subtitle").textContent = `${JOB_LABEL[job.kind] ?? job.kind} · ${state.course.title}${job.startedAt ? ` · started ${fullDate(job.startedAt)}` : ""}` +
    (job.finishedAt && job.startedAt ? ` · took ${formatDuration((new Date(job.finishedAt) - new Date(job.startedAt)) / 1000)}` : "");
  const badge = $("job-badge");
  badge.className = `job-badge badge-${job.status}`;
  badge.textContent = job.status === "running" ? `${pct}%` : JOB_STATUS_LABEL[job.status] ?? job.status;
  $("job-detail").textContent = job.status === "queued"
    ? (offline ? "Waiting for the rendering engine to come online…" : "Waiting for the engine…")
    : active ? p.detail || "Working…" : job.status === "succeeded" ? "Finished" : job.status === "cancelled" ? "Stopped" : "Stopped with an error";
  $("job-eta").textContent = active && job.attempt > 1 ? `attempt ${job.attempt}/${job.maxAttempts}` : "";
  $("job-bar").style.width = `${pct}%`;
  const wrap = $("job-bar-wrap");
  wrap.setAttribute("aria-valuenow", String(pct));
  wrap.classList.toggle("failed", job.status === "failed");
  wrap.classList.toggle("succeeded", job.status === "succeeded");

  const stages = $("stages");
  const list = p.stages ?? [];
  stages.hidden = !list.length;
  stages.replaceChildren(...list.map((s) => el("li", { "data-status": s.status, title: s.detail || s.label }, s.label, s.status === "reused" ? el("span", { class: "reused-tag", text: "· reused" }) : null)));

  const result = $("job-result");
  if (active) result.hidden = true;
  else {
    const text = job.status === "succeeded"
      ? (state.course.error ? state.course.error : "Done.")
      : job.error || "The job did not finish.";
    result.className = `result ${job.status === "succeeded" && !state.course.error ? "success" : "error"}`;
    result.textContent = text;
    result.hidden = false;
  }
  cancel.hidden = !active;
  cancel.disabled = job.cancelRequested;
  cancel.textContent = job.cancelRequested ? "Cancelling…" : "Cancel";
  retry.hidden = !["failed", "cancelled"].includes(job.status);

  const lines = (state.logJob === job.id ? state.log : "").split("\n").filter(Boolean);
  $("log-count").textContent = lines.length ? `(${lines.length} lines)` : "";
  const pre = $("log");
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  pre.textContent = lines.slice(-300).join("\n");
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

async function cancelJob() {
  const job = state.course?.job;
  if (!jobActive(job)) return;
  if (!confirm(`Cancel the ${(JOB_LABEL[job.kind] ?? "job").toLowerCase()}? Finished slides are kept and reused next time.`)) return;
  try { await call("POST", `/jobs/${job.id}/cancel`, {}); await refreshAll(); } catch (e) { fail(e); }
}
async function retryJob() {
  const job = state.course?.job;
  try { await call("POST", `/jobs/${job.id}/retry`, {}); toast("Job queued again."); await refreshAll(); scheduleTick(); } catch (e) { fail(e); }
}

// ---------- side column ----------

function renderPreviews() {
  const box = $("previews");
  const c = state.course;
  const items = c ? Object.entries(c.previews ?? {}).sort((a, b) => Number(a[0]) - Number(b[0])) : [];
  if (!items.length) {
    box.replaceChildren(el("div", { class: "empty small" }, el("p", { text: c ? "No previews yet. Use “Preview voice” to hear sample slides." : "Select a course to hear voice previews." })));
    return;
  }
  const existing = new Map([...box.querySelectorAll("[data-clip]")].map((n) => [n.dataset.clip, n]));
  const keep = [];
  for (const [n, p] of items) {
    const key = `${c.id}:${n}:${p.at}`;
    let node = existing.get(key);
    if (!node) {
      const slide = c.slides.find((s) => s.slide === Number(n));
      node = el("div", { class: "clip", "data-clip": key },
        el("span", { class: "clip-title" }, `Slide ${n}${slide ? ` · ${slide.title}` : ""} `, p.stale ? el("span", { class: "badge badge-cancelled", text: "narration changed since" }) : null),
        el("audio", { controls: true, preload: "none", src: apiUrl(`/courses/${c.id}/previews/${n}?v=${encodeURIComponent(p.at)}`) }),
      );
    }
    keep.push(node);
  }
  box.replaceChildren(el("div", { class: "preview-set" }, el("div", { class: "preview-head" }, el("strong", { text: "Saved narration" }), state.engine?.tts ? ` · voice ${state.engine.tts}` : ""), ...keep));
}

function renderActivity() {
  const list = $("activity");
  if (!state.activity.length) {
    list.replaceChildren(el("li", { class: "empty small" }, el("p", { text: "Your uploads and jobs appear here." })));
    return;
  }
  list.replaceChildren(...state.activity.slice(0, 12).map((j) => {
    const took = j.finishedAt && j.startedAt ? ` · ${formatDuration((new Date(j.finishedAt) - new Date(j.startedAt)) / 1000)}` : "";
    const first = (j.status === "failed" ? j.error ?? "" : "").split("\n")[0];
    return el("li", {},
      el("span", { class: `act-icon ${j.status === "succeeded" ? "succeeded" : j.status}`, "aria-hidden": "true", text: JOB_ICON[j.kind] ?? "•" }),
      el("div", {},
        el("div", { class: "act-title" }, `${JOB_LABEL[j.kind] ?? j.kind} `, el("span", { class: `badge badge-${j.status}`, text: j.status === "running" ? `${Math.round(j.progress?.percent ?? 0)}%` : JOB_STATUS_LABEL[j.status] ?? j.status })),
        el("div", { class: "act-meta", title: fullDate(j.createdAt), text: `${j.courseTitle ?? ""} · ${timeAgo(j.startedAt ?? j.createdAt)}${took}${first ? ` · ${first}` : ""}` })),
    );
  }));
}

// ---------- generated videos ----------

/** Versions a course has. Order of preference when playing: approved final, enhanced draft, original. */
function versionsOf(c) {
  const list = [];
  if (c.available.animated) {
    if (c.animatedDraft === false) list.push({ key: "approved", file: "animated", label: "Clinically approved animated final", short: "Approved animated final", cls: "badge-complete" });
    else list.push({ key: "draft", file: "animated", label: "Enhanced animated draft", short: "Enhanced animated draft", cls: "badge-cancelled" });
  }
  if (c.available.video) list.push({ key: "original", file: "video", label: "Original narrated slides", short: c.available.animated ? "Original narrated slides (optional)" : "Original narrated slides", cls: "" });
  return list;
}

/** "7 of 9 slides have topic-specific animation; slides 1 use generic cards" for a course whose animation was planned. */
function animationSummary(c) {
  const a = c.animation;
  if (!a || !a.slideCount) return null;
  const generic = a.genericSlides ?? [];
  const text = generic.length
    ? `Animation: ${a.slideCount - generic.length} of ${a.slideCount} slides have a topic-specific scene; generic key-point cards on slide${generic.length > 1 ? "s" : ""} ${generic.join(", ")}.`
    : `Animation: all ${a.slideCount} slides have a topic-specific scene.`;
  return el("div", { class: "video-meta anim-summary" }, el("span", { class: generic.length ? "generic-note" : "", text }));
}

function videoCard(c) {
  const versions = versionsOf(c);
  const best = versions[0];
  const busy = courseBusy(c);
  const statusText = busy ? STATUS_LABEL[c.status] : c.publishedAt ? "Published" : best?.key === "approved" ? "Approved" : c.animatedDraft ? "Draft" : c.available.video ? "Original only" : STATUS_LABEL[c.status];
  const statusClass = busy ? "" : c.publishedAt || best?.key === "approved" ? "badge-complete" : c.status === "failed" ? "badge-failed" : "badge-cancelled";
  const playable = Boolean(best);

  const thumb = el("button", { class: "thumb", type: "button", disabled: !playable, "aria-label": playable ? `Play ${c.title}` : `${c.title} has no video yet`, onclick: () => openPlayer(c) },
    c.available.thumbnail ? el("img", { src: fileUrl(c, "thumbnail"), alt: "", loading: "lazy", width: "1280", height: "720" }) : el("span", { class: "noimg", text: busy ? "Generating…" : "No thumbnail yet" }),
    playable ? el("span", { class: "play", "aria-hidden": "true" }, svgPlay()) : null,
    c.durationSeconds ? el("span", { class: "duration", text: formatClock(c.durationSeconds) }) : null,
  );
  const meta = [c.slideCount && `${c.slideCount} slides`, c.durationSeconds && formatDuration(c.durationSeconds), c.videoBytes && formatBytes(c.videoBytes), c.completedAt && `built ${timeAgo(c.completedAt)}`].filter(Boolean);
  const pct = Math.round(c.job?.progress?.percent ?? 0);

  const dl = [];
  if (best) dl.push(el("a", { class: "btn btn-ghost small", href: fileUrl(c, best.file, true), title: `Download ${best.label}` }, "↓ Download MP4"));
  if (best && best.key !== "original" && c.available.video) dl.push(el("a", { class: "btn btn-ghost small", href: fileUrl(c, "video", true), title: "Download the optional original narrated-slides MP4" }, "↓ Original narrated MP4"));
  for (const [k, label] of [["vtt", "VTT"], ["srt", "SRT"], ["transcript", "Transcript"]]) {
    if (c.available[k]) dl.push(el("a", { class: "btn btn-ghost small", href: fileUrl(c, k, true), title: `Download ${label}` }, `↓ ${label}`));
  }

  return el("article", { class: "video-card", "data-course": c.id },
    thumb,
    el("div", { class: "video-body" },
      el("div", { class: "row between gap" }, el("h3", { class: "video-title", text: c.title }), el("span", { class: `badge ${statusClass}`, text: statusText })),
      el("div", { class: "video-meta" }, meta.map((m) => el("span", { text: m }))),
      el("div", { class: "version-chips" }, versions.length ? versions.map((v) => el("span", { class: `badge ${v.cls}`, text: v.short })) : el("span", { class: "muted small", text: busy ? "Rendering…" : "No video yet" })),
      animationSummary(c),
      busy && c.job ? el("div", { class: "job-mini" }, el("div", { class: "bar" }, el("span", { style: `width:${pct}%` })), el("span", { class: "small muted", text: c.job.progress?.detail ?? "Working…" })) : null,
      c.stale ? el("div", { class: "video-meta" }, el("span", { text: "Edited since this video was made — regenerate to include the edits." })) : null,
    ),
    el("div", { class: "video-actions" },
      el("button", { class: "btn btn-primary small", type: "button", disabled: !playable, onclick: () => openPlayer(c) }, "Play"),
      dl,
      c.libraryOnly ? null : el("button", { class: "btn btn-secondary small", type: "button", onclick: () => editAgain(c.id) }, "Edit Again"),
    ),
  );
}

function renderVideos() {
  const list = state.courses.filter((c) => c.hasVideo || courseBusy(c) && c.slideCount);
  $("videos").replaceChildren(...(list.length ? list.map(videoCard) : [el("div", { class: "empty" }, el("p", { text: "Your finished videos will appear here." }))]));
}

async function editAgain(id) {
  if (dirty() && state.currentId !== id && !confirm("You have unsaved edits to another course. Discard them?")) return;
  if (state.currentId !== id) {
    state.editor = { open: false, slide: 1, drafts: {}, anim: {} };
    state.currentId = id;
    storageSet(STORE_KEY, id);
    await refreshAll();
  }
  openEditor();
  $("editor-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- player (same dashboard, modal over the page)

function openPlayer(c, key) {
  const versions = versionsOf(c);
  const v = versions.find((x) => x.key === key) ?? versions[0];
  if (!v) return;
  const video = $("player-video");
  video.replaceChildren();
  video.removeAttribute("crossorigin"); // same-origin API that redirects to a signed storage URL
  video.src = fileUrl(c, v.file);
  if (c.available.thumbnail) video.poster = fileUrl(c, "thumbnail"); else video.removeAttribute("poster");
  if (c.available.vtt) video.append(el("track", { kind: "captions", label: "English", srclang: "en", src: fileUrl(c, "vtt"), default: true }));
  $("player-title").textContent = `${c.title} — ${v.label}`;
  $("player-meta").textContent = [c.slideCount && `${c.slideCount} slides`, c.durationSeconds && formatDuration(c.durationSeconds), v.key === "draft" && "DRAFT: not clinically approved — private to your account", v.key === "approved" && "reviewed and approved by a medical reviewer"]
    .filter(Boolean).join(" · ");
  $("player-versions").replaceChildren(...versions.map((x) => el("button", { class: `tab${x.key === v.key ? " active" : ""}`, type: "button", "aria-selected": String(x.key === v.key), onclick: () => openPlayer(c, x.key) }, x.label)));
  const links = [el("a", { class: "btn btn-ghost small", href: fileUrl(c, v.file, true) }, "↓ Download MP4")];
  for (const [k, label] of [["vtt", "VTT"], ["srt", "SRT"], ["transcript", "Transcript"]]) if (c.available[k]) links.push(el("a", { class: "btn btn-ghost small", href: fileUrl(c, k, true) }, `↓ ${label}`));
  $("player-downloads").replaceChildren(...links);
  if (!$("player").open) $("player").showModal();
}

function closePlayer() {
  const video = $("player-video");
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("player").close();
}

// ---------- editor (inside the dashboard) ----------

function openEditor() {
  if (!state.course?.slides?.length) return;
  state.editor.open = true;
  $("editor-card").hidden = false;
  if (!state.course.slides.some((s) => s.slide === state.editor.slide)) state.editor.slide = state.course.slides[0].slide;
  renderEditor();
  renderFiles();
}
function closeEditor() {
  if (dirty() && !confirm("Close the editor and discard unsaved edits?")) return;
  state.editor = { open: false, slide: 1, drafts: {}, anim: {} };
  $("editor-card").hidden = true;
  renderFiles();
}
const editorHasFocus = () => $("editor-card").contains(document.activeElement) && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName);

function slideDraft(n) { return (state.editor.drafts[n] ??= {}); }
function animDraft(n) { return (state.editor.anim[n] ??= {}); }

function renderEditorChrome() {
  const d = dirty();
  $("editor-dirty").textContent = d ? "Unsaved changes" : "";
  $("editor-save").disabled = !d || courseBusy(state.course);
}

function renderEditor() {
  const c = state.course;
  if (!c) return;
  renderEditorChrome();
  const busy = courseBusy(c);
  const list = $("slide-list");
  list.replaceChildren(...c.slides.map((s) => {
    const saved = c.animationEdits?.[String(s.slide)];
    const edited = state.editor.drafts[s.slide] || state.editor.anim[s.slide];
    return el("li", {},
      el("button", { type: "button", class: `slide-item${s.slide === state.editor.slide ? " selected" : ""}${!s.narration.trim() ? " missing" : ""}`, onclick: () => { state.editor.slide = s.slide; renderEditor(); } },
        el("span", { class: "slide-no", text: String(s.slide) }),
        el("span", { class: "slide-name", text: state.editor.drafts[s.slide]?.title ?? s.title }),
        effective(c, s.slide)?.template === "key-points" ? el("span", { class: "badge badge-cancelled generic-badge", title: "Generic key-point cards: no clinical structure was recognised. Pick a better animation type.", text: "generic" }) : null,
        edited ? el("span", { class: "dot-edit", title: "Unsaved edit" }) : saved ? el("span", { class: "dot-saved", title: "Saved animation edit" }) : null,
      ));
  }));
  const pane = $("slide-pane");
  pane.replaceChildren(animationOverview(c), slidePane(c, busy));
}

/** Thumbnails of every slide's animated scene (the same renderer as the MP4), drawn when the panel is opened. */
function animationOverview(c) {
  const plan = c.animationPlan;
  if (!plan?.length) return el("span");
  const generic = plan.filter((p) => (effective(c, p.slide)?.template ?? p.template) === "key-points").length;
  const box = el("details", { class: "anim-overview" },
    el("summary", { text: `Animation overview — ${plan.length - generic} of ${plan.length} slides topic-specific${generic ? `, ${generic} generic` : ""}` }));
  box.addEventListener("toggle", () => {
    if (!box.open || box.dataset.drawn || !window.DoctynScene) return;
    box.dataset.drawn = "1";
    const grid = el("div", { class: "anim-overview-grid" });
    for (const p of plan) {
      const eff = effective(c, p.slide) ?? { template: p.template, slideText: p.slideText, popups: p.popups, events: p.events };
      const cell = el("button", { type: "button", class: "anim-thumb", onclick: () => { state.editor.slide = p.slide; renderEditor(); } });
      try {
        const svg = window.DoctynScene.renderFrame({ ...p, slideText: eff.slideText, events: eff.events, popups: [], labels: { ...(p.labels ?? {}), ...(c.animationEdits?.[String(p.slide)]?.labels ?? {}) } }, p.durationSeconds * 0.85, { captions: false });
        cell.append(document.importNode(new DOMParser().parseFromString(svg, "image/svg+xml").documentElement, true));
      } catch { cell.append(el("span", { class: "muted small", text: "no preview" })); }
      const isGeneric = eff.template === "key-points";
      cell.append(el("span", { class: "anim-thumb-cap" }, `${p.slide} · ${eff.template}`, isGeneric ? el("span", { class: "badge badge-cancelled generic-badge", text: "generic" }) : null));
      grid.append(cell);
    }
    box.append(grid);
  });
  return box;
}

function slidePane(c, busy) {
  const n = state.editor.slide;
  const s = c.slides.find((x) => x.slide === n);
  if (!s) return el("div", { class: "empty", text: "Select a slide." });
  const d = state.editor.drafts[n] ?? {};
  const narration = d.narration ?? s.narration;
  const parts = [];

  // preview
  const img = c.slidePreviews
    ? el("img", { class: "slide-img", src: apiUrl(`/courses/${c.id}/slides/${n}/image`), alt: `Slide ${n} preview`, loading: "lazy", width: "960", height: "540" })
    : el("div", { class: "slide-img placeholder" }, el("span", { text: "Slide preview is not available yet. It is rendered by the engine when the course is validated." }));
  parts.push(el("div", { class: "preview-row" },
    img,
    el("div", { class: "slide-text" }, el("h4", { text: `Slide ${n} of ${c.slides.length} — text on the slide` }),
      s.pptxText?.length ? el("ul", {}, s.pptxText.slice(0, 14).map((t) => el("li", { text: t }))) : el("p", { class: "muted small", text: "No text found on this slide." }),
      el("p", { class: "muted small", text: "Your original PPTX is never changed. Overlay text and pop-ups below are added to the animated version." })),
  ));

  // title + narration
  const title = el("input", { type: "text", maxlength: "300", value: d.title ?? s.title, disabled: busy, "aria-label": `Slide ${n} title` });
  title.addEventListener("input", () => { slideDraft(n).title = title.value; renderEditorChrome(); markListEdited(); });
  const text = el("textarea", { rows: "9", maxlength: "20000", disabled: busy, "aria-label": `Slide ${n} narration`, placeholder: "Narration for this slide…" });
  text.value = narration;
  const count = el("span", { class: "small muted" });
  const upd = () => { const w = text.value.split(/\s+/).filter(Boolean).length; count.textContent = `${w} words · about ${formatDuration(w / 2.6)} spoken`; };
  upd();
  text.addEventListener("input", () => { slideDraft(n).narration = text.value; upd(); renderEditorChrome(); markListEdited(); });
  parts.push(el("div", { class: "stack" },
    el("label", { class: "field" }, "Slide title", title),
    el("label", { class: "field" }, el("span", { class: "row between" }, "Voiceover narration", count), text),
    voiceRow(c, s, busy),
  ));

  parts.push(animationBlock(c, s, busy));
  return el("div", { class: "stack" }, parts);
}

function markListEdited() {
  const items = $("slide-list").querySelectorAll(".slide-item");
  const idx = state.course.slides.findIndex((s) => s.slide === state.editor.slide);
  const btn = items[idx];
  if (btn && !btn.querySelector(".dot-edit")) btn.append(el("span", { class: "dot-edit", title: "Unsaved edit" }));
}

function voiceRow(c, s, busy) {
  const n = s.slide;
  const p = c.previews?.[String(n)];
  const edited = state.editor.drafts[n]?.narration !== undefined;
  const row = el("div", { class: "voice-row" },
    el("button", { class: "btn btn-secondary small", type: "button", disabled: busy || edited || jobActive(c.job), title: edited ? "Save your edit first — previews use the saved narration" : "", onclick: async () => {
      try { await call("POST", `/courses/${c.id}/preview`, { slides: String(n) }); toast(`Voice preview for slide ${n} queued.`); await refreshAll(); scheduleTick(); } catch (e) { fail(e); }
    } }, "Preview this slide's voice"),
  );
  if (edited) row.append(el("span", { class: "small muted", text: "Save to hear the edited narration." }));
  else if (p) row.append(el("audio", { controls: true, preload: "none", src: apiUrl(`/courses/${c.id}/previews/${n}?v=${encodeURIComponent(p.at)}`) }), p.stale ? el("span", { class: "badge badge-cancelled", text: "older narration" }) : el("span", { class: "badge badge-complete", text: "current" }));
  return row;
}

/** Effective animation values: unsaved draft > saved edit > current plan. */
function effective(c, n) {
  const plan = c.animationPlan?.find((p) => p.slide === n);
  const saved = c.animationEdits?.[String(n)] ?? {};
  const d = state.editor.anim[n] ?? {};
  if (!plan) return null;
  return {
    plan,
    template: d.template ?? saved.template ?? plan.template,
    slideText: d.slideText ?? saved.slideText ?? plan.slideText,
    popups: d.popups ?? saved.popups ?? plan.popups,
    events: d.events ?? saved.events ?? plan.events,
  };
}

function animationBlock(c, s, busy) {
  const n = s.slide;
  const box = el("section", { class: "anim-block" }, el("h4", { text: "Medical animation" }));
  const eff = effective(c, n);
  if (!eff) {
    box.append(
      el("p", { class: "muted small", text: c.animation ? "The animation plan is out of date for this slide." : "The animation plan for this course is not ready yet." }),
      el("button", { class: "btn btn-secondary small", type: "button", disabled: busy || jobActive(c.job) || c.validation?.ok === false, onclick: refreshPlan }, "Prepare animations"),
    );
    return box;
  }
  const { plan } = eff;
  const narr = state.editor.drafts[n]?.narration ?? s.narration;
  if (narr.trim() !== plan.narration.trim()) {
    box.append(el("div", { class: "notice" }, "The narration changed after this animation was planned. Save, then refresh the plan so cues and timings follow the new words. ",
      el("button", { class: "link-btn", type: "button", disabled: dirty() || busy || jobActive(c.job), onclick: refreshPlan }, "Refresh animation plan")));
  }
  const tmpl = el("select", { disabled: busy, "aria-label": `Slide ${n} animation type` },
    (state.meta?.animationTemplates ?? [plan.template]).map((t) => el("option", { value: t, text: t, selected: eff.template === t })));
  tmpl.addEventListener("change", () => { animDraft(n).template = tmpl.value; renderEditorChrome(); markListEdited(); });
  box.append(
    el("p", { class: "muted small", text: plan.rationale }),
    plan.analysis ? el("p", { class: "small", text: `${plan.analysis.category.replace(/-/g, " ")} · ${plan.analysis.topic}${plan.analysis.objective ? ` — ${plan.analysis.objective}` : ""}` }) : null,
    plan.items?.length ? el("div", { class: "notice", text: "The on-screen labels of this scene were selected automatically from this slide's own text and narration. Check each label against the source, change the animation type if another fits better, and save before generating the video." }) : null,
    plan.template === "key-points" ? el("div", { class: "notice", text: "This slide uses the generic key-points layout because no topic-specific clinical scene fits it. Pick another type if one fits better." }) : null,
    el("label", { class: "field" }, "Animation type", tmpl),
  );

  // live preview: the same renderer that draws the MP4, fed with the saved plan plus any unsaved edits
  const saved = c.animationEdits?.[String(n)] ?? {};
  const labelsNow = () => ({ ...(plan.labels ?? {}), ...(saved.labels ?? {}), ...(state.editor.anim[n]?.labels ?? {}) });
  const stage = el("div", { class: "scene-stage", role: "img", "aria-label": `Slide ${n} animation preview` });
  const slider = el("input", { type: "range", min: "0", max: String(plan.durationSeconds), step: "0.1", value: String(Math.round(plan.durationSeconds * 0.8 * 10) / 10), "aria-label": "Preview time in seconds" });
  const drawPreview = () => {
    if (!window.DoctynScene) { stage.textContent = "The preview could not be loaded."; return; }
    try {
      const svg = window.DoctynScene.renderFrame({ ...plan, slideText: eff.slideText, labels: labelsNow(), events: eff.events, popups: eff.popups }, Number(slider.value), { watermark: "DRAFT PREVIEW" });
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      stage.replaceChildren(document.importNode(doc.documentElement, true));
    } catch { stage.textContent = "This slide could not be previewed."; }
  };
  slider.addEventListener("input", drawPreview);
  drawPreview();
  box.append(el("div", { class: "scene-preview" }, stage, slider,
    eff.template !== plan.template ? el("p", { class: "small muted", text: "The preview shows the planned type. Save, then refresh the animation plan to preview the new type." }) : null));
  if (plan.items?.length) {
    const fields = el("div", { class: "scene-labels" });
    for (const it of plan.items) {
      const input = el("input", { type: "text", maxlength: "120", disabled: busy, "aria-label": `Slide ${n} label ${it.id}`, value: labelsNow()[it.id] ?? it.label });
      input.addEventListener("input", () => { animDraft(n).labels = { ...labelsNow(), [it.id]: input.value }; drawPreview(); renderEditorChrome(); markListEdited(); });
      fields.append(el("label", {}, it.description ?? it.id, input));
    }
    box.append(el("details", { class: "scene-label-edit" }, el("summary", { text: "Edit on-screen labels (use | to split a heading from its detail)" }), fields));
  }

  const over = el("textarea", { rows: "3", disabled: busy, "aria-label": `Slide ${n} overlay text` });
  over.value = eff.slideText.join("\n");
  over.addEventListener("input", () => { animDraft(n).slideText = over.value.split("\n").map((t) => t.trim()).filter(Boolean); renderEditorChrome(); markListEdited(); });
  box.append(el("label", { class: "field" }, "On-screen text overlay (one line each)", over));

  // pop-ups
  const popBox = el("div", { class: "popups" });
  const popups = eff.popups;
  const setPopups = (next) => { animDraft(n).popups = next; renderEditorChrome(); markListEdited(); renderEditor(); };
  popBox.append(el("h5", { text: "Medical explanation pop-ups" }));
  popups.forEach((p, i) => {
    const upd = (patch) => { const next = popups.map((x, j) => (j === i ? { ...x, ...patch } : x)); animDraft(n).popups = next; renderEditorChrome(); markListEdited(); };
    const t = el("input", { type: "text", maxlength: "80", value: p.title, disabled: busy, "aria-label": "Pop-up title" });
    t.addEventListener("input", () => upd({ title: t.value }));
    const body = el("textarea", { rows: "2", maxlength: "400", disabled: busy, "aria-label": "Pop-up text" });
    body.value = p.text;
    body.addEventListener("input", () => upd({ text: body.value }));
    const kind = el("select", { disabled: busy, "aria-label": "Pop-up kind" }, ["definition", "clinical", "warning"].map((k) => el("option", { value: k, text: k, selected: p.kind === k })));
    kind.addEventListener("change", () => upd({ kind: kind.value }));
    popBox.append(el("div", { class: "popup-edit" },
      el("div", { class: "row gap wrap" }, t, kind,
        el("button", { class: "btn btn-ghost danger small", type: "button", disabled: busy, onclick: () => setPopups(popups.filter((_, j) => j !== i)) }, "Remove")),
      body,
      timeRow("Shows from", "to", p.start, p.end, plan.durationSeconds, busy, (start, end) => upd({ start, end })),
      p.origin !== "source" ? el("span", { class: "small muted", text: `Origin: ${p.origin} — needs clinician sign-off` }) : null,
    ));
  });
  popBox.append(el("button", { class: "btn btn-secondary small", type: "button", disabled: busy || popups.length >= 20, onclick: () => {
    const start = Math.min(1, Math.max(0, plan.durationSeconds - 3));
    setPopups([...popups, { id: `custom-${Date.now().toString(36)}`, title: "Note", text: "", kind: "clinical", start, end: Math.min(plan.durationSeconds, start + 5), origin: "source" }]);
  } }, "Add pop-up"));
  box.append(popBox);

  // timings
  const evBox = el("div", { class: "timings" }, el("h5", { text: `Animation timings (slide lasts ${plan.durationSeconds.toFixed(1)} s${plan.durationSource === "estimated" ? ", estimated until the video is generated" : ""})` }));
  eff.events.forEach((ev, i) => {
    const upd = (start, end) => { const next = eff.events.map((x, j) => (j === i ? { ...x, start, end } : x)); animDraft(n).events = next; renderEditorChrome(); markListEdited(); };
    evBox.append(el("div", { class: "event-row" },
      el("span", { class: "event-name", title: ev.cue ?? "", text: `${c.animationEdits?.[String(n)]?.labels?.[ev.element] ?? plan.labels?.[ev.element] ?? ev.element} · ${ev.action}` }),
      timeRow("", "→", ev.start, ev.end, plan.durationSeconds, busy, upd),
    ));
  });
  box.append(evBox);

  const unack = plan.flags.filter((f) => !f.acknowledged);
  if (unack.length) box.append(el("ul", { class: "flags" }, unack.map((f) => el("li", {}, el("strong", { text: f.kind }), `: ${f.text}`))));
  if (c.animationEdits?.[String(n)]) {
    box.append(el("button", { class: "btn btn-ghost small", type: "button", disabled: busy, onclick: async () => {
      try { await call("PATCH", `/courses/${c.id}/animation`, { slide: n, reset: true }); delete state.editor.anim[n]; toast("Animation edits for this slide were reset."); await refreshAll(); renderEditor(); } catch (e) { fail(e); }
    } }, "Reset animation edits for this slide"));
  }
  return box;
}

function timeRow(labelA, labelB, a, b, max, busy, onChange) {
  const mk = (val, aria) => el("input", { type: "number", min: "0", max: String(Math.ceil(max)), step: "0.1", value: String(Math.round(val * 10) / 10), disabled: busy, "aria-label": aria });
  const x = mk(a, "start seconds");
  const y = mk(b, "end seconds");
  const fire = () => {
    let s = Math.max(0, Math.min(max, Number(x.value) || 0));
    let e = Math.max(s + 0.1, Math.min(max, Number(y.value) || 0));
    onChange(Math.round(s * 100) / 100, Math.round(e * 100) / 100);
  };
  x.addEventListener("change", fire);
  y.addEventListener("change", fire);
  return el("span", { class: "time-row" }, labelA ? el("span", { class: "small muted", text: labelA }) : null, x, el("span", { class: "small muted", text: labelB }), y, el("span", { class: "small muted", text: "s" }));
}

async function refreshPlan() {
  const c = state.course;
  try { await call("POST", `/courses/${c.id}/plan`, {}); toast("Refreshing the animation plan…"); await refreshAll(); scheduleTick(); } catch (e) { fail(e); }
}

/** Save narration/title edits and animation edits. Returns true on success. */
async function saveEdits() {
  const c = state.course;
  if (!c || !dirty()) return true;
  try {
    const slides = Object.entries(state.editor.drafts).map(([slide, d]) => ({ slide: Number(slide), ...d }));
    if (slides.length) await call("PATCH", `/courses/${c.id}`, { slides });
    for (const [slide, edit] of Object.entries(state.editor.anim)) {
      if (Object.keys(edit).length) await call("PATCH", `/courses/${c.id}/animation`, { slide: Number(slide), edit });
    }
    const reopened = c.review.status !== "none";
    state.editor.drafts = {};
    state.editor.anim = {};
    await loadCurrent();
    await loadCourses();
    toast(reopened ? "Saved. Medical review is needed again for the changed content." : "Saved. Generate Video will use these edits.");
    renderAll({ force: true });
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

// ---------- medical review queue + administration (same page, role based) ----------

function renderRoleAreas() {
  const role = state.user?.role;
  $("review-card").hidden = !(role === "reviewer" || role === "admin");
  $("admin-card").hidden = role !== "admin";
}

async function loadReviewQueue() {
  if (!["reviewer", "admin"].includes(state.user?.role)) return;
  const box = $("review-list");
  try {
    const { courses } = await call("GET", "/reviews");
    box.replaceChildren(courses.length
      ? el("div", { class: "course-list" }, courses.map((c) => el("article", { class: "course-row" },
        el("div", { class: "row between gap wrap" }, el("h3", { class: "video-title", text: c.title }), el("span", { class: "muted small", text: `${c.ownerName} · ${c.slideCount} slides · requested ${timeAgo(c.updatedAt)}` })),
        el("div", { class: "video-actions" }, el("button", { class: "btn btn-primary small", type: "button", onclick: () => openReview(c.id) }, "Review")),
      )))
      : el("div", { class: "empty" }, el("p", { text: "Nothing is waiting for review." })));
  } catch (e) { box.replaceChildren(el("div", { class: "notice error", text: errText(e) })); }
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
        await Promise.all([loadReviewQueue(), refreshAll()]);
      } catch (e) { fail(e); }
    };
    const plan = course.animationPlan ?? [];
    $("review-dialog-title").textContent = course.title;
    $("review-body").replaceChildren(
      el("p", { class: "muted small", text: "You are approving the narration below and, where present, the animation callouts and flagged items. Approval covers this version only." }),
      ...course.slides.map((s) => {
        const a = plan.find((p) => p.slide === s.slide);
        const open = a ? a.flags.filter((f) => !f.acknowledged) : [];
        return el("details", { class: "anim-slide" },
          el("summary", {}, el("strong", { text: `Slide ${s.slide}` }), ` ${s.title} `, open.length ? el("span", { class: "badge badge-cancelled", text: `${open.length} flag${open.length > 1 ? "s" : ""}` }) : null),
          el("div", { class: "stack" },
            el("p", { class: "narration", text: s.narration }),
            a ? el("p", { class: "muted small", text: `Animation: ${a.template}. ${a.rationale}` }) : null,
            a?.slideText?.length ? el("p", { class: "small", text: `On screen: ${a.slideText.join(" / ")}` }) : null,
            ...(a?.popups ?? []).map((p) => el("p", { class: "small" }, el("strong", { text: `${p.title} (${p.kind}, ${p.origin}): ` }), p.text)),
            open.length ? el("ul", { class: "flags" }, open.map((f) => el("li", {}, el("strong", { text: f.kind }), `: ${f.text}`))) : null,
          ));
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

const stat = (label, value) => el("div", { class: "stat" }, el("strong", { text: String(value) }), el("span", { class: "muted small", text: label }));
const cardOf = (title, sub, ...body) => el("section", { class: "card" }, el("div", { class: "card-head" }, el("div", {}, el("h2", { text: title }), sub ? el("p", { class: "muted", text: sub }) : null)), ...body);

async function loadAdmin() {
  if (state.user?.role !== "admin") return;
  const root = $("admin-root");
  try {
    const [o, u, j, c] = await Promise.all([
      call("GET", "/admin/overview"), call("GET", "/admin/users"),
      call("GET", `/admin/jobs${state.adminFilter ? `?status=${state.adminFilter}` : ""}`), call("GET", "/admin/courses"),
    ]);
    const n = (obj, k) => obj?.[k] ?? 0;
    const sel = (user, field, options) => {
      const s = el("select", { disabled: user.id === state.user.id, "aria-label": `${field} for ${user.email}` }, options.map((x) => el("option", { value: x, text: x, selected: user[field] === x })));
      s.addEventListener("change", async () => { try { await call("PATCH", `/admin/users/${user.id}`, { [field]: s.value }); toast("Updated."); } catch (e) { fail(e); } loadAdmin(); });
      return s;
    };
    const filter = el("select", { "aria-label": "Filter jobs by status" }, ["", "queued", "running", "failed", "cancelled", "succeeded"].map((s) => el("option", { value: s, text: s || "all", selected: state.adminFilter === s })));
    filter.addEventListener("change", () => { state.adminFilter = filter.value; loadAdmin(); });
    root.replaceChildren(
      cardOf("Administration", "Users, jobs and storage across the platform. Administrators manage accounts and jobs; the API never gives them other users' course content.",
        el("div", { class: "stats" }, stat("Active users", n(o.users, "active")), stat("Awaiting approval", n(o.users, "pending")), stat("Courses", Object.values(o.courses).reduce((a, b) => a + b, 0)),
          stat("Jobs running", n(o.jobs, "running")), stat("Jobs queued", n(o.jobs, "queued")), stat("Jobs failed", n(o.jobs, "failed")), stat("Stored", formatBytes(o.storageBytes) || "0 B"))),
      cardOf("Users", null, el("div", { class: "table-wrap" }, el("table", { class: "table" },
        el("thead", {}, el("tr", {}, ["Name", "Email", "Status", "Role", "Courses", "Storage", "Last sign-in"].map((h) => el("th", { text: h })))),
        el("tbody", {}, u.users.map((x) => el("tr", {}, el("td", { text: x.name }), el("td", { text: x.email }), el("td", {}, sel(x, "status", ["pending", "active", "disabled"])), el("td", {}, sel(x, "role", ["user", "reviewer", "admin"])),
          el("td", { text: String(x.courses) }), el("td", { text: formatBytes(x.storageBytes) || "0 B" }), el("td", { text: x.lastLoginAt ? timeAgo(x.lastLoginAt) : "never" }))))))),
      el("section", { class: "card" }, el("div", { class: "card-head" }, el("div", {}, el("h2", { text: "Jobs" }), el("p", { class: "muted", text: "Cancel stuck jobs and retry failed renders." })), filter),
        el("div", { class: "table-wrap" }, el("table", { class: "table" },
          el("thead", {}, el("tr", {}, ["Course", "Kind", "Status", "Attempt", "Started", "Error", ""].map((h) => el("th", { text: h })))),
          el("tbody", {}, j.jobs.length ? j.jobs.map((x) => el("tr", {}, el("td", { text: x.courseTitle ?? x.courseId }), el("td", { text: x.kind }), el("td", {}, el("span", { class: `badge badge-${x.status}`, text: x.status })),
            el("td", { text: `${x.attempt}/${x.maxAttempts}` }), el("td", { text: x.startedAt ? timeAgo(x.startedAt) : "—" }), el("td", { class: "err-cell", title: x.error ?? "", text: (x.error ?? "").split("\n")[0].slice(0, 90) }),
            el("td", { class: "row gap" },
              ["queued", "running"].includes(x.status) ? el("button", { class: "btn btn-ghost danger small", type: "button", onclick: async () => { try { await call("POST", `/admin/jobs/${x.id}/cancel`, {}); } catch (e) { fail(e); } loadAdmin(); } }, "Cancel") : null,
              ["failed", "cancelled"].includes(x.status) ? el("button", { class: "btn btn-secondary small", type: "button", onclick: async () => { try { await call("POST", `/admin/jobs/${x.id}/retry`, {}); } catch (e) { fail(e); } loadAdmin(); } }, "Retry") : null))) : [el("tr", {}, el("td", { colspan: "7", class: "muted", text: "No jobs." }))])))),
      cardOf("Courses and storage", null, el("div", { class: "table-wrap" }, el("table", { class: "table" },
        el("thead", {}, el("tr", {}, ["Title", "Owner", "Status", "Video", "Updated", ""].map((h) => el("th", { text: h })))),
        el("tbody", {}, c.courses.length ? c.courses.map((x) => el("tr", {}, el("td", { text: x.title }), el("td", { text: `${x.ownerName} (${x.ownerEmail})` }),
          el("td", {}, el("span", { class: `badge ${STATUS_CLASS[x.status] ?? ""}`, text: STATUS_LABEL[x.status] ?? x.status })), el("td", { text: x.videoBytes ? formatBytes(x.videoBytes) : "—" }), el("td", { text: timeAgo(x.updatedAt) }),
          el("td", {}, el("button", { class: "btn btn-ghost danger small", type: "button", onclick: async () => {
            if (!confirm(`Delete "${x.title}" for ${x.ownerEmail} and remove its files from storage?`)) return;
            try { await call("DELETE", `/admin/courses/${x.id}`); } catch (e) { fail(e); } loadAdmin();
          } }, "Delete")))) : [el("tr", {}, el("td", { colspan: "6", class: "muted", text: "No courses." }))])))),
    );
  } catch (e) { root.replaceChildren(el("div", { class: "notice error", text: errText(e) })); }
}

// ---------- wiring ----------

function setupStatic() {
  setupDropzones();
  $("upload-btn").addEventListener("click", uploadSelected);
  $("edit-btn").addEventListener("click", () => (state.editor.open ? closeEditor() : openEditor()));
  $("editor-close").addEventListener("click", closeEditor);
  $("editor-save").addEventListener("click", () => saveEdits());
  $("preview-btn").addEventListener("click", startPreview);
  $("generate-btn").addEventListener("click", startGenerate);
  $("review-btn").addEventListener("click", reviewAction);
  $("render-final-btn").addEventListener("click", renderFinal);
  $("publish-btn").addEventListener("click", publishAction);
  $("cancel-btn").addEventListener("click", cancelJob);
  $("retry-btn").addEventListener("click", retryJob);
  $("refresh-btn").addEventListener("click", () => refreshAll());
  $("status-pill").addEventListener("click", () => refreshAll());
  $("banner-retry").addEventListener("click", async () => { await loadSession(); if (state.user) await refreshAll(); else location.reload(); });
  $("log-details").addEventListener("toggle", () => loadLog().then(renderProgress));
  $("course-select").addEventListener("change", async (e) => {
    const v = e.target.value;
    if (dirty() && !confirm("Switch course and discard unsaved edits?")) { renderCoursePicker(); return; }
    state.editor = { open: false, slide: 1, drafts: {}, anim: {} };
    $("editor-card").hidden = true;
    state.currentId = v === "__new__" ? null : v;
    storageSet(STORE_KEY, v === "__new__" ? "new" : v);
    $("course-title").value = "";
    await loadCurrent();
    await loadLog();
    renderAll({ force: true });
  });
  $("course-title").addEventListener("change", async () => {
    const c = state.course;
    const t = $("course-title").value.trim();
    if (!c || !t || t === c.title) return;
    try { await call("PATCH", `/courses/${c.id}`, { title: t }); await refreshAll(); toast("Title saved."); } catch (e) { fail(e); }
  });
  $("player-close").addEventListener("click", closePlayer);
  $("player").addEventListener("cancel", (e) => { e.preventDefault(); closePlayer(); });
  $("player").addEventListener("click", (e) => e.target === $("player") && closePlayer());
  $("review-close").addEventListener("click", () => $("review-dialog").close());
  window.addEventListener("beforeunload", (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } });
}

// Review queue and admin lists (role based, same page) load when the page is ready and refresh slowly.
async function slowAreas() {
  await Promise.all([loadReviewQueue(), loadAdmin()]);
}
boot().then(() => {
  if (state.user && !state.unavailable) {
    slowAreas();
    setInterval(() => !document.hidden && slowAreas(), 30000);
  }
});
