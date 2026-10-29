// The slide editor's HTTP API (registered into the /api/v3 router by cloud/routes.js).
// Every route works on a course the signed-in user owns: another user's course answers 404, exactly like the rest of the API.
// @ts-nocheck
import { HttpError, audit } from "../auth.js";
import { UUID_RE, cleanText, contentHash, courseKeys } from "../util.js";
import { MAX_SLIDES, normalizeDeckSlides, remapByNumber, renumber, suggestForSlide, withIdentity } from "./model.js";
import { extractDeck } from "./pptx.js";

const AUTO_KEEP = 40;
const AUTO_MERGE_SECONDS = 300;

/** Course row locked for the duration of a transaction. */
async function lockMine(q, user, id) {
  const row = (await q.query("SELECT * FROM courses WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE", [UUID_RE.test(id) ? id : "00000000-0000-0000-0000-000000000000", user.id])).rows[0];
  if (!row) throw new HttpError(404, "Course not found.");
  return row;
}

const versionRow = (v) => ({ id: v.id, kind: v.kind, label: v.label, createdAt: v.created_at, slideCount: v.slide_count ?? v.slides?.length ?? 0, title: v.title });
const VERSION_LIST = "SELECT id, kind, label, title, created_at, jsonb_array_length(slides) AS slide_count FROM course_versions WHERE course_id = $1 ORDER BY created_at DESC LIMIT 60";

async function snapshot(q, row, kind, label, state) {
  const slides = state?.slides ?? row.slides;
  await q.query(
    "INSERT INTO course_versions(course_id, owner_id, kind, label, title, slides, animation_edits, content_hash) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)",
    [row.id, row.owner_id, kind, label, state?.title ?? row.title, JSON.stringify(slides), JSON.stringify(state?.animationEdits ?? row.animation_edits ?? {}), state?.hash ?? row.content_hash],
  );
}

/** Autosaves update the newest automatic version while it is recent, so history is a handful of useful points, not one per keystroke. */
async function autoVersion(q, row, state) {
  const last = (await q.query("SELECT id, kind, created_at FROM course_versions WHERE course_id = $1 ORDER BY created_at DESC LIMIT 1", [row.id])).rows[0];
  if (last?.kind === "auto" && Date.now() - new Date(last.created_at).getTime() < AUTO_MERGE_SECONDS * 1000) {
    await q.query("UPDATE course_versions SET title = $2, slides = $3::jsonb, animation_edits = $4::jsonb, content_hash = $5 WHERE id = $1", [last.id, state.title, JSON.stringify(state.slides), JSON.stringify(state.animationEdits), state.hash]);
  } else {
    await snapshot(q, row, "auto", "Autosave", state);
  }
  await q.query(
    "DELETE FROM course_versions WHERE course_id = $1 AND kind = 'auto' AND id NOT IN (SELECT id FROM course_versions WHERE course_id = $1 AND kind = 'auto' ORDER BY created_at DESC LIMIT $2)",
    [row.id, AUTO_KEEP],
  );
}

/** Pages in the uploaded presentation (the limit for a slide's `origin.page`). */
const pageCountOf = (row) => Number(row.editor_shapes?.pageCount ?? row.validation?.pptxCount ?? row.slide_count ?? 0);

/**
 * Replace the slide list. Everything keyed by slide number (animation edits, the planned animations, voice previews) follows the
 * slides it belongs to, a changed course needs a new clinical review, and the video on record becomes "out of date".
 */
