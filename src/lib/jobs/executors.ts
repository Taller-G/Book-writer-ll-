import fs from "node:fs";
import path from "node:path";
import { createAiClient, type AiClient } from "../ai";
import { dataDir, type Db, type DbHandle } from "../db/client";
import type { EditorialContract, Job, StyleProfile } from "../db/schema";
import { proposeApparatus } from "../master/apparatus";
import {
  assembleMasterText,
  generateMasterText,
  generateStyleSample,
} from "../master/generate";
import { checkQuoteBalance, normalizeText } from "../master/normalize";
import { proposeOutline } from "../master/outline";
import { segmentText } from "../master/segments";
import { acceptedApparatus, saveProposedApparatus } from "../repo/apparatus";
import { appendChange } from "../repo/changeLog";
import {
  getContract,
  getStyleProfile,
  getStyleSample,
  saveStyleSample,
} from "../repo/editorial";
import { markJobRunning, markJobSucceeded } from "../repo/jobs";
import { ensureRules } from "../repo/normalization";
import { getFormatConfig, insertPdfVersion, nextPdfVersion } from "../repo/output";
import { getOutline, parseOutlineData, saveProposedOutline } from "../repo/outline";
import { getProject } from "../repo/projects";
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
  // Accepted apparatus sections wrap the text; proposed/discarded ones are
  // simply left out — discarding a section never breaks the book.
  const front = acceptedApparatus(db, job.projectId, "front");
  const back = acceptedApparatus(db, job.projectId, "back");
  const sectionBlock = (s: { title: string; content: string }) =>
    `## ${s.title}\n\n${s.content}`;
  const content = [
    ...front.map(sectionBlock),
    passB.content,
    ...back.map(sectionBlock),
  ].join("\n\n");
  sqlite.transaction(() => {
    const version = nextTextVersion(db, job.projectId, "final");
    const text = insertText(db, {
      projectId: job.projectId,
      stageKey: "final",
      version,
      content,
      jobId: job.id,
    });
    appendChange(db, {
      projectId: job.projectId,
      what:
        `FINAL text v${version} frozen from passB v${passB.version}` +
        (front.length + back.length > 0
          ? ` with ${front.length + back.length} accepted apparatus section(s)`
          : ""),
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

// --- Master text (spec §4 stage 4 — editorial prose mode) --------------------
// Three AI executors on pipeline stage 5 plus the apparatus proposal. All AI
// work happens before the single success transaction; the AI client is
// resolved through a swappable factory so tests can inject a fake.

let aiFactory: (db: Db) => AiClient = (db) => createAiClient(db);

/** Test seam: replace the AI client used by the master-text executors. */
export function setAiFactoryForTests(factory?: (db: Db) => AiClient): void {
  aiFactory = factory ?? ((db) => createAiClient(db));
}

function envTokenBudget(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/** Shared gate: the master-text flow needs cleaned text, a prose contract
 *  and a style profile. */
function requireProseInputs(
  db: Db,
  projectId: string,
): { passA: NonNullable<ReturnType<typeof latestText>>; contract: EditorialContract; styleProfile: StyleProfile } {
  const passA = latestText(db, projectId, "passA");
  if (!passA) {
    throw new JobInputError(
      "There is no cleaned text. Run Cleanup Pass A first.",
    );
  }
  const contract = getContract(db, projectId);
  if (!contract) {
    throw new JobInputError("Sign the editorial contract first (stage 2).");
  }
  if (contract.mode !== "prose") {
    throw new JobInputError(
      "Master-text generation only runs in editorial prose mode. " +
        "This project's contract is set to " + contract.mode + ".",
    );
  }
  const styleProfile = getStyleProfile(db, projectId);
  if (!styleProfile) {
    throw new JobInputError("Save the style profile first (stage 3).");
  }
  return { passA, contract, styleProfile };
}

const proposeOutlineExec: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const { passA, contract, styleProfile } = requireProseInputs(db, job.projectId);
  const project = getProject(db, job.projectId)!;
  markJobRunning(db, job.id, { stageKey: "passA", version: passA.version }, passA.version);
  const segments = segmentText(passA.content);
  const { outline, aiCalls } = await proposeOutline(
    aiFactory(db),
    {
      projectId: job.projectId,
      jobId: job.id,
      bookTitle: project.title,
      segments,
      contract,
      styleProfile,
    },
    { analysisInputBudget: envTokenBudget("BOOK_WRITER_ANALYSIS_INPUT_TOKENS") },
  );
  sqlite.transaction(() => {
    saveProposedOutline(db, job.projectId, outline, job.id);
    appendChange(db, {
      projectId: job.projectId,
      what:
        `AI proposed an outline: ${outline.chapters.length} chapter(s), ` +
        `${outline.leitmotifs.length} leitmotif(s)`,
      where: "stage 5 · outline",
      why: "analysis of themes, repetitions and stories in the cleaned material",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      { chapters: outline.chapters.length, leitmotifs: outline.leitmotifs.length, aiCalls },
      passA.version,
    );
  })();
};

const generateStyleSampleExec: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const { passA, contract, styleProfile } = requireProseInputs(db, job.projectId);
  markJobRunning(db, job.id, { stageKey: "passA", version: passA.version }, passA.version);
  const sample = await generateStyleSample(aiFactory(db), {
    projectId: job.projectId,
    jobId: job.id,
    contract,
    styleProfile,
    segments: segmentText(passA.content),
  });
  sqlite.transaction(() => {
    saveStyleSample(db, job.projectId, sample);
    appendChange(db, {
      projectId: job.projectId,
      what: "Style sample generated for user approval",
      where: "stage 5 · style sample",
      why: "the voice must be pre-approved before master-text generation",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(db, job.id, { sampleChars: sample.length }, passA.version);
  })();
};

const generateMasterTextExec: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const { passA, contract, styleProfile } = requireProseInputs(db, job.projectId);
  const outlineRow = getOutline(db, job.projectId);
  if (!outlineRow || outlineRow.status !== "confirmed") {
    throw new JobInputError(
      "The outline must be confirmed before generating the master text.",
    );
  }
  const sample = getStyleSample(db, job.projectId);
  if (!sample?.approvedAt) {
    throw new JobInputError(
      "Generate and approve a style sample before the full generation.",
    );
  }
  const project = getProject(db, job.projectId)!;
  const outline = parseOutlineData(outlineRow);
  const rules = ensureRules(db, job.projectId);
  markJobRunning(
    db,
    job.id,
    {
      stageKey: "passA",
      version: passA.version,
      chapters: outline.chapters.length,
      enabledRules: rules.filter((r) => r.enabled === 1).map((r) => r.ruleKey),
    },
    passA.version,
  );
  const segments = segmentText(passA.content);
  const { chapters, aiCalls } = await generateMasterText(
    aiFactory(db),
    {
      projectId: job.projectId,
      jobId: job.id,
      bookTitle: project.title,
      contract,
      styleProfile,
      outline,
      segments,
      promptRules: rules,
      approvedSample: sample.text,
    },
    { chapterInputBudget: envTokenBudget("BOOK_WRITER_CHAPTER_INPUT_TOKENS") },
  );
  const assembled = assembleMasterText(chapters);
  const normalized = normalizeText(assembled, rules);
  const quoteBalance = checkQuoteBalance(normalized.output);
  sqlite.transaction(() => {
    const version = nextTextVersion(db, job.projectId, "passB");
    const text = insertText(db, {
      projectId: job.projectId,
      stageKey: "passB",
      version,
      content: normalized.output,
      jobId: job.id,
    });
    for (const c of chapters) {
      appendChange(db, {
        projectId: job.projectId,
        what: `Chapter "${c.title}" written (${c.calls} AI call(s))`,
        where: "stage 5 · master text",
        why: "master-text generation per the confirmed outline and style profile",
        authorizedBy: `job ${job.type} (${job.id})`,
      });
    }
    for (const n of normalized.changes) {
      appendChange(db, {
        projectId: job.projectId,
        what: `Normalization "${n.label}" applied (${n.count}×)`,
        where: "stage 5 · master text",
        why: "orthotypographic normalization per the project rule list",
        authorizedBy: `job ${job.type} (${job.id})`,
      });
    }
    if (!quoteBalance.ok) {
      for (const p of quoteBalance.problems) {
        addReviewItem(db, {
          projectId: job.projectId,
          itemType: "orthotypography",
          excerpt: "",
          question: `Quote-balance check failed: ${p}`,
        });
      }
    }
    appendChange(db, {
      projectId: job.projectId,
      what:
        `Master text passB v${version} generated: ${chapters.length} chapter(s), ` +
        `${aiCalls} AI call(s); quote-balance check ${quoteBalance.ok ? "passed" : "FAILED"}`,
      where: "stage 5 · passB text",
      why: "editorial prose mode master-text generation",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      {
        stageTextId: text.id,
        stageKey: "passB",
        chapters: chapters.length,
        aiCalls,
        normalization: normalized.changes,
        quoteBalance,
      },
      version,
    );
  })();
};

const proposeApparatusExec: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const { contract, styleProfile } = requireProseInputs(db, job.projectId);
  const passB = latestText(db, job.projectId, "passB");
  if (!passB) {
    throw new JobInputError(
      "Generate the master text first — the apparatus is proposed around it.",
    );
  }
  const outlineRow = getOutline(db, job.projectId);
  if (!outlineRow) {
    throw new JobInputError("There is no outline. Propose and confirm one first.");
  }
  const project = getProject(db, job.projectId)!;
  markJobRunning(db, job.id, { stageKey: "passB", version: passB.version }, passB.version);
  const { proposals, aiCalls } = await proposeApparatus(aiFactory(db), {
    projectId: job.projectId,
    jobId: job.id,
    bookTitle: project.title,
    author: project.author,
    contract,
    styleProfile,
    outline: parseOutlineData(outlineRow),
    masterTextOpening: passB.content.slice(0, 2_000),
  });
  sqlite.transaction(() => {
    const saved = saveProposedApparatus(db, job.projectId, proposals, job.id);
    for (const s of saved) {
      appendChange(db, {
        projectId: job.projectId,
        what: `Apparatus section "${s.title}" proposed (${s.sectionKey})`,
        where: `stage 5 · apparatus · ${s.sectionKey}`,
        why: "editorial apparatus proposal per the §6 guide",
        authorizedBy: `job ${job.type} (${job.id})`,
      });
    }
    markJobSucceeded(
      db,
      job.id,
      { proposed: saved.map((s) => s.sectionKey), aiCalls },
      passB.version,
    );
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
  propose_outline: proposeOutlineExec,
  generate_style_sample: generateStyleSampleExec,
  generate_master_text: generateMasterTextExec,
  propose_apparatus: proposeApparatusExec,
  finalize_text: finalizeText,
  export_book: exportBook,
};
