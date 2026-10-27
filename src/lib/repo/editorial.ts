import { desc, eq } from "drizzle-orm";
import {
  authorshipWarning,
  proposeLegalText,
} from "../contract/definitions";
import type { Db } from "../db/client";
import {
  contractVersions,
  editorialContracts,
  pdfVersions,
  projects,
  stageTexts,
  styleProfiles,
  type ContractVersion,
  type EditorialContract,
  type StyleProfile,
} from "../db/schema";
import { newId, now } from "../util";
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

export function listContractVersions(
  db: Db,
  projectId: string,
): ContractVersion[] {
  return db
    .select()
    .from(contractVersions)
    .where(eq(contractVersions.projectId, projectId))
    .orderBy(desc(contractVersions.version))
    .all();
}

/** A downstream artifact that was produced under the editorial contract. */
export interface DownstreamArtifact {
  label: string;
  stage: number;
  createdAt: string;
}

const TEXT_ARTIFACTS: Record<string, { label: string; stage: number }> = {
  passA: { label: "Cleanup Pass A text", stage: 4 },
  passB: { label: "Refine Pass B text", stage: 5 },
  final: { label: "FINAL text", stage: 6 },
};

/**
 * Everything the contract governs that already exists: the texts of passes
 * A/B/final and the exports. These are what a contract change invalidates.
 */
export function listDownstreamArtifacts(
  db: Db,
  projectId: string,
): DownstreamArtifact[] {
  const texts = db
    .select()
    .from(stageTexts)
    .where(eq(stageTexts.projectId, projectId))
    .all()
    .filter((t) => t.stageKey in TEXT_ARTIFACTS)
    .map((t) => ({
      label: `${TEXT_ARTIFACTS[t.stageKey].label} v${t.version}`,
      stage: TEXT_ARTIFACTS[t.stageKey].stage,
      createdAt: t.createdAt,
    }));
  const exports = db
    .select()
    .from(pdfVersions)
    .where(eq(pdfVersions.projectId, projectId))
    .all()
    .map((p) => ({
      label: `Export v${p.version}`,
      stage: 8,
      createdAt: p.createdAt,
    }));
  return [...texts, ...exports].sort((a, b) => a.stage - b.stage);
}

export interface SaveContractInput {
  projectId: string;
  mode: EditorialContract["mode"];
  tone?: EditorialContract["tone"];
  destination?: EditorialContract["destination"];
  authorship?: EditorialContract["authorship"];
  rightsNotes?: string;
  legalText?: string;
  rules: string;
  notes: string;
}

export interface SaveContractResult {
  contract: EditorialContract;
  /** Decision fields that actually changed in this save. */
  changed: string[];
  /** Artifacts that already existed when a signed contract was changed. */
  affected: DownstreamArtifact[];
}

/**
 * Sign or revise the editorial contract. Every save that changes a decision
 * bumps the version and snapshots it into contract_versions; a revision made
 * after downstream artifacts exist names them in the change log so the
 * warning is on the record, not just on screen.
 */
export function saveContract(
  db: Db,
  input: SaveContractInput,
): SaveContractResult {
  const existing = getContract(db, input.projectId);
  const ts = now();

  const next = {
    mode: input.mode,
    tone: input.tone ?? existing?.tone ?? null,
    destination: input.destination ?? existing?.destination ?? null,
    authorship: input.authorship ?? existing?.authorship ?? null,
    rightsNotes: input.rightsNotes ?? existing?.rightsNotes ?? "",
    legalText: input.legalText ?? existing?.legalText ?? "",
    rules: input.rules,
    notes: input.notes,
  };

  // Declaring third-party material must produce a legal-text proposal: fill
  // the slot when the user has not written their own yet.
  if (next.authorship && !next.legalText.trim()) {
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .get();
    next.legalText = proposeLegalText({
      authorship: next.authorship,
      destination: next.destination,
      author: project?.author,
    });
  }

  const changed = existing
    ? (Object.keys(next) as (keyof typeof next)[]).filter(
        (k) => (existing[k] ?? null) !== (next[k] ?? null),
      )
    : (Object.keys(next) as (keyof typeof next)[]);
  if (existing && changed.length === 0) {
    return { contract: existing, changed: [], affected: [] };
  }

  const version = existing ? existing.version + 1 : 1;
  if (existing) {
    db.update(editorialContracts)
      .set({ ...next, version, signedAt: ts })
      .where(eq(editorialContracts.projectId, input.projectId))
      .run();
  } else {
    db.insert(editorialContracts)
      .values({ projectId: input.projectId, ...next, version, signedAt: ts })
      .run();
  }
  const contract = getContract(db, input.projectId)!;
  db.insert(contractVersions)
    .values({
      id: newId(),
      projectId: input.projectId,
      version,
      snapshot: JSON.stringify(contract),
      createdAt: ts,
    })
    .run();

  appendChange(db, {
    projectId: input.projectId,
    what: existing
      ? `Editorial contract revised to v${version} (changed: ${changed.join(", ")})`
      : `Editorial contract v1 signed ("${input.mode}" mode)`,
    where: "stage 2 · editorial contract",
    why: existing
      ? "user revised the editorial contract"
      : "user signed the initial editorial contract",
    authorizedBy: "user",
  });

  // The mid-project warning, on the record: name every artifact produced
  // under the previous version.
  const affected = existing ? listDownstreamArtifacts(db, input.projectId) : [];
  if (affected.length > 0) {
    appendChange(db, {
      projectId: input.projectId,
      what:
        `Contract change to v${version} affects ${affected.length} existing ` +
        `artifact(s): ${affected.map((a) => a.label).join(", ")}`,
      where: "stage 2 · editorial contract",
      why: `these artifacts were produced under contract v${existing!.version} and may need re-running`,
      authorizedBy: "user",
    });
  }

  return { contract, changed, affected };
}

/** Re-export for callers that render the third-party warning. */
export { authorshipWarning };

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

// --- Style sample (master-text stage 5) --------------------------------------
// A short AI-written sample the user pre-approves before full generation, and
// later validates the generated master text against. Distinct from the stage-3
// `sample` column (the draft-profile preview): this one benchmarks the voice
// on the cleaned text and gates master-text generation. Stored in the style
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
