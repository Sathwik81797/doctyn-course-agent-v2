// @ts-check
// Durable job queue on Postgres. Workers claim jobs with FOR UPDATE SKIP LOCKED, keep them alive
// with heartbeats, and a reaper requeues jobs whose worker died. No separate queue service needed.
import { HttpError } from "./auth.js";

export const ACTIVE = ["queued", "running"];

/**
 * @param {import("./db.js").Db} db
 * @param {{ courseId: string, ownerId: string, kind: "parse" | "build" | "animate", maxAttempts: number, payload?: object }} j
 */
export async function enqueue(db, j) {
  return db.tx(async (q) => {
    await q.query("SELECT id FROM courses WHERE id = $1 FOR UPDATE", [j.courseId]);
    const active = await q.query("SELECT id, kind FROM jobs WHERE course_id = $1 AND status = ANY($2)", [j.courseId, ACTIVE]);
    if (active.rows[0]) throw new HttpError(409, `A ${active.rows[0].kind} job is already ${"in progress"} for this course.`);
    const res = await q.query(
      "INSERT INTO jobs(course_id, owner_id, kind, max_attempts, payload) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *",
      [j.courseId, j.ownerId, j.kind, j.maxAttempts, JSON.stringify(j.payload ?? {})],
    );
    return res.rows[0];
  });
}

