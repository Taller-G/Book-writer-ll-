"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "../db/client";
import {
  approveStyleSample,
  validateAgainstSample,
} from "../repo/editorial";
import { loadRuleSet, setRuleEnabled } from "../repo/normalization";
import { setApparatusStatus } from "../repo/apparatus";
import {
  confirmOutline,
  saveOutlineEdit,
  type OutlineChapter,
} from "../repo/outline";
import { touchProject } from "../repo/projects";

// Server actions for the master-text stage (stage 5, editorial prose mode).
// Every user decision lands in the change log via the repo layer.

function stagePath(projectId: string): string {
  return `/projects/${projectId}/stages/5`;
}

function parseChapters(json: string): OutlineChapter[] | undefined {
  try {
    const parsed = JSON.parse(json) as OutlineChapter[];
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed.filter(
      (c) =>
        typeof c.id === "string" &&
        typeof c.title === "string" &&
        Array.isArray(c.segmentIds),
    );
  } catch {
    return undefined;
  }
}

/** Persist outline edits made in the editor (reorder / rename / merge). */
export async function saveOutlineEditAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const chapters = parseChapters(String(formData.get("chapters") ?? ""));
  const editSummary = String(formData.get("editSummary") ?? "").trim();
  if (!projectId || !chapters) return;
  const db = getDb();
  saveOutlineEdit(
    db,
    projectId,
    chapters,
    editSummary || "Outline edited by the user",
  );
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function confirmOutlineAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;
  const db = getDb();
  confirmOutline(db, projectId);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function toggleRuleAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const ruleKey = String(formData.get("ruleKey") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!projectId || !ruleKey) return;
  const db = getDb();
  setRuleEnabled(db, projectId, ruleKey, enabled);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function loadRuleSetAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const language = String(formData.get("language") ?? "");
  if (!projectId || !language) return;
  const db = getDb();
  loadRuleSet(db, projectId, language);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function approveSampleAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;
  const db = getDb();
  approveStyleSample(db, projectId);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function validateSampleAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;
  const db = getDb();
  validateAgainstSample(db, projectId);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function resolveApparatusAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const sectionKey = String(formData.get("sectionKey") ?? "");
  const status = String(formData.get("status") ?? "") as "accepted" | "discarded";
  if (!projectId || !sectionKey || (status !== "accepted" && status !== "discarded")) {
    return;
  }
  const content = formData.get("content");
  const db = getDb();
  setApparatusStatus(
    db,
    projectId,
    sectionKey,
    status,
    typeof content === "string" ? content : undefined,
  );
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}
