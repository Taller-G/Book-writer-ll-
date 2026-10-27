import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { changeLog, type ChangeLogEntry } from "../db/schema";
import { now } from "../util";

// The ONLY write path is append. Updates/deletes are blocked by database
// triggers (see bootstrap.ts), so even code that bypasses this module cannot
// mutate history.

export interface ChangeLogAppend {
  projectId: string;
  what: string;
  where: string;
  why: string;
  authorizedBy: string;
  /** Optional structured classification (e.g. a Pass A correction type). */
  category?: string;
}

export function appendChange(db: Db, entry: ChangeLogAppend): void {
  db.insert(changeLog)
    .values({ category: null, ...entry, createdAt: now() })
    .run();
}

export function listChanges(
  db: Db,
  projectId: string,
  limit = 200,
): ChangeLogEntry[] {
  return db
    .select()
    .from(changeLog)
    .where(eq(changeLog.projectId, projectId))
    .orderBy(desc(changeLog.id))
    .limit(limit)
    .all();
}

export function countChanges(db: Db, projectId: string): number {
  return listChanges(db, projectId, 100000).length;
}
