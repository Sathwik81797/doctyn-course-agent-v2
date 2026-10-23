import { loadCatalog } from "./_lib/catalog.js";

// GET /api/course-file?slug=<slug>&file=vtt|srt|transcript[&download=1]
// Same-origin proxy for the small text files, so captions load without cross-origin (CORS) setup.
// Only URLs listed in the published catalog are ever fetched.
const FILES = {
  vtt: { name: "captions.vtt", type: "text/vtt; charset=utf-8" },
  srt: { name: "captions.srt", type: "application/x-subrip; charset=utf-8" },
  transcript: { name: "transcript.txt", type: "text/plain; charset=utf-8" },
};

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const { slug, file, download } = req.query;
  const spec = FILES[String(file)];
  if (!spec || typeof slug !== "string") return res.status(400).json({ error: "Unknown course file." });
  try {
    const { courses } = await loadCatalog();
    const url = courses.find((c) => c.slug === slug)?.files?.[file]?.url;
    if (!url) return res.status(404).json({ error: "Not published." });
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).json({ error: "The file could not be loaded." });
    res.setHeader("Content-Type", spec.type);
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    if (download) res.setHeader("Content-Disposition", `attachment; filename="${slug}-${spec.name}"`);
    return res.status(200).send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    return res.status(502).json({ error: "The file could not be loaded." });
  }
}
