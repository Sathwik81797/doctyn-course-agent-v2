// Shared by the serverless functions. Underscore folders are not routed by Vercel.
// Reads the published-course catalog that `npm run publish-course` writes to Vercel Blob.

const CATALOG_PATH = "library/catalog.json";
const FILE_KEYS = ["video", "thumbnail", "vtt", "srt", "transcript"];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;

/** Public URL of the catalog: LIBRARY_CATALOG_URL, else derived from the Blob store id inside the token. */
export function catalogUrl(env = process.env) {
  const explicit = (env.LIBRARY_CATALOG_URL || "").trim();
  if (explicit) return explicit;
  const m = /^vercel_blob_rw_([a-z0-9]+)_/i.exec((env.BLOB_READ_WRITE_TOKEN || "").trim());
  return m ? `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com/${CATALOG_PATH}` : null;
}

function isBlobUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

/** Keep only well-formed courses whose files live on Vercel Blob; drop anything unexpected. */
export function cleanCatalog(raw) {
  const courses = [];
  for (const c of Array.isArray(raw?.courses) ? raw.courses : []) {
    if (!c || typeof c.slug !== "string" || !SLUG_RE.test(c.slug)) continue;
    const files = {};
    for (const key of FILE_KEYS) {
      const f = c.files?.[key];
      if (f && isBlobUrl(f.url)) files[key] = { url: f.url, bytes: Number.isFinite(f.bytes) ? f.bytes : null };
    }
    if (!files.video) continue;
    courses.push({
      slug: c.slug,
      title: String(c.title || c.slug).slice(0, 300),
      slideCount: Number.isFinite(c.slideCount) ? c.slideCount : null,
      durationSeconds: Number.isFinite(c.durationSeconds) ? c.durationSeconds : null,
      generatedAt: typeof c.generatedAt === "string" ? c.generatedAt : null,
      publishedAt: typeof c.publishedAt === "string" ? c.publishedAt : null,
      files,
    });
  }
  courses.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  return courses;
}

export async function loadCatalog(env = process.env, fetchImpl = fetch) {
  const url = catalogUrl(env);
  if (!url) return { configured: false, courses: [] };
  const res = await fetchImpl(`${url}?t=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  if (res.status === 404) return { configured: true, courses: [] };
  if (!res.ok) throw new Error(`Catalog request failed with HTTP ${res.status}.`);
  return { configured: true, courses: cleanCatalog(await res.json()) };
}

export { FILE_KEYS, SLUG_RE };
