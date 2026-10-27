// The print-shop checklist, built entirely from the project's real data: the
// page count and embedded-font status come off the compiled PDF, the format
// comes off the saved configuration, the colour mode off the editorial
// contract's destination. Nothing here is hand-typed per book — a
// non-professional author can hand the generated document straight to a print
// shop and answer its questions from it.
//
// This module is pure (no I/O): the executor feeds it values it has already
// read from the PDF, the QA report and the database.

import type { PageSizeDef } from "../format/config";

export interface BindingRecommendation {
  id: "saddle_stitch" | "perfect_bound";
  label: string;
  /** Why this binding suits the page count — shown to the author. */
  rationale: string;
}

/**
 * Binding follows the page count: a thin book cannot hold a glued spine and is
 * saddle-stitched; past ~48 pages a perfect-bound (glued) spine is the norm,
 * which is where both real projects landed.
 */
export function recommendBinding(pageCount: number): BindingRecommendation {
  if (pageCount < 48) {
    return {
      id: "saddle_stitch",
      label: "saddle-stitched (stapled)",
      rationale: `${pageCount} pages is too few for a glued spine; saddle-stitching holds a thin book flat.`,
    };
  }
  return {
    id: "perfect_bound",
    label: "perfect-bound softcover (glued spine)",
    rationale: `${pageCount} pages carry a glued spine well — the standard softcover binding.`,
  };
}

export interface PrinterQuestion {
  question: string;
  answer: string;
}

export interface PrintChecklistInput {
  projectTitle: string;
  pageCount: number;
  pageSize: PageSizeDef;
  /** From the contract destination; defaults handled by the caller. */
  colorMode: "sRGB" | "CMYK";
  destinationLabel: string;
  fontsEmbedded: boolean;
  fontsDetail: string;
  /** Human sentence from the QA image-dpi check. */
  imageResolution: string;
  bleedMm: number;
  binding: BindingRecommendation;
  hasQrCodes: boolean;
  /** "attached" when a selected cover carries a file; else "pending". */
  coverStatus: "attached" | "pending";
  /** Whether a PDF/X variant is required and whether it was produced. */
  pdfx: { required: boolean; produced: boolean };
}

export interface PrintChecklist {
  oneLiner: string;
  interior: {
    format: string;
    pageCount: number;
    colorMode: string;
    fonts: string;
    imageResolution: string;
    bleed: string;
  };
  binding: string;
  paper: { interior: string; cover: string };
  cover: string;
  fileFormat: string;
  qrReminder: string | null;
  printerQuestions: PrinterQuestion[];
}

const PAPER_INTERIOR = "cream uncoated, 80 g/m²";
const PAPER_COVER = "300 g/m², laminated (matte or gloss)";

/** "A5 (14.8 × 21 cm)" — the format line shared by the checklist and one-liner. */
export function formatLabel(size: PageSizeDef): string {
  const cm = (mm: number) => (mm / 10).toLocaleString("en-US");
  return `${size.id} (${cm(size.widthMm)} × ${cm(size.heightMm)} cm)`;
}

/** One line the author can paste to a print shop; carries the real numbers. */
export function buildOneLiner(input: PrintChecklistInput): string {
  return (
    `${formatLabel(input.pageSize)} book, ${input.pageCount} pages, ` +
    `${input.binding.label}; interior ${PAPER_INTERIOR}, cover ${PAPER_COVER}.`
  );
}

