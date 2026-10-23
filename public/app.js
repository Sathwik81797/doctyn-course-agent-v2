// Doctyn Course Studio — dashboard UI.
// Everything shown here comes from the local engine (npm run dashboard). Nothing is simulated:
// when the engine is not reachable the page says so and disables the actions.

const DEFAULT_API = "http://127.0.0.1:8788";
const STORAGE_KEY = "doctyn.engineUrl";
const JOB_LABELS = { validate: "Validation", "preview-tts": "Voice preview", "build-course": "Course build" };
const JOB_ICONS = { validate: "✓", "preview-tts": "♪", "build-course": "▶", upload: "↑" };
const STATUS_LABELS = { running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };

const $ = (id) => document.getElementById(id);

const state = {
  api: DEFAULT_API,
  online: false,
  health: null,
  job: null,
  logLine: 0,
  pollTimer: 0,
  healthTimer: 0,
  selected: { pptx: null, docx: null },
  uploading: false,
  courses: [],
  published: null,
};

// ---------- small helpers ----------

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}
function formatClock(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
function timeAgo(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function fullDate(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

let toastTimer = 0;
function toast(message, isError = false) {
  const t = $("toast");
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 7000 : 3500);
}

function mediaUrl(slug, rel, { download = false, version = "" } = {}) {
  const path = rel.split("/").map(encodeURIComponent).join("/");
  const q = new URLSearchParams();
  if (download) q.set("download", "1");
  if (version) q.set("v", version);
  const qs = q.toString();
  return `${state.api}/media/${encodeURIComponent(slug)}/${path}${qs ? `?${qs}` : ""}`;
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${state.api}${path}`, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  } catch {
    setOnline(false);
    throw new Error("The local course engine is not reachable. Is `npm run dashboard` running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Engine returned HTTP ${res.status}.`);
  return data;
}

// ---------- connection ----------

async function probe(base) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.service === "doctyn-course-agent" ? data : null;
  } catch {
    return null;
  }
}

function candidateApis() {
  const list = [];
  const saved = storageGet(STORAGE_KEY);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname) && location.protocol === "http:";
  // Served by the engine itself: it is always the right backend, whatever port it runs on.
  if (local) list.push(location.origin);
  if (saved) list.push(saved);
  list.push(DEFAULT_API);
  return [...new Set(list.map((u) => u.replace(/\/+$/, "")))];
}

async function connect() {
  for (const base of candidateApis()) {
    const health = await probe(base);
    if (health) {
      state.api = base;
      syncStudioFrame();
      onHealth(health);
      return;
    }
  }
  state.api = candidateApis()[0];
  setOnline(false);
}

async function checkHealth() {
  const health = await probe(state.api);
  if (health) onHealth(health);
  else if (state.online) setOnline(false);
  else if (!storageGet(STORAGE_KEY)) await connect();
  else setOnline(false);
}

function scheduleHealth() {
  clearTimeout(state.healthTimer);
  state.healthTimer = setTimeout(async () => {
    await checkHealth();
    scheduleHealth();
  }, state.online ? 10000 : 4000);
}

function onHealth(health) {
  const wasOnline = state.online;
  state.health = health;
  setOnline(true);
  updateVoiceCopy();
  if (health.currentJob && (!state.job || state.job.id !== health.currentJob.id)) attachJob(health.currentJob);
  if (!wasOnline) refreshAll();
}

function setOnline(online) {
  state.online = online;
  $("offline-banner").hidden = online;
  $("banner-api").textContent = state.api;
  $("footer-api").textContent = state.api;
  updateStatusPill();
  updateControls();
  if (!online) {
    $("current-inputs").replaceChildren(el("span", { class: "muted", text: "Current input files appear here once the engine is connected." }));
    renderLibrary(null);
    renderPreviews(null);
    renderActivity(null);
  }
}

