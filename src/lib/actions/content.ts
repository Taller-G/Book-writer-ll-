"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "../db/client";
import type { Source } from "../db/schema";
import { removeSourceFiles, verifyChecksum } from "../files/store";
import { appendChange } from "../repo/changeLog";
import {
  confirmStyleProfile,
  getConfirmedStyleProfile,
  saveContract,
} from "../repo/editorial";
import { addCover, saveFormatConfig, selectCover, setChecklistDone } from "../repo/output";
import { touchProject } from "../repo/projects";
import { resolveReviewItem } from "../repo/review";
import { removeStyleRef } from "../repo/styleRefs";
import {
  addSource,
  getSource,
  linkSources,
  mergeSourceMetadata,
  removeSource,
  unlinkSources,
} from "../repo/sources";
import { stampTextProfileVersion } from "../repo/texts";
import { now } from "../util";

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
  const db = getDb();
  const source = getSource(db, sourceId);
  removeSource(db, sourceId);
  // Removing a source deletes its whole file tree (original + derived).
  if (source?.originalPath) {
    removeSourceFiles(source.projectId, sourceId);
  }
  revalidatePath(stagePath(projectId, 1));
}

/** Recompute the original's SHA-1 and record the verification on the card. */
export async function verifySourceAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const sourceId = String(formData.get("sourceId") ?? "");
  if (!sourceId) return;
  const db = getDb();
  const source = getSource(db, sourceId);
  if (!source?.originalPath || !source.checksumSha1) return;
  let verification: { ok: boolean; actual: string };
  try {
    verification = verifyChecksum(source.originalPath, source.checksumSha1);
  } catch (e) {
    verification = {
      ok: false,
      actual: `unreadable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  mergeSourceMetadata(db, sourceId, {
    lastVerifiedAt: now(),
    lastVerifiedOk: verification.ok,
    lastVerifiedSha1: verification.actual,
  });
  revalidatePath(stagePath(projectId, 1));
}

/** Manually link an audio/video source with a transcript/document source. */
export async function linkSourcesAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const sourceId = String(formData.get("sourceId") ?? "");
  const otherId = String(formData.get("otherId") ?? "");
  if (!sourceId || !otherId || sourceId === otherId) return;
  const db = getDb();
  const a = getSource(db, sourceId);
  const b = getSource(db, otherId);
  if (!a || !b || a.projectId !== b.projectId) return;
  const isMedia = (s: Source) =>
    s.mediaType === "audio" || s.mediaType === "video" || s.kind === "audio";
  const media = isMedia(a) ? a : isMedia(b) ? b : null;
  const text = media === a ? b : a;
  if (!media || isMedia(text)) return;
  linkSources(db, media.id, text.id);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 1));
}

export async function unlinkSourceAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const sourceId = String(formData.get("sourceId") ?? "");
  if (!sourceId) return;
  unlinkSources(getDb(), sourceId);
  revalidatePath(stagePath(projectId, 1));
}

export async function saveContractAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const mode = String(formData.get("mode") ?? "hybrid") as
    | "verbatim"
    | "prose"
    | "hybrid";
  if (!projectId) return;
  const optional = <T extends string>(name: string): T | undefined => {
    const value = String(formData.get(name) ?? "");
    return value ? (value as T) : undefined;
  };
  const db = getDb();
  saveContract(db, {
    projectId,
    mode,
    tone: optional<
      "neutral" | "literary_cinematic" | "academic" | "conversational"
    >("tone"),
    destination: optional<"personal" | "short_run" | "isbn" | "digital">(
      "destination",
    ),
    authorship: optional<"own" | "third_party" | "mixed">("authorship"),
    rightsNotes: String(formData.get("rightsNotes") ?? ""),
    legalText: String(formData.get("legalText") ?? ""),
    rules: String(formData.get("rules") ?? ""),
    notes: String(formData.get("notes") ?? ""),
  });
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 2));
}

export async function removeStyleRefAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const refId = String(formData.get("refId") ?? "");
  if (!refId) return;
  removeStyleRef(getDb(), refId);
  revalidatePath(stagePath(projectId, 3));
}

/**
 * Confirm the style profile exactly as the user reviewed/adjusted it in the
 * plain-language form. Excerpts arrive one per block, separated by blank
 * lines; at most 5 are kept as the few-shot set.
 */
export async function confirmStyleAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;
  const excerpts = String(formData.get("excerpts") ?? "")
    .split(/\n\s*\n/)
    .map((e) => e.trim())
    .filter(Boolean)
    .slice(0, 5);
  const db = getDb();
  confirmStyleProfile(db, projectId, {
    tone: String(formData.get("tone") ?? ""),
    register: String(formData.get("register") ?? ""),
    person: String(formData.get("person") ?? ""),
    notes: String(formData.get("notes") ?? ""),
    voice: String(formData.get("voice") ?? ""),
    rhythm: String(formData.get("rhythm") ?? ""),
    punctuation: String(formData.get("punctuation") ?? ""),
    metaphors: String(formData.get("metaphors") ?? ""),
    openings: String(formData.get("openings") ?? ""),
    excerpts,
  });
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 3));
}

/**
 * The user chose to KEEP a text that was written under an older style
 * profile: stamp it with the current profile version and record the decision
 * in the audit log. The text itself is untouched.
 */
export async function keepTextProfileAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const textId = String(formData.get("textId") ?? "");
  const stageKey = String(formData.get("stageKey") ?? "");
  if (!projectId || !textId) return;
  const db = getDb();
  const profile = getConfirmedStyleProfile(db, projectId);
  if (!profile) return;
  stampTextProfileVersion(db, textId, profile.version);
  appendChange(db, {
    projectId,
    what: `Kept ${stageKey} text written under an older style profile (now counted as v${profile.version})`,
    where: `style profile · ${stageKey} text`,
    why: "user chose to keep the text instead of regenerating it after a profile change",
    authorizedBy: "user",
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
