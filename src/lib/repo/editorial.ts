import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  editorialContracts,
  styleProfiles,
  type EditorialContract,
  type StyleProfile,
} from "../db/schema";
import { now } from "../util";
import { appendChange } from "./changeLog";

export function getContract(
  db: Db,
  projectId: string,
): EditorialContract | undefined {
  return db
    .select()
    .from(editorialContracts)
    .where(eq(editorialContracts.projectId, projectId))
    .get();
}

export function saveContract(
  db: Db,
  input: {
    projectId: string;
    mode: EditorialContract["mode"];
    rules: string;
    notes: string;
  },
): void {
  const existing = getContract(db, input.projectId);
  const ts = now();
  if (existing) {
    db.update(editorialContracts)
      .set({ mode: input.mode, rules: input.rules, notes: input.notes, signedAt: ts })
      .where(eq(editorialContracts.projectId, input.projectId))
      .run();
  } else {
    db.insert(editorialContracts)
      .values({ ...input, signedAt: ts })
      .run();
  }
  appendChange(db, {
    projectId: input.projectId,
    what: `Editorial contract set to "${input.mode}" mode`,
    where: "editorial contract",
    why: existing
      ? "user revised the editorial contract"
      : "user signed the initial editorial contract",
    authorizedBy: "user",
  });
}

export function getStyleProfile(
  db: Db,
  projectId: string,
): StyleProfile | undefined {
  return db
    .select()
    .from(styleProfiles)
    .where(eq(styleProfiles.projectId, projectId))
    .get();
}

export function saveStyleProfile(
  db: Db,
  input: {
    projectId: string;
    tone: string;
    register: string;
    person: string;
    notes: string;
  },
): void {
  const existing = getStyleProfile(db, input.projectId);
  const ts = now();
  if (existing) {
    db.update(styleProfiles)
      .set({ ...input, updatedAt: ts })
      .where(eq(styleProfiles.projectId, input.projectId))
      .run();
  } else {
    db.insert(styleProfiles)
      .values({ ...input, data: "{}", updatedAt: ts })
      .run();
  }
}
