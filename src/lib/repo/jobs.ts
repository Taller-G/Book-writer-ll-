import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { jobs, type Job } from "../db/schema";
import { newId, now } from "../util";

// The async job contract every stage runs through (the seam other slices
// extend): one row per attempt, with a versioned input snapshot (what the
// job consumed) and a versioned output (what it produced). Failed attempts
// keep their error; retries are NEW rows linked via retry_of, so history is
// never overwritten.

export function createJob(
  db: Db,
  input: {
    projectId: string;
    stage: number;
    type: string;
    retryOf?: string;
    attempt?: number;
  },
): Job {
  const id = newId();
  db.insert(jobs)
    .values({
      id,
      projectId: input.projectId,
      stage: input.stage,
      type: input.type,
      retryOf: input.retryOf,
      attempt: input.attempt ?? 1,
      createdAt: now(),
    })
    .run();
  return getJob(db, id)!;
}

export function getJob(db: Db, id: string): Job | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function listJobs(db: Db, projectId: string): Job[] {
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.projectId, projectId))
    .orderBy(desc(jobs.createdAt))
    .all();
}

export function latestJobForStage(
  db: Db,
  projectId: string,
  stage: number,
): Job | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.stage, stage)))
    .orderBy(desc(jobs.createdAt))
    .limit(1)
    .get();
}

export function markJobRunning(
  db: Db,
  id: string,
  inputSnapshot: unknown,
  inputVersion: number,
): void {
  db.update(jobs)
    .set({
      status: "running",
      input: JSON.stringify(inputSnapshot),
      inputVersion,
      startedAt: now(),
    })
    .where(eq(jobs.id, id))
    .run();
}

/**
 * Called INSIDE the executor's commit transaction, together with the writes
 * that produce the output — success and output land atomically or not at all.
 */
export function markJobSucceeded(
  db: Db,
  id: string,
  output: unknown,
  outputVersion: number,
): void {
  db.update(jobs)
    .set({
      status: "succeeded",
      output: JSON.stringify(output),
      outputVersion,
      error: null,
      finishedAt: now(),
    })
    .where(eq(jobs.id, id))
    .run();
}

export function markJobFailed(db: Db, id: string, error: string): void {
  db.update(jobs)
    .set({ status: "failed", error, finishedAt: now() })
    .where(eq(jobs.id, id))
    .run();
}
