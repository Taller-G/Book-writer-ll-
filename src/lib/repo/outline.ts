import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { outlines, type Outline } from "../db/schema";
import {
  EMPTY_OUTLINE,
  type OutlineChapter,
  type OutlineData,
} from "../master/chapters";
import { now } from "../util";
import { appendChange } from "./changeLog";

// The proposed/confirmed book structure for the master-text stage. Chapters
// live inside the data JSON so the outline editor's reorder/rename/merge all
// land as one atomic row update; every user edit is change-logged.

export {
  EMPTY_OUTLINE,
  mergeChapters,
  type OutlineChapter,
  type OutlineData,
} from "../master/chapters";

export function getOutline(db: Db, projectId: string): Outline | undefined {
  return db.select().from(outlines).where(eq(outlines.projectId, projectId)).get();
}

export function parseOutlineData(outline: Outline | undefined): OutlineData {
  if (!outline) return EMPTY_OUTLINE;
  try {
    const raw = JSON.parse(outline.data) as Partial<OutlineData>;
    return {
      chapters: Array.isArray(raw.chapters) ? raw.chapters : [],
      leitmotifs: Array.isArray(raw.leitmotifs) ? raw.leitmotifs : [],
      analysisNotes: typeof raw.analysisNotes === "string" ? raw.analysisNotes : "",
    };
  } catch {
    return EMPTY_OUTLINE;
  }
}

/** Replace the outline with a fresh AI proposal (back to 'proposed'). */
export function saveProposedOutline(
  db: Db,
  projectId: string,
  data: OutlineData,
  jobId?: string,
): void {
  const ts = now();
  const existing = getOutline(db, projectId);
  if (existing) {
    db.update(outlines)
      .set({ status: "proposed", data: JSON.stringify(data), jobId, updatedAt: ts })
      .where(eq(outlines.projectId, projectId))
      .run();
  } else {
    db.insert(outlines)
      .values({
        projectId,
        status: "proposed",
        data: JSON.stringify(data),
        jobId,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  }
}

/**
 * Persist a user edit of the outline (reorder/rename/merge, done in the
 * editor). `editSummary` says what the user did, for the change log.
 * Editing re-opens a confirmed outline back to 'proposed'.
 */
export function saveOutlineEdit(
  db: Db,
  projectId: string,
  chapters: OutlineChapter[],
  editSummary: string,
): void {
  const existing = getOutline(db, projectId);
  if (!existing) throw new Error("No outline to edit — propose one first.");
  const data = parseOutlineData(existing);
  db.update(outlines)
    .set({
      status: "proposed",
      data: JSON.stringify({ ...data, chapters }),
      updatedAt: now(),
    })
    .where(eq(outlines.projectId, projectId))
    .run();
  appendChange(db, {
    projectId,
    what: editSummary,
    where: "stage 5 · outline",
    why: "user reshaped the proposed table of contents",
    authorizedBy: "user",
  });
}

/** Lock the outline so master-text generation can run against it. */
export function confirmOutline(db: Db, projectId: string): void {
  const existing = getOutline(db, projectId);
  if (!existing) throw new Error("No outline to confirm — propose one first.");
  db.update(outlines)
    .set({ status: "confirmed", updatedAt: now() })
    .where(eq(outlines.projectId, projectId))
    .run();
  const data = parseOutlineData(existing);
  appendChange(db, {
    projectId,
    what: `Outline confirmed with ${data.chapters.length} chapter(s)`,
    where: "stage 5 · outline",
    why: "user approved the book structure for master-text generation",
    authorizedBy: "user",
  });
}

