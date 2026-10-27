// Deterministic pagination for the PDF preview (spec §5.1, Stage 6.3).
//
// There is no real typesetting engine in this slice (real PDF rendering is a
// separate work order — see project memory). Instead this module lays the
// approved FINAL text into pages from the physical-format configuration so the
// app has a STABLE page model: the same text + same format always yields the
// same pages. That stability is what makes the page count, the page-by-page
// visual diff and the spread viewer possible, and it is purely a function of
// its inputs — no randomness, no I/O — so it is trivially unit-testable.

import { getPageSize, type FormatConfigData } from "../format/config";

export interface Page {
  /** 1-based page number. */
  pageNumber: number;
  /** Rendered lines (blank lines included, for the viewer's spacing). */
  lines: string[];
  /** The page's text, lines joined with newlines. */
  text: string;
}

export interface PageGeometry {
  charsPerLine: number;
  linesPerPage: number;
}

const PT_TO_MM = 0.352778;

/**
 * Printable text area and the resulting characters-per-line / lines-per-page,
 * derived from the page size, margins and typography. Average character width
 * is approximated at half the body em — enough for a consistent, believable
 * page model (this is a preview, not a final typesetter).
 */
export function pageGeometry(format: FormatConfigData): PageGeometry {
  const size = getPageSize(format.pageSize);
  const m = format.marginsCm;
  const textWidthMm = Math.max(1, size.widthMm - (m.inner + m.outer) * 10);
  const textHeightMm = Math.max(1, size.heightMm - (m.top + m.bottom) * 10);
  const charWidthMm = 0.5 * format.typography.bodySizePt * PT_TO_MM;
  const lineHeightMm = Math.max(0.1, format.typography.leadingPt * PT_TO_MM);
  const charsPerLine = Math.max(10, Math.floor(textWidthMm / charWidthMm));
  const linesPerPage = Math.max(1, Math.floor(textHeightMm / lineHeightMm));
  return { charsPerLine, linesPerPage };
}

/** True when a text block is a markdown heading (chapter/section opening). */
function isHeading(block: string): boolean {
  return block.startsWith("## ");
}

function headingText(block: string): string {
  return block.replace(/^#+\s*/, "");
}

/**
 * Greedy word-wrap that never splits a word, so the sequence of words is
 * preserved exactly (the word-for-word QA check relies on this). A word longer
 * than the line simply takes a line of its own.
 */
function wrapWords(text: string, charsPerLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= charsPerLine) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/**
 * Lay the FINAL text into pages. Headings open a new page (the proven
 * "chapters open recto" convention); paragraphs flow and, in `spaced` mode,
 * are separated by a blank line.
 */
export function paginate(text: string, format: FormatConfigData): Page[] {
  const { charsPerLine, linesPerPage } = pageGeometry(format);
  const spaced = format.paragraphs.style === "spaced";
  const blocks = text
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const pages: string[][] = [];
  let currentLines: string[] = [];

  const flushPage = () => {
    if (currentLines.length > 0) {
      pages.push(currentLines);
      currentLines = [];
    }
  };
  const pushLines = (newLines: string[]) => {
    for (const line of newLines) {
      if (currentLines.length >= linesPerPage) flushPage();
      currentLines.push(line);
    }
  };

  blocks.forEach((block) => {
    if (isHeading(block)) {
      // A heading starts a fresh page, then its own (wrapped) line(s).
      flushPage();
      pushLines(wrapWords(headingText(block), charsPerLine));
      pushLines([""]);
      return;
    }
    const wrapped = wrapWords(block, charsPerLine);
    pushLines(wrapped);
    if (spaced) pushLines([""]);
  });
  flushPage();

  if (pages.length === 0) pages.push([""]);

  return pages.map((lines, i) => ({
    pageNumber: i + 1,
    lines,
    text: lines.join("\n"),
  }));
}

/**
 * The canonical word stream of a text: heading markers removed, split on
 * whitespace. Both the approved text and the paginated pages reduce to the
 * same stream when no CONTENT changed — the basis of the word-for-word check.
 */
export function canonicalTokens(text: string): string[] {
  return text
    .replace(/^#+\s*/gm, "")
    .split(/\s+/)
    .filter(Boolean);
}

/** The canonical word stream recovered from a set of pages. */
export function tokensFromPages(pages: Page[]): string[] {
  return canonicalTokens(pages.map((p) => p.text).join("\n"));
}
