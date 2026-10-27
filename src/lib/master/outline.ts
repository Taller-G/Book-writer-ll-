import type { AiClient } from "../ai";
import { estimateTokens } from "../ai/estimate";
import type { EditorialContract, StyleProfile } from "../db/schema";
import { newId } from "../util";
import type { OutlineChapter, OutlineData } from "./chapters";
import { parseJsonObject } from "./json";
import { chunkSegments, joinSegments, type Segment } from "./segments";

// AI analysis of the cleaned material (spec §4, stage 4): find themes,
// repetitions and stories, and propose a parts/chapters architecture with
// titles. When the material exceeds one analysis call, chunks are first
// condensed with the 'fast' role — the final 'large' call then works over
// summaries, never relying on implicit model memory.

export interface ProposeOutlineArgs {
  projectId: string;
  jobId: string;
  bookTitle: string;
  segments: Segment[];
  contract: EditorialContract;
  styleProfile: StyleProfile;
}

export interface ProposeOutlineOptions {
  /** Max input tokens per analysis call before chunked summarization kicks in. */
  analysisInputBudget?: number;
}

const DEFAULT_ANALYSIS_BUDGET = 60_000;

interface RawOutline {
  chapters?: Array<{
    title?: string;
    part?: string;
    summary?: string;
    themes?: string[];
    segmentIds?: number[];
  }>;
  leitmotifs?: string[];
  analysisNotes?: string;
}

const OUTLINE_INSTRUCTIONS =
  "You are a book editor analyzing cleaned raw material (talks, transcripts, " +
  "notes) to design the structure of a book. Identify the themes, the " +
  "repetitions (candidates to become deliberate leitmotifs) and the stories " +
  "the material contains, then propose a parts/chapters architecture with " +
  "evocative titles in the material's language. Every chapter must reference " +
  "the source segments it draws from by their numeric ids. Respond with ONLY " +
  "a JSON object shaped as: {\"chapters\": [{\"title\": string, \"part\": " +
  "string (optional, empty when the book needs no parts), \"summary\": " +
  "string (one paragraph), \"themes\": [string], \"segmentIds\": [number]}], " +
  "\"leitmotifs\": [string], \"analysisNotes\": string}.";

const SUMMARY_INSTRUCTIONS =
  "You are condensing raw book material so an editor can design the book's " +
  "structure. For EACH numbered segment, write one line in the form " +
  "\"#<id>: <summary>\" capturing its topic, any story told, and phrases " +
  "that repeat across the material. Keep every segment id. Respond with only " +
  "those lines.";

function numberedSegments(segments: Segment[]): string {
  return segments.map((s) => `#${s.id}: ${s.text}`).join("\n\n");
}

export async function proposeOutline(
  ai: AiClient,
  args: ProposeOutlineArgs,
  options: ProposeOutlineOptions = {},
): Promise<{ outline: OutlineData; aiCalls: number }> {
  const budget = options.analysisInputBudget ?? DEFAULT_ANALYSIS_BUDGET;
  const { segments } = args;
  let aiCalls = 0;

  // Material that fits goes to the analysis call verbatim; oversized material
  // is first condensed chunk by chunk with the 'fast' role.
  let analysisInput = numberedSegments(segments);
  if (estimateTokens(joinSegments(segments)) > budget) {
    const chunks = chunkSegments(segments, budget, estimateTokens);
    const summaries: string[] = [];
    for (const chunk of chunks) {
      const res = await ai.complete({
        role: "fast",
        projectId: args.projectId,
        jobId: args.jobId,
        system: {
          instructions: SUMMARY_INSTRUCTIONS,
          contract: args.contract,
          styleProfile: args.styleProfile,
        },
        messages: [{ role: "user", content: numberedSegments(chunk) }],
      });
      aiCalls++;
      summaries.push(res.text.trim());
    }
    analysisInput =
      "Per-segment summaries of the material (condensed from the full text):\n\n" +
      summaries.join("\n");
  }

  const res = await ai.complete({
    role: "large",
    projectId: args.projectId,
    jobId: args.jobId,
    system: {
      instructions: OUTLINE_INSTRUCTIONS,
      contract: args.contract,
      styleProfile: args.styleProfile,
    },
    messages: [
      {
        role: "user",
        content:
          `Book working title: ${args.bookTitle}\n` +
          `Total segments: ${segments.length} (ids 0–${segments.length - 1})\n\n` +
          analysisInput,
      },
    ],
  });
  aiCalls++;

  const raw = parseJsonObject<RawOutline>(res.text);
  const maxId = segments.length - 1;
  const chapters: OutlineChapter[] = (raw.chapters ?? [])
    .map((c) => ({
      id: newId(),
      title: typeof c.title === "string" && c.title.trim() ? c.title.trim() : "Untitled chapter",
      part: typeof c.part === "string" ? c.part.trim() : "",
      summary: typeof c.summary === "string" ? c.summary : "",
      themes: Array.isArray(c.themes) ? c.themes.filter((t) => typeof t === "string") : [],
      segmentIds: Array.isArray(c.segmentIds)
        ? c.segmentIds.filter(
            (id): id is number =>
              typeof id === "number" && Number.isInteger(id) && id >= 0 && id <= maxId,
          )
        : [],
    }))
    .filter((c) => c.segmentIds.length > 0);
  if (chapters.length === 0) {
    throw new Error(
      "The analysis returned no usable chapters. Retry the outline proposal.",
    );
  }
  return {
    outline: {
      chapters,
      leitmotifs: Array.isArray(raw.leitmotifs)
        ? raw.leitmotifs.filter((l) => typeof l === "string")
        : [],
      analysisNotes: typeof raw.analysisNotes === "string" ? raw.analysisNotes : "",
    },
    aiCalls,
  };
}
