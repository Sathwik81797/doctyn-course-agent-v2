import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { del, list, put } from "@vercel/blob";
import { listCourses, type CourseSummary } from "../server/library.js";
import { PipelineError } from "../utils/errors.js";

/**
 * Only these files are ever published. Source PPTX/DOCX, checkpoint.json, qa/, audio/, slides/ and
 * video-segments/ are deliberately not on this list.
 */
export const PUBLISHABLE = [
  { key: "video", file: "final-video.mp4", contentType: "video/mp4", required: true },
  { key: "thumbnail", file: "thumbnail.jpg", contentType: "image/jpeg", required: true },
  { key: "vtt", file: "captions.vtt", contentType: "text/vtt; charset=utf-8", required: true },
  { key: "srt", file: "captions.srt", contentType: "application/x-subrip; charset=utf-8", required: true },
  { key: "transcript", file: "transcript.txt", contentType: "text/plain; charset=utf-8", required: false },
] as const;

export type FileKey = (typeof PUBLISHABLE)[number]["key"];

export const CATALOG_PATH = "library/catalog.json";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;

export interface CatalogCourse {
  slug: string;
  title: string;
  slideCount: number | null;
  durationSeconds: number | null;
  generatedAt: string | null;
  publishedAt: string;
  files: Partial<Record<FileKey, { url: string; bytes: number }>>;
}

export interface Catalog {
  version: 1;
  updatedAt: string;
  courses: CatalogCourse[];
}

export interface PlanFile {
  key: FileKey;
  localPath: string;
  blobPath: string;
  contentType: string;
  bytes: number;
}

