import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { editorialLocks, type EditorialLock } from "../db/schema";
import { now } from "../util";
import { appendChange } from "./changeLog";

// The FINAL lock (spec §4 stage 3.6). Enforced as per-project editorial state:
// once the text is declared FINAL it is locked, and no text-producing pass may
// run again until the user explicitly unlocks it. Every lock, unlock and
// post-closure touch-up is written to the append-only change log.

export function getLock(db: Db, projectId: string): EditorialLock | undefined {
  return db
    .select()
    .from(editorialLocks)
    .where(eq(editorialLocks.projectId, projectId))
    .get();
}

export function isLocked(db: Db, projectId: string): boolean {
  return getLock(db, projectId)?.locked === 1;
}

function upsert(db: Db, projectId: string, patch: Partial<EditorialLock>): void {
  const existing = getLock(db, projectId);
  const ts = now();
  if (existing) {
    db.update(editorialLocks)
      .set({ ...patch, updatedAt: ts })
      .where(eq(editorialLocks.projectId, projectId))
      .run();
  } else {
    db.insert(editorialLocks)
      .values({ projectId, locked: 0, updatedAt: ts, ...patch })
      .run();
  }
}

/** Declare the text FINAL and locked. Called by finalize once verification
 *  passes. The change-log entry is written by the finalize executor itself. */
export function lockText(db: Db, projectId: string, version: number): void {
  upsert(db, projectId, {
    locked: 1,
    lockedVersion: version,
    lockedAt: now(),
  });
}

/**
 * Explicit user action to reopen a FINAL text. Refuses when it is not locked
 * (nothing to unlock) and records the reopening in the audit log.
 */
export function unlockText(db: Db, projectId: string, reason: string): void {
  const lock = getLock(db, projectId);
  if (!lock || lock.locked !== 1) {
    throw new Error("The text is not locked — there is nothing to unlock.");
  }
  upsert(db, projectId, { locked: 0, unlockedAt: now() });
  appendChange(db, {
    projectId,
    what: `FINAL text v${lock.lockedVersion ?? "?"} unlocked for editing`,
    where: "stage 6 · final text",
    why: reason || "user explicitly reopened the closed text",
    authorizedBy: "user",
  });
}

/** Guard for any post-closure write path: throws while the text is locked. */
export function assertUnlocked(db: Db, projectId: string): void {
  if (isLocked(db, projectId)) {
    throw new Error(
      "The text is FINAL and locked. Unlock it explicitly before editing — " +
        "every post-closure change is logged.",
    );
  }
}
