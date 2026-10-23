import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import { run, toFileUrl } from "../utils/exec.js";
import { ensureDir, exists, removeMatching, slideFile, writeFileAtomic } from "../utils/files.js";
import { findOptionalTool, requireTool } from "../utils/tools.js";

export type Rasterizer = "pdftoppm" | "mupdf";

/** PPTX -> PDF with headless LibreOffice, using a private profile so an open LibreOffice window cannot interfere. */
export async function convertPptxToPdf(opts: {
  pptx: string;
  workDir: string;
  config: Config;
  exportHiddenSlides: boolean;
}): Promise<string> {
  const soffice = requireTool("libreoffice", opts.config);
  await ensureDir(opts.workDir);

  // A plain ASCII file name avoids LibreOffice quirks with unusual characters.
  const src = path.join(opts.workDir, "presentation.pptx");
  const pdf = path.join(opts.workDir, "presentation.pdf");
  await fs.copyFile(opts.pptx, src);
  await fs.rm(pdf, { force: true });

  const profile = path.join(opts.config.tempDir, "libreoffice-profile");
  await ensureDir(profile);

  const filter = opts.exportHiddenSlides
    ? 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'
    : "pdf:impress_pdf_Export";

  const args = [
    `-env:UserInstallation=${toFileUrl(profile)}`,
    "--headless", "--invisible", "--nologo", "--nodefault", "--norestore", "--nolockcheck",
    "--convert-to", filter,
    "--outdir", opts.workDir,
    src,
  ];

  // On Windows, LibreOffice can crash on the first launch while it initialises a new
  // profile, and it sometimes exits 0 without writing anything. Retry, then check the result.
  const attempts = 3;
  let lastProblem = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { stdout, stderr } = await run(soffice, args, { label: "LibreOffice", timeoutMs: 15 * 60_000, cwd: opts.workDir });
      const st = await fs.stat(pdf).catch(() => null);
      if (st && st.size > 0) return pdf;
      const output = (stdout + "\n" + stderr).trim();
      lastProblem = `LibreOffice exited normally but did not write the PDF.${output ? `\n\nLibreOffice output:\n${output}` : ""}`;
    } catch (err) {
      lastProblem = (err as Error).message;
    }
    if (attempt < attempts) console.warn(`  ! LibreOffice conversion attempt ${attempt} failed; retrying...`);
  }

  throw new PipelineError(
    `LibreOffice did not produce a PDF from the presentation after ${attempts} attempts.\nExpected: ${pdf}\n\n${lastProblem}`,
    "Check that the PPTX opens in LibreOffice Impress. If LibreOffice is stuck, close all LibreOffice windows " +
      "(and soffice.bin in Task Manager), then run the build again.",
  );
}

async function loadMupdf() {
  try {
    return await import("mupdf");
  } catch (err) {
    throw new PipelineError(
      `The MuPDF PDF renderer could not be loaded: ${(err as Error).message}`,
      "Run `npm install` in the project folder, or install Poppler and set PDFTOPPM_PATH in .env.",
    );
  }
}

export async function countPdfPages(pdf: string): Promise<number> {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(await fs.readFile(pdf), "application/pdf");
  try {
    return doc.countPages();
  } finally {
    doc.destroy();
  }
}

/** Fit an arbitrary page image into an exact W x H canvas without distortion (letterbox/pillarbox). */
async function fitToFrame(input: Buffer | string, out: string, config: Config): Promise<void> {
  const { width, height, padColor } = config.video;
  const png = await sharp(input)
    .flatten({ background: padColor })
    .resize(width, height, { fit: "contain", background: padColor, kernel: "lanczos3" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFileAtomic(out, png);
}

async function rasterizeWithPdftoppm(pdftoppm: string, pdf: string, pages: number, workDir: string, config: Config): Promise<string[]> {
  const prefix = path.join(workDir, "page");
  await removeMatching(workDir, /^page-\d+\.png$/);
  // Render generously, then let sharp downscale precisely to the frame.
  const dpi = Math.max(150, Math.ceil((config.video.width / 13.333) * 1.25));
  await run(pdftoppm, ["-png", "-r", String(dpi), pdf, prefix], { label: "pdftoppm", timeoutMs: 30 * 60_000 });
  const names = (await fs.readdir(workDir)).filter((n) => /^page-\d+\.png$/.test(n));
  names.sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  if (names.length !== pages) {
    throw new PipelineError(`pdftoppm produced ${names.length} images but the PDF has ${pages} pages.`);
  }
  return names.map((n) => path.join(workDir, n));
}

/** Render every PDF page to slides/slide-NNN.png at the configured frame size. */
export async function rasterizePdf(opts: {
  pdf: string;
  slidesDir: string;
  workDir: string;
  expectedPages: number;
  config: Config;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ pngs: string[]; rasterizer: Rasterizer }> {
  const { config } = opts;
  const pages = await countPdfPages(opts.pdf);
  if (pages !== opts.expectedPages) {
    throw new PipelineError(
      `LibreOffice exported ${pages} PDF pages, but the PPTX has ${opts.expectedPages} slides.`,
      "The slide images would not line up with the narration, so the build was stopped.\n" +
        "Check for slides LibreOffice cannot render, or re-save the PPTX from PowerPoint and try again.",
    );
  }

  await ensureDir(opts.slidesDir);
  await removeMatching(opts.slidesDir, /^slide-\d+\.png$/);
  const pngs: string[] = [];

  const pdftoppm = findOptionalTool("pdftoppm", config);
  if (pdftoppm) {
    const pageImages = await rasterizeWithPdftoppm(pdftoppm, opts.pdf, pages, opts.workDir, config);
    for (const [i, img] of pageImages.entries()) {
      const out = path.join(opts.slidesDir, slideFile(i + 1, "png"));
      await fitToFrame(img, out, config);
      pngs.push(out);
      opts.onProgress?.(i + 1, pages);
    }
    return { pngs, rasterizer: "pdftoppm" };
  }

  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(await fs.readFile(opts.pdf), "application/pdf");
  try {
    for (let i = 0; i < pages; i++) {
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const scale = Math.min(config.video.width / (x1 - x0), config.video.height / (y1 - y0));
        const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        try {
          const out = path.join(opts.slidesDir, slideFile(i + 1, "png"));
          await fitToFrame(Buffer.from(pixmap.asPNG()), out, config);
          pngs.push(out);
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
      opts.onProgress?.(i + 1, pages);
    }
  } finally {
    doc.destroy();
  }
  return { pngs, rasterizer: "mupdf" };
}

/** 1280x720 JPEG from slide 1. */
export async function createThumbnail(slidePng: string, out: string, config: Config): Promise<void> {
  if (!(await exists(slidePng))) {
    throw new PipelineError(`Cannot create thumbnail: slide image not found:\n${slidePng}`);
  }
  const jpg = await sharp(slidePng)
    .resize(1280, 720, { fit: "contain", background: config.video.padColor })
    .flatten({ background: config.video.padColor })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  await writeFileAtomic(out, jpg);
}
