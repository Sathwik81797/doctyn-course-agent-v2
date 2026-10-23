/**
 * npm run animate -- <command>
 *
 *   analyze [--ai]              build output/<slug>/animation/plan.json from ./input (keeps existing edits unless --force)
 *   status                      template + review state of every slide
 *   approve --slide N --reviewer "Name" [--notes "..."]   acknowledge all flags and approve one slide
 *   render [--slides 3,12,14] [--draft] [--quality draft|final] [--fps 24]
 *   preview [--slides 8,9] [--clips]  still frames + contact sheets in animation/preview/; --clips renders short draft MP4 clips instead
 *   render --enhanced [--draft]   same, into animation/enhanced/ (never overwrites the existing video); unchanged segments are reused
 *   review-pack                 write animation/review-pack.md for the clinician (what is on screen, when, flags, approve commands)
 *   verify [--video FILE]       duration, audio, resolution and topic-specific coverage checks
 *   demo                        render the three diabetes example slides (3, 12, 14) as draft MP4s + stills
 *
 * Local only. `analyze --ai` is the only command that can call a paid API (OpenAI).
 */
import path from "node:path";
import { aiAnalyzer, openAiComplete } from "./animation/ai.js";
import { buildCoursePlan } from "./animation/build-plan.js";
import fs from "node:fs/promises";
import { renderPreviews, previewDir } from "./animation/preview.js";
import { buildReviewPack } from "./animation/review-pack.js";
import { verifyVideo } from "./animation/verify.js";
import { animationPaths, renderAnimatedVideo, renderSlideSegment, renderStill } from "./animation/render.js";
import { getSlide, isApproved, loadPlan, planPath, reviewSummary, savePlan, setReview } from "./animation/store.js";
import { loadConfig } from "./utils/config.js";
import { PipelineError, runMain } from "./utils/errors.js";
import { exists, formatDuration, pad3 } from "./utils/files.js";

export const DEMO_SLIDES = [3, 12, 14];

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? "" : v;
}

