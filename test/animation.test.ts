import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { interpretAiReply, aiAnalyzer } from "../src/animation/ai.js";
import { analyzeSlide, chooseTemplate, contentHash, sentences, type SlideSource } from "../src/animation/analyzer.js";
import { assertRenderable, rasterFrame } from "../src/animation/render.js";
import { TEMPLATE_DEFS, deriveCards, renderFrame } from "../src/animation/scene/core.js";
import { findPhrase, LEAD_IN, TAIL, wordTimings } from "../src/animation/scene/timing.js";
import { applyEdit, isApproved, savePlan, setReview } from "../src/animation/store.js";
import { AUTHORED, authoredFor } from "../src/animation/scene/content.js";
import { TEMPLATES, type CoursePlan } from "../src/animation/types.js";
import { createDashboardServer } from "../src/server/app.js";

const SLIDE14: SlideSource = {
  slide: 14,
  title: "Muscle = Primary Glucose Disposal Organ",
  narration:
    "Approximately 70 percent of post-meal glucose uptake occurs in skeletal muscle. When muscle mass is low, the glucose sink is reduced, post-prandial glucose can rise, and insulin demand increases.",
  slideText: ["14", "Muscle = Primary Glucose Disposal Organ", "RISK FACTORS FOR DIABETES  •  FROM GENETICS TO LIFESTYLE", "14", "~70%", "of post-meal glucose uptake occurs in skeletal muscle", "01", "Low muscle mass", "Reduces glucose sink", "02", "Post-prandial glucose", "Rises", "03", "Insulin demand", "Increases"],
  durationSeconds: 12.6,
  durationSource: "estimated",
};
const SLIDE12: SlideSource = {
  slide: 12,
  title: "Why Visceral Fat Is More Dangerous Than BMI",
  narration:
    "Visceral fat releases free fatty acids directly into the portal circulation, increases hepatic gluconeogenesis, and produces inflammatory cytokines. Together, these effects can produce profound insulin resistance. This is why central adiposity can carry metabolic risk that is not captured by BMI alone.",
  slideText: ["FREE FATTY ACIDS", "Portal circulation", "HEPATIC EFFECT", "↑ gluconeogenesis", "INFLAMMATION", "Cytokines"],
  durationSeconds: 17.8,
  durationSource: "estimated",
};
const SLIDE3: SlideSource = {
  slide: 3,
  title: "Diabetes as a Continuum",
  narration:
    "Diabetes progresses through a continuum of clinical stages: normal glucose tolerance, compensated insulin resistance, prediabetes, overt diabetes, and insulin-dependent diabetes. Each stage represents a different degree of metabolic progression, and each stage has distinct laboratory signatures.",
  slideText: ["03", "Diabetes as a Continuum", "NORMAL", "Glucose tolerance"],
  durationSeconds: 15.4,
  durationSource: "estimated",
};
const OTHER: SlideSource = {
  slide: 30,
  title: "Young Lean Patient",
  narration: "This patient is 24 years old, has a BMI of 21 kilograms per square metre, and an HbA1c of 6.2 percent.",
  slideText: ["30", "CLINICAL CASE", "Young Lean Patient", "30", "PATIENT PROFILE", "Age: 24 years BMI: 21 kg/m² HbA1c: 6.2%", "LAB CLUES", "Fasting insulin: low-normal"],
  durationSeconds: 9,
  durationSource: "estimated",
};

describe("timing", () => {
  test("word timings are monotonic and fill the narration window", () => {
    const speech = 10;
    const w = wordTimings(SLIDE14.narration, speech);
    assert.ok(w.length > 20);
    for (let i = 1; i < w.length; i++) assert.ok(w[i]!.start >= w[i - 1]!.start);
    assert.ok(Math.abs(w[0]!.start - LEAD_IN) < 1e-9);
    assert.ok(Math.abs(w.at(-1)!.end - (LEAD_IN + speech)) < 1e-6);
  });

  test("findPhrase ignores case and punctuation, and returns null when absent", () => {
    const w = wordTimings("Insulin demand increases, sharply.", 4);
    assert.ok(findPhrase(w, "INSULIN DEMAND"));
    assert.ok(findPhrase(w, "increases"));
    assert.equal(findPhrase(w, "glucose sink"), null);
  });
});