function updateStatusPill() {
  const pill = $("status-pill");
  const running = state.job && state.job.status === "running";
  pill.dataset.state = !state.online ? "offline" : running ? "busy" : "online";
  $("status-text").textContent = !state.online
    ? "Engine offline"
    : running
      ? `${JOB_LABELS[state.job.kind]} running · ${Math.round(state.job.progress.percent)}%`
      : "Engine connected";
}

function updateVoiceCopy() {
  const tts = state.health && state.health.tts;
  if (!tts) return;
  const name = tts.provider === "kokoro" ? "Kokoro" : tts.provider === "openai" ? "OpenAI" : "Windows";
  $("preview-title").textContent = `Preview ${name} voice`;
  const voice = tts.voice ? ` (${tts.voice}${tts.provider !== "windows" ? `, ${Number(tts.speed).toFixed(1)}×` : ""})` : "";
  $("preview-desc").textContent =
    `Records sample narration${voice} for a few slides so you can judge the voice before a full build. Build files are not touched.` +
    (tts.provider === "openai" ? " Uses the paid OpenAI API." : "");
}

function updateControls() {
  const running = Boolean(state.job && state.job.status === "running");
  const ready = state.online && !running && !state.uploading;
  document.querySelectorAll("[data-job]").forEach((b) => (b.disabled = !ready));
  $("preview-slides").disabled = !ready;
  const anySelected = state.selected.pptx || state.selected.docx;
  $("upload-btn").disabled = !ready || !anySelected;
  document.querySelectorAll(".dropzone").forEach((dz) => {
    dz.classList.toggle("disabled", !ready);
    dz.querySelector("input").disabled = !ready;
  });
  $("cancel-btn").hidden = !running;
}

// ---------- data refresh ----------

async function refreshAll() {
  if (!state.online) return;
  await Promise.allSettled([refreshInputs(), refreshLibrary(), refreshPreviews(), refreshActivity()]);
}

async function refreshInputs() {
  const data = await api("/api/inputs");
  const box = $("current-inputs");
  const chips = [];
  for (const type of ["pptx", "docx"]) {
    const files = data[type] || [];
    if (files.length === 0) {
      chips.push(el("span", { class: "chip" }, el("span", { class: "chip-label", text: type.toUpperCase() }), el("span", { class: "muted", text: "none in input/" })));
    } else {
      for (const f of files) {
        chips.push(el("span", { class: "chip", title: `${f.name} · ${formatBytes(f.bytes)} · ${fullDate(f.modifiedAt)}` },
          el("span", { class: "chip-label", text: type.toUpperCase() }), el("span", { text: f.name })));
      }
      if (files.length > 1) chips.push(el("span", { class: "chip", style: "color: var(--red)", text: `${files.length} ${type} files — the engine needs exactly one` }));
    }
  }
  box.replaceChildren(...chips);
}

async function refreshLibrary() {
  const data = await api("/api/courses");
  state.courses = data.courses;
  renderLibrary(data.courses);
}

async function refreshPublished() {
  const box = $("published");
  const message = (text) => box.replaceChildren(el("div", { class: "empty" }, el("p", { text })));
  try {
    const res = await fetch("/api/library", { headers: { Accept: "application/json" } });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error("unavailable");
    state.published = data.courses;
    if (!data.configured) message("The video library is not connected to storage yet. Connect a Vercel Blob store, then publish a course.");
    else if (!data.courses.length) message("No courses have been published yet.");
    else box.replaceChildren(...data.courses.map((c) => videoCard(publishedItem(c), false)));
  } catch {
    message("The published video library could not be loaded. It is served by the deployed website, not by the local engine.");
  }
}

async function refreshPreviews() {
  const data = await api("/api/previews");
  renderPreviews(data.previews);
}

async function refreshActivity() {
  const data = await api("/api/activity");
  renderActivity(data.activity);
}

// ---------- uploads ----------

