import type { FormatConfig } from "../db/schema";
import { resolveFont, type ResolvedFont } from "./fonts";

// Deterministic conversion of the approved master text into the XeLaTeX
// composition (memoir + fontspec), plus the inverse parse used to verify —
// word for word — that the composition carries exactly the approved text.
//
// The approved text grammar is the one the pipeline produces upstream:
// paragraphs separated by blank lines; "## Title" opens a chapter; a
// paragraph of only asterisks ("***" or "* * *") is a scene separator.

export type BookBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "separator" };

export interface BookChapter {
  title: string;
  blocks: BookBlock[];
}

export interface BookModel {
  /** Paragraphs that appear before the first chapter heading. */
  intro: BookBlock[];
  chapters: BookChapter[];
}

const SEPARATOR_RE = /^\*(\s*\*){1,5}$/;

export function parseBook(approvedText: string): BookModel {
  const model: BookModel = { intro: [], chapters: [] };
  const paragraphs = approvedText
    .split(/\n\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const p of paragraphs) {
    const target =
      model.chapters.length === 0
        ? model.intro
        : model.chapters[model.chapters.length - 1].blocks;
    if (p.startsWith("## ")) {
      model.chapters.push({ title: p.slice(3).trim(), blocks: [] });
    } else if (SEPARATOR_RE.test(p)) {
      target.push({ kind: "separator" });
    } else {
      target.push({ kind: "paragraph", text: p });
    }
  }
  return model;
}

// LaTeX escaping — bijective so decompose() can invert it exactly.
const ESCAPES: Array<[plain: string, tex: string]> = [
  ["\\", "\\textbackslash{}"],
  ["{", "\\{"],
  ["}", "\\}"],
  ["$", "\\$"],
  ["&", "\\&"],
  ["#", "\\#"],
  ["_", "\\_"],
  ["%", "\\%"],
  ["^", "\\textasciicircum{}"],
  ["~", "\\textasciitilde{}"],
];

export function escapeLatex(s: string): string {
  let out = "";
  for (const ch of s) {
    const esc = ESCAPES.find(([plain]) => plain === ch);
    out += esc ? esc[1] : ch;
  }
  return out;
}

