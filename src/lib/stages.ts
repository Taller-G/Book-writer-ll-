// The 8-stage pipeline (spec §3). Stage numbers are 1-based and stable:
// every other slice (jobs, texts, checklist) references these numbers.

export type StageTextKey = "raw" | "passA" | "passB" | "final";

export interface StageDef {
  num: number;
  slug: string;
  title: string;
  short: string;
  description: string;
  /** Job type this stage can run, if any. */
  jobType?: string;
  /** Stage text produced by this stage's job, if any. */
  producesText?: StageTextKey;
}

export const STAGES: StageDef[] = [
  {
    num: 1,
    slug: "sources",
    title: "Sources",
    short: "Ingest your raw material",
    description:
      "Add everything the book starts from: transcripts, documents, notes. " +
      "When you're done, compile them into the raw working text.",
    jobType: "ingest_sources",
    producesText: "raw",
  },
  {
    num: 2,
    slug: "contract",
    title: "Editorial contract",
    short: "Decide how faithful the text stays",
    description:
      "Answer the four decisions — mode, tone, destination, authorship — and " +
      "sign the contract. Every later change is judged against it.",
    jobType: "tone_samples",
  },
  {
    num: 3,
    slug: "style",
    title: "Style profile",
    short: "Capture the voice",
    description:
      "Attach reference texts and let the AI propose the voice — or write it " +
      "yourself — then confirm it. The confirmed profile is injected into " +
      "every AI call in every later stage.",
  },
  {
    num: 4,
    slug: "cleanup",
    title: "Cleanup — Pass A",
    short: "Clean the transcription",
    description:
      "Run the first cleanup pass over the raw text. Every change is recorded " +
      "in the audit log: what changed, where, and why.",
    jobType: "cleanup_pass_a",
    producesText: "passA",
  },
  {
    num: 5,
    slug: "refine",
    title: "Refine — Pass B",
    short: "Shape the prose",
    description:
      "Run the second pass: structure and flow, within the limits of the " +
      "editorial contract. Doubtful edits go to the review queue.",
    jobType: "refine_pass_b",
    producesText: "passB",
  },
  {
    num: 6,
    slug: "review",
    title: "Review",
    short: "Resolve the open questions",
    description:
      "Go through the review queue, accept or reject each flagged item, then " +
      "finalize the text.",
    jobType: "finalize_text",
    producesText: "final",
  },
  {
    num: 7,
    slug: "format",
    title: "Format",
    short: "Set up the print layout",
    description:
      "Decide the physical format — page size, typefaces, margins, folios and " +
      "book conventions. Every choice is explained and preloaded with proven " +
      "defaults; accepting them untouched gives a professional result.",
  },
  {
    num: 8,
    slug: "export",
    title: "Export",
    short: "Produce the book",
    description:
      "Generate a versioned export of the formatted book, manage covers, and " +
      "walk the final checklist.",
    jobType: "export_book",
  },
];

export const STAGE_COUNT = STAGES.length;

export function getStage(num: number): StageDef | undefined {
  return STAGES.find((s) => s.num === num);
}

export type StageStatus = "locked" | "not_started" | "in_progress" | "done";

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  locked: "Locked",
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
};
