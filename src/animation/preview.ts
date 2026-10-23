/**
 * Review previews: still frames at three points of each slide's narration plus contact sheets
 * (one tile per slide, drawn near the end of the animation). Images only; no video is rendered.
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ensureDir, pad3 } from "../utils/files.js";
import { DRAFT_WATERMARK, animationPaths, rasterFrame, renderStill } from "./render.js";
import { isApproved } from "./store.js";
import type { SlidePlan } from "./types.js";

export const PREVIEW_POINTS = [0.25, 0.6, 0.95];
const TILE_W = 640;
const TILE_H = 360;
const COLS = 3;

export function previewDir(courseRoot: string): string {
  return path.join(animationPaths(courseRoot).root, "preview");
}

export async function renderPreviews(courseRoot: string, slides: SlidePlan[], log: (m: string) => void = () => undefined): Promise<{ stills: number; sheets: string[] }> {
  const dir = previewDir(courseRoot);
  await ensureDir(dir);
  for (const f of await fs.readdir(dir)) if (/^contact-sheet-.*.png$/.test(f)) await fs.rm(path.join(dir, f));
  let stills = 0;
  const finals: Array<{ slide: SlidePlan; file: string }> = [];
  for (const slide of slides) {
    const wm = isApproved(slide) ? undefined : DRAFT_WATERMARK;
    for (const f of PREVIEW_POINTS) {
      const out = path.join(dir, `slide-${pad3(slide.slide)}-t${Math.round(f * 100)}.png`);
      await renderStill(slide, slide.durationSeconds * f, out, 1, wm);
      stills++;
      if (f === PREVIEW_POINTS[PREVIEW_POINTS.length - 1]) finals.push({ slide, file: out });
    }
    log(`  slide ${pad3(slide.slide)} ${slide.template}`);
  }
  const sheets: string[] = [];
  const perSheet = COLS * 4;
  for (let i = 0; i < finals.length; i += perSheet) {
    const group = finals.slice(i, i + perSheet);
    const rows = Math.ceil(group.length / COLS);
    const tiles = await Promise.all(
      group.map(async ({ file }, k) => ({
        input: await sharp(await fs.readFile(file)).resize(TILE_W, TILE_H).png().toBuffer(),
        left: (k % COLS) * (TILE_W + 8),
        top: Math.floor(k / COLS) * (TILE_H + 8),
      })),
    );
    const out = path.join(dir, `contact-sheet-${String(sheets.length + 1).padStart(2, "0")}-slides-${pad3(group[0]!.slide.slide)}-${pad3(group[group.length - 1]!.slide.slide)}.png`);
    await sharp({ create: { width: COLS * TILE_W + (COLS - 1) * 8, height: rows * TILE_H + (rows - 1) * 8, channels: 3, background: "#000000" } })
      .composite(tiles)
      .png()
      .toFile(out);
    sheets.push(out);
  }
  return { stills, sheets };
}

export { rasterFrame };