export interface PublishPlan {
  course: CourseSummary;
  files: PlanFile[];
  totalBytes: number;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Check a course is genuinely complete and list exactly what would be uploaded. */
export async function buildPlan(outputDir: string, slug: string): Promise<PublishPlan> {
  if (!isValidSlug(slug)) {
    throw new PipelineError(
      `"${slug}" cannot be published.`,
      "Course folder names must be lowercase letters, digits and hyphens so they make safe web addresses.",
    );
  }
  const course = (await listCourses(outputDir)).find((c) => c.slug === slug);
  if (!course) throw new PipelineError(`No course folder named "${slug}" in ${outputDir}.`, "Run `npm run publish-course` with no arguments to list courses.");
  if (course.status !== "complete") {
    throw new PipelineError(
      `Course "${slug}" is not complete (status: ${course.status}).`,
      "Only courses whose build finished and passed final validation can be published. Run `npm run build-course` first.",
    );
  }
  const files: PlanFile[] = [];
  const missing: string[] = [];
  for (const spec of PUBLISHABLE) {
    const localPath = path.join(outputDir, slug, spec.file);
    const st = await fs.stat(localPath).catch(() => null);
    if (!st?.isFile() || st.size === 0) {
      if (spec.required) missing.push(spec.file);
      continue;
    }
    files.push({ key: spec.key, localPath, blobPath: `courses/${slug}/${spec.file}`, contentType: spec.contentType, bytes: st.size });
  }
  if (missing.length) throw new PipelineError(`Course "${slug}" is missing: ${missing.join(", ")}.`, "Re-run `npm run build-course` to regenerate them.");
  return { course, files, totalBytes: files.reduce((n, f) => n + f.bytes, 0) };
}

export function catalogEntry(plan: PublishPlan, urls: Partial<Record<FileKey, string>>, publishedAt: string): CatalogCourse {
  const files: CatalogCourse["files"] = {};
  for (const f of plan.files) {
    const url = urls[f.key];
    if (url) files[f.key] = { url, bytes: f.bytes };
  }
  return {
    slug: plan.course.slug,
    title: plan.course.title,
    slideCount: plan.course.slideCount,
    durationSeconds: plan.course.durationSeconds,
    generatedAt: plan.course.generatedAt,
    publishedAt,
    files,
  };
}

export function upsertCourse(catalog: Catalog | null, entry: CatalogCourse, now: string): Catalog {
  const others = (catalog?.courses ?? []).filter((c) => c.slug !== entry.slug);
  return { version: 1, updatedAt: now, courses: [entry, ...others] };
}

export function removeCourse(catalog: Catalog, slug: string, now: string): Catalog {
  return { version: 1, updatedAt: now, courses: catalog.courses.filter((c) => c.slug !== slug) };
}

/** Credentials passed to every @vercel/blob call: a read-write token, or a Vercel OIDC token plus store id. */
export type BlobAuth = { token: string } | { oidcToken: string; storeId: string };

function storeIdOf(auth: BlobAuth): string | null {
  if ("storeId" in auth) return auth.storeId.replace(/^store_/, "").toLowerCase();
  return /^vercel_blob_rw_([a-z0-9]+)_/i.exec(auth.token)?.[1]?.toLowerCase() ?? null;
}

/** The catalog URL the website derives from the credentials (must match where the catalog really lives). */
export function expectedCatalogUrl(auth: BlobAuth | string): string | null {
  const id = storeIdOf(typeof auth === "string" ? { token: auth } : auth);
  return id ? `https://${id}.public.blob.vercel-storage.com/${CATALOG_PATH}` : null;
}

/** Looks for credentials without throwing; OIDC (VERCEL_OIDC_TOKEN + BLOB_STORE_ID) wins, like the SDK. */
export function findAuth(env: NodeJS.ProcessEnv = process.env): BlobAuth | null {
  const oidcToken = env["VERCEL_OIDC_TOKEN"]?.trim();
  const storeId = env["BLOB_STORE_ID"]?.trim();
  if (oidcToken && storeId) return { oidcToken, storeId };
  const token = env["BLOB_READ_WRITE_TOKEN"]?.trim();
  return token ? { token } : null;
}

export function requireAuth(env: NodeJS.ProcessEnv = process.env): BlobAuth {
  const auth = findAuth(env);
  if (auth) return auth;
  if (env["VERCEL_OIDC_TOKEN"]?.trim()) {
    throw new PipelineError(
      "VERCEL_OIDC_TOKEN is set but BLOB_STORE_ID is not.",
      "Add your Blob store id (store_...) to .env.local or .env as BLOB_STORE_ID=... " +
        "(Vercel dashboard -> Storage -> your Blob store). OIDC tokens from `vercel env pull` expire after about 12 hours; pull again if uploads are rejected.",
    );
  }
  throw new PipelineError(
    "No Vercel Blob credentials found.",
    "Run `vercel env pull .env.local` (VERCEL_OIDC_TOKEN) and set BLOB_STORE_ID, or set BLOB_READ_WRITE_TOKEN. " +
      "See the 'Publishing to Vercel' section of README.md.",
  );
}

export async function readCatalog(auth: BlobAuth): Promise<Catalog | null> {
  const found = await list({ prefix: CATALOG_PATH, ...auth, limit: 5 });
  const blob = found.blobs.find((b) => b.pathname === CATALOG_PATH);
  if (!blob) return null;
  const res = await fetch(`${blob.url}?t=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new PipelineError(`The existing catalog could not be read (HTTP ${res.status}).`, "Nothing was changed.");
  return (await res.json()) as Catalog;
}

export async function writeCatalog(auth: BlobAuth, catalog: Catalog): Promise<string> {
  const result = await put(CATALOG_PATH, JSON.stringify(catalog, null, 2), {
    access: "public",
    ...auth,
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  });
  return result.url;
}

/** Uploads media first and the catalog last, so the website never lists a course whose files are missing. */
export async function uploadPlan(
  auth: BlobAuth,
  plan: PublishPlan,
  onProgress: (file: PlanFile, percent: number) => void,
): Promise<{ entry: CatalogCourse; catalogUrl: string }> {
  const urls: Partial<Record<FileKey, string>> = {};
  for (const f of plan.files) {
    const result = await put(f.blobPath, createReadStream(f.localPath), {
      access: "public",
      ...auth,
      contentType: f.contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      multipart: f.bytes > 8 * 1024 * 1024,
      onUploadProgress: (e) => onProgress(f, e.percentage),
    });
    urls[f.key] = result.url;
  }
  const now = new Date().toISOString();
  const entry = catalogEntry(plan, urls, now);
  const catalogUrl = await writeCatalog(auth, upsertCourse(await readCatalog(auth), entry, now));
  return { entry, catalogUrl };
}

/** Removes the course's files and its catalog entry. Local files are never touched. */
export async function unpublish(auth: BlobAuth, slug: string): Promise<string[]> {
  if (!isValidSlug(slug)) throw new PipelineError(`"${slug}" is not a valid course slug.`);
  const catalog = await readCatalog(auth);
  const found = await list({ prefix: `courses/${slug}/`, ...auth, limit: 100 });
  const urls = found.blobs.map((b) => b.url);
  if (catalog) await writeCatalog(auth, removeCourse(catalog, slug, new Date().toISOString()));
  if (urls.length) await del(urls, { ...auth });
  return found.blobs.map((b) => b.pathname);
}
