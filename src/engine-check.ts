/**
 * npm run engine:check
 *
 * Read-only readiness check for the Windows rendering engine against the real services. It never starts the engine and never
 * writes: no table is created in Neon, nothing is uploaded to Blob, no job is claimed. It reports PASS / FAIL per item and prints
 * only the NAMES of settings, never their values.
 */
import { cloudConfig, configProblems } from "../cloud/config.js";
import { inspectTargets } from "./migration/targets.js";
import { loadConfig } from "./utils/config.js";
import { formatError } from "./utils/errors.js";
import { requireTool } from "./utils/tools.js";

const rows: Array<[boolean, string, string]> = [];
const row = (pass: boolean, what: string, detail = ""): void => void rows.push([pass, what, detail]);

try {
  const cloud = cloudConfig();
  const problems = configProblems(cloud);
  row(cloud.storageDriver === "blob", "STORAGE_DRIVER=blob", cloud.storageDriver === "blob" ? "" : `is "${cloud.storageDriver}"; add STORAGE_DRIVER=blob to .env`);
  row(Boolean(cloud.databaseUrl), "DATABASE_URL is set (Neon)", cloud.databaseUrl ? "" : "set it in the Windows environment or .env");
  row(Boolean(cloud.blob.token), "BLOB_READ_WRITE_TOKEN is set", cloud.blob.token ? "" : "run: vercel env pull .env.local (development scope is enough)");
  row(Boolean(cloud.secret && cloud.secret.length >= 32), "APP_SECRET is set (32+ characters)", "any random value on this PC; it does not have to match Vercel's");
  for (const p of problems) if (!/APP_SECRET|BLOB_READ_WRITE_TOKEN|DATABASE_URL/.test(p)) row(false, p);

  const app = loadConfig();
  for (const tool of ["ffmpeg", "ffprobe", "libreoffice"] as const) {
    try {
      requireTool(tool, app);
      row(true, `${tool} found`);
    } catch (err) {
      row(false, `${tool} found`, formatError(err).split("\n")[0]);
    }
  }
  row(app.tts.provider === "kokoro" || app.tts.provider === "windows" || Boolean(app.openaiApiKey), `voice engine: ${app.tts.provider}`, app.tts.provider === "openai" && !app.openaiApiKey ? "OPENAI_API_KEY is missing" : "");

  const t = await inspectTargets(cloud);
  for (const f of t.findings) row(f.level !== "error", f.text.replace(/\s+/g, " "));
} catch (err) {
  row(false, "readiness check", formatError(err).split("\n")[0] ?? "");
}

for (const [pass, what, detail] of rows) console.log(`  ${pass ? "PASS" : "FAIL"}  ${what}${detail && !pass ? `  — ${detail}` : ""}`);
const failed = rows.filter((r) => !r[0]).length;
console.log(failed ? `\nENGINE NOT READY: ${failed} item(s) to fix.` : "\nENGINE READY. Start it with: bash scripts/start-engine.sh");
process.exit(failed ? 1 : 0);
