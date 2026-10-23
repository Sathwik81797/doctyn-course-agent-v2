// @ts-check
// Environment-driven configuration for the cloud API and the render worker.
// Nothing here has a default that would silently create or use paid infrastructure.

/**
 * @typedef {Object} CloudConfig
 * @property {boolean} production
 * @property {string | null} databaseUrl
 * @property {string} localDbDir
 * @property {"s3" | "fs"} storageDriver
 * @property {{ endpoint: string | null, region: string, bucket: string | null, accessKeyId: string | null, secretAccessKey: string | null, forcePathStyle: boolean }} s3
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
 */

/** @param {Record<string, string | undefined>} [env] @returns {CloudConfig} */
export function cloudConfig(env = process.env) {
  const production = Boolean(env.VERCEL) || env.NODE_ENV === "production";
  const num = (/** @type {string} */ name, /** @type {number} */ dflt) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const list = (/** @type {string | undefined} */ v) =>
    (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    production,
    databaseUrl: env.DATABASE_URL?.trim() || null,
    localDbDir: env.LOCAL_DB_DIR?.trim() || ".data/pglite",
    storageDriver: env.STORAGE_DRIVER?.trim() === "fs" ? "fs" : "s3",
    s3: {
      endpoint: env.S3_ENDPOINT?.trim() || null,
      region: env.S3_REGION?.trim() || "auto",
      bucket: env.S3_BUCKET?.trim() || null,
      accessKeyId: env.S3_ACCESS_KEY_ID?.trim() || null,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY?.trim() || null,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    },
    fsRoot: env.LOCAL_STORAGE_DIR?.trim() || ".data/storage",
    secret: env.APP_SECRET?.trim() || null,
    registrationMode: env.REGISTRATION_MODE === "open" ? "open" : "approval",
    adminEmails: list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
    maxUploadBytes: num("MAX_UPLOAD_MB", 200) * 1024 * 1024,
    sessionDays: num("SESSION_DAYS", 14),
    signedUrlSeconds: num("SIGNED_URL_SECONDS", 900),
    jobMaxAttempts: num("JOB_MAX_ATTEMPTS", 3),
    staleJobSeconds: num("STALE_JOB_SECONDS", 120),
    allowedOrigins: list(env.APP_ORIGINS),
  };
}

/** Problems that make a deployment unsafe or unusable. Empty = fine. @param {CloudConfig} c */
export function configProblems(c) {
  /** @type {string[]} */
  const p = [];
  if (c.production && !c.databaseUrl) p.push("DATABASE_URL is not set (a Postgres connection string is required in production).");
  if (!c.secret || c.secret.length < 32) p.push("APP_SECRET must be set to a random string of at least 32 characters.");
  if (c.production && c.storageDriver === "fs") p.push("STORAGE_DRIVER=fs is for local development only. Configure S3_* object storage.");
  if (c.storageDriver === "s3") {
    for (const [k, v] of Object.entries({ S3_BUCKET: c.s3.bucket, S3_ACCESS_KEY_ID: c.s3.accessKeyId, S3_SECRET_ACCESS_KEY: c.s3.secretAccessKey })) {
      if (!v) p.push(`${k} is not set.`);
    }
  }
  return p;
}