async function applyDeck(q, user, row, { title, slides, animationEdits, kind }) {
  const old = withIdentity(row.slides);
  const moves = renumber(old, slides);
  const numbered = slides.map((s, i) => ({ ...s, slide: i + 1 }));
  const hash = contentHash(title, numbered);
  const changed = hash !== row.content_hash;
  const edits = animationEdits ?? remapByNumber(row.animation_edits ?? {}, moves);
  const plan = row.animation
    ? { ...row.animation, slides: (row.animation.slides ?? []).map((p) => { const m = moves.find((x) => x.from === p.slide); return m ? { ...p, slide: m.to } : null; }).filter(Boolean) }
    : null;
  // Voice previews are stored per slide number: keep only those whose slide did not move.
  const previews = Object.fromEntries(Object.entries(row.previews ?? {}).filter(([n]) => moves.some((m) => m.from === Number(n) && m.to === Number(n))));
  const resolved = row.status === "invalid" && numbered.every((s) => s.narration.trim());
  const res = await q.query(
    `UPDATE courses SET title = $2, slides = $3::jsonb, slide_count = $4, content_hash = $5, animation_edits = $6::jsonb, animation = $7::jsonb, previews = $8::jsonb,
            editor_rev = editor_rev + 1,
            status = CASE WHEN $9 THEN 'parsed' ELSE status END,
            error = CASE WHEN $9 THEN NULL ELSE error END,
            validation = CASE WHEN $9 THEN COALESCE(validation, '{}'::jsonb) || '{"ok":true,"resolvedByEdit":true}'::jsonb ELSE validation END,
            review_status = CASE WHEN $10 THEN 'none' ELSE review_status END,
            published_at = CASE WHEN $10 THEN NULL ELSE published_at END,
            updated_at = now() WHERE id = $1 RETURNING *`,
    [row.id, title, JSON.stringify(numbered), numbered.length, hash, JSON.stringify(edits), plan ? JSON.stringify(plan) : null, JSON.stringify(previews), resolved, changed],
  );
  if (changed) await audit(q, user.id, kind === "restore" ? "course.editor.restore" : "course.editor.save", row.id, { slides: numbered.length, reviewReset: row.review_status !== "none" });
  return { row: res.rows[0], state: { title, slides: numbered, animationEdits: edits, hash }, changed };
}

