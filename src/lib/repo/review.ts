import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { reviewQueue, type ReviewItem } from "../db/schema";
import type { StageTextKey } from "../stages";
import { newId, now } from "../util";
import { appendChange } from "./changeLog";
import { latestText, updateTextContent } from "./texts";

// The review queue is the unified inbox of human decisions. Any producer (audio
// doubts, reaction candidates, ambiguous questions, punctuation batches,
// low-dpi images) emits an item through addReviewItem(); resolveReviewItem()
// records the decision in the change log AND applies it to the working text.

/** One resolution choice shown on a card (option A / option B). */
export interface ReviewOption {
  id: string;
  label: string;
  value: string;
}

export interface AddReviewInput {
  projectId: string;
  itemType?: string;
  /** Short legacy summary; kept for back-compat with existing producers. */
  excerpt?: string;
  question: string;
  // The doubtful span with the validated text around it.
  contextBefore?: string;
  doubtfulText?: string;
  contextAfter?: string;
  options?: ReviewOption[];
  /** Which stage text the span lives in, so a resolution can edit it. */
  stageKey?: StageTextKey;
  // Audio-doubt locating.
  sourceId?: string;
  anchorBefore?: string;
  anchorAfter?: string;
  rawTimestamp?: number;
  /** Override the auto-computed dedupe key (stable fingerprint of the span). */
  dedupeKey?: string;
}

/** Resolution actions. Legacy accepted/rejected are still accepted so older
 *  call sites keep working. */
export type Resolution =
  | "accepted"
  | "rejected"
  | "approve"
  | "reject"
  | "option_a"
  | "option_b"
  | "leave_as_is"
  | "cut_sentence"
  | "free_text";

export interface ResolveOptions {
  note?: string;
  /** Free-text replacement, or the chosen option id for option_a/option_b. */
  value?: string;
}

const LEAVE_AS_IS: Resolution = "leave_as_is";

/** A stable fingerprint of a doubtful span, so the same doubt in a later pass
 *  maps to the same key — the basis for "leave as is is never re-flagged". */
export function computeDedupeKey(itemType: string, basis: string): string {
  const norm = basis.toLowerCase().replace(/\s+/g, " ").trim();
  return `${itemType}::${norm}`;
}

/**
 * Add a doubt to the queue. Returns the created item, or null when it was
 * suppressed: a span the user already resolved as "leave as is" is never
 * flagged again, and an identical pending item is not duplicated.
 */
export function addReviewItem(db: Db, input: AddReviewInput): ReviewItem | null {
  const itemType = input.itemType ?? "edit";
  const basis = input.doubtfulText || input.excerpt || input.question;
  const dedupeKey = input.dedupeKey ?? computeDedupeKey(itemType, basis);

  const priorWithKey = db
    .select()
    .from(reviewQueue)
    .where(
      and(
        eq(reviewQueue.projectId, input.projectId),
        eq(reviewQueue.dedupeKey, dedupeKey),
      ),
    )
    .all();
  // Never re-flag something resolved "leave as is"; never duplicate a pending one.
  if (
    priorWithKey.some(
      (p) => p.resolution === LEAVE_AS_IS || p.status === "pending",
    )
  ) {
    return null;
  }

  const id = newId();
  db.insert(reviewQueue)
    .values({
      id,
      projectId: input.projectId,
      itemType,
      excerpt: input.excerpt ?? "",
      question: input.question,
      contextBefore: input.contextBefore ?? "",
      doubtfulText: input.doubtfulText ?? "",
      contextAfter: input.contextAfter ?? "",
      options: JSON.stringify(input.options ?? []),
      stageKey: input.stageKey ?? null,
      sourceId: input.sourceId ?? null,
      anchorBefore: input.anchorBefore ?? "",
      anchorAfter: input.anchorAfter ?? "",
      rawTimestamp: input.rawTimestamp ?? null,
      dedupeKey,
      createdAt: now(),
    })
    .run();
  return db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).get()!;
}

