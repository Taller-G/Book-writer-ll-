"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "../db/client";
import type { Source } from "../db/schema";
import {
  readOriginal,
  removeSourceFiles,
  verifyChecksum,
  writeDerived,
} from "../files/store";
import { parseFormatData } from "../format/config";
import { appendChange } from "../repo/changeLog";
import {
  confirmStyleProfile,
  getConfirmedStyleProfile,
  saveContract,
} from "../repo/editorial";
import { addCover, saveFormatConfig, selectCover, setChecklistDone } from "../repo/output";
import { assertUnlocked, unlockText } from "../repo/locks";
import { touchProject } from "../repo/projects";
import {
  addReaction,
  getReaction,
  setReactionStatus,
} from "../repo/reactions";
import {
  getReviewItem,
  resolveBatch,
  resolveReviewBatch,
  resolveReviewItem,
  type Resolution,
} from "../repo/review";
import { msToCharOffset } from "../reactions/detect";
import { decodeWav, sliceClipWav } from "../reactions/wav";
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

const RESOLUTIONS: readonly Resolution[] = [
  "accepted",
  "rejected",
  "approve",
  "reject",
  "option_a",
  "option_b",
  "leave_as_is",
  "cut_sentence",
  "free_text",
];

function isResolution(value: string): value is Resolution {
  return (RESOLUTIONS as readonly string[]).includes(value);
}

/** Resolve a single review item with the chosen action (option A/B, leave as
 *  is, cut sentence, free text, approve/reject). */
export async function resolveReviewAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  // `resolution` is the new field; `status` is the legacy accept/reject name.
  const resolution = String(formData.get("resolution") ?? formData.get("status") ?? "");
  if (!itemId || !isResolution(resolution)) return;
  const db = getDb();
  resolveReviewItem(db, itemId, resolution, {
    note: String(formData.get("note") ?? ""),
    value: String(formData.get("value") ?? ""),
  });
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 6));
}

/** Resolve many items at once — the bulk path for punctuation batches. */
export async function resolveReviewBatchAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const resolution = String(formData.get("resolution") ?? "");
  const ids = formData.getAll("itemId").map(String).filter(Boolean);
  if (ids.length === 0 || !isResolution(resolution)) return;
  const db = getDb();
  resolveReviewBatch(db, ids, resolution, { note: String(formData.get("note") ?? "") });
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 6));
}

/** Confirm or reject a detected reaction candidate; resolves its review item. */
export async function resolveReactionAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const reactionId = String(formData.get("reactionId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  const decision = String(formData.get("decision") ?? "") as "confirm" | "reject";
  if (!reactionId || (decision !== "confirm" && decision !== "reject")) return;
  const db = getDb();
  assertUnlocked(db, projectId);
  const reaction = getReaction(db, reactionId);
  if (!reaction) return;
  setReactionStatus(db, reactionId, decision === "confirm" ? "confirmed" : "rejected");
  if (itemId && getReviewItem(db, itemId)) {
    resolveReviewItem(db, itemId, decision === "confirm" ? "accepted" : "rejected", {
      note:
        decision === "confirm"
          ? `confirmed ${reaction.kind} reaction for insertion`
          : `rejected ${reaction.kind} reaction (false positive)`,
    });
  }
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 5));
}

/**
 * Manual reaction marking for rooms where acoustic detection finds nothing
 * (the quiet-room path). Creates a CONFIRMED reaction directly. When an audio
 * source and a timestamp are given, a clip is cut; otherwise it is a pure
 * text-anchored mark.
 */
export async function markReactionAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const kind = String(formData.get("kind") ?? "") as "laughter" | "applause";
  if (!projectId || (kind !== "laughter" && kind !== "applause")) return;
  const db = getDb();
  assertUnlocked(db, projectId);
  const sourceId = String(formData.get("sourceId") ?? "") || null;
  const atMs = Number(formData.get("atMs") ?? "");
  const hasMs = Number.isFinite(atMs) && atMs >= 0;
  let charAnchor: number | null = null;
  const rawAnchor = Number(formData.get("charAnchor") ?? "");
  if (Number.isFinite(rawAnchor) && rawAnchor >= 0) charAnchor = Math.round(rawAnchor);

  let clipPath: string | null = null;
  let startMs = hasMs ? Math.round(atMs) : 0;
  let endMs = hasMs ? Math.round(atMs) + 1500 : 0;
  const source = sourceId ? getSource(db, sourceId) : undefined;
  if (source?.originalPath && hasMs) {
    try {
      const audio = decodeWav(readOriginal(source.originalPath));
      const totalMs = (source.durationSeconds ?? audio.frameCount / audio.sampleRate) * 1000;
      endMs = Math.min(totalMs, startMs + 1500);
      if (charAnchor === null && source.content) {
        charAnchor = msToCharOffset(startMs, totalMs, source.content.length);
      }
      clipPath = writeDerived(
        projectId,
        sourceId!,
        `reaction-manual-${startMs}-${kind}.wav`,
        sliceClipWav(audio, startMs, endMs),
      );
    } catch {
      // Non-WAV or unreadable — keep it as a text-only manual mark.
      startMs = hasMs ? Math.round(atMs) : 0;
      endMs = startMs;
    }
  }

  addReaction(db, {
    projectId,
    sourceId,
    kind,
    startMs,
    endMs,
    clipPath,
    acoustic: {},
    semantic: "manually marked by user",
    origin: "manual",
    status: "confirmed",
    charAnchor,
  });
  appendChange(db, {
    projectId,
    what: `Manually marked a ${kind} reaction${hasMs ? ` at ${startMs} ms` : ""}`,
    where: "stage 5 · reactions",
    why: "acoustic detection found nothing in this room — user marked it by hand",
    authorizedBy: "user",
  });
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 5));
}

/** Accept or reject a whole Pass C batch of inconsistencies in one step. */
export async function resolveBatchAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const batchId = String(formData.get("batchId") ?? "");
  const status = String(formData.get("status") ?? "") as "accepted" | "rejected";
  if (!projectId || !batchId || (status !== "accepted" && status !== "rejected")) return;
  const db = getDb();
  resolveBatch(db, projectId, batchId, status);
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 6));
}

/** Explicitly reopen a FINAL (locked) text for editing; the reason is logged. */
export async function unlockTextAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;
  const db = getDb();
  unlockText(db, projectId, String(formData.get("reason") ?? ""));
  touchProject(db, projectId);
  revalidatePath(stagePath(projectId, 6));
}

export async function saveFormatAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;
  const db = getDb();
  // The wizard posts the whole configuration as one JSON payload; anything
  // missing or malformed falls back to the §7 proven defaults.
  const data = parseFormatData(String(formData.get("formatData") ?? "{}"));
  saveFormatConfig(db, projectId, data);
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
