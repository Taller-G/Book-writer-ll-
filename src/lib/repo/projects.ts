import { and, desc, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import type { Db } from "../db/client";
import {
  changeLog,
  checklistItems,
  projects,
  stageProgress,
  type Project,
  type StageProgressRow,
} from "../db/schema";
import { STAGES, STAGE_COUNT, type StageStatus } from "../stages";
import { newId, now } from "../util";
import { appendChange } from "./changeLog";

const DEFAULT_CHECKLIST = [
  "Title page and copyright page reviewed",
  "Front matter (dedication, prologue) in place",
  "Full read-through of the FINAL text done",
  "Page numbers and headers verified",
  "Cover resolution checked for print",
  "ISBN / legal data verified",
];

export function createProject(
  handle: DbHandle,
  input: { title: string; author?: string },
): Project {
  const { db, sqlite } = handle;
  const id = newId();
  const ts = now();
  sqlite.transaction(() => {
    db.insert(projects)
      .values({
        id,
        title: input.title,
        author: input.author ?? "",
        currentStage: 1,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    for (const stage of STAGES) {
      db.insert(stageProgress)
        .values({
          projectId: id,
          stage: stage.num,
          status: stage.num === 1 ? "in_progress" : "not_started",
          updatedAt: ts,
        })
        .run();
    }
    DEFAULT_CHECKLIST.forEach((label, i) => {
      db.insert(checklistItems)
        .values({ id: newId(), projectId: id, label, position: i, createdAt: ts })
        .run();
    });
    appendChange(db, {
      projectId: id,
      what: `Project "${input.title}" created`,
      where: "project",
      why: "new book project started",
      authorizedBy: "user",
    });
  })();
  return getProject(db, id)!;
}

export function listProjects(db: Db): Project[] {
  return db.select().from(projects).orderBy(desc(projects.updatedAt)).all();
}

export function getProject(db: Db, id: string): Project | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export function touchProject(db: Db, id: string): void {
  db.update(projects)
    .set({ updatedAt: now() })
    .where(eq(projects.id, id))
    .run();
}

/**
 * Deletes a project and all its data. The change_log delete trigger only
 * permits purging entries whose project row is already gone, so the project
 * row goes first; every other table cascades via foreign keys.
 */
export function deleteProject(handle: DbHandle, id: string): void {
  const { db, sqlite } = handle;
  sqlite.transaction(() => {
    db.delete(projects).where(eq(projects.id, id)).run();
    db.delete(changeLog).where(eq(changeLog.projectId, id)).run();
  })();
}

export interface StageState {
  num: number;
  slug: string;
  title: string;
  short: string;
  status: StageStatus;
}

/**
 * Per-stage status for the wizard. A stage is "locked" when any earlier
 * stage is not done — back-navigation is always allowed, skipping ahead is
 * not.
 */
export function getStageStates(db: Db, projectId: string): StageState[] {
  const rows: StageProgressRow[] = db
    .select()
    .from(stageProgress)
    .where(eq(stageProgress.projectId, projectId))
    .all();
  const byStage = new Map(rows.map((r) => [r.stage, r.status]));
  let frontierPassed = false;
  return STAGES.map((s) => {
    const stored = byStage.get(s.num) ?? "not_started";
    let status: StageStatus;
    if (frontierPassed) {
      status = "locked";
    } else {
      status = stored;
      if (stored !== "done") frontierPassed = true;
    }
    return { num: s.num, slug: s.slug, title: s.title, short: s.short, status };
  });
}

export function setStageStatus(
  db: Db,
  projectId: string,
  stage: number,
  status: "not_started" | "in_progress" | "done",
): void {
  db.update(stageProgress)
    .set({ status, updatedAt: now() })
    .where(
      and(eq(stageProgress.projectId, projectId), eq(stageProgress.stage, stage)),
    )
    .run();
}

/** Marks a stage done and moves the project pointer to the next stage. */
export function completeStage(
  handle: DbHandle,
  projectId: string,
  stage: number,
): void {
  const { db, sqlite } = handle;
  const stageDef = STAGES.find((s) => s.num === stage);
  sqlite.transaction(() => {
    setStageStatus(db, projectId, stage, "done");
    const next = Math.min(stage + 1, STAGE_COUNT);
    if (next !== stage) {
      const nextRow = db
        .select()
        .from(stageProgress)
        .where(
          and(
            eq(stageProgress.projectId, projectId),
            eq(stageProgress.stage, next),
          ),
        )
        .get();
      if (nextRow && nextRow.status === "not_started") {
        setStageStatus(db, projectId, next, "in_progress");
      }
    }
    db.update(projects)
      .set({ currentStage: next, updatedAt: now() })
      .where(eq(projects.id, projectId))
      .run();
    appendChange(db, {
      projectId,
      what: `Stage ${stage} (${stageDef?.title ?? "?"}) marked complete`,
      where: `stage ${stage}`,
      why: "user confirmed the stage's work is done",
      authorizedBy: "user",
    });
  })();
}

/** Reopens a completed stage (going back to rework it). */
export function reopenStage(
  handle: DbHandle,
  projectId: string,
  stage: number,
): void {
  const { db, sqlite } = handle;
  sqlite.transaction(() => {
    setStageStatus(db, projectId, stage, "in_progress");
    db.update(projects)
      .set({ currentStage: stage, updatedAt: now() })
      .where(eq(projects.id, projectId))
      .run();
    appendChange(db, {
      projectId,
      what: `Stage ${stage} reopened`,
      where: `stage ${stage}`,
      why: "user went back to rework this stage",
      authorizedBy: "user",
    });
  })();
}
