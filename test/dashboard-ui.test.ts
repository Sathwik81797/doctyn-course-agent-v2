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
import { contentHash } from "../cloud/util.js";

/**
 * Runs the real public/app.js against the real API in a simulated browser: the single dashboard,
 * with the existing 52-slide-style "original + enhanced draft" course seeded the way the importer leaves it.
 */
let ctx: Ctx;
let server: http.Server;
let base = "";
let tmp = "";
let dom: JSDOM;
let win: any;
let doc: Document;
let courseId = "";
let cookie = "";

const slides = [
  { slide: 1, title: "Intro", narration: "Welcome to the module.", pptxTitle: "Intro", pptxText: ["Intro slide text"] },
  { slide: 2, title: "Risk", narration: "Obesity raises risk.", pptxTitle: "Risk", pptxText: ["Risk slide text", "Second line"] },
];
const planSlide = (s: (typeof slides)[number]) => ({
  slide: s.slide, title: s.title, narration: s.narration, slideText: [`Overlay ${s.slide}`], template: "pathway", rationale: "Cause to consequence chain.",
  analyzer: "rules", params: {}, labels: {}, durationSeconds: 12, durationSource: "audio", audioStale: false,
  events: [{ id: `e${s.slide}`, element: "cause", action: "show", start: 1, end: 3 }],
  popups: [{ id: `p${s.slide}`, title: "Definition", text: "A glossary definition.", kind: "definition", start: 2, end: 6, origin: "glossary" }],
  flags: [{ id: `f${s.slide}`, kind: "ai-content", text: "Glossary text needs sign-off.", acknowledged: false }],
  review: { status: "needs_review" },
});

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
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
};

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-ui-"));
  const config = cloudConfig({
    STORAGE_DRIVER: "fs", LOCAL_STORAGE_DIR: path.join(tmp, "storage"), LOCAL_DB_DIR: "memory://", APP_SECRET: "u".repeat(40), DEV_AUTO_LOGIN: "true", ALLOW_SELF_REVIEW: "true",
  });
  ctx = { config, db: await createDb(config), storage: await createStorage(config) };
  server = http.createServer((req, res) => void handleApi(ctx, req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const owner = await ensureLocalUser(ctx.db);
  const { token } = await createSession(ctx.db, config, owner);
  cookie = `doctyn_session=${token}`;
  const hash = contentHash("Diabetes Course", slides);
  courseId = (await ctx.db.query(
    `INSERT INTO courses(owner_id, title, status, slide_count, slides, validation, content_hash, built_hash, outputs, duration_seconds, completed_at, animation, slide_previews)
     VALUES ($1,'Diabetes Course','complete',2,$2::jsonb,'{"ok":true}'::jsonb,$3,$3,$4::jsonb,915.7,now(),$5::jsonb,false) RETURNING id`,
    [
      owner, JSON.stringify(slides), hash,
      JSON.stringify({
        video: { key: "k/v.mp4", bytes: 48000000 }, thumbnail: { key: "k/t.jpg", bytes: 1 }, vtt: { key: "k/a.vtt", bytes: 1 }, srt: { key: "k/a.srt", bytes: 1 },
        transcript: { key: "k/t.txt", bytes: 1 }, animated: { key: "k/e.mp4", bytes: 82000000, draft: true },
      }),
      JSON.stringify({ planned: true, rendered: true, draft: true, slides: slides.map(planSlide) }),
    ],
  )).rows[0].id;
  await ctx.db.query("UPDATE courses SET pptx_name='deck.pptx', docx_name='script.docx', pptx_key='x/p', docx_key='x/d' WHERE id = $1", [courseId]);

  const html = (await fs.readFile(path.resolve("public/index.html"), "utf8")).replace(/<script[^>]*src="\/app\.js"[^>]*><\/script>/, "");
  const bundle = (await build({ entryPoints: [path.resolve("public/app.js")], bundle: true, format: "iife", write: false })).outputFiles[0]!.text;
  dom = new JSDOM(html, { url: `${base}/`, runScripts: "outside-only", pretendToBeVisual: true });
  win = dom.window;
  doc = win.document;
  win.fetch = (input: string, init: RequestInit = {}) =>
    fetch(new URL(input, base), { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie } });
  win.confirm = () => true;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  win.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  win.HTMLMediaElement.prototype.load = () => {};
  win.HTMLMediaElement.prototype.pause = () => {};
  win.eval(bundle);
  await until(() => $$("#videos .video-card").length === 1, "the generated video card to appear");
});

