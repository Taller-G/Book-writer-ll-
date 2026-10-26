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
      createdAt: now(),
    })
    .run();
  return db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).get()!;
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
