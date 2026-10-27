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
