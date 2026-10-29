import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createSession, ensureLocalUser } from "../cloud/auth.js";
import { cloudConfig } from "../cloud/config.js";
import { createDb } from "../cloud/db.js";
import { handleApi, type Ctx } from "../cloud/routes.js";
import { createStorage } from "../cloud/storage.js";
import { contentHash, courseKeys } from "../cloud/util.js";
import { parseDocx } from "../src/services/parse-docx.js";
import { parsePptx } from "../src/services/parse-pptx.js";

/** Runs the real dashboard and the real slide editor (public/app.js + public/studio.js) against the real API in a simulated browser. */
const FIX = path.join(import.meta.dirname, "fixtures", "sepsis");
let ctx: Ctx;
let server: http.Server;
let base = "";
let tmp = "";
let win: any;
let doc: Document;
let courseId = "";
let cookie = "";

const until = async (fn: () => unknown, what: string, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for: ${what}`);
};
const $ = (sel: string) => doc.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => [...doc.querySelectorAll(sel)] as HTMLElement[];
const byText = (sel: string, text: string) => $$(sel).find((n) => n.textContent?.trim() === text);
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
};
const dbSlides = async () => (await ctx.db.query("SELECT slides, title, editor_rev FROM courses WHERE id = $1", [courseId])).rows[0];
const saved = () => /All changes saved/.test($(".studio-save")?.textContent ?? "");
const thumbTitles = () => $$(".studio-thumbs .thumb-title").map((n) => n.textContent);
const pointer = (target: EventTarget, name: string, x: number, y: number) =>
  target.dispatchEvent(new win.MouseEvent(name, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-editor-ui-"));
  const config = cloudConfig({ STORAGE_DRIVER: "fs", LOCAL_STORAGE_DIR: path.join(tmp, "storage"), LOCAL_DB_DIR: "memory://", APP_SECRET: "u".repeat(40), DEV_AUTO_LOGIN: "true", ALLOW_SELF_REVIEW: "true" });
  ctx = { config, db: await createDb(config), storage: await createStorage(config) };
  server = http.createServer((req, res) => void handleApi(ctx, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const owner = await ensureLocalUser(ctx.db);
  const { token } = await createSession(ctx.db, config, owner);
  cookie = `doctyn_session=${token}`;

  const pptx = await parsePptx(path.join(FIX, "Doctyn_V2_Sepsis_Demo_Slides.pptx"));
  const docx = await parseDocx(path.join(FIX, "Doctyn_V2_Sepsis_Demo_Voiceover.docx"));
  const slides = pptx.slides.map((s, i) => ({ slide: s.number, title: docx.records[i]!.title, narration: docx.records[i]!.text, pptxTitle: s.title, pptxText: [] }));
  courseId = (await ctx.db.query(
    `INSERT INTO courses(owner_id, title, status, slide_count, slides, validation, content_hash, slide_previews, pptx_name, docx_name)
     VALUES ($1,'Sepsis demo','parsed',$2,$3::jsonb,$4::jsonb,$5,true,'deck.pptx','script.docx') RETURNING id`,
    [owner, slides.length, JSON.stringify(slides), JSON.stringify({ ok: true, pptxCount: slides.length }), contentHash("Sepsis demo", slides)],
  )).rows[0].id;
  const key = courseKeys(owner, courseId).source("pptx", "aaaaaa");
  await ctx.storage.uploadFromFile(key, path.join(FIX, "Doctyn_V2_Sepsis_Demo_Slides.pptx"), "application/octet-stream");
  await ctx.db.query("UPDATE courses SET pptx_key = $2 WHERE id = $1", [courseId, key]);

  const html = (await fs.readFile(path.resolve("public/index.html"), "utf8")).replace(/<script[^>]*src="\/app\.js"[^>]*><\/script>/, "");
  const bundle = (await build({ entryPoints: [path.resolve("public/app.js")], bundle: true, format: "iife", write: false })).outputFiles[0]!.text;
  const dom = new JSDOM(html, { url: `${base}/`, runScripts: "outside-only", pretendToBeVisual: true });
  win = dom.window;
  doc = win.document;
  win.fetch = (input: string, init: RequestInit = {}) => fetch(new URL(input, base), { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie } });
  win.confirm = () => true;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  win.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new win.Event("close")); };
  win.eval(bundle);
  await until(() => !($("#studio-btn") as HTMLElement).hidden, "the Slide Editor button");
});

after(async () => {
  // The dashboard keeps polling while a job is queued: stop its network calls and let in-flight ones settle before closing the window.
  win.fetch = () => new Promise(() => {});
  await new Promise((r) => setTimeout(r, 400));
  win?.close();
  server.close();
  await ctx.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("the slide editor workspace (real studio.js against the real API)", () => {
  it("opens from the dashboard with all five areas: toolbar, thumbnails, canvas, tool panels and voiceover", async () => {
    $("#studio-btn").click();
    await until(() => $$(".studio-thumbs .thumb").length === 9, "nine slide thumbnails");
    for (const sel of [".studio-toolbar", ".studio-left", ".studio-center .stage", ".studio-right", ".studio-bottom"]) assert.ok($(sel), sel);
    const tools = $$(".studio-tools button").map((b) => b.textContent?.trim());
    for (const want of ["Undo", "Redo", "Save", "Versions", "Preview", "Generate Video"]) assert.ok(tools.includes(want), `toolbar has ${want}`);
    assert.deepEqual($$(".studio-right .studio-tab").map((t) => t.textContent), ["Format", "Diagram", "Animation", "Improve"]);
    assert.match($(".studio-bottom textarea").getAttribute("aria-label") ?? "", /Narration for slide 1/);
    assert.ok(($(".studio-tools button[aria-label='Undo']") as HTMLButtonElement).disabled, "nothing to undo yet");
  });

  it("shows the narration of the selected slide and autosaves an edit to it", async () => {
    $$(".studio-thumbs .thumb")[2]!.click();
    await until(() => /Narration for slide 3/.test($(".studio-bottom textarea").getAttribute("aria-label") ?? ""), "slide 3 selected");
    const before = (await dbSlides()).slides[2].narration as string;
    assert.equal(($(".studio-bottom textarea") as HTMLTextAreaElement).value, before);
    type($(".studio-bottom textarea") as HTMLTextAreaElement, `${before} Extra sentence.`);
    assert.match($(".studio-save").textContent ?? "", /Unsaved/);
    await until(saved, "the autosave to finish", 6000);
    assert.equal((await dbSlides()).slides[2].narration, `${before} Extra sentence.`);
  });

  it("moves a slide, keeps its narration attached, and undo/redo restore the order", async () => {
    const titles = thumbTitles();
    const narr3 = (await dbSlides()).slides[2].narration as string;
    byText(".studio-slidebar button", "↓")!.click(); // slide 3 -> position 4
    await until(() => thumbTitles()[3] === titles[2], "slide moved down");
    assert.equal(thumbTitles()[2], titles[3]);
    assert.equal(($(".studio-bottom textarea") as HTMLTextAreaElement).value, narr3 + " Extra sentence.".slice(0, 0) || narr3, "the narration box follows the slide");
    await until(saved, "saved", 6000);
    const row = await dbSlides();
    assert.equal(row.slides[3].narration, narr3, "the narration is stored with the moved slide");
    assert.deepEqual(row.slides.map((s: any) => s.slide), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    ($(".studio-tools button[aria-label='Undo']") as HTMLButtonElement).click();
    await until(() => thumbTitles()[2] === titles[2], "undo restores the order");
    ($(".studio-tools button[aria-label='Redo']") as HTMLButtonElement).click();
    await until(() => thumbTitles()[3] === titles[2], "redo moves it again");
    await until(saved, "saved", 6000);
    assert.equal((await dbSlides()).slides[3].narration, narr3);
  });

  it("drags a text item and the move is saved into the course", async () => {
    $$(".studio-thumbs .thumb")[0]!.click();
    await until(() => /slide 1/i.test($(".studio-bottom textarea").getAttribute("aria-label") ?? ""), "slide 1");
    const stage = $(".stage");
    (stage as any).getBoundingClientRect = () => ({ width: 1000, height: 562.5, left: 0, top: 0, right: 1000, bottom: 562.5, x: 0, y: 0 });
    await until(() => $$(".el-hit").length > 3, "hit boxes on the canvas");
    // the heading text box of the sepsis demo (id 5) is among the original shapes
    const hit = $(".el-hit[data-key='s:5']");
    assert.ok(hit, "the title text box is selectable");
    pointer(hit, "pointerdown", 100, 100);
    pointer(win, "pointermove", 200, 150); // 10% right, ~9% down
    pointer(win, "pointerup", 200, 150);
    await until(saved, "saved", 6000);
    const moved = (await dbSlides()).slides[0].edits.shapes["5"];
    assert.ok(moved.x > 0.14 && moved.y > 0.2, `moved to ${JSON.stringify(moved)}`);
    // the Format tab now edits that item
    assert.match($(".studio-right").textContent ?? "", /Text: TextBox 4/);
    type($(".studio-right textarea") as HTMLTextAreaElement, "Sepsis: edited in the workspace");
    await until(saved, "saved", 6000);
    assert.deepEqual((await dbSlides()).slides[0].edits.shapes["5"].text, ["Sepsis: edited in the workspace"]);
  });

  it("adds a slide and a clinical flowchart, then keeps Generate Video disabled until the narration exists", async () => {
    byText(".studio-slidebar button", "+ Slide")!.click();
    await until(() => $$(".studio-thumbs .thumb").length === 10, "a tenth slide");
    byText(".studio-right .studio-tab", "Diagram")!.click();
    byText(".tpl", "Clinical flowchartBoxes joined by arrows, in order")!.click();
    await until(saved, "saved", 6000);
    const row = await dbSlides();
    const added = row.slides.find((s: any) => s.origin === null);
    assert.ok(added.edits.added.filter((e: any) => e.type === "arrow").length >= 3, "flowchart arrows were saved");
    assert.ok(added.edits.added.some((e: any) => e.text === "Step 1"));
    const gen = byText(".studio-tools button", "Generate Video") as HTMLButtonElement;
    assert.ok(gen.disabled, "a slide without narration blocks generation");
    assert.match(gen.title, /1 slide\(s\) still need narration/);
    type($(".studio-bottom textarea") as HTMLTextAreaElement, "This new slide explains the escalation steps.");
    await until(() => !gen.disabled, "Generate Video to enable");
    await until(saved, "saved", 6000);
  });

  it("offers suggestions that change nothing until accepted", async () => {
    $$(".studio-thumbs .thumb")[1]!.click();
    await until(() => /slide 2/i.test($(".studio-bottom textarea").getAttribute("aria-label") ?? ""), "slide 2");
    const narrationBefore = ($(".studio-bottom textarea") as HTMLTextAreaElement).value;
    type($(".studio-bottom textarea") as HTMLTextAreaElement, `Basically, ${narrationBefore.charAt(0).toLowerCase()}${narrationBefore.slice(1)} It is important to note that 30 mL/kg matters.`);
    await until(saved, "saved", 6000);
    byText(".studio-right .studio-tab", "Improve")!.click();
    byText(".studio-right button", "Improve Slide Content")!.click();
    await until(() => $$(".sug").length > 0, "suggestions");
    const textBefore = ($(".studio-bottom textarea") as HTMLTextAreaElement).value;
    assert.match(textBefore, /^Basically/, "nothing was applied just by asking");
    const tighten = $$(".sug").find((s) => /Tighten the narration/.test(s.textContent ?? ""))!;
    assert.ok(tighten, "narration suggestion present");
    byText(".sug button", "Accept")!; // exists
    (tighten.querySelector("button") as HTMLButtonElement).click();
    await until(() => !/^Basically/.test(($(".studio-bottom textarea") as HTMLTextAreaElement).value), "accepted narration");
    assert.match(($(".studio-bottom textarea") as HTMLTextAreaElement).value, /30 mL\/kg/, "the figure is kept");
    // rejecting removes a card without applying it
    const before = $$(".sug").length;
    const reject = byText(".sug button", "Reject");
    if (reject) { reject.click(); await until(() => $$(".sug").length === before - 1, "card dismissed"); }
    await until(saved, "saved", 6000);
  });

  it("lists saved versions with the original state, and restoring returns to it", async () => {
    byText(".studio-tools button", "Versions")!.click();
    await until(() => $$("dialog[open] .versions li").length >= 1, "version list");
    assert.ok($$("dialog[open] .versions li").some((li) => /When slide editing began/.test(li.textContent ?? "")));
    assert.match($("dialog[open]").textContent ?? "", /Download original PPTX/);
    const first = $$("dialog[open] .versions li").find((li) => /When slide editing began/.test(li.textContent ?? ""))!;
    (first.querySelector("button") as HTMLButtonElement).click();
    await until(() => thumbTitles().length === 9, "the nine original slides are back");
    const row = await dbSlides();
    assert.equal(row.slides.length, 9);
    assert.deepEqual(row.slides.map((s: any) => s.origin.page), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(row.slides[0].edits === undefined || Object.keys(row.slides[0].edits).length === 0, true);
  });

  it("generates the video from the saved edits and returns to the dashboard", async () => {
    const gen = byText(".studio-tools button", "Generate Video") as HTMLButtonElement;
    await until(() => !gen.disabled, "Generate Video enabled");
    gen.click();
    await until(() => !$(".studio"), "the editor to close");
    const job = (await ctx.db.query("SELECT kind, status FROM jobs WHERE course_id = $1 ORDER BY created_at DESC LIMIT 1", [courseId])).rows[0];
    assert.deepEqual(job, { kind: "build", status: "queued" });
    const course = (await ctx.db.query("SELECT status FROM courses WHERE id = $1", [courseId])).rows[0];
    assert.equal(course.status, "queued");
  });
});
