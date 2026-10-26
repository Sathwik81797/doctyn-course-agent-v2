// @ts-check
// Registration, login and server-side sessions. Passwords use scrypt; session tokens are random
// 256-bit values stored only as SHA-256 hashes, so a database leak does not leak live sessions.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = /** @type {(pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>} */ (promisify(scryptCb));
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const COOKIE = "doctyn_session";

export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {string} password */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** @param {string} password @param {string} stored */
export async function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, SCRYPT);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Verified against when the email is unknown, so response time does not reveal which emails exist. */
const DUMMY_HASH = hashPassword("not-a-real-password-for-timing");

/** @param {string} token */
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/** @param {unknown} v */
export function cleanEmail(v) {
  const email = String(v ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  return email;
}

/** @param {unknown} v */
export function cleanPassword(v) {
  const pw = String(v ?? "");
  if (pw.length < 10) throw new HttpError(400, "Use a password of at least 10 characters.");
  if (pw.length > 200) throw new HttpError(400, "That password is too long (200 characters maximum).");
  return pw;
}

/**
 * @typedef {{ id: string, email: string, name: string, role: "user" | "reviewer" | "admin", status: "pending" | "active" | "disabled" }} User
 */

/** @param {any} row @returns {User} */
export function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status };
}

/**
 * @param {import("./db.js").Queryable} db
 * @param {import("./config.js").CloudConfig} config
 * @param {{ email: unknown, name: unknown, password: unknown }} input
 */
export async function register(db, config, input) {
  const email = cleanEmail(input.email);
  const name = String(input.name ?? "").trim().slice(0, 100);
  if (!name) throw new HttpError(400, "Enter your name.");
  const password = cleanPassword(input.password);
  const isAdmin = config.adminEmails.includes(email);
  const role = isAdmin ? "admin" : "user";
  const status = isAdmin || config.registrationMode === "open" ? "active" : "pending";
  const hash = await hashPassword(password);
  const res = await db.query(
    "INSERT INTO users(email, name, password_hash, role, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING RETURNING id, email, name, role, status",
    [email, name, hash, role, status],
  );
  if (!res.rows[0]) throw new HttpError(409, "An account with that email already exists. Sign in instead.");
  await audit(db, res.rows[0].id, "user.register", res.rows[0].id, { status });
  return publicUser(res.rows[0]);
}

const WINDOW_MINUTES = 15;
const MAX_ATTEMPTS = 8;

/**
 * @param {import("./db.js").Queryable} db
 * @param {import("./config.js").CloudConfig} config
 * @param {{ email: unknown, password: unknown, ip: string, userAgent?: string }} input
 */
export async function login(db, config, input) {
  const email = String(input.email ?? "").trim().toLowerCase();
  const keys = [`email:${email}`, `ip:${input.ip}`];
  const recent = await db.query(
    "SELECT count(*)::int AS n FROM login_attempts WHERE key = ANY($1) AND at > now() - ($2 || ' minutes')::interval",
    [keys, String(WINDOW_MINUTES)],
  );
  if (recent.rows[0].n >= MAX_ATTEMPTS * 2) throw new HttpError(429, "Too many sign-in attempts. Wait 15 minutes and try again.");

  const found = await db.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = found.rows[0];
  const ok = await verifyPassword(String(input.password ?? ""), user ? user.password_hash : await DUMMY_HASH);
  if (!user || !ok) {
    await db.query("INSERT INTO login_attempts(key) SELECT unnest($1::text[])", [keys]);
    throw new HttpError(401, "Email or password is incorrect.");
  }
  if (user.status === "pending") throw new HttpError(403, "Your account is waiting for administrator approval.");
  if (user.status === "disabled") throw new HttpError(403, "This account has been disabled. Contact an administrator.");

  const { token, expires } = await createSession(db, config, user.id, input.userAgent ?? "");
  await db.query("DELETE FROM sessions WHERE expires_at < now()");
  await db.query("DELETE FROM login_attempts WHERE at < now() - interval '1 day'");
  await audit(db, user.id, "user.login", user.id, {});
  return { user: publicUser(user), token, expires };
}

/**
 * @param {import("./db.js").Queryable} db
 * @param {import("./config.js").CloudConfig} config
 * @param {string} userId @param {string} [userAgent]
 */
export async function createSession(db, config, userId, userAgent = "") {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  await db.query("INSERT INTO sessions(user_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4)", [
    userId,
    hashToken(token),
    expires.toISOString(),
    userAgent.slice(0, 300),
  ]);
  await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
  return { token, expires };
}

/**
 * Development convenience only (never used in production): the single local user of `npm run cloud:dev`.
 * @param {import("./db.js").Queryable} db
 */
export async function ensureLocalUser(db) {
  const email = "local@doctyn.local";
  const found = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  if (found.rows[0]) return /** @type {string} */ (found.rows[0].id);
  const res = await db.query(
    "INSERT INTO users(email, name, password_hash, role, status) VALUES ($1,'Local user',$2,'admin','active') RETURNING id",
    [email, await hashPassword(randomBytes(24).toString("hex"))],
  );
  return /** @type {string} */ (res.rows[0].id);
}

/** @param {import("./db.js").Queryable} db @param {string} token */
export async function logout(db, token) {
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

/** @param {string | undefined} header @returns {string | null} */
export function sessionTokenFromCookie(header) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** @param {import("./db.js").Queryable} db @param {string | null} token @returns {Promise<User | null>} */
export async function userForToken(db, token) {
  if (!token) return null;
  const res = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.status FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const u = res.rows[0];
  return u && u.status === "active" ? publicUser(u) : null;
}

/** @param {string} token @param {Date} expires @param {boolean} secure */
export function sessionCookie(token, expires, secure) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? "; Secure" : ""}`;
}

/** @param {boolean} secure */
export function clearCookie(secure) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/**
 * @param {import("./db.js").Queryable} db
 * @param {string | null} userId
 * @param {string} action
 * @param {string | null} target
 * @param {object} meta
 */
export async function audit(db, userId, action, target, meta) {
  await db.query("INSERT INTO audit_log(user_id, action, target, meta) VALUES ($1,$2,$3,$4::jsonb)", [userId, action, target, JSON.stringify(meta)]);
}

/**
 * JSON request body, in any Node server. Plain Node leaves the body in the request stream; the Vercel Node runtime
 * has ALREADY consumed the stream and put the parsed body in req.body (verified with vercel dev: readableEnded=true,
 * 0 bytes streamed). Reading only the stream there yields an empty body, so every sign-in would fail.
 * @param {import("node:http").IncomingMessage} req @param {number} max
 * @returns {Promise<Record<string, any>>}
 */
export async function readJsonBody(req, max) {
  const pre = /** @type {any} */ (req).body;
  if (pre !== undefined && pre !== null && (req.readableEnded || req.readable === false)) {
    if (Buffer.isBuffer(pre) || typeof pre === "string") {
      const text = Buffer.isBuffer(pre) ? pre.toString("utf8") : pre;
      if (text.length > max) throw new HttpError(413, "Request body is too large.");
      if (!text.trim()) return {};
      try {
        const v = JSON.parse(text);
        return v && typeof v === "object" ? v : {};
      } catch {
        throw new HttpError(400, "Request body must be JSON.");
      }
    }
    if (typeof pre === "object") {
      if (JSON.stringify(pre).length > max) throw new HttpError(413, "Request body is too large.");
      return pre;
    }
    throw new HttpError(400, "Request body must be JSON.");
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, "Request body is too large.");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}