/** @param {{ route: Function, mine: Function, readJson: Function, sendJson: Function, toCourse: Function, BUSY: string[] }} api */
export function registerEditorRoutes({ route, mine, readJson, sendJson, toCourse, BUSY }) {
  route("GET", "/courses/:id/editor", "user", async (ctx, { res, user, params }) => {
    let row = await mine(ctx, user, params.id);
    if (!row.slides?.length) throw new HttpError(409, "The slides have not been read from your files yet. Upload a presentation and a script first.");
    // Courses uploaded before the editor existed get stable slide ids (nothing visible changes).
    if (row.slides.some((s) => !s.uid)) {
      row = (await ctx.db.query("UPDATE courses SET slides = $2::jsonb WHERE id = $1 RETURNING *", [row.id, JSON.stringify(withIdentity(row.slides))])).rows[0];
    }
    let deckError = null;
    if (!row.editor_shapes) {
      try {
        if (!row.pptx_key) throw new Error("no presentation");
        const deck = await extractDeck(await ctx.storage.readBuffer(row.pptx_key, 150 * 1024 * 1024));
        row = (await ctx.db.query("UPDATE courses SET editor_shapes = $2::jsonb WHERE id = $1 RETURNING *", [row.id, JSON.stringify(deck)])).rows[0];
      } catch (err) {
        deckError = "The shapes on your slides could not be read, so text positions cannot be edited. You can still edit narration, titles, and slide order.";
        console.error("[editor] could not read the deck", err);
      }
    }
    if (!(await ctx.db.query("SELECT 1 FROM course_versions WHERE course_id = $1 LIMIT 1", [row.id])).rows[0]) {
      await snapshot(ctx.db, row, "original", "When slide editing began");
    }
    const versions = (await ctx.db.query(VERSION_LIST, [row.id])).rows.map(versionRow);
    const jobs = (await ctx.db.query("SELECT * FROM jobs WHERE course_id = $1 ORDER BY created_at DESC LIMIT 1", [row.id])).rows;
    sendJson(res, 200, {
      course: toCourse({ ...row, job: jobs[0] }, true),
      rev: row.editor_rev,
      deck: row.editor_shapes ?? { slideSize: { cx: 12192000, cy: 6858000 }, pageCount: pageCountOf(row), pages: {} },
      deckError,
      versions,
      maxSlides: MAX_SLIDES,
    });
  });

  route("PUT", "/courses/:id/editor", "user", async (ctx, { req, res, user, params }) => {
    const body = await readJson(req, 4 * 1024 * 1024);
    const out = await ctx.db.tx(async (q) => {
      const row = await lockMine(q, user, params.id);
      if (BUSY.includes(row.status)) throw new HttpError(409, "This course is being processed. Edit it when the job has finished.");
      if (Number(body.rev) !== row.editor_rev) throw new HttpError(409, "This course was changed somewhere else (another tab or device). Reload the editor to continue from the latest saved version.");
      const title = cleanText(body.title ?? row.title, 200).trim();
      if (!title) throw new HttpError(400, "The title cannot be empty.");
      const slides = normalizeDeckSlides(body.slides, pageCountOf(row), withIdentity(row.slides));
      const applied = await applyDeck(q, user, row, { title, slides });
      if (applied.changed) await autoVersion(q, row, applied.state);
      return applied.row;
    });
    sendJson(res, 200, { course: toCourse(out, true), rev: out.editor_rev });
  });

  route("GET", "/courses/:id/editor/versions", "user", async (ctx, { res, user, params }) => {
    const row = await mine(ctx, user, params.id);
    sendJson(res, 200, { versions: (await ctx.db.query(VERSION_LIST, [row.id])).rows.map(versionRow), currentHash: row.content_hash });
  });

  route("POST", "/courses/:id/editor/versions", "user", async (ctx, { req, res, user, params }) => {
    const body = await readJson(req, 4096);
    const label = cleanText(body.label, 80).trim() || "Saved version";
    await ctx.db.tx(async (q) => {
      const row = await lockMine(q, user, params.id);
      await snapshot(q, row, "manual", label);
    });
    sendJson(res, 201, { versions: (await ctx.db.query(VERSION_LIST, [(await mine(ctx, user, params.id)).id])).rows.map(versionRow) });
  });

  route("POST", "/courses/:id/editor/versions/:vid/restore", "user", async (ctx, { res, user, params }) => {
    if (!UUID_RE.test(params.vid)) throw new HttpError(404, "Version not found.");
    const out = await ctx.db.tx(async (q) => {
      const row = await lockMine(q, user, params.id);
      if (BUSY.includes(row.status)) throw new HttpError(409, "This course is being processed. Restore a version when the job has finished.");
      const v = (await q.query("SELECT * FROM course_versions WHERE id = $1 AND course_id = $2 AND owner_id = $3", [params.vid, row.id, user.id])).rows[0];
      if (!v) throw new HttpError(404, "Version not found.");
      // The state being replaced is kept, so a restore can itself be undone.
      await snapshot(q, row, "restore", `Before restoring “${v.label || v.kind}”`);
      const slides = normalizeDeckSlides(v.slides, pageCountOf(row), withIdentity(row.slides));
      const applied = await applyDeck(q, user, row, { title: v.title, slides, animationEdits: v.animation_edits ?? {}, kind: "restore" });
      return applied.row;
    });
    sendJson(res, 200, { course: toCourse(out, true), rev: out.editor_rev });
  });

  route("POST", "/courses/:id/editor/suggest", "user", async (ctx, { req, res, user, params }) => {
    await mine(ctx, user, params.id);
    const body = await readJson(req, 64 * 1024);
    const texts = Array.isArray(body.texts) ? body.texts.slice(0, 40).map((t) => cleanText(t, 1000)) : [];
    sendJson(res, 200, {
      engine: "rules",
      note: "Suggestions are generated locally from the slide's own text and narration. Nothing is applied until you accept it.",
      suggestions: suggestForSlide({ title: cleanText(body.title, 300), narration: cleanText(body.narration, 20000), texts }),
    });
  });

  // The files the user uploaded are kept untouched; they can always be downloaded again.
  route("GET", "/courses/:id/editor/original/:type", "user", async (ctx, { res, user, params }) => {
    const row = await mine(ctx, user, params.id);
    const type = params.type;
    if (type !== "pptx" && type !== "docx") throw new HttpError(404, "File not found.");
    const key = row[`${type}_key`];
    if (!key) throw new HttpError(404, "File not found.");
    const contentType = type === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const url = await ctx.storage.presignGet(key, { contentType, filename: row[`${type}_name`] || `original.${type}` });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", url);
    res.writeHead(302).end();
  });
  void courseKeys;
}
