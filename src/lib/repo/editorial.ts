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

/**
 * The profile injected into AI calls: only a profile the user has confirmed
 * shapes generated text — a fresh draft shapes nothing until confirmed.
 */
export function getConfirmedStyleProfile(
  db: Db,
  projectId: string,
): StyleProfile | undefined {
  const profile = getStyleProfile(db, projectId);
  return profile?.status === "confirmed" ? profile : undefined;
}

/** The editable, plain-language part of the profile. */
export interface StyleProfileFields {
  tone: string;
  register: string;
  person: string;
  notes: string;
  voice: string;
  rhythm: string;
  punctuation: string;
  metaphors: string;
  openings: string;
  /** 3-5 verbatim few-shot excerpts from the reference material. */
  excerpts: string[];
}

/**
 * Store a freshly extracted profile as a DRAFT for the user to confirm or
 * adjust. The version is NOT bumped (that happens on confirm) and any earlier
 * sample passage is cleared — it was generated with the previous profile.
 */
export function saveDraftProfile(
  db: Db,
  projectId: string,
  fields: StyleProfileFields,
): void {
  const existing = getStyleProfile(db, projectId);
  const ts = now();
  const values = {
    ...fields,
    excerpts: JSON.stringify(fields.excerpts),
    status: "draft" as const,
    sample: "",
    updatedAt: ts,
  };
  if (existing) {
    db.update(styleProfiles)
      .set(values)
      .where(eq(styleProfiles.projectId, projectId))
      .run();
  } else {
    db.insert(styleProfiles)
      .values({ projectId, data: "{}", ...values })
      .run();
  }
}

/**
 * Confirm the profile the user reviewed. The first confirmation is version 1;
 * confirming again after an earlier confirmation bumps the version, which is
 * what marks downstream texts as written under an older profile.
 */
export function confirmStyleProfile(
  db: Db,
  projectId: string,
  fields: StyleProfileFields,
): StyleProfile {
  const existing = getStyleProfile(db, projectId);
  const ts = now();
  const version = existing
    ? existing.confirmedAt
      ? existing.version + 1
      : existing.version
    : 1;
  const values = {
    ...fields,
    excerpts: JSON.stringify(fields.excerpts),
    status: "confirmed" as const,
    version,
    confirmedAt: ts,
    updatedAt: ts,
  };
  if (existing) {
    db.update(styleProfiles)
      .set(values)
      .where(eq(styleProfiles.projectId, projectId))
      .run();
  } else {
    db.insert(styleProfiles)
      .values({ projectId, data: "{}", ...values })
      .run();
  }
  appendChange(db, {
    projectId,
    what: `Style profile v${version} confirmed (${fields.excerpts.length} excerpt(s))`,
    where: "style profile",
    why: existing?.confirmedAt
      ? "user changed the style profile mid-project"
      : "user confirmed the style profile",
    authorizedBy: "user",
  });
  return getStyleProfile(db, projectId)!;
}

/** Parse the profile's excerpts column; tolerates nothing — bad JSON is []. */
export function parseExcerpts(profile: StyleProfile): string[] {
  try {
    const arr = JSON.parse(profile.excerpts);
    return Array.isArray(arr) ? arr.filter((e) => typeof e === "string") : [];
  } catch {
    return [];
  }
}

/** Store the sample passage generated with the current (draft) profile. */
export function saveSamplePassage(
  db: Db,
  projectId: string,
  sample: string,
): void {
  db.update(styleProfiles)
    .set({ sample, updatedAt: now() })
    .where(eq(styleProfiles.projectId, projectId))
    .run();
}
