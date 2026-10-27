import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import {
  buildOneLiner,
  buildPrintChecklist,
  checklistItemLabels,
  recommendBinding,
  type PrintChecklistInput,
} from "@/lib/export/checklist";
import { readPdfInfo } from "@/lib/export/pdfInfo";
import { detectQrCodes } from "@/lib/export/qr";
import { getPageSize } from "@/lib/format/config";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { insertPdfVersion, listChecklist, listPdfVersions } from "@/lib/repo/output";
import { createProject } from "@/lib/repo/projects";
import { insertText } from "@/lib/repo/texts";
import type { QaCheck } from "@/lib/render/qa";

// ---------------------------------------------------------------------------
// Pure core — no external tools.
// ---------------------------------------------------------------------------

function baseInput(over: Partial<PrintChecklistInput> = {}): PrintChecklistInput {
  return {
    projectTitle: "Memoir",
    pageCount: 248,
    pageSize: getPageSize("A5"),
    colorMode: "CMYK",
    destinationLabel: "ISBN publication",
    fontsEmbedded: true,
    fontsDetail: "2 font(s), all embedded.",
    imageResolution: "No raster images in the PDF.",
    bleedMm: 3,
    binding: recommendBinding(248),
    hasQrCodes: false,
    coverStatus: "pending",
    pdfx: { required: true, produced: true },
    ...over,
  };
}

describe("print-shop checklist core", () => {
  it("the one-liner carries the real page count and format", () => {
    const line = buildOneLiner(baseInput({ pageCount: 311 }));
    expect(line).toContain("311");
    expect(line).toContain("A5");
    expect(line).toContain("14.8 × 21 cm");
  });

  it("binding is recommended from the page count", () => {
    expect(recommendBinding(20).id).toBe("saddle_stitch");
    expect(recommendBinding(248).id).toBe("perfect_bound");
  });

  it("detects QR codes in the book text, without false positives", () => {
    expect(detectQrCodes("Scan the QR code to hear the original audio.")).toBe(true);
    expect(detectQrCodes("Escaneá este código QR para escuchar.")).toBe(true);
    expect(detectQrCodes("A plain chapter with no codes at all.")).toBe(false);
    expect(detectQrCodes("The square root and the acquirer agreed.")).toBe(false);
  });

  it("the QR checklist item appears only when the book has QR codes", () => {
    const withQr = checklistItemLabels(buildPrintChecklist(baseInput({ hasQrCodes: true })));
    const withoutQr = checklistItemLabels(buildPrintChecklist(baseInput({ hasQrCodes: false })));
    expect(withQr.some((l) => /QR/i.test(l))).toBe(true);
    expect(withoutQr.some((l) => /QR/i.test(l))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Executor — reads the real PDF via poppler (pdfinfo) and the stored QA report.
// ---------------------------------------------------------------------------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-export-"));
process.env.BOOK_WRITER_DATA_DIR = dataDir;
const FIXTURE_PDF = path.resolve(process.cwd(), "tests/fixtures/sample.pdf");

afterAll(() => {
  delete process.env.BOOK_WRITER_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PASS_CHECKS: QaCheck[] = [
  {
    id: "fonts_embedded",
    title: "All fonts embedded in the PDF",
    passed: true,
    pages: [],
    detail: "2 font(s), all embedded.",
  },
  {
    id: "image_dpi",
    title: "Images at ≥300 dpi at printed size",
    passed: true,
    pages: [],
    detail: "No raster images in the PDF.",
  },
];

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Export test", author: "A. Author" }).id;
});

function seedFinalText(content: string): void {
  insertText(handle.db, { projectId, stageKey: "final", version: 1, content });
}

/** Insert a Stage-7-style render row + its stored QA report JSON. */
function seedRender(passed: boolean, checks: QaCheck[]): void {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-qa-"));
  const mdPath = path.join(reportDir, "qa-v1.md");
  fs.writeFileSync(mdPath, "# QA report\n");
  fs.writeFileSync(
    path.join(reportDir, "qa-v1.json"),
    JSON.stringify({ passed, checks }),
  );
  insertPdfVersion(handle.db, {
    projectId,
    version: 1,
    filePath: FIXTURE_PDF,
    textVersion: 1,
    formatHash: "abc123def456",
    qaPassed: passed ? 1 : 0,
    qaReportPath: mdPath,
  });
}

async function runExport() {
  return enqueueAndRun(handle, { projectId, stage: 8, type: "export_book" });
}

describe("export_book executor", () => {
  it("derives the checklist page count from the actual PDF and the one-liner carries it", async () => {
    seedFinalText("## Chapter One\n\nA quiet opening paragraph for the book.");
    seedRender(true, PASS_CHECKS);

    const job = await runExport();
    expect(job.status).toBe("succeeded");

    const out = JSON.parse(job.output!);
    const actualPages = readPdfInfo(FIXTURE_PDF).pageCount;
    expect(actualPages).toBeGreaterThan(0);
    expect(out.pageCount).toBe(actualPages); // from the PDF, not the config
    expect(out.oneLiner).toContain(String(actualPages));
    expect(out.oneLiner).toContain("A5");

    // The toggle-checklist is seeded from the same real data.
    const items = listChecklist(handle.db, projectId);
    expect(items.some((i) => i.label.includes(String(actualPages)))).toBe(true);
    expect(items.some((i) => i.label.toLowerCase().includes("font"))).toBe(true);

    // The interior PDF was copied into the export bundle.
    expect(fs.existsSync(out.interiorPath)).toBe(true);
  });

  it("blocks the export when the latest render's QA report has failures, naming them", async () => {
    seedFinalText("## Chapter One\n\nText.");
    seedRender(false, [
      {
        id: "folio_overlap",
        title: "No text overlaps the folio (page number)",
        passed: false,
        pages: [61],
        detail: "Text intersects the folio zone on page(s) 61.",
      },
      ...PASS_CHECKS,
    ]);

    const job = await runExport();
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/Export blocked/);
    expect(job.error).toContain("No text overlaps the folio (page number)");
    expect(job.error).toContain("61");
    // Nothing was exported: no export row was written.
    const exportRows = listPdfVersions(handle.db, projectId).filter(
      (v) => v.textVersion === null,
    );
    expect(exportRows).toHaveLength(0);
  });

  it("refuses to export before a typeset PDF exists", async () => {
    seedFinalText("## Chapter One\n\nText.");
    const job = await runExport();
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/no typeset PDF/i);
  });

  it("shows the QR print-test reminder when the book contains QR codes", async () => {
    seedFinalText(
      "## Chapter One\n\nScan the QR code below to hear the original recording.",
    );
    seedRender(true, PASS_CHECKS);

    const job = await runExport();
    expect(job.status).toBe("succeeded");
    const out = JSON.parse(job.output!);
    expect(out.hasQrCodes).toBe(true);
    expect(out.qrReminder).toMatch(/QR/);
    expect(
      listChecklist(handle.db, projectId).some((i) => /QR/i.test(i.label)),
    ).toBe(true);
  });

  it("omits the QR reminder for a book without QR codes", async () => {
    seedFinalText("## Chapter One\n\nA book with no codes of any kind.");
    seedRender(true, PASS_CHECKS);

    const job = await runExport();
    expect(job.status).toBe("succeeded");
    const out = JSON.parse(job.output!);
    expect(out.hasQrCodes).toBe(false);
    expect(out.qrReminder).toBeNull();
    expect(
      listChecklist(handle.db, projectId).some((i) => /QR/i.test(i.label)),
    ).toBe(false);
  });
});