describe("analyzer", () => {
  test("chooses a specialised template for the diabetes examples, an authored scene for matching slides, and key-points otherwise", () => {
    assert.equal(chooseTemplate(SLIDE14).template, "glucose-uptake");
    assert.equal(chooseTemplate(SLIDE12).template, "visceral-fat");
    assert.equal(chooseTemplate(SLIDE3).template, "continuum");
    assert.equal(chooseTemplate({ ...OTHER, title: "A Slide From Another Course" }).template, "key-points");
    assert.equal(chooseTemplate(OTHER).template, "case");
  });

  test("slide 14 timeline runs the mechanism in order, then the consequences as narrated", () => {
    const plan = analyzeSlide(SLIDE14);
    const at = (id: string) => plan.events.find((e) => e.element === id && e.action === "show")!;
    for (const [a, b] of [["muscle", "betaCell"], ["betaCell", "insulin"], ["insulin", "receptor"], ["receptor", "glut4"], ["glut4", "uptake"]] as const) {
      assert.ok(at(a).start <= at(b).start, `${a} before ${b}`);
    }
    // "insulin demand" is the last phrase of the narration; it must not drag the insulin step there
    assert.ok(at("insulin").start < 4);
    assert.ok(at("sink").start < at("rise").start && at("rise").start < at("demand").start);
    for (const e of plan.events) assert.ok(e.start >= 0 && e.end <= plan.durationSeconds && e.end > e.start);
  });

  test("optional consequences are omitted when the narration does not mention them", () => {
    const plan = analyzeSlide({ ...SLIDE14, narration: "GLUT-4 carries glucose into skeletal muscle after a meal." });
    assert.ok(!plan.events.some((e) => e.element === "sink" || e.element === "demand"));
  });

  test("numeric claims and tool-written pop-ups are flagged for clinician review", () => {
    const plan = analyzeSlide(SLIDE14);
    assert.ok(plan.flags.some((f) => f.kind === "numeric-claim" && f.text.includes("70 percent")));
    assert.ok(plan.flags.some((f) => f.kind === "ai-content"));
    assert.ok(plan.flags.every((f) => !f.acknowledged));
    assert.equal(plan.review.status, "needs_review");
    // the pearl is taken verbatim from the source narration
    const pearl = plan.popups.find((p) => p.origin === "source")!;
    assert.ok(SLIDE14.narration.includes(pearl.text));
  });

  test("pop-ups never overlap and stay inside the slide", () => {
    for (const src of [SLIDE3, SLIDE12, SLIDE14, OTHER]) {
      const plan = analyzeSlide(src);
      const sorted = [...plan.popups].sort((a, b) => a.start - b.start);
      for (let i = 0; i < sorted.length; i++) {
        assert.ok(sorted[i]!.end <= plan.durationSeconds);
        if (i) assert.ok(sorted[i]!.start >= sorted[i - 1]!.end - 1e-9, `${src.slide}: ${sorted[i - 1]!.title} overlaps ${sorted[i]!.title}`);
      }
    }
  });

  test("slide numbers, footers and arrows are not turned into cards", () => {
    const cards = deriveCards(OTHER.slideText, OTHER.title, OTHER.slide);
    assert.deepEqual(cards.map((c) => c.heading), ["CLINICAL CASE", "PATIENT PROFILE", "LAB CLUES"]);
    assert.ok(cards.every((c) => !/^\d+$/.test(c.body)));
    const arrows = deriveCards(["GENETICS", "↓", "LIFESTYLE"], "x", 1);
    assert.equal(arrows.length, 2);
  });
});

