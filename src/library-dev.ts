/**
 * npm run library:dev
 *
 * The dashboard in video-library mode on http://127.0.0.1:8791/, reading the REAL private Vercel Blob store with the
 * BLOB_READ_WRITE_TOKEN from .env.local (or .env) — the same code the Vercel function runs. No database, no S3.
 * Needs LIBRARY_USERS (see npm run library:hash-password) in .env.local / .env; APP_SECRET is generated for local use.
 */
import { config as loadEnv } from "dotenv";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createLibraryHandler, libraryConfig, libraryModeConfigured, libraryProblems, vercelBlobReader } from "../cloud/library.js";
import { sendJson } from "../cloud/routes.js";
import { PROJECT_ROOT } from "./utils/config.js";

loadEnv({ path: path.join(PROJECT_ROOT, ".env.local"), quiet: true });
loadEnv({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
delete process.env.DATABASE_URL; // library mode is the no-database mode
if (!process.env.APP_SECRET) {
  const f = path.join(PROJECT_ROOT, ".data", "dev-secret");
  mkdirSync(path.dirname(f), { recursive: true });
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex"));
  process.env.APP_SECRET = readFileSync(f, "utf8").trim();
}
if (!libraryModeConfigured(process.env)) {
  console.error("Library mode is not configured:\n- " + libraryProblems(process.env).join("\n- "));
  console.error("\nExample (Git Bash):\n  read -s -p 'Password: ' LIBRARY_PASSWORD; export LIBRARY_PASSWORD\n  npm run library:hash-password -- you@example.com   # then put the printed line in .env.local as LIBRARY_USERS=...");
  process.exit(1);
}

const cfg = libraryConfig(process.env);
const handle = createLibraryHandler({ config: cfg, readBlob: vercelBlobReader(cfg.blobToken) });
const publicDir = path.join(PROJECT_ROOT, "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const port = Number(process.env.LIBRARY_DEV_PORT || 8791);

http
  .createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/v3")) return handle(req, res);
      const file = path.resolve(publicDir, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)));
      if (!file.startsWith(publicDir + path.sep) || !(await fs.stat(file).then((s) => s.isFile(), () => false))) return sendJson(res, 404, { error: "Not found." });
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      createReadStream(file).pipe(res);
    })();
  })
  .listen(port, "127.0.0.1", () => console.log(`Doctyn video library (private Blob) at http://127.0.0.1:${port}/  — ${cfg.users.size} invited user(s)`));
