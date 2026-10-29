// @ts-check
// The /api/v3 HTTP API. Framework-neutral (Node req/res) so it runs inside one Vercel function
// and inside the local development server unchanged.
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  HttpError, audit, clearCookie, login, logout, publicUser, readJsonBody, register, sessionCookie, sessionTokenFromCookie, userForToken,
} from "./auth.js";
import { engineStatus, enqueue, reapStale, requestCancel, retryJob } from "./queue.js";
import { registerEditorRoutes } from "./editor/routes.js";
import { ANIMATION_TEMPLATES, OUTPUT_FILES, UUID_RE, cleanText, contentHash, courseKeys, narrationHash, normalizeRouteUrl, parseSlideList } from "./util.js";

/** @typedef {{ config: import("./config.js").CloudConfig, db: import("./db.js").Db, storage: import("./storage.js").Storage }} Ctx */
/** @typedef {import("node:http").IncomingMessage} Req */
/** @typedef {import("node:http").ServerResponse} Res */

const BUSY = ["parsing", "queued", "rendering"];

/** @param {Res} res @param {number} status @param {unknown} body @param {string[]} [cookies] */
export function sendJson(res, status, body, cookies) {
  const data = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (cookies?.length) res.setHeader("Set-Cookie", cookies);
  res.writeHead(status);
  res.end(data);
}

/** @param {Req} req @param {number} [max] */
function readJson(req, max = 2 * 1024 * 1024) {
  return readJsonBody(req, max);
}

/** @param {Req} req */
function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

/** @param {Req} req @param {import("./config.js").CloudConfig} config */
function isSecure(req, config) {
  return config.production || req.headers["x-forwarded-proto"] === "https";
}

/** @param {any} r @param {boolean} detail */
export function toCourse(r, detail = false) {
  const outputs = r.outputs ?? {};
  const current = r.content_hash && r.built_hash === r.content_hash;
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    error: r.error,
    slideCount: r.slide_count,
    ownerId: r.owner_id,
    ...(r.owner_name ? { ownerName: r.owner_name, ownerEmail: r.owner_email } : {}),
    files: { pptx: r.pptx_name ?? null, docx: r.docx_name ?? null },
    durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
    hasVideo: Boolean(outputs.video),
    available: Object.fromEntries(Object.keys(OUTPUT_FILES).map((k) => [k, Boolean(outputs[k])])),
    videoBytes: outputs.video?.bytes ?? null,
    stale: Boolean(outputs.video) && !current,
    review: {
      status: r.review_status,
      notes: r.review_notes,
      at: r.reviewed_at,
      matchesCurrentContent: r.review_status !== "none" && r.review_hash === r.content_hash,
    },
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    animation: r.animation ? { planned: true, rendered: Boolean(r.animation.rendered), draft: r.animation.draft ?? null, slideCount: r.animation.slides?.length ?? 0, genericSlides: (r.animation.slides ?? []).filter((/** @type {any} */ s) => s.template === "key-points").map((/** @type {any} */ s) => s.slide) } : null,
    animatedDraft: outputs.animated ? Boolean(outputs.animated.draft) : null,
    slidePreviews: Boolean(r.slide_previews),
    ...(detail ? { previews: Object.fromEntries(Object.entries(r.previews ?? {}).map(([n, p]) => [n, { at: p.at, stale: p.hash !== narrationHash(String(r.slides.find((/** @type {any} */ x) => x.slide === Number(n))?.narration ?? "")) }])), slides: r.slides, validation: r.validation, animationPlan: r.animation?.slides ?? null, animationEdits: r.animation_edits ?? {} } : {}),
    ...(r.job ? { job: toJob(r.job) } : {}),
  };
}

/** @param {any} j @param {boolean} [withLog] */
export function toJob(j, withLog = false) {
  return {
    id: j.id,
    courseId: j.course_id,
    kind: j.kind,
    status: j.status,
    cancelRequested: j.cancel_requested,
    attempt: j.attempt,
    maxAttempts: j.max_attempts,
    progress: j.progress,
    error: j.error,
    createdAt: j.created_at,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
    heartbeatAt: j.heartbeat_at,
    ...(j.course_title ? { courseTitle: j.course_title } : {}),
    ...(withLog ? { log: j.log_tail } : {}),
  };
}

/** Course owned by the caller. Admins manage jobs and users but never read other users' content. @param {Ctx} ctx @param {any} user @param {string} id */
async function mine(ctx, user, id) {
  if (!UUID_RE.test(id)) throw new HttpError(404, "Course not found.");
  const res = await ctx.db.query("SELECT * FROM courses WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL", [id, user.id]);
  if (!res.rows[0]) throw new HttpError(404, "Course not found.");
  return res.rows[0];
}

/** @param {any} user @param {...string} roles */
function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, "You do not have permission to do that.");
}

