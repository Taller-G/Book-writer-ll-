import type { AiClient } from "../ai";
import type { EditorialContract, StyleProfile } from "../db/schema";
import { parseJsonObject } from "../master/json";
import {
  APPROACH_CATALOG,
  type BackCoverDraft,
  type ConceptDraft,
  type TitleOptionDraft,
} from "../repo/covers";

// Cover-design AI calls (spec §4 Stage 7). Every call is shaped by the
// project's editorial contract and confirmed style profile (auto-injected by
// the client) and grounded in the book's own title, genre/tone and — for the
// back cover — its actual text. The plain-language explanations shown to the
// user come from the catalogs in repo/covers, never from the model.

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((e): e is string => typeof e === "string").map((e) => e.trim())
    : [];
}

const VALID_APPROACHES = new Set(APPROACH_CATALOG.map((a) => a.key));

export interface CoverSeed {
  projectId: string;
  jobId: string;
  bookTitle: string;
  author: string;
  contract: EditorialContract;
  styleProfile?: StyleProfile;
  /** Short description of what the book is about, for grounding. */
  synopsis: string;
}

/* ------------------------------------------------------------------ */
/* Concept proposal (2–4 concepts + A/B/C title options)              */
/* ------------------------------------------------------------------ */

interface RawConcept {
  approach?: string;
  title?: string;
  subtitle?: string;
  tagline?: string;
  rationale?: string;
  palette?: unknown;
  imagery?: string;
}

interface RawProposal {
  concepts?: RawConcept[];
  titleOptions?: Array<{
    label?: string;
    title?: string;
    subtitle?: string;
    tagline?: string;
    rationale?: string;
  }>;
}

function conceptInstructions(): string {
  const catalog = APPROACH_CATALOG.map(
    (a) => `- ${a.key}: ${a.label}. ${a.explanation}`,
  ).join("\n");
  return (
    "You are a book-cover art director. From the book's title, genre/tone and " +
    "synopsis, propose between 2 and 4 distinct cover CONCEPTS, each using a " +
    "different approach from this catalog (use the catalog key verbatim as " +
    `"approach"):\n${catalog}\n\n` +
    "Also propose exactly 3 title/subtitle/tagline options labelled A, B and C " +
    "for the author to compare. Write every piece of text in the book's " +
    "language. Respond with ONLY a JSON object:\n" +
    '{"concepts":[{"approach":string,"title":string,"subtitle":string,' +
    '"tagline":string,"rationale":string (why this cover fits the book),' +
    '"palette":[up to 4 hex colors like "#1a2b3c"],"imagery":string ' +
    "(what image/photo, or empty for the minimalist approach)}]," +
    '"titleOptions":[{"label":"A","title":string,"subtitle":string,' +
    '"tagline":string,"rationale":string}]}'
  );
}

export async function proposeCoverConcepts(
  ai: AiClient,
  args: CoverSeed,
): Promise<{
  concepts: ConceptDraft[];
  titleOptions: TitleOptionDraft[];
  aiCalls: number;
}> {
  const res = await ai.complete({
    role: "large",
    projectId: args.projectId,
    jobId: args.jobId,
    system: {
      instructions: conceptInstructions(),
      contract: args.contract,
      styleProfile: args.styleProfile,
    },
    messages: [
      {
        role: "user",
        content:
          `Title: "${args.bookTitle}"` +
          (args.author ? ` by ${args.author}` : "") +
          `\nGenre/tone: ${args.contract.tone ?? "unspecified"}\n\n` +
          `What the book is about:\n${args.synopsis}`,
      },
    ],
    maxTokens: 1800,
  });
  const raw = parseJsonObject<RawProposal>(res.text);
  const concepts: ConceptDraft[] = (raw.concepts ?? [])
    .filter((c) => typeof c.approach === "string" && VALID_APPROACHES.has(c.approach))
    .map((c) => ({
      approach: c.approach!,
      title: asString(c.title) || args.bookTitle,
      subtitle: asString(c.subtitle),
      tagline: asString(c.tagline),
      rationale: asString(c.rationale),
      palette: asStringArray(c.palette).slice(0, 4),
      imagery: asString(c.imagery),
    }))
    // One concept per approach — keep the first of any duplicate.
    .filter((c, i, arr) => arr.findIndex((o) => o.approach === c.approach) === i)
    .slice(0, 4);
  if (concepts.length === 0) {
    throw new Error(
      "The model proposed no usable cover concepts. Retry the proposal.",
    );
  }
  const titleOptions: TitleOptionDraft[] = (raw.titleOptions ?? [])
    .map((t, i) => ({
      label: asString(t.label) || ["A", "B", "C"][i] || `Option ${i + 1}`,
      title: asString(t.title),
      subtitle: asString(t.subtitle),
      tagline: asString(t.tagline),
      rationale: asString(t.rationale),
    }))
    .filter((t) => t.title !== "")
    .slice(0, 3);
  return { concepts, titleOptions, aiCalls: 1 };
}