/** Claim the oldest runnable job for this worker, or null. @param {import("./db.js").Db} db @param {string} workerId */
export async function claim(db, workerId) {
  const res = await db.query(
    `UPDATE jobs SET status = 'running', locked_by = $1, heartbeat_at = now(), attempt = attempt + 1,
            started_at = COALESCE(started_at, now()), finished_at = NULL, error = NULL
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now()
                  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [workerId],
  );
  return res.rows[0] ?? null;
}

/**
 * Worker liveness + progress. `cancel` tells the worker to stop; `lost` means the job was taken away.
 * @param {import("./db.js").Queryable} db
 * @param {string} jobId @param {string} workerId
 * @param {{ progress?: object, log?: string }} [update]
 */
export async function heartbeat(db, jobId, workerId, update = {}) {
  const res = await db.query(
    `UPDATE jobs SET heartbeat_at = now(),
            progress = COALESCE($3::jsonb, progress),
            log_tail = right(log_tail || $4, 16000)
      WHERE id = $1 AND locked_by = $2 AND status = 'running'
      RETURNING cancel_requested`,
    [jobId, workerId, update.progress ? JSON.stringify(update.progress) : null, update.log ?? ""],
  );
  const row = res.rows[0];
  return { lost: !row, cancel: Boolean(row?.cancel_requested) };
}

/** @param {import("./db.js").Queryable} db @param {string} jobId @param {string} workerId @param {object} [progress] */
export async function markSucceeded(db, jobId, workerId, progress) {
  await db.query(
    "UPDATE jobs SET status = 'succeeded', finished_at = now(), progress = COALESCE($3::jsonb, progress) WHERE id = $1 AND locked_by = $2 AND status = 'running'",
    [jobId, workerId, progress ? JSON.stringify(progress) : null],
  );
}

/** @param {import("./db.js").Queryable} db @param {string} jobId @param {string} workerId */
export async function markCancelled(db, jobId, workerId) {
  await db.query("UPDATE jobs SET status = 'cancelled', finished_at = now(), error = 'Cancelled.' WHERE id = $1 AND locked_by = $2", [jobId, workerId]);
}

/** Seconds to wait before automatic retry n (1-based). @param {number} attempt */
export const backoffSeconds = (attempt) => Math.min(600, 30 * attempt * attempt);

/**
 * Failure handling: retry automatically while attempts remain and the error is transient,
 * otherwise mark failed. Returns "requeued" or "failed".
 * @param {import("./db.js").Queryable} db
 * @param {{ id: string, attempt: number, max_attempts: number }} job
 * @param {string} workerId @param {string} error @param {boolean} retryable
 */
export async function markFailed(db, job, workerId, error, retryable) {
  if (retryable && job.attempt < job.max_attempts) {
    await db.query(
      `UPDATE jobs SET status = 'queued', locked_by = NULL, error = $3, run_after = now() + ($4 || ' seconds')::interval
        WHERE id = $1 AND locked_by = $2`,
      [job.id, workerId, error, String(backoffSeconds(job.attempt))],
    );
    return "requeued";
  }
  await db.query("UPDATE jobs SET status = 'failed', finished_at = now(), error = $3 WHERE id = $1 AND locked_by = $2", [job.id, workerId, error]);
  return "failed";
}

/**
 * @param {import("./db.js").Db} db @param {string} jobId @param {(job: any) => boolean} canTouch
 */
export async function requestCancel(db, jobId, canTouch) {
  return db.tx(async (q) => {
    const job = (await q.query("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [jobId])).rows[0];
    if (!job || !canTouch(job)) throw new HttpError(404, "Job not found.");
    if (job.status === "queued") {
      await q.query("UPDATE jobs SET status = 'cancelled', finished_at = now(), error = 'Cancelled before it started.' WHERE id = $1", [jobId]);
      await q.query("UPDATE courses SET status = $2, updated_at = now() WHERE id = $1", [job.course_id, job.kind === "parse" ? "uploaded" : job.kind === "animate" ? "complete" : "parsed"]);
      return "cancelled";
    }
    if (job.status === "running") {
      await q.query("UPDATE jobs SET cancel_requested = true WHERE id = $1", [jobId]);
      return "cancelling";
    }
    throw new HttpError(409, `That job already ${job.status}.`);
  });
}

/** Failed or cancelled job -> queued again, same row, attempts reset. Reuses the worker's cached progress. @param {import("./db.js").Db} db @param {string} jobId @param {(job: any) => boolean} canTouch */
export async function retryJob(db, jobId, canTouch) {
  return db.tx(async (q) => {
    const job = (await q.query("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [jobId])).rows[0];
    if (!job || !canTouch(job)) throw new HttpError(404, "Job not found.");
    if (job.status !== "failed" && job.status !== "cancelled") throw new HttpError(409, "Only failed or cancelled jobs can be retried.");
    const other = await q.query("SELECT 1 FROM jobs WHERE course_id = $1 AND status = ANY($2) AND id <> $3", [job.course_id, ACTIVE, jobId]);
    if (other.rows[0]) throw new HttpError(409, "Another job is already active for this course.");
    const res = await q.query(
      `UPDATE jobs SET status = 'queued', attempt = 0, cancel_requested = false, error = NULL, locked_by = NULL,
              run_after = now(), finished_at = NULL, log_tail = '' WHERE id = $1 RETURNING *`,
      [jobId],
    );
    await q.query("UPDATE courses SET status = $2, error = NULL, updated_at = now() WHERE id = $1", [job.course_id, job.kind === "parse" ? "parsing" : job.kind === "animate" ? "rendering" : "queued"]);
    return res.rows[0];
  });
}

/**
 * Requeue (or fail/cancel) running jobs whose worker stopped sending heartbeats.
 * @param {import("./db.js").Db} db @param {number} staleSeconds
 */
export async function reapStale(db, staleSeconds) {
  return db.tx(async (q) => {
    const stale = (
      await q.query(
        `SELECT * FROM jobs WHERE status = 'running' AND heartbeat_at < now() - ($1 || ' seconds')::interval FOR UPDATE SKIP LOCKED`,
        [String(staleSeconds)],
      )
    ).rows;
    for (const job of stale) {
      if (job.cancel_requested) {
        await q.query("UPDATE jobs SET status = 'cancelled', finished_at = now(), error = 'Cancelled.' WHERE id = $1", [job.id]);
        await q.query("UPDATE courses SET status = $2, updated_at = now() WHERE id = $1", [job.course_id, job.kind === "parse" ? "uploaded" : job.kind === "animate" ? "complete" : "parsed"]);
      } else if (job.attempt < job.max_attempts) {
        await q.query(
          "UPDATE jobs SET status = 'queued', locked_by = NULL, error = 'The worker stopped responding; the job was queued again.', run_after = now() WHERE id = $1",
          [job.id],
        );
      } else {
        await q.query("UPDATE jobs SET status = 'failed', finished_at = now(), error = 'The worker stopped responding and no attempts are left.' WHERE id = $1", [job.id]);
        await q.query("UPDATE courses SET status = 'failed', error = 'The worker stopped responding and no attempts are left.', updated_at = now() WHERE id = $1", [job.course_id]);
      }
    }
    return stale.length;
  });
}
