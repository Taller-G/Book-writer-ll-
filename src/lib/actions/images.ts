"use server";

import { revalidatePath } from "next/cache";
import { getDb, getDbHandle } from "../db/client";
import { removeImageFiles } from "../files/store";
import { enqueueAndRun } from "../jobs/runner";
import {
  discardImage,
  getImage,
  placeImage,
  regenerateImageCredits,
  removeImage,
  reorderImages,
  setImageCaption,
  setImageCreditsStatus,
  setImageOrigin,
  setImageSize,
} from "../repo/images";
import { getProject, touchProject } from "../repo/projects";
import type { BookImage } from "../db/schema";

// Server actions for the Stage 7 images panel. Each one mutates an image (or
// the credits section), regenerates the automatic credits so the section always
// matches the current images, and revalidates the stage.

const STAGE = 7;

function stagePath(projectId: string): string {
  return `/projects/${projectId}/stages/${STAGE}`;
}

/** Rebuild credits from the current images after any change to them. */
function refreshCredits(projectId: string): void {
  const db = getDb();
  const author = getProject(db, projectId)?.author ?? "";
  regenerateImageCredits(db, projectId, author);
}

export async function generateImageAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const prompt = String(formData.get("prompt") ?? "").trim();
  const caption = String(formData.get("caption") ?? "").trim();
  if (!projectId || !prompt) return;
  await enqueueAndRun(getDbHandle(), {
    projectId,
    stage: STAGE,
    type: "generate_image",
    params: { prompt, caption },
  });
  revalidatePath(stagePath(projectId));
  revalidatePath(`/projects/${projectId}`);
}

export async function placeImageAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const imageId = String(formData.get("imageId") ?? "");
  const anchorText = String(formData.get("anchorText") ?? "").trim();
  const sizeOption = String(formData.get("sizeOption") ?? "column") as
    | BookImage["sizeOption"];
  if (!projectId || !imageId) return;
  const db = getDb();
  placeImage(db, imageId, { anchorText, sizeOption });
  refreshCredits(projectId);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function setImageSizeAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const imageId = String(formData.get("imageId") ?? "");
  const sizeOption = String(formData.get("sizeOption") ?? "column") as
    | BookImage["sizeOption"];
  if (!projectId || !imageId) return;
  setImageSize(getDb(), imageId, sizeOption);
  revalidatePath(stagePath(projectId));
}

export async function setImageOriginAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const imageId = String(formData.get("imageId") ?? "");
  const origin = String(formData.get("origin") ?? "own") as BookImage["origin"];
  if (!projectId || !imageId) return;
  setImageOrigin(getDb(), imageId, {
    origin,
    sourceCredit: String(formData.get("sourceCredit") ?? ""),
    licenseNote: String(formData.get("licenseNote") ?? ""),
  });
  refreshCredits(projectId);
  revalidatePath(stagePath(projectId));
}

export async function setImageCaptionAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const imageId = String(formData.get("imageId") ?? "");
  if (!projectId || !imageId) return;
  setImageCaption(getDb(), imageId, {
    caption: String(formData.get("caption") ?? ""),
    altText: String(formData.get("altText") ?? ""),
  });
  refreshCredits(projectId);
  revalidatePath(stagePath(projectId));
}

export async function discardImageAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const imageId = String(formData.get("imageId") ?? "");
  if (!projectId || !imageId) return;
  const db = getDb();
  discardImage(db, imageId);
  refreshCredits(projectId);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function deleteImageAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const imageId = String(formData.get("imageId") ?? "");
  if (!projectId || !imageId) return;
  const db = getDb();
  const image = getImage(db, imageId);
  removeImage(db, imageId);
  if (image) removeImageFiles(projectId, imageId);
  refreshCredits(projectId);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function reorderImagesAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const orderedIds = String(formData.get("orderedIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!projectId || orderedIds.length === 0) return;
  const db = getDb();
  reorderImages(db, projectId, orderedIds);
  refreshCredits(projectId);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId));
}

export async function regenerateCreditsAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;
  refreshCredits(projectId);
  revalidatePath(stagePath(projectId));
}

export async function setCreditsStatusAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const status = String(formData.get("status") ?? "") as "accepted" | "discarded";
  if (!projectId || (status !== "accepted" && status !== "discarded")) return;
  const edited = formData.get("content");
  setImageCreditsStatus(
    getDb(),
    projectId,
    status,
    typeof edited === "string" ? edited : undefined,
  );
  revalidatePath(stagePath(projectId));
}
