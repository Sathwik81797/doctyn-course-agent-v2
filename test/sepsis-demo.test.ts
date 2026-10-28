import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { buildCoursePlan } from "../src/animation/build-plan.js";
import { readSlideTexts } from "../src/animation/pptx-text.js";
import { renderFrame } from "../src/animation/scene/core.js";
import { ICON_IDS, pictogram } from "../src/animation/scene/icons.js";
import { analyzeSlideText, findBoilerplate } from "../src/animation/scene/structure.js";
import { applyEdit } from "../src/animation/store.js";
import { parsePptx } from "../src/services/parse-pptx.js";
import { loadConfig } from "../src/utils/config.js";

const dir = path.join(import.meta.dirname, "fixtures", "sepsis");
const PPTX = path.join(dir, "Doctyn_V2_Sepsis_Demo_Slides.pptx");

async function plan() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sepsis-"));
  const saved = { ...process.env };
  try {
    await fs.mkdir(path.join(tmp, "input"));
    await fs.copyFile(PPTX, path.join(tmp, "input", "slides.pptx"));
    await fs.copyFile(path.join(dir, "Doctyn_V2_Sepsis_Demo_Voiceover.docx"), path.join(tmp, "input", "voiceover.docx"));
    Object.assign(process.env, { INPUT_DIR: path.join(tmp, "input"), OUTPUT_DIR: path.join(tmp, "output"), TEMP_DIR: path.join(tmp, "temp") });
    return (await buildCoursePlan(loadConfig())).plan;
  } finally {
    process.env = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe("reading a designed slide", () => {
  test("soft line breaks become separate lines, and repeated header/footer lines are found", async () => {
    const pptx = await parsePptx(PPTX);
    const texts = await readSlideTexts(PPTX, pptx.slides.map((s) => s.entry));
    assert.ok(texts[7]!.includes("Fever + new confusion") && texts[7]!.includes("Rapid breathing + hypotension"), "the line break in the case slide splits the two findings");
    const bp = findBoilerplate(texts);
    assert.equal(bp.length, 2);
    assert.ok(bp.some((b) => /doctyn course studio/.test(b)) && bp.some((b) => /educational demonstration only/.test(b)));
  });

  test("numbered boxes, arrows, counters, subtitles and section headings are understood", async () => {
    const pptx = await parsePptx(PPTX);
    const texts = await readSlideTexts(PPTX, pptx.slides.map((s) => s.entry));
    const bp = findBoilerplate(texts);
    const two = analyzeSlideText("What Is Sepsis?", texts[1]!, bp);
    assert.equal(two.sequence, true);
    assert.equal(two.subtitle, "Infection-associated organ dysfunction");
    assert.deepEqual(two.items, ["Suspected or confirmed infection", "Dysregulated host response", "Life-threatening organ dysfunction"]);
    assert.ok(two.dropped.some((d) => /01\/09|02\/09/.test(d) || /DOCTYN/.test(d)), "header, footer and counter are not content");
    const eight = analyzeSlideText("Clinical Case: Possible Sepsis", texts[7]!, bp);
    assert.deepEqual(eight.sections.map((s) => s.header), ["CLINICAL PRESENTATION", "RESPONSE PATHWAY"]);
    assert.deepEqual(eight.sections[1]!.lines, ["Recognize → Assess → Escalate → Reassess"]);
    assert.deepEqual(eight.chains[0], ["Recognize", "Assess", "Escalate", "Reassess"]);
    // an ordinary bullet list is not mistaken for a subtitle plus bullets
    assert.equal(analyzeSlideText("Risk Factors", ["Hypertension", "Smoking", "Dyslipidaemia", "Diabetes"]).subtitle, undefined);
  });
});

describe("the 9-slide Sepsis demo deck, planned from the real PPTX and DOCX", () => {
  test("8 of 9 slides get a topic-specific scene; only the cover is generic and says so", async () => {
    const { slides } = await plan();
    assert.equal(slides.length, 9);
    assert.deepEqual(
      slides.map((s) => s.template),
      ["key-points", "pathway", "pathway", "converge", "workflow", "converge", "workflow", "case", "converge"],
    );
    const generic = slides.filter((s) => s.template === "key-points");
    assert.deepEqual(generic.map((s) => s.slide), [1]);
    assert.ok(generic[0]!.flags.some((f) => f.kind === "generic-animation"), "a generic slide is flagged for the reviewer");
    assert.ok(slides.filter((s) => s.template !== "key-points").every((s) => !s.flags.some((f) => f.kind === "generic-animation")));
  });

  test("the scenes are built from the slides' own content, never from the header, footer or counters", async () => {
    const { slides } = await plan();
    for (const s of slides) {
      const labels = (s.items ?? []).map((i) => i.label).join(" ");
      assert.ok(!/DOCTYN|COURSE STUDIO|Educational demonstration only|\d\d\/09/i.test(labels), `slide ${s.slide} labels`);
      assert.ok(!/DOCTYN|COURSE STUDIO|Educational demonstration only/i.test(s.slideText.join(" ")), `slide ${s.slide} text`);
    }
    const [, two, three, four, five, six, seven, eight, nine] = slides;
    assert.deepEqual(two!.items!.filter((i) => /^n\d/.test(i.id)).map((i) => i.label), ["Suspected or confirmed infection", "Dysregulated host response", "Life-threatening organ dysfunction"]);
    assert.deepEqual(four!.items!.filter((i) => /^s\d/.test(i.id)).length, 3);
    assert.match(six!.analysis!.mechanism ?? "", /Escalate care and monitor closely/);
    assert.match(six!.rationale, /happen together/);
    assert.deepEqual(five!.items!.map((i) => i.id), ["w1", "w2", "w3"]);
    assert.deepEqual(eight!.items!.map((i) => i.label).slice(0, 3), ["Clinical presentation", "Fever + new confusion", "Rapid breathing + hypotension"]);
    assert.equal(nine!.items!.find((i) => i.id === "out")!.label, "Key Takeaways|Recognize early. Reassess often");
    assert.ok(three && seven);
  });

  test("clinical pictograms are chosen from the slide's words", async () => {
    const { slides } = await plan();
    const icons = slides.flatMap((s) => Object.entries(s.params).filter(([k]) => k.endsWith(".icon")).map(([, v]) => String(v)));
    for (const want of ["infection", "inflammation", "lungs", "brain", "flask", "alert"]) assert.ok(icons.includes(want), `icon ${want} appears`);
    for (const id of ICON_IDS) assert.match(pictogram(id, 50, 50, 60, "#fff"), /^<g transform=/);
    assert.equal(pictogram("nope", 0, 0, 10, "#fff"), "");
  });

  test("every element appears while the voice is speaking, in the slide's order, and the finished scene is complete", async () => {
    const { slides } = await plan();
    for (const s of slides.filter((x) => x.template !== "key-points")) {
      const shows = s.events.filter((e) => e.action === "show" && !/^(note|stat|out|verdict|head)/.test(e.element));
      assert.ok(shows.length >= 2, `slide ${s.slide} has timed elements`);
      for (const e of shows) assert.ok(e.start < s.durationSeconds * 0.92, `slide ${s.slide} ${e.element} appears at ${e.start}s of ${s.durationSeconds}s`);
      if (["pathway", "workflow"].includes(s.template)) {
        const chain = shows.filter((e) => /^(n|w)\d+$/.test(e.element)).sort((a, b) => a.element.localeCompare(b.element));
        for (let i = 1; i < chain.length; i++) assert.ok(chain[i]!.start >= chain[i - 1]!.start, `slide ${s.slide}: step ${i + 1} follows step ${i}`);
      }
      const end = renderFrame(s, s.durationSeconds - 0.05, {}).replace(/<[^>]+>/g, " ");
      for (const it of s.items ?? []) {
        if (/^p\d+$/.test(it.id) && s.template === "case") continue;
        assert.ok(end.includes(it.label.split(/[|\s]/)[0]!.replace(/[:,]$/, "")), `slide ${s.slide}: ${it.id} is on screen at the end`);
      }
    }
  });

  test("the animation changes over time (it is not a static slide)", async () => {
    const { slides } = await plan();
    for (const s of slides) {
      const early = renderFrame(s, 0.2, {});
      const late = renderFrame(s, s.durationSeconds * 0.9, {});
      assert.notEqual(early, late, `slide ${s.slide}`);
      assert.ok(late.length > early.length, `slide ${s.slide} gains elements as it is narrated`);
    }
  });

  test("a person can switch a generic slide to a better scene, and the choice survives", async () => {
    const p = await plan();
    const out = applyEdit(p, 1, { template: "workflow" });
    assert.equal(out.template, "workflow");
    assert.ok(out.items?.length);
    assert.ok(!out.flags.some((f) => f.kind === "generic-animation"), "no longer generic");
  });
});
