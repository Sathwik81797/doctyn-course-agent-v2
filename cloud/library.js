// @ts-check
// Library mode: a small, fully server-side way to show videos that are already in a PRIVATE Vercel Blob store,
// with no Postgres and no S3. It provides just enough of the /api/v3 surface for the existing dashboard:
//   - sign-in against a fixed list of invited users (scrypt password hashes in LIBRARY_USERS), stateless signed cookie
//   - the catalog (cloud/library-catalog.js) as the course list
//   - an authenticated streaming endpoint (Range supported) that reads the blob with BLOB_READ_WRITE_TOKEN
// The Blob token and the private blob URLs never leave the server.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { HttpError, readJsonBody, hashPassword, sessionCookie, clearCookie, sessionTokenFromCookie, verifyPassword } from "./auth.js";
import { LIBRARY_VIDEOS } from "./library-catalog.js";
import { checkCsrf, sendJson } from "./routes.js";
import { OUTPUT_FILES, normalizeRouteUrl } from "./util.js";

/**
 * @typedef {Object} LibraryConfig
 * @property {string} blobToken
 * @property {string} secret
 * @property {Map<string, string>} users      lower-case email -> scrypt hash
 * @property {number} sessionDays
 * @property {boolean} secureCookies
 */
/**
 * Reads a blob (optionally a byte range). Returns null when it does not exist.
 * @typedef {(pathname: string, o: { range?: string }) => Promise<{ headers: { get(name: string): string | null }, stream: ReadableStream<Uint8Array> } | null>} BlobReader
 */
/** @typedef {{ config: LibraryConfig, readBlob: BlobReader, videos?: typeof LIBRARY_VIDEOS }} LibraryContext */

/** "a@x.org=scrypt$..,b@y.org=scrypt$.." (comma or newline separated). @param {string | undefined} text */
export function parseLibraryUsers(text) {
  /** @type {Map<string, string>} */
  const users = new Map();
  for (const entry of (text ?? "").split(/[\n,]+/)) {
    const i = entry.indexOf("=");
    if (i < 1) continue;
    const email = entry.slice(0, i).trim().toLowerCase();
    const hash = entry.slice(i + 1).trim();
    if (email && hash.startsWith("scrypt$")) users.set(email, hash);
  }
  return users;
}

/** Library mode is used when it is configured AND no database is (a full deployment takes precedence). @param {Record<string, string | undefined>} env */
export function libraryModeConfigured(env) {
  return !env.DATABASE_URL && Boolean(env.BLOB_READ_WRITE_TOKEN?.trim()) && parseLibraryUsers(env.LIBRARY_USERS).size > 0 && (env.APP_SECRET?.trim().length ?? 0) >= 32;
}

/** @param {Record<string, string | undefined>} env @returns {LibraryConfig} */
export function libraryConfig(env) {
  const days = Number(env.SESSION_DAYS);
  return {
    blobToken: (env.BLOB_READ_WRITE_TOKEN ?? "").trim(),
    secret: (env.APP_SECRET ?? "").trim(),
    users: parseLibraryUsers(env.LIBRARY_USERS),
    sessionDays: Number.isFinite(days) && days > 0 ? days : 7,
    secureCookies: Boolean(env.VERCEL) || env.NODE_ENV === "production",
  };
}

/** Problems that stop library mode from working, in plain words. @param {Record<string, string | undefined>} env */
export function libraryProblems(env) {
  /** @type {string[]} */
  const p = [];
  if (!env.BLOB_READ_WRITE_TOKEN?.trim()) p.push("BLOB_READ_WRITE_TOKEN is not set.");
  if (parseLibraryUsers(env.LIBRARY_USERS).size === 0) p.push("LIBRARY_USERS is not set (invited users as email=scrypt-hash; create hashes with npm run library:hash-password).");
  if ((env.APP_SECRET?.trim().length ?? 0) < 32) p.push("APP_SECRET must be a random string of at least 32 characters.");
  return p;
}

// ---------- stateless sessions ----------

/** @param {string} secret @param {string} body */
const mac = (secret, body) => createHmac("sha256", secret).update(`doctyn-library-session:${body}`).digest("base64url");

/** @param {string} email @param {string} secret @param {number} days @param {number} [now] */
export function signSession(email, secret, days, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ e: email, x: Math.floor(now / 1000) + Math.round(days * 86400), n: randomBytes(6).toString("hex") })).toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

/** @param {string | null} token @param {string} secret @param {number} [now] @returns {string | null} the e-mail, or null */
export function verifySession(token, secret, now = Date.now()) {
  if (!token) return null;
  const [body = "", sig = ""] = token.split(".");
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof claims.e === "string" && claims.x > now / 1000 ? claims.e : null;
  } catch {
    return null;
  }
}

