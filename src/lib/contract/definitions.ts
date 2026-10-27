// The Stage 2 editorial-contract questions (spec §4): the plain-language
// options, the before/after examples that explain each mode, the predefined
// tones (with the instruction the tone-sample job sends to the model), the
// destination choices with their downstream consequences, and the legal-text
// proposals per authorship declaration. Shared by the Stage 2 UI, the
// executors, and the AI system prompt so one definition drives all three.

import type { EditorialContract } from "../db/schema";

export type ContractMode = EditorialContract["mode"];
export type ContractTone = NonNullable<EditorialContract["tone"]>;
export type ContractDestination = NonNullable<EditorialContract["destination"]>;
export type ContractAuthorship = NonNullable<EditorialContract["authorship"]>;

export interface ModeOption {
  value: ContractMode;
  label: string;
  help: string;
  /** Raw material, as the transcription has it. */
  exampleBefore: string;
  /** The same paragraph after this mode's passes. */
  exampleAfter: string;
  /** Hard rule injected into every AI call under this mode. */
  aiDirective: string;
}

const EXAMPLE_BEFORE =
  "Well, um, I arrived in the city in 1952, I think it was '52, and, " +
  "you know, there was no work, no work anywhere. My mother said " +
  "\"we eat what there is\" and that was that.";

export const MODES: ModeOption[] = [
  {
    value: "verbatim",
    label: "Verbatim (faithful)",
    help:
      "The text stays as spoken or written. Only transcription noise is " +
      "fixed — spacing, punctuation, obvious mishearings. No rewriting.",
    exampleBefore: EXAMPLE_BEFORE,
    exampleAfter:
      "Well, um, I arrived in the city in 1952, I think it was '52, and, " +
      "you know, there was no work, no work anywhere. My mother said " +
      "\"we eat what there is\" and that was that.",
    aiDirective:
      "VERBATIM MODE: do not rewrite, rephrase, restructure or remove any " +
      "words (including filler words and repetitions). Only fix mechanical " +
      "transcription noise: spacing, punctuation, obvious mishearings.",
  },
  {
    value: "prose",
    label: "Editorial prose",
    help:
      "The material is rewritten as polished prose. Meaning and facts are " +
      "preserved; wording, rhythm and structure are the editor's.",
    exampleBefore: EXAMPLE_BEFORE,
    exampleAfter:
      "I arrived in the city in 1952 to find no work anywhere. My mother " +
      "settled it the way she settled everything: we would eat what there was.",
    aiDirective:
      "PROSE MODE: rewrite the material as polished prose. Preserve meaning, " +
      "facts and the author's intent; wording and structure may change.",
  },
  {
    value: "hybrid",
    label: "Hybrid",
    help:
      "Quoted speech stays exactly as spoken; the narration around it " +
      "becomes polished prose.",
    exampleBefore: EXAMPLE_BEFORE,
    exampleAfter:
      "I arrived in the city in 1952 to find no work anywhere. My mother " +
      "said \"we eat what there is\" and that was that.",
    aiDirective:
      "HYBRID MODE: text inside quotation marks must stay exactly as spoken " +
      "— never rewrite a quote. Narration outside quotes may be rewritten " +
      "as polished prose, preserving meaning and facts.",
  },
];

export interface ToneOption {
  value: ContractTone;
  label: string;
  help: string;
  /** Sent to the model when generating this tone's sample and later passes. */
  instruction: string;
}

export const TONES: ToneOption[] = [
  {
    value: "neutral",
    label: "Neutral",
    help: "Clear and plain. Says what happened without decoration.",
    instruction:
      "Neutral tone: clear, plain, balanced sentences. No stylistic " +
      "flourishes, no dramatization; let the facts carry the weight.",
  },
  {
    value: "literary_cinematic",
    label: "Literary–cinematic",
    help: "Evocative and scene-driven. Shows places and moments like a film.",
    instruction:
      "Literary-cinematic tone: evocative, scene-driven prose with concrete " +
      "sensory detail and rhythm. Show moments rather than summarize them, " +
      "without inventing facts.",
  },
  {
    value: "academic",
    label: "Academic",
    help: "Precise and formal. Careful claims, measured distance.",
    instruction:
      "Academic tone: precise, formal register; measured, carefully " +
      "qualified claims; no colloquialisms.",
  },
  {
    value: "conversational",
    label: "Conversational",
    help: "Warm and direct, as if telling the story to a friend.",
    instruction:
      "Conversational tone: warm, direct, first-person ease, as if telling " +
      "the story to a friend. Natural contractions welcome; keep it honest, " +
      "not chatty.",
  },
];