function selectFile(type, file) {
  const dz = $(`drop-${type}`);
  const label = dz.querySelector('[data-role="selected"]');
  if (file && !file.name.toLowerCase().endsWith(`.${type}`)) {
    toast(`"${file.name}" is not a .${type} file.`, true);
    file = null;
  }
  state.selected[type] = file || null;
  dz.classList.toggle("has-file", Boolean(file));
  label.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "";
  updateControls();
}

function setupDropzones() {
  document.querySelectorAll(".dropzone").forEach((dz) => {
    const type = dz.dataset.type;
    const input = dz.querySelector("input");
    input.addEventListener("change", () => selectFile(type, input.files[0]));
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!input.disabled) dz.classList.add("drag");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      if (input.disabled) return;
      const files = [...e.dataTransfer.files];
      // Accept both files dropped onto either zone.
      for (const f of files) {
        const ext = f.name.toLowerCase().split(".").pop();
        if (ext === "pptx" || ext === "docx") selectFile(ext, f);
        else toast(`"${f.name}" is not a .pptx or .docx file.`, true);
      }
    });
  });
}

function uploadOne(type, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${state.api}/api/inputs/${type}?filename=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: the local engine is not reachable."));
    xhr.send(file);
  });
}

async function uploadSelected() {
  const items = ["pptx", "docx"].filter((t) => state.selected[t]).map((t) => [t, state.selected[t]]);
  if (!items.length) return;
  const notice = $("upload-notice");
  notice.hidden = true;
  state.uploading = true;
  updateControls();
  $("upload-progress").hidden = false;
  const total = items.reduce((a, [, f]) => a + f.size, 0) || 1;
  let base = 0;
  const messages = [];
  try {
    for (const [type, file] of items) {
      $("upload-text").textContent = `Uploading ${file.name}…`;
      const result = await uploadOne(type, file, (loaded) => {
        $("upload-bar").style.width = `${((base + loaded) / total) * 100}%`;
      });
      base += file.size;
      messages.push(`Uploaded ${result.file.name}${result.replaced.length ? ` (previous file moved to input/.replaced/)` : ""}.`);
      selectFile(type, null);
      $(`drop-${type}`).querySelector("input").value = "";
    }
    $("upload-bar").style.width = "100%";
    notice.className = "notice success";
    notice.textContent = `${messages.join("\n")}\nNext: run Validate course to check every slide has narration.`;
  } catch (err) {
    notice.className = "notice error";
    notice.textContent = [...messages, err.message].join("\n");
  } finally {
    notice.hidden = false;
    state.uploading = false;
    setTimeout(() => ($("upload-progress").hidden = true), 800);
    updateControls();
    refreshInputs().catch(() => {});
    refreshActivity().catch(() => {});
  }
}

// ---------- jobs ----------

async function startJob(kind) {
  const body = { kind };
  if (kind === "preview-tts") body.slides = $("preview-slides").value.trim();
  const paid = state.health && state.health.tts && state.health.tts.provider === "openai";
  if (paid && kind !== "validate" && !confirm("TTS_PROVIDER is openai, so this makes paid OpenAI API requests. Continue?")) return;
  try {
    const { job } = await api("/api/jobs", { method: "POST", body: JSON.stringify(body) });
    attachJob(job);
    toast(`${JOB_LABELS[kind]} started.`);
  } catch (err) {
    toast(err.message, true);
  }
}

function attachJob(job) {
  state.job = job;
  state.logLine = 0;
  $("log").textContent = "";
  $("log-details").open = job.kind === "validate";
  renderJob(job);
  updateControls();
  pollJob();
  document.querySelectorAll(".video-card").length && renderLibrary(state.courses);
}