// ---------- the default blob reader (server side, token never leaves) ----------

/** @param {string} token @returns {BlobReader} */
export function vercelBlobReader(token) {
  return async (pathname, { range }) => {
    const { get } = await import("@vercel/blob");
    try {
      const r = await get(pathname, { access: "private", token, ...(range ? { headers: { Range: range } } : {}) });
      return r && r.statusCode === 200 ? { headers: r.headers, stream: r.stream } : null;
    } catch (err) {
      const status = /: (\d{3}) /.exec(String(/** @type {Error} */ (err).message))?.[1];
      if (status === "416") throw new HttpError(416, "That byte range is outside the video.");
      throw err;
    }
  };
}

// ---------- catalog -> the shape the dashboard expects ----------

/** @param {import("./library-catalog.js").LibraryVideo} v @param {boolean} detail */
function toLibraryCourse(v, detail) {
  const f = v.files;
  const animated = f.animated;
  const main = animated ?? f.video;
  const course = {
    id: v.id,
    title: v.title,
    status: "complete",
    error: null,
    slideCount: v.slideCount,
    ownerId: null,
    files: { pptx: null, docx: null },
    durationSeconds: v.durationSeconds,
    hasVideo: Boolean(main),
    available: {
      video: Boolean(f.video), thumbnail: Boolean(f.thumbnail), vtt: Boolean(f.vtt), srt: Boolean(f.srt), transcript: Boolean(f.transcript), animated: Boolean(animated),
    },
    videoBytes: main?.bytes ?? null,
    stale: false,
    review: { status: "none", notes: null, at: null, matchesCurrentContent: false },
    publishedAt: null,
    createdAt: v.completedAt,
    updatedAt: v.completedAt,
    completedAt: v.completedAt,
    animation: animated ? { planned: true, rendered: true, draft: animated.draft !== false, slideCount: v.slideCount } : null,
    animatedDraft: animated ? animated.draft !== false : null,
    slidePreviews: false,
    libraryOnly: true,
  };
  return detail ? { ...course, slides: [], validation: null, animationPlan: null, animationEdits: {}, previews: {} } : course;
}

/** @param {string} email */
const publicUser = (email) => ({ id: email, email, name: email.split("@")[0], role: "user", status: "active" });

/** Best-effort throttle per warm instance; scrypt's cost is the real brake. */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 8;

