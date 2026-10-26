import fs from "node:fs";
import path from "node:path";
import { dataDir, type DbHandle } from "../db/client";
import type { Job } from "../db/schema";
import { appendChange } from "../repo/changeLog";
import { markJobRunning, markJobSucceeded } from "../repo/jobs";
import { getFormatConfig, insertPdfVersion, nextPdfVersion } from "../repo/output";
import { addReviewItem, countPendingReviews } from "../repo/review";
import { listSources } from "../repo/sources";
import { insertText, latestText, nextTextVersion } from "../repo/texts";

// Baseline deterministic executors — the versioned input/output contract
// other work orders replace with Claude-powered implementations. An executor
// may do slow async work to COMPUTE its result, but all database writes for
// the result happen in ONE synchronous transaction together with
// markJobSucceeded, so a failure anywhere leaves no partial output.

export class JobInputError extends Error {}

export type Executor = (handle: DbHandle, job: Job) => Promise<void>;

/** Tiny pause so job status transitions are observable in the UI. */
function breathe(): Promise<void> {
  return new Promise((r) => setTimeout(r, 400));
}

const ingestSources: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const all = listSources(db, job.projectId);
  if (all.length === 0) {
    throw new JobInputError(
      "No sources yet — add at least one source before compiling the raw text.",
    );
  }
  markJobRunning(
    db,
    job.id,
    { sourceIds: all.map((s) => s.id), sourceCount: all.length },
    nextTextVersion(db, job.projectId, "raw"),
  );
  await breathe();
  const compiled = all
    .slice()
    .reverse()
    .map((s) => `## ${s.title}\n\n${s.content.trim()}`)
    .join("\n\n");
  sqlite.transaction(() => {
    const version = nextTextVersion(db, job.projectId, "raw");
    const text = insertText(db, {
      projectId: job.projectId,
      stageKey: "raw",
      version,
      content: compiled,
      jobId: job.id,
    });
    appendChange(db, {
      projectId: job.projectId,
      what: `Compiled ${all.length} source(s) into raw text v${version}`,
      where: "stage 1 · raw text",
      why: "sources ingested into the working text",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(db, job.id, { stageTextId: text.id, stageKey: "raw" }, version);
  })();
};

interface TextChange {
  what: string;
  where: string;
  count: number;
}

/** Deterministic transcription cleanup; returns the new text plus an audit of what changed. */
function cleanupTransform(input: string): { output: string; changes: TextChange[] } {
  const changes: TextChange[] = [];
  const paragraphs = input.split(/\n\n+/);
  const fillerWords = ["um", "uh", "er", "este", "o sea", "you know"];
  const cleaned = paragraphs.map((p, i) => {
    let out = p;
    for (const filler of fillerWords) {
      const re = new RegExp(`(^|\\s)${filler.replace(" ", "\\s")}[,.]?(?=\\s|$)`, "gi");
      const hits = out.match(re)?.length ?? 0;
      if (hits > 0) {
        out = out.replace(re, "$1").replace(/\s{2,}/g, " ");
        changes.push({
          what: `Removed filler word "${filler}" (${hits}×)`,
          where: `paragraph ${i + 1}`,
          count: hits,
        });
      }
    }
    const doubleSpaces = out.match(/ {2,}/g)?.length ?? 0;
    if (doubleSpaces > 0) {
      out = out.replace(/ {2,}/g, " ");
      changes.push({
        what: `Collapsed repeated spaces (${doubleSpaces}×)`,
        where: `paragraph ${i + 1}`,
        count: doubleSpaces,
      });
    }
    const spacedPunct = out.match(/\s+([,.;:!?])/g)?.length ?? 0;
    if (spacedPunct > 0) {
      out = out.replace(/\s+([,.;:!?])/g, "$1");
      changes.push({
        what: `Fixed spacing before punctuation (${spacedPunct}×)`,
        where: `paragraph ${i + 1}`,
        count: spacedPunct,
      });
    }
    return out.trim();
  });
  return { output: cleaned.join("\n\n"), changes };
}

const cleanupPassA: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const raw = latestText(db, job.projectId, "raw");
  if (!raw) {
    throw new JobInputError(
      "There is no raw text to clean. Go back to Sources and compile it first.",
    );
  }
  markJobRunning(db, job.id, { stageKey: "raw", version: raw.version }, raw.version);
  await breathe();
  const { output, changes } = cleanupTransform(raw.content);
  sqlite.transaction(() => {
    const version = nextTextVersion(db, job.projectId, "passA");
    const text = insertText(db, {
      projectId: job.projectId,
      stageKey: "passA",
      version,
      content: output,
      jobId: job.id,
    });
    for (const c of changes) {
      appendChange(db, {
        projectId: job.projectId,
        what: c.what,
        where: c.where,
        why: "transcription cleanup per editorial contract",
        authorizedBy: `job ${job.type} (${job.id})`,
      });
    }
    appendChange(db, {
      projectId: job.projectId,
      what: `Cleanup Pass A produced passA v${version} from raw v${raw.version} (${changes.length} change group(s))`,
      where: "stage 4 · passA text",
      why: "first cleanup pass over the transcription",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      { stageTextId: text.id, stageKey: "passA", changeGroups: changes.length },
      version,
    );
  })();
};

const refinePassB: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const passA = latestText(db, job.projectId, "passA");
  if (!passA) {
    throw new JobInputError(
      "There is no Pass A text to refine. Run Cleanup Pass A first.",
    );
  }
  markJobRunning(db, job.id, { stageKey: "passA", version: passA.version }, passA.version);
  await breathe();
  const paragraphs = passA.content
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const longOnes = paragraphs
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.split(/\s+/).length > 120);
  const output = paragraphs.join("\n\n");
  sqlite.transaction(() => {
    const version = nextTextVersion(db, job.projectId, "passB");
    const text = insertText(db, {
      projectId: job.projectId,
      stageKey: "passB",
      version,
      content: output,
      jobId: job.id,
    });
    for (const { p, i } of longOnes) {
      addReviewItem(db, {
        projectId: job.projectId,
        itemType: "structure",
        excerpt: p.slice(0, 120) + "…",
        question: `Paragraph ${i + 1} runs ${p.split(/\s+/).length} words — split it?`,
      });
    }
    appendChange(db, {
      projectId: job.projectId,
      what: `Refine Pass B produced passB v${version} from passA v${passA.version}; flagged ${longOnes.length} item(s) for review`,
      where: "stage 5 · passB text",
      why: "structure and flow pass within the editorial contract",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      { stageTextId: text.id, stageKey: "passB", flagged: longOnes.length },
      version,
    );
  })();
};

