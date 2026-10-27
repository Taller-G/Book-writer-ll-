"use server";

import { revalidatePath } from "next/cache";
import { createAiClient } from "../ai";
import { getDbHandle } from "../db/client";
import { rollbackTo } from "../preview/build";
import {
  confirmContentChange,
  rejectContentChange,
  submitCorrection,
  type AnnotationInput,
} from "../preview/correction";
import { touchProject } from "../repo/projects";

function stage8(projectId: string): void {
  revalidatePath(`/projects/${projectId}/stages/8`);
  revalidatePath(`/projects/${projectId}`);
}

function parseRegion(raw: string): AnnotationInput["region"] {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Record<string, number>;
    if (
      typeof r.x === "number" &&
      typeof r.y === "number" &&
      typeof r.w === "number" &&
      typeof r.h === "number"
    ) {
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
  } catch {
    /* ignore malformed region */
  }
  return null;
}

/**
 * Send a correction request (optionally an annotation) to the agent. Errors —
 * including a missing API key or a bad agent response — are recorded as an
 * agent message so the conversation always reflects what happened.
 */
export async function sendCorrectionAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const userText = String(formData.get("userText") ?? "").trim();
  if (!projectId || !userText) return;
  const handle = getDbHandle();
  const pageRaw = String(formData.get("pageNumber") ?? "");
  const pageNumber = pageRaw ? Number(pageRaw) : null;
  const annotation: AnnotationInput = {
    pageNumber: Number.isFinite(pageNumber) ? pageNumber : null,
    region: parseRegion(String(formData.get("region") ?? "")),
    image: String(formData.get("image") ?? "") || null,
  };
  try {
    const client = createAiClient(handle.db);
    await submitCorrection(handle, client, { projectId, userText, annotation });
  } catch (err) {
    // Surface the failure in the conversation rather than throwing to the UI.
    const { addCorrectionMessage } = await import("../repo/correction");
    addCorrectionMessage(handle.db, {
      projectId,
      role: "agent",
      body:
        "I couldn't process that request: " +
        (err instanceof Error ? err.message : String(err)),
      status: "answered",
    });
  }
  touchProject(handle.db, projectId);
  stage8(projectId);
}

export async function confirmContentAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const messageId = String(formData.get("messageId") ?? "");
  if (!projectId || !messageId) return;
  const handle = getDbHandle();
  confirmContentChange(handle, { projectId, messageId });
  touchProject(handle.db, projectId);
  stage8(projectId);
}

export async function rejectContentAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const messageId = String(formData.get("messageId") ?? "");
  if (!projectId || !messageId) return;
  const handle = getDbHandle();
  rejectContentChange(handle, { projectId, messageId });
  touchProject(handle.db, projectId);
  stage8(projectId);
}

export async function rollbackPdfAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const version = Number(formData.get("version") ?? 0);
  if (!projectId || !version) return;
  const handle = getDbHandle();
  rollbackTo(handle, { projectId, version });
  touchProject(handle.db, projectId);
  stage8(projectId);
}
