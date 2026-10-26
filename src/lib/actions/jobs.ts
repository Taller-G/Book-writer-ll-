"use server";

import { revalidatePath } from "next/cache";
import { getDbHandle } from "../db/client";
import { enqueueAndRun, retryJob } from "../jobs/runner";

export async function runStageJobAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const stage = Number(formData.get("stage") ?? 0);
  const type = String(formData.get("type") ?? "");
  if (!projectId || !type || stage < 1 || stage > 8) return;
  await enqueueAndRun(getDbHandle(), { projectId, stage, type });
  revalidatePath(`/projects/${projectId}/stages/${stage}`);
  revalidatePath(`/projects/${projectId}`);
}

export async function retryJobAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const jobId = String(formData.get("jobId") ?? "");
  const stage = Number(formData.get("stage") ?? 0);
  if (!jobId) return;
  await retryJob(getDbHandle(), jobId);
  revalidatePath(`/projects/${projectId}/stages/${stage}`);
  revalidatePath(`/projects/${projectId}`);
}