const finalizeText: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const passB = latestText(db, job.projectId, "passB");
  if (!passB) {
    throw new JobInputError("There is no Pass B text. Run Refine Pass B first.");
  }
  const pending = countPendingReviews(db, job.projectId);
  if (pending > 0) {
    throw new JobInputError(
      `${pending} review item(s) are still pending. Resolve them before finalizing.`,
    );
  }
  markJobRunning(db, job.id, { stageKey: "passB", version: passB.version }, passB.version);
  await breathe();
  sqlite.transaction(() => {
    const version = nextTextVersion(db, job.projectId, "final");
    const text = insertText(db, {
      projectId: job.projectId,
      stageKey: "final",
      version,
      content: passB.content,
      jobId: job.id,
    });
    appendChange(db, {
      projectId: job.projectId,
      what: `FINAL text v${version} frozen from passB v${passB.version}`,
      where: "stage 6 · final text",
      why: "review queue fully resolved; text approved",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(db, job.id, { stageTextId: text.id, stageKey: "final" }, version);
  })();
};

const exportBook: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const finalText = latestText(db, job.projectId, "final");
  if (!finalText) {
    throw new JobInputError(
      "There is no FINAL text to export. Finalize the text in Review first.",
    );
  }
  const format = getFormatConfig(db, job.projectId);
  markJobRunning(
    db,
    job.id,
    { stageKey: "final", version: finalText.version, trimSize: format.trimSize },
    finalText.version,
  );
  await breathe();
  const version = nextPdfVersion(db, job.projectId);
  const dir = path.join(dataDir(), "exports", job.projectId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `book-v${version}.html`);
  const body = finalText.content
    .split(/\n\n+/)
    .map((p) =>
      p.startsWith("## ")
        ? `<h2>${escapeHtml(p.slice(3))}</h2>`
        : `<p>${escapeHtml(p)}</p>`,
    )
    .join("\n");
  fs.writeFileSync(
    filePath,
    `<!doctype html><html><head><meta charset="utf-8"><title>Export v${version}</title>
<style>body{font-family:${format.fontFamily},serif;font-size:${format.fontSizePt}pt;line-height:${format.lineHeight};max-width:40em;margin:2em auto;}</style>
</head><body>${body}</body></html>`,
  );
  sqlite.transaction(() => {
    const pdf = insertPdfVersion(db, {
      projectId: job.projectId,
      version,
      filePath,
      notes: `Export from FINAL v${finalText.version}, trim ${format.trimSize}`,
      jobId: job.id,
    });
    appendChange(db, {
      projectId: job.projectId,
      what: `Export v${version} generated (${path.basename(filePath)})`,
      where: "stage 8 · exports",
      why: "print-ready export requested",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(db, job.id, { pdfVersionId: pdf.id, filePath }, version);
  })();
};

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export const EXECUTORS: Record<string, Executor> = {
  ingest_sources: ingestSources,
  cleanup_pass_a: cleanupPassA,
  refine_pass_b: refinePassB,
  finalize_text: finalizeText,
  export_book: exportBook,
};
