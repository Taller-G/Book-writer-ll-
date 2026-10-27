import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  checklistItems,
  covers,
  formatConfigs,
  jobs,
  pdfVersions,
  type ChecklistItem,
  type Cover,
  type FormatConfig,
  type PdfVersion,
} from "../db/schema";
import {
  legacyFields,
  PROVEN_DEFAULTS,
  serializeFormatData,
  type FormatConfigData,
} from "../format/config";
import { newId, now } from "../util";

/**
 * A missing row is seeded with the §7 proven defaults, so a project whose
 * user accepts everything untouched still ends with that exact configuration
 * saved. The legacy columns are derived from the same data.
 */
export function getFormatConfig(db: Db, projectId: string): FormatConfig {
  const existing = db
    .select()
    .from(formatConfigs)
    .where(eq(formatConfigs.projectId, projectId))
    .get();
  if (existing) return existing;
  db.insert(formatConfigs)
    .values({
      projectId,
      ...legacyFields(PROVEN_DEFAULTS),
      data: serializeFormatData(PROVEN_DEFAULTS),
      updatedAt: now(),
    })
    .run();
  return db
    .select()
    .from(formatConfigs)
    .where(eq(formatConfigs.projectId, projectId))
    .get()!;
}

export function saveFormatConfig(
  db: Db,
  projectId: string,
  data: FormatConfigData,
): void {
  getFormatConfig(db, projectId);
  db.update(formatConfigs)
    .set({
      ...legacyFields(data),
      data: serializeFormatData(data),
      updatedAt: now(),
    })
    .where(eq(formatConfigs.projectId, projectId))
    .run();
}

/**
 * Layout has begun once the project has produced (or attempted) an export —
 * from that point on a page-size change forces re-iterating the whole layout.
 */
export function layoutHasBegun(db: Db, projectId: string): boolean {
  if (listPdfVersions(db, projectId).length > 0) return true;
  const exportJob = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.type, "export_book")))
    .limit(1)
    .get();
  return exportJob !== undefined;
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
    textVersion?: number;
    formatHash?: string;
    qaPassed?: number;
    qaReportPath?: string;
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
