"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb, getDbHandle } from "../db/client";
import {
  completeStage,
  createProject,
  deleteProject,
  getProject,
  reopenStage,
} from "../repo/projects";

export async function createProjectAction(formData: FormData): Promise<void> {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const author = String(formData.get("author") ?? "").trim();
  const project = createProject(getDbHandle(), { title, author });
  revalidatePath("/");
  redirect(`/projects/${project.id}`);
}

export async function deleteProjectAction(formData: FormData): Promise<void> {
  const id = String(formData.get("projectId") ?? "");
  if (id) deleteProject(getDbHandle(), id);
  revalidatePath("/");
  redirect("/");
}

export async function completeStageAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const stage = Number(formData.get("stage") ?? 0);
  const project = getProject(getDb(), projectId);
  if (!project || stage < 1 || stage > 8) return;
  completeStage(getDbHandle(), projectId, stage);
  revalidatePath(`/projects/${projectId}`);
  if (stage < 8) redirect(`/projects/${projectId}/stages/${stage + 1}`);
  redirect(`/projects/${projectId}`);
}

export async function reopenStageAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const stage = Number(formData.get("stage") ?? 0);
  if (!projectId || stage < 1 || stage > 8) return;
  reopenStage(getDbHandle(), projectId, stage);
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}/stages/${stage}`);
}
