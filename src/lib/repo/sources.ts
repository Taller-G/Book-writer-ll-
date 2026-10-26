import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sources, type Source } from "../db/schema";
import { newId, now } from "../util";

export function addSource(
  db: Db,
  input: {
    projectId: string;
    kind: Source["kind"];
    title: string;
    content: string;
  },
): Source {
  const id = newId();
  db.insert(sources)
    .values({ ...input, id, createdAt: now() })
    .run();
  return db.select().from(sources).where(eq(sources.id, id)).get()!;
}

export function listSources(db: Db, projectId: string): Source[] {
  return db
    .select()
    .from(sources)
    .where(eq(sources.projectId, projectId))
    .orderBy(desc(sources.createdAt))
    .all();
}

export function removeSource(db: Db, id: string): void {
  db.delete(sources).where(eq(sources.id, id)).run();
}
