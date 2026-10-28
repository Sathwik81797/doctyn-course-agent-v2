import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { bundleScene } from "../scripts/build-preview.mjs";
import { aiAnalyzer, AI_TEMPLATES, interpretAiReply } from "../src/animation/ai.js";
import { analyzeSlide, chooseScene, contentHash, type SlideSource } from "../src/animation/analyzer.js";
import { buildCoursePlan } from "../src/animation/build-plan.js";
import { assertRenderable } from "../src/animation/render.js";
import { renderFrame } from "../src/animation/scene/core.js";
import { DERIVABLE, deriveFor, deriveScene, ORGANS } from "../src/animation/scene/derive.js";
import { normalizeWord } from "../src/animation/scene/timing.js";
import { applyEdit, isApproved, loadPlan, savePlan, setReview } from "../src/animation/store.js";
import { CoursePlanSchema, TEMPLATES, type CoursePlan, type SlidePlan } from "../src/animation/types.js";
import { loadConfig } from "../src/utils/config.js";
import { buildVoiceoverDocx } from "../src/worker/docx-builder.js";
import { ACS_DURATIONS, ACS_SLIDES, ACS_TITLE } from "./fixtures/acs-course.js";

const source = (i: number): SlideSource => ({
  slide: i + 1,
  title: ACS_SLIDES[i]!.title,
  narration: ACS_SLIDES[i]!.narration,
  slideText: ACS_SLIDES[i]!.bullets,
  durationSeconds: ACS_DURATIONS[i]!,
  durationSource: "audio",
});
const plans = (): SlidePlan[] => ACS_SLIDES.map((_, i) => analyzeSlide(source(i)));

const tokens = (s: string): string[] => s.split(/\s+/).map(normalizeWord).filter(Boolean);

