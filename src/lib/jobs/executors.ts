import fs from "node:fs";
import path from "node:path";
import { AiAuthError, createAiClient, type AiClient } from "../ai";
import { destinationOption, TONES } from "../contract/definitions";
import { dataDir, type Db, type DbHandle } from "../db/client";
import type { EditorialContract, Job, StyleProfile } from "../db/schema";
import {
  imageAbsolutePath,
  readOriginal,
  saveImageFile,
  writeDerived,
} from "../files/store";
import { readImageDimensions } from "../images/dimensions";
import { imageDpiWarnings } from "../images/dpi";
import { countWords } from "../ingest/extract";
import {
  applyPassB,
  extractWords,
  sameWordSequence,
  type PassBReaction,
} from "../format/passB";
import { classifyInconsistencies } from "../format/passC";
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
  addImage,
  imageCreditsGate,
  listPlacedImages,
  regenerateImageCredits,
  renderableImageCredits,
} from "../repo/images";
import {
  getConfirmedStyleProfile,
  getContract,
  getStyleProfile,
  getStyleSample,
  saveDraftProfile,
  saveSamplePassage,
  saveStyleSample,
  type StyleProfileFields,
} from "../repo/editorial";
import {
  buildPrintChecklist,
  checklistItemLabels,
  recommendBinding,
  renderChecklistMarkdown,
  type PrintChecklistInput,
} from "../export/checklist";
import { readPdfInfo } from "../export/pdfInfo";
import { toCmykPressPdf } from "../export/pdfx";
import { detectQrCodes } from "../export/qr";
import { failingChecks, qaCheck, readQaReport } from "../export/qaReport";
import { getPageSize, parseFormatData } from "../format/config";
import { markJobRunning, markJobSucceeded } from "../repo/jobs";
import { ensureRules } from "../repo/normalization";
import {
  getFormatConfig,
  insertPdfVersion,
  latestPdfVersion,
  latestRender,
  listCovers,
  nextPdfVersion,
  replaceChecklist,
} from "../repo/output";
import { computePreview } from "../preview/build";
import { parsePages, serializePages } from "../preview/diff";
import { getOutline, parseOutlineData, saveProposedOutline } from "../repo/outline";
import { assertUnlocked, isLocked, lockText } from "../repo/locks";
import { getProject } from "../repo/projects";
import { addReaction, confirmedReactions } from "../repo/reactions";
import { addReviewItem, countPendingReviews } from "../repo/review";
import { getSource, listSources, saveTranscription } from "../repo/sources";
import {
  aiSemanticChecker,
  findReactionCandidates,
  type ReactionCandidate,
} from "../reactions/detect";
import { decodeWav, sliceClipWav, type DecodedAudio } from "../reactions/wav";
import { listStyleRefs } from "../repo/styleRefs";
import { insertText, latestText, nextTextVersion } from "../repo/texts";
import { renderBook } from "../render/render";
import { createTranscriptionClient } from "../transcription/asr";
import {
  applyCorrections,
  CORRECTION_TYPE_LABELS,
  parseProposedCorrections,
  verifyDiffMatchesCorrections,
  type ApplyResult,
  type Correction,
} from "../transcription/corrections";
import { newId, now } from "../util";

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

// Stage 3.1: automatic transcription of audio sources via the hosted ASR
// seam. Transcribes every audio/video source that still has no text, in one
// async job, with word-level timestamps stored on each source. The ASR work
// (slow, network) happens before a single commit transaction per source.
const transcribeAudio: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const pending = listSources(db, job.projectId).filter(
    (s) =>
      (s.mediaType === "audio" || s.mediaType === "video") &&
      !!s.originalPath &&
      s.content.trim() === "",
  );
  if (pending.length === 0) {
    throw new JobInputError(
      "No audio to transcribe — upload a recording whose transcript you don't " +
        "already have, or paste the transcript in as a text source.",
    );
  }
  markJobRunning(
    db,
    job.id,
    {
      sourceIds: pending.map((s) => s.id),
      total: pending.length,
      titles: pending.map((s) => s.title),
    },
    1,
  );
  const client = createTranscriptionClient();
  const done: Array<{ id: string; title: string; words: number; model: string }> = [];
  for (const source of pending) {
    const audio = readOriginal(source.originalPath!);
    const result = await client.transcribe({
      audio,
      mimeType: source.mimeType ?? "application/octet-stream",
      filename: source.originalName ?? `${source.title}.audio`,
      language: source.language,
    });
    const wordCount = countWords(result.text);
    sqlite.transaction(() => {
      saveTranscription(db, source.id, {
        content: result.text,
        wordCount,
        language: result.language,
        words: result.words,
        model: result.model,
        provider: "asr",
        transcribedAt: now(),
      });
      appendChange(db, {
        projectId: job.projectId,
        what: `Transcribed recording "${source.title}" (${wordCount} words, ${result.words.length} word-level timestamps, model ${result.model})`,
        where: "stage 1 · transcription",
        why: "automatic speech recognition of an uploaded recording",
        authorizedBy: `job ${job.type} (${job.id})`,
      });
    })();
    done.push({
      id: source.id,
      title: source.title,
      words: wordCount,
      model: result.model,
    });
  }
  sqlite.transaction(() => {
    markJobSucceeded(
      db,
      job.id,
      { transcribed: done, count: done.length },
      1,
    );
  })();
};

/**
 * The passage tone samples are generated from: the first real paragraphs of
 * the user's own compiled material (headings skipped), capped so four
 * parallel completions stay cheap.
 */
export function sampleExcerpt(rawText: string, maxChars = 700): string {
  const paragraphs = rawText
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("## "));
  const picked: string[] = [];
  let length = 0;
  for (const p of paragraphs) {
    picked.push(p);
    length += p.length;
    if (length >= maxChars) break;
  }
  const excerpt = picked.join("\n\n");
  return excerpt.length > maxChars * 2 ? excerpt.slice(0, maxChars * 2) : excerpt;
}

