import type { DbHandle } from "../db/client";
import type { Job } from "../db/schema";
import { createJob, getJob, markJobFailed } from "../repo/jobs";
import { touchProject } from "../repo/projects";
import { EXECUTORS } from "./executors";

/**
 * Runs one job to completion. Any throw — input validation, executor bug —
 * lands in markJobFailed; outputs are only written inside the executor's
 * success transaction, so a failed attempt leaves project state untouched.
 */
export async function runJob(handle: DbHandle, jobId: string): Promise<Job> {
  const { db } = handle;
  const job = getJob(db, jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const executor = EXECUTORS[job.type];
  try {
    if (!executor) throw new Error(`No executor registered for job type "${job.type}"`);
    await executor(handle, job);
  } catch (err) {
    markJobFailed(db, job.id, err instanceof Error ? err.message : String(err));
  }
  touchProject(db, job.projectId);
  return getJob(db, jobId)!;
}

/** Enqueue a stage job and run it to completion. */
export async function enqueueAndRun(
  handle: DbHandle,
  input: { projectId: string; stage: number; type: string },
): Promise<Job> {
  const job = createJob(handle.db, input);
  return runJob(handle, job.id);
}

/** Retry a failed job: a NEW attempt linked to the old one; history stays. */
export async function retryJob(handle: DbHandle, failedJobId: string): Promise<Job> {
  const { db } = handle;
  const failed = getJob(db, failedJobId);
  if (!failed) throw new Error(`Job ${failedJobId} not found`);
  if (failed.status !== "failed") {
    throw new Error(`Only failed jobs can be retried (status: ${failed.status})`);
  }
  const retry = createJob(db, {
    projectId: failed.projectId,
    stage: failed.stage,
    type: failed.type,
    retryOf: failed.id,
    attempt: failed.attempt + 1,
  });
  return runJob(handle, retry.id);
}