describe("scene renderer", () => {
  test("every template renders valid-looking SVG with no NaN at many time points", () => {
    for (const src of [SLIDE3, SLIDE12, SLIDE14, OTHER]) {
      const plan = analyzeSlide(src);
      for (let t = 0; t <= plan.durationSeconds; t += plan.durationSeconds / 12) {
        const svg = renderFrame(plan, t, { watermark: "DRAFT" });
        assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
        assert.ok(!/NaN|undefined|Infinity/.test(svg), `${plan.template} @${t.toFixed(1)}s contains an invalid number`);
      }
    }
  });

  test("elements animate: nothing at t=0, the mechanism visible later", () => {
    const plan = analyzeSlide(SLIDE14);
    const early = renderFrame(plan, 0);
    const late = renderFrame(plan, 6.5);
    assert.ok(!early.includes("GLUT4 moves to membrane"));
    assert.ok(late.includes("GLUT4 moves to membrane"));
    assert.notEqual(renderFrame(plan, 5), renderFrame(plan, 5.5));
  });

  test("moving a timeline event changes when its element appears", () => {
    const plan = analyzeSlide(SLIDE12);
    const ev = plan.events.find((e) => e.element === "liver")!;
    assert.ok(renderFrame(plan, ev.end + 0.1).includes(">Liver<"));
    ev.start = 15;
    ev.end = 16;
    assert.ok(!renderFrame(plan, 10).includes(">Liver<"));
  });

  test("label overrides and XML escaping", () => {
    const plan = analyzeSlide(SLIDE12);
    plan.labels["fat"] = "Fat <b> & co";
    assert.ok(renderFrame(plan, 3).includes("Fat &lt;b&gt; &amp; co"));
  });

  test("the draft watermark is only drawn when requested, and frames rasterise at the requested scale", async () => {
    const plan = analyzeSlide(SLIDE14);
    assert.ok(!renderFrame(plan, 3).includes("DRAFT"));
    assert.ok(renderFrame(plan, 3, { watermark: "DRAFT" }).includes("DRAFT"));
    const buf = await rasterFrame(plan, 3, { scale: 0.25 });
    assert.equal(buf.length, 480 * 270 * 3);
  });

  test("template registry covers every template id", () => {
    for (const id of TEMPLATES) assert.ok(TEMPLATE_DEFS[id].name);
  });
});

function samplePlan(): CoursePlan {
  const now = new Date().toISOString();
  return { version: 1, courseTitle: "Sample", slug: "sample", createdAt: now, updatedAt: now, slides: [analyzeSlide(SLIDE3), analyzeSlide(SLIDE12), analyzeSlide(SLIDE14), analyzeSlide(OTHER)] };
}

describe("review and approval", () => {
  test("approval needs a reviewer name and every flag acknowledged", () => {
    const plan = samplePlan();
    assert.throws(() => setReview(plan, 14, { status: "approved", acknowledge: "all" }), /reviewer name/);
    assert.throws(() => setReview(plan, 14, { status: "approved", reviewer: "Dr A" }), /flag\(s\) have not been acknowledged/);
    setReview(plan, 14, { status: "approved", reviewer: "Dr A", acknowledge: "all" });
    const s = plan.slides.find((x) => x.slide === 14)!;
    assert.ok(isApproved(s));
    assert.ok(s.flags.every((f) => f.acknowledged));
    assert.equal(s.review.reviewer, "Dr A");
  });

  test("any content edit after approval withdraws the approval", () => {
    const plan = samplePlan();
    setReview(plan, 14, { status: "approved", reviewer: "Dr A", acknowledge: "all" });
    applyEdit(plan, 14, { narration: SLIDE14.narration.replace("70", "60") });
    const s = plan.slides.find((x) => x.slide === 14)!;
    assert.equal(isApproved(s), false);
    assert.equal(s.review.status, "needs_review");
  });

  test("moving a timeline event also withdraws approval; hash tracks content", () => {
    const plan = samplePlan();
    setReview(plan, 12, { status: "approved", reviewer: "Dr A", acknowledge: "all" });
    const s = plan.slides.find((x) => x.slide === 12)!;
    const before = contentHash(s);
    applyEdit(plan, 12, { events: s.events.map((e, i) => (i === 0 ? { ...e, start: e.start + 0.5, end: e.end + 0.5 } : e)) });
    assert.notEqual(contentHash(s), before);
    assert.equal(isApproved(s), false);
  });

  test("render gate: unapproved slides block a final render but not a draft", () => {
    const plan = samplePlan();
    assert.throws(() => assertRenderable(plan.slides, false), /not clinically approved/);
    assert.doesNotThrow(() => assertRenderable(plan.slides, true));
    for (const s of plan.slides) setReview(plan, s.slide, { status: "approved", reviewer: "Dr A", acknowledge: "all" });
    assert.doesNotThrow(() => assertRenderable(plan.slides, false));
    plan.slides[0]!.audioStale = true;
    assert.throws(() => assertRenderable(plan.slides, false), /edited after its audio/);
  });
});

