/**
 * npm run worker
 *
 * The persistent render worker. Run it in a container (see Dockerfile.worker) or on any
 * machine with LibreOffice, FFmpeg and Node. It pulls jobs from the same Postgres database the
 * website uses, downloads the user's files from private object storage, runs the unchanged
 * build-course pipeline, and uploads the results back.
 */
import "dotenv/config";
import path from "node:path";
import { ConfigError, getContext } from "../../cloud/context.js";
import { PROJECT_ROOT } from "../utils/config.js";
import { runWorker } from "./loop.js";

const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => ac.abort());

try {
  const ctx = await getContext();
  const workRoot = path.resolve(process.env.WORK_DIR?.trim() || path.join(PROJECT_ROOT, ".data", "work"));
  await runWorker(ctx, { workRoot, signal: ac.signal });
  await ctx.db.close();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    console.error("\nSet these in .env (see .env.example) and start the worker again.");
  } else {
    console.error(err);
  }
  process.exit(1);
}
