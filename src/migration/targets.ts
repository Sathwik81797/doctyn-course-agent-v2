/**
 * Read-only inspection of the services a real migration (or the Windows engine) will write to: Neon Postgres and the private
 * Vercel Blob store. Nothing here creates a table, a schema or a file. In particular it does NOT use createDb(), which would
 * apply the schema migrations to an empty database the moment it connects.
 */
import { MIGRATIONS } from "../../cloud/db.js";
import type { CloudConfig } from "../../cloud/config.js";
import { LIBRARY_VIDEOS } from "../../cloud/library-catalog.js";
import { createStorage } from "../../cloud/storage.js";
import { LIBRARY_KEY_PREFIX } from "../../cloud/storage-blob.js";
import type { Finding } from "./library-migration.js";

export type DbState = "not-configured" | "unreachable" | "empty" | "needs-upgrade" | "ready";

export interface TargetReport {
  findings: Finding[];
  db: DbState;
  /** users already in the database (emails only), when the schema exists */
  existingUsers: string[];
  blob: "not-used" | "ok" | "failed";
}

export async function inspectTargets(config: CloudConfig): Promise<TargetReport> {
  const findings: Finding[] = [];
  const add = (level: Finding["level"], text: string): void => void findings.push({ level, text });
  const report: TargetReport = { findings, db: "not-configured", existingUsers: [], blob: "not-used" };

  // ---- Neon / Postgres (SELECTs only)
  if (!config.databaseUrl) {
    add("error", "DATABASE_URL is not set in this shell or .env (your Neon connection string).");
  } else {
    const { default: pg } = await import("pg");
    const url = new URL(config.databaseUrl);
    url.searchParams.delete("sslmode");
    const client = new pg.Client({
      connectionString: url.toString(),
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? undefined : config.dbSslVerify ? true : { rejectUnauthorized: false },
      ...(config.dbSchema ? { options: `-c search_path=${config.dbSchema}` } : {}),
    });
    try {
      await client.connect();
      const host = url.hostname.replace(/^[^.]+/, "<id>");
      const has = (await client.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS yes")).rows[0].yes as boolean;
      if (!has) {
        report.db = "empty";
        add("info", `Neon (${host}, database ${url.pathname.slice(1)}) is reachable and has no tables yet. The real run creates them; this check did not.`);
      } else {
        const applied = (await client.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n as number;
        if (applied < MIGRATIONS.length) {
          report.db = "needs-upgrade";
          add("warn", `Neon has ${applied} of ${MIGRATIONS.length} schema upgrades applied; the real run applies the rest.`);
        } else {
          report.db = "ready";
          report.existingUsers = (await client.query("SELECT email FROM users ORDER BY email")).rows.map((r) => r.email as string);
          add("info", `Neon (${host}) is reachable with the current schema and ${report.existingUsers.length} account(s).`);
        }
      }
    } catch (err) {
      report.db = "unreachable";
      add("error", `Neon could not be reached: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  // ---- Vercel Blob (a HEAD of the library video; no write, no download)
  if (config.storageDriver === "blob") {
    if (!config.blob.token) {
      report.blob = "failed";
      add("error", "BLOB_READ_WRITE_TOKEN is not set (it is in .env.local after `vercel env pull .env.local`).");
    } else {
      try {
        const storage = await createStorage(config);
        const lib = LIBRARY_VIDEOS[0]?.files.animated;
        const head = lib ? await storage.head(`${LIBRARY_KEY_PREFIX}${lib.pathname}`) : null;
        if (lib && head && head.size === lib.bytes) {
          report.blob = "ok";
          add("info", `Private Blob store: the library's enhanced draft is there (${head.size} bytes) and will be referenced, not copied.`);
        } else {
          report.blob = "failed";
          add("error", lib ? `The library video was not found in Blob with the expected size (${lib.bytes} bytes).` : "No library video is registered.");
        }
      } catch (err) {
        report.blob = "failed";
        add("error", `The Blob store could not be read: ${(err as Error).message.split("\n")[0]}`);
      }
    }
  } else {
    add("warn", `STORAGE_DRIVER is "${config.storageDriver}", not "blob": the video would be uploaded to that storage instead of being referenced in Blob.`);
  }
  return report;
}

/**
 * Proves that the password in $LIBRARY_PASSWORD is the one the LIVE library site accepts today (one sign-in attempt over HTTPS to
 * your own site, the same request its login page makes). Combined with the local hash check, it shows the hash in your users
 * file corresponds to the password people use now. Neither the password nor any cookie is printed or stored.
 */
export async function checkLiveLogin(siteUrl: string, email: string, password: string): Promise<Finding> {
  try {
    const origin = new URL(siteUrl).origin;
    const res = await fetch(`${origin}/api/v3/route?p=auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "doctyn", origin },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 200) return { level: "info", text: `${email} signs in on the live site (${origin}) with that password.` };
    if (res.status === 429) return { level: "warn", text: "The live site is throttling sign-ins for this address; wait a few minutes and try again." };
    return { level: "error", text: `The live site (${origin}) did not accept that password for ${email} (HTTP ${res.status}).` };
  } catch (err) {
    return { level: "error", text: `The live site could not be reached: ${(err as Error).message.split("\n")[0]}` };
  }
}