describe("editing", () => {
  test("narration edit on an estimated slide re-times it and moves cue-linked steps", () => {
    const plan = samplePlan();
    const s = plan.slides.find((x) => x.slide === 12)!;
    const d0 = s.durationSeconds;
    const gluco0 = s.events.find((e) => e.element === "gluco")!.start;
    applyEdit(plan, 12, { narration: "First, a short lead-in sentence that delays everything by several seconds. " + s.narration });
    assert.ok(s.durationSeconds > d0);
    assert.ok(s.events.find((e) => e.element === "gluco")!.start > gluco0);
  });

  test("narration edit on a slide with audio keeps its duration and marks audio stale", () => {
    const plan = samplePlan();
    const s = plan.slides.find((x) => x.slide === 14)!;
    s.durationSource = "audio";
    const d0 = s.durationSeconds;
    applyEdit(plan, 14, { narration: s.narration + " Extra." });
    assert.equal(s.audioStale, true);
    assert.equal(s.durationSeconds, d0);
  });

  test("changing the template rebuilds the timeline for the new diagram", () => {
    const plan = samplePlan();
    applyEdit(plan, 30, { template: "glucose-uptake" });
    const s = plan.slides.find((x) => x.slide === 30)!;
    assert.equal(s.template, "glucose-uptake");
    assert.ok(s.events.some((e) => e.element === "glut4"));
    assert.ok(!s.events.some((e) => e.element.startsWith("card")));
  });

  test("invalid edits are rejected with a readable message", () => {
    const plan = samplePlan();
    assert.throws(() => applyEdit(plan, 14, { template: "nope" }), /rejected/);
    assert.throws(() => applyEdit(plan, 14, { sneaky: true }), /rejected/);
    assert.throws(() => applyEdit(plan, 99, {}), /not in the animation plan/);
  });

  test("event times past the end are clamped into the slide; negative times are rejected", () => {
    const plan = samplePlan();
    const s = plan.slides.find((x) => x.slide === 14)!;
    applyEdit(plan, 14, { events: [{ id: "x", element: "blood", action: "show", start: 2, end: 9999 }] });
    assert.equal(s.events[0]!.end, s.durationSeconds);
    assert.throws(() => applyEdit(plan, 14, { events: [{ id: "x", element: "blood", action: "show", start: -5, end: 3 }] }), /rejected/);
  });
});

describe("AI analysis (mocked, no network)", () => {
  const src = SLIDE14;
  test("accepts a valid reply, keeps only pop-ups whose cue is in the narration, and tags them as AI", () => {
    const o = interpretAiReply(
      JSON.stringify({ template: "glucose-uptake", rationale: "muscle uptake", popups: [{ title: "GLUT4", text: "t", kind: "definition", cue: "skeletal muscle" }, { title: "Bad", text: "t", kind: "definition", cue: "not in narration" }] }),
      src,
    );
    assert.equal(o.template, "glucose-uptake");
    assert.equal(o.extraPopups?.length, 1);
    assert.equal(o.extraPopups?.[0]?.origin, "ai");
  });

  test("rejects unknown templates and non-JSON replies", () => {
    assert.throws(() => interpretAiReply(JSON.stringify({ template: "hologram", rationale: "x" }), src));
    assert.throws(() => interpretAiReply("sure! here you go", src), /not JSON/);
  });

  test("an AI-chosen template flows through analyzeSlide and its pop-ups are flagged", async () => {
    const override = await aiAnalyzer(async () => JSON.stringify({ template: "key-points", rationale: "generic", popups: [{ title: "T", text: "t", kind: "definition", cue: "skeletal muscle" }] }))(src);
    const plan = analyzeSlide(src, override);
    assert.equal(plan.template, "key-points");
    assert.equal(plan.analyzer, "ai");
    assert.ok(plan.flags.some((f) => f.kind === "ai-content" && f.text.includes('"T"')));
  });
});