/** @type {Array<{ method: string, pattern: RegExp, auth: "none" | "user", handler: (c: Ctx, a: any) => Promise<void> }>} */
const routes = [];
/** @param {string} method @param {string} pattern @param {"none" | "user"} auth @param {(c: Ctx, a: any) => Promise<void>} handler */
function route(method, pattern, auth, handler) {
  routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), auth, handler });
}

// ---------- health & auth ----------

route("GET", "/health", "none", async (ctx, { res }) => {
  await ctx.db.query("SELECT 1");
  sendJson(res, 200, { ok: true, service: "doctyn-cloud", db: ctx.db.kind, storage: ctx.storage.driver, registration: ctx.config.registrationMode });
});

route("GET", "/engine", "user", async (ctx, { res }) => {
  // If the PC went off mid-job, free the job so it resumes when the engine returns (the website polls this).
  await reapStale(ctx.db, ctx.config.staleJobSeconds);
  sendJson(res, 200, await engineStatus(ctx.db));
});

route("GET", "/meta", "none", async (ctx, { res }) => {
  sendJson(res, 200, { localMode: ctx.config.devAutoLogin, registration: ctx.config.registrationMode, maxUploadBytes: ctx.config.maxUploadBytes, animationTemplates: ANIMATION_TEMPLATES });
});

route("POST", "/auth/register", "none", async (ctx, { req, res }) => {
  const body = /** @type {any} */ (await readJson(req, 16 * 1024));
  const user = await register(ctx.db, ctx.config, body);
  sendJson(res, 201, {
    user,
    message: user.status === "active" ? "Account created. You can sign in now." : "Account created. An administrator must approve it before you can sign in.",
  });
});

route("POST", "/auth/login", "none", async (ctx, { req, res }) => {
  const body = /** @type {any} */ (await readJson(req, 16 * 1024));
  const out = await login(ctx.db, ctx.config, { email: body.email, password: body.password, ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "") });
  sendJson(res, 200, { user: out.user }, [sessionCookie(out.token, out.expires, isSecure(req, ctx.config))]);
});

route("POST", "/auth/logout", "none", async (ctx, { req, res }) => {
  const token = sessionTokenFromCookie(req.headers.cookie);
  if (token) await logout(ctx.db, token);
  sendJson(res, 200, { ok: true }, [clearCookie(isSecure(req, ctx.config))]);
});

route("GET", "/auth/me", "none", async (ctx, { req, res }) => {
  const user = await userForToken(ctx.db, sessionTokenFromCookie(req.headers.cookie));
  sendJson(res, 200, { user });
});

// ---------- courses ----------

const COURSE_WITH_JOB = `
  SELECT c.*, (SELECT row_to_json(j) FROM (SELECT * FROM jobs WHERE course_id = c.id ORDER BY created_at DESC LIMIT 1) j) AS job
  FROM courses c`;

route("GET", "/courses", "user", async (ctx, { res, user }) => {
  const rows = (await ctx.db.query(`${COURSE_WITH_JOB} WHERE c.owner_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 200`, [user.id])).rows;
  sendJson(res, 200, { courses: rows.map((r) => toCourse(r)) });
});

route("POST", "/courses", "user", async (ctx, { req, res, user }) => {
  const body = /** @type {any} */ (await readJson(req, 16 * 1024));
  const title = cleanText(body.title, 200).trim();
  if (!title) throw new HttpError(400, "Enter a course title.");
  const count = (await ctx.db.query("SELECT count(*)::int AS n FROM courses WHERE owner_id = $1 AND deleted_at IS NULL", [user.id])).rows[0].n;
  if (count >= 100) throw new HttpError(409, "You have reached the limit of 100 courses. Delete an old one first.");
  const row = (await ctx.db.query("INSERT INTO courses(owner_id, title) VALUES ($1,$2) RETURNING *", [user.id, title])).rows[0];
  await audit(ctx.db, user.id, "course.create", row.id, {});
  sendJson(res, 201, { course: toCourse(row, true) });
});

