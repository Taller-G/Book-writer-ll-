import { getPageSize, type FormatConfigData } from "../format/config";

// Printed-dpi preflight (spec §4 Stage 6.4, pain point #8). The layout engine's
// QA suite already checks rendered images at ≥300 dpi, but that is after a full
// compile. This module answers the same question from the pixel dimensions and
// the chosen printed size BEFORE any render, so a picture too small for a
// full-page placement is flagged while it can still be swapped — not after the
// PDF is built. It is pure arithmetic over the format config and the image's
// natural pixel size; no file access, no database.

/** The print-industry floor for photographic reproduction. */
export const MIN_PRINT_DPI = 300;

export type SizeOption = "column" | "half" | "full";

export interface PlacedImageSize {
  widthPx: number;
  heightPx: number;
  sizeOption: SizeOption;
}

const CM_PER_INCH = 2.54;

/** The text block (inside the margins) in inches — the measure images fit. */
export function textBlockInches(format: FormatConfigData): {
  width: number;
  height: number;
} {
  const page = getPageSize(format.pageSize);
  const m = format.marginsCm;
  const widthCm = page.widthMm / 10 - m.inner - m.outer;
  const heightCm = page.heightMm / 10 - m.top - m.bottom;
  return { width: widthCm / CM_PER_INCH, height: heightCm / CM_PER_INCH };
}

/**
 * The box (inches) an image is scaled to fit at each size option. A
 * column-width image is only width-constrained (it keeps its aspect and flows
 * to whatever height), so its box height is unbounded.
 */
export function printedBoxInches(
  sizeOption: SizeOption,
  format: FormatConfigData,
): { width: number; height: number } {
  const text = textBlockInches(format);
  switch (sizeOption) {
    case "full":
      return { width: text.width, height: text.height };
    case "half":
      return { width: text.width, height: text.height / 2 };
    case "column":
    default:
      return { width: text.width, height: Infinity };
  }
}

/**
 * The effective dpi of the image once scaled (keeping aspect) to fit the
 * printed box. Returns 0 when the pixel size is unknown — the caller treats
 * that as "cannot verify" rather than a pass. The scale is bound by whichever
 * dimension fills the box first; dpi is uniform, so it equals the larger of the
 * two pixels-per-inch ratios.
 */
export function imageDpi(
  image: PlacedImageSize,
  format: FormatConfigData,
): number {
  if (image.widthPx <= 0 || image.heightPx <= 0) return 0;
  const box = printedBoxInches(image.sizeOption, format);
  const byWidth = image.widthPx / box.width;
  const byHeight = Number.isFinite(box.height)
    ? image.heightPx / box.height
    : 0;
  return Math.round(Math.max(byWidth, byHeight));
}

export interface DpiWarning {
  imageId: string;
  dpi: number;
  /** 0 dpi means the pixel size could not be read from the file. */
  unknown: boolean;
  sizeOption: SizeOption;
  message: string;
}

export interface DpiCheckable {
  id: string;
  widthPx: number;
  heightPx: number;
  sizeOption: SizeOption;
  caption?: string;
  originalName?: string;
}

function imageLabel(image: DpiCheckable): string {
  return image.caption?.trim() || image.originalName?.trim() || image.id;
}

/**
 * One warning per image whose printed dpi falls short (or cannot be read) at
 * its chosen size. An empty array means every placed image prints at or above
 * the floor — safe to render.
 */
export function imageDpiWarnings(
  images: DpiCheckable[],
  format: FormatConfigData,
  minDpi: number = MIN_PRINT_DPI,
): DpiWarning[] {
  const warnings: DpiWarning[] = [];
  for (const image of images) {
    const dpi = imageDpi(image, format);
    const label = imageLabel(image);
    if (dpi === 0) {
      warnings.push({
        imageId: image.id,
        dpi: 0,
        unknown: true,
        sizeOption: image.sizeOption,
        message: `"${label}": pixel dimensions unknown — printed dpi cannot be verified.`,
      });
    } else if (dpi < minDpi) {
      warnings.push({
        imageId: image.id,
        dpi,
        unknown: false,
        sizeOption: image.sizeOption,
        message: `"${label}" prints at ~${dpi} dpi at ${image.sizeOption} size — below the ${minDpi} dpi minimum. Use a higher-resolution image or a smaller placement.`,
      });
    }
  }
  return warnings;
}
