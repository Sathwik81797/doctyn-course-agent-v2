import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cloudConfig } from "../cloud/config.js";
import { createDb } from "../cloud/db.js";
import { extractDeck } from "../cloud/editor/pptx.js";
import { buildEditedPptx, hasDeckEdits } from "../cloud/editor/pptx-write.js";
import { criticalTokens, normalizeDeckSlides, normalizeEdits, suggestForSlide } from "../cloud/editor/model.js";
import { handleApi, type Ctx } from "../cloud/routes.js";
import { createStorage } from "../cloud/storage.js";
import { contentHash, courseKeys } from "../cloud/util.js";
import * as M from "../public/studio-model.js";
import { readSlideTexts } from "../src/animation/pptx-text.js";
import { convertPptxToPdf, rasterizePdf } from "../src/services/render-slides.js";
import { parseDocx } from "../src/services/parse-docx.js";
import { parsePptx } from "../src/services/parse-pptx.js";
import { loadConfig } from "../src/utils/config.js";
import { applyDeckEdits } from "../src/worker/plan.js";
import { buildVoiceoverDocx } from "../src/worker/docx-builder.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sepsis", "Doctyn_V2_Sepsis_Demo_Slides.pptx");

// ---------------------------------------------------------------- the editor's data operations

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ uid: `s${i + 1}`, origin: { page: i + 1 }, title: `Title ${i + 1}`, narration: `Narration ${i + 1}`, edits: {}, pptxTitle: "", pptxText: [] as string[] }));

describe("editing slides in the workspace (data operations)", () => {
  it("adds, duplicates, deletes and moves slides; the narration always travels with its slide", () => {
    let slides: any[] = mk(4);
    slides = M.moveSlide(slides, 0, 2).slides; // slide 1 now third
    assert.deepEqual(M.pairing(slides).map((p: any) => [p.uid, p.narration]), [["s2", "Narration 2"], ["s3", "Narration 3"], ["s1", "Narration 1"], ["s4", "Narration 4"]]);
    const dup = M.duplicateSlide(slides, 1);
    assert.equal(dup.slides.length, 5);
    assert.equal(dup.slides[2].narration, "Narration 3", "a duplicate carries a copy of the narration");
    assert.notEqual(dup.slides[2].uid, dup.slides[1].uid);
    const added = M.insertSlide(dup.slides, 0);
    assert.equal(added.slides[1].origin, null);
    assert.equal(added.slides[1].narration, "");
    const del = M.deleteSlide(added.slides, 1);
    assert.equal(del.slides.length, 5);
    assert.equal(M.deleteSlide([mk(1)[0]], 0).slides.length, 1, "the last slide cannot be deleted");
  });

  it("undoes and redoes, merging rapid typing into one step", () => {
    const h = new M.History();
    h.push("a", "typing", 1000);
    h.push("a2", "typing", 1200); // same burst
    h.push("b", "", 5000);
    assert.equal(h.undoStack.length, 2);
    assert.equal(h.undo("c"), "b");
    assert.equal(h.undo("b"), "a");
    assert.equal(h.undo("a"), null);
    assert.equal(h.redo("a"), "b");
    h.push("x", "", 9000);
    assert.equal(h.canRedo, false, "a new edit discards the redo stack");
  });

  it("builds editable diagrams whose arrows follow the boxes", () => {
    const slide: any = { edits: {} };
    const els: any[] = M.insertDiagram(slide, "flowchart", ["Recognise", "Assess", "Escalate"]);
    const boxes = els.filter((e: any) => e.type !== "arrow");
    const arrows = els.filter((e: any) => e.type === "arrow");
    assert.equal(boxes.length, 3);
    assert.equal(arrows.length, 2);
    const before = { x1: arrows[0].x1, x2: arrows[0].x2 };
    M.patchAdded(slide, boxes[1].id, { y: boxes[1].y + 0.2 });
    assert.notEqual(arrows[0].y2, boxes[0].y + boxes[0].h / 2, "the arrow end moved with the box");
    assert.equal(before.x1, arrows[0].x1);
    M.removeAdded(slide, boxes[1].id);
    assert.ok(slide.edits.added.every((e: any) => e.from !== boxes[1].id && e.to !== boxes[1].id), "no arrow keeps pointing at a deleted box");
    for (const k of ["decision", "pathway", "compare", "cycle"]) assert.ok(M.diagramTemplate(k).length >= 4, k);
  });
});

