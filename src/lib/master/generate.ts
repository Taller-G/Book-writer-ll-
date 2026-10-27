import type { AiClient } from "../ai";
import { estimateTokens } from "../ai/estimate";
import type { EditorialContract, NormalizationRule, StyleProfile } from "../db/schema";
import type { OutlineData } from "./chapters";
import { chunkSegments, joinSegments, segmentsById, type Segment } from "./segments";

// Master-text generation (spec §4, stage 4, editorial prose mode). One AI
// call per chapter — a chapter whose material exceeds the per-call budget is
// generated in sequential parts. EVERY call re-injects the editorial
// contract, the style profile (via SystemContext) and an explicit book-state
// summary; nothing relies on the model's implicit memory between calls.

export interface GenerateArgs {
  projectId: string;
  jobId: string;
  bookTitle: string;
  contract: EditorialContract;
  styleProfile: StyleProfile;
  outline: OutlineData;
  segments: Segment[];
  /** Enabled 'prompt'-kind normalization rules, injected into instructions. */
  promptRules: NormalizationRule[];
  /** The user-approved style sample the text must stay consistent with. */
  approvedSample: string;
}

export interface GenerateOptions {
  /** Max source tokens per generation call; bigger chapters are split. */
  chapterInputBudget?: number;
  /** Characters of the previous chapter's tail carried into the next call. */
  transitionTailChars?: number;
}

const DEFAULT_CHAPTER_BUDGET = 24_000;
const DEFAULT_TAIL_CHARS = 600;

export interface GeneratedChapter {
  chapterId: string;
  title: string;
  part: string;
  text: string;
  calls: number;
}

const GENERATION_INSTRUCTIONS =
  "You are ghost-writing one chapter of a book from cleaned raw material " +
  "(talks/transcripts), in editorial prose mode. Rewrite the material as " +
  "flowing book prose in the material's language, following the editorial " +
  "contract and style profile strictly. Requirements: remove timestamps, " +
  "podcast-style intros/outros and spoken-medium artifacts; where the book's " +
  "leitmotifs listed below reappear, keep them deliberately as recurring " +
  "motifs instead of deleting the repetition; open the chapter with a " +
  "transition that flows naturally from the end of the previous chapter " +
  "(provided in the book state); do not invent facts or stories not present " +
  "in the material. Respond with ONLY the chapter's prose — no headings, no " +
  "preamble, no commentary.";

const SAMPLE_INSTRUCTIONS =
  "You are ghost-writing a SHORT style sample (2–3 paragraphs) showing how " +
  "this book will sound in editorial prose mode. Rewrite the given material " +
  "excerpt as book prose in the material's language, strictly following the " +
  "editorial contract and style profile. Respond with ONLY the sample prose.";

function promptRulesBlock(rules: NormalizationRule[]): string {
  const active = rules.filter((r) => r.kind === "prompt" && r.enabled === 1);
  if (active.length === 0) return "";
  return (
    "Orthotypographic rules to apply while writing:\n" +
    active.map((r) => `- ${r.label}: ${r.explanation}`).join("\n")
  );
}