async function pollJob() {
  clearTimeout(state.pollTimer);
  if (!state.job) return;
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(state.job.id)}?after=${state.logLine}`);
    state.job = data.job;
    if (data.lines.length) appendLog(data.lines);
    state.logLine = data.nextLine;
    renderJob(data.job);
    if (data.job.status !== "running") {
      updateControls();
      onJobFinished(data.job);
      return;
    }
  } catch {
    // engine went away; health check will report it, keep trying
  }
  state.pollTimer = setTimeout(pollJob, 1000);
}

function onJobFinished(job) {
  const ok = job.status === "succeeded";
  toast(`${JOB_LABELS[job.kind]} ${STATUS_LABELS[job.status].toLowerCase()}.`, !ok);
  if (!ok) $("log-details").open = true;
  refreshAll();
}

function appendLog(lines) {
  const pre = $("log");
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.append(document.createTextNode(lines.join("\n") + "\n"));
  $("log-count").textContent = `(${state.logLine + lines.length} lines)`;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function renderJob(job) {
  $("job-empty").hidden = true;
  $("job-panel").hidden = false;
  const running = job.status === "running";
  const p = job.progress || { percent: 0, stages: [], detail: "" };

  $("job-subtitle").textContent = `${JOB_LABELS[job.kind]}${job.args.length ? ` (${job.args.join(" ")})` : ""} · started ${fullDate(job.startedAt)}` +
    (job.endedAt ? ` · took ${formatDuration((new Date(job.endedAt) - new Date(job.startedAt)) / 1000)}` : "");

  const badge = $("job-badge");
  badge.className = `job-badge badge-${job.status}`;
  badge.textContent = running ? `${Math.round(p.percent)}%` : STATUS_LABELS[job.status];
  $("job-detail").textContent = running ? p.detail : job.status === "succeeded" ? "Finished" : job.status === "cancelled" ? "Stopped" : "Stopped with an error";
  $("job-eta").textContent = running && p.eta ? `about ${p.eta} left in this step` : "";

  const percent = job.status === "succeeded" ? 100 : p.percent;
  $("job-bar").style.width = `${percent}%`;
  const wrap = $("job-bar-wrap");
  wrap.setAttribute("aria-valuenow", String(Math.round(percent)));
  wrap.classList.toggle("failed", ["failed", "interrupted"].includes(job.status));
  wrap.classList.toggle("succeeded", job.status === "succeeded");

  const stages = $("stages");
  stages.hidden = !p.stages.length;
  stages.replaceChildren(...p.stages.map((s) =>
    el("li", { "data-status": s.status, title: s.detail || s.label }, s.label, s.status === "reused" ? el("span", { class: "reused-tag", text: "· reused" }) : null)));

  const result = $("job-result");
  if (running) {
    result.hidden = true;
  } else {
    const text = job.status === "succeeded" ? job.summary || "Done." : [job.summary, job.error].filter(Boolean).join("\n\n") || "The job did not finish.";
    result.className = `result ${job.status === "succeeded" ? "success" : "error"}`;
    result.textContent = text;
    result.hidden = false;
  }
  updateStatusPill();
}

async function cancelJob() {
  if (!state.job || state.job.status !== "running") return;
  if (!confirm(`Cancel the running ${JOB_LABELS[state.job.kind].toLowerCase()}? Finished slides are kept and reused next time.`)) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.job.id)}/cancel`, { method: "POST" });
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- library ----------

function renderLibrary(courses) {
  const grid = $("library");
  if (!courses) {
    grid.replaceChildren(el("div", { class: "empty" }, el("p", { text: "Connect the local engine to see courses on this computer." })));
    return;
  }
  if (!courses.length) {
    grid.replaceChildren(el("div", { class: "empty" }, el("p", { text: "No courses in output/ yet. Upload files, validate, then Generate to create the first video." })));
    return;
  }
  const buildingSlug = state.job && state.job.status === "running" && state.job.kind === "build-course" ? state.job.courseSlug : null;
  grid.replaceChildren(...courses.map((c) => videoCard(localItem(c), c.slug === buildingSlug)));
}