const toneSamples: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const raw = latestText(db, job.projectId, "raw");
  if (!raw) {
    throw new JobInputError(
      "Tone samples are generated from your own material — compile your " +
        "sources into the raw text first (Stage 1).",
    );
  }
  const excerpt = sampleExcerpt(raw.content);
  markJobRunning(
    db,
    job.id,
    { stageKey: "raw", version: raw.version, excerptChars: excerpt.length },
    raw.version,
  );
  const client = createAiClient(db);
  // Same passage, once per predefined tone, so the user compares like with
  // like. `bare` keeps the auto-injected contract and style profile out:
  // the tone is exactly what is being decided here.
  const samples = await Promise.all(
    TONES.map(async (tone) => {
      const res = await client.complete({
        role: "large",
        projectId: job.projectId,
        jobId: job.id,
        system: {
          bare: true,
          instructions:
            "Rewrite the user's passage as a book paragraph in the tone " +
            "described below. Keep the meaning, the facts and the language " +
            "of the passage (reply in that same language). Return only the " +
            "rewritten passage, nothing else.\n" +
            tone.instruction,
        },
        messages: [{ role: "user", content: excerpt }],
        maxTokens: 800,
      });
      return {
        tone: tone.value,
        label: tone.label,
        text: res.text.trim(),
        model: res.model,
      };
    }),
  );
  sqlite.transaction(() => {
    appendChange(db, {
      projectId: job.projectId,
      what: `Generated ${samples.length} tone samples from raw text v${raw.version}`,
      where: "stage 2 · tone samples",
      why: "side-by-side tone comparison for the editorial contract",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(db, job.id, { excerpt, samples }, raw.version);
  })();
};

interface TextChange {
  what: string;
  where: string;
  count: number;
}

/**
 * Deterministic transcription cleanup; returns the new text plus an audit of
 * what changed. Removing filler words is a rewrite, so it is only done when
 * the editorial contract allows rewrites (prose/hybrid). In verbatim mode the
 * candidates are reported as `blocked` instead — kept, not removed.
 */
function cleanupTransform(
  input: string,
  allowRewrites: boolean,
): { output: string; changes: TextChange[]; blocked: TextChange[] } {
  const changes: TextChange[] = [];
  const blocked: TextChange[] = [];
  const paragraphs = input.split(/\n\n+/);
  const fillerWords = ["um", "uh", "er", "este", "o sea", "you know"];
  const cleaned = paragraphs.map((p, i) => {
    let out = p;
    for (const filler of fillerWords) {
      const re = new RegExp(`(^|\\s)${filler.replace(" ", "\\s")}[,.]?(?=\\s|$)`, "gi");
      const hits = out.match(re)?.length ?? 0;
      if (hits > 0) {
        if (!allowRewrites) {
          blocked.push({
            what: `Kept filler word "${filler}" (${hits}×)`,
            where: `paragraph ${i + 1}`,
            count: hits,
          });
          continue;
        }
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
  return { output: cleaned.join("\n\n"), changes, blocked };
}

/** The contract every text pass runs under; refusing to run without one. */
function requireContract(db: DbHandle["db"], projectId: string) {
  const contract = getContract(db, projectId);
  if (!contract) {
    throw new JobInputError(
      "No editorial contract — sign it in Stage 2 before running text passes.",
    );
  }
  return contract;
}

const PASS_A_MAX_TOKENS = 4000;

/** Pass A correction-proposal instructions: ONLY transcription-software noise. */
function passAInstructions(mode: string): string {
  return (
    "You correct transcription-software noise in an audio-book transcript. " +
    "Find ONLY errors the transcription software made, and return them as corrections. " +
    "You must NOT rephrase, improve, shorten, reorder or edit the author's words in any " +
    `way — that is strictly forbidden by the editorial contract (${mode} mode). ` +
    "Every correction MUST be exactly one of these classes:\n" +
    '- ASR: a misheard word or phrase (e.g. "Tu shé" heard instead of "Touché")\n' +
    "- NOM: a proper name the transcriber spelled wrong\n" +
    "- REC: a systematic transcriber pattern (a recurring mis-transcription)\n" +
    '- NORM: a number written as pronounced that should be digits (e.g. "twenty twenty five" -> "2025")\n\n' +
    "Respond with ONLY a JSON array (no prose, no code fences). Each element is an object with string " +
    'fields "type" (ASR|NOM|REC|NORM), "original" (the EXACT text as it appears in the transcript, copied ' +
    'verbatim so it can be found and replaced), "correction" (the fixed text), "justification" (why this is a ' +
    'transcription error and not an edit), and an optional number "position". Return [] if there are none.'
  );
}

/**
 * Ask the AI to propose structured transcription-noise corrections. When no
 * AI key is configured the pass still runs: it skips the correction phase and
 * falls back to the deterministic mechanical cleanup only.
 */
async function proposePassACorrections(
  db: Db,
  job: Job,
  text: string,
  mode: string,
): Promise<{
  proposal: ReturnType<typeof parseProposedCorrections> | null;
  skipReason?: string;
}> {
  let client: AiClient;
  try {
    client = aiFactory(db);
  } catch (e) {
    if (e instanceof AiAuthError) return { proposal: null, skipReason: e.message };
    throw e;
  }
  const response = await client.complete({
    role: "fast",
    // bare: the proposal must spot raw transcription noise, not be shaped by
    // the project voice; the faithful rule is stated in the instructions and
    // enforced structurally by the correction engine regardless.
    system: { instructions: passAInstructions(mode), bare: true },
    messages: [{ role: "user", content: text }],
    maxTokens: PASS_A_MAX_TOKENS,
    projectId: job.projectId,
    jobId: job.id,
  });
  return { proposal: parseProposedCorrections(response.text) };
}

const cleanupPassA: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const raw = latestText(db, job.projectId, "raw");
  if (!raw) {
    throw new JobInputError(
      "There is no raw text to clean. Go back to Sources and compile it first.",
    );
  }
  const contract = requireContract(db, job.projectId);
  const allowRewrites = contract.mode !== "verbatim";
  markJobRunning(
    db,
    job.id,
    {
      stageKey: "raw",
      version: raw.version,
      contractVersion: contract.version,
      contractMode: contract.mode,
    },
    raw.version,
  );

  // --- Phase 1: AI proposes transcription-noise corrections ----------------
  const { proposal, skipReason } = await proposePassACorrections(
    db,
    job,
    raw.content,
    contract.mode,
  );

  // --- Phase 2: apply with programmatic verification -----------------------
  // Every proposal is checked against the faithful contract and the
  // exactly-once rule; anything unverifiable goes to the doubtful queue, never
  // silently into the text.
  const correctionResult: ApplyResult = proposal
    ? applyCorrections(raw.content, proposal.valid, contract.mode)
    : { output: raw.content, applied: [], doubtful: [], rejected: [] };
  const rejected = [
    ...(proposal?.rejected ?? []),
    ...correctionResult.rejected,
  ];
  const corrected = correctionResult.output;

  // --- Phase 3: hard proof — corrected == raw + exactly the applied changes
  const verdict = verifyDiffMatchesCorrections(
    raw.content,
    corrected,
    correctionResult.applied,
  );
  if (!verdict.ok) {
    throw new Error(
      "Pass A aborted: the corrected text does not match the logged corrections " +
        `(word-level diff mismatch). ${verdict.problems.join(" ")}`,
    );
  }

  // --- Phase 4: deterministic mechanical cleanup (spacing, punctuation; and
  // filler removal only where the contract allows rewrites) on top.
  await breathe();
  const { output, changes, blocked } = cleanupTransform(corrected, allowRewrites);

  const label = (c: Correction) =>
    `${CORRECTION_TYPE_LABELS[c.type]} (${c.type})`;

  sqlite.transaction(() => {
    const version = nextTextVersion(db, job.projectId, "passA");
    const text = insertText(db, {
      projectId: job.projectId,
      stageKey: "passA",
      version,
      content: output,
      jobId: job.id,
    });
    // Applied noise corrections — one attributed, classified audit row each.
    for (const c of correctionResult.applied) {
      appendChange(db, {
        projectId: job.projectId,
        what: `Corrected "${c.original}" → "${c.correction}" [${label(c)}]`,
        where: "stage 4 · passA · transcription noise",
        why: c.justification || "transcription-software error corrected",
        authorizedBy: `job ${job.type} (${job.id})`,
        category: c.type,
      });
    }
    // Unverifiable proposals → the doubtful queue (review_queue), plus a note.
    for (const d of correctionResult.doubtful) {
      addReviewItem(db, {
        projectId: job.projectId,
        itemType: "transcription",
        excerpt: d.correction.original,
        question:
          `Transcription fix "${d.correction.original}" → "${d.correction.correction}" ` +
          `[${label(d.correction)}] was not auto-applied: ${d.reason}`,
      });
      appendChange(db, {
        projectId: job.projectId,
        what: `Doubtful correction queued for review: "${d.correction.original}" → "${d.correction.correction}" [${label(d.correction)}]`,
        where: "stage 4 · passA · doubtful queue",
        why: d.reason,
        authorizedBy: `job ${job.type} (${job.id})`,
        category: d.correction.type,
      });
    }
    // Rejected proposals — edits the faithful contract refused, on the record.
    for (const r of rejected) {
      appendChange(db, {
        projectId: job.projectId,
        what: `Rejected proposed edit "${r.correction.original}" → "${r.correction.correction}"`,
        where: "stage 4 · passA · blocked by contract",
        why: r.reason,
        authorizedBy: `job ${job.type} (${job.id})`,
      });
    }
    // Deterministic mechanical cleanup changes (and verbatim-blocked fillers).
    for (const c of changes) {
      appendChange(db, {
        projectId: job.projectId,
        what: c.what,
        where: c.where,
        why: `transcription cleanup per editorial contract v${contract.version} (${contract.mode})`,
        authorizedBy: `job ${job.type} (${job.id})`,
      });
    }
    for (const c of blocked) {
      appendChange(db, {
        projectId: job.projectId,
        what: c.what,
        where: c.where,
        why: `editorial contract v${contract.version} is verbatim — rewrites are blocked`,
        authorizedBy: `job ${job.type} (${job.id})`,
      });
    }
    appendChange(db, {
      projectId: job.projectId,
      what:
        `Cleanup Pass A produced passA v${version} from raw v${raw.version}: ` +
        `${correctionResult.applied.length} noise correction(s) applied, ` +
        `${correctionResult.doubtful.length} doubtful, ${rejected.length} rejected; ` +
        `${changes.length} mechanical change group(s), ${blocked.length} blocked by contract` +
        (skipReason ? " (AI correction skipped: no AI key configured)" : ""),
      where: "stage 4 · passA text",
      why: "transcription-noise correction pass over the raw transcript",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      {
        stageTextId: text.id,
        stageKey: "passA",
        corrections: correctionResult.applied.length,
        doubtful: correctionResult.doubtful.length,
        rejected: rejected.length,
        diffVerified: verdict.ok,
        changeGroups: changes.length,
        blockedByContract: blocked.length,
        contractVersion: contract.version,
        aiCorrectionSkipped: skipReason ?? null,
      },
      version,
    );
  })();
};

/** Decode the first WAV-decodable audio source of a project (for clips). */
function projectAudioForClips(
  db: Db,
  projectId: string,
): { sourceId: string; audio: DecodedAudio; durationMs: number } | undefined {
  for (const src of listSources(db, projectId)) {
    const isAudio =
      src.mediaType === "audio" || src.mediaType === "video" || src.kind === "audio";
    if (!isAudio || !src.originalPath) continue;
    try {
      const audio = decodeWav(readOriginal(src.originalPath));
      const durationMs =
        (src.durationSeconds ?? audio.frameCount / audio.sampleRate) * 1000;
      return { sourceId: src.id, audio, durationMs };
    } catch {
      // not WAV-decodable — try the next source
    }
  }
  return undefined;
}

// Pass B (spec §4 stage 3.5): faithful structuring. Inserts paragraph breaks at
// discourse anchors and applies genre conventions — confirmed reactions in
// italic brackets, interviewer questions in bold with an em dash on their own
// paragraph — WITHOUT changing a single spoken word. Ambiguous questions
// (speaker-rhetorical vs interviewer) are routed to the review queue with their
// audio clip rather than silently formatted. Runs identically for verbatim and
// hybrid contracts: it never rewrites.
const refinePassB: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const passA = latestText(db, job.projectId, "passA");
  if (!passA) {
    throw new JobInputError(
      "There is no Pass A text to refine. Run Cleanup Pass A first.",
    );
  }
  assertUnlocked(db, job.projectId);
  const contract = requireContract(db, job.projectId);
  markJobRunning(
    db,
    job.id,
    {
      stageKey: "passA",
      version: passA.version,
      contractVersion: contract.version,
      contractMode: contract.mode,
    },
    passA.version,
  );
  await breathe();

  const reactions: PassBReaction[] = confirmedReactions(db, job.projectId)
    .filter((r) => r.charAnchor !== null)
    .map((r) => ({ kind: r.kind, charAnchor: r.charAnchor as number }));
  const result = applyPassB(passA.content, { reactions });

  // The contract made structural: Pass B may only add breaks and formatting
  // marks. If a single spoken word moved, abort rather than write drift.
  if (!sameWordSequence(passA.content, result.output)) {
    throw new Error(
      "Pass B altered the spoken-word sequence — aborting to protect the " +
        "faithful text. This is a bug in the structuring pass.",
    );
  }

  // Ambiguous questions get their audio clip (when a WAV recording is linked)
  // so the reviewer can hear who asked.
  const clipSource = result.ambiguousQuestions.length
    ? projectAudioForClips(db, job.projectId)
    : undefined;

  sqlite.transaction(() => {
    const version = nextTextVersion(db, job.projectId, "passB");
    const text = insertText(db, {
      projectId: job.projectId,
      stageKey: "passB",
      version,
      content: result.output,
      jobId: job.id,
    });
    for (const q of result.ambiguousQuestions) {
      let clipPath: string | null = null;
      if (clipSource) {
        // Map the question's text offset proportionally back to audio time.
        const ms =
          passA.content.length > 0
            ? (q.charOffset / passA.content.length) * clipSource.durationMs
            : 0;
        clipPath = writeDerived(
          job.projectId,
          clipSource.sourceId,
          `question-${q.charOffset}.wav`,
          sliceClipWav(clipSource.audio, ms, ms + 3000),
        );
      }
      addReviewItem(db, {
        projectId: job.projectId,
        itemType: "question",
        stageKey: "passB",
        excerpt: q.excerpt,
        doubtfulText: q.excerpt,
        question:
          "Is this an interviewer's question or the speaker's own rhetorical " +
          "question? It was left unformatted pending your decision.",
        clipPath,
      });
    }
    appendChange(db, {
      projectId: job.projectId,
      what:
        `Refine Pass B produced passB v${version} from passA v${passA.version}: ` +
        `${result.paragraphBreaksAdded} paragraph break(s), ` +
        `${result.reactionsInserted} reaction(s), ` +
        `${result.interviewerQuestions} interviewer question(s); ` +
        `${result.ambiguousQuestions.length} ambiguous question(s) flagged`,
      where: "stage 5 · passB text",
      why:
        `faithful structuring within editorial contract v${contract.version} ` +
        `(${contract.mode}) — no word changed`,
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      {
        stageTextId: text.id,
        stageKey: "passB",
        paragraphBreaksAdded: result.paragraphBreaksAdded,
        reactionsInserted: result.reactionsInserted,
        interviewerQuestions: result.interviewerQuestions,
        ambiguousFlagged: result.ambiguousQuestions.length,
        contractVersion: contract.version,
      },
      version,
    );
  })();
};

// Pass C (spec §4 stage 3.6): classify gross inconsistencies by severity and
// emit them as one approvable review batch. Flags only — never edits the text.
const classifyInconsistenciesExec: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const passB = latestText(db, job.projectId, "passB");
  if (!passB) {
    throw new JobInputError(
      "There is no Pass B text to check. Run Refine Pass B first.",
    );
  }
  assertUnlocked(db, job.projectId);
  const contract = requireContract(db, job.projectId);
  const styleProfile = getConfirmedStyleProfile(db, job.projectId);
  markJobRunning(db, job.id, { stageKey: "passB", version: passB.version }, passB.version);

  const { items, aiCalls } = await classifyInconsistencies(aiFactory(db), {
    projectId: job.projectId,
    jobId: job.id,
    text: passB.content,
    contract,
    styleProfile,
  });
  const batchId = newId();
  const bySeverity = {
    gross: items.filter((i) => i.severity === "gross").length,
    medium: items.filter((i) => i.severity === "medium").length,
    minor: items.filter((i) => i.severity === "minor").length,
  };

  sqlite.transaction(() => {
    for (const item of items) {
      addReviewItem(db, {
        projectId: job.projectId,
        itemType: "inconsistency",
        severity: item.severity,
        batchId,
        excerpt: item.excerpt.slice(0, 160),
        question: item.description,
      });
    }
    appendChange(db, {
      projectId: job.projectId,
      what:
        `Pass C flagged ${items.length} inconsistency item(s) ` +
        `(${bySeverity.gross} gross, ${bySeverity.medium} medium, ${bySeverity.minor} minor)`,
      where: "stage 6 · review queue",
      why: "gross-inconsistency classification over the structured text (no word changed)",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      { batchId, flagged: items.length, bySeverity, aiCalls },
      passB.version,
    );
  })();
};

// Finalize (spec §4 stage 3.6): the stage-closing verification and the FINAL
// lock. It refuses to close unless (1) the review queue is empty, (2) the
// «»-quote balance is perfect, and (3) the word sequence of the final text
// equals the approved Pass B text plus the recorded apparatus — a word-for-word
// guard against drift between approval and closure. On success the text is
// locked; re-finalizing or any edit then requires an explicit unlock, which is
// logged, as is every post-closure touch-up.
const finalizeText: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const passB = latestText(db, job.projectId, "passB");
  if (!passB) {
    throw new JobInputError("There is no Pass B text. Run Refine Pass B first.");
  }
  // A locked FINAL must be explicitly reopened before it can be re-finalized.
  if (isLocked(db, job.projectId)) {
    throw new JobInputError(
      "The text is FINAL and locked. Unlock it explicitly in Review before " +
        "re-finalizing — the reopening is logged.",
    );
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

  // (2) Perfect «» quote balance over the whole closed text.
  const balance = checkQuoteBalance(content);
  if (!balance.ok) {
    throw new JobInputError(
      "The text cannot close with unbalanced quotes: " + balance.problems.join(" "),
    );
  }

  // (3) Word-for-word: the final text's words must be exactly the approved
  // apparatus words plus the approved Pass B words, in order.
  const expectedWords = [
    ...front.map(sectionBlock).flatMap(extractWords),
    ...extractWords(passB.content),
    ...back.map(sectionBlock).flatMap(extractWords),
  ];
  const finalWords = extractWords(content);
  const wordsMatch =
    expectedWords.length === finalWords.length &&
    expectedWords.every((w, i) => w === finalWords[i]);
  if (!wordsMatch) {
    throw new Error(
      "Stage-closing verification failed: the final word sequence does not " +
        "equal the approved text plus recorded changes. Nothing was frozen.",
    );
  }

  sqlite.transaction(() => {
    const version = nextTextVersion(db, job.projectId, "final");
    const text = insertText(db, {
      projectId: job.projectId,
      stageKey: "final",
      version,
      content,
      jobId: job.id,
    });
    // Close and lock: the text is FINAL.
    lockText(db, job.projectId, version);
    appendChange(db, {
      projectId: job.projectId,
      what:
        `FINAL text v${version} frozen and LOCKED from passB v${passB.version}` +
        (front.length + back.length > 0
          ? ` with ${front.length + back.length} accepted apparatus section(s)`
          : ""),
      where: "stage 6 · final text",
      why:
        "stage-closing verification passed: queue empty, quotes balanced, word " +
        "sequence equals approved text plus recorded changes",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      { stageTextId: text.id, stageKey: "final", locked: true, words: finalWords.length },
      version,
    );
  })();
};

// Stage 7 layout engine: approved FINAL text + format_config → versioned,
// QA-checked PDF. The composition is verified word-for-word against the
// approved text before compiling; a mismatch aborts the render. The QA report
// is always written — a failing report versions the PDF as qa_passed = 0 so
// the defects can be inspected, page by page.
const renderPdf: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const finalText = latestText(db, job.projectId, "final");
  if (!finalText) {
    throw new JobInputError(
      "There is no FINAL text to render. Finalize the text in Review first.",
    );
  }
  const project = getProject(db, job.projectId);
  if (!project) throw new JobInputError("Project not found.");
  const format = getFormatConfig(db, job.projectId);
  // Placed images enter the layout engine's input; the credits section (when
  // the book has images) is appended so it is typeset and verified with the
  // text. Pre-render dpi warnings are computed from pixel size vs printed size
  // BEFORE compiling, so a too-small image is flagged without a full render.
  const placed = listPlacedImages(db, job.projectId);
  const images = placed.map((img) => ({
    path: imageAbsolutePath(img.filePath),
    sizeOption: img.sizeOption,
    anchorText: img.anchorText,
    order: img.narrativeOrder,
  }));
  const dpiWarnings = imageDpiWarnings(
    placed.map((img) => ({
      id: img.id,
      widthPx: img.widthPx,
      heightPx: img.heightPx,
      sizeOption: img.sizeOption,
      caption: img.caption,
      originalName: img.originalName,
    })),
    parseFormatData(format.data),
  );
  const credits = renderableImageCredits(db, job.projectId);
  const approvedText = credits
    ? `${finalText.content}\n\n## ${credits.title}\n\n${credits.content}`
    : finalText.content;
  markJobRunning(
    db,
    job.id,
    {
      stageKey: "final",
      version: finalText.version,
      trimSize: format.trimSize,
      placedImages: placed.length,
      dpiWarnings: dpiWarnings.map((w) => w.message),
    },
    finalText.version,
  );
  const version = nextPdfVersion(db, job.projectId);
  const outDir = path.join(dataDir(), "exports", job.projectId);
  const result = await renderBook({
    approvedText,
    format,
    images,
    meta: { title: project.title, author: project.author },
    buildDir: path.join(outDir, "build"),
    outDir,
    pdfVersion: version,
    textVersion: finalText.version,
  });
  sqlite.transaction(() => {
    const pdf = insertPdfVersion(db, {
      projectId: job.projectId,
      version,
      filePath: result.pdfPath,
      notes: `Rendered from FINAL v${finalText.version}, trim ${format.trimSize}, font ${result.fontUsed}`,
      jobId: job.id,
      textVersion: finalText.version,
      formatHash: result.formatHash,
      qaPassed: result.qaReport.passed ? 1 : 0,
      qaReportPath: result.qaFiles.markdownPath,
    });
    const failing = result.qaReport.checks.filter((c) => !c.passed);
    for (const w of dpiWarnings) {
      appendChange(db, {
        projectId: job.projectId,
        what: `Pre-render dpi warning: ${w.message}`,
        where: "stage 7 · images · dpi",
        why: "image printed resolution checked against 300 dpi before compiling",
        authorizedBy: `job ${job.type} (${job.id})`,
      });
    }
    appendChange(db, {
      projectId: job.projectId,
      what:
        `PDF v${version} rendered (${path.basename(result.pdfPath)}); QA ` +
        (result.qaReport.passed
          ? "passed all checks"
          : `failed: ${failing.map((c) => c.id).join(", ")}`) +
        (placed.length > 0 ? `; ${placed.length} image(s) placed` : "") +
        (dpiWarnings.length > 0 ? `; ${dpiWarnings.length} dpi warning(s)` : ""),
      where: "stage 7 · pdf renders",
      why: "layout render of the approved text requested",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      {
        pdfVersionId: pdf.id,
        filePath: result.pdfPath,
        qaPassed: result.qaReport.passed,
        qaReportPath: result.qaFiles.markdownPath,
        recoveredFromCorruption: result.recoveredFromCorruption,
        placedImages: placed.length,
        dpiWarnings: dpiWarnings.map((w) => w.message),
      },
      version,
    );
  })();
};

// Stage 8 export: assembles the print-shop deliverables from the QA-passed
// Stage 7 render. It refuses to run while the latest render's QA report has any
// failing check (naming them), and every checklist value — page count, embedded
// fonts, image resolution — is read off the actual compiled PDF and its report,
// never off the project config. The deliverable bundle is a copied interior
// PDF, an auto-generated print-shop checklist + one-line summary, an optional
// CMYK/PDF-X variant for print destinations, and the cover spread when one is
// attached (otherwise flagged pending). A book that contains QR codes carries a
// print-test reminder.
const exportBook: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const finalText = latestText(db, job.projectId, "final");
  if (!finalText) {
    throw new JobInputError(
      "There is no FINAL text to export. Finalize the text in Review first.",
    );
  }
  // A book with images must carry an accepted credits section — block the
  // export if it was discarded or never accepted. (The credits and images
  // themselves are typeset into the Stage-7 render that this export copies.)
  const creditsCheck = imageCreditsGate(db, job.projectId);
  if (!creditsCheck.ok) throw new JobInputError(creditsCheck.reason!);
  const render = latestRender(db, job.projectId);
  if (!render || !render.qaReportPath) {
    throw new JobInputError(
      "There is no typeset PDF to export. Render the QA-checked PDF in Stage 7 (Format) first.",
    );
  }
  // Honour the QA report already on record: a failing report blocks the export,
  // naming every defect so the author knows exactly what to fix and where.
  const qa = readQaReport(render.qaReportPath);
  const failing = failingChecks(qa);
  if (!qa.passed || failing.length > 0 || render.qaPassed !== 1) {
    const reasons = failing.map(
      (c) =>
        `- ${c.title}${c.pages.length ? ` (page(s) ${c.pages.join(", ")})` : ""}: ${c.detail}`,
    );
    throw new JobInputError(
      `Export blocked — the QA report for PDF v${render.version} has ${failing.length} failing check(s):\n` +
        reasons.join("\n") +
        "\nRe-render in Stage 7 until QA passes, then export.",
    );
  }

  const project = getProject(db, job.projectId);
  if (!project) throw new JobInputError("Project not found.");
  const format = getFormatConfig(db, job.projectId);
  const formatData = parseFormatData(format.data);
  // The contract's destination decides the colour space (and thus whether a
  // PDF/X variant is required).
  const contract = getContract(db, job.projectId);
  const destination = contract?.destination
    ? destinationOption(contract.destination)
    : undefined;
  const colorMode = destination?.colorProfile ?? "sRGB";

  // Page count straight off the compiled PDF — never estimated from the config.
  const info = readPdfInfo(render.filePath);
  const fontsCheck = qaCheck(qa, "fonts_embedded");
  const imageCheck = qaCheck(qa, "image_dpi");
  const hasQrCodes = detectQrCodes(finalText.content);
  const selectedCover = listCovers(db, job.projectId).find(
    (c) => c.selected === 1 && c.filePath,
  );

  markJobRunning(
    db,
    job.id,
    {
      stageKey: "final",
      version: finalText.version,
      fromRenderVersion: render.version,
      pageCount: info.pageCount,
      colorProfile: colorMode,
      hasQrCodes,
    },
    finalText.version,
  );
  await breathe();
  // The same export also feeds the Stage 6.3 preview viewer and correction
  // cycle: lay the approved text into pages, QA it and diff against the previous
  // version, so the preview is seeded from one code path.
  const previousPdf = latestPdfVersion(db, job.projectId);
  const preview = computePreview(
    finalText.content,
    formatData,
    parsePages(previousPdf?.pages),
  );

  const version = nextPdfVersion(db, job.projectId);
  const bundleDir = path.join(
    dataDir(),
    "exports",
    job.projectId,
    `export-v${version}`,
  );
  fs.mkdirSync(bundleDir, { recursive: true });

  // Interior PDF: the QA-passed render, copied into the deliverable bundle.
  const interiorPath = path.join(bundleDir, "book-interior.pdf");
  fs.copyFileSync(render.filePath, interiorPath);

  // PDF/X variant when the destination prints in CMYK — best effort; a missing
  // Ghostscript degrades to a checklist note, it never fails the export.
  const pdfxRequired = colorMode === "CMYK";
  let pdfxPath: string | undefined;
  if (pdfxRequired) {
    const candidate = path.join(bundleDir, "book-pdfx.pdf");
    if (toCmykPressPdf(interiorPath, candidate)) pdfxPath = candidate;
  }
  const pdfxProduced = pdfxPath !== undefined;

  // Cover spread only when a selected cover carries a real file; else pending.
  let coverPath: string | undefined;
  if (selectedCover?.filePath && fs.existsSync(selectedCover.filePath)) {
    coverPath = path.join(
      bundleDir,
      `cover-spread${path.extname(selectedCover.filePath)}`,
    );
    fs.copyFileSync(selectedCover.filePath, coverPath);
  }

  const checklistInput: PrintChecklistInput = {
    projectTitle: project.title,
    pageCount: info.pageCount,
    pageSize: getPageSize(formatData.pageSize),
    colorMode,
    destinationLabel: destination?.label ?? "unspecified",
    fontsEmbedded: fontsCheck?.passed ?? false,
    fontsDetail: fontsCheck?.detail ?? "font embedding unknown",
    imageResolution: imageCheck?.detail ?? "image resolution unknown",
    bleedMm: 3,
    binding: recommendBinding(info.pageCount),
    hasQrCodes,
    coverStatus: coverPath ? "attached" : "pending",
    pdfx: { required: pdfxRequired, produced: pdfxProduced },
  };
  const checklist = buildPrintChecklist(checklistInput);

  const checklistPath = path.join(bundleDir, "print-checklist.md");
  fs.writeFileSync(
    checklistPath,
    renderChecklistMarkdown(project.title, checklist),
  );
  const oneLinerPath = path.join(bundleDir, "one-liner.txt");
  fs.writeFileSync(oneLinerPath, checklist.oneLiner + "\n");

  sqlite.transaction(() => {
    // The UI's toggle-checklist is regenerated from this export's real data.
    replaceChecklist(db, job.projectId, checklistItemLabels(checklist));
    const pdf = insertPdfVersion(db, {
      projectId: job.projectId,
      version,
      filePath: interiorPath,
      notes:
        `Export bundle v${version} from FINAL v${finalText.version} / PDF v${render.version} ` +
        `(${info.pageCount} pp, ${checklist.interior.colorMode})` +
        (hasQrCodes ? ", QR print-test reminder" : ""),
      jobId: job.id,
      pages: serializePages(preview.pages),
      pageCount: preview.pageCount,
      sourceTextVersion: finalText.version,
      kind: "export",
      qa: JSON.stringify(preview.qa),
      diff: JSON.stringify(preview.diff),
    });
    appendChange(db, {
      projectId: job.projectId,
      what:
        `Export bundle v${version} generated: interior PDF (${info.pageCount} pp), ` +
        `print-shop checklist, one-liner` +
        (pdfxProduced ? ", PDF/X (CMYK)" : "") +
        (coverPath ? ", cover spread" : "") +
        (hasQrCodes ? "; QR print-test reminder included" : ""),
      where: "stage 8 · exports",
      why: "print-ready export requested; built from the QA-passed render",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      {
        pdfVersionId: pdf.id,
        bundleDir,
        interiorPath,
        pdfxPath: pdfxPath ?? null,
        coverPath: coverPath ?? null,
        checklistPath,
        oneLinerPath,
        oneLiner: checklist.oneLiner,
        pageCount: info.pageCount,
        colorMode: checklist.interior.colorMode,
        hasQrCodes,
        qrReminder: checklist.qrReminder,
        coverStatus: checklistInput.coverStatus,
        pdfx: checklistInput.pdfx,
        fromRenderVersion: render.version,
      },
      version,
    );
  })();
};

// --- Stage 3: style profile extraction and sample generation ------------

/** Cap per reference so a whole book attached as reference stays affordable. */
const MAX_REF_CHARS = 20_000;
const SAMPLE_SOURCE_CHARS = 1_500;

const EXTRACT_INSTRUCTIONS = `You are a literary style analyst. Extract a style profile from the reference texts the user provides. Describe each dimension in short plain language a non-technical author understands (e.g. "short sentences, second person, everyday examples, almost no adjectives"), in the language of the references.

Respond with ONLY a JSON object, no prose and no code fences, with exactly these string fields: "voice", "tone", "register" (vocabulary and register), "person" (narrative person), "rhythm" (sentence rhythm), "punctuation" (characteristic punctuation), "metaphors" (use of metaphors and examples), "openings" (how sections open and close), "notes" (anything else that defines the voice) — plus "excerpts": an array of 3 to 5 short passages (1-3 sentences each) copied VERBATIM from the references, chosen as the most representative of the voice.`;

/**
 * Parse the model's profile JSON strictly. Any shortfall throws — a failed
 * job with a clear error, never a silent partial profile.
 */
function parseProfileJson(text: string): StyleProfileFields {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    throw new Error(
      "The AI did not return a valid style profile (unparseable response). " +
        "Run the extraction again.",
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(
      "The AI did not return a valid style profile (not a JSON object). " +
        "Run the extraction again.",
    );
  }
  const d = data as Record<string, unknown>;
  const field = (key: string) => (typeof d[key] === "string" ? (d[key] as string) : "");
  const excerpts = Array.isArray(d.excerpts)
    ? d.excerpts.filter((e): e is string => typeof e === "string" && e.trim() !== "")
    : [];
  const fields: StyleProfileFields = {
    voice: field("voice"),
    tone: field("tone"),
    register: field("register"),
    person: field("person"),
    rhythm: field("rhythm"),
    punctuation: field("punctuation"),
    metaphors: field("metaphors"),
    openings: field("openings"),
    notes: field("notes"),
    excerpts: excerpts.slice(0, 5),
  };
  const traitCount = [
    fields.voice,
    fields.tone,
    fields.register,
    fields.person,
    fields.rhythm,
    fields.punctuation,
    fields.metaphors,
    fields.openings,
  ].filter((v) => v.trim() !== "").length;
  if (traitCount < 4 || fields.excerpts.length === 0) {
    throw new Error(
      "The AI returned an incomplete style profile " +
        `(${traitCount}/8 traits, ${fields.excerpts.length} excerpt(s)). ` +
        "Nothing was saved — run the extraction again.",
    );
  }
  return fields;
}

const extractStyle: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const refs = listStyleRefs(db, job.projectId);
  if (refs.length === 0) {
    throw new JobInputError(
      "No reference files attached. Add at least one reference (txt, md, pdf, docx) " +
        "whose style the profile should capture.",
    );
  }
  markJobRunning(
    db,
    job.id,
    { refIds: refs.map((r) => r.id), refCount: refs.length },
    1,
  );
  const material = refs
    .map((r) => {
      const text =
        r.content.length > MAX_REF_CHARS
          ? r.content.slice(0, MAX_REF_CHARS) + "\n[truncated]"
          : r.content;
      return `### Reference: ${r.name}\n\n${text}`;
    })
    .join("\n\n");
  const ai = createAiClient(db);
  const response = await ai.complete({
    role: "large",
    // bare: the extraction reads the references with fresh eyes — it must not
    // be shaped by a previous profile or the editorial contract.
    system: { instructions: EXTRACT_INSTRUCTIONS, bare: true },
    messages: [{ role: "user", content: material }],
    maxTokens: 2000,
    projectId: job.projectId,
    jobId: job.id,
  });
  const fields = parseProfileJson(response.text);
  sqlite.transaction(() => {
    saveDraftProfile(db, job.projectId, fields);
    appendChange(db, {
      projectId: job.projectId,
      what: `Style profile draft extracted from ${refs.length} reference(s) (${fields.excerpts.length} excerpts)`,
      where: "style profile",
      why: "AI extraction over the attached reference files",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      { status: "draft", excerpts: fields.excerpts.length, model: response.model },
      1,
    );
  })();
};

const styleSample: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const profile = getStyleProfile(db, job.projectId);
  if (!profile) {
    throw new JobInputError(
      "There is no style profile yet. Extract one from references (or fill the form) first.",
    );
  }
  const raw = latestText(db, job.projectId, "raw");
  const source = listSources(db, job.projectId).find((s) => s.content.trim() !== "");
  const material = raw?.content ?? source?.content;
  if (!material) {
    throw new JobInputError(
      "No project material to sample. Add sources in Stage 1 — the sample rewrites " +
        "a passage of your own text with the profile.",
    );
  }
  markJobRunning(
    db,
    job.id,
    { from: raw ? `raw v${raw.version}` : `source "${source!.title}"` },
    1,
  );
  // Cut at a paragraph boundary so the model gets a coherent passage.
  let passage = material.slice(0, SAMPLE_SOURCE_CHARS);
  const lastBreak = passage.lastIndexOf("\n\n");
  if (lastBreak > SAMPLE_SOURCE_CHARS / 2) passage = passage.slice(0, lastBreak);
  const ai = createAiClient(db);
  const response = await ai.complete({
    role: "large",
    system: {
      instructions:
        "Rewrite the passage below applying the style profile, so the author can judge " +
        "the profile on their own material before it is applied to the whole book. " +
        "Keep the content and meaning; change only how it is written. " +
        "Respond with the rewritten passage only.",
      // Explicit: the sample must use the profile under review even while
      // it is still a draft (auto-injection only carries confirmed profiles).
      styleProfile: profile,
    },
    messages: [{ role: "user", content: passage }],
    maxTokens: 1500,
    projectId: job.projectId,
    jobId: job.id,
  });
  sqlite.transaction(() => {
    saveSamplePassage(db, job.projectId, response.text.trim());
    appendChange(db, {
      projectId: job.projectId,
      what: `Sample passage generated with style profile (${profile.status})`,
      where: "style profile",
      why: "preview the profile on the project's own material before confirming",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(db, job.id, { sampleChars: response.text.length }, 1);
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
 *  and a CONFIRMED style profile (a draft shapes nothing until confirmed). */
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
  const styleProfile = getConfirmedStyleProfile(db, projectId);
  if (!styleProfile) {
    throw new JobInputError(
      "Confirm the style profile first (stage 3) — only a confirmed profile " +
        "shapes generated text.",
    );
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
          stageKey: "passB",
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

// --- Stage 6.4: AI image generation -----------------------------------------
// Generates an image from a prompt through the AI seam and files it straight
// into the review grid (status 'review', origin 'ai'), so a newly generated
// image is seen before it is ever placed. The AI-origin credit line follows
// automatically from the stored origin when the credits section is rebuilt.

interface GenerateImageParams {
  prompt: string;
  caption?: string;
}

function parseGenerateImageParams(raw: string): GenerateImageParams {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = {};
  }
  const d = (data ?? {}) as Record<string, unknown>;
  const prompt = typeof d.prompt === "string" ? d.prompt.trim() : "";
  if (!prompt) {
    throw new JobInputError(
      "No prompt was given for the image. Describe the image to generate.",
    );
  }
  return { prompt, caption: typeof d.caption === "string" ? d.caption : "" };
}

const generateImageExec: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const project = getProject(db, job.projectId);
  if (!project) throw new JobInputError("Project not found.");
  const params = parseGenerateImageParams(job.input);
  markJobRunning(db, job.id, { prompt: params.prompt }, 1);
  const imageId = newId();
  const result = await aiFactory(db).generateImage({
    projectId: job.projectId,
    jobId: job.id,
    prompt: params.prompt,
  });
  const dims = readImageDimensions(result.data);
  const ext = result.mimeType.includes("jpeg") ? "jpg" : "png";
  const filename = `ai-${imageId}.${ext}`;
  const stored = saveImageFile(job.projectId, imageId, filename, result.data);
  sqlite.transaction(() => {
    addImage(db, {
      id: imageId,
      projectId: job.projectId,
      origin: "ai",
      filePath: stored.relativePath,
      originalName: filename,
      mimeType: result.mimeType,
      sizeBytes: stored.sizeBytes,
      checksumSha1: stored.checksumSha1,
      widthPx: dims?.width ?? 0,
      heightPx: dims?.height ?? 0,
      caption: params.caption,
      aiModel: result.model,
      aiPrompt: params.prompt,
    });
    // Keep the mandatory credits section in step with the new AI image.
    regenerateImageCredits(db, job.projectId, project.author);
    appendChange(db, {
      projectId: job.projectId,
      what: `AI image generated (${result.model}) and added to the review grid`,
      where: "stage 7 · images",
      why: "author requested an AI-generated illustration",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      { imageId, model: result.model, width: dims?.width ?? 0, height: dims?.height ?? 0 },
      1,
    );
  })();
};

// --- Stage 5: acoustic audience-reaction detection (spec §4 stage 3.4) -------
// DSP finds candidate reactions (no AI); the semantic check (AI, swappable)
// confirms the preceding sentence is funny/forceful. Only double-evidence
// candidates become review items, each carrying its audio clip. A quiet room
// produces an empty, zero-candidate success — never a false positive.

export function reactionLabel(kind: "laughter" | "applause"): string {
  return kind === "laughter" ? "Laughter" : "Applause";
}

/** The transcript a source's reactions are aligned against. */
function transcriptForSource(
  db: Db,
  projectId: string,
  src: ReturnType<typeof listSources>[number],
): string {
  const linked = src.linkedSourceId ? getSource(db, src.linkedSourceId) : undefined;
  return (
    linked?.content ||
    latestText(db, projectId, "passA")?.content ||
    src.content ||
    ""
  );
}

const detectReactions: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const contract = requireContract(db, job.projectId);
  const audioSources = listSources(db, job.projectId).filter(
    (s) =>
      (s.mediaType === "audio" || s.mediaType === "video" || s.kind === "audio") &&
      !!s.originalPath,
  );
  if (audioSources.length === 0) {
    throw new JobInputError(
      "No audio recording to analyze. Add an audio source, or mark reactions " +
        "by hand on the player (manual marking).",
    );
  }
  markJobRunning(db, job.id, { sources: audioSources.map((s) => s.id) }, 1);

  const client = aiFactory(db);
  const styleProfile = getConfirmedStyleProfile(db, job.projectId);
  const semanticCheck = aiSemanticChecker(client, {
    projectId: job.projectId,
    jobId: job.id,
    contract,
    styleProfile,
  });

  // All slow work (decode, DSP, semantic calls, clip extraction) happens before
  // the single write transaction.
  const pending: Array<{
    sourceId: string;
    candidate: ReactionCandidate;
    clipPath: string;
  }> = [];
  let analyzed = 0;
  let skipped = 0;
  for (const src of audioSources) {
    let audio: DecodedAudio;
    try {
      audio = decodeWav(readOriginal(src.originalPath!));
    } catch {
      // Not decodable without ffmpeg (mp3/m4a): skip gracefully, like ingest.
      skipped++;
      continue;
    }
    analyzed++;
    const transcript = transcriptForSource(db, job.projectId, src);
    const candidates = await findReactionCandidates({
      audio,
      transcript,
      durationSeconds: src.durationSeconds ?? undefined,
      semanticCheck,
    });
    for (const candidate of candidates) {
      if (!candidate.hasDoubleEvidence) continue;
      const clipPath = writeDerived(
        job.projectId,
        src.id,
        `reaction-${candidate.detected.startMs}-${candidate.detected.kind}.wav`,
        sliceClipWav(audio, candidate.detected.startMs, candidate.detected.endMs),
      );
      pending.push({ sourceId: src.id, candidate, clipPath });
    }
  }

  sqlite.transaction(() => {
    for (const { sourceId, candidate, clipPath } of pending) {
      const d = candidate.detected;
      const reaction = addReaction(db, {
        projectId: job.projectId,
        sourceId,
        kind: d.kind,
        startMs: d.startMs,
        endMs: d.endMs,
        clipPath,
        acoustic: {
          rms: d.rms,
          zcr: d.zcr,
          modulation: d.modulation,
          frameCount: d.frameCount,
        },
        semantic: candidate.semantic.note,
        origin: "acoustic",
        status: "candidate",
        charAnchor: candidate.charAnchor,
      });
      addReviewItem(db, {
        projectId: job.projectId,
        itemType: "reaction",
        excerpt: candidate.precedingSentence.slice(0, 160),
        question:
          `Audience ${d.kind} detected after this line (acoustic + semantic ` +
          `evidence) — confirm to insert *[${reactionLabel(d.kind)}]*?`,
        clipPath,
        refId: reaction.id,
      });
      appendChange(db, {
        projectId: job.projectId,
        what: `Candidate ${d.kind} reaction detected at ${d.startMs}–${d.endMs} ms`,
        where: "stage 5 · reactions",
        why: "double evidence: acoustic DSP + semantic check of the preceding line",
        authorizedBy: `job ${job.type} (${job.id})`,
      });
    }
    appendChange(db, {
      projectId: job.projectId,
      what:
        `Reaction detection: ${pending.length} candidate(s) from ${analyzed} ` +
        `recording(s)${skipped > 0 ? `, ${skipped} skipped (not WAV-decodable)` : ""}`,
      where: "stage 5 · reactions",
      why: "acoustic audience-reaction pass over the linked recordings",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      { analyzed, skipped, candidates: pending.length },
      1,
    );
  })();
};

export const EXECUTORS: Record<string, Executor> = {
  ingest_sources: ingestSources,
  transcribe_audio: transcribeAudio,
  tone_samples: toneSamples,
  extract_style: extractStyle,
  style_sample: styleSample,
  cleanup_pass_a: cleanupPassA,
  detect_reactions: detectReactions,
  refine_pass_b: refinePassB,
  classify_inconsistencies: classifyInconsistenciesExec,
  propose_outline: proposeOutlineExec,
  generate_style_sample: generateStyleSampleExec,
  generate_master_text: generateMasterTextExec,
  propose_apparatus: proposeApparatusExec,
  generate_image: generateImageExec,
  finalize_text: finalizeText,
  render_pdf: renderPdf,
  export_book: exportBook,
};