/* ------------------------------------------------------------------ */
/* Single-concept regeneration                                         */
/* ------------------------------------------------------------------ */

export async function regenerateConcept(
  ai: AiClient,
  args: CoverSeed & { approach: string; avoid?: string },
): Promise<ConceptDraft> {
  const entry = APPROACH_CATALOG.find((a) => a.key === args.approach);
  const res = await ai.complete({
    role: "large",
    projectId: args.projectId,
    jobId: args.jobId,
    system: {
      instructions:
        "You are a book-cover art director. Propose ONE fresh cover concept " +
        `using the "${args.approach}" approach (${entry?.label ?? args.approach}: ` +
        `${entry?.explanation ?? ""}). Give a genuinely new direction` +
        (args.avoid ? `, different from: ${args.avoid}` : "") +
        ". Write all text in the book's language. Respond with ONLY a JSON " +
        'object: {"approach":string,"title":string,"subtitle":string,' +
        '"tagline":string,"rationale":string,"palette":[hex colors],' +
        '"imagery":string}.',
      contract: args.contract,
      styleProfile: args.styleProfile,
    },
    messages: [
      {
        role: "user",
        content:
          `Title: "${args.bookTitle}"` +
          (args.author ? ` by ${args.author}` : "") +
          `\nGenre/tone: ${args.contract.tone ?? "unspecified"}\n\n` +
          `What the book is about:\n${args.synopsis}`,
      },
    ],
    maxTokens: 900,
  });
  const c = parseJsonObject<RawConcept>(res.text);
  return {
    approach: args.approach,
    title: asString(c.title) || args.bookTitle,
    subtitle: asString(c.subtitle),
    tagline: asString(c.tagline),
    rationale: asString(c.rationale),
    palette: asStringArray(c.palette).slice(0, 4),
    imagery: asString(c.imagery),
  };
}

/* ------------------------------------------------------------------ */
/* Guided back-cover content (blurb + verbatim quote + bio)            */
/* ------------------------------------------------------------------ */

/** Whitespace/quote-insensitive membership test. */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”«»"'‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `quote` appears verbatim (modulo whitespace/quotes) in the text. */
export function quoteIsFromText(quote: string, text: string): boolean {
  const q = normalizeForMatch(quote);
  return q.length > 0 && normalizeForMatch(text).includes(q);
}

/** A real sentence from the book's body, used when the model's quote cannot
 *  be verified against the text — the quote must always be the book's words. */
export function extractFallbackQuote(text: string): string {
  const sentences = text
    .split(/\n+/)
    .filter((line) => !line.trim().startsWith("#"))
    .join(" ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 180);
  return sentences[0] ?? "";
}

/** The sentence of the original text that contains the quote (for provenance). */
function locateSourceExcerpt(quote: string, text: string): string {
  const q = normalizeForMatch(quote);
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (normalizeForMatch(s).includes(q)) return s.trim();
  }
  return quote.trim();
}

interface RawBackCover {
  blurb?: string;
  quote?: string;
  bio?: string;
}

export interface BackCoverResult {
  drafts: BackCoverDraft[];
  quoteVerified: boolean;
  aiCalls: number;
}

