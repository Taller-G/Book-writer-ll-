import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { reactions, type Reaction } from "../db/schema";
import { newId, now } from "../util";

// Audience reactions (spec §4 stage 3.4). Acoustic detection emits candidates;
// the review queue confirms them; Pass B inserts the confirmed ones. Manual
// marks (quiet rooms) are confirmed on creation.

export interface AddReactionInput {
  projectId: string;
  sourceId?: string | null;
  kind: Reaction["kind"];
  startMs: number;
  endMs: number;
  clipPath?: string | null;
  acoustic?: unknown;
  semantic?: string;
  origin?: Reaction["origin"];
  status?: Reaction["status"];
  charAnchor?: number | null;
}

export function addReaction(db: Db, input: AddReactionInput): Reaction {
  const id = newId();
  const status = input.status ?? "candidate";
  db.insert(reactions)
    .values({
      id,
      projectId: input.projectId,
      sourceId: input.sourceId ?? null,
      kind: input.kind,
      startMs: Math.round(input.startMs),
      endMs: Math.round(input.endMs),
      clipPath: input.clipPath ?? null,
      acoustic: JSON.stringify(input.acoustic ?? {}),
      semantic: input.semantic ?? "",
      origin: input.origin ?? "acoustic",
      status,
      charAnchor: input.charAnchor ?? null,
      createdAt: now(),
      confirmedAt: status === "confirmed" ? now() : null,
    })
    .run();
  return getReaction(db, id)!;
}

export function getReaction(db: Db, id: string): Reaction | undefined {
  return db.select().from(reactions).where(eq(reactions.id, id)).get();
}

export function listReactions(
  db: Db,
  projectId: string,
  status?: Reaction["status"],
): Reaction[] {
  const where = status
    ? and(eq(reactions.projectId, projectId), eq(reactions.status, status))
    : eq(reactions.projectId, projectId);
  return db
    .select()
    .from(reactions)
    .where(where)
    .orderBy(asc(reactions.startMs))
    .all();
}

/** Confirmed reactions in text-position order — the set Pass B inserts. */
export function confirmedReactions(db: Db, projectId: string): Reaction[] {
  return listReactions(db, projectId, "confirmed").sort(
    (a, b) => (a.charAnchor ?? 0) - (b.charAnchor ?? 0) || a.startMs - b.startMs,
  );
}

export function setReactionStatus(
  db: Db,
  id: string,
  status: Reaction["status"],
): void {
  db.update(reactions)
    .set({ status, confirmedAt: status === "confirmed" ? now() : null })
    .where(eq(reactions.id, id))
    .run();
}

export function setReactionAnchor(db: Db, id: string, charAnchor: number): void {
  db.update(reactions)
    .set({ charAnchor })
    .where(eq(reactions.id, id))
    .run();
}
