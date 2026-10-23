import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PipelineError } from "./errors.js";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** True if the path is a regular file with at least `minBytes` bytes. */
export async function isNonEmptyFile(p: string, minBytes = 1): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile() && st.size >= minBytes;
  } catch {
    return false;
  }
}

export async function allNonEmpty(files: string[]): Promise<boolean> {
  for (const f of files) {
    if (!(await isNonEmptyFile(f))) return false;
  }
  return true;
}

/** Office lock/temp files such as "~$deck.pptx". */
export function isOfficeTempFile(name: string): boolean {
  return name.startsWith("~$") || name.startsWith(".~lock.");
}

/** 1 -> "001" */
export function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/** Slide labels in headings/transcripts: 1 -> "01" (wider when > 99 slides). */
export function padLabel(n: number, total: number): string {
  return String(n).padStart(Math.max(2, String(total).length), "0");
}

export function slideFile(n: number, ext: string): string {
  return `slide-${pad3(n)}.${ext}`;
}

/** Number embedded in names like slide-012.png, or NaN. */
export function slideNumberOf(name: string): number {
  const m = /^slide-(\d+)\./i.exec(name);
  return m ? Number(m[1]) : Number.NaN;
}

/** List slide-NNN.<ext> files in a directory, sorted numerically (not lexically). */
export async function listSlideFiles(dir: string, ext: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const re = new RegExp(`^slide-\\d+\\.${ext}$`, "i");
  const names = (await fs.readdir(dir)).filter((n) => re.test(n));
  names.sort((a, b) => slideNumberOf(a) - slideNumberOf(b));
  return names.map((n) => path.join(dir, n));
}

export async function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(p)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export function sha256(...parts: Array<string | number | boolean | undefined>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${String(part)}\u0000`);
  return hash.digest("hex");
}

/** Write via a temp file + rename so a crash never leaves a half-written file behind. */
export async function writeFileAtomic(p: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, p);
}

export async function copyIfChanged(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  try {
    const [a, b] = await Promise.all([fs.stat(src), fs.stat(dest)]);
    if (a.size === b.size && (await sha256File(src)) === (await sha256File(dest))) return;
  } catch {
    // destination missing: copy below
  }
  await fs.copyFile(src, dest);
}

/** Remove files in `dir` matching `re` (used to clear stale numbered outputs). */
export async function removeMatching(dir: string, re: RegExp): Promise<void> {
  if (!(await exists(dir))) return;
  for (const name of await fs.readdir(dir)) {
    if (re.test(name)) await fs.rm(path.join(dir, name), { force: true });
  }
}

export async function assertWritableDir(dir: string, label: string): Promise<void> {
  try {
    await ensureDir(dir);
    const probe = path.join(dir, `.write-test-${process.pid}`);
    await fs.writeFile(probe, "ok");
    await fs.rm(probe, { force: true });
  } catch (err) {
    throw new PipelineError(
      `The ${label} folder is not writable:\n${dir}`,
      `Details: ${(err as Error).message}\nCheck folder permissions, or close programs (e.g. OneDrive sync, media players) that may be locking files.`,
    );
  }
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (failed === undefined) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== undefined) throw failed;
  return results;
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}
