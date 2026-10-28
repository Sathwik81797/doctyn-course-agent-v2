// @ts-check
// Environment-driven configuration for the cloud API and the render worker.
// Nothing here has a default that would silently create or use paid infrastructure.

/**
 * @typedef {Object} CloudConfig
 * @property {boolean} production
 * @property {string | null} databaseUrl
 * @property {string | null} dbSchema  optional Postgres schema to keep all tables in (needs a direct, non-pooled connection)
 * @property {boolean} dbSslVerify  verify the database server's TLS certificate (default; DATABASE_SSL=no-verify turns it off)
 * @property {string} localDbDir
 * @property {"s3" | "fs" | "blob"} storageDriver
 * @property {{ endpoint: string | null, region: string, bucket: string | null, accessKeyId: string | null, secretAccessKey: string | null, forcePathStyle: boolean }} s3
 * @property {{ token: string | null, prefix: string }} blob  Vercel Blob (private store): the read-write token and the folder all V2 files live under
 * @property {string} fsRoot
 * @property {string | null} secret
 * @property {"open" | "approval"} registrationMode
 * @property {string[]} adminEmails
 * @property {number} maxUploadBytes
 * @property {number} sessionDays
 * @property {number} signedUrlSeconds
 * @property {number} jobMaxAttempts
 * @property {number} staleJobSeconds
 * @property {string[]} allowedOrigins
 * @property {boolean} allowSelfReview
 * @property {boolean} devAutoLogin  development server only: sign in the single local user automatically
 */

/** @param {Record<string, string | undefined>} [env] @returns {CloudConfig} */
export function cloudConfig(env = process.env) {
  // Values pasted into a dashboard or piped from a shell often carry quotes or a trailing newline; accept them.
  const clean = (/** @type {string | undefined} */ v) => (v ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
  const production = Boolean(env.VERCEL) || env.NODE_ENV === "production";
  const num = (/** @type {string} */ name, /** @type {number} */ dflt) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const list = (/** @type {string | undefined} */ v) =>
    (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    production,
    databaseUrl: clean(env.DATABASE_URL) || null,
    dbSchema: env.DB_SCHEMA?.trim() || null,
    dbSslVerify: env.DATABASE_SSL?.trim() !== "no-verify",
    localDbDir: env.LOCAL_DB_DIR?.trim() || ".data/pglite",
    storageDriver: clean(env.STORAGE_DRIVER).toLowerCase() === "fs" ? "fs" : clean(env.STORAGE_DRIVER).toLowerCase() === "blob" ? "blob" : "s3",
    s3: {
      endpoint: env.S3_ENDPOINT?.trim() || null,
      region: env.S3_REGION?.trim() || "auto",
      bucket: env.S3_BUCKET?.trim() || null,
      accessKeyId: env.S3_ACCESS_KEY_ID?.trim() || null,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY?.trim() || null,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    },
    blob: { token: env.BLOB_READ_WRITE_TOKEN?.trim() || null, prefix: (env.BLOB_PREFIX?.trim() || "v2").replace(/^\/+|\/+$/g, "") },
    fsRoot: env.LOCAL_STORAGE_DIR?.trim() || ".data/storage",
    secret: clean(env.APP_SECRET) || null,
    registrationMode: env.REGISTRATION_MODE === "open" ? "open" : "approval",
    adminEmails: list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
    maxUploadBytes: num("MAX_UPLOAD_MB", 200) * 1024 * 1024,
    sessionDays: num("SESSION_DAYS", 14),
    signedUrlSeconds: num("SIGNED_URL_SECONDS", 900),
    jobMaxAttempts: num("JOB_MAX_ATTEMPTS", 3),
    staleJobSeconds: num("STALE_JOB_SECONDS", 120),
    allowedOrigins: list(env.APP_ORIGINS),
    allowSelfReview: env.ALLOW_SELF_REVIEW === "true",
    devAutoLogin: !production && env.DEV_AUTO_LOGIN === "true",
  };
}

/** Problems that make a deployment unsafe or unusable. Empty = fine. @param {CloudConfig} c */
export function configProblems(c) {
  /** @type {string[]} */
  const p = [];
  if (c.production && !c.databaseUrl) p.push("DATABASE_URL is not set (a Postgres connection string is required in production).");
  if (!c.secret || c.secret.length < 32) p.push("APP_SECRET must be set to a random string of at least 32 characters.");
  if (c.production && c.storageDriver === "fs") p.push("STORAGE_DRIVER=fs is for local development only. Configure S3_* object storage.");
  if (c.dbSchema && !/^[a-z_][a-z0-9_]{0,40}$/.test(c.dbSchema)) p.push("DB_SCHEMA must be a lower-case Postgres schema name such as doctyn.");
  if (c.dbSchema && c.databaseUrl && /-pooler\./.test(c.databaseUrl)) p.push("DB_SCHEMA needs the direct (non-pooled) connection string; the pooled one forgets session settings.");
  if (c.storageDriver === "blob") {
    if (!c.blob.token) p.push("BLOB_READ_WRITE_TOKEN is not set (the read-write token of your private Vercel Blob store).");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}){0,3}$/.test(c.blob.prefix) || ["courses", "library"].includes(c.blob.prefix.split("/")[0] ?? "")) {
      p.push("BLOB_PREFIX must be a plain folder name such as v2 (not 'courses', which holds the existing private video library).");
    }
  }
  if (c.storageDriver === "s3") {
    for (const [k, v] of Object.entries({ S3_BUCKET: c.s3.bucket, S3_ACCESS_KEY_ID: c.s3.accessKeyId, S3_SECRET_ACCESS_KEY: c.s3.secretAccessKey })) {
      if (!v) p.push(`${k} is not set${k === "S3_BUCKET" ? " (or set STORAGE_DRIVER=blob to store files in your private Vercel Blob store instead)" : ""}.`);
    }
  }
  return p;
}
