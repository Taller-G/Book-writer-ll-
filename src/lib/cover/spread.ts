// Full-spread cover geometry (spec §4 Stage 7).
//
// A print cover is one flat canvas: back cover + spine + front cover, laid
// left to right, with 3 mm of bleed added on every outer edge so the trim can
// drift without leaving a white sliver. A user-uploaded PNG must match these
// dimensions (including the bleed) to drop into the spread cleanly.

import { getPageSize, type FormatConfigData } from "../format/config";

export const BLEED_MM = 3;
export const PRINT_DPI = 300;

const MM_PER_INCH = 25.4;

export function mmToPx(mm: number, dpi = PRINT_DPI): number {
  return Math.round((mm / MM_PER_INCH) * dpi);
}

export interface SpreadDims {
  bleedMm: number;
  /** One cover page = the trim page size. */
  pageWidthMm: number;
  pageHeightMm: number;
  spineWidthMm: number;
  /** Flat canvas including bleed on all four sides. */
  totalWidthMm: number;
  totalHeightMm: number;
  totalWidthPx: number;
  totalHeightPx: number;
  dpi: number;
}

/**
 * The flat cover canvas for a given format and spine width. Width is
 * back + spine + front plus a bleed on the far left and far right; height is
 * the page height plus a bleed top and bottom.
 */
export function spreadDims(
  format: FormatConfigData,
  spineMm: number,
  dpi = PRINT_DPI,
): SpreadDims {
  const size = getPageSize(format.pageSize);
  const totalWidthMm = size.widthMm * 2 + spineMm + BLEED_MM * 2;
  const totalHeightMm = size.heightMm + BLEED_MM * 2;
  return {
    bleedMm: BLEED_MM,
    pageWidthMm: size.widthMm,
    pageHeightMm: size.heightMm,
    spineWidthMm: spineMm,
    totalWidthMm,
    totalHeightMm,
    totalWidthPx: mmToPx(totalWidthMm, dpi),
    totalHeightPx: mmToPx(totalHeightMm, dpi),
    dpi,
  };
}

/**
 * Read a PNG's pixel dimensions from its IHDR chunk, without decoding the
 * image. Returns null if the buffer is not a PNG.
 */
export function readPngDimensions(
  buf: Buffer,
): { width: number; height: number } | null {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature)) return null;
  // After the 8-byte signature: 4-byte length, 4-byte "IHDR", then width/height.
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export interface UploadFit {
  ok: boolean;
  targetWidthPx: number;
  targetHeightPx: number;
  actualWidthPx: number;
  actualHeightPx: number;
  /** Effective DPI the upload would print at, given the spread's mm size. */
  effectiveDpi: number;
  reasons: string[];
}

/**
 * Check whether an uploaded PNG fits the target spread (including bleed). The
 * pixel count may differ from the 300-DPI target as long as the aspect ratio
 * matches and the resolution stays print-worthy (≥ 200 DPI over the full
 * canvas). A size mismatch is reported, not silently accepted or rejected.
 */
export function checkUploadFit(
  actual: { width: number; height: number },
  spread: SpreadDims,
  opts: { aspectTolerancePct?: number; minDpi?: number } = {},
): UploadFit {
  const aspectTolerancePct = opts.aspectTolerancePct ?? 1.5;
  const minDpi = opts.minDpi ?? 200;
  const reasons: string[] = [];

  const targetAspect = spread.totalWidthMm / spread.totalHeightMm;
  const actualAspect = actual.width / actual.height;
  const aspectDrift =
    (Math.abs(actualAspect - targetAspect) / targetAspect) * 100;
  if (aspectDrift > aspectTolerancePct) {
    reasons.push(
      `Aspect ratio is off by ${aspectDrift.toFixed(1)}% — the full spread ` +
        `(back + spine + front + bleed) is ${spread.totalWidthMm.toFixed(0)} × ` +
        `${spread.totalHeightMm.toFixed(0)} mm (${targetAspect.toFixed(3)}:1). ` +
        `The upload is ${actualAspect.toFixed(3)}:1.`,
    );
  }

  const effectiveDpi = Math.round(
    (actual.width / spread.totalWidthMm) * MM_PER_INCH,
  );
  if (effectiveDpi < minDpi) {
    reasons.push(
      `Resolution is ${effectiveDpi} DPI across the spread — below the ` +
        `${minDpi} DPI minimum for print. Supply at least ` +
        `${spread.totalWidthPx} × ${spread.totalHeightPx} px.`,
    );
  }

  return {
    ok: reasons.length === 0,
    targetWidthPx: spread.totalWidthPx,
    targetHeightPx: spread.totalHeightPx,
    actualWidthPx: actual.width,
    actualHeightPx: actual.height,
    effectiveDpi,
    reasons,
  };
}
