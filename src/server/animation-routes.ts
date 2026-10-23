/**
 * V2 endpoints: animation plans, edits and clinical review, plus the studio UI assets.
 * Mounted by app.ts under /api/v2 and /studio. Same localhost-only protections as the rest of the server.
 */
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { analyzeSlide } from "../animation/analyzer.js";
import { TEMPLATE_DEFS, elementSpecs } from "../animation/scene/core.js";
import { applyEdit, getSlide, isApproved, loadPlan, planPath, reviewSummary, savePlan, setReview } from "../animation/store.js";
import { REVIEW_STATUSES, TEMPLATES, type CoursePlan, type SlidePlan } from "../animation/types.js";
import { PipelineError } from "../utils/errors.js";
import { exists } from "../utils/files.js";
import { HttpError, readJson, sendJson } from "./app.js";

const STUDIO_DIR = path.resolve(import.meta.dirname, "..", "animation", "studio");

/** One writer at a time per process: plan.json is read-modify-write. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function courseRoot(outputDir: string, slug: string | undefined): string {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new HttpError(404, "Unknown course.");
  return path.join(outputDir, slug);
}

function describe(slide: SlidePlan) {
  return {
    ...slide,
    approved: isApproved(slide),
    elements: elementSpecs(slide).map((e) => ({ id: e.id, label: e.label, description: e.description })),
  };
}

function slideNumber(raw: string | undefined, plan: CoursePlan): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || !plan.slides.some((s) => s.slide === n)) throw new HttpError(404, `Slide ${raw} is not in this course.`);
  return n;
}

/** Turn plan/validation problems into 4xx responses instead of 500s. */
function asHttp(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof PipelineError) throw new HttpError(409, err.hint ? `${err.message}\n${err.hint}` : err.message);
  throw err;
}

export async function handleAnimationApi(req: http.IncomingMessage, res: http.ServerResponse, p: string[], outputDir: string): Promise<boolean> {
  const method = req.method ?? "GET";

  if (method === "GET" && p[0] === "courses" && p.length === 1) {
    const out = [];
    for (const e of await fs.readdir(outputDir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const root = path.join(outputDir, e.name);
      if (!(await exists(planPath(root)))) continue;
      try {
        const plan = await loadPlan(root);
        out.push({ slug: e.name, title: plan.courseTitle, slides: plan.slides.length, review: reviewSummary(plan) });
      } catch {
        // an unreadable plan is simply not listed
      }
    }
    sendJson(res, 200, { courses: out });
    return true;
  }

  if (p[0] !== "courses" && p[1] === "plan" && method === "GET") {
    const root = courseRoot(outputDir, p[0]);
    const plan = await loadPlan(root).catch(asHttp);
    sendJson(res, 200, {
      slug: plan.slug,
      courseTitle: plan.courseTitle,
      review: reviewSummary(plan),
      templates: TEMPLATES.map((id) => ({ id, name: TEMPLATE_DEFS[id].name })),
      reviewStatuses: REVIEW_STATUSES,
      slides: plan.slides.map(describe),
    });
    return true;
  }

  if (p[1] === "slides" && p[2]) {
    const root = courseRoot(outputDir, p[0]);
    const slug = p[0]!;
    const sub = p[3];

    if (method === "PUT" && !sub) {
      const body = await readJson(req, 512 * 1024);
      const slide = await exclusive(async () => {
        const plan = await loadPlan(root);
        const n = slideNumber(p[2], plan);
        const edited = applyEdit(plan, n, body);
        await savePlan(root, plan);
        return edited;
      }).catch(asHttp);
      sendJson(res, 200, { slide: describe(slide) });
      return true;
    }

    if (method === "POST" && sub === "review") {
      const body = (await readJson(req)) as { status?: string; reviewer?: string; notes?: string; acknowledge?: string[] | "all" };
      if (!body.status || !(REVIEW_STATUSES as readonly string[]).includes(body.status)) {
        throw new HttpError(400, `status must be one of: ${REVIEW_STATUSES.join(", ")}.`);
      }
      const slide = await exclusive(async () => {
        const plan = await loadPlan(root);
        const n = slideNumber(p[2], plan);
        const reviewed = setReview(plan, n, {
          status: body.status as (typeof REVIEW_STATUSES)[number],
          reviewer: typeof body.reviewer === "string" ? body.reviewer : undefined,
          notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : undefined,
          acknowledge: body.acknowledge === "all" ? "all" : Array.isArray(body.acknowledge) ? body.acknowledge.filter((x) => typeof x === "string") : undefined,
        });
        await savePlan(root, plan);
        return reviewed;
      }).catch(asHttp);
      sendJson(res, 200, { slide: describe(slide), slug });
      return true;
    }

    if (method === "POST" && sub === "reanalyze") {
      const slide = await exclusive(async () => {
        const plan = await loadPlan(root);
        const n = slideNumber(p[2], plan);
        const old = getSlide(plan, n);
        const fresh = analyzeSlide({
          slide: old.slide,
          title: old.title,
          narration: old.narration,
          slideText: old.slideText,
          durationSeconds: old.durationSeconds,
          durationSource: old.durationSource,
        });
        // keep the audio-staleness marker; review restarts because the content changed
        Object.assign(old, fresh, { audioStale: old.audioStale });
        await savePlan(root, plan);
        return old;
      }).catch(asHttp);
      sendJson(res, 200, { slide: describe(slide) });
      return true;
    }
  }
  return false;
}

const STUDIO_FILES: Record<string, { file: string; type: string }> = {
  "": { file: "index.html", type: "html" },
  "index.html": { file: "index.html", type: "html" },
  "studio.css": { file: "studio.css", type: "css" },
};

let bundle: { at: number; code: string } | undefined;

async function studioBundle(): Promise<string> {
  const entry = path.join(STUDIO_DIR, "main.ts");
  const newest = Math.max(
    ...(await Promise.all([entry, path.join(STUDIO_DIR, "..", "scene", "core.ts"), path.join(STUDIO_DIR, "..", "scene", "timing.ts")].map(async (f) => (await fs.stat(f)).mtimeMs))),
  );
  if (bundle && bundle.at >= newest) return bundle.code;
  // esbuild ships with tsx (a dev dependency); the dashboard already runs through tsx.
  const { build } = await import("esbuild");
  const out = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", target: "es2022", sourcemap: "inline", logLevel: "silent" });
  const code = out.outputFiles[0]?.text ?? "";
  bundle = { at: newest, code };
  return code;
}

export async function serveStudio(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string[],
  sendFile: (file: string, downloadName: string | null) => Promise<void>,
): Promise<void> {
  const name = p.join("/");
  if (name === "studio.js") {
    let code: string;
    try {
      code = await studioBundle();
    } catch (err) {
      throw new HttpError(500, `The studio script failed to build: ${(err as Error).message}`);
    }
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : code);
    return;
  }
  const entry = STUDIO_FILES[name];
  if (!entry) throw new HttpError(404, "Not found.");
  await sendFile(path.join(STUDIO_DIR, entry.file), null);
}
