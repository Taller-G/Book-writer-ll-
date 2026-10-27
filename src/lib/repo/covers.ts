import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  backCoverSections,
  coverConcepts,
  coverIterations,
  coverSpine,
  titleOptions,
  type BackCoverSection,
  type CoverConcept,
  type CoverIteration,
  type CoverSpine,
  type TitleOption,
} from "../db/schema";
import { DEFAULT_PAPER_STOCK } from "../cover/spine";
import { newId, now } from "../util";
import { appendChange } from "./changeLog";

// Stage 7 cover repo. Concepts, guided back-cover content, title options, the
// spine configuration and the iteration thread. Every function takes an
// injectable `db`; user decisions land in the change log.

/* ------------------------------------------------------------------ */
/* Catalogs (the plain-language "what this is for", shown with every   */
/* proposal — the text comes from here, never from the model).         */
/* ------------------------------------------------------------------ */

export interface ApproachEntry {
  key: string;
  label: string;
  /** What this kind of cover is, in plain language. */
  explanation: string;
}

/** The cover approaches the AI proposes from (spec §4 Stage 7). */
export const APPROACH_CATALOG: ApproachEntry[] = [
  {
    key: "minimalist",
    label: "Minimalist typographic",
    explanation:
      "No image — the title, set large in a confident typeface on a plain " +
      "ground, does all the work. Reads as literary and timeless; the " +
      "cheapest to print well and the hardest to get wrong.",
  },
  {
    key: "image",
    label: "With an image",
    explanation:
      "A single evocative photograph or illustration carries the mood, with " +
      "the title laid over or beneath it. Sells the feeling of the book at a " +
      "glance; depends entirely on the image being strong and well-licensed.",
  },
  {
    key: "author_photo",
    label: "With the author's photo",
    explanation:
      "The author's face on the cover. Right for memoir and for a known " +
      "voice, where the person is the draw; the photograph must be high " +
      "resolution and well lit.",
  },
];

export function approachEntry(key: string): ApproachEntry | undefined {
  return APPROACH_CATALOG.find((a) => a.key === key);
}

export interface BackCoverGuideEntry {
  key: "blurb" | "quote" | "bio";
  label: string;
  explanation: string;
}

/** What a professional back cover carries, and why (spec §4 Stage 7). */
export const BACK_COVER_GUIDE: BackCoverGuideEntry[] = [
  {
    key: "blurb",
    label: "Blurb (two paragraphs)",
    explanation:
      "The promise of the reading experience — not a summary. Two short " +
      "paragraphs: the first draws the reader in with the book's world or " +
      "question, the second hints at the stakes without giving the ending. " +
      "It is the single most-read text on the whole book.",
  },
  {
    key: "quote",
    label: "Highlighted quote",
    explanation:
      "One short, striking line lifted verbatim from the book itself, set " +
      "apart in larger type. It lets the reader hear the author's actual " +
      "voice before buying — so it must be real text, never invented.",
  },
  {
    key: "bio",
    label: "Author bio",
    explanation:
      "A few sentences on who the author is and why they are the person to " +
      "tell this story. Builds trust; kept short and in the third person.",
  },
];

export function backCoverGuideEntry(
  key: string,
): BackCoverGuideEntry | undefined {
  return BACK_COVER_GUIDE.find((g) => g.key === key);
}

/* ------------------------------------------------------------------ */
/* Cover concepts                                                      */
/* ------------------------------------------------------------------ */

export function listConcepts(db: Db, projectId: string): CoverConcept[] {
  return db
    .select()
    .from(coverConcepts)
    .where(eq(coverConcepts.projectId, projectId))
    .orderBy(asc(coverConcepts.position), asc(coverConcepts.createdAt))
    .all();
}

export function getConcept(db: Db, id: string): CoverConcept | undefined {
  return db.select().from(coverConcepts).where(eq(coverConcepts.id, id)).get();
}

export interface ConceptDraft {
  approach: string;
  title: string;
  subtitle: string;
  tagline: string;
  rationale: string;
  palette: string[];
  imagery: string;
}

/**
 * Replace the still-PROPOSED AI concepts with a fresh proposal. Concepts the
 * user has already kept or discarded, and any uploaded PNGs, are left
 * untouched — re-proposing never destroys a decision or an upload.
 */