function unescapeLatex(s: string): string {
  // Single pass so an unescaped backslash never re-combines with following
  // characters into a second round of replacements.
  return s.replace(
    /\\textbackslash\{\}|\\textasciicircum\{\}|\\textasciitilde\{\}|\\[{}$&#_%]/g,
    (m) => {
      if (m === "\\textbackslash{}") return "\\";
      if (m === "\\textasciicircum{}") return "^";
      if (m === "\\textasciitilde{}") return "~";
      return m[1];
    },
  );
}

interface TrimSize {
  width: string;
  height: string;
}

// Keys cover both the page-size IDs the Stage 5/7 format wizard writes into
// the legacy trim_size column (A5, 12x18cm, 15x23cm) and the earlier inch
// presets, so the trim size the user chose is honoured verbatim.
const TRIM_SIZES: Record<string, TrimSize> = {
  A5: { width: "148mm", height: "210mm" },
  "12x18cm": { width: "120mm", height: "180mm" },
  "15x23cm": { width: "150mm", height: "230mm" },
  "5x8in": { width: "5in", height: "8in" },
  "5.5x8.5in": { width: "5.5in", height: "8.5in" },
  "6x9in": { width: "6in", height: "9in" },
};

// memoir's supported point-size class options (basic set).
const MEMOIR_SIZES = [9, 10, 11, 12, 14, 17];

export interface Margins {
  top: string;
  bottom: string;
  inner: string;
  outer: string;
}

const DEFAULT_MARGINS: Margins = {
  top: "20mm",
  bottom: "20mm",
  inner: "22mm",
  outer: "16mm",
};

export function parseMargins(json: string): Margins {
  try {
    const raw = JSON.parse(json) as Partial<Margins>;
    return { ...DEFAULT_MARGINS, ...raw };
  } catch {
    return DEFAULT_MARGINS;
  }
}

export interface Composition {
  tex: string;
  model: BookModel;
  font: ResolvedFont;
  /** Chapter titles in order — the QA suite checks these against the TOC. */
  chapterTitles: string[];
  separatorCount: number;
}

const BODY_BEGIN = "% ===BOOK BODY BEGIN===";
const BODY_END = "% ===BOOK BODY END===";

/** The exact text the scene-break macro prints — QA locates it on the page. */
export const SEPARATOR_TEXT = "* * *";

export function composeBook(
  approvedText: string,
  format: FormatConfig,
  meta: { title: string; author: string },
): Composition {
  const model = parseBook(approvedText);
  const trim = TRIM_SIZES[format.trimSize] ?? TRIM_SIZES.A5;
  const margins = parseMargins(format.margins);
  const font = resolveFont(format.fontFamily);
  const sizePt = MEMOIR_SIZES.reduce((best, s) =>
    Math.abs(s - format.fontSizePt) < Math.abs(best - format.fontSizePt) ? s : best,
  );
  // memoir's \OnehalfSpacing-style factor: lineHeight is relative to the
  // font size; LaTeX's \linespread is relative to the 1.2em default leading.
  const linespread = (format.lineHeight / 1.2).toFixed(3);

  const body: string[] = [];
  const emitBlocks = (blocks: BookBlock[]) => {
    for (const b of blocks) {
      body.push(b.kind === "separator" ? "\\scenebreak" : escapeLatex(b.text));
      body.push("");
    }
  };
  emitBlocks(model.intro);
  for (const ch of model.chapters) {
    body.push(`\\chapter{${escapeLatex(ch.title)}}`);
    body.push("");
    emitBlocks(ch.blocks);
  }

  const tex = `\\documentclass[${sizePt}pt,twoside,openright]{memoir}
\\setstocksize{${trim.height}}{${trim.width}}
\\settrimmedsize{${trim.height}}{${trim.width}}{*}
\\setlrmarginsandblock{${margins.inner}}{${margins.outer}}{*}
\\setulmarginsandblock{${margins.top}}{${margins.bottom}}{*}
\\checkandfixthelayout
\\usepackage{fontspec}
\\setmainfont{${font.family}}
\\linespread{${linespread}}
\\clubpenalty=10000
\\widowpenalty=10000
\\raggedbottom
% Folio bottom-center on every page so the QA overlap check has one target.
\\pagestyle{plain}
\\aliaspagestyle{chapter}{plain}
\\newcommand{\\scenebreak}{\\par\\fancybreak{*\\quad*\\quad*}\\par}
\\title{${escapeLatex(meta.title)}}
\\author{${escapeLatex(meta.author)}}
\\begin{document}
\\frontmatter
\\tableofcontents*
\\mainmatter
${BODY_BEGIN}
${body.join("\n")}
${BODY_END}
\\end{document}
`;

  return {
    tex,
    model,
    font,
    chapterTitles: model.chapters.map((c) => c.title),
    separatorCount:
      model.intro.filter((b) => b.kind === "separator").length +
      model.chapters.reduce(
        (n, c) => n + c.blocks.filter((b) => b.kind === "separator").length,
        0,
      ),
  };
}

// --- Verification -----------------------------------------------------------

/** Canonical token a scene separator contributes to the word stream. */
const SEP_TOKEN = "⁂"; // ⁂ — cannot collide with prose words

function words(text: string): string[] {
  return text.normalize("NFC").split(/\s+/).filter(Boolean);
}

/** Word stream of the approved master text. */
export function approvedWordStream(approvedText: string): string[] {
  const model = parseBook(approvedText);
  const out: string[] = [];
  const walk = (blocks: BookBlock[]) => {
    for (const b of blocks) {
      if (b.kind === "separator") out.push(SEP_TOKEN);
      else out.push(...words(b.text));
    }
  };
  walk(model.intro);
  for (const ch of model.chapters) {
    out.push(...words(ch.title));
    walk(ch.blocks);
  }
  return out;
}

/**
 * Inverse parse: rebuild the word stream from the .tex composition itself.
 * It only understands the grammar composeBook() emits — which is the point:
 * anything else in the body is a mismatch, not silently skipped.
 */
export function composedWordStream(tex: string): string[] {
  const begin = tex.indexOf(BODY_BEGIN);
  const end = tex.indexOf(BODY_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new CompositionMismatchError(
      "Composition is missing its body markers — not produced by this composer.",
    );
  }
  const bodyLines = tex.slice(begin + BODY_BEGIN.length, end).split("\n");
  const out: string[] = [];
  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%")) continue;
    if (trimmed === "\\scenebreak") {
      out.push(SEP_TOKEN);
      continue;
    }
    const chapter = trimmed.match(/^\\chapter\{(.*)\}$/);
    if (chapter) {
      out.push(...words(unescapeLatex(chapter[1])));
      continue;
    }
    out.push(...words(unescapeLatex(trimmed)));
  }
  return out;
}

export class CompositionMismatchError extends Error {}

function context(stream: string[], at: number): string {
  const from = Math.max(0, at - 4);
  const to = Math.min(stream.length, at + 5);
  return stream
    .slice(from, to)
    .map((w, i) => (from + i === at ? `[${w}]` : w))
    .join(" ");
}

/**
 * Abort gate: the normalized composition text must be word-for-word identical
 * to the approved text. Throws naming the first diverging word position.
 */
export function verifyComposition(approvedText: string, tex: string): void {
  const approved = approvedWordStream(approvedText);
  const composed = composedWordStream(tex);
  const n = Math.min(approved.length, composed.length);
  for (let i = 0; i < n; i++) {
    if (approved[i] !== composed[i]) {
      throw new CompositionMismatchError(
        `Composition mismatch at word ${i + 1}: approved "${approved[i]}" vs composed "${composed[i]}". ` +
          `Approved context: …${context(approved, i)}… — composed context: …${context(composed, i)}…`,
      );
    }
  }
  if (approved.length !== composed.length) {
    const i = n;
    const longer = approved.length > composed.length ? "approved" : "composed";
    const extra = (approved.length > composed.length ? approved : composed)[i];
    throw new CompositionMismatchError(
      `Composition mismatch at word ${i + 1}: the ${longer} text has ${Math.abs(
        approved.length - composed.length,
      )} extra word(s), starting with "${extra}".`,
    );
  }
}
