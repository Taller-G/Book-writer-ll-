"use server";

import { revalidatePath } from "next/cache";
import { getDbHandle } from "../db/client";
import { parseFormatData } from "../format/config";
import { estimatePageCount } from "../cover/spine";
import {
  addIteration,
  confirmSpine,
  selectConcept,
  selectTitleOption,
  setBackCoverStatus,
  setConceptStatus,
  setPaperStock,
  type IterationRegion,
} from "../repo/covers";
import { runJob } from "../jobs/runner";
import { createJob } from "../repo/jobs";
import { getFormatConfig } from "../repo/output";
import { touchProject } from "../repo/projects";
import { latestText } from "../repo/texts";

// Server actions for the Stage 7 cover studio. Cover AI runs as jobs (stage 7);
// decisions (keep/discard/select/confirm) write directly. Every action
// revalidates the Stage 7 page.

const STAGE = 7;
function stagePath(projectId: string): string {
  return `/projects/${projectId}/stages/${STAGE}`;
}

/** Spawn a cover job, optionally carrying a conceptId, and run it. */
export async function runCoverJobAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const type = String(formData.get("type") ?? "");
  const conceptId = String(formData.get("conceptId") ?? "");
  const allowed = new Set([
    "propose_cover_concepts",
    "regenerate_cover_concept",
    "draft_back_cover",
    "iterate_cover",
  ]);
  if (!projectId || !allowed.has(type)) return;
  const handle = getDbHandle();
  const job = createJob(handle.db, {
    projectId,
    stage: STAGE,
    type,
    params: conceptId ? { conceptId } : undefined,
  });
  await runJob(handle, job.id);
  revalidatePath(stagePath(projectId));
  revalidatePath(`/projects/${projectId}`);
}

export async function setConceptStatusAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const conceptId = String(formData.get("conceptId") ?? "");
  const status = String(formData.get("status") ?? "") as "kept" | "discarded";
  if (!projectId || !conceptId || (status !== "kept" && status !== "discarded")) {
    return;
  }
  const { db } = getDbHandle();
  setConceptStatus(db, projectId, conceptId, status);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function selectConceptAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const conceptId = String(formData.get("conceptId") ?? "");
  if (!projectId || !conceptId) return;
  const { db } = getDbHandle();
  selectConcept(db, projectId, conceptId);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function resolveBackCoverAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const sectionKey = String(formData.get("sectionKey") ?? "");
  const status = String(formData.get("status") ?? "") as "accepted" | "discarded";
  if (!projectId || !sectionKey || (status !== "accepted" && status !== "discarded")) {
    return;
  }
  const content = formData.get("content");
  const { db } = getDbHandle();
  setBackCoverStatus(
    db,
    projectId,
    sectionKey,
    status,
    typeof content === "string" ? content : undefined,
  );
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function selectTitleOptionAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const optionId = String(formData.get("optionId") ?? "");
  if (!projectId || !optionId) return;
  const { db } = getDbHandle();
  selectTitleOption(db, projectId, optionId);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function setPaperStockAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const paperStock = String(formData.get("paperStock") ?? "");
  if (!projectId || !paperStock) return;
  const { db } = getDbHandle();
  setPaperStock(db, projectId, paperStock);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

/** Confirm the spine width at the current estimated page count. */
export async function confirmSpineAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;
  const { db } = getDbHandle();
  const format = parseFormatData(getFormatConfig(db, projectId).data);
  const finalText = latestText(db, projectId, "final");
  const pageCount = estimatePageCount(finalText?.content ?? "", format);
  confirmSpine(db, projectId, pageCount);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

/**
 * Add an annotation (optionally with a marked region) to the cover preview and
 * run the cover agent so it answers — the annotation reaches the agent with
 * the region attached.
 */
export async function addCoverAnnotationAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!projectId || !note) return;
  const conceptId = String(formData.get("conceptId") ?? "");
  const target = (String(formData.get("target") ?? "spread") || "spread") as
    | "front"
    | "back"
    | "spine"
    | "spread";
  const region = parseRegionField(formData.get("region"));
  const handle = getDbHandle();
  addIteration(handle.db, {
    projectId,
    conceptId: conceptId || undefined,
    target,
    region,
    note,
  });
  const job = createJob(handle.db, {
    projectId,
    stage: STAGE,
    type: "iterate_cover",
  });
  await runJob(handle, job.id);
  touchProject(handle.db, projectId);
  revalidatePath(stagePath(projectId));
}

function parseRegionField(raw: FormDataEntryValue | null): IterationRegion | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const r = JSON.parse(raw) as IterationRegion;
    const inRange = (n: unknown) => typeof n === "number" && n >= 0 && n <= 1;
    if (inRange(r.x) && inRange(r.y) && inRange(r.w) && inRange(r.h)) return r;
  } catch {
    /* ignore malformed region */
  }
  return null;
}
