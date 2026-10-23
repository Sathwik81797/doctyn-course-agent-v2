import { loadCatalog } from "./_lib/catalog.js";

// GET /api/library -> the courses published to Vercel Blob (public data only).
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed." });
  }
  try {
    const catalog = await loadCatalog();
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=300");
    return res.status(200).json(catalog);
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "The video library could not be loaded.", courses: [] });
  }
}
