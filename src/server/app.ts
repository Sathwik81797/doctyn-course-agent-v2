import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { ensureDir } from "../utils/files.js";
import { BusyError, JobManager } from "./jobs.js";
import { listCourses, listInputs, listPreviews, safeUploadName } from "./library.js";
import { handleAnimationApi, serveStudio } from "./animation-routes.js";
import { JOB_KINDS, type JobKind } from "./progress.js";

export interface DashboardOptions {
  projectRoot: string;
  inputDir: string;
  outputDir: string;
  publicDir: string;
  /** Exact origins, or patterns with * standing for one DNS label fragment ([a-z0-9-]+). */
  allowedOrigins: string[];
  tts: { provider: string; voice: string; speed: number };
  maxUploadBytes?: number;
  /** Override how jobs are launched (tests). */
  jobRunner?: { command: string; prefixArgs: string[] };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Files under output/<course>/ the dashboard may serve. Nothing else (no .env, no checkpoints of other dirs). */
const MEDIA_EXTENSIONS = new Set([".mp4", ".mp3", ".jpg", ".png", ".vtt", ".srt", ".txt", ".json"]);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function originMatcher(patterns: string[]): (origin: string) => boolean {
  const res = patterns.map(
    (p) => new RegExp(`^${p.trim().replace(/\/+$/, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+")}$`, "i"),
  );
  return (origin) => res.some((re) => re.test(origin));
}

export async function createDashboardServer(opts: DashboardOptions): Promise<{ server: http.Server; jobs: JobManager }> {
  const jobs = new JobManager(opts.projectRoot, path.join(opts.outputDir, ".dashboard"), opts.jobRunner);
  await jobs.load();
  const originAllowed = originMatcher(opts.allowedOrigins);
  const maxUpload = opts.maxUploadBytes ?? 500 * 1024 * 1024;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.destroy();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const origin = req.headers.origin;

    // Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
    const host = (req.headers.host ?? "").toLowerCase();
    const port = req.socket.localPort;
    if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) {
      throw new HttpError(421, "This dashboard backend only answers requests to localhost.");
    }

