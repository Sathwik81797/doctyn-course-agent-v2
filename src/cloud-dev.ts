/**
 * npm run cloud:dev
 *
 * The whole cloud app on http://127.0.0.1:8790 for development and testing: the same API handler
 * Vercel runs, a real Postgres (PGlite in-process, or DATABASE_URL), local-disk "object storage",
 * and the render worker in the same process (PGlite allows one process per database).
 * Set DEV_WORKER=false to run `npm run worker` separately against a shared DATABASE_URL.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { ConfigError, getContext } from "../cloud/context.js";
import { handleApi, sendJson } from "../cloud/routes.js";
import { PROJECT_ROOT } from "./utils/config.js";
import { runWorker } from "./worker/loop.js";

process.chdir(PROJECT_ROOT);
process.env.STORAGE_DRIVER ??= process.env.S3_BUCKET ? "s3" : "fs";
if (!process.env.APP_SECRET) {
  const f = path.join(".data", "dev-secret");
  mkdirSync(".data", { recursive: true });
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex"));
  process.env.APP_SECRET = readFileSync(f, "utf8").trim();
}
const port = Number(process.env.CLOUD_DEV_PORT || 8790);
const publicDir = path.join(PROJECT_ROOT, "public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/v3")) {
      try {
        return await handleApi(await getContext(), req, res);
      } catch (err) {
        return sendJson(res, 503, { error: err instanceof ConfigError ? err.message : String(err) });
      }
    }
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || !(await fs.stat(file).then((s) => s.isFile(), () => false))) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    createReadStream(file).pipe(res);
  })();
});

const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (ac.abort(), server.close()));

server.listen(port, "127.0.0.1", () => {
  console.log(`Doctyn cloud (development) at http://127.0.0.1:${port}`);
  if (process.env.DEV_WORKER !== "false") {
    getContext()
      .then((ctx) => runWorker(ctx, { workRoot: path.join(PROJECT_ROOT, ".data", "work"), signal: ac.signal }))
      .catch((err) => console.error(err instanceof ConfigError ? err.message : err));
  }
});
