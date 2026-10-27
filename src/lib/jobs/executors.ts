import fs from "node:fs";
import path from "node:path";
import { createAiClient, type AiClient } from "../ai";
import { destinationOption, TONES } from "../contract/definitions";
import { dataDir, type Db, type DbHandle } from "../db/client";
import type { EditorialContract, Job, StyleProfile } from "../db/schema";
import { proposeApparatus } from "../master/apparatus";
import {
  draftBackCover,
  iterateCover,
  proposeCoverConcepts,
  regenerateConcept,
} from "../cover/concepts";
import {
  getConcept,
  oldestPendingIteration,
  parseRegion,
  resolveIteration,
  saveProposedBackCover,
  saveProposedConcepts,
  saveTitleOptions,
  updateConceptDraft,
} from "../repo/covers";
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
  getConfirmedStyleProfile,
  getContract,
  getStyleProfile,
  getStyleSample,
  saveDraftProfile,
  saveSamplePassage,
  saveStyleSample,
  type StyleProfileFields,
} from "../repo/editorial";
import { markJobRunning, markJobSucceeded } from "../repo/jobs";
import { ensureRules } from "../repo/normalization";
import { getFormatConfig, insertPdfVersion, nextPdfVersion } from "../repo/output";
import { getOutline, parseOutlineData, saveProposedOutline } from "../repo/outline";
import { getProject } from "../repo/projects";
import { addReviewItem, countPendingReviews } from "../repo/review";
import { listSources } from "../repo/sources";
import { listStyleRefs } from "../repo/styleRefs";
import { insertText, latestText, nextTextVersion } from "../repo/texts";
import { renderBook } from "../render/render";

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
  await breathe();
  const { output, changes, blocked } = cleanupTransform(raw.content, allowRewrites);
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
      what: `Cleanup Pass A produced passA v${version} from raw v${raw.version} (${changes.length} change group(s), ${blocked.length} blocked by contract)`,
      where: "stage 4 · passA text",
      why: "first cleanup pass over the transcription",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      {
        stageTextId: text.id,
        stageKey: "passA",
        changeGroups: changes.length,
        blockedByContract: blocked.length,
        contractVersion: contract.version,
      },
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
  const contract = requireContract(db, job.projectId);
  // Pass B is a rewrite pass: under a verbatim contract it must not touch
  // the text — it passes it through unchanged and says so on the record.
  const allowRewrites = contract.mode !== "verbatim";
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
  const paragraphs = passA.content
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const longOnes = allowRewrites
    ? paragraphs
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.split(/\s+/).length > 120)
    : [];
  const output = allowRewrites ? paragraphs.join("\n\n") : passA.content;
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
      what: allowRewrites
        ? `Refine Pass B produced passB v${version} from passA v${passA.version}; flagged ${longOnes.length} item(s) for review`
        : `Refine Pass B passed passA v${passA.version} through unchanged as passB v${version} — verbatim contract blocks rewrites`,
      where: "stage 5 · passB text",
      why: `structure and flow pass within editorial contract v${contract.version} (${contract.mode})`,
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      {
        stageTextId: text.id,
        stageKey: "passB",
        flagged: longOnes.length,
        rewritesBlocked: !allowRewrites,
        contractVersion: contract.version,
      },
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
  markJobRunning(
    db,
    job.id,
    { stageKey: "final", version: finalText.version, trimSize: format.trimSize },
    finalText.version,
  );
  const version = nextPdfVersion(db, job.projectId);
  const outDir = path.join(dataDir(), "exports", job.projectId);
  const result = await renderBook({
    approvedText: finalText.content,
    format,
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
    appendChange(db, {
      projectId: job.projectId,
      what:
        `PDF v${version} rendered (${path.basename(result.pdfPath)}); QA ` +
        (result.qaReport.passed
          ? "passed all checks"
          : `failed: ${failing.map((c) => c.id).join(", ")}`),
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
      },
      version,
    );
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
  // The contract's destination decides the legal page, the ISBN placeholder
  // and the color profile of the export.
  const contract = getContract(db, job.projectId);
  const destination = contract?.destination
    ? destinationOption(contract.destination)
    : undefined;
  markJobRunning(
    db,
    job.id,
    {
      stageKey: "final",
      version: finalText.version,
      trimSize: format.trimSize,
      contractVersion: contract?.version,
      destination: contract?.destination,
      colorProfile: destination?.colorProfile,
    },
    finalText.version,
  );
  await breathe();
  const version = nextPdfVersion(db, job.projectId);
  const dir = path.join(dataDir(), "exports", job.projectId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `book-v${version}.html`);
  const legalBlocks: string[] = [];
  if (contract?.legalText.trim()) {
    legalBlocks.push(
      ...contract.legalText
        .split(/\n\n+/)
        .map((p) => `<p>${escapeHtml(p.trim())}</p>`),
    );
  }
  if (destination?.needsIsbn && !/ISBN/i.test(contract?.legalText ?? "")) {
    legalBlocks.push(`<p>ISBN: ___-__-_____-__-_ (to be assigned)</p>`);
  }
  const frontMatter =
    legalBlocks.length > 0
      ? `<section class="legal">${legalBlocks.join("\n")}</section>\n<hr>\n`
      : "";
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
${destination ? `<meta name="color-profile" content="${destination.colorProfile}">\n` : ""}<style>body{font-family:${format.fontFamily},serif;font-size:${format.fontSizePt}pt;line-height:${format.lineHeight};max-width:40em;margin:2em auto;}</style>
</head><body>${frontMatter}${body}</body></html>`,
  );
  sqlite.transaction(() => {
    const pdf = insertPdfVersion(db, {
      projectId: job.projectId,
      version,
      filePath,
      notes:
        `Export from FINAL v${finalText.version}, trim ${format.trimSize}` +
        (destination
          ? `, destination ${destination.label} (${destination.colorProfile})`
          : ""),
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

// --- Stage 7: cover design (spec §4 Stage 7) ----------------------------
// Four AI executors, all routed through the swappable aiFactory so tests
// inject a fake. propose/regenerate shape cover concepts; draft_back_cover is
// grounded in the FINAL text; iterate_cover carries a marked region to the
// agent. Each follows the house rule: AI work first, one success transaction.

/** A short synopsis of the book for grounding cover concepts: the opening of
 *  the best available text, headings stripped. */
function bookSynopsis(db: Db, projectId: string): string {
  const text =
    latestText(db, projectId, "final") ??
    latestText(db, projectId, "passB") ??
    latestText(db, projectId, "passA") ??
    latestText(db, projectId, "raw");
  if (!text) return "";
  return text.content
    .split(/\n+/)
    .filter((l) => !l.trim().startsWith("#"))
    .join(" ")
    .slice(0, 1_500)
    .trim();
}

const proposeCoverConceptsExec: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const project = getProject(db, job.projectId);
  if (!project) throw new JobInputError("Project not found.");
  const contract = getContract(db, job.projectId);
  if (!contract) {
    throw new JobInputError(
      "Sign the editorial contract (Stage 2) before proposing covers.",
    );
  }
  markJobRunning(db, job.id, { title: project.title, tone: contract.tone }, 1);
  const { concepts, titleOptions, aiCalls } = await proposeCoverConcepts(
    aiFactory(db),
    {
      projectId: job.projectId,
      jobId: job.id,
      bookTitle: project.title,
      author: project.author,
      contract,
      styleProfile: getConfirmedStyleProfile(db, job.projectId) ?? undefined,
      synopsis: bookSynopsis(db, job.projectId),
    },
  );
  sqlite.transaction(() => {
    const saved = saveProposedConcepts(db, job.projectId, concepts, job.id);
    saveTitleOptions(db, job.projectId, titleOptions, job.id);
    appendChange(db, {
      projectId: job.projectId,
      what: `Proposed ${saved.length} cover concept(s) and ${titleOptions.length} title option(s)`,
      where: "stage 7 · covers",
      why: "AI cover proposal from title, genre/tone and synopsis",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      { approaches: saved.map((c) => c.approach), titleOptions: titleOptions.length, aiCalls },
      1,
    );
  })();
};

const regenerateCoverConceptExec: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const params = JSON.parse(job.input || "{}") as { conceptId?: string };
  const concept = params.conceptId ? getConcept(db, params.conceptId) : undefined;
  if (!concept || concept.projectId !== job.projectId) {
    throw new JobInputError("The concept to regenerate was not found.");
  }
  if (concept.source !== "ai") {
    throw new JobInputError("Only AI concepts can be regenerated.");
  }
  const project = getProject(db, job.projectId)!;
  const contract = getContract(db, job.projectId);
  if (!contract) throw new JobInputError("Sign the editorial contract first.");
  markJobRunning(db, job.id, { conceptId: concept.id, approach: concept.approach }, 1);
  const draft = await regenerateConcept(aiFactory(db), {
    projectId: job.projectId,
    jobId: job.id,
    bookTitle: project.title,
    author: project.author,
    contract,
    styleProfile: getConfirmedStyleProfile(db, job.projectId) ?? undefined,
    synopsis: bookSynopsis(db, job.projectId),
    approach: concept.approach,
    avoid: concept.title,
  });
  sqlite.transaction(() => {
    updateConceptDraft(db, concept.id, draft, job.id);
    appendChange(db, {
      projectId: job.projectId,
      what: `Regenerated the "${concept.approach}" cover concept`,
      where: `stage 7 · covers · ${concept.approach}`,
      why: "user asked for a fresh take on this concept",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(db, job.id, { conceptId: concept.id, approach: concept.approach }, 1);
  })();
};

const draftBackCoverExec: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const finalText = latestText(db, job.projectId, "final");
  if (!finalText) {
    throw new JobInputError(
      "The back cover is drafted from the FINAL text — finalize the text in Review first.",
    );
  }
  const project = getProject(db, job.projectId)!;
  const contract = getContract(db, job.projectId);
  if (!contract) throw new JobInputError("Sign the editorial contract first.");
  markJobRunning(db, job.id, { stageKey: "final", version: finalText.version }, finalText.version);
  const { drafts, quoteVerified, aiCalls } = await draftBackCover(aiFactory(db), {
    projectId: job.projectId,
    jobId: job.id,
    bookTitle: project.title,
    author: project.author,
    contract,
    styleProfile: getConfirmedStyleProfile(db, job.projectId) ?? undefined,
    finalText: finalText.content,
  });
  sqlite.transaction(() => {
    const saved = saveProposedBackCover(db, job.projectId, drafts, job.id);
    appendChange(db, {
      projectId: job.projectId,
      what:
        `Drafted back-cover content (${saved.map((s) => s.sectionKey).join(", ")}); ` +
        `quote ${quoteVerified ? "verified against" : "fell back to a sentence from"} the book text`,
      where: "stage 7 · back cover",
      why: "guided back-cover drafting from the book's actual content",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(
      db,
      job.id,
      { sections: saved.map((s) => s.sectionKey), quoteVerified, aiCalls },
      finalText.version,
    );
  })();
};

const iterateCoverExec: Executor = async (handle, job) => {
  const { db, sqlite } = handle;
  const pending = oldestPendingIteration(db, job.projectId);
  if (!pending) {
    throw new JobInputError("There is no pending cover annotation to answer.");
  }
  const project = getProject(db, job.projectId)!;
  const contract = getContract(db, job.projectId);
  if (!contract) throw new JobInputError("Sign the editorial contract first.");
  const concept = pending.conceptId ? getConcept(db, pending.conceptId) : undefined;
  markJobRunning(db, job.id, { iterationId: pending.id, target: pending.target }, 1);
  const { response, aiCalls } = await iterateCover(aiFactory(db), {
    projectId: job.projectId,
    jobId: job.id,
    bookTitle: project.title,
    contract,
    styleProfile: getConfirmedStyleProfile(db, job.projectId) ?? undefined,
    concept: concept
      ? {
          approach: concept.approach,
          title: concept.title,
          subtitle: concept.subtitle,
          tagline: concept.tagline,
          rationale: concept.rationale,
          imagery: concept.imagery,
        }
      : undefined,
    target: pending.target,
    region: parseRegion(pending.region),
    note: pending.note,
  });
  sqlite.transaction(() => {
    resolveIteration(db, pending.id, response, job.id);
    appendChange(db, {
      projectId: job.projectId,
      what: `Cover agent answered an annotation on the ${pending.target}`,
      where: "stage 7 · cover iteration",
      why: "user annotated the cover preview and asked for a revision",
      authorizedBy: `job ${job.type} (${job.id})`,
    });
    markJobSucceeded(db, job.id, { iterationId: pending.id, aiCalls }, 1);
  })();
};

export const EXECUTORS: Record<string, Executor> = {
  ingest_sources: ingestSources,
  tone_samples: toneSamples,
  extract_style: extractStyle,
  style_sample: styleSample,
  cleanup_pass_a: cleanupPassA,
  refine_pass_b: refinePassB,
  propose_outline: proposeOutlineExec,
  generate_style_sample: generateStyleSampleExec,
  generate_master_text: generateMasterTextExec,
  propose_apparatus: proposeApparatusExec,
  finalize_text: finalizeText,
  render_pdf: renderPdf,
  export_book: exportBook,
  propose_cover_concepts: proposeCoverConceptsExec,
  regenerate_cover_concept: regenerateCoverConceptExec,
  draft_back_cover: draftBackCoverExec,
  iterate_cover: iterateCoverExec,
};