function parseSlides(v: string | undefined): number[] | undefined {
  if (!v) return undefined;
  const out = new Set<number>();
  for (const part of v.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new PipelineError(`Invalid slide list "${v}". Use e.g. 3,12,14 or 1-5.`);
    for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

async function courseRootFromInput(config: ReturnType<typeof loadConfig>): Promise<string> {
  const { loadCourse } = await import("./services/course.js");
  return (await loadCourse(config)).paths.root;
}

runMain(async () => {
  const [cmd = "help", ...args] = process.argv.slice(2);
  const config = loadConfig();

  switch (cmd) {
    case "analyze": {
      const useAi = args.includes("--ai");
      const ai = useAi ? aiAnalyzer(openAiComplete(config)) : undefined;
      const { plan, courseRoot } = await buildCoursePlan(config, { ...(ai ? { ai } : {}), log: console.log });
      if ((await exists(planPath(courseRoot))) && !args.includes("--force")) {
        throw new PipelineError(
          `An animation plan already exists: ${planPath(courseRoot)}`,
          "Re-running analyze would discard edits and approvals. Use --force to replace it.",
        );
      }
      await savePlan(courseRoot, plan);
      const by = new Map<string, number>();
      for (const s of plan.slides) by.set(s.template, (by.get(s.template) ?? 0) + 1);
      console.log(`ANIMATION PLAN CREATED (${useAi ? "AI-assisted" : "rule-based"})`);
      console.log(`Course: ${plan.courseTitle}`);
      console.log(`Slides: ${plan.slides.length}`);
      for (const [t, n] of by) console.log(`  ${t.padEnd(15)} ${n}`);
      console.log(`Estimated-duration slides: ${plan.slides.filter((s) => s.durationSource === "estimated").length} (run build-course first for exact audio timing)`);
      console.log(`Plan: ${planPath(courseRoot)}`);
      console.log("Next: npm run dashboard  →  http://127.0.0.1:8788/#/studio");
      return 0;
    }

    case "status": {
      const root = await courseRootFromInput(config);
      const plan = await loadPlan(root);
      for (const s of plan.slides) {
        const state = isApproved(s) ? "APPROVED" : s.review.status === "approved" ? "EDITED-SINCE-APPROVAL" : s.review.status.toUpperCase();
        console.log(`${pad3(s.slide)}  ${s.template.padEnd(15)} ${state.padEnd(22)} flags ${s.flags.filter((f) => !f.acknowledged).length}/${s.flags.length}  ${s.title}`);
      }
      const r = reviewSummary(plan);
      console.log(`\n${r.approved}/${r.total} approved, ${r.needs_review} need review, ${r.rejected} rejected`);
      return 0;
    }

    case "approve": {
      const n = Number(flag(args, "slide"));
      if (!Number.isInteger(n)) throw new PipelineError("Use: npm run animate -- approve --slide N --reviewer \"Name\"");
      const root = await courseRootFromInput(config);
      const plan = await loadPlan(root);
      const slide = getSlide(plan, n);
      const notes = flag(args, "notes");
      setReview(plan, n, { status: "approved", reviewer: flag(args, "reviewer"), acknowledge: "all", ...(notes ? { notes } : {}) });
      await savePlan(root, plan);
      console.log(`Slide ${n} approved by ${slide.review.reviewer}. ${slide.flags.length} flag(s) acknowledged.`);
      return 0;
    }

    case "preview": {
      const root = await courseRootFromInput(config);
      const plan = await loadPlan(root);
      const only = parseSlides(flag(args, "slides"));
      const chosen = plan.slides.filter((s) => !only || only.includes(s.slide));
      if (args.includes("--clips")) {
        // Motion previews: half-resolution draft clips with the narration, in their own folder.
        const clipDir = path.join(previewDir(root), "clips");
        for (const s of chosen) {
          const out = path.join(clipDir, `slide-${pad3(s.slide)}-${s.template}.mp4`);
          await renderSlideSegment({ slide: s, courseRoot: root, out, config, settings: { fps: 24, scale: 0.5, draft: true, log: console.log } });
          console.log(`  clip → ${out}`);
        }
        return 0;
      }
      const r = await renderPreviews(root, chosen, console.log);
      console.log(`
PREVIEW: ${r.stills} stills, ${r.sheets.length} contact sheet(s)
Folder: ${previewDir(root)}`);
      for (const f of r.sheets) console.log("  " + f);
      return 0;
    }

    case "render":
    case "demo": {
      const root = await courseRootFromInput(config);
      const plan = await loadPlan(root);
      const demo = cmd === "demo";
      const quality = flag(args, "quality") ?? (demo ? "draft" : "final");
      const fps = Number(flag(args, "fps") ?? (demo ? 24 : config.video.fps));
      const slides = demo ? DEMO_SLIDES : parseSlides(flag(args, "slides"));
      const settings = { fps, scale: quality === "draft" ? 0.5 : 1, draft: demo || args.includes("--draft"), log: console.log };
      console.log(`${demo ? "DEMO" : "RENDER"}: ${slides ? `slides ${slides.join(", ")}` : "all slides"} · ${quality} quality · ${fps} fps${settings.draft ? " · DRAFT watermark on unapproved slides" : ""}`);
      const dirs = animationPaths(root);
      if (demo) {
        // One MP4 per example so each can be reviewed separately.
        for (const [i, n] of DEMO_SLIDES.entries()) {
          const slide = getSlide(plan, n);
          const out = path.join(dirs.demos, `demo-${i + 1}-slide-${pad3(n)}-${slide.template}.mp4`);
          const r = await renderAnimatedVideo({ plan, courseRoot: root, config, settings, slides: [n], out });
          for (const f of [0.25, 0.6, 0.95]) await renderStill(slide, slide.durationSeconds * f, path.join(dirs.stills, `slide-${pad3(n)}-t${Math.round(f * 100)}.png`), 1, "DRAFT — NOT CLINICALLY APPROVED");
          console.log(`  → ${r.file}`);
        }
        console.log(`\nStills: ${dirs.stills}`);
        return 0;
      }
      if (args.includes("--enhanced")) {
        // Separate folder: the earlier video and its segments stay exactly as they were.
        const enh = path.join(dirs.root, "enhanced");
        const segDir = path.join(enh, "segments");
        await fs.mkdir(segDir, { recursive: true });
        let seeded = 0;
        for (const f of await fs.readdir(dirs.segments).catch(() => [] as string[])) {
          if (!/^slide-\d+\.mp4(\.key)?$/.test(f)) continue;
          try {
            await fs.copyFile(path.join(dirs.segments, f), path.join(segDir, f), fs.constants.COPYFILE_EXCL);
            seeded++;
          } catch {
            // already present in the enhanced folder
          }
        }
        console.log(`Seeded ${seeded} earlier segment file(s); segments whose content is unchanged are reused, the rest are re-rendered.`);
        const out = path.join(enh, settings.draft ? "animated-video.enhanced.draft.mp4" : "animated-video.enhanced.mp4");
        const e = await renderAnimatedVideo({ plan, courseRoot: root, config, settings, segmentsDir: segDir, out, ...(slides ? { slides } : {}) });
        console.log(`\nENHANCED VIDEO COMPLETE\nSlides: ${e.segments} (${e.reused} reused, ${e.segments - e.reused} re-rendered)\nDuration: ${formatDuration(e.seconds)}\nOutput: ${e.file}`);
        return 0;
      }
      const r = await renderAnimatedVideo({ plan, courseRoot: root, config, settings, ...(slides ? { slides } : {}) });
      console.log(`\nANIMATED VIDEO COMPLETE\nSlides: ${r.segments} (${r.reused} reused)\nDuration: ${formatDuration(r.seconds)}\nOutput: ${r.file}`);
      return 0;
    }

    case "review-pack": {
      const root = await courseRootFromInput(config);
      const plan = await loadPlan(root);
      const baseFile = path.join(animationPaths(root).root, "plan.baseline-key-points.json");
      const baseline = (await exists(baseFile)) ? (JSON.parse(await fs.readFile(baseFile, "utf8")) as typeof plan) : undefined;
      const out = path.join(animationPaths(root).root, "review-pack.md");
      await fs.writeFile(out, buildReviewPack(plan, baseline), "utf8");
      console.log(`Review pack written: ${out}`);
      return 0;
    }

    case "verify": {
      const root = await courseRootFromInput(config);
      const plan = await loadPlan(root);
      const base = animationPaths(root).root;
      const candidates = [flag(args, "video"), path.join(base, "enhanced", "animated-video.enhanced.mp4"), path.join(base, "enhanced", "animated-video.enhanced.draft.mp4"), path.join(base, "animated-video.draft.mp4")];
      let file: string | undefined;
      for (const c of candidates) {
        if (c && (await exists(c))) {
          file = c;
          break;
        }
      }
      if (!file) throw new PipelineError("No animated video found to verify.", "Render one first: npm run animate -- render --enhanced --draft");
      console.log(`VERIFY: ${file}`);
      const checks = await verifyVideo(file, plan, config);
      for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n        ${c.detail}`);
      const failed = checks.filter((c) => !c.ok).length;
      console.log(failed ? `\nRESULT: FAIL (${failed})` : "\nRESULT: PASS");
      return failed ? 1 : 0;
    }

    default:
      console.log("Commands: analyze [--ai] [--force] | status | approve --slide N --reviewer NAME | preview [--slides 3,12] [--clips] | review-pack | render [--slides 3,12] [--draft] [--enhanced] [--quality draft|final] | verify [--video FILE] | demo");
      return cmd === "help" ? 0 : 1;
  }
});