export function getReviewItem(db: Db, id: string): ReviewItem | undefined {
  return db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).get();
}

export function listReviewItems(db: Db, projectId: string): ReviewItem[] {
  return db
    .select()
    .from(reviewQueue)
    .where(eq(reviewQueue.projectId, projectId))
    .orderBy(desc(reviewQueue.createdAt))
    .all();
}

export function parseOptions(item: ReviewItem): ReviewOption[] {
  try {
    const parsed = JSON.parse(item.options);
    return Array.isArray(parsed) ? (parsed as ReviewOption[]) : [];
  } catch {
    return [];
  }
}

export function countPendingReviews(db: Db, projectId: string): number {
  return db
    .select()
    .from(reviewQueue)
    .where(
      and(eq(reviewQueue.projectId, projectId), eq(reviewQueue.status, "pending")),
    )
    .all().length;
}

export interface ReviewProgress {
  total: number;
  pending: number;
  resolved: number;
  byType: Record<string, { total: number; pending: number }>;
}

/** Counts for the inbox header: overall progress and a per-producer breakdown. */
export function reviewProgress(db: Db, projectId: string): ReviewProgress {
  const items = listReviewItems(db, projectId);
  const byType: ReviewProgress["byType"] = {};
  let pending = 0;
  for (const i of items) {
    const bucket = (byType[i.itemType] ??= { total: 0, pending: 0 });
    bucket.total += 1;
    if (i.status === "pending") {
      bucket.pending += 1;
      pending += 1;
    }
  }
  return { total: items.length, pending, resolved: items.length - pending, byType };
}

// --- Applying a resolution to the working text -------------------------------

const APPLY_ORDER: StageTextKey[] = ["passB", "passA", "raw", "final"];

/** The text a span belongs to: the item's own stage if set and present, else
 *  the latest of the working texts. */
function targetText(db: Db, item: ReviewItem) {
  const preferred =
    item.stageKey && (APPLY_ORDER as string[]).includes(item.stageKey)
      ? [item.stageKey as StageTextKey, ...APPLY_ORDER]
      : APPLY_ORDER;
  for (const key of preferred) {
    const text = latestText(db, item.projectId, key);
    if (text) return text;
  }
  return undefined;
}

/** Replace the doubtful span with `replacement` in `content`. Uses the
 *  before/after context to disambiguate, falling back to the first occurrence.
 *  Returns null when the span cannot be found. */
function replaceSpan(content: string, item: ReviewItem, replacement: string): string | null {
  const doubtful = item.doubtfulText;
  if (!doubtful) return null;
  if (item.contextBefore || item.contextAfter) {
    const region = `${item.contextBefore}${doubtful}${item.contextAfter}`;
    const idx = content.indexOf(region);
    if (idx >= 0) {
      const newRegion = `${item.contextBefore}${replacement}${item.contextAfter}`;
      return content.slice(0, idx) + newRegion + content.slice(idx + region.length);
    }
  }
  const idx = content.indexOf(doubtful);
  if (idx < 0) return null;
  return content.slice(0, idx) + replacement + content.slice(idx + doubtful.length);
}

/** Tidy the seams left by a deletion: doubled spaces and spaces before
 *  punctuation. */
function tidy(content: string): string {
  return content.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1");
}

interface Applied {
  applied: boolean;
  description: string;
}