/** @param {LibraryContext} ctx */
export function createLibraryHandler(ctx) {
  const videos = ctx.videos ?? LIBRARY_VIDEOS;
  const dummyHash = hashPassword("not-a-real-password-for-timing");
  /** @type {Map<string, number[]>} */
  const fails = new Map();

  /** @param {import("node:http").IncomingMessage} req */
  const ipOf = (req) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

  /** @param {import("node:http").IncomingMessage} req @returns {string | null} */
  function userEmail(req) {
    const email = verifySession(sessionTokenFromCookie(req.headers.cookie), ctx.config.secret);
    // Removing someone from LIBRARY_USERS ends their access immediately, even with a valid cookie.
    return email && ctx.config.users.has(email) ? email : null;
  }

  /** @param {import("node:http").IncomingMessage} req */
  const readJson = (req) => readJsonBody(req, 16 * 1024);

  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
  return async function handle(req, res) {
    try {
      normalizeRouteUrl(req);
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/^\/api\/v3/, "").replace(/\/+$/, "") || "/";
      const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
      checkCsrf(req, { allowedOrigins: [] });

      if (method === "GET" && path === "/health") return sendJson(res, 200, { ok: true, service: "doctyn-library", mode: "library", storage: "vercel-blob" });
      if (method === "GET" && path === "/meta") {
        return sendJson(res, 200, { libraryMode: true, localMode: false, registration: "closed", maxUploadBytes: 0, animationTemplates: [] });
      }

      if (method === "POST" && path === "/auth/login") {
        const body = /** @type {any} */ (await readJson(req));
        const email = String(body.email ?? "").trim().toLowerCase();
        const key = `${ipOf(req)}|${email}`;
        const now = Date.now();
        const recent = (fails.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
        if (recent.length >= MAX_FAILS) throw new HttpError(429, "Too many sign-in attempts. Wait 15 minutes and try again.");
        const stored = ctx.config.users.get(email);
        const ok = await verifyPassword(String(body.password ?? ""), stored ?? (await dummyHash));
        if (!stored || !ok) {
          recent.push(now);
          fails.set(key, recent);
          if (fails.size > 1000) fails.clear();
          throw new HttpError(401, "Email or password is incorrect.");
        }
        fails.delete(key);
        const token = signSession(email, ctx.config.secret, ctx.config.sessionDays);
        const expires = new Date(now + ctx.config.sessionDays * 86400_000);
        return sendJson(res, 200, { user: publicUser(email) }, [sessionCookie(token, expires, ctx.config.secureCookies)]);
      }
      if (method === "POST" && path === "/auth/logout") return sendJson(res, 200, { ok: true }, [clearCookie(ctx.config.secureCookies)]);
      if (method === "POST" && path === "/auth/register") throw new HttpError(403, "Accounts are by invitation. Ask the administrator for access.");
      if (method === "GET" && path === "/auth/me") {
        const email = userEmail(req);
        return sendJson(res, 200, { user: email ? publicUser(email) : null });
      }

      // everything below needs a signed-in, still-invited user
      const email = userEmail(req);
      if (!email) throw new HttpError(401, "Please sign in.");

      if (method === "GET" && path === "/courses") return sendJson(res, 200, { courses: videos.map((v) => toLibraryCourse(v, false)) });
      if (method === "GET" && path === "/engine") return sendJson(res, 200, { online: false, workers: 0, busy: 0, tts: null, queued: 0, running: 0 });
      if (method === "GET" && path === "/activity") return sendJson(res, 200, { activity: [] });

      const m = /^\/courses\/([^/]+)(?:\/files\/([a-z]+))?$/.exec(path);
      if (m) {
        const video = videos.find((v) => v.id === m[1]);
        if (!video) throw new HttpError(404, "Course not found.");
        if (method === "GET" && !m[2]) return sendJson(res, 200, { course: toLibraryCourse(video, true), jobs: [] });
        if (method === "GET" && m[2]) return await streamFile(req, res, url, video, m[2]);
      }
      if (method !== "GET") throw new HttpError(501, "Uploading, editing and rendering are not enabled on this site yet (video library mode). The Windows engine, a database and storage are needed for that.");
      throw new HttpError(404, `No API route ${req.method} ${path}`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error("[library]", err instanceof Error ? err.message : err);
      if (res.headersSent) return void res.destroy();
      sendJson(res, status, { error: status === 500 ? "The video could not be read from storage." : /** @type {Error} */ (err).message });
    }
  };

  /**
   * Stream one catalogued file from the private store. The client only ever sees this endpoint.
   * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @param {URL} url
   * @param {import("./library-catalog.js").LibraryVideo} video @param {string} name
   */
  async function streamFile(req, res, url, video, name) {
    const spec = /** @type {Record<string, { name: string, type: string }>} */ (OUTPUT_FILES)[name];
    const file = /** @type {Record<string, import("./library-catalog.js").LibraryFile | undefined>} */ (video.files)[name];
    if (!spec || !file) throw new HttpError(404, "That file is not available.");

    let range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    if (range && !/^bytes=\d*-\d*$/.test(range)) throw new HttpError(416, "Only a single byte range is supported.");
    const head = req.method === "HEAD";
    if (head) range = "bytes=0-0"; // enough to learn the total size without moving the file

    const blob = await ctx.readBlob(file.pathname, range ? { range } : {});
    if (!blob) throw new HttpError(404, "The file is not in the library store.");

    const contentRange = blob.headers.get("content-range");
    const partial = Boolean(range) && Boolean(contentRange);
    const total = contentRange ? Number(/\/(\d+)$/.exec(contentRange)?.[1]) : Number(blob.headers.get("content-length"));
    res.setHeader("Content-Type", spec.type);
    res.setHeader("Accept-Ranges", "bytes");
    // Private: the draft must never be cached by shared caches or CDNs.
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (file.draft) res.setHeader("X-Doctyn-Status", "draft");
    if (url.searchParams.has("download")) {
      const fname = `${video.title.replace(/[^\w.-]+/g, "-").slice(0, 60)}-${file.draft ? "DRAFT-" : ""}${spec.name}`;
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    }
    if (head) {
      res.setHeader("Content-Length", String(total));
      res.writeHead(200).end();
      await blob.stream.cancel().catch(() => {});
      return;
    }
    if (partial && contentRange) res.setHeader("Content-Range", contentRange);
    const length = blob.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);
    res.writeHead(partial ? 206 : 200);

    const source = Readable.fromWeb(/** @type {any} */ (blob.stream));
    // A viewer that seeks or closes the page must not keep the upstream read open.
    res.on("close", () => source.destroy());
    source.on("error", () => res.destroy());
    source.pipe(res);
  }
}