after(async () => {
  win?.close();
  server.close();
  await ctx.db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("single dashboard (real app.js against the real API)", () => {
  it("has one page: no separate cloud, studio or admin navigation", () => {
    assert.equal($$("nav, .main-nav, .nav-link").length, 0);
    assert.ok($(".hero"), "original blue banner is kept");
    assert.ok($("#drop-pptx") && $("#drop-docx"), "PPTX and DOCX upload cards are kept");
    assert.ok($("#previews") && $("#activity") && $("#videos"), "voice previews, recent activity and generated videos are on the page");
  });

  it("shows the course in Generated Videos with both versions, draft status and every control", () => {
    const card = $("#videos .video-card");
    const text = card.textContent ?? "";
    assert.match(text, /Diabetes Course/);
    assert.match(text, /2 slides/);
    assert.match(text, /15m 16s/);
    assert.match(card.querySelector(".thumb img")?.getAttribute("src") ?? "", /files\/thumbnail$/);
    assert.match(text, /Draft/);
    const chips = [...card.querySelectorAll(".version-chips .badge")].map((b) => b.textContent);
    assert.deepEqual(chips, ["Enhanced draft", "Original"]);
    const labels = [...card.querySelectorAll("button, a")].map((b) => b.textContent?.trim());
    for (const want of ["Play", "↓ Download MP4", "↓ Original MP4", "↓ VTT", "↓ SRT", "↓ Transcript", "Edit Again"]) assert.ok(labels.includes(want), `card has "${want}"`);
    const href = (card.querySelector("a[href*='files/animated']") as HTMLAnchorElement).getAttribute("href");
    assert.match(href ?? "", /\/courses\/[^/]+\/files\/animated\?download=1$/);
  });

  it("plays inside the dashboard with a switch between the draft and the original", async () => {
    byText("#videos button", "Play")!.click();
    const dialog = $("#player") as HTMLDialogElement;
    assert.ok(dialog.hasAttribute("open"));
    assert.match(($("#player-video") as HTMLVideoElement).getAttribute("src") ?? "", /files\/animated$/);
    assert.match($("#player-title").textContent ?? "", /Enhanced draft/);
    assert.match($("#player-meta").textContent ?? "", /DRAFT: not clinically approved/);
    assert.ok($("#player-video track[src$='files/vtt']"), "captions attached");
    const tabs = $$("#player-versions .tab");
    assert.deepEqual(tabs.map((t) => t.textContent), ["Enhanced draft", "Original (narrated slides)"]);
    tabs[1]!.click();
    assert.match(($("#player-video") as HTMLVideoElement).getAttribute("src") ?? "", /files\/video$/);
    $("#player-close").click();
    assert.ok(!dialog.hasAttribute("open"));
  });

  it("Edit Again opens the editor inside the same page with the slide, narration and animation controls", async () => {
    byText("#videos button", "Edit Again")!.click();
    await until(() => !($("#editor-card") as HTMLElement).hidden, "editor to open");
    assert.equal($$("#slide-list .slide-item").length, 2);
    assert.match($("#slide-pane").textContent ?? "", /Slide 1 of 2/);
    assert.match($("#slide-pane").textContent ?? "", /Intro slide text/, "text of the PPTX slide is shown");
    assert.equal(($("#slide-pane textarea[aria-label='Slide 1 narration']") as HTMLTextAreaElement).value, "Welcome to the module.");
    assert.ok($("#slide-pane select[aria-label='Slide 1 animation type']"), "animation type selector");
    assert.ok($("#slide-pane textarea[aria-label='Slide 1 overlay text']"), "overlay text editor");
    assert.ok(byText("#slide-pane button", "Add pop-up"), "can add pop-ups");
    assert.ok(byText("#slide-pane button", "Remove"), "can remove pop-ups");
    assert.equal($$("#slide-pane .event-row input").length, 2, "timing inputs");
    assert.equal(($("#editor-save") as HTMLButtonElement).disabled, true, "nothing to save yet");
  });

  it("saves narration, overlay, pop-up and timing edits to the backend", async () => {
    type($("#slide-pane textarea[aria-label='Slide 1 narration']") as HTMLTextAreaElement, "Welcome to this edited module.");
    type($("#slide-pane textarea[aria-label='Slide 1 overlay text']") as HTMLTextAreaElement, "Edited overlay");
    byText("#slide-pane button", "Add pop-up")!.click();
    await until(() => $$("#slide-pane .popup-edit").length === 2, "second pop-up row");
    type($$("#slide-pane .popup-edit textarea")[1] as HTMLTextAreaElement, "Screen early.");
    const timing = $$("#slide-pane .event-row input")[0] as HTMLInputElement;
    type(timing, "0.5");
    assert.equal($("#editor-dirty").textContent, "Unsaved changes");
    const save = $("#editor-save") as HTMLButtonElement;
    assert.equal(save.disabled, false);
    save.click();
    await until(() => $("#editor-dirty").textContent === "", "edits to be saved");

    const row = (await ctx.db.query("SELECT slides, animation_edits, review_status FROM courses WHERE id = $1", [courseId])).rows[0];
    assert.equal(row.slides[0].narration, "Welcome to this edited module.");
    const edit = row.animation_edits["1"];
    assert.deepEqual(edit.slideText, ["Edited overlay"]);
    assert.equal(edit.popups.length, 2);
    assert.equal(edit.popups[1].text, "Screen early.");
    assert.equal(edit.events[0].start, 0.5);
    // the saved edit shows in the course list as stale video (a new Generate is needed)
    await until(() => /Edited since this video was made/.test($("#videos").textContent ?? ""), "video card to flag the edit");
    assert.equal(($("#generate-btn") as HTMLButtonElement).textContent, "Regenerate Video");
  });

  it("Generate Video queues a job and says the engine is offline instead of pretending", async () => {
    assert.match($("#status-text").textContent ?? "", /Engine offline/);
    assert.equal($("#offline-banner").hidden, false);
    const gen = $("#generate-btn") as HTMLButtonElement;
    assert.equal(gen.disabled, false);
    gen.click();
    await until(() => /Waiting for the rendering engine/.test($("#job-detail").textContent ?? ""), "progress panel to show the queued job");
    assert.equal($("#cancel-btn").hidden, false);
    const job = (await ctx.db.query("SELECT kind, status, payload FROM jobs WHERE course_id = $1 ORDER BY created_at DESC LIMIT 1", [courseId])).rows[0];
    assert.equal(job.kind, "build");
    assert.equal(job.status, "queued");
    assert.equal(job.payload.animate, true, "Generate Video includes the medical animations");
    assert.equal((gen).disabled, true, "cannot start a second job");
    $("#cancel-btn").click();
    await until(() => ($("#generate-btn") as HTMLButtonElement).disabled === false, "cancel to free the course");
  });

  it("uploads PPTX + DOCX from the same page and reports that validation waits for the engine", async () => {
    const select = $("#course-select") as HTMLSelectElement;
    select.value = "__new__";
    select.dispatchEvent(new win.Event("change", { bubbles: true }));
    await until(() => ($("#upload-btn") as HTMLButtonElement).textContent === "Upload files", "new-course mode");
    const zip = "PK\u0003\u0004fake-office-file";
    for (const [type, name] of [["pptx", "My Deck.pptx"], ["docx", "My Script.docx"]] as const) {
      const input = $(`#drop-${type} input`) as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [new win.File([zip], name)], configurable: true });
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
    }
    assert.match($("#drop-pptx .dz-selected").textContent ?? "", /My Deck\.pptx/);
    assert.equal(($("#course-title") as HTMLInputElement).value, "My Deck", "title taken from the file name");
    const up = $("#upload-btn") as HTMLButtonElement;
    assert.equal(up.disabled, false);
    up.click();
    await until(() => /rendering engine is offline/.test($("#upload-notice").textContent ?? ""), "offline-engine notice after upload", 15000);
    await until(() => /Validation will start when the rendering engine is online/.test($("#validation-box").textContent ?? ""), "validation status");
    const created = (await ctx.db.query("SELECT title, status, pptx_name, docx_name FROM courses WHERE title = 'My Deck'")).rows[0];
    assert.deepEqual(created, { title: "My Deck", status: "parsing", pptx_name: "My Deck.pptx", docx_name: "My Script.docx" });
    const chips = $("#current-inputs").textContent ?? "";
    assert.match(chips, /My Deck\.pptx/);
    assert.match(chips, /My Script\.docx/);
  });
});
