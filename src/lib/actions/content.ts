"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "../db/client";
import type { Source } from "../db/schema";
import { saveContract, saveStyleProfile } from "../repo/editorial";
import { addCover, saveFormatConfig, selectCover, setChecklistDone } from "../repo/output";
import { touchProject } from "../repo/projects";
import { resolveReviewItem } from "../repo/review";
import { addSource, removeSource } from "../repo/sources";

function stagePath(projectId: string, stage: number): string {
  return `/projects/${projectId}/stages/${stage}`;
}

export async function addSourceAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const content = String(formData.get("content") ?? "").trim();
  const kind = String(formData.get("kind") ?? "transcript") as Source["kind"];
  if (!projectId || !title || !content) return;
  const db = getDb();
  addSource(db, { projectId, kind, title, content });
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 1));
}

export async function removeSourceAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const sourceId = String(formData.get("sourceId") ?? "");
  if (!sourceId) return;
  removeSource(getDb(), sourceId);
  revalidatePath(stagePath(projectId, 1));
}

export async function saveContractAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const mode = String(formData.get("mode") ?? "hybrid") as
    | "verbatim"
    | "prose"
    | "hybrid";
  if (!projectId) return;
  const db = getDb();
  saveContract(db, {
    projectId,
    mode,
    rules: String(formData.get("rules") ?? ""),
    notes: String(formData.get("notes") ?? ""),
  });
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 2));
}

export async function saveStyleAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;
  const db = getDb();
  saveStyleProfile(db, {
    projectId,
    tone: String(formData.get("tone") ?? ""),
    register: String(formData.get("register") ?? ""),
    person: String(formData.get("person") ?? ""),
    notes: String(formData.get("notes") ?? ""),
  });
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 3));
}

export async function resolveReviewAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  const status = String(formData.get("status") ?? "") as "accepted" | "rejected";
  if (!itemId || (status !== "accepted" && status !== "rejected")) return;
  const db = getDb();
  resolveReviewItem(db, itemId, status, String(formData.get("note") ?? ""));
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 6));
}

export async function saveFormatAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;
  const db = getDb();
  saveFormatConfig(db, {
    projectId,
    trimSize: String(formData.get("trimSize") ?? "6x9in"),
    fontFamily: String(formData.get("fontFamily") ?? "Garamond"),
    fontSizePt: Number(formData.get("fontSizePt") ?? 11),
    lineHeight: Number(formData.get("lineHeight") ?? 1.4),
    margins: String(formData.get("margins") ?? "{}"),
  });
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 7));
}

export async function toggleChecklistAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  const done = String(formData.get("done") ?? "") === "true";
  if (!itemId) return;
  setChecklistDone(getDb(), itemId, done);
  revalidatePath(stagePath(projectId, 8));
}

export async function addCoverAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!projectId || !title) return;
  addCover(getDb(), {
    projectId,
    title,
    description: String(formData.get("description") ?? ""),
  });
  revalidatePath(stagePath(projectId, 8));
}

export async function selectCoverAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const coverId = String(formData.get("coverId") ?? "");
  if (!projectId || !coverId) return;
  selectCover(getDb(), projectId, coverId);
  revalidatePath(stagePath(projectId, 8));
}
