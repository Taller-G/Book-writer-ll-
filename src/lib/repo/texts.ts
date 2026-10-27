import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { stageTexts, type StageText } from "../db/schema";
import type { StageTextKey } from "../stages";
import { newId, now } from "../util";
import { getConfirmedStyleProfile } from "./editorial";

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
  // Every text is stamped with the confirmed style profile version in force
  // when it was produced, so a later profile change can list exactly which
  // texts were written under the previous voice.
  const profile = getConfirmedStyleProfile(db, input.projectId);
  db.insert(stageTexts)
    .values({
      ...input,
      id,
      createdAt: now(),
      styleProfileVersion: profile?.version ?? null,
    })
    .run();
  return db.select().from(stageTexts).where(eq(stageTexts.id, id)).get()!;
}

/**
 * Latest text per generated stage (passA/passB/final — raw is a mechanical
 * source compilation with no voice) written under a profile version other
 * than the current one. These are the texts offered for regenerate/keep
 * after a mid-project profile change.
 */
export function textsUnderOldProfile(
  db: Db,
  projectId: string,
  currentProfileVersion: number,
): StageText[] {
  const keys: StageTextKey[] = ["passA", "passB", "final"];
  const stale: StageText[] = [];
  for (const key of keys) {
    const text = latestText(db, projectId, key);
    if (text && text.styleProfileVersion !== currentProfileVersion) {
      stale.push(text);
    }
  }
  return stale;
}

/**
 * Edit the content of an existing text in place. Used when a review resolution
 * is applied to the working text — the change itself is recorded in the
 * append-only change log, so the edit is auditable even though the row mutates.
 */
export function updateTextContent(db: Db, textId: string, content: string): void {
  db.update(stageTexts).set({ content }).where(eq(stageTexts.id, textId)).run();
}

/** The user chose to keep a text written under an older profile. */
export function stampTextProfileVersion(
  db: Db,
  textId: string,
  version: number,
): void {
  db.update(stageTexts)
    .set({ styleProfileVersion: version })
    .where(eq(stageTexts.id, textId))
    .run();
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
