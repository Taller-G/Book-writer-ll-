import { execFileSync } from "node:child_process";

// Facts read straight off the compiled PDF — never off the project config.
// The print-shop checklist's page count and physical size come from here so
// they describe the file the printer will actually receive, not an estimate.

export interface PdfInfo {
  /** Total page count pdfinfo reports. */
  pageCount: number;
  /** Trimmed page size in PostScript points (72 pt = 1 inch). */
  widthPt: number;
  heightPt: number;
}

/**
 * Read `pdfinfo` output for the given PDF. Throws when poppler is missing or
 * the file is not a readable PDF — the export must not invent a page count.
 */
export function readPdfInfo(pdfPath: string): PdfInfo {
  const out = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
  const pages = out.match(/^Pages:\s+(\d+)/m);
  if (!pages) {
    throw new Error(`pdfinfo reported no page count for ${pdfPath}`);
  }
  // "Page size: 419.528 x 595.276 pts (A5)"
  const size = out.match(/^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m);
  return {
    pageCount: Number(pages[1]),
    widthPt: size ? Number(size[1]) : 0,
    heightPt: size ? Number(size[2]) : 0,
  };
}