describe("what the browser may send", () => {
  it("clamps and whitelists visual edits", () => {
    const e: any = normalizeEdits({
      shapes: { "4": { x: 9, w: -3, size: 5000, font: "Comic Sans", color: "red", text: ["ok"], evil: 1 }, "x": { x: 1 } },
      added: [{ id: "a b!", type: "rect", x: 0.2, y: 0.2, w: 0.2, h: 0.1, fill: "#12ab34", script: "x" }, { id: "z", type: "unknown" }],
      bg: "javascript:1",
    });
    assert.deepEqual(Object.keys(e.shapes), ["4"]);
    assert.equal(e.shapes["4"].x, 2);
    assert.equal(e.shapes["4"].w, 0.005);
    assert.equal(e.shapes["4"].size, 200);
    assert.equal(e.shapes["4"].font, undefined);
    assert.equal(e.shapes["4"].color, undefined);
    assert.equal(e.added.length, 1);
    assert.equal(e.added[0].id, "ab");
    assert.equal(e.added[0].fill, "#12AB34");
    assert.equal(e.bg, undefined);
  });

  it("rejects a slide list that points outside the uploaded presentation", () => {
    assert.throws(() => normalizeDeckSlides([{ uid: "a", origin: { page: 12 }, title: "x", narration: "" }], 9), /page 12/);
    assert.throws(() => normalizeDeckSlides([{ uid: "a", title: "x" }, { uid: "a", title: "y" }], 9), /repeated id/);
    assert.throws(() => normalizeDeckSlides([], 9), /at least one slide/);
  });
});

describe("Improve Slide Content", () => {
  it("proposes tighter narration without touching numbers, doses or drug names", () => {
    const narration = "In order to treat septic shock, it is important to note that 30 mL/kg of crystalloid should be given. Basically, start norepinephrine if MAP stays below 65 mmHg.";
    const s = suggestForSlide({ title: "Sepsis", narration, texts: [] }).find((x) => x.id === "narration-tighten");
    assert.ok(s, "a tightening is proposed");
    assert.deepEqual(criticalTokens(s!.after), criticalTokens(narration));
    assert.match(s!.after, /^To treat septic shock/);
  });

  it("proposes a flowchart and animation, marks them clinical, and applies nothing by itself", () => {
    const list = suggestForSlide({ title: "Escalation workflow", narration: "First recognise the signs. Then assess organ function. Next escalate to critical care. Finally reassess response.", texts: ["Recognise", "Assess", "Escalate", "Reassess"] });
    const diagram = list.find((x) => x.kind === "diagram");
    assert.ok(diagram?.clinical, "diagram content is flagged for checking");
    assert.equal(diagram!.apply!.type, "diagram");
    assert.ok(list.some((x) => x.kind === "animation"));
    const slide: any = { narration: "x", edits: {} };
    assert.equal(slide.edits.added, undefined, "suggesting does not change the slide");
    M.applySuggestion(slide, diagram, []);
    assert.ok(slide.edits.added.length >= 4, "only accepting adds it");
  });

  it("reminds the author to verify figures", () => {
    const list = suggestForSlide({ title: "Dosing", narration: "Give 500 mg every 6 hours.", texts: [] });
    assert.ok(list.some((x) => x.kind === "check" && /500mg/.test(x.after)));
  });
});

// ---------------------------------------------------------------- the edited PPTX (what the video is built from)