describe("non-diabetes course (acute coronary syndromes): topic-driven animation planning", () => {
  test("every structured slide gets the matching reusable medical scene, not generic key-point cards", () => {
    const got = plans();
    ACS_SLIDES.forEach((s, i) => {
      if (s.expect) assert.equal(got[i]!.template, s.expect, `slide ${i + 1} "${s.title}" -> ${got[i]!.rationale}`);
    });
    const specialised = got.filter((p) => p.template !== "key-points").length;
    assert.ok(specialised >= 8, `${specialised} of ${got.length} slides have a clinical scene`);
    // only the introduction falls back to generic cards; the take-home summary is drawn as points feeding its message
    assert.equal(got[9]!.template, "converge");
    assert.deepEqual(
      got.map((p, i) => (p.template === "key-points" ? i + 1 : 0)).filter(Boolean),
      [1],
    );
  });

  test("scenes use all the categories the brief lists", () => {
    const categories = new Set(plans().flatMap((p) => (p.analysis ? [p.analysis.category] : [])));
    for (const c of ["pathophysiology", "anatomy", "laboratory", "comparison", "timeline", "treatment-algorithm", "clinical-case"]) assert.ok(categories.has(c as never), `category ${c} present`);
    for (const p of plans().filter((x) => x.template !== "key-points")) {
      assert.ok(p.analysis?.topic && p.analysis.objective, `slide ${p.slide} records its topic and educational objective`);
    }
  });

  test("no medical text is invented: every label is built from the slide's own words", () => {
    const allowed = new Set(["patient", "findings", "interpretation"]);
    for (const [i, p] of plans().entries()) {
      const src = new Set(tokens(`${ACS_SLIDES[i]!.title} ${ACS_SLIDES[i]!.bullets.join(" ")} ${ACS_SLIDES[i]!.narration}`));
      for (const it of p.items ?? []) {
        for (const tok of tokens(it.label.replace(/\|/g, " ").replace(/…/g, " "))) {
          const organ = Object.values(ORGANS).some((o) => normalizeWord(o.name) === tok);
          assert.ok(src.has(tok) || allowed.has(tok) || organ || tok === "vs", `slide ${i + 1} label "${it.label}" contains "${tok}", which is not in the source`);
        }
      }
    }
  });

  test("elements are anchored to the narration and the timeline stays inside the slide", () => {
    for (const p of plans().filter((x) => x.template !== "key-points")) {
      assert.ok(p.events.length >= 3, `slide ${p.slide} has ${p.events.length} timed elements`);
      const cued = p.events.filter((e) => e.cue).length;
      assert.ok(cued >= Math.ceil(p.events.length / 2), `slide ${p.slide}: ${cued}/${p.events.length} elements are anchored to a narrated phrase`);
      for (const e of p.events) assert.ok(e.start >= 0 && e.end <= p.durationSeconds + 1e-6 && e.end > e.start, `slide ${p.slide} event ${e.element}`);
      // chained scenes reveal in order
      const shows = p.events.filter((e) => e.action === "show");
      assert.equal(new Set(shows.map((e) => e.element)).size, shows.length, "each element appears once");
    }
  });

  test("every scene renders complete, NaN-free frames at the start, middle and end", () => {
    for (const p of plans()) {
      for (const f of [0.05, 0.4, 0.8, 0.98]) {
        const svg = renderFrame(p, p.durationSeconds * f, { watermark: "DRAFT" });
        assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
        assert.ok(!/NaN|undefined|Infinity/.test(svg), `slide ${p.slide} at ${f}`);
      }
    }
    // the final render is refused until a clinician approves every slide; draft renders are allowed
    assert.throws(() => assertRenderable(plans(), false), /not clinically approved/);
    assertRenderable(plans(), true);
  });

  test("by the end of a slide the first words of every element are on screen", () => {
    for (const p of plans().filter((x) => x.template !== "key-points")) {
      const markup = renderFrame(p, p.durationSeconds - 0.05, {}).replace(/<[^>]+>/g, " ");
      const text = markup.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      for (const it of p.items ?? []) {
        if (/^p\d+$/.test(it.id) && p.template === "case") continue;
        const firstWord = it.label.split(/[|\s]/)[0]!.replace(/[:,]$/, "");
        assert.ok(text.includes(firstWord), `slide ${p.slide}: "${firstWord}" (${it.id}) is drawn`);
      }
    }
  });

  test("structurally comparable to the enhanced diabetes video: reviewed, flagged, pop-ups, one scene per slide", () => {
    const got = plans();
    for (const p of got) {
      assert.equal(p.review.status, "needs_review");
      assert.ok(!isApproved(p), "nothing is approved automatically");
      if (p.template !== "key-points") {
        assert.ok(p.flags.some((f) => f.kind === "template-assumption"), `slide ${p.slide} lists the visual assumptions a clinician must confirm`);
        assert.ok(p.flags.every((f) => !f.acknowledged));
      }
    }
    assert.ok(got.filter((p) => p.popups.length).length >= 5, "definition / key-figure pop-ups appear as in the diabetes video");
    assert.ok(got.some((p) => p.flags.some((f) => f.kind === "numeric-claim")), "numbers in the narration are flagged for the reviewer");
    assert.ok(got.some((p) => p.flags.some((f) => f.kind === "drug")), "drug mentions (aspirin) are flagged");
    // proportion of clinical (non-generic) scenes: diabetes video 48/52; this deck must be in the same league
    assert.ok(got.filter((p) => p.template !== "key-points").length / got.length >= 0.8);
  });

  test("planning is deterministic and the plan survives a save and reload with the schema", async () => {
    const a = plans();
    const b = plans();
    assert.deepEqual(a, b);
    assert.deepEqual(a.map(contentHash), b.map(contentHash));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acs-plan-"));
    try {
      const plan: CoursePlan = { version: 1, courseTitle: ACS_TITLE, slug: "acs", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", slides: a };
      assert.ok(CoursePlanSchema.safeParse(plan).success);
      await savePlan(dir, plan);
      const back = await loadPlan(dir);
      assert.deepEqual(back.slides.map(contentHash), a.map(contentHash));
      assert.deepEqual(back.slides[1]!.items, a[1]!.items);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("the diabetes course still gets its authored scenes, and another course's slide never inherits them", () => {
    const diabetes = analyzeSlide({ slide: 2, title: "Why Risk Factor Assessment Is Critical", narration: "Diabetes is not an on-and-off disease. By fasting glucose crossing 126, about 50 percent of beta-cell function may already be lost. Microvascular injury may already be present. Risk-factor assessment lets us intervene early.", slideText: [], durationSeconds: 20, durationSource: "audio" });
    assert.equal(diabetes.template, "pathway");
    assert.equal(diabetes.items, undefined, "authored scenes keep their items in content.ts, so their content hashes are unchanged");
    const other = analyzeSlide({ ...source(1), slide: 2 });
    assert.ok(other.items?.length, "a different course gets items derived from its own words");
    assert.ok(!other.items!.some((i) => /beta|β/i.test(i.label)));
  });

  test("a full PPTX + DOCX goes through the real parsers and produces the same plan", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acs-files-"));
    const saved = { ...process.env };
    try {
      await fs.mkdir(path.join(dir, "input"), { recursive: true });
      const mod = await import("pptxgenjs");
      const Pptx = (mod.default.default ?? mod.default) as unknown as typeof mod.default.default;
      const deck = new Pptx();
      for (const s of ACS_SLIDES) {
        const sl = deck.addSlide();
        sl.addText(s.title, { x: 0.6, y: 0.4, w: 8.8, h: 0.8, fontSize: 28, bold: true });
        sl.addText(s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })), { x: 0.8, y: 1.6, w: 8.4, h: 3.5, fontSize: 20 });
      }
      await deck.writeFile({ fileName: path.join(dir, "input", "acs.pptx") });
      await fs.writeFile(path.join(dir, "input", "acs-voiceover.docx"), await buildVoiceoverDocx(ACS_TITLE, ACS_SLIDES.map((s, i) => ({ slide: i + 1, title: s.title, narration: s.narration }))));
      Object.assign(process.env, { INPUT_DIR: path.join(dir, "input"), OUTPUT_DIR: path.join(dir, "output"), TEMP_DIR: path.join(dir, "temp") });
      const { plan } = await buildCoursePlan(loadConfig());
      assert.equal(plan.slides.length, ACS_SLIDES.length);
      ACS_SLIDES.forEach((s, i) => {
        if (s.expect) assert.equal(plan.slides[i]!.template, s.expect, `slide ${i + 1} from real files`);
        assert.equal(plan.slides[i]!.title, s.title);
      });
      assert.ok(plan.slides.every((p) => p.durationSource === "estimated"));
    } finally {
      process.env = saved;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("reusable component derivation", () => {
  test("thin content falls back to key-points instead of inventing structure", () => {
    assert.equal(deriveScene({ slide: 1, title: "Welcome", narration: "Thank you for joining us today.", slideText: [] }), null);
    assert.equal(deriveFor("compare", { slide: 1, title: "Welcome", narration: "Hello everyone.", slideText: [] }, true), null);
    assert.equal(analyzeSlide({ slide: 1, title: "Welcome", narration: "Thank you for joining us today.", slideText: [], durationSeconds: 6, durationSource: "estimated" }).template, "key-points");
  });

  test("anatomy marks only organs the slide names, at schematic positions", () => {
    const d = deriveFor("organ-map", { slide: 1, title: "Kidneys", narration: "The kidneys lie either side of the spine and filter the blood.", slideText: [] }, true)!;
    assert.deepEqual(d.items.map((i) => i.id), ["o1"]);
    assert.equal(d.params["o1.organ"], "kidneys");
    assert.ok(d.assumptions.some((a) => /schematic/.test(a)));
    assert.equal(deriveFor("organ-map", { slide: 1, title: "Rules", narration: "Follow the rules.", slideText: [] }, true), null);
  });

  test("other medical topics are recognised too (renal workup, sepsis timeline, anaemia comparison)", () => {
    const renal = deriveScene({
      slide: 3, title: "Approach to Acute Kidney Injury",
      narration: "First, confirm the rise in creatinine against the baseline. Next, look for a reversible cause such as hypovolaemia. If the urine output is low, assess volume status and review nephrotoxic drugs. Then request a renal ultrasound to exclude obstruction. Finally, discuss with nephrology if the creatinine keeps rising.",
      slideText: ["Confirm the rise in creatinine", "Look for reversible causes", "Assess volume status", "Renal ultrasound", "Escalate to nephrology"],
    });
    assert.equal(renal?.template, "workflow");
    const sepsis = deriveScene({
      slide: 4, title: "Sepsis: The First Hours",
      narration: "Within the first hour, recognise sepsis and take blood cultures. After 3 hours, give broad-spectrum antibiotics and fluids. By 6 hours, reassess perfusion and lactate. Over the following days, narrow the antibiotics to the organism.",
      slideText: [],
    });
    assert.equal(sepsis?.template, "timeline");
    const anaemia = deriveScene({
      slide: 5, title: "Iron Deficiency versus Anaemia of Chronic Disease",
      narration: "In iron deficiency, ferritin is low, whereas in anaemia of chronic disease ferritin is normal or high. Iron deficiency raises transferrin, while chronic disease lowers it.",
      slideText: [],
    });
    assert.equal(anaemia?.template, "compare");
  });

  test("DERIVABLE templates are real, registered templates", () => {
    for (const t of DERIVABLE) assert.ok((TEMPLATES as readonly string[]).includes(t));
    for (const t of ["compare", "workflow", "organ-map"]) assert.ok((TEMPLATES as readonly string[]).includes(t));
  });
});

describe("AI planning is optional and cannot place anything on screen by itself", () => {
  const src = source(7); // the management workflow
  const reply = (o: object): string => JSON.stringify({ rationale: "ordered steps", category: "treatment-algorithm", topic: "ACS management", objective: "Know the first steps", popups: [], ...o });

  test("a valid AI choice is used, its understanding is recorded, and the text still comes from the slide", () => {
    const o = interpretAiReply(reply({ template: "workflow", mechanism: "ECG then reperfusion" }), src);
    const p = analyzeSlide(src, o);
    assert.equal(p.template, "workflow");
    assert.equal(p.analyzer, "ai");
    assert.equal(p.analysis?.objective, "Know the first steps");
    assert.deepEqual(p.items?.map((i) => i.label).slice(0, 2), ["Aspirin and 12-lead ECG", "Troponin and rhythm monitoring"]);
  });

  test("a template the slide cannot fill is ignored and the deterministic planner decides", () => {
    const thin = { ...source(0) };
    const p = analyzeSlide(thin, interpretAiReply(reply({ template: "compare" }), thin));
    assert.notEqual(p.template, "compare");
    assert.match(p.rationale, /AI suggested "compare"/);
  });

  test("an AI failure leaves the deterministic plan (build-plan catches it per slide)", async () => {
    const failing = aiAnalyzer(async () => {
      throw new Error("network down");
    });
    await assert.rejects(() => failing(src), /network down/);
    assert.equal(analyzeSlide(src).template, "workflow");
  });

  test("the AI catalogue offers the reusable components and key-points only", () => {
    assert.ok(AI_TEMPLATES.includes("workflow") && AI_TEMPLATES.includes("organ-map") && AI_TEMPLATES.includes("key-points"));
    assert.ok(!(AI_TEMPLATES as readonly string[]).includes("glucose-uptake"));
  });
});

describe("editing animation choices", () => {
  const mk = (): CoursePlan => ({ version: 1, courseTitle: ACS_TITLE, slug: "acs", createdAt: "x", updatedAt: "x", slides: plans() });

  test("switching the type re-derives the scene from the slide, drops the old one, and withdraws approval", () => {
    const plan = mk();
    const s = plan.slides[5]!; // compare
    setReview(plan, 6, { status: "approved", reviewer: "Dr Test", acknowledge: "all" });
    assert.ok(isApproved(s));
    const out = applyEdit(plan, 6, { template: "balance" });
    assert.equal(out.template, "balance");
    assert.ok(out.items?.some((i) => i.id === "L"), "balance elements were derived");
    assert.ok(!out.items?.some((i) => i.id === "a1"), "the previous scene's elements are gone");
    assert.ok(!isApproved(out));
    renderFrame(out, 5);
  });

  test("editing a label changes what is drawn, the content hash and the approval", () => {
    const plan = mk();
    const s = plan.slides[1]!;
    setReview(plan, 2, { status: "approved", reviewer: "Dr Test", acknowledge: "all" });
    const before = contentHash(s);
    applyEdit(plan, 2, { labels: { n1: "Plaque rupture (edited)" } });
    assert.notEqual(contentHash(s), before);
    assert.ok(!isApproved(s));
    assert.ok(renderFrame(s, s.durationSeconds - 0.05).includes("(edited)"));
  });

  test("a type that cannot be derived is still honoured when a person picks it", () => {
    const plan = mk();
    const out = applyEdit(plan, 1, { template: "key-points" });
    assert.equal(out.template, "key-points");
    assert.equal(out.items, undefined);
  });

  test("chooseScene never lets an AI-picked, un-fillable template through", () => {
    const c = chooseScene(source(0), { template: "workflow", analyzer: "ai" });
    assert.notEqual(c.template, "workflow");
  });
});

describe("dashboard preview bundle", () => {
  test("public/scene.js is up to date with the renderer", async () => {
    const built = await bundleScene();
    const onDisk = await fs.readFile(path.join(process.cwd(), "public", "scene.js"), "utf8");
    assert.equal(onDisk, built, "run: npm run build:preview");
  });
});