export interface DestinationOption {
  value: ContractDestination;
  label: string;
  help: string;
  /** What this choice changes downstream (legal credits, ISBN, color). */
  downstream: string;
  needsIsbn: boolean;
  colorProfile: "sRGB" | "CMYK";
}

export const DESTINATIONS: DestinationOption[] = [
  {
    value: "personal",
    label: "Personal copy",
    help: "A copy for you and your family — not sold or distributed.",
    downstream:
      "Simple credits page, no ISBN, screen (sRGB) color profile.",
    needsIsbn: false,
    colorProfile: "sRGB",
  },
  {
    value: "short_run",
    label: "Short print run",
    help: "A small printed edition shared or sold informally.",
    downstream:
      "Credits and rights page, ISBN optional, print (CMYK) color profile.",
    needsIsbn: false,
    colorProfile: "CMYK",
  },
  {
    value: "isbn",
    label: "ISBN publication",
    help: "A formally published edition with an ISBN.",
    downstream:
      "Full legal page with ISBN and legal-deposit placeholders, print " +
      "(CMYK) color profile, distribution-ready credits.",
    needsIsbn: true,
    colorProfile: "CMYK",
  },
  {
    value: "digital",
    label: "Digital only",
    help: "An ebook or PDF distributed digitally.",
    downstream:
      "Digital rights line, optional e-ISBN, screen (sRGB) color profile.",
    needsIsbn: false,
    colorProfile: "sRGB",
  },
];

export interface AuthorshipOption {
  value: ContractAuthorship;
  label: string;
  help: string;
}

export const AUTHORSHIPS: AuthorshipOption[] = [
  {
    value: "own",
    label: "Entirely my own material",
    help: "Everything was created by you (or the person you represent).",
  },
  {
    value: "third_party",
    label: "Material by someone else",
    help: "Recordings, texts or images created by other people.",
  },
  {
    value: "mixed",
    label: "Mixed",
    help: "Your own material plus third-party quotes, images or excerpts.",
  },
];

export function modeOption(value: ContractMode): ModeOption {
  return MODES.find((m) => m.value === value)!;
}

export function toneOption(value: ContractTone): ToneOption {
  return TONES.find((t) => t.value === value)!;
}

export function destinationOption(
  value: ContractDestination,
): DestinationOption {
  return DESTINATIONS.find((d) => d.value === value)!;
}

export function authorshipOption(value: ContractAuthorship): AuthorshipOption {
  return AUTHORSHIPS.find((a) => a.value === value)!;
}

/**
 * Proposed legal/credits text for the chosen authorship and destination.
 * A proposal only — the user edits and owns the final wording.
 */
export function proposeLegalText(input: {
  authorship: ContractAuthorship;
  destination?: ContractDestination | null;
  author?: string;
  year?: number;
}): string {
  const year = input.year ?? new Date().getFullYear();
  const author = input.author?.trim() || "The author";
  const lines: string[] = [`© ${year} ${author}. All rights reserved.`];
  if (input.authorship === "third_party") {
    lines.push(
      "This work is based on material created by third parties and is " +
        "reproduced with the permission of the rights holders. No part of " +
        "the third-party material may be reproduced without their written " +
        "consent.",
    );
  }
  if (input.authorship === "mixed") {
    lines.push(
      "This work includes quotations, images or excerpts belonging to " +
        "third parties, reproduced with permission or under applicable " +
        "quotation rights. All other material © the author.",
    );
  }
  if (input.destination === "isbn") {
    lines.push("ISBN: ___-__-_____-__-_ (to be assigned)");
    lines.push("Legal deposit: pending.");
  }
  if (input.destination === "digital") {
    lines.push(
      "Digital edition. Unauthorized copying or redistribution of this " +
        "file is prohibited.",
    );
  }
  return lines.join("\n\n");
}

/**
 * The limitation warning shown when the user declares third-party material.
 * Null when there is nothing to warn about.
 */
export function authorshipWarning(
  authorship: ContractAuthorship | null | undefined,
  destination?: ContractDestination | null,
): string | null {
  if (authorship !== "third_party" && authorship !== "mixed") return null;
  const base =
    "You declared third-party material. This app cannot verify rights: you " +
    "must hold written permission (or a clear legal basis, such as " +
    "quotation rights) for every third-party recording, text or image " +
    "before distributing the book.";
  const commercial =
    destination && destination !== "personal"
      ? " Your chosen destination distributes copies beyond personal use — " +
        "distributing unlicensed third-party material may infringe copyright."
      : "";
  return base + commercial;
}