export function saveProposedConcepts(
  db: Db,
  projectId: string,
  drafts: ConceptDraft[],
  jobId?: string,
): CoverConcept[] {
  const existing = listConcepts(db, projectId);
  for (const c of existing) {
    if (c.source === "ai" && c.status === "proposed") {
      db.delete(coverConcepts).where(eq(coverConcepts.id, c.id)).run();
    }
  }
  const ts = now();
  const saved: CoverConcept[] = [];
  drafts.forEach((d, i) => {
    const entry = approachEntry(d.approach);
    const id = newId();
    db.insert(coverConcepts)
      .values({
        id,
        projectId,
        source: "ai",
        approach: d.approach,
        title: d.title,
        subtitle: d.subtitle,
        tagline: d.tagline,
        rationale: d.rationale,
        explanation: entry?.explanation ?? "",
        palette: JSON.stringify(d.palette ?? []),
        imagery: d.imagery,
        status: "proposed",
        position: i,
        jobId,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    saved.push(getConcept(db, id)!);
  });
  return saved;
}

/** Overwrite a single concept's design fields (independent regeneration). */
export function updateConceptDraft(
  db: Db,
  conceptId: string,
  draft: ConceptDraft,
  jobId?: string,
): void {
  const entry = approachEntry(draft.approach);
  db.update(coverConcepts)
    .set({
      approach: draft.approach,
      title: draft.title,
      subtitle: draft.subtitle,
      tagline: draft.tagline,
      rationale: draft.rationale,
      explanation: entry?.explanation ?? "",
      palette: JSON.stringify(draft.palette ?? []),
      imagery: draft.imagery,
      status: "proposed",
      jobId,
      updatedAt: now(),
    })
    .where(eq(coverConcepts.id, conceptId))
    .run();
}

export function insertUploadedConcept(
  db: Db,
  input: {
    projectId: string;
    title: string;
    filePath: string;
    widthPx: number;
    heightPx: number;
    note: string;
  },
): CoverConcept {
  const id = newId();
  const ts = now();
  const count = listConcepts(db, input.projectId).length;
  db.insert(coverConcepts)
    .values({
      id,
      projectId: input.projectId,
      source: "upload",
      approach: "upload",
      title: input.title,
      explanation:
        "A cover you designed yourself and uploaded as a print-ready PNG.",
      rationale: input.note,
      filePath: input.filePath,
      widthPx: input.widthPx,
      heightPx: input.heightPx,
      status: "kept",
      position: 100 + count,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  appendChange(db, {
    projectId: input.projectId,
    what: `Uploaded a cover design "${input.title}" (${input.widthPx}×${input.heightPx} px)`,
    where: "stage 7 · covers",
    why: "user provided their own cover design",
    authorizedBy: "user",
  });
  return getConcept(db, id)!;
}

export function setConceptStatus(
  db: Db,
  projectId: string,
  conceptId: string,
  status: "kept" | "discarded",
): void {
  const concept = getConcept(db, conceptId);
  if (!concept || concept.projectId !== projectId) return;
  db.update(coverConcepts)
    .set({ status, updatedAt: now() })
    .where(eq(coverConcepts.id, conceptId))
    .run();
  appendChange(db, {
    projectId,
    what: `Cover concept "${concept.title || concept.approach}" ${status}`,
    where: `stage 7 · covers · ${concept.approach}`,
    why:
      status === "kept"
        ? "user kept this concept as a candidate"
        : "user discarded this concept",
    authorizedBy: "user",
  });
}

/** Mark one concept as the selected cover; clears the flag on the rest. */
export function selectConcept(
  db: Db,
  projectId: string,
  conceptId: string,
): void {
  db.update(coverConcepts)
    .set({ selected: 0 })
    .where(eq(coverConcepts.projectId, projectId))
    .run();
  db.update(coverConcepts)
    .set({ selected: 1, status: "kept", updatedAt: now() })
    .where(eq(coverConcepts.id, conceptId))
    .run();
}

/* ------------------------------------------------------------------ */
/* Back-cover content                                                  */
/* ------------------------------------------------------------------ */

export function listBackCover(db: Db, projectId: string): BackCoverSection[] {
  return db
    .select()
    .from(backCoverSections)
    .where(eq(backCoverSections.projectId, projectId))
    .orderBy(asc(backCoverSections.position))
    .all();
}

export interface BackCoverDraft {
  sectionKey: "blurb" | "quote" | "bio";
  content: string;
  sourceExcerpt?: string;
}

/**
 * Upsert the proposed back-cover sections. A section the user already accepted
 * or discarded is left as-is; only still-proposed ones are refreshed.
 */
export function saveProposedBackCover(
  db: Db,
  projectId: string,
  drafts: BackCoverDraft[],
  jobId?: string,
): BackCoverSection[] {
  const existing = listBackCover(db, projectId);
  const ts = now();
  const saved: BackCoverSection[] = [];
  for (const d of drafts) {
    const guide = backCoverGuideEntry(d.sectionKey);
    if (!guide) continue;
    const prior = existing.find((s) => s.sectionKey === d.sectionKey);
    if (prior && prior.status !== "proposed") {
      saved.push(prior);
      continue;
    }
    const position = BACK_COVER_GUIDE.findIndex((g) => g.key === d.sectionKey);
    if (prior) {
      db.update(backCoverSections)
        .set({
          content: d.content,
          sourceExcerpt: d.sourceExcerpt ?? "",
          jobId,
          updatedAt: ts,
        })
        .where(eq(backCoverSections.id, prior.id))
        .run();
      saved.push(
        db
          .select()
          .from(backCoverSections)
          .where(eq(backCoverSections.id, prior.id))
          .get()!,
      );
    } else {
      const id = newId();
      db.insert(backCoverSections)
        .values({
          id,
          projectId,
          sectionKey: d.sectionKey,
          explanation: guide.explanation,
          content: d.content,
          sourceExcerpt: d.sourceExcerpt ?? "",
          status: "proposed",
          position,
          jobId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      saved.push(
        db
          .select()
          .from(backCoverSections)
          .where(eq(backCoverSections.id, id))
          .get()!,
      );
    }
  }
  return saved;
}

export function setBackCoverStatus(
  db: Db,
  projectId: string,
  sectionKey: string,
  status: "accepted" | "discarded",
  editedContent?: string,
): void {
  const section = db
    .select()
    .from(backCoverSections)
    .where(
      and(
        eq(backCoverSections.projectId, projectId),
        eq(backCoverSections.sectionKey, sectionKey as "blurb" | "quote" | "bio"),
      ),
    )
    .get();
  if (!section) return;
  const edited =
    status === "accepted" &&
    editedContent !== undefined &&
    editedContent !== section.content;
  db.update(backCoverSections)
    .set({
      status,
      ...(edited ? { content: editedContent } : {}),
      updatedAt: now(),
    })
    .where(eq(backCoverSections.id, section.id))
    .run();
  appendChange(db, {
    projectId,
    what: `Back-cover ${sectionKey} ${status}${edited ? " with edits" : ""}`,
    where: `stage 7 · back cover · ${sectionKey}`,
    why:
      status === "accepted"
        ? "user approved this back-cover element"
        : "user discarded this back-cover element",
    authorizedBy: "user",
  });
}

/* ------------------------------------------------------------------ */
/* Title / subtitle / tagline options (A/B/C)                          */
/* ------------------------------------------------------------------ */

export function listTitleOptions(db: Db, projectId: string): TitleOption[] {
  return db
    .select()
    .from(titleOptions)
    .where(eq(titleOptions.projectId, projectId))
    .orderBy(asc(titleOptions.label))
    .all();
}

export interface TitleOptionDraft {
  label: string;
  title: string;
  subtitle: string;
  tagline: string;
  rationale: string;
}

export function saveTitleOptions(
  db: Db,
  projectId: string,
  drafts: TitleOptionDraft[],
  jobId?: string,
): TitleOption[] {
  db.delete(titleOptions).where(eq(titleOptions.projectId, projectId)).run();
  const ts = now();
  const saved: TitleOption[] = [];
  for (const d of drafts) {
    const id = newId();
    db.insert(titleOptions)
      .values({
        id,
        projectId,
        label: d.label,
        title: d.title,
        subtitle: d.subtitle,
        tagline: d.tagline,
        rationale: d.rationale,
        jobId,
        createdAt: ts,
      })
      .run();
    saved.push(
      db.select().from(titleOptions).where(eq(titleOptions.id, id)).get()!,
    );
  }
  return saved;
}

export function selectTitleOption(
  db: Db,
  projectId: string,
  optionId: string,
): void {
  db.update(titleOptions)
    .set({ selected: 0 })
    .where(eq(titleOptions.projectId, projectId))
    .run();
  db.update(titleOptions)
    .set({ selected: 1 })
    .where(eq(titleOptions.id, optionId))
    .run();
}

/* ------------------------------------------------------------------ */
/* Spine configuration                                                 */
/* ------------------------------------------------------------------ */

/** Returns the spine row, seeding a default (unconfirmed) one on first read. */
export function getSpine(db: Db, projectId: string): CoverSpine {
  const existing = db
    .select()
    .from(coverSpine)
    .where(eq(coverSpine.projectId, projectId))
    .get();
  if (existing) return existing;
  db.insert(coverSpine)
    .values({
      projectId,
      paperStock: DEFAULT_PAPER_STOCK,
      confirmed: 0,
      updatedAt: now(),
    })
    .run();
  return db
    .select()
    .from(coverSpine)
    .where(eq(coverSpine.projectId, projectId))
    .get()!;
}

/** Change the paper stock. Changing paper changes the spine, so this clears
 *  any prior confirmation. */
export function setPaperStock(
  db: Db,
  projectId: string,
  paperStock: string,
): void {
  getSpine(db, projectId);
  db.update(coverSpine)
    .set({ paperStock, confirmed: 0, confirmedPageCount: null, updatedAt: now() })
    .where(eq(coverSpine.projectId, projectId))
    .run();
}

/** Confirm the spine for the page count it was confirmed at. */
export function confirmSpine(
  db: Db,
  projectId: string,
  pageCount: number,
): void {
  getSpine(db, projectId);
  db.update(coverSpine)
    .set({ confirmed: 1, confirmedPageCount: pageCount, updatedAt: now() })
    .where(eq(coverSpine.projectId, projectId))
    .run();
  appendChange(db, {
    projectId,
    what: `Spine width confirmed with the printer at ${pageCount} pages`,
    where: "stage 7 · spine",
    why: "user confirmed the paper and page count with the printer",
    authorizedBy: "user",
  });
}

/* ------------------------------------------------------------------ */
/* Iteration thread (annotations + agent replies)                      */
/* ------------------------------------------------------------------ */

export function listIterations(db: Db, projectId: string): CoverIteration[] {
  return db
    .select()
    .from(coverIterations)
    .where(eq(coverIterations.projectId, projectId))
    .orderBy(desc(coverIterations.createdAt))
    .all();
}

export interface IterationRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Record a user annotation (optionally over a marked region of the preview). */
export function addIteration(
  db: Db,
  input: {
    projectId: string;
    conceptId?: string;
    target: "front" | "back" | "spine" | "spread";
    region?: IterationRegion | null;
    note: string;
  },
): CoverIteration {
  const id = newId();
  db.insert(coverIterations)
    .values({
      id,
      projectId: input.projectId,
      conceptId: input.conceptId ?? null,
      target: input.target,
      region: input.region ? JSON.stringify(input.region) : null,
      note: input.note,
      createdAt: now(),
    })
    .run();
  return db
    .select()
    .from(coverIterations)
    .where(eq(coverIterations.id, id))
    .get()!;
}

/** The oldest annotation the agent has not yet replied to. */
export function oldestPendingIteration(
  db: Db,
  projectId: string,
): CoverIteration | undefined {
  return db
    .select()
    .from(coverIterations)
    .where(
      and(
        eq(coverIterations.projectId, projectId),
        isNull(coverIterations.response),
      ),
    )
    .orderBy(asc(coverIterations.createdAt))
    .limit(1)
    .get();
}

export function resolveIteration(
  db: Db,
  id: string,
  response: string,
  jobId?: string,
): void {
  db.update(coverIterations)
    .set({ response, jobId, resolvedAt: now() })
    .where(eq(coverIterations.id, id))
    .run();
}

export function parseRegion(region: string | null): IterationRegion | null {
  if (!region) return null;
  try {
    const r = JSON.parse(region) as IterationRegion;
    if (
      typeof r.x === "number" &&
      typeof r.y === "number" &&
      typeof r.w === "number" &&
      typeof r.h === "number"
    ) {
      return r;
    }
  } catch {
    /* ignore */
  }
  return null;
}