describe("writing the edited presentation", () => {
  it("reorders, duplicates, deletes and adds slides and applies text and shape edits", async () => {
    const buf = await fs.readFile(FIXTURE);
    const deck: any = await extractDeck(buf);
    assert.equal(deck.pageCount, 9);
    const titleShape = deck.pages["2"].shapes.find((s: any) => s.paras?.[0] === "Sepsis: Recognize, Assess, Respond") ?? deck.pages["2"].shapes.find((s: any) => s.kind === "text");
    assert.ok(titleShape);
    const slides = [
      { origin: { page: 3 } },
      { origin: { page: 2 }, edits: { shapes: { [titleShape.id]: { text: ["A NEW HEADING"], x: 0.2, bold: true, color: "#CC0000", size: 40 } }, added: [{ id: "b1", type: "round", x: 0.1, y: 0.7, w: 0.3, h: 0.1, text: "Added box" }, { id: "a1", type: "arrow", x1: 0.4, y1: 0.75, x2: 0.6, y2: 0.75 }] } },
      { origin: { page: 2 } },
      { origin: null, edits: { bg: "#F0F0F0", added: [{ id: "t1", type: "text", x: 0.1, y: 0.1, w: 0.8, h: 0.1, text: "Brand new slide", size: 36 }] } },
    ];
    assert.ok(hasDeckEdits(slides as any, 9));
    const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "edited-")), "edited.pptx");
    await fs.writeFile(out, await buildEditedPptx(buf, slides as any, deck));
    const info = await parsePptx(out);
    assert.equal(info.slideCount, 4);
    const texts = await readSlideTexts(out, info.slides.map((s) => s.entry));
    const original = await readSlideTexts(FIXTURE, (await parsePptx(FIXTURE)).slides.map((s) => s.entry));
    assert.deepEqual(texts[0], original[2], "page 3 moved to the front");
    assert.ok(texts[1]!.includes("A NEW HEADING") && texts[1]!.includes("Added box"), "text and added shapes are in the slide");
    assert.deepEqual(texts[2], original[1], "the duplicate is the untouched original page 2");
    assert.ok(!texts[2]!.includes("A NEW HEADING"), "edits stay on the slide they were made on");
    assert.deepEqual(texts[3], ["Brand new slide"]);
    const zip = await (await import("jszip")).default.loadAsync(await fs.readFile(out));
    const xml = await zip.file("ppt/slides/slide2.xml")!.async("string");
    assert.match(xml, /flipV|prst="straightConnector1"/);
    assert.match(xml, /<a:tailEnd type="triangle"/);
  });

  it("leaves a course untouched until it has edits", async () => {
    const same = Array.from({ length: 9 }, (_, i) => ({ origin: { page: i + 1 }, edits: {} }));
    assert.equal(hasDeckEdits(same as any, 9), false);
    assert.equal(hasDeckEdits(same.slice(1) as any, 9), true);
    const unedited = await applyDeckEdits({ slides: same, validation: { pptxCount: 9 } }, FIXTURE + ".none").catch(() => "not touched");
    assert.equal(unedited, false);
  });

  it("renders the modified slides with LibreOffice (skipped when it is not installed)", async (t) => {
    const buf = await fs.readFile(FIXTURE);
    const deck: any = await extractDeck(buf);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "render-edited-"));
    const pptx = path.join(dir, "presentation.pptx");
    await fs.writeFile(pptx, await buildEditedPptx(buf, [{ origin: { page: 4 } }, { origin: null, edits: { added: [{ id: "t1", type: "text", x: 0.1, y: 0.1, w: 0.8, h: 0.2, text: "Hello editor", size: 44 }, { id: "r1", type: "diamond", x: 0.3, y: 0.5, w: 0.3, h: 0.3, text: "Decision?" }] } }, { origin: { page: 1 } }] as any, deck));
    const config = loadConfig();
    let pdf: string;
    try {
      pdf = await convertPptxToPdf({ pptx, workDir: path.join(dir, "pdf"), config, exportHiddenSlides: false });
    } catch (err) {
      if (/LibreOffice/i.test(String(err instanceof Error ? err.message : err))) return t.skip("LibreOffice is not installed");
      throw err;
    }
    const { pngs } = await rasterizePdf({ pdf, slidesDir: path.join(dir, "png"), workDir: path.join(dir, "pdf"), expectedPages: 3, config });
    assert.equal(pngs.length, 3, "one image per edited slide");
    const sharp = (await import("sharp")).default;
    const meta = await sharp(pngs[1]!).metadata();
    assert.equal(meta.width, 1920);
    // the new slide is not blank: the added text and diamond were drawn
    const stats = await sharp(pngs[1]!).stats();
    assert.ok(stats.channels.some((c) => c.stdev > 5), "the added shapes are visible in the rendered image");
  });
});