// Both libraries render from one shape: { origin, title, slug, slideCount, durationSeconds, builtAt, builtLabel, status, tts,
// files: { video|thumbnail|vtt|srt|transcript: { url, downloadUrl, bytes } } }.
function localItem(c) {
  const version = c.generatedAt || c.updatedAt || "";
  const files = {};
  for (const [key, rel] of [["video", "final-video.mp4"], ["thumbnail", "thumbnail.jpg"], ["vtt", "captions.vtt"], ["srt", "captions.srt"], ["transcript", "transcript.txt"]]) {
    if (c.files[key]) files[key] = { url: mediaUrl(c.slug, rel, { version }), downloadUrl: mediaUrl(c.slug, rel, { download: true }), bytes: c.files[key].bytes };
  }
  return { origin: "local", title: c.title, slug: c.slug, slideCount: c.slideCount, durationSeconds: c.durationSeconds, builtAt: c.generatedAt || c.updatedAt, builtLabel: c.generatedAt ? "Built" : "Updated", status: c.status, tts: c.tts, files };
}

function publishedItem(c) {
  const v = encodeURIComponent(c.publishedAt || c.generatedAt || "");
  const text = (file) => `/api/course-file?slug=${encodeURIComponent(c.slug)}&file=${file}`;
  const files = {};
  for (const key of ["video", "thumbnail"]) {
    if (c.files[key]) files[key] = { url: `${c.files[key].url}?v=${v}`, downloadUrl: `${c.files[key].url}?download=1`, bytes: c.files[key].bytes };
  }
  for (const key of ["vtt", "srt", "transcript"]) {
    if (c.files[key]) files[key] = { url: text(key), downloadUrl: `${text(key)}&download=1`, bytes: c.files[key].bytes };
  }
  return { origin: "published", title: c.title, slug: c.slug, slideCount: c.slideCount, durationSeconds: c.durationSeconds, builtAt: c.publishedAt || c.generatedAt, builtLabel: "Published", status: "complete", tts: null, files };
}

function videoCard(c, building) {
  const playable = Boolean(c.files.video);
  const statusText = building ? "Building…" : c.status === "complete" ? "Complete" : c.status === "failed" ? "Failed validation" : "Incomplete";
  const badgeClass = building ? "badge" : `badge badge-${c.status}`;

  const thumb = el("button", { class: "thumb", type: "button", disabled: !playable, "aria-label": playable ? `Play ${c.title}` : `${c.title} has no video yet`, onclick: () => openPlayer(c) },
    c.files.thumbnail
      ? el("img", { src: c.files.thumbnail.url, alt: "", loading: "lazy", width: "1280", height: "720" })
      : el("span", { class: "noimg", text: "No thumbnail yet" }),
    playable ? el("span", { class: "play", "aria-hidden": "true" }, svgPlay()) : null,
    c.durationSeconds ? el("span", { class: "duration", text: formatClock(c.durationSeconds) }) : null,
  );

  const meta = [];
  if (c.slideCount) meta.push(`${c.slideCount} slides`);
  if (c.durationSeconds) meta.push(formatDuration(c.durationSeconds));
  if (c.files.video) meta.push(formatBytes(c.files.video.bytes));
  if (c.builtAt) meta.push(`${c.builtLabel} ${timeAgo(c.builtAt)}`);

  return el("article", { class: "video-card" },
    thumb,
    el("div", { class: "video-body" },
      el("div", { class: "row between gap" }, el("h3", { class: "video-title", text: c.title }), el("span", { class: badgeClass, text: statusText })),
      el("div", { class: "video-meta" }, ...meta.map((m) => el("span", { text: m }))),
      c.tts ? el("div", { class: "video-meta", title: c.tts }, el("span", { text: c.tts.split(",")[0] })) : null,
    ),
    el("div", { class: "video-actions" },
      el("button", { class: "btn btn-primary small", type: "button", disabled: !playable, onclick: () => openPlayer(c) }, "Play"),
      ...downloadLinks(c),
    ),
  );
}

