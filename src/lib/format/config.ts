// Physical format model (spec §4 Stage 5 / §7 proven defaults).
//
// The full configuration lives as JSON in format_configs.data; the legacy
// columns (trim_size, font_family, font_size_pt, line_height, margins) are
// kept in sync via legacyFields() so the Stage 8 export executor and any
// older reader keep working without a schema change.

export type PageSizeId = "A5" | "12x18cm" | "15x23cm";
export type ParagraphStyle = "indent" | "spaced";
export type FolioPosition = "outer-bottom" | "center-bottom" | "outer-top";
export type NumeralStyle = "oldstyle" | "lining";
export type SeparatorStyle = "whitespace" | "rule";

export interface PageSizeDef {
  id: PageSizeId;
  label: string;
  widthMm: number;
  heightMm: number;
}

export const PAGE_SIZES: PageSizeDef[] = [
  { id: "A5", label: "A5 (14.8 × 21 cm)", widthMm: 148, heightMm: 210 },
  { id: "12x18cm", label: "12 × 18 cm", widthMm: 120, heightMm: 180 },
  { id: "15x23cm", label: "15 × 23 cm", widthMm: 150, heightMm: 230 },
];

export function getPageSize(id: string): PageSizeDef {
  return PAGE_SIZES.find((p) => p.id === id) ?? PAGE_SIZES[0];
}

export interface FormatConfigData {
  pageSize: PageSizeId;
  typography: {
    bodyFamily: string;
    bodySizePt: number;
    leadingPt: number;
    headingFamily: string;
    numerals: NumeralStyle;
  };
  /** Print margins. inner = spine side; must stay larger than outer. */
  marginsCm: { inner: number; outer: number; top: number; bottom: number };
  paragraphs: {
    style: ParagraphStyle;
    /** First-line indent, used when style === "indent". */
    indentEm: number;
    /** Space between paragraphs, used when style === "spaced". */
    spacingEm: number;
  };
  folios: {
    position: FolioPosition;
    family: string;
    sizePt: number;
    smallCaps: boolean;
    frontMatterUnnumbered: boolean;
    onChapterOpenings: boolean;
  };
  conventions: {
    chaptersOpenRecto: boolean;
    technicalBlankPages: boolean;
    separatorStyle: SeparatorStyle;
    separatorSpaceEm: number;
  };
}

// The §7 proven configuration: what both real book projects converged on.
// Accepting every wizard default must yield exactly this object.
export const PROVEN_DEFAULTS: FormatConfigData = {
  pageSize: "A5",
  typography: {
    bodyFamily: "EB Garamond",
    bodySizePt: 11,
    leadingPt: 14.5,
    headingFamily: "Inter",
    numerals: "oldstyle",
  },
  marginsCm: { inner: 2.3, outer: 1.9, top: 1.6, bottom: 2.4 },
  paragraphs: { style: "indent", indentEm: 1.2, spacingEm: 0.8 },
  folios: {
    position: "outer-bottom",
    family: "Inter",
    sizePt: 9,
    smallCaps: true,
    frontMatterUnnumbered: true,
    onChapterOpenings: true,
  },
  conventions: {
    chaptersOpenRecto: true,
    technicalBlankPages: true,
    separatorStyle: "whitespace",
    separatorSpaceEm: 2.4,
  },
};

/** Proven acceptable ranges for the A5 margins (cm), shown as guidance. */
export const MARGIN_RANGES_CM = {
  inner: [2.1, 2.5] as const,
  outer: [1.8, 2.1] as const,
  top: [1.4, 1.9] as const,
  bottom: [2.4, 2.4] as const,
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(defaults: T, stored: unknown): T {
  if (!isObject(defaults as unknown) || !isObject(stored)) {
    return stored === undefined ? defaults : (stored as T);
  }
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(defaults as Record<string, unknown>)) {
    out[key] = merge(def, (stored as Record<string, unknown>)[key]);
  }
  return out as T;
}

/**
 * Read a format_configs.data JSON string into a complete FormatConfigData,
 * filling anything missing (older rows, partial writes) from the §7 defaults.
 */
export function parseFormatData(dataJson: string | null | undefined): FormatConfigData {
  let stored: unknown = {};
  try {
    stored = JSON.parse(dataJson || "{}");
  } catch {
    stored = {};
  }
  return merge(PROVEN_DEFAULTS, stored);
}

export function serializeFormatData(data: FormatConfigData): string {
  return JSON.stringify(data);
}

/** Legacy column values derived from the full config (kept in sync on save). */
export function legacyFields(data: FormatConfigData): {
  trimSize: string;
  fontFamily: string;
  fontSizePt: number;
  lineHeight: number;
  margins: string;
} {
  const m = data.marginsCm;
  const mm = (cm: number) => `${Math.round(cm * 10)}mm`;
  return {
    trimSize: data.pageSize,
    fontFamily: data.typography.bodyFamily,
    fontSizePt: data.typography.bodySizePt,
    lineHeight:
      Math.round((data.typography.leadingPt / data.typography.bodySizePt) * 100) / 100,
    margins: JSON.stringify({
      top: mm(m.top),
      bottom: mm(m.bottom),
      inner: mm(m.inner),
      outer: mm(m.outer),
    }),
  };
}