// ---------------------------------------------------------------- the website API

let server: http.Server;
let base = "";
let ctx: Ctx;
let tmp = "";

async function call(method: string, p: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${base}${p}`, { method, redirect: "manual", headers: { "x-requested-with": "doctyn", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  const set = res.headers.get("set-cookie");
  return { status: res.status, body: parsed, headers: res.headers, ...(set ? { cookie: set.split(";")[0]! } : {}) };
}

async function signedIn(email: string): Promise<string> {
  const pw = "correct horse battery";
  assert.equal((await call("POST", "/api/v3/auth/register", { email, name: email.split("@")[0], password: pw })).status, 201);
  await ctx.db.query("UPDATE users SET status = 'active' WHERE email = $1", [email]);
  return (await call("POST", "/api/v3/auth/login", { email, password: pw })).cookie!;
}

/** A parsed course exactly as the engine's parse job leaves it, built from the real sepsis files. */
async function parsedCourse(owner: string, title = "Sepsis"): Promise<{ id: string; ownerId: string; slides: any[] }> {
  const created = await call("POST", "/api/v3/courses", { title }, owner);
  const id = created.body.course.id as string;
  const ownerId = created.body.course.ownerId as string;
  const pptxKey = courseKeys(ownerId, id).source("pptx", "abcdef");
  const tmpFile = path.join(tmp, `${id}.pptx`);
  await fs.copyFile(FIXTURE, tmpFile);
  await ctx.storage.uploadFromFile(pptxKey, tmpFile, "application/octet-stream");
  const pptx = await parsePptx(FIXTURE);
  const docx = await parseDocx(path.join(import.meta.dirname, "fixtures", "sepsis", "Doctyn_V2_Sepsis_Demo_Voiceover.docx"));
  const slides = pptx.slides.map((s, i) => ({ slide: s.number, title: docx.records[i]?.title || `Slide ${s.number}`, narration: docx.records[i]?.text ?? "", pptxTitle: s.title, pptxText: [] }));
  await ctx.db.query(
    `UPDATE courses SET status = 'parsed', pptx_key = $2, pptx_name = 'deck.pptx', slide_count = $3, slides = $4::jsonb, content_hash = $5, validation = $6::jsonb, slide_previews = true WHERE id = $1`,
    [id, pptxKey, slides.length, JSON.stringify(slides), contentHash(title, slides), JSON.stringify({ ok: true, pptxCount: slides.length })],
  );
  return { id, ownerId, slides };
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-editor-"));
  const config = cloudConfig({ STORAGE_DRIVER: "fs", LOCAL_STORAGE_DIR: path.join(tmp, "storage"), LOCAL_DB_DIR: "memory://", APP_SECRET: "x".repeat(40), ADMIN_EMAILS: "admin@example.com" });
  ctx = { config, db: await createDb(config), storage: await createStorage(config) };
  server = http.createServer((req, res) => void handleApi(ctx, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server.close();
  await ctx.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("saving, reloading, ordering and versions", () => {
  let owner = "";
  let c: { id: string; slides: any[] };
  let rev = 0;
  let editorSlides: any[] = [];

  before(async () => {
    owner = await signedIn("editor-owner@example.com");
    c = await parsedCourse(owner);
  });

  it("opens the editor: stable slide ids, the shapes of the upload, and a first saved version", async () => {
    const r = await call("GET", `/api/v3/courses/${c.id}/editor`, undefined, owner);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    rev = r.body.rev;
    editorSlides = r.body.course.slides;
    assert.equal(editorSlides.length, 9);
    assert.deepEqual(editorSlides.map((s: any) => s.origin.page), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(r.body.deck.pageCount, 9);
    assert.ok(r.body.deck.pages["2"].shapes.some((s: any) => s.kind === "text"));
    assert.equal(r.body.versions.length, 1);
    assert.equal(r.body.versions[0].kind, "original");
  });

  it("saves reordered, duplicated and added slides, and reloading returns exactly that", async () => {
    const [s1, s2, s3, ...rest] = editorSlides;
    const added = { uid: "snew1", origin: null, title: "Added slide", narration: "This slide was added in the editor.", edits: { bg: "#FFFFFF", added: [{ id: "t1", type: "text", x: 0.1, y: 0.1, w: 0.5, h: 0.1, text: "Hello" }] } };
    const dup = { ...s2, uid: "sdup2", title: "Slide 2 copy" };
    const next = [s3, s1, dup, s2, added, ...rest];
    const put = await call("PUT", `/api/v3/courses/${c.id}/editor`, { rev, title: "Sepsis edited", slides: next }, owner);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.rev, rev + 1);
    rev = put.body.rev;
    const saved = put.body.course.slides;
    assert.equal(saved.length, 11);
    assert.deepEqual(saved.map((s: any) => s.slide), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // narration stayed with its slide after the reorder
    assert.equal(saved[0].narration, s3.narration);
    assert.equal(saved[1].narration, s1.narration);
    assert.equal(saved[2].narration, s2.narration, "the duplicate has its own copy of the narration");
    assert.equal(saved[4].title, "Added slide");

    const reload = await call("GET", `/api/v3/courses/${c.id}/editor`, undefined, owner);
    assert.equal(reload.body.course.title, "Sepsis edited");
    assert.deepEqual(reload.body.course.slides.map((s: any) => s.uid), next.map((s) => s.uid));
    assert.deepEqual(reload.body.course.slides[4].edits.added[0].text, "Hello");
    assert.equal(reload.body.course.slideCount, 11);
    editorSlides = reload.body.course.slides;
  });

  it("builds the voiceover script and the presentation the video is made from, in the edited order", async () => {
    const row = (await ctx.db.query("SELECT * FROM courses WHERE id = $1", [c.id])).rows[0];
    const docxPath = path.join(tmp, "script.docx");
    await fs.writeFile(docxPath, await buildVoiceoverDocx(row.title, row.slides));
    const docx = await parseDocx(docxPath);
    assert.deepEqual(docx.records.map((r) => r.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(docx.records.map((r) => r.text), row.slides.map((s: any) => s.narration.trim().replace(/\n+/g, " ")).map((t: string) => t));
    const pptxPath = path.join(tmp, "edited-from-db.pptx");
    await fs.copyFile(FIXTURE, pptxPath);
    assert.equal(await applyDeckEdits(row, pptxPath), true);
    const info = await parsePptx(pptxPath);
    assert.equal(info.slideCount, docx.records.length, "slide count equals narration count, as the pipeline requires");
    const texts = await readSlideTexts(pptxPath, info.slides.map((s) => s.entry));
    assert.deepEqual(texts[4], ["Hello"], "the added slide is in position 5");
  });

  it("marks the course out of date, remaps animation edits to the slides they belong to, and drops stale previews", async () => {
    // an animation edit on the slide that is now third (original page 2), and a preview on slide 1
    const edited = (await ctx.db.query("SELECT slides FROM courses WHERE id = $1", [c.id])).rows[0].slides;
    const oldNumber = edited.findIndex((s: any) => s.uid === "p2") + 1;
    await ctx.db.query("UPDATE courses SET animation_edits = $2::jsonb, previews = $3::jsonb, status = 'complete', built_hash = content_hash, outputs = '{\"video\":{\"key\":\"k\",\"bytes\":1}}'::jsonb WHERE id = $1", [c.id, JSON.stringify({ [String(oldNumber)]: { template: "timeline" } }), JSON.stringify({ "1": { at: "now", hash: "x" }, "9": { at: "now", hash: "y" } })]);
    const moved = [...editorSlides];
    const [first] = moved.splice(0, 1);
    moved.push(first); // everything shifts up by one
    const put = await call("PUT", `/api/v3/courses/${c.id}/editor`, { rev, slides: moved }, owner);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    rev = put.body.rev;
    assert.equal(put.body.course.stale, true, "the video on record no longer matches");
    const row = (await ctx.db.query("SELECT animation_edits, previews FROM courses WHERE id = $1", [c.id])).rows[0];
    assert.deepEqual(row.animation_edits, { [String(oldNumber - 1)]: { template: "timeline" } });
    assert.deepEqual(row.previews, {}, "voice previews of moved slides are dropped, not attached to the wrong slide");
    await ctx.db.query("UPDATE courses SET status = 'parsed' WHERE id = $1", [c.id]);
    editorSlides = put.body.course.slides;
  });

  it("refuses a save made from an out-of-date copy, bad slide ids and edits during a job", async () => {
    const stale = await call("PUT", `/api/v3/courses/${c.id}/editor`, { rev: rev - 1, slides: editorSlides }, owner);
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /changed somewhere else/);
    assert.equal((await call("PUT", `/api/v3/courses/${c.id}/editor`, { rev, slides: [{ ...editorSlides[0], origin: { page: 99 } }] }, owner)).status, 400);
    assert.equal((await call("PUT", `/api/v3/courses/${c.id}/editor`, { rev, slides: [] }, owner)).status, 400);
    await ctx.db.query("UPDATE courses SET status = 'rendering' WHERE id = $1", [c.id]);
    assert.equal((await call("PUT", `/api/v3/courses/${c.id}/editor`, { rev, slides: editorSlides }, owner)).status, 409);
    await ctx.db.query("UPDATE courses SET status = 'parsed' WHERE id = $1", [c.id]);
  });

  it("keeps versions, restores an earlier one, and can undo the restore", async () => {
    const list = await call("GET", `/api/v3/courses/${c.id}/editor/versions`, undefined, owner);
    const original = list.body.versions.find((v: any) => v.kind === "original");
    assert.ok(original && original.slideCount === 9);
    const named = await call("POST", `/api/v3/courses/${c.id}/editor/versions`, { label: "Before restore" }, owner);
    assert.equal(named.status, 201);
    const restore = await call("POST", `/api/v3/courses/${c.id}/editor/versions/${original.id}/restore`, {}, owner);
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.equal(restore.body.course.slides.length, 9);
    assert.deepEqual(restore.body.course.slides.map((s: any) => s.origin.page), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(restore.body.course.title, "Sepsis", "the title comes back too");
    const after = await call("GET", `/api/v3/courses/${c.id}/editor/versions`, undefined, owner);
    assert.ok(after.body.versions.some((v: any) => v.kind === "restore"), "the replaced state was kept");
    const back = after.body.versions.find((v: any) => v.label === "Before restore");
    const undo = await call("POST", `/api/v3/courses/${c.id}/editor/versions/${back.id}/restore`, {}, owner);
    assert.equal(undo.body.course.slides.length, 11);
  });

  it("requests an improvement suggestion without changing anything", async () => {
    const before = (await ctx.db.query("SELECT content_hash, editor_rev FROM courses WHERE id = $1", [c.id])).rows[0];
    const r = await call("POST", `/api/v3/courses/${c.id}/editor/suggest`, { title: "Workflow", narration: "First recognise. Then assess. Next escalate. Finally reassess it.", texts: ["Recognise", "Assess", "Escalate"] }, owner);
    assert.equal(r.status, 200);
    assert.equal(r.body.engine, "rules");
    assert.ok(Array.isArray(r.body.suggestions));
    assert.deepEqual((await ctx.db.query("SELECT content_hash, editor_rev FROM courses WHERE id = $1", [c.id])).rows[0], before);
  });
});

describe("who may edit a course", () => {
  let alice = "";
  let bob = "";
  let id = "";

  before(async () => {
    alice = await signedIn("perm-alice@example.com");
    bob = await signedIn("perm-bob@example.com");
    id = (await parsedCourse(alice, "Private course")).id;
    assert.equal((await call("GET", `/api/v3/courses/${id}/editor`, undefined, alice)).status, 200);
  });

  it("answers 404 to every editor route for another user, and 401 without a session", async () => {
    const any = [{ uid: "x", origin: { page: 1 }, title: "x", narration: "x" }];
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", `/api/v3/courses/${id}/editor`],
      ["PUT", `/api/v3/courses/${id}/editor`, { rev: 0, slides: any }],
      ["GET", `/api/v3/courses/${id}/editor/versions`],
      ["POST", `/api/v3/courses/${id}/editor/versions`, { label: "x" }],
      ["POST", `/api/v3/courses/${id}/editor/suggest`, { narration: "x" }],
      ["GET", `/api/v3/courses/${id}/editor/original/pptx`],
    ];
    for (const [m, p, b] of attempts) {
      assert.equal((await call(m, p, b, bob)).status, 404, `${m} ${p} as another user`);
      assert.equal((await call(m, p, b)).status, 401, `${m} ${p} signed out`);
    }
    const version = (await call("GET", `/api/v3/courses/${id}/editor/versions`, undefined, alice)).body.versions[0].id;
    assert.equal((await call("POST", `/api/v3/courses/${id}/editor/versions/${version}/restore`, {}, bob)).status, 404);
    assert.equal((await call("GET", `/api/v3/courses/${id}`, undefined, alice)).body.course.title, "Private course", "nothing was changed by the refused attempts");
  });

  it("does not let an administrator edit someone else's course", async () => {
    await call("POST", "/api/v3/auth/register", { email: "admin@example.com", name: "Admin", password: "long enough password" });
    const admin = (await call("POST", "/api/v3/auth/login", { email: "admin@example.com", password: "long enough password" })).cookie!;
    assert.equal((await call("GET", `/api/v3/courses/${id}/editor`, undefined, admin)).status, 404);
  });

  it("serves the original upload to its owner only", async () => {
    const own = await call("GET", `/api/v3/courses/${id}/editor/original/pptx`, undefined, alice);
    assert.equal(own.status, 302);
    assert.equal((await call("GET", `/api/v3/courses/${id}/editor/original/xlsx`, undefined, alice)).status, 404);
  });
});

describe("replacing the uploaded files starts the editor over", () => {
  it("clears saved versions and shapes of the old files", async () => {
    const owner = await signedIn("replace-owner@example.com");
    const c = await parsedCourse(owner, "Replace me");
    await call("GET", `/api/v3/courses/${c.id}/editor`, undefined, owner);
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM course_versions WHERE course_id = $1", [c.id])).rows[0].n, 1);
    const content = "PK\u0003\u0004fake";
    const up = await call("POST", `/api/v3/courses/${c.id}/upload-url`, { type: "pptx", filename: "new.pptx", size: Buffer.byteLength(content) }, owner);
    const put = await fetch(`${base}${up.body.url}`, { method: "PUT", headers: up.body.headers, body: content });
    assert.equal(put.status, 200);
    const done = await call("POST", `/api/v3/courses/${c.id}/files/complete`, { type: "pptx", key: up.body.key, filename: "new.pptx" }, owner);
    assert.equal(done.status, 200);
    const row = (await ctx.db.query("SELECT editor_shapes, editor_rev, slides FROM courses WHERE id = $1", [c.id])).rows[0];
    assert.equal(row.editor_shapes, null);
    assert.equal(row.editor_rev, 0);
    assert.deepEqual(row.slides, []);
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM course_versions WHERE course_id = $1", [c.id])).rows[0].n, 0);
  });
});
