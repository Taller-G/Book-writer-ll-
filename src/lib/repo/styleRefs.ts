import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { styleRefs, type StyleRef } from "../db/schema";
import { newId, now } from "../util";

// Reference files attached for style extraction. Only the extracted text is
// kept: the refs are inputs to the profile, not book material.

export function addStyleRef(
  db: Db,
  input: { projectId: string; name: string; content: string; wordCount: number },
): StyleRef {
  const id = newId();
  db.insert(styleRefs)
    .values({ ...input, id, createdAt: now() })
    .run();
  return db.select().from(styleRefs).where(eq(styleRefs.id, id)).get()!;
}

export function listStyleRefs(db: Db, projectId: string): StyleRef[] {
  return db
    .select()
    .from(styleRefs)
    .where(eq(styleRefs.projectId, projectId))
    .orderBy(desc(styleRefs.createdAt))
    .all();
}

export function removeStyleRef(db: Db, id: string): void {
  db.delete(styleRefs).where(eq(styleRefs.id, id)).run();
}
