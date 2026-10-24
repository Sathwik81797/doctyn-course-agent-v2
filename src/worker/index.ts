/**
 * npm run engine   (alias: npm run worker)
 *
 * The Windows render engine. It makes OUTBOUND connections only: to the Postgres database and the
 * private storage bucket the website also uses. Nothing listens on this PC, so no port is opened and
 * no tunnel is needed. While this process runs, jobs from the website are picked up and rendered with
 * LibreOffice, the configured AI voice (Kokoro / OpenAI / Windows) and FFmpeg, plus the animation engine.
 * When it is not running, jobs wait in the queue and the website says the engine is offline.
 */
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { ConfigError, getContext } from "../../cloud/context.js";
import { loadConfig, PROJECT_ROOT } from "../utils/config.js";
import { formatError } from "../utils/errors.js";
import { requireTool } from "../utils/tools.js";
import { runWorker } from "./loop.js";

const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => ac.abort());

/** Fail early, in plain words, if this PC cannot render. */
function preflight(): { tts: string } {
  const config = loadConfig();
  const problems: string[] = [];
  for (const tool of ["ffmpeg", "ffprobe", "libreoffice"] as const) {
    try {
      requireTool(tool, config);
    } catch (err) {
      problems.push(formatError(err));
    }
  }
  const provider = config.tts.provider;
  if (provider === "openai" && !process.env.OPENAI_API_KEY?.trim()) {
    problems.push("TTS_PROVIDER=openai but OPENAI_API_KEY is not set in .env.");
  }
  if (problems.length) {
    console.error("This PC is not ready to render:\n");
    console.error(problems.join("\n\n"));
    process.exit(1);
  }
  return { tts: provider };
}

try {
  const { tts } = preflight();
  const ctx = await getContext();
  // Keep working files out of OneDrive: syncing gigabytes of temporary video slows the PC.
  const defaultWork = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Doctyn", "work") : path.join(PROJECT_ROOT, ".data", "work");
  const workRoot = path.resolve(process.env.WORK_DIR?.trim() || defaultWork);
  process.env.TEMP_DIR ??= path.join(workRoot, "temp");
  console.log(`Doctyn render engine on ${os.hostname()}`);
  console.log(`  voice engine : ${tts}`);
  console.log(`  database     : ${ctx.db.kind}   storage: ${ctx.storage.driver}`);
  console.log(`  work folder  : ${workRoot}`);
  console.log("  Press Ctrl+C to stop. The website shows the engine as offline while this is not running.\n");
  await runWorker(ctx, { workRoot, signal: ac.signal, info: { tts, platform: process.platform } });
  await ctx.db.close();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    console.error("\nSet these in .env (see .env.example, section 'Cloud platform') and start the engine again.");
  } else {
    console.error(formatError(err));
  }
  process.exit(1);
}