function downloadLinks(c) {
  const links = [
    ["video", "final-video.mp4", "Download MP4"],
    ["vtt", "captions.vtt", "VTT"],
    ["srt", "captions.srt", "SRT"],
    ["transcript", "transcript.txt", "Transcript"],
  ];
  return links
    .filter(([key]) => c.files[key])
    .map(([key, file, label]) =>
      el("a", { class: "btn btn-ghost small", href: c.files[key].downloadUrl, download: `${c.slug}-${file}`, title: `Download ${file} (${formatBytes(c.files[key].bytes)})` }, `↓ ${label}`));
}

function svgPlay() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "26");
  svg.setAttribute("height", "26");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("fill", "#fff");
  path.setAttribute("d", "M8 5v14l11-7z");
  svg.append(path);
  return svg;
}

function openPlayer(c) {
  if (!c.files.video) return;
  const video = $("player-video");
  video.replaceChildren();
  // Published captions are served from this site; local ones come from the engine and need CORS.
  if (c.origin === "local") video.setAttribute("crossorigin", "anonymous");
  else video.removeAttribute("crossorigin");
  video.src = c.files.video.url;
  if (c.files.thumbnail) video.poster = c.files.thumbnail.url;
  else video.removeAttribute("poster");
  if (c.files.vtt) {
    video.append(el("track", { kind: "captions", label: "English", srclang: "en", src: c.files.vtt.url, default: true }));
  }
  $("player-title").textContent = c.title;
  $("player-meta").textContent = [c.slideCount && `${c.slideCount} slides`, c.durationSeconds && formatDuration(c.durationSeconds), c.builtAt && `${c.builtLabel.toLowerCase()} ${fullDate(c.builtAt)}`, c.status !== "complete" && "last build did not pass final validation"]
    .filter(Boolean).join(" · ");
  $("player-downloads").replaceChildren(...downloadLinks(c));
  $("player").showModal();
}

function closePlayer() {
  const video = $("player-video");
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("player").close();
}

// ---------- previews ----------

function renderPreviews(sets) {
  const box = $("previews");
  if (!sets) {
    box.replaceChildren(el("div", { class: "empty small" }, el("p", { text: "Connect the local engine to hear voice previews." })));
    return;
  }
  if (!sets.length) {
    box.replaceChildren(el("div", { class: "empty small" }, el("p", { text: "No previews yet. Use “Preview voice” to record sample slides." })));
    return;
  }
  box.replaceChildren(...sets.slice(0, 3).map((s) =>
    el("div", { class: "preview-set" },
      el("div", { class: "preview-head" }, el("strong", { text: s.voice }), ` · ${timeAgo(s.generatedAt)}`),
      ...s.clips.map((clip) =>
        el("div", { class: "clip" },
          el("span", { class: "clip-title", text: `${clip.title || `Slide ${clip.slide}`}${clip.seconds ? ` · ${clip.seconds.toFixed(1)}s` : ""}` }),
          el("audio", { controls: true, preload: "none", src: mediaUrl(s.slug, clip.path, { version: s.generatedAt }) }),
        )),
    )));
}

// ---------- activity ----------

function renderActivity(items) {
  const list = $("activity");
  if (!items) {
    list.replaceChildren(el("li", { class: "empty small" }, el("p", { text: "Connect the local engine to see recent activity." })));
    return;
  }
  if (!items.length) {
    list.replaceChildren(el("li", { class: "empty small" }, el("p", { text: "Nothing yet. Uploads and jobs started from this dashboard appear here." })));
    return;
  }
  list.replaceChildren(...items.slice(0, 12).map((item) => {
    if (item.kind === "upload") {
      const f = item.files[0];
      return el("li", {},
        el("span", { class: "act-icon", "aria-hidden": "true", text: JOB_ICONS.upload }),
        el("div", {},
          el("div", { class: "act-title", text: `Uploaded ${f ? f.type.toUpperCase() : "file"}` }),
          el("div", { class: "act-meta", title: fullDate(item.at), text: `${f ? f.name : ""} · ${timeAgo(item.at)}` })));
    }
    const took = item.endedAt ? ` · ${formatDuration((new Date(item.endedAt) - new Date(item.startedAt)) / 1000)}` : "";
    const firstLine = (item.status === "succeeded" ? item.summary : item.error || item.summary || "").split("\n")[0];
    return el("li", {},
      el("span", { class: `act-icon ${item.status}`, "aria-hidden": "true", text: JOB_ICONS[item.kind] }),
      el("div", {},
        el("div", { class: "act-title" }, `${JOB_LABELS[item.kind]} `, el("span", { class: `badge badge-${item.status}`, text: item.status === "running" ? `${Math.round(item.progress.percent)}%` : STATUS_LABELS[item.status] })),
        el("div", { class: "act-meta", title: fullDate(item.startedAt), text: `${timeAgo(item.startedAt)}${took}${firstLine ? ` · ${firstLine}` : ""}` })));
  }));
}

