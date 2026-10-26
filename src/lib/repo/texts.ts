import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { stageTexts, type StageText } from "../db/schema";
import type { StageTextKey } from "../stages";
import { newId, now } from "../util";

export function latestText(
  db: Db,
  projectId: string,
  stageKey: StageTextKey,
): StageText | undefined {
  return db
    .select()
    .from(stageTexts)
    .where(
      and(eq(stageTexts.projectId, projectId), eq(stageTexts.stageKey, stageKey)),
    )
    .orderBy(desc(stageTexts.version))
    .limit(1)
    .get();
}

export function nextTextVersion(
  db: Db,
  projectId: string,
  stageKey: StageTextKey,
): number {
  return (latestText(db, projectId, stageKey)?.version ?? 0) + 1;
}

export function insertText(
  db: Db,
  input: {
    projectId: string;
    stageKey: StageTextKey;
    version: number;
    content: string;
    jobId?: string;
  },
): StageText {
  const id = newId();
  db.insert(stageTexts)
    .values({ ...input, id, createdAt: now() })
    .run();
  return db.select().from(stageTexts).where(eq(stageTexts.id, id)).get()!;
}

export function listTextVersions(
  db: Db,
  projectId: string,
): Pick<StageText, "id" | "stageKey" | "version" | "createdAt">[] {
  return db
    .select({
      id: stageTexts.id,
      stageKey: stageTexts.stageKey,
      version: stageTexts.version,
      createdAt: stageTexts.createdAt,
    })
    .from(stageTexts)
    .where(eq(stageTexts.projectId, projectId))
    .orderBy(desc(stageTexts.createdAt))
    .all();
}