describe("studio API", () => {
  let root: string;
  let base: string;
  let server: http.Server;
  const SLUG = "sample";

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "doctyn-studio-"));
    await fs.mkdir(path.join(root, "output"), { recursive: true });
    await fs.mkdir(path.join(root, "public"), { recursive: true });
    await fs.writeFile(path.join(root, "public", "index.html"), "x");
    await savePlan(path.join(root, "output", SLUG), samplePlan());
    ({ server } = await createDashboardServer({
      projectRoot: root,
      inputDir: path.join(root, "input"),
      outputDir: path.join(root, "output"),
      publicDir: path.join(root, "public"),
      allowedOrigins: [],
      tts: { provider: "kokoro", voice: "x", speed: 1 },
    }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };

  test("lists courses and returns the plan with element descriptions and templates", async () => {
    const list = await call("GET", "/api/v2/courses");
    assert.equal(list.json["courses"][0].slug, SLUG);
    const plan = await call("GET", `/api/v2/${SLUG}/plan`);
    assert.equal(plan.status, 200);
    assert.equal(plan.json["slides"].length, 4);
    assert.equal(plan.json["templates"].length, TEMPLATES.length);
    assert.ok(plan.json["slides"][2].elements.some((e: { id: string }) => e.id === "glut4"));
  });

  test("edit → persisted; review gate over HTTP", async () => {
    const put = await call("PUT", `/api/v2/${SLUG}/slides/14`, { labels: { fat: "x" }, popups: [] });
    assert.equal(put.status, 200);
    assert.equal(put.json["slide"].popups.length, 0);

    const noAck = await call("POST", `/api/v2/${SLUG}/slides/14/review`, { status: "approved", reviewer: "Dr A" });
    assert.equal(noAck.status, 409);
    assert.match(String(noAck.json["error"]), /not been acknowledged/);

    const ok = await call("POST", `/api/v2/${SLUG}/slides/14/review`, { status: "approved", reviewer: "Dr A", acknowledge: "all" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json["slide"].approved, true);

    const after = await call("GET", `/api/v2/${SLUG}/plan`);
    assert.equal(after.json["review"].approved, 1);

    const edit = await call("PUT", `/api/v2/${SLUG}/slides/14`, { narration: "Changed." });
    assert.equal(edit.json["slide"].approved, false);
  });

  test("bad input is a 4xx, never a 500", async () => {
    assert.equal((await call("PUT", `/api/v2/${SLUG}/slides/14`, { template: "bogus" })).status, 409);
    assert.equal((await call("PUT", `/api/v2/${SLUG}/slides/999`, {})).status, 404);
    assert.equal((await call("POST", `/api/v2/${SLUG}/slides/14/review`, { status: "weird" })).status, 400);
    assert.equal((await call("GET", `/api/v2/..%2f..%2fetc/plan`)).status, 404);
    assert.equal((await call("GET", `/api/v2/nothere/plan`)).status, 409);
  });

  test("re-analysis restores the generated timeline", async () => {
    const r = await call("POST", `/api/v2/${SLUG}/slides/12/reanalyze`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json["slide"].review.status, "needs_review");
  });

  test("serves the studio page and a bundled script", async () => {
    const page = await fetch(`${base}/studio/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Doctyn Animation Studio/);
    const js = await fetch(`${base}/studio/studio.js`);
    assert.equal(js.status, 200);
    const code = await js.text();
    assert.match(code, /renderFrame/);
    assert.equal((await fetch(`${base}/studio/main.ts`)).status, 404);
  });
});


const COURSE_TITLES: Record<string, string> = {"1":"Risk Factors for Diabetes – From Genetics to Lifestyle","2":"Why Risk Factor Assessment Is Critical","4":"Two Biological Axes That Determine Risk","5":"Clinical Meaning of Risk Factors","6":"How Age Increases Diabetes Risk","7":"Young Age of Onset = Aggressive Biology","8":"South Asian / Indian Diabetes Phenotype","9":"Clinical Consequence","10":"What Family History Truly Represents","11":"Laboratory Clue of Genetic β-Cell Weakness","13":"Clinical Measurement","15":"Who Has Low Muscle Mass?","17":"Dietary Pattern and β-Cell Stress","18":"Prediabetes","19":"Gestational Diabetes: A Long-Term Diabetes Risk Marker","20":"Gestational Diabetes","21":"PCOS","22":"Core Screening Tests","23":"Fasting Insulin","24":"HOMA-IR — Insulin Resistance Index","25":"C-Peptide","26":"OGTT Pattern Recognition","27":"Investigations Summary","28":"Insulin-Resistance Dominant Phenotype","29":"β-Cell Failure Dominant Phenotype","30":"Young Lean Patient","31":"Obese Middle-Aged Patient","32":"Woman With History of GDM","33":"Initial Evaluation","34":"Interpretation","35":"Advanced Results","36":"Clinical Conclusion","37":"Management Implication","38":"Case 4 — Clinical Scenario","39":"Clinical Concern","40":"Investigations Ordered","41":"Management Implication","42":"Obese Patient With Normal Glucose but High Insulin","43":"Why This Patient Is Not “Normal”","44":"Interpretation","45":"Management Implication","46":"Algorithm: Test Ordering in Patients at Risk for Diabetes","47":"Step 2 — First-Line Tests","48":"Interpret Results","49":"Step 4 — Mechanism Identification","50":"Step 5 — Phenotype Classification","51":"Step 6 — Action","52":"Clinical Take-Home Messages"};

describe("sentence splitting", () => {
  test("does not cut a clinical value at its decimal point", () => {
    const s = sentences("The results are a fasting blood sugar of 108 milligrams per decilitre and an HbA1c of 6.0 percent. Next, repeat in 6.5 weeks! Done");
    assert.deepEqual(s, ["The results are a fasting blood sugar of 108 milligrams per decilitre and an HbA1c of 6.0 percent.", "Next, repeat in 6.5 weeks!", "Done"]);
  });
});

describe("authored medical scenes", () => {
  test("every authored slide matches its title and uses a registered template", () => {
    for (const [n, a] of Object.entries(AUTHORED)) {
      assert.ok(authoredFor(Number(n), COURSE_TITLES[n]!), `slide ${n} title should match`);
      assert.ok((TEMPLATES as readonly string[]).includes(a.template), `slide ${n} template`);
      assert.equal(new Set(a.items.map((i) => i.id)).size, a.items.length, `slide ${n} item ids unique`);
    }
  });

  test("the title guard stops authored content leaking onto another course", () => {
    assert.equal(authoredFor(30, "Chapter 3 review"), undefined);
    assert.equal(authoredFor(99, "Young Lean Patient"), undefined);
  });

  test("48 slides are covered; none of the covered slides is a generic key-points scene", () => {
    assert.equal(Object.keys(AUTHORED).length, 48);
    assert.ok(Object.values(AUTHORED).every((a) => a.template !== "key-points"));
  });

  test("each authored slide builds a timeline, resolves its narration cues and draws NaN-free frames", () => {
    for (const [n, a] of Object.entries(AUTHORED)) {
      // narration built from the cue phrases themselves, so every cue is findable
      const narration = a.items.flatMap((i) => i.cues).join(". ") + ".";
      const plan = analyzeSlide({ slide: Number(n), title: COURSE_TITLES[n]!, narration, slideText: [], durationSeconds: 10, durationSource: "audio" });
      assert.equal(plan.template, a.template, `slide ${n}`);
      assert.ok(plan.flags.some((f) => f.kind === "template-assumption"), `slide ${n} needs a clinician-facing template assumption flag`);
      assert.equal(plan.review.status, "needs_review");
      for (const item of a.items) {
        const ev = plan.events.find((e) => e.element === item.id);
        assert.ok(ev, `slide ${n} element ${item.id} has an event`);
        if (item.cues.some(Boolean)) assert.ok(ev.cue, `slide ${n} element ${item.id} resolved a narration cue`);
      }
      for (const f of [0, 0.3, 0.6, 0.99]) {
        const svg = renderFrame(plan, plan.durationSeconds * f);
        assert.ok(svg.startsWith("<svg"), `slide ${n}`);
        assert.ok(!/NaN|undefined|Infinity/.test(svg), `slide ${n} at ${f}: bad number in SVG`);
      }
    }
  });

  test("editing an authored label changes the slide content hash and resets approval", () => {
    const plan = analyzeSlide({ slide: 25, title: COURSE_TITLES["25"]!, narration: "C-peptide reflects endogenous insulin production.", slideText: [], durationSeconds: 12, durationSource: "audio" });
    const course: CoursePlan = { version: 1, courseTitle: "t", slug: "t", createdAt: "", updatedAt: "", slides: [plan] };
    setReview(course, 25, { status: "approved", reviewer: "Dr Test", acknowledge: "all" });
    assert.ok(isApproved(course.slides[0]!));
    applyEdit(course, 25, { labels: { test: "C-peptide (fasting)" } });
    assert.ok(!isApproved(course.slides[0]!));
  });
});