    if (origin) {
      const self = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
      if (!self.includes(origin) && !originAllowed(origin)) {
        throw new HttpError(
          403,
          `Origin ${origin} is not allowed. Add it to DASHBOARD_ALLOWED_ORIGINS in .env and restart npm run dashboard.`,
        );
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    }

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
      res.setHeader("Access-Control-Max-Age", "600");
      // Chrome Private Network Access: a public HTTPS page calling localhost.
      if (req.headers["access-control-request-private-network"]) res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.writeHead(204).end();
      return;
    }

    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (parts[0] === "api" && parts[1] === "v2") {
      if (await handleAnimationApi(req, res, parts.slice(2), opts.outputDir)) return;
      throw new HttpError(404, `No API route ${req.method} /${parts.join("/")}`);
    }
    if (parts[0] === "studio" && (req.method === "GET" || req.method === "HEAD")) return serveStudio(req, res, parts.slice(1), (f, d) => sendFile(req, res, f, d));
    if (parts[0] === "api") return api(req, res, url, parts.slice(1));
    if (parts[0] === "media" && (req.method === "GET" || req.method === "HEAD")) return media(req, res, url, parts.slice(1));
    if (req.method === "GET" || req.method === "HEAD") return staticFile(req, res, parts);
    throw new HttpError(405, "Method not allowed.");
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string[]): Promise<void> {
    if (req.method === "POST" && p[0] === "jobs" && p[1] && p[2] === "cancel") {
      if (!jobs.cancel(p[1])) throw new HttpError(409, "That job is not running.");
      return sendJson(res, 202, { ok: true });
    }
    const route = `${req.method} /${p[0] ?? ""}${req.method === "POST" && p.length > 1 ? "/…" : ""}`;
    switch (route) {
      case "GET /health":
        return sendJson(res, 200, {
          ok: true,
          service: "doctyn-course-agent",
          tts: opts.tts,
          inputDir: opts.inputDir,
          outputDir: opts.outputDir,
          currentJob: jobs.current,
        });
      case "GET /inputs":
        return sendJson(res, 200, await listInputs(opts.inputDir));
      case "PUT /inputs":
        return upload(req, res, url, p[1]);
      case "GET /courses":
        return sendJson(res, 200, { courses: await listCourses(opts.outputDir) });
      case "GET /previews":
        return sendJson(res, 200, { previews: await listPreviews(opts.outputDir) });
      case "GET /activity":
        return sendJson(res, 200, { activity: jobs.activity() });
      case "POST /jobs": {
        const body = (await readJson(req)) as { kind?: string; slides?: string };
        if (!body.kind || !(JOB_KINDS as readonly string[]).includes(body.kind)) {
          throw new HttpError(400, `Unknown job kind. Use one of: ${JOB_KINDS.join(", ")}.`);
        }
        const kind = body.kind as JobKind;
        const args: string[] = [];
        if (kind === "preview-tts" && body.slides !== undefined && String(body.slides).trim() !== "") {
          const slides = String(body.slides).replace(/\s+/g, "");
          if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(slides) || slides.length > 80) {
            throw new HttpError(400, `Invalid slide list "${body.slides}". Use e.g. 1-3 or 1,12,24.`);
          }
          args.push("--slides", slides);
        }
        try {
          return sendJson(res, 202, { job: jobs.start(kind, args) });
        } catch (err) {
          if (err instanceof BusyError) throw new HttpError(409, `${err.message} Wait for it to finish or cancel it first.`);
          throw err;
        }
      }
      case "GET /jobs": {
        const id = p[1];
        if (!id || id === "current") return sendJson(res, 200, { job: jobs.current });
        const job = jobs.get(id);
        if (!job) throw new HttpError(404, "Job not found.");
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
        const lines = await jobs.lines(id, after);
        return sendJson(res, 200, { job, lines, nextLine: after + lines.length });
      }
    }
    throw new HttpError(404, `No API route ${req.method} /api/${p.join("/")}`);
  }

  async function upload(req: http.IncomingMessage, res: http.ServerResponse, url: URL, type: string | undefined): Promise<void> {
    if (type !== "pptx" && type !== "docx") throw new HttpError(404, "Upload to /api/inputs/pptx or /api/inputs/docx.");
    if (jobs.busy) throw new HttpError(409, "A job is running and is using the input files. Upload again when it has finished.");
    const ext = `.${type}` as const;
    const rawName = url.searchParams.get("filename") ?? `course${ext}`;
    if (path.extname(rawName).toLowerCase() !== ext) {
      throw new HttpError(400, `"${rawName}" is not a ${ext} file. ${type === "pptx" ? "Save the presentation from PowerPoint as .pptx." : "Save the voiceover script from Word as .docx."}`);
    }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxUpload) throw new HttpError(413, `File is larger than the ${Math.round(maxUpload / 1048576)} MB upload limit.`);

    await ensureDir(opts.inputDir);
    const tmp = path.join(opts.inputDir, `.uploading-${type}-${process.pid}-${Date.now()}`);
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxUpload) cb(new HttpError(413, `File is larger than the ${Math.round(maxUpload / 1048576)} MB upload limit.`));
        else cb(null, chunk);
      },
    });
    try {
      const out = createWriteStream(tmp);
      await pipeline(req, counter, out);
      const fh = await fs.open(tmp, "r");
      const magic = Buffer.alloc(4);
      await fh.read(magic, 0, 4, 0);
      await fh.close();
      if (bytes === 0 || magic.toString("binary") !== "PK\x03\x04") {
        throw new HttpError(400, `"${rawName}" is not a valid ${ext} file (Office files are ZIP archives; this one is not). Re-save it and try again.`);
      }

      // The pipeline needs exactly one file of each type, so move previous ones aside (never delete them).
      const current = await listInputs(opts.inputDir);
      const replaced: string[] = [];
      if (current[type].length) {
        const archive = path.join(opts.inputDir, ".replaced", new Date().toISOString().replace(/[:.]/g, "-"));
        await ensureDir(archive);
        for (const f of current[type]) {
          await fs.rename(path.join(opts.inputDir, f.name), path.join(archive, f.name));
          replaced.push(f.name);
        }
      }
      const name = safeUploadName(rawName, ext);
      await fs.rename(tmp, path.join(opts.inputDir, name));
      const record = await jobs.recordUpload([{ type, name, bytes }], replaced);
      sendJson(res, 201, { file: { type, name, bytes }, replaced, upload: record, inputs: await listInputs(opts.inputDir) });
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async function media(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string[]): Promise<void> {
    const [slug, ...rest] = p;
    if (!slug || slug.startsWith(".") || rest.length === 0 || rest.some((s) => s === ".." || s === "." || s.includes("\\"))) {
      throw new HttpError(404, "Not found.");
    }
    const courseRoot = path.join(opts.outputDir, slug);
    const file = path.resolve(courseRoot, ...rest);
    if (!file.startsWith(courseRoot + path.sep) || !MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      throw new HttpError(404, "Not found.");
    }
    const download = url.searchParams.has("download") ? `${slug}-${path.basename(file)}` : null;
    await sendFile(req, res, file, download);
  }

  async function staticFile(req: http.IncomingMessage, res: http.ServerResponse, p: string[]): Promise<void> {
    if (p.some((s) => s.startsWith(".") || s.includes("\\"))) throw new HttpError(404, "Not found.");
    const file = path.resolve(opts.publicDir, ...(p.length ? p : ["index.html"]));
    if (!file.startsWith(path.resolve(opts.publicDir) + path.sep)) throw new HttpError(404, "Not found.");
    await sendFile(req, res, file, null);
  }

  return { server, jobs };
}

async function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, downloadName: string | null): Promise<void> {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    throw new HttpError(404, "Not found.");
  }
  if (!st.isFile()) throw new HttpError(404, "Not found.");
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Last-Modified", st.mtime.toUTCString());
  res.setHeader("Cache-Control", "no-cache");
  if (downloadName) {
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  }

  let start = 0;
  let end = st.size - 1;
  const range = req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range) : null;
  if (req.headers.range && st.size > 0) {
    if (!range || (range[1] === "" && range[2] === "")) {
      res.setHeader("Content-Range", `bytes */${st.size}`);
      res.writeHead(416).end();
      return;
    }
    if (range[1] === "") {
      start = Math.max(0, st.size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== "") end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= st.size) {
      res.setHeader("Content-Range", `bytes */${st.size}`);
      res.writeHead(416).end();
      return;
    }
    res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    res.writeHead(206);
  } else {
    res.setHeader("Content-Length", String(st.size));
    res.writeHead(200);
  }
  if (req.method === "HEAD" || st.size === 0) {
    res.end();
    return;
  }
  await pipeline(createReadStream(file, { start, end }), res).catch(() => {
    // client closed the connection (seeking in a video does this constantly)
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

export async function readJson(req: http.IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw new HttpError(413, "Request body too large.");
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}
