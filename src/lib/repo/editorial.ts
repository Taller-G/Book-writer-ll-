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

// --- Style sample (master-text stage) ---------------------------------------
// A short AI-written sample the user pre-approves before full generation, and
// later validates the generated master text against. Stored in the style
// profile's data JSON so the profile row stays the single source of voice.

export interface StyleSample {
  text: string;
  createdAt: string;
  /** Set when the user approves the sample as the voice benchmark. */
  approvedAt?: string;
  /** Set when the user validates the generated master text against it. */
  validatedAt?: string;
}

function parseProfileData(profile: StyleProfile): Record<string, unknown> {
  try {
    const parsed = JSON.parse(profile.data);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function getStyleSample(db: Db, projectId: string): StyleSample | undefined {
  const profile = getStyleProfile(db, projectId);
  if (!profile) return undefined;
  const sample = parseProfileData(profile).sample as StyleSample | undefined;
  return sample && typeof sample.text === "string" ? sample : undefined;
}

function writeStyleSample(db: Db, projectId: string, sample: StyleSample): void {
  const profile = getStyleProfile(db, projectId);
  if (!profile) throw new Error("No style profile — save it in stage 3 first.");
  const data = { ...parseProfileData(profile), sample };
  db.update(styleProfiles)
    .set({ data: JSON.stringify(data), updatedAt: now() })
    .where(eq(styleProfiles.projectId, projectId))
    .run();
}

/** Store a freshly generated sample; any previous approval is reset. */
export function saveStyleSample(db: Db, projectId: string, text: string): void {
  writeStyleSample(db, projectId, { text, createdAt: now() });
}

export function approveStyleSample(db: Db, projectId: string): void {
  const sample = getStyleSample(db, projectId);
  if (!sample) throw new Error("No style sample to approve — generate one first.");
  writeStyleSample(db, projectId, { ...sample, approvedAt: now() });
  appendChange(db, {
    projectId,
    what: "Style sample approved as the voice benchmark",
    where: "stage 5 · style sample",
    why: "user confirmed the sample matches the intended voice",
    authorizedBy: "user",
  });
}

/** Record that the user validated the generated text against the sample. */
export function validateAgainstSample(db: Db, projectId: string): void {
  const sample = getStyleSample(db, projectId);
  if (!sample?.approvedAt) {
    throw new Error("There is no approved sample to validate against.");
  }
  writeStyleSample(db, projectId, { ...sample, validatedAt: now() });
  appendChange(db, {
    projectId,
    what: "Generated master text validated against the approved style sample",
    where: "stage 5 · style sample",
    why: "user compared the result with the pre-approved sample and accepted the voice",
    authorizedBy: "user",
  });
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
