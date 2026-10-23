import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { cloudConfig, configProblems } from "../cloud/config.js";
import { ANIMATION_TEMPLATES, contentHash, courseKeys } from "../cloud/util.js";
import { TEMPLATES } from "../src/animation/types.js";
import { parseDocx } from "../src/services/parse-docx.js";
import { buildVoiceoverDocx } from "../src/worker/docx-builder.js";

describe("voiceover DOCX built from dashboard edits", () => {
  it("round-trips through the existing parser with numbers, titles and paragraphs intact", async () => {
    const slides = [
      { slide: 1, title: "Risk Factors for Diabetes", narration: "Welcome to this module.\n\nWe cover β-cell function and HbA1c." },
      { slide: 2, title: "Why Assessment — Is Critical", narration: "Diabetes is not an on-and-off disease." },
      { slide: 3, title: "Slide 3 of the plan", narration: "Slide 4 will follow. VOICEOVER is just a word here." },
    ];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docx-rt-"));
    try {
      const file = path.join(dir, "v.docx");
      await fs.writeFile(file, await buildVoiceoverDocx("Course", slides));
      const parsed = await parseDocx(file);
      assert.deepEqual(parsed.malformedHeadings, []);
      assert.deepEqual(parsed.records.map((r) => r.number), [1, 2, 3]);
      assert.equal(parsed.records[0]!.title, "Risk Factors for Diabetes");
      assert.equal(parsed.records[1]!.title, "Why Assessment — Is Critical");
      assert.match(parsed.records[0]!.text, /Welcome to this module\.\s+We cover β-cell function and HbA1c\./);
      assert.match(parsed.records[2]!.text, /Slide 4 will follow/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cloud helpers", () => {
  it("keeps the API's animation template list in sync with the engine", () => {
    assert.deepEqual([...ANIMATION_TEMPLATES].sort(), [...TEMPLATES].sort());
  });

  it("changes the content hash for any edit to title or narration, and only then", () => {
    const base = [{ slide: 1, title: "A", narration: "one" }];
    const h = contentHash("T", base);
    assert.equal(contentHash("T", [{ slide: 1, title: " A ", narration: "one " }]), h);
    assert.notEqual(contentHash("T", [{ slide: 1, title: "A", narration: "two" }]), h);
    assert.notEqual(contentHash("T2", base), h);
  });

  it("namespaces every storage key under the owner and course", () => {
    const k = courseKeys("user-1", "course-1");
    assert.ok(k.source("pptx", "ab").startsWith("users/user-1/courses/course-1/"));
    assert.ok(k.output("final-video.mp4").startsWith("users/user-1/courses/course-1/"));
    assert.ok(k.cache.startsWith("users/user-1/courses/course-1/"));
  });

  it("reports unsafe or incomplete production configuration in plain words", () => {
    const bad = configProblems(cloudConfig({ VERCEL: "1" }));
    assert.ok(bad.some((p) => /DATABASE_URL/.test(p)));
    assert.ok(bad.some((p) => /APP_SECRET/.test(p)));
    assert.ok(bad.some((p) => /S3_BUCKET/.test(p)));
    const fsInProd = configProblems(cloudConfig({ VERCEL: "1", DATABASE_URL: "postgres://x", APP_SECRET: "s".repeat(40), STORAGE_DRIVER: "fs" }));
    assert.ok(fsInProd.some((p) => /local development only/.test(p)));
    const good = configProblems(
      cloudConfig({ VERCEL: "1", DATABASE_URL: "postgres://x", APP_SECRET: "s".repeat(40), S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }),
    );
    assert.deepEqual(good, []);
  });
});