export function buildPrintChecklist(input: PrintChecklistInput): PrintChecklist {
  const fonts = input.fontsEmbedded
    ? `all embedded (${input.fontsDetail})`
    : `NOT all embedded — ${input.fontsDetail}`;
  const fileFormat = input.pdfx.required
    ? input.pdfx.produced
      ? "PDF/X (CMYK) — generated alongside the interior PDF"
      : "PDF/X (CMYK) required for this destination — ask the printer to convert from the supplied PDF (Ghostscript was not available to do it here)"
    : "Press-ready PDF (interior), fonts embedded";

  const printerQuestions: PrinterQuestion[] = [
    {
      question: "What is the trim (page) size?",
      answer: formatLabel(input.pageSize),
    },
    { question: "How many pages?", answer: `${input.pageCount} pages.` },
    {
      question: "Colour or black & white? Which colour space?",
      answer:
        input.colorMode === "CMYK"
          ? "Print colour space CMYK (destination: " + input.destinationLabel + ")."
          : "sRGB / screen colour (destination: " + input.destinationLabel + ").",
    },
    {
      question: "What paper for the interior and the cover?",
      answer: `Interior ${PAPER_INTERIOR}; cover ${PAPER_COVER}.`,
    },
    { question: "Which binding?", answer: `${input.binding.label}. ${input.binding.rationale}` },
    {
      question: "Is there bleed?",
      answer: `Yes — ${input.bleedMm} mm bleed on all outer edges. Interior pages have no bleed unless an image runs to the edge.`,
    },
    {
      question: "Are the fonts embedded or outlined?",
      answer: input.fontsEmbedded
        ? "All fonts are embedded in the PDF."
        : "Not all fonts are embedded — this must be fixed before printing: " + input.fontsDetail,
    },
    { question: "What file format will you send?", answer: fileFormat },
    {
      question: "What about the cover and the spine width?",
      answer:
        input.coverStatus === "attached"
          ? "A cover spread is supplied; the spine width is to be confirmed with the printer (it depends on the final paper and page count)."
          : "The cover is still pending. The spine width is to be confirmed with the printer once the cover is ready — it depends on the final paper and page count.",
    },
  ];

  return {
    oneLiner: buildOneLiner(input),
    interior: {
      format: formatLabel(input.pageSize),
      pageCount: input.pageCount,
      colorMode:
        input.colorMode === "CMYK" ? "CMYK (print)" : "sRGB (screen)",
      fonts,
      imageResolution: input.imageResolution,
      bleed: `${input.bleedMm} mm on outer edges`,
    },
    binding: `${input.binding.label} — ${input.binding.rationale}`,
    paper: { interior: PAPER_INTERIOR, cover: PAPER_COVER },
    cover:
      input.coverStatus === "attached"
        ? "Cover spread supplied; spine width to be confirmed with the printer."
        : "Cover pending; spine width to be confirmed with the printer.",
    fileFormat,
    qrReminder: input.hasQrCodes
      ? "This book contains QR codes. Print a test copy and scan every QR before the full run — a QR that prints too small or low-contrast fails silently."
      : null,
    printerQuestions,
  };
}

/**
 * The checklist as the actionable toggle-list the Stage 8 UI tracks. Derived
 * from the same real data; the QR item appears only when the book has QR codes.
 */
export function checklistItemLabels(checklist: PrintChecklist): string[] {
  const items = [
    `Interior: ${checklist.interior.format}, ${checklist.interior.pageCount} pages — confirm with printer`,
    `Colour mode: ${checklist.interior.colorMode}`,
    `Fonts: ${checklist.interior.fonts}`,
    `Images: ${checklist.interior.imageResolution}`,
    `Bleed: ${checklist.interior.bleed}`,
    `Binding: ${checklist.binding}`,
    `Paper — interior: ${checklist.paper.interior}`,
    `Paper — cover: ${checklist.paper.cover}`,
    checklist.cover,
    `File format: ${checklist.fileFormat}`,
  ];
  if (checklist.qrReminder) items.push("Test-print and scan every QR code before the run");
  return items;
}

/** The full print-shop document the author hands over. */
export function renderChecklistMarkdown(
  title: string,
  checklist: PrintChecklist,
): string {
  const lines: string[] = [
    `# Print-shop checklist — ${title}`,
    "",
    "## One-line summary (paste to the printer)",
    "",
    checklist.oneLiner,
    "",
    "## Interior",
    "",
    `- Format: ${checklist.interior.format}`,
    `- Pages: ${checklist.interior.pageCount}`,
    `- Colour mode: ${checklist.interior.colorMode}`,
    `- Fonts: ${checklist.interior.fonts}`,
    `- Images: ${checklist.interior.imageResolution}`,
    `- Bleed: ${checklist.interior.bleed}`,
    `- File format: ${checklist.fileFormat}`,
    "",
    "## Binding & materials",
    "",
    `- Binding: ${checklist.binding}`,
    `- Interior paper: ${checklist.paper.interior}`,
    `- Cover paper: ${checklist.paper.cover}`,
    `- Cover: ${checklist.cover}`,
  ];
  if (checklist.qrReminder) {
    lines.push("", "## QR codes", "", `- ${checklist.qrReminder}`);
  }
  lines.push("", "## Likely printer questions (prepared answers)", "");
  for (const q of checklist.printerQuestions) {
    lines.push(`**${q.question}**`, "", q.answer, "");
  }
  return lines.join("\n");
}
