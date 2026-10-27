import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { reviewQueue, type ReviewItem } from "../db/schema";
import { newId, now } from "../util";
import { appendChange } from "./changeLog";

export function addReviewItem(
  db: Db,
  input: {
    projectId: string;
    itemType?: string;
    excerpt: string;
    question: string;
    severity?: "gross" | "medium" | "minor";
    clipPath?: string | null;
    batchId?: string | null;
    refId?: string | null;
  },
): ReviewItem {
  const id = newId();
  db.insert(reviewQueue)
    .values({
      id,
      projectId: input.projectId,
      itemType: input.itemType ?? "edit",
      excerpt: input.excerpt,
      question: input.question,
      severity: input.severity ?? null,
      clipPath: input.clipPath ?? null,
      batchId: input.batchId ?? null,
      refId: input.refId ?? null,
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

export function countPendingReviews(db: Db, projectId: string): number {
  return db
    .select()
    .from(reviewQueue)
    .where(
      and(eq(reviewQueue.projectId, projectId), eq(reviewQueue.status, "pending")),
    )
    .all().length;
}

/** Pending items of one Pass C batch, gross severity first. */
export function listBatchItems(db: Db, batchId: string): ReviewItem[] {
  const rank = (s: ReviewItem["severity"]) =>
    s === "gross" ? 0 : s === "medium" ? 1 : 2;
  return db
    .select()
    .from(reviewQueue)
    .where(eq(reviewQueue.batchId, batchId))
    .all()
    .sort((a, b) => rank(a.severity) - rank(b.severity));
}

export function resolveReviewItem(
  db: Db,
  id: string,
  status: "accepted" | "rejected",
  note = "",
): void {
  const item = db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).get();
  if (!item) return;
  db.update(reviewQueue)
    .set({ status, resolutionNote: note, resolvedAt: now() })
    .where(eq(reviewQueue.id, id))
    .run();
  appendChange(db, {
    projectId: item.projectId,
    what: `Review item ${status}: ${item.question}`,
    where: item.excerpt ? `near "${item.excerpt.slice(0, 60)}"` : "review queue",
    why: note || `user ${status} the flagged edit`,
    authorizedBy: "user",
  });
}

/** Resolve a whole Pass C batch at once (the approvable-batch path). */
export function resolveBatch(
  db: Db,
  projectId: string,
  batchId: string,
  status: "accepted" | "rejected",
): number {
  const pending = listBatchItems(db, batchId).filter((i) => i.status === "pending");
  for (const item of pending) {
    resolveReviewItem(db, item.id, status, `batch ${status} (Pass C severity ${item.severity})`);
  }
  if (pending.length > 0) {
    appendChange(db, {
      projectId,
      what: `Pass C batch ${status}: ${pending.length} inconsistency item(s)`,
      where: "stage 6 · review queue",
      why: "user acted on a classified batch of inconsistencies in one step",
      authorizedBy: "user",
    });
  }
  return pending.length;
}
