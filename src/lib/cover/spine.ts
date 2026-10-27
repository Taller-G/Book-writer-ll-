// Spine-width estimation (spec §4 Stage 7).
//
// The spine of a perfect-bound book is page count × paper thickness. Neither
// number is final until the printer confirms the paper, so everything here is
// an ESTIMATE the user must confirm with the printer — see isSpineConfirmed.
//
// The page count is derived deterministically from the FINAL text's word count
// and the chosen format geometry (page size, body size, leading, margins), so
// it recalculates whenever the pagination changes (the text grows/shrinks, or
// the format changes). This is intentionally a print-shop estimate, not a
// typeset page count — it needs no rendered PDF.

import { getPageSize, type FormatConfigData } from "../format/config";

const MM_PER_PT = 0.352778;

export interface PaperStock {
  id: string;
  label: string;
  /** Caliper: the thickness of a single leaf (one sheet) in millimetres. */
  caliperMm: number;
  blurb: string;
}

// Common trade paper stocks and their approximate caliper per leaf. Real
// values vary by mill; these are typical and must be confirmed with the
// printer before the cover goes to press.
export const PAPER_STOCKS: PaperStock[] = [
  {
    id: "bond_80_white",
    label: "Bond 80 gsm (white)",
    caliperMm: 0.1,
    blurb:
      "Thin, bright white office-weight stock. Keeps the spine slim; text can show through on heavy ink coverage.",
  },
  {
    id: "offset_90_cream",
    label: "Offset 90 gsm (cream)",
    caliperMm: 0.125,
    blurb:
      "The proven choice for prose: warm cream tone, opaque, comfortable to read. Both finished books used it.",
  },
  {
    id: "offset_120_white",
    label: "Offset 120 gsm (white)",
    caliperMm: 0.16,
    blurb:
      "Heavier, more substantial page; good for illustrated books. Noticeably thicker spine and higher cost.",
  },
];

export const DEFAULT_PAPER_STOCK = "offset_90_cream";

export function getPaperStock(id: string | null | undefined): PaperStock {
  return (
    PAPER_STOCKS.find((s) => s.id === id) ??
    PAPER_STOCKS.find((s) => s.id === DEFAULT_PAPER_STOCK)!
  );
}

/** Words that fit on one body page, derived from the format geometry. */
export function wordsPerPage(format: FormatConfigData): number {
  const size = getPageSize(format.pageSize);
  const textWidthMm =
    size.widthMm - (format.marginsCm.inner + format.marginsCm.outer) * 10;
  const textHeightMm =
    size.heightMm - (format.marginsCm.top + format.marginsCm.bottom) * 10;
  if (textWidthMm <= 0 || textHeightMm <= 0) return 1;
  const lineHeightMm = format.typography.leadingPt * MM_PER_PT;
  const linesPerPage = Math.max(1, Math.floor(textHeightMm / lineHeightMm));
  // Average glyph advance for a serif text face is roughly half the point
  // size; ~6 characters (five letters + a space) make an average word.
  const charWidthMm = format.typography.bodySizePt * 0.5 * MM_PER_PT;
  const charsPerLine = Math.max(1, Math.floor(textWidthMm / charWidthMm));
  const perLine = charsPerLine / 6;
  return Math.max(1, Math.round(linesPerPage * perLine));
}

/** Word count of the FINAL text, ignoring markdown section headings. */
export function countWords(finalText: string): number {
  return finalText
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Estimate the printed page count from the FINAL text and the format. Rounded
 * UP to a multiple of 4 because sheets are imposed in signatures — a printer
 * bills and binds in multiples of four pages. Returns 0 for empty text.
 */
export function estimatePageCount(
  finalText: string,
  format: FormatConfigData,
): number {
  const words = countWords(finalText);
  if (words === 0) return 0;
  const raw = Math.ceil(words / wordsPerPage(format));
  return Math.ceil(raw / 4) * 4;
}

/**
 * Spine width in millimetres for a perfect-bound book: two pages share one
 * leaf, so leaves = pageCount / 2, each leaf as thick as the paper's caliper.
 */
export function spineWidthMm(pageCount: number, stock: PaperStock): number {
  const leaves = pageCount / 2;
  return Math.round(leaves * stock.caliperMm * 100) / 100;
}

export interface SpineRow {
  confirmed: number;
  confirmedPageCount: number | null;
}

/**
 * The spine is confirmed only when the user explicitly confirmed it AND the
 * page count has not changed since. Any pagination change re-raises the
 * "to be confirmed with the printer" flag — a stale confirmation is no
 * confirmation.
 */
export function isSpineConfirmed(
  spine: SpineRow,
  currentPageCount: number,
): boolean {
  return (
    spine.confirmed === 1 &&
    spine.confirmedPageCount !== null &&
    spine.confirmedPageCount === currentPageCount
  );
}
