// @ts-check
// One tiny query interface over node-postgres (production) and PGlite (an in-process
// real Postgres used for local development and automated tests only).
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} Queryable
 * @property {(text: string, params?: unknown[]) => Promise<{ rows: any[], rowCount: number }>} query
 * @property {(text: string) => Promise<unknown>} exec   multi-statement SQL without parameters
 */
/**
 * @typedef {Queryable & { tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>, close: () => Promise<void>, kind: "pg" | "pglite" }} Db
 */

export const MIGRATIONS = [
  `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','reviewer','admin')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  );
  CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    user_agent text
  );
  CREATE TABLE login_attempts (
    id bigserial PRIMARY KEY,
    key text NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX login_attempts_key_at ON login_attempts(key, at);
  CREATE TABLE courses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'created'
      CHECK (status IN ('created','uploaded','parsing','parsed','invalid','queued','rendering','complete','failed')),
    error text,
    pptx_key text, pptx_name text, pptx_bytes bigint,
    docx_key text, docx_name text, docx_bytes bigint,
    slide_count int,
    validation jsonb,
    slides jsonb NOT NULL DEFAULT '[]'::jsonb,
    content_hash text,
    built_hash text,
    review_status text NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','pending','approved','rejected')),
    review_hash text,
    review_by uuid REFERENCES users(id) ON DELETE SET NULL,
    review_notes text,
    reviewed_at timestamptz,
    published_at timestamptz,
    outputs jsonb NOT NULL DEFAULT '{}'::jsonb,
    duration_seconds numeric,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    deleted_at timestamptz
  );
  CREATE INDEX courses_owner ON courses(owner_id, created_at DESC);
  CREATE TABLE jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('parse','build')),
    status text NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    cancel_requested boolean NOT NULL DEFAULT false,
    attempt int NOT NULL DEFAULT 0,
    max_attempts int NOT NULL DEFAULT 3,
    run_after timestamptz NOT NULL DEFAULT now(),
    locked_by text,
    heartbeat_at timestamptz,
    progress jsonb NOT NULL DEFAULT '{}'::jsonb,
    log_tail text NOT NULL DEFAULT '',
    error text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
  );
  CREATE INDEX jobs_queue ON jobs(status, run_after, created_at);
  CREATE INDEX jobs_course ON jobs(course_id, created_at DESC);
  CREATE TABLE audit_log (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    user_id uuid,
    action text NOT NULL,
    target text,
    meta jsonb NOT NULL DEFAULT '{}'::jsonb
  );
  `,
  `
  ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('parse','build','animate'));
  ALTER TABLE courses ADD COLUMN animation jsonb;
  ALTER TABLE courses ADD COLUMN animation_edits jsonb NOT NULL DEFAULT '{}'::jsonb;
  `,
  `
  CREATE TABLE workers (
    id text PRIMARY KEY,
    hostname text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    last_seen timestamptz NOT NULL DEFAULT now(),
    current_job uuid,
    info jsonb NOT NULL DEFAULT '{}'::jsonb
  );
  `,
  `
  ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('parse','build','animate','preview','plan'));
  ALTER TABLE courses ADD COLUMN slide_previews boolean NOT NULL DEFAULT false;
  ALTER TABLE courses ADD COLUMN previews jsonb NOT NULL DEFAULT '{}'::jsonb;
  `,
  `
  ALTER TABLE courses ADD COLUMN import_key text;
  CREATE UNIQUE INDEX courses_import_key ON courses(owner_id, import_key) WHERE import_key IS NOT NULL;
  `,
];

/** @param {Queryable} q */
async function migrate(q) {
  await q.query("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await q.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (done.has(i + 1)) continue;
    await q.exec(/** @type {string} */ (MIGRATIONS[i]));
    await q.query("INSERT INTO schema_migrations(version) VALUES ($1)", [i + 1]);
  }
}

/** @param {import("./config.js").CloudConfig} config @returns {Promise<Db>} */
export async function createDb(config) {
  /** @type {Db} */
  let db;
  if (config.databaseUrl) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.production ? 3 : 10,
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? undefined : { rejectUnauthorized: false },
    });
    /** @param {{ query: (t: string, p?: any[]) => Promise<any> }} c @returns {Queryable} */
    const wrap = (c) => ({ query: (t, p) => c.query(t, p).then((r) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 })), exec: (t) => c.query(t) });
    db = {
      kind: "pg",
      ...wrap(pool),
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const out = await fn(wrap(c));
          await c.query("COMMIT");
          return out;
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
    await db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(727274)");
      await migrate(q);
    });
  } else {
    if (config.production) throw new Error("DATABASE_URL is required in production. PGlite is for local development only.");
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = config.localDbDir;
    if (dir !== "memory://") fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
    const lite = dir === "memory://" ? new PGlite() : new PGlite(path.resolve(dir));
    await lite.waitReady;
    /** @param {{ query: (t: string, p?: any[]) => Promise<any>, exec: (t: string) => Promise<any> }} c @returns {Queryable} */
    const wrap = (c) => ({ query: (t, p) => c.query(t, p ?? []).then((r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length })), exec: (t) => c.exec(t) });
    db = {
      kind: "pglite",
      ...wrap(lite),
      tx: (fn) => lite.transaction((t) => fn(wrap(t))),
      close: () => lite.close(),
    };
    await migrate(db);
  }
  return db;
}
