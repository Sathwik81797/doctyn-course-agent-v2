import os from "node:os";
import { claim, markCancelled, markFailed, markSucceeded, reapStale } from "../../cloud/queue.js";
import type { Ctx } from "../../cloud/routes.js";
import { runAnimate } from "./animate-job.js";
import { CancelledError, PermanentJobError, runBuild, runParse, sendHeartbeat, settleCourseAfterFailure, type JobEnv, type WorkerJob } from "./jobs.js";

export interface WorkerOptions {
  workRoot: string;
  workerId?: string;
  pollMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Claim one job and run it to completion. Returns false when the queue was empty. */
export async function processOne(ctx: Ctx, opts: Required<Pick<WorkerOptions, "workRoot" | "workerId">> & Pick<WorkerOptions, "log">): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const job = (await claim(ctx.db, opts.workerId)) as (WorkerJob & Record<string, unknown>) | null;
  if (!job) return false;
  log(`job ${job.id} (${job.kind}, attempt ${job.attempt}/${job.max_attempts}) started`);

  const env: JobEnv = {
    ctx,
    workerId: opts.workerId,
    workRoot: opts.workRoot,
    progress: (progress, text) => sendHeartbeat(env, job, progress, text),
  };
  try {
    if (job.kind === "parse") await runParse(job, env);
    else if (job.kind === "animate") await runAnimate(job, env);
    else await runBuild(job, env);
    await markSucceeded(ctx.db, job.id, opts.workerId);
    log(`job ${job.id} succeeded`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CancelledError) {
      await markCancelled(ctx.db, job.id, opts.workerId);
      await settleCourseAfterFailure(ctx, job, "cancelled", message);
      log(`job ${job.id} cancelled`);
    } else {
      const outcome = await markFailed(ctx.db, job, opts.workerId, message.slice(0, 2000), !(err instanceof PermanentJobError));
      await settleCourseAfterFailure(ctx, job, outcome, message);
      log(`job ${job.id} ${outcome}: ${message.split("\n")[0]}`);
    }
  }
  return true;
}

export async function runWorker(ctx: Ctx, opts: WorkerOptions): Promise<void> {
  const workerId = opts.workerId ?? `${os.hostname()}-${process.pid}`;
  const pollMs = opts.pollMs ?? 3000;
  const log = opts.log ?? ((m: string) => console.log(`[worker ${workerId}] ${m}`));
  let lastReap = 0;
  log("started; waiting for jobs");
  while (!opts.signal?.aborted) {
    try {
      if (Date.now() - lastReap > 30_000) {
        lastReap = Date.now();
        const n = await reapStale(ctx.db, ctx.config.staleJobSeconds);
        if (n) log(`requeued ${n} job(s) from a stopped worker`);
      }
      const worked = await processOne(ctx, { workRoot: opts.workRoot, workerId, log });
      if (!worked) await sleep(pollMs, opts.signal);
    } catch (err) {
      log(`loop error: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(pollMs * 2, opts.signal);
    }
  }
  log("stopped");
}