route("GET", "/courses/:id", "user", async (ctx, { res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  const jobs = (await ctx.db.query("SELECT * FROM jobs WHERE course_id = $1 ORDER BY created_at DESC LIMIT 5", [row.id])).rows;
  sendJson(res, 200, { course: toCourse({ ...row, job: jobs[0] }, true), jobs: jobs.map((j) => toJob(j)) });
});

route("DELETE", "/courses/:id", "user", async (ctx, { res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  if (BUSY.includes(row.status)) throw new HttpError(409, "Cancel the running job before deleting this course.");
  await ctx.db.query("UPDATE courses SET deleted_at = now(), updated_at = now() WHERE id = $1", [row.id]);
  await ctx.storage.removePrefix(`${courseKeys(row.owner_id, row.id).base}/`);
  await audit(ctx.db, user.id, "course.delete", row.id, {});
  sendJson(res, 200, { ok: true });
});

const MAX_SLIDES = 300;

route("POST", "/courses/:id/upload-url", "user", async (ctx, { req, res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  if (BUSY.includes(row.status)) throw new HttpError(409, "Wait for the current job to finish before replacing files.");
  const body = /** @type {any} */ (await readJson(req, 16 * 1024));
  const type = body.type;
  if (type !== "pptx" && type !== "docx") throw new HttpError(400, "type must be pptx or docx.");
  const filename = cleanText(body.filename, 200);
  if (path.extname(filename).toLowerCase() !== `.${type}`) throw new HttpError(400, `"${filename}" is not a .${type} file.`);
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, "File size is required.");
  if (size > ctx.config.maxUploadBytes) throw new HttpError(413, `File is larger than the ${Math.round(ctx.config.maxUploadBytes / 1048576)} MB limit.`);
  const key = courseKeys(row.owner_id, row.id).source(type, randomBytes(6).toString("hex"));
  const contentType = type === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const url = await ctx.storage.presignPut(key, { contentType, size });
  sendJson(res, 200, { url, key, method: "PUT", headers: { "Content-Type": contentType }, expiresInSeconds: ctx.config.signedUrlSeconds });
});

route("POST", "/courses/:id/files/complete", "user", async (ctx, { req, res, user, params }) => {
  const body = /** @type {any} */ (await readJson(req, 16 * 1024));
  const type = body.type;
  if (type !== "pptx" && type !== "docx") throw new HttpError(400, "type must be pptx or docx.");
  const out = await ctx.db.tx(async (q) => {
    const row = (await q.query("SELECT * FROM courses WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE", [UUID_RE.test(params.id) ? params.id : "00000000-0000-0000-0000-000000000000", user.id])).rows[0];
    if (!row) throw new HttpError(404, "Course not found.");
    if (BUSY.includes(row.status)) throw new HttpError(409, "Wait for the current job to finish before replacing files.");
    const key = String(body.key ?? "");
    const prefix = `${courseKeys(row.owner_id, row.id).base}/source/${type}-`;
    if (!key.startsWith(prefix) || key.includes("..")) throw new HttpError(400, "That file does not belong to this course.");
    const head = await ctx.storage.head(key);
    if (!head) throw new HttpError(400, "The upload did not finish. Try uploading the file again.");
    if (head.size > ctx.config.maxUploadBytes) {
      await ctx.storage.remove(key);
      throw new HttpError(413, "File is larger than the upload limit.");
    }
    const name = cleanText(body.filename, 200) || `${type}`;
    const oldKey = row[`${type}_key`];
    const both = type === "pptx" ? row.docx_key : row.pptx_key;
    // Replacing a file invalidates everything derived from it, including any clinical review.
    const res2 = await q.query(
      `UPDATE courses SET ${type}_key = $2, ${type}_name = $3, ${type}_bytes = $4,
              status = $5, error = NULL, slide_count = NULL, validation = NULL, slides = '[]'::jsonb,
              content_hash = NULL, built_hash = NULL, review_status = 'none', review_hash = NULL, published_at = NULL,
              editor_shapes = NULL, editor_rev = 0, animation = NULL, animation_edits = '{}'::jsonb,
              updated_at = now() WHERE id = $1 RETURNING *`,
      [row.id, key, name, head.size, both ? "parsing" : "created"],
    );
    // The previous upload stays in storage (originals are preserved); it is removed with the course.
    // Saved editor versions describe slides of the old files, so they go.
    await q.query("DELETE FROM course_versions WHERE course_id = $1", [row.id]);
    void oldKey;
    if (both) await q.query("INSERT INTO jobs(course_id, owner_id, kind, max_attempts) VALUES ($1,$2,'parse',$3)", [row.id, row.owner_id, ctx.config.jobMaxAttempts]);
    return res2.rows[0];
  });
  sendJson(res, 200, { course: toCourse(out, true) });
});

route("PATCH", "/courses/:id", "user", async (ctx, { req, res, user, params }) => {
  const body = /** @type {any} */ (await readJson(req));
  const out = await ctx.db.tx(async (q) => {
    const row = (await q.query("SELECT * FROM courses WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE", [UUID_RE.test(params.id) ? params.id : "00000000-0000-0000-0000-000000000000", user.id])).rows[0];
    if (!row) throw new HttpError(404, "Course not found.");
    if (BUSY.includes(row.status)) throw new HttpError(409, "This course is being processed. Edit it when the job has finished.");
    const title = body.title === undefined ? row.title : cleanText(body.title, 200).trim();
    if (!title) throw new HttpError(400, "The title cannot be empty.");
    /** @type {any[]} */
    const slides = row.slides.map((/** @type {any} */ s) => ({ ...s }));
    if (body.slides !== undefined) {
      if (!Array.isArray(body.slides) || body.slides.length > MAX_SLIDES) throw new HttpError(400, "slides must be a list of edits.");
      if (!slides.length) throw new HttpError(409, "The slides have not been read from the uploaded files yet.");
      for (const e of body.slides) {
        const s = slides.find((x) => x.slide === Number(e?.slide));
        if (!s) throw new HttpError(400, `Slide ${e?.slide} does not exist in this course.`);
        if (e.title !== undefined) s.title = cleanText(e.title, 300).trim();
        if (e.narration !== undefined) s.narration = cleanText(e.narration, 20000);
      }
    }
    const hash = slides.length ? contentHash(title, slides) : null;
    const changed = hash !== row.content_hash;
    // The user supplied what the files lacked (missing narration): the course becomes buildable.
    const resolved = row.status === "invalid" && body.slides !== undefined && slides.length > 0 && slides.every((s) => s.narration.trim());
    // Clinical review applies to the exact text it was given for: any change reopens it.
    const res2 = await q.query(
      `UPDATE courses SET title = $2, slides = $3::jsonb, content_hash = $4,
              status = CASE WHEN $5 THEN 'parsed' ELSE status END,
              error = CASE WHEN $5 THEN NULL ELSE error END,
              validation = CASE WHEN $5 THEN COALESCE(validation, '{}'::jsonb) || '{"ok":true,"resolvedByEdit":true}'::jsonb ELSE validation END,
              review_status = CASE WHEN $6 THEN 'none' ELSE review_status END,
              published_at = CASE WHEN $6 THEN NULL ELSE published_at END,
              updated_at = now() WHERE id = $1 RETURNING *`,
      [row.id, title, JSON.stringify(slides), hash, resolved, changed],
    );
    if (changed) await audit(q, user.id, "course.edit", row.id, { reviewReset: row.review_status !== "none" });
    return res2.rows[0];
  });
  sendJson(res, 200, { course: toCourse(out, true) });
});

route("POST", "/courses/:id/build", "user", async (ctx, { req, res, user, params }) => {
  const opts = /** @type {any} */ (await readJson(req, 4096));
  const row = await mine(ctx, user, params.id);
  if (!["parsed", "complete", "failed"].includes(row.status)) {
    throw new HttpError(409, row.status === "invalid" ? "Fix the problems found in the files before generating the video." : `This course cannot be built while it is ${row.status}.`);
  }
  const slides = row.slides;
  if (!slides.length || row.validation?.ok === false) throw new HttpError(409, "The presentation and voiceover script do not match yet.");
  const empty = slides.filter((/** @type {any} */ s) => !s.narration.trim()).map((/** @type {any} */ s) => s.slide);
  if (empty.length) throw new HttpError(409, `Slides without narration: ${empty.join(", ")}. Add narration before generating.`);
  const job = await enqueue(ctx.db, { courseId: row.id, ownerId: row.owner_id, kind: "build", maxAttempts: ctx.config.jobMaxAttempts, payload: { animate: opts.animate !== false } });
  await ctx.db.query("UPDATE courses SET status = 'queued', error = NULL, updated_at = now() WHERE id = $1", [row.id]);
  await audit(ctx.db, user.id, "job.build", row.id, { job: job.id });
  sendJson(res, 202, { job: toJob(job) });
});

// ---------- animations ----------

route("POST", "/courses/:id/animate", "user", async (ctx, { res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  if (row.status !== "complete" || !row.outputs.video) {
    throw new HttpError(409, "Generate the narrated video first. Animations are timed to the finished narration audio.");
  }
  if (row.built_hash !== row.content_hash) throw new HttpError(409, "The narrated video is out of date with your edits. Generate it again first.");
  const job = await enqueue(ctx.db, { courseId: row.id, ownerId: row.owner_id, kind: "animate", maxAttempts: ctx.config.jobMaxAttempts });
  await ctx.db.query("UPDATE courses SET status = 'rendering', error = NULL, updated_at = now() WHERE id = $1", [row.id]);
  await audit(ctx.db, user.id, "job.animate", row.id, { job: job.id });
  sendJson(res, 202, { job: toJob(job) });
});

/** Stage edits to one slide's animation. They are applied (and validated in full) by the worker. */
route("PATCH", "/courses/:id/animation", "user", async (ctx, { req, res, user, params }) => {
  const body = /** @type {any} */ (await readJson(req, 512 * 1024));
  const out = await ctx.db.tx(async (q) => {
    const row = (await q.query("SELECT * FROM courses WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE", [UUID_RE.test(params.id) ? params.id : "00000000-0000-0000-0000-000000000000", user.id])).rows[0];
    if (!row) throw new HttpError(404, "Course not found.");
    if (BUSY.includes(row.status)) throw new HttpError(409, "This course is being processed. Edit animations when the job has finished.");
    const n = Number(body.slide);
    if (!row.slides.some((/** @type {any} */ s) => s.slide === n)) throw new HttpError(400, `Slide ${body.slide} does not exist.`);
    const e = body.edit && typeof body.edit === "object" ? body.edit : body.reset === true ? {} : null;
    if (!e) throw new HttpError(400, "edit is required.");
    /** @type {Record<string, unknown>} */
    const clean = {};
    if (e.template !== undefined) {
      if (!ANIMATION_TEMPLATES.includes(e.template)) throw new HttpError(400, "Unknown animation template.");
      clean.template = e.template;
    }
    if (e.slideText !== undefined) {
      if (!Array.isArray(e.slideText) || e.slideText.length > 60) throw new HttpError(400, "slideText must be a list of up to 60 strings.");
      clean.slideText = e.slideText.map((/** @type {unknown} */ t) => cleanText(t, 500));
    }
    if (e.labels !== undefined) {
      if (!e.labels || typeof e.labels !== "object" || Object.keys(e.labels).length > 60) throw new HttpError(400, "labels must be an object.");
      clean.labels = Object.fromEntries(Object.entries(e.labels).map(([k, v]) => [cleanText(k, 60), cleanText(v, 120)]));
    }
    if (e.popups !== undefined) {
      if (!Array.isArray(e.popups) || e.popups.length > 20) throw new HttpError(400, "popups must be a list of up to 20 items.");
      clean.popups = e.popups;
    }
    if (e.events !== undefined) {
      if (!Array.isArray(e.events) || e.events.length > 80) throw new HttpError(400, "events must be a list of up to 80 timeline items.");
      clean.events = e.events;
    }
    /** @type {Record<string, any>} */
    const edits = { ...(row.animation_edits ?? {}) };
    if (body.reset === true) delete edits[String(n)];
    else {
      if (!Object.keys(clean).length) throw new HttpError(400, "Nothing to change.");
      edits[String(n)] = { ...(row.animation_edits?.[String(n)] ?? {}), ...clean };
    }
    // AI-generated clinical content changed: any earlier approval no longer applies.
    const res2 = await q.query(
      "UPDATE courses SET animation_edits = $2::jsonb, review_status = 'none', published_at = NULL, updated_at = now() WHERE id = $1 RETURNING *",
      [row.id, JSON.stringify(edits)],
    );
    await audit(q, user.id, "course.animation.edit", row.id, { slide: n, keys: Object.keys(clean) });
    return res2.rows[0];
  });
  sendJson(res, 200, { course: toCourse(out, true) });
});

// ---------- slide images, voice previews, activity ----------

route("POST", "/courses/:id/plan", "user", async (ctx, { res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  if (!row.slides.length || BUSY.includes(row.status)) throw new HttpError(409, "This course is not ready for animation planning.");
  if (row.slides.some((/** @type {any} */ s) => !s.narration.trim())) throw new HttpError(409, "Every slide needs narration before animations can be planned.");
  const job = await enqueue(ctx.db, { courseId: row.id, ownerId: row.owner_id, kind: "plan", maxAttempts: ctx.config.jobMaxAttempts });
  sendJson(res, 202, { job: toJob(job) });
});

route("GET", "/courses/:id/slides/:n/image", "user", async (ctx, { res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  const n = Number(params.n);
  if (!row.slide_previews || !Number.isInteger(n) || n < 1 || n > Math.max(row.slide_count ?? 0, row.validation?.pptxCount ?? 0)) throw new HttpError(404, "No preview image for that slide.");
  const url = await ctx.storage.presignGet(courseKeys(row.owner_id, row.id).slideImage(n), { contentType: "image/jpeg" });
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", url);
  res.writeHead(302).end();
});

route("POST", "/courses/:id/preview", "user", async (ctx, { req, res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  if (!row.slides.length || BUSY.includes(row.status)) throw new HttpError(409, "This course is not ready for a voice preview.");
  const body = /** @type {any} */ (await readJson(req, 4096));
  const slides = parseSlideList(String(body.slides ?? "1-3"), row.slide_count ?? row.slides.length);
  if (!slides) throw new HttpError(400, `Invalid slide list "${body.slides}". Use e.g. 1-3 or 1,12 (slides 1 to ${row.slide_count}).`);
  if (slides.length > 10) throw new HttpError(400, "Preview up to 10 slides at a time.");
  const empty = slides.filter((n) => !row.slides.find((/** @type {any} */ s) => s.slide === n)?.narration.trim());
  if (empty.length) throw new HttpError(409, `Slides without narration: ${empty.join(", ")}.`);
  const job = await enqueue(ctx.db, { courseId: row.id, ownerId: row.owner_id, kind: "preview", maxAttempts: ctx.config.jobMaxAttempts, payload: { slides } });
  sendJson(res, 202, { job: toJob(job) });
});

route("GET", "/courses/:id/previews/:n", "user", async (ctx, { res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  const n = Number(params.n);
  if (!row.previews?.[String(n)]) throw new HttpError(404, "No voice preview for that slide yet.");
  const url = await ctx.storage.presignGet(courseKeys(row.owner_id, row.id).voicePreview(n), { contentType: "audio/mpeg" });
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", url);
  res.writeHead(302).end();
});

route("GET", "/activity", "user", async (ctx, { res, user }) => {
  const rows = (await ctx.db.query(
    `SELECT j.*, c.title AS course_title FROM jobs j JOIN courses c ON c.id = j.course_id
      WHERE j.owner_id = $1 AND c.deleted_at IS NULL ORDER BY j.created_at DESC LIMIT 25`,
    [user.id],
  )).rows;
  sendJson(res, 200, { activity: rows.map((j) => toJob(j)) });
});

// ---------- clinical review & publication ----------

route("POST", "/courses/:id/review/request", "user", async (ctx, { res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  if (!row.content_hash) throw new HttpError(409, "There is no content to review yet.");
  await ctx.db.query("UPDATE courses SET review_status = 'pending', review_hash = $2, review_by = NULL, review_notes = NULL, reviewed_at = NULL, updated_at = now() WHERE id = $1", [row.id, row.content_hash]);
  await audit(ctx.db, user.id, "review.request", row.id, {});
  sendJson(res, 200, { ok: true });
});

route("GET", "/reviews", "user", async (ctx, { res, user }) => {
  requireRole(user, "reviewer", "admin");
  const rows = (await ctx.db.query(
    `SELECT c.*, u.name AS owner_name, u.email AS owner_email FROM courses c JOIN users u ON u.id = c.owner_id
      WHERE c.review_status = 'pending' AND c.deleted_at IS NULL ORDER BY c.updated_at`,
  )).rows;
  sendJson(res, 200, { courses: rows.map((r) => toCourse(r)) });
});

/** Reviewers read the exact content they are asked to approve. */
route("GET", "/reviews/:id", "user", async (ctx, { res, user, params }) => {
  requireRole(user, "reviewer", "admin");
  if (!UUID_RE.test(params.id)) throw new HttpError(404, "Course not found.");
  const row = (await ctx.db.query("SELECT * FROM courses WHERE id = $1 AND review_status = 'pending' AND deleted_at IS NULL", [params.id])).rows[0];
  if (!row) throw new HttpError(404, "That course is not waiting for review.");
  await audit(ctx.db, user.id, "review.open", row.id, {});
  sendJson(res, 200, { course: toCourse(row, true) });
});

route("POST", "/courses/:id/review", "user", async (ctx, { req, res, user, params }) => {
  requireRole(user, "reviewer", "admin");
  const body = /** @type {any} */ (await readJson(req, 16 * 1024));
  const decision = body.decision;
  if (decision !== "approved" && decision !== "rejected") throw new HttpError(400, "decision must be approved or rejected.");
  const notes = cleanText(body.notes, 4000).trim();
  if (decision === "rejected" && !notes) throw new HttpError(400, "Explain what needs to change when rejecting.");
  if (!UUID_RE.test(params.id)) throw new HttpError(404, "Course not found.");
  const owner = (await ctx.db.query("SELECT owner_id FROM courses WHERE id = $1", [params.id])).rows[0]?.owner_id;
  if (owner === user.id && !ctx.config.allowSelfReview) throw new HttpError(403, "A different medical reviewer must review your own course.");
  const out = await ctx.db.query(
    `UPDATE courses SET review_status = $2, review_by = $3, review_notes = $4, reviewed_at = now(), updated_at = now()
      WHERE id = $1 AND review_status = 'pending' AND review_hash = content_hash AND deleted_at IS NULL RETURNING id`,
    [params.id, decision, user.id, notes || null],
  );
  if (!out.rows[0]) throw new HttpError(409, "That course is not waiting for review, or its content changed after the request. Ask the author to request review again.");
  await audit(ctx.db, user.id, `review.${decision}`, params.id, { notes });
  sendJson(res, 200, { ok: true });
});

route("POST", "/courses/:id/publish", "user", async (ctx, { res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  if (row.status !== "complete" || !row.outputs.video) throw new HttpError(409, "Generate the video before publishing.");
  if (row.built_hash !== row.content_hash) throw new HttpError(409, "The video is out of date with your edits. Generate it again first.");
  if (row.review_status !== "approved" || row.review_hash !== row.content_hash) {
    throw new HttpError(409, "A medical reviewer must approve the current content before it can be published.");
  }
  await ctx.db.query("UPDATE courses SET published_at = now(), updated_at = now() WHERE id = $1", [row.id]);
  await audit(ctx.db, user.id, "course.publish", row.id, {});
  sendJson(res, 200, { ok: true });
});

route("POST", "/courses/:id/unpublish", "user", async (ctx, { res, user, params }) => {
  const row = await mine(ctx, user, params.id);
  await ctx.db.query("UPDATE courses SET published_at = NULL, updated_at = now() WHERE id = $1", [row.id]);
  sendJson(res, 200, { ok: true });
});

// ---------- files ----------

route("GET", "/courses/:id/files/:name", "user", async (ctx, { req, res, user, params, url }) => {
  const row = await mine(ctx, user, params.id);
  const spec = /** @type {Record<string, { name: string, type: string }>} */ (OUTPUT_FILES)[params.name ?? ""];
  const out = row.outputs?.[params.name ?? ""];
  if (!spec || !out) throw new HttpError(404, "That file is not available.");
  const download = url.searchParams.has("download");
  const filename = `${row.title.replace(/[^\w.-]+/g, "-").slice(0, 60)}-${spec.name}${row.published_at ? "" : ""}`;
  if (params.name === "video" || params.name === "thumbnail" || params.name === "animated") {
    const signed = await ctx.storage.presignGet(out.key, { contentType: spec.type, ...(download ? { filename } : {}) });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", signed);
    res.writeHead(302).end();
    return;
  }
  const buf = await ctx.storage.readBuffer(out.key, 20 * 1024 * 1024);
  res.setHeader("Content-Type", spec.type);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (download) res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`);
  res.writeHead(200);
  res.end(req.method === "HEAD" ? undefined : buf);
});

// ---------- jobs ----------

route("GET", "/jobs/:id", "user", async (ctx, { res, user, params }) => {
  if (!UUID_RE.test(params.id)) throw new HttpError(404, "Job not found.");
  const j = (await ctx.db.query("SELECT j.*, c.title AS course_title FROM jobs j JOIN courses c ON c.id = j.course_id WHERE j.id = $1 AND j.owner_id = $2", [params.id, user.id])).rows[0];
  if (!j) throw new HttpError(404, "Job not found.");
  sendJson(res, 200, { job: toJob(j, true) });
});

route("POST", "/jobs/:id/cancel", "user", async (ctx, { res, user, params }) => {
  const result = await requestCancel(ctx.db, params.id, (j) => j.owner_id === user.id);
  await audit(ctx.db, user.id, "job.cancel", params.id, {});
  sendJson(res, 202, { result });
});

route("POST", "/jobs/:id/retry", "user", async (ctx, { res, user, params }) => {
  const job = await retryJob(ctx.db, params.id, (j) => j.owner_id === user.id);
  await audit(ctx.db, user.id, "job.retry", params.id, {});
  sendJson(res, 202, { job: toJob(job) });
});

// ---------- administration ----------

route("GET", "/admin/overview", "user", async (ctx, { res, user }) => {
  requireRole(user, "admin");
  const q = ctx.db;
  const [users, jobs, courses, storage, failed] = await Promise.all([
    q.query("SELECT status, count(*)::int AS n FROM users GROUP BY status"),
    q.query("SELECT status, count(*)::int AS n FROM jobs GROUP BY status"),
    q.query("SELECT status, count(*)::int AS n FROM courses WHERE deleted_at IS NULL GROUP BY status"),
    q.query(`SELECT COALESCE(sum(COALESCE(pptx_bytes,0) + COALESCE(docx_bytes,0)
              + COALESCE((outputs->'video'->>'bytes')::bigint,0) + COALESCE((outputs->'thumbnail'->>'bytes')::bigint,0)),0)::bigint AS bytes
             FROM courses WHERE deleted_at IS NULL`),
    q.query("SELECT j.*, c.title AS course_title FROM jobs j JOIN courses c ON c.id = j.course_id WHERE j.status = 'failed' ORDER BY j.finished_at DESC LIMIT 20"),
  ]);
  const tally = (/** @type {any[]} */ rows) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  sendJson(res, 200, {
    users: tally(users.rows), jobs: tally(jobs.rows), courses: tally(courses.rows),
    storageBytes: Number(storage.rows[0].bytes), failedJobs: failed.rows.map((j) => toJob(j)),
  });
});

route("GET", "/admin/users", "user", async (ctx, { res, user }) => {
  requireRole(user, "admin");
  const rows = (await ctx.db.query(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at,
            (SELECT count(*)::int FROM courses c WHERE c.owner_id = u.id AND c.deleted_at IS NULL) AS courses,
            (SELECT COALESCE(sum(COALESCE(pptx_bytes,0) + COALESCE(docx_bytes,0) + COALESCE((outputs->'video'->>'bytes')::bigint,0)),0)::bigint
               FROM courses c WHERE c.owner_id = u.id AND c.deleted_at IS NULL) AS storage_bytes
       FROM users u ORDER BY u.created_at`,
  )).rows;
  sendJson(res, 200, { users: rows.map((r) => ({ ...publicUser(r), createdAt: r.created_at, lastLoginAt: r.last_login_at, courses: r.courses, storageBytes: Number(r.storage_bytes) })) });
});

route("PATCH", "/admin/users/:id", "user", async (ctx, { req, res, user, params }) => {
  requireRole(user, "admin");
  const body = /** @type {any} */ (await readJson(req, 4096));
  if (!UUID_RE.test(params.id)) throw new HttpError(404, "User not found.");
  if (params.id === user.id) throw new HttpError(409, "You cannot change your own role or status.");
  const sets = [];
  /** @type {unknown[]} */
  const vals = [params.id];
  if (body.status !== undefined) {
    if (!["active", "disabled", "pending"].includes(body.status)) throw new HttpError(400, "Invalid status.");
    vals.push(body.status);
    sets.push(`status = $${vals.length}`);
  }
  if (body.role !== undefined) {
    if (!["user", "reviewer", "admin"].includes(body.role)) throw new HttpError(400, "Invalid role.");
    vals.push(body.role);
    sets.push(`role = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, "Nothing to change.");
  const out = await ctx.db.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1 RETURNING id, email, name, role, status`, vals);
  if (!out.rows[0]) throw new HttpError(404, "User not found.");
  if (body.status === "disabled") await ctx.db.query("DELETE FROM sessions WHERE user_id = $1", [params.id]);
  await audit(ctx.db, user.id, "admin.user.update", params.id, { status: body.status, role: body.role });
  sendJson(res, 200, { user: publicUser(out.rows[0]) });
});

route("GET", "/admin/jobs", "user", async (ctx, { res, user, url }) => {
  requireRole(user, "admin");
  const status = url.searchParams.get("status");
  const rows = (await ctx.db.query(
    `SELECT j.*, c.title AS course_title FROM jobs j JOIN courses c ON c.id = j.course_id
      WHERE ($1::text IS NULL OR j.status = $1) ORDER BY j.created_at DESC LIMIT 100`,
    [status && /^[a-z]+$/.test(status) ? status : null],
  )).rows;
  sendJson(res, 200, { jobs: rows.map((j) => toJob(j)) });
});

route("GET", "/admin/jobs/:id", "user", async (ctx, { res, user, params }) => {
  requireRole(user, "admin");
  if (!UUID_RE.test(params.id)) throw new HttpError(404, "Job not found.");
  const j = (await ctx.db.query("SELECT j.*, c.title AS course_title FROM jobs j JOIN courses c ON c.id = j.course_id WHERE j.id = $1", [params.id])).rows[0];
  if (!j) throw new HttpError(404, "Job not found.");
  sendJson(res, 200, { job: toJob(j, true) });
});

route("POST", "/admin/jobs/:id/cancel", "user", async (ctx, { res, user, params }) => {
  requireRole(user, "admin");
  const result = await requestCancel(ctx.db, params.id, () => true);
  await audit(ctx.db, user.id, "admin.job.cancel", params.id, {});
  sendJson(res, 202, { result });
});

route("POST", "/admin/jobs/:id/retry", "user", async (ctx, { res, user, params }) => {
  requireRole(user, "admin");
  const job = await retryJob(ctx.db, params.id, () => true);
  await audit(ctx.db, user.id, "admin.job.retry", params.id, {});
  sendJson(res, 202, { job: toJob(job) });
});

route("GET", "/admin/courses", "user", async (ctx, { res, user }) => {
  requireRole(user, "admin");
  const rows = (await ctx.db.query(
    `SELECT c.*, u.name AS owner_name, u.email AS owner_email FROM courses c JOIN users u ON u.id = c.owner_id
      WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 200`,
  )).rows;
  sendJson(res, 200, { courses: rows.map((r) => toCourse(r)) });
});

route("DELETE", "/admin/courses/:id", "user", async (ctx, { res, user, params }) => {
  requireRole(user, "admin");
  if (!UUID_RE.test(params.id)) throw new HttpError(404, "Course not found.");
  const row = (await ctx.db.query("UPDATE courses SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL AND status <> ALL($2) RETURNING owner_id, id", [params.id, BUSY])).rows[0];
  if (!row) throw new HttpError(409, "Course not found, or a job is still running for it. Cancel the job first.");
  await ctx.storage.removePrefix(`${courseKeys(row.owner_id, row.id).base}/`);
  await audit(ctx.db, user.id, "admin.course.delete", params.id, {});
  sendJson(res, 200, { ok: true });
});

registerEditorRoutes({ route, mine, readJson, sendJson, toCourse, BUSY });

// ---------- dispatcher ----------

/** @param {Req} req @param {{ allowedOrigins: string[] }} config */
export function checkCsrf(req, config) {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  if (req.headers["x-requested-with"] !== "doctyn") throw new HttpError(403, "Missing request header.");
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, "Bad origin.");
    }
    if (host !== req.headers.host && !config.allowedOrigins.includes(origin)) throw new HttpError(403, "Cross-site request blocked.");
  }
}

/** @param {Ctx} ctx @param {Req} req @param {Res} res */
export async function handleApi(ctx, req, res) {
  try {
    normalizeRouteUrl(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname.replace(/^\/api\/v3/, "").replace(/\/+$/, "") || "/";
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");

    if (pathname.startsWith("/storage/") && ctx.storage.serveFs) {
      return await ctx.storage.serveFs(pathname.slice("/storage/".length), req, res);
    }
    checkCsrf(req, ctx.config);

    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      let user = null;
      if (r.auth === "user") {
        user = await userForToken(ctx.db, sessionTokenFromCookie(req.headers.cookie));
        if (!user) throw new HttpError(401, "Please sign in.");
      }
      await r.handler(ctx, { req, res, url, user, params: { ...m.groups } });
      return;
    }
    throw new HttpError(404, `No API route ${req.method} ${pathname}`);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error("[api]", err);
    if (res.headersSent) return void res.destroy();
    sendJson(res, status, { error: status === 500 ? "Something went wrong on the server." : /** @type {Error} */ (err).message });
  }
}
