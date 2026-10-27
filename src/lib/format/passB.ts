// Pass B — faithful structuring of a book of talks (spec §4 stage 3.5).
//
// The one rule that governs everything here: NOT A SINGLE WORD may change. Pass
// B only inserts paragraph breaks at discourse anchors and adds formatting
// marks — italic-bracketed audience reactions, bold em-dashed interviewer
// questions. The spoken-word sequence (every token outside a bracketed stage
// direction, ignoring emphasis marks) is byte-for-byte identical in and out,
// which `extractWords` lets callers assert.
//
// Genre conventions:
//  - audience reactions  →  *[Laughter]* / *[Applause]* on their own line
//  - interviewer questions (a standalone question that is clearly a turn:
//    leading dialogue dash or an interviewer label)  →  bold, em dash, own
//    paragraph
//  - a standalone question that is NOT clearly marked is AMBIGUOUS (it could be
//    the speaker's own rhetorical question): it is left untouched and flagged
//    to the review queue — never silently formatted.
//  - a question embedded in the speaker's flowing answer is rhetorical: left
//    exactly as spoken.

export type ReactionKind = "laughter" | "applause";

export interface PassBReaction {
  kind: ReactionKind;
  /** Character offset in the input where the reaction belongs. */
  charAnchor: number;
}

export interface AmbiguousQuestion {
  excerpt: string;
  /** Character offset of the question in the input. */
  charOffset: number;
}

export interface PassBOptions {
  reactions?: PassBReaction[];
  /** Discourse connectors that open a new paragraph (language-specific). */
  connectors?: string[];
}

export interface PassBResult {
  output: string;
  reactionsInserted: number;
  interviewerQuestions: number;
  paragraphBreaksAdded: number;
  ambiguousQuestions: AmbiguousQuestion[];
}

// Spoken-discourse connectors that typically begin a new thought. Kept to
// unambiguous openers so splitting stays conservative.
export const DEFAULT_CONNECTORS = [
  // Spanish
  "pero", "entonces", "y entonces", "sin embargo", "ahora bien", "además",
  "por otro lado", "por eso", "así que", "en primer lugar", "por último",
  "finalmente", "bueno", "claro", "fíjense", "miren", "la verdad",
  "dicho esto", "en segundo lugar", "con todo",
  // English
  "so", "but", "now", "however", "finally", "on the other hand",
  "in addition", "meanwhile", "and then", "well", "look", "that said",
];

const INTERVIEWER_LABEL =
  /^(?:p|q|pregunta|entrevistador(?:a)?|interviewer|periodista|moderador(?:a)?)\s*[:.–-]/i;

const LEADING_DASH = /^\s*[—–-]+\s*/;

export function reactionText(kind: ReactionKind): string {
  return kind === "laughter" ? "*[Laughter]*" : "*[Applause]*";
}

/**
 * The spoken-word stream used to prove Pass B changed no words: bracketed
 * stage directions and emphasis marks are dropped, everything else lowercased
 * and tokenized into word tokens.
 */
export function extractWords(text: string): string[] {
  return (
    text
      .replace(/\[[^\]]*\]/g, " ") // drop [Laughter] / [Applause] stage directions
      .replace(/[*_]+/g, " ") // drop bold/italic markers
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
  );
}

function splitSentences(paragraph: string): string[] {
  const trimmed = paragraph.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isQuestion(sentence: string): boolean {
  return /\?[”"»'’)\]]*\s*$/.test(sentence.trim());
}

function startsWithConnector(sentence: string, connectors: string[]): boolean {
  const s = sentence.trim().toLowerCase();
  return connectors.some((c) => {
    if (!s.startsWith(c)) return false;
    // Must be a whole word (followed by a boundary, not more letters).
    const next = s.charAt(c.length);
    return next === "" || !/[\p{L}\p{N}]/u.test(next);
  });
}

function isMarkedInterviewer(question: string): boolean {
  const q = question.trim();
  return LEADING_DASH.test(q) || INTERVIEWER_LABEL.test(q);
}

/** Bold, em-dash, own-paragraph form — keeping every spoken word. */
function formatInterviewer(question: string): string {
  // Drop a leading dash run (punctuation, not a word) so we don't double it,
  // then re-introduce the canonical em dash.
  const body = question.trim().replace(LEADING_DASH, "");
  return `**— ${body}**`;
}

export function applyPassB(input: string, options: PassBOptions = {}): PassBResult {
  const connectors = options.connectors ?? DEFAULT_CONNECTORS;
  const reactions = (options.reactions ?? [])
    .slice()
    .sort((a, b) => a.charAnchor - b.charAnchor);

  const srcParagraphs = input.split(/\n\n+/);
  const out: string[] = [];
  const ambiguousQuestions: AmbiguousQuestion[] = [];
  let interviewerQuestions = 0;
  let reactionsInserted = 0;
  let paragraphBreaksAdded = 0;

  let reactionIdx = 0;
  const emitReactionsUpTo = (upto: number) => {
    while (reactionIdx < reactions.length && reactions[reactionIdx].charAnchor <= upto) {
      out.push(reactionText(reactions[reactionIdx].kind));
      reactionIdx++;
      reactionsInserted++;
    }
  };

  let pos = 0;
  for (const para of srcParagraphs) {
    const start = input.indexOf(para, pos);
    const end = start < 0 ? pos + para.length : start + para.length;
    pos = end;

    const sentences = splitSentences(para);
    if (sentences.length === 0) {
      emitReactionsUpTo(end);
      continue;
    }

    if (sentences.length === 1 && isQuestion(sentences[0])) {
      const q = sentences[0];
      if (isMarkedInterviewer(q)) {
        out.push(formatInterviewer(q));
        interviewerQuestions++;
      } else {
        // Ambiguous: could be a speaker rhetorical question. Leave it exactly
        // as spoken and route it to the queue.
        out.push(q);
        ambiguousQuestions.push({ excerpt: q.slice(0, 160), charOffset: start });
      }
      emitReactionsUpTo(end);
      continue;
    }

    // Flowing paragraph: split at discourse anchors; questions here are
    // rhetorical (part of the answer) and stay untouched.
    let buffer: string[] = [];
    for (const s of sentences) {
      if (buffer.length > 0 && startsWithConnector(s, connectors)) {
        out.push(buffer.join(" "));
        paragraphBreaksAdded++;
        buffer = [s];
      } else {
        buffer.push(s);
      }
    }
    if (buffer.length) out.push(buffer.join(" "));
    emitReactionsUpTo(end);
  }
  emitReactionsUpTo(Number.POSITIVE_INFINITY);

  return {
    output: out.join("\n\n"),
    reactionsInserted,
    interviewerQuestions,
    paragraphBreaksAdded,
    ambiguousQuestions,
  };
}

/** Deep word-sequence equality — the Pass B invariant. */
export function sameWordSequence(a: string, b: string): boolean {
  const wa = extractWords(a);
  const wb = extractWords(b);
  if (wa.length !== wb.length) return false;
  for (let i = 0; i < wa.length; i++) if (wa[i] !== wb[i]) return false;
  return true;
}