export async function draftBackCover(
  ai: AiClient,
  args: {
    projectId: string;
    jobId: string;
    bookTitle: string;
    author: string;
    contract: EditorialContract;
    styleProfile?: StyleProfile;
    /** The book's FINAL text — the blurb and quote must come from it. */
    finalText: string;
  },
): Promise<BackCoverResult> {
  const material = args.finalText.slice(0, 16_000);
  const res = await ai.complete({
    role: "large",
    projectId: args.projectId,
    jobId: args.jobId,
    system: {
      instructions:
        "You are writing the back cover of a book, working ONLY from the " +
        "book's own text supplied below. Produce three things, in the book's " +
        "language:\n" +
        "1. blurb — two short paragraphs that promise the reading experience " +
        "(draw the reader in, hint at the stakes; do not summarise or spoil).\n" +
        "2. quote — ONE short, striking line copied VERBATIM from the text " +
        "below (copy it exactly, word for word; do not invent or paraphrase).\n" +
        "3. bio — two or three sentences on the author, third person.\n" +
        'Respond with ONLY a JSON object: {"blurb":string,"quote":string,' +
        '"bio":string}.',
      contract: args.contract,
      styleProfile: args.styleProfile,
    },
    messages: [
      {
        role: "user",
        content:
          `Book: "${args.bookTitle}"` +
          (args.author ? ` by ${args.author}` : "") +
          `\n\nThe book's text:\n\n${material}`,
      },
    ],
    maxTokens: 1200,
  });
  const raw = parseJsonObject<RawBackCover>(res.text);
  const blurb = asString(raw.blurb);
  const bio = asString(raw.bio);
  let quote = asString(raw.quote).replace(/^["“«»]+|["”«»]+$/g, "").trim();

  // The quote must be the book's actual words. If the model's quote cannot be
  // found in the text, fall back to a real sentence lifted from it.
  let quoteVerified = quoteIsFromText(quote, args.finalText);
  if (!quoteVerified) {
    const fallback = extractFallbackQuote(args.finalText);
    if (fallback) {
      quote = fallback;
      quoteVerified = quoteIsFromText(quote, args.finalText);
    }
  }
  const sourceExcerpt = quote ? locateSourceExcerpt(quote, args.finalText) : "";

  const drafts: BackCoverDraft[] = [];
  if (blurb) drafts.push({ sectionKey: "blurb", content: blurb });
  if (quote) drafts.push({ sectionKey: "quote", content: quote, sourceExcerpt });
  if (bio) drafts.push({ sectionKey: "bio", content: bio });
  if (drafts.length === 0) {
    throw new Error(
      "The model returned no usable back-cover content. Retry the draft.",
    );
  }
  return { drafts, quoteVerified, aiCalls: 1 };
}

/* ------------------------------------------------------------------ */
/* Iteration: an annotation (with its marked region) reaches the agent */
/* ------------------------------------------------------------------ */

export async function iterateCover(
  ai: AiClient,
  args: {
    projectId: string;
    jobId: string;
    bookTitle: string;
    contract: EditorialContract;
    styleProfile?: StyleProfile;
    concept?: {
      approach: string;
      title: string;
      subtitle: string;
      tagline: string;
      rationale: string;
      imagery: string;
    };
    target: string;
    region: { x: number; y: number; w: number; h: number } | null;
    note: string;
  },
): Promise<{ response: string; aiCalls: number }> {
  const regionLine = args.region
    ? `The user marked a region of the ${args.target} to point at: ` +
      `x=${args.region.x.toFixed(2)}, y=${args.region.y.toFixed(2)}, ` +
      `width=${args.region.w.toFixed(2)}, height=${args.region.h.toFixed(2)} ` +
      "(fractions of the cover, origin top-left). Focus your advice on what " +
      "sits in that region."
    : `The user is commenting on the ${args.target} as a whole.`;
  const conceptLine = args.concept
    ? `Current concept (${args.concept.approach}): title "${args.concept.title}", ` +
      `subtitle "${args.concept.subtitle}", tagline "${args.concept.tagline}". ` +
      `Imagery: ${args.concept.imagery || "none"}. Rationale: ${args.concept.rationale}.`
    : "No specific concept is attached.";
  const res = await ai.complete({
    role: "large",
    projectId: args.projectId,
    jobId: args.jobId,
    system: {
      instructions:
        "You are the cover-design agent iterating with the author on their " +
        "book cover. Respond conversationally with concrete, actionable " +
        "revisions addressing exactly what the user marked. Keep it short.",
      contract: args.contract,
      styleProfile: args.styleProfile,
    },
    messages: [
      {
        role: "user",
        content:
          `Book: "${args.bookTitle}"\n${conceptLine}\n${regionLine}\n\n` +
          `The user says: ${args.note}`,
      },
    ],
    maxTokens: 700,
  });
  return { response: res.text.trim(), aiCalls: 1 };
}