// ---------- settings ----------

function openSettings() {
  $("api-input").value = state.api;
  $("settings").showModal();
}

function setupSettings() {
  $("settings-btn").addEventListener("click", openSettings);
  $("banner-settings").addEventListener("click", openSettings);
  $("status-pill").addEventListener("click", () => (state.online ? refreshAll() : openSettings()));
  $("settings-cancel").addEventListener("click", () => $("settings").close());
  $("settings-reset").addEventListener("click", () => {
    storageSet(STORAGE_KEY, null);
    $("settings").close();
    connect().then(scheduleHealth);
  });
  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    let value = $("api-input").value.trim().replace(/\/+$/, "");
    try {
      const u = new URL(value);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      value = u.origin;
    } catch {
      toast("Enter a full URL such as http://127.0.0.1:8788", true);
      return;
    }
    storageSet(STORAGE_KEY, value);
    state.api = value;
    $("settings").close();
    checkHealth().then(scheduleHealth);
  });
}

// ---------- navigation (dashboard <-> AI Animation Studio, one page, one server) ----------

function currentView() {
  return location.hash.startsWith("#/studio") ? "studio" : "dashboard";
}

function syncStudioFrame() {
  const frame = $("studio-frame");
  const want = `${state.api}/studio/?embed=1`;
  // Load lazily, and again if the engine address changed.
  if (currentView() === "studio" && frame.dataset.loaded !== want) {
    frame.dataset.loaded = want;
    frame.src = want;
  }
}

function showView() {
  const view = currentView();
  $("dashboard-view").hidden = view !== "dashboard";
  $("studio-view").hidden = view !== "studio";
  document.body.dataset.view = view;
  document.querySelectorAll(".nav-link").forEach((a) => {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.title = view === "studio" ? "AI Animation Studio — Doctyn Course Studio" : "Doctyn Course Studio";
  syncStudioFrame();
}

// ---------- boot ----------

function boot() {
  window.addEventListener("hashchange", showView);
  showView();
  setupDropzones();
  setupSettings();
  $("upload-btn").addEventListener("click", uploadSelected);
  document.querySelectorAll("[data-job]").forEach((b) => b.addEventListener("click", () => startJob(b.dataset.job)));
  $("cancel-btn").addEventListener("click", cancelJob);
  $("refresh-btn").addEventListener("click", () => (state.online ? refreshAll() : checkHealth()));
  $("published-refresh-btn").addEventListener("click", () => refreshPublished());
  $("banner-retry").addEventListener("click", () => connect().then(scheduleHealth));
  $("player-close").addEventListener("click", closePlayer);
  $("player").addEventListener("cancel", (e) => {
    e.preventDefault();
    closePlayer();
  });
  $("player").addEventListener("click", (e) => e.target === $("player") && closePlayer());
  $("banner-api").textContent = state.api;
  $("footer-api").textContent = state.api;
  updateControls();
  refreshPublished();
  connect().then(scheduleHealth);
  // Keep relative times fresh.
  setInterval(() => state.online && !document.hidden && refreshActivity().catch(() => {}), 30000);
}

boot();