/** The explicit book-state summary re-injected on every generation call. */
export function buildBookState(args: {
  bookTitle: string;
  outline: OutlineData;
  writtenTitles: string[];
  previousTail: string;
  approvedSample: string;
}): string {
  const { outline } = args;
  const toc = outline.chapters
    .map((c, i) => {
      const written = args.writtenTitles.includes(c.title);
      const part = c.part ? ` (${c.part})` : "";
      return `${i + 1}. ${c.title}${part} — ${written ? "already written" : "pending"}. ${c.summary}`;
    })
    .join("\n");
  const parts = [
    `Book state — "${args.bookTitle}"`,
    `Confirmed table of contents:\n${toc}`,
    outline.leitmotifs.length > 0
      ? `Deliberate leitmotifs to keep recurring:\n- ${outline.leitmotifs.join("\n- ")}`
      : "",
    args.previousTail
      ? `End of the previous chapter (write a transition from here):\n…${args.previousTail}`
      : "This is the book's first chapter.",
    `Approved style sample the prose must stay consistent with:\n${args.approvedSample}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

export async function generateMasterText(
  ai: AiClient,
  args: GenerateArgs,
  options: GenerateOptions = {},
): Promise<{ chapters: GeneratedChapter[]; aiCalls: number }> {
  const budget = options.chapterInputBudget ?? DEFAULT_CHAPTER_BUDGET;
  const tailChars = options.transitionTailChars ?? DEFAULT_TAIL_CHARS;
  const chapters: GeneratedChapter[] = [];
  const writtenTitles: string[] = [];
  let previousTail = "";
  let aiCalls = 0;

  for (const chapter of args.outline.chapters) {
    const source = segmentsById(args.segments, chapter.segmentIds);
    const parts = chunkSegments(source, budget, estimateTokens);
    let text = "";
    for (let i = 0; i < parts.length; i++) {
      const bookState = buildBookState({
        bookTitle: args.bookTitle,
        outline: args.outline,
        writtenTitles,
        previousTail: i === 0 ? previousTail : text.slice(-tailChars),
        approvedSample: args.approvedSample,
      });
      const continuation =
        parts.length > 1
          ? `\n\nThis chapter is generated in ${parts.length} consecutive parts; ` +
            `this is part ${i + 1}. ${
              i > 0
                ? "Continue the chapter seamlessly from the previous part's tail " +
                  "shown in the book state — do not restart or re-introduce it."
                : ""
            }`
          : "";
      const res = await ai.complete({
        role: "large",
        projectId: args.projectId,
        jobId: args.jobId,
        system: {
          instructions: [GENERATION_INSTRUCTIONS, promptRulesBlock(args.promptRules)]
            .filter(Boolean)
            .join("\n\n"),
          contract: args.contract,
          styleProfile: args.styleProfile,
        },
        messages: [
          {
            role: "user",
            content:
              `${bookState}\n\n` +
              `Chapter to write now: "${chapter.title}"` +
              (chapter.part ? ` — ${chapter.part}` : "") +
              `\nChapter intent: ${chapter.summary}\n` +
              (chapter.themes.length > 0
                ? `Chapter themes: ${chapter.themes.join(", ")}\n`
                : "") +
              continuation +
              `\n\nSource material for this chapter:\n\n${joinSegments(parts[i])}`,
          },
        ],
      });
      aiCalls++;
      text = text ? `${text}\n\n${res.text.trim()}` : res.text.trim();
    }
    chapters.push({
      chapterId: chapter.id,
      title: chapter.title,
      part: chapter.part,
      text,
      calls: parts.length,
    });
    writtenTitles.push(chapter.title);
    previousTail = text.slice(-tailChars);
  }
  return { chapters, aiCalls };
}

/** Assemble the generated chapters into the master text (passB content). */
export function assembleMasterText(chapters: GeneratedChapter[]): string {
  const blocks: string[] = [];
  let currentPart = "";
  for (const c of chapters) {
    if (c.part && c.part !== currentPart) {
      blocks.push(`## ${c.part}`);
      currentPart = c.part;
    }
    blocks.push(`## ${c.title}`);
    blocks.push(c.text);
  }
  return blocks.join("\n\n");
}

/** A short pre-generation sample for the user to approve the voice. */
export async function generateStyleSample(
  ai: AiClient,
  args: {
    projectId: string;
    jobId: string;
    contract: EditorialContract;
    styleProfile: StyleProfile;
    segments: Segment[];
  },
  options: { sampleInputBudget?: number } = {},
): Promise<string> {
  const budget = options.sampleInputBudget ?? 4_000;
  const excerpt = chunkSegments(args.segments, budget, estimateTokens)[0] ?? [];
  const res = await ai.complete({
    role: "large",
    projectId: args.projectId,
    jobId: args.jobId,
    system: {
      instructions: SAMPLE_INSTRUCTIONS,
      contract: args.contract,
      styleProfile: args.styleProfile,
    },
    messages: [
      { role: "user", content: `Material excerpt:\n\n${joinSegments(excerpt)}` },
    ],
  });
  return res.text.trim();
}