/** Work out the new text for a resolution and write it in place. */
function applyResolutionToText(
  db: Db,
  item: ReviewItem,
  resolution: Resolution,
  value: string,
): Applied {
  // Decisions that keep the text as it stands change nothing.
  if (
    resolution === LEAVE_AS_IS ||
    resolution === "reject" ||
    resolution === "rejected"
  ) {
    return { applied: false, description: "" };
  }

  let replacement: string | null = null;
  let verb = "replaced";
  if (resolution === "cut_sentence") {
    replacement = "";
    verb = "cut";
  } else if (resolution === "free_text") {
    replacement = value;
  } else if (resolution === "option_a" || resolution === "option_b") {
    const option = parseOptions(item).find((o) => o.id === value);
    replacement = option ? option.value : null;
  } else if (resolution === "approve" || resolution === "accepted") {
    // Approve a suggested correction: prefer an explicit value, else the lone
    // option. With nothing to apply, the approval is recorded but the text is
    // left untouched.
    const options = parseOptions(item);
    replacement = value || (options.length === 1 ? options[0].value : "");
    if (!replacement && !value) return { applied: false, description: "" };
  }

  if (replacement === null || !item.doubtfulText) {
    return { applied: false, description: "" };
  }

  const text = targetText(db, item);
  if (!text) return { applied: false, description: "" };
  const replaced = replaceSpan(text.content, item, replacement);
  if (replaced === null) return { applied: false, description: "" };
  const next = resolution === "cut_sentence" ? tidy(replaced) : replaced;
  if (next === text.content) return { applied: false, description: "" };
  updateTextContent(db, text.id, next);
  const shownFrom = item.doubtfulText.slice(0, 60);
  const description =
    resolution === "cut_sentence"
      ? `cut "${shownFrom}" from ${text.stageKey} v${text.version}`
      : `${verb} "${shownFrom}" with "${replacement.slice(0, 60)}" in ${text.stageKey} v${text.version}`;
  return { applied: true, description };
}

/** A short human label for a resolution, for the change log. */
function resolutionLabel(resolution: Resolution, item: ReviewItem, value: string): string {
  switch (resolution) {
    case "leave_as_is":
      return "left as is";
    case "cut_sentence":
      return "cut the sentence";
    case "free_text":
      return `replaced with free text`;
    case "option_a":
    case "option_b": {
      const option = parseOptions(item).find((o) => o.id === value);
      return option ? `chose "${option.label}"` : "chose an option";
    }
    case "approve":
    case "accepted":
      return "approved";
    case "reject":
    case "rejected":
      return "rejected";
    default:
      return resolution;
  }
}

/**
 * Resolve one item: record the decision in the (append-only) change log, apply
 * it to the working text where the resolution calls for a text change, and mark
 * the row resolved. Legacy callers may pass "accepted"/"rejected" positionally.
 */
export function resolveReviewItem(
  db: Db,
  id: string,
  resolution: Resolution,
  opts: ResolveOptions = {},
): void {
  const item = getReviewItem(db, id);
  if (!item || item.status !== "pending") return;
  const value = opts.value ?? "";
  const note = opts.note ?? "";

  const applied = applyResolutionToText(db, item, resolution, value);

  const status: ReviewItem["status"] =
    resolution === "reject" || resolution === "rejected" ? "rejected" : "accepted";

  db.update(reviewQueue)
    .set({
      status,
      resolution,
      resolutionValue: value,
      resolutionNote: note,
      resolvedAt: now(),
    })
    .where(eq(reviewQueue.id, id))
    .run();

  const label = resolutionLabel(resolution, item, value);
  appendChange(db, {
    projectId: item.projectId,
    what:
      `Review item ${label}: ${item.question}` +
      (applied.applied ? ` — ${applied.description}` : ""),
    where: item.doubtfulText
      ? `near "${item.doubtfulText.slice(0, 60)}"`
      : item.excerpt
        ? `near "${item.excerpt.slice(0, 60)}"`
        : "review queue",
    why: note || `user ${label}`,
    authorizedBy: "user",
  });
}

/**
 * Resolve many items with the same action in one go — the batch path for
 * punctuation suggestions (bulk approve / reject). Returns how many were
 * actually resolved (already-resolved ids are skipped). */
export function resolveReviewBatch(
  db: Db,
  ids: string[],
  resolution: Resolution,
  opts: ResolveOptions = {},
): number {
  let resolved = 0;
  for (const id of ids) {
    const before = getReviewItem(db, id);
    if (!before || before.status !== "pending") continue;
    resolveReviewItem(db, id, resolution, opts);
    resolved += 1;
  }
  return resolved;
}
