import type { AiClient } from "../ai";
import type { EditorialContract, StyleProfile } from "../db/schema";
import { detectReactions, type DetectedReaction, type ReactionDspOptions } from "./dsp";
import type { DecodedAudio } from "./wav";

// Second evidence track for audience reactions (spec §4 stage 3.4). Acoustic
// detection alone is not trusted: a candidate is only emitted when the
// PRECEDING sentence is independently judged funny (→ laughter) or forceful
// (→ applause). The acoustic half is AI-free DSP (dsp.ts); this semantic half
// is a small AI call behind the swappable client, so a quiet room never gets a
// reaction and a loud cough over flat prose is filtered out.

export interface SemanticVerdict {
  funny: boolean;
  forceful: boolean;
  note: string;
}

export type SemanticChecker = (
  precedingSentence: string,
  kind: DetectedReaction["kind"],
) => Promise<SemanticVerdict>;

export interface ReactionCandidate {
  detected: DetectedReaction;
  /** The sentence that ends just before the reaction, by time→text mapping. */
  precedingSentence: string;
  /** Character offset in the transcript where the reaction belongs. */
  charAnchor: number;
  semantic: SemanticVerdict;
  /** Acoustic AND semantic both support the reaction. */
  hasDoubleEvidence: boolean;
}

/** Map an audio timestamp to a character offset in the aligned transcript. */
export function msToCharOffset(
  ms: number,
  totalDurationMs: number,
  textLength: number,
): number {
  if (totalDurationMs <= 0 || textLength <= 0) return textLength;
  const ratio = Math.min(1, Math.max(0, ms / totalDurationMs));
  return Math.round(ratio * textLength);
}

/** The last complete sentence ending at or before `charOffset`. */
export function precedingSentence(text: string, charOffset: number): string {
  const head = text.slice(0, Math.min(charOffset, text.length));
  // Split on sentence terminators (Latin + Spanish ¿¡ handled by the trailing
  // punctuation), keeping it simple and deterministic.
  const parts = head
    .split(/(?<=[.!?…»])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : head.trim();
}

/** True when the semantic verdict backs the detected reaction kind. */
export function supportsKind(
  verdict: SemanticVerdict,
  kind: DetectedReaction["kind"],
): boolean {
  return kind === "laughter"
    ? verdict.funny
    : verdict.forceful || verdict.funny;
}

/**
 * Pair acoustic detections with the semantic judgement of their preceding
 * sentence. Returns every detection with its evidence; the caller emits the
 * double-evidence ones to the review queue.
 */
export async function findReactionCandidates(params: {
  audio: DecodedAudio;
  transcript: string;
  durationSeconds?: number;
  semanticCheck: SemanticChecker;
  dsp?: ReactionDspOptions;
}): Promise<ReactionCandidate[]> {
  const detected = detectReactions(params.audio.samples, params.audio.sampleRate, params.dsp);
  const totalMs =
    (params.durationSeconds ?? params.audio.frameCount / params.audio.sampleRate) * 1000;
  const candidates: ReactionCandidate[] = [];
  for (const d of detected) {
    const charAnchor = msToCharOffset(d.startMs, totalMs, params.transcript.length);
    const sentence = precedingSentence(params.transcript, charAnchor);
    const semantic = await params.semanticCheck(sentence, d.kind);
    candidates.push({
      detected: d,
      precedingSentence: sentence,
      charAnchor,
      semantic,
      hasDoubleEvidence: supportsKind(semantic, d.kind),
    });
  }
  return candidates;
}

const SEMANTIC_INSTRUCTIONS = `You judge whether a single sentence from a spoken talk would plausibly trigger an audience reaction. Reply with ONLY a JSON object, no prose, no code fences, with exactly these boolean/string fields:
- "funny": true if the sentence is a joke, witticism or clearly amusing (would draw laughter)
- "forceful": true if the sentence is a strong, rousing or applause-worthy statement (a call to action, a powerful closing line, a bold claim)
- "note": a very short reason (max 12 words)
Be conservative: plain, neutral, factual sentences are neither funny nor forceful.`;

/** Build a semantic checker backed by the project's AI client. */
export function aiSemanticChecker(
  client: AiClient,
  ctx: {
    projectId: string;
    jobId?: string;
    contract?: EditorialContract;
    styleProfile?: StyleProfile;
  },
): SemanticChecker {
  return async (sentence, kind) => {
    if (!sentence.trim()) return { funny: false, forceful: false, note: "no preceding text" };
    const res = await client.complete({
      role: "fast",
      projectId: ctx.projectId,
      jobId: ctx.jobId,
      // bare: the judgement must read the sentence plainly, not through the
      // book's voice.
      system: { instructions: SEMANTIC_INSTRUCTIONS, bare: true },
      messages: [
        {
          role: "user",
          content: `Detected reaction: ${kind}.\nPreceding sentence:\n"""${sentence}"""`,
        },
      ],
      maxTokens: 120,
    });
    return parseVerdict(res.text);
  };
}

/** Parse the semantic verdict JSON; anything unreadable is "no evidence". */
export function parseVerdict(text: string): SemanticVerdict {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const d = JSON.parse(stripped) as Record<string, unknown>;
    return {
      funny: d.funny === true,
      forceful: d.forceful === true,
      note: typeof d.note === "string" ? d.note : "",
    };
  } catch {
    return { funny: false, forceful: false, note: "unparseable verdict" };
  }
}
