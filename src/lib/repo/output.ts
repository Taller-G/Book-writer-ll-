import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  checklistItems,
  covers,
  formatConfigs,
  pdfVersions,
  type ChecklistItem,
  type Cover,
  type FormatConfig,
  type PdfVersion,
} from "../db/schema";
import { newId, now } from "../util";

const DEFAULT_MARGINS =
  '{"top":"20mm","bottom":"20mm","inner":"22mm","outer":"16mm"}';

export function getFormatConfig(db: Db, projectId: string): FormatConfig {
  const existing = db
    .select()
    .from(formatConfigs)
    .where(eq(formatConfigs.projectId, projectId))
    .get();
  if (existing) return existing;
  db.insert(formatConfigs)
    .values({ projectId, margins: DEFAULT_MARGINS, updatedAt: now() })
    .run();
  return db
    .select()
    .from(formatConfigs)
    .where(eq(formatConfigs.projectId, projectId))
    .get()!;
}

export function saveFormatConfig(
  db: Db,
  input: {
    projectId: string;
    trimSize: string;
    fontFamily: string;
    fontSizePt: number;
    lineHeight: number;
    margins: string;
  },
): void {
  getFormatConfig(db, input.projectId);
  db.update(formatConfigs)
    .set({ ...input, updatedAt: now() })
    .where(eq(formatConfigs.projectId, input.projectId))
    .run();
}

export function listPdfVersions(db: Db, projectId: string): PdfVersion[] {
  return db
    .select()
    .from(pdfVersions)
    .where(eq(pdfVersions.projectId, projectId))
    .orderBy(desc(pdfVersions.version))
    .all();
}

export function nextPdfVersion(db: Db, projectId: string): number {
  return (listPdfVersions(db, projectId)[0]?.version ?? 0) + 1;
}

export function insertPdfVersion(
  db: Db,
  input: {
    projectId: string;
    version: number;
    filePath: string;
    notes?: string;
    jobId?: string;
  },
): PdfVersion {
  const id = newId();
  db.insert(pdfVersions)
    .values({ ...input, id, notes: input.notes ?? "", createdAt: now() })
    .run();
  return db.select().from(pdfVersions).where(eq(pdfVersions.id, id)).get()!;
}

export function listCovers(db: Db, projectId: string): Cover[] {
  return db
    .select()
    .from(covers)
    .where(eq(covers.projectId, projectId))
    .orderBy(desc(covers.createdAt))
    .all();
}

export function addCover(
  db: Db,
  input: { projectId: string; title: string; description: string },
): void {
  db.insert(covers)
    .values({ ...input, id: newId(), createdAt: now() })
    .run();
}

export function selectCover(db: Db, projectId: string, coverId: string): void {
  db.update(covers)
    .set({ selected: 0 })
    .where(eq(covers.projectId, projectId))
    .run();
  db.update(covers).set({ selected: 1 }).where(eq(covers.id, coverId)).run();
}

export function listChecklist(db: Db, projectId: string): ChecklistItem[] {
  return db
    .select()
    .from(checklistItems)
    .where(eq(checklistItems.projectId, projectId))
    .orderBy(asc(checklistItems.position))
    .all();
}

export function setChecklistDone(db: Db, id: string, done: boolean): void {
  db.update(checklistItems)
    .set({ done: done ? 1 : 0 })
    .where(eq(checklistItems.id, id))
    .run();
}
