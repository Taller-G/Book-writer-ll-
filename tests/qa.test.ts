import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeBook } from "@/lib/render/compose";
import { compileBook } from "@/lib/render/compile";
import { runQa, toPt, type QaExpectations, type QaReport } from "@/lib/render/qa";
import { writeQaReport } from "@/lib/render/report";
import type { FormatConfig } from "@/lib/db/schema";

const FORMAT: FormatConfig = {
  projectId: "p1",
  trimSize: "6x9in",
  fontFamily: "Palatino",
  fontSizePt: 11,
  lineHeight: 1.4,
  margins: '{"top":"20mm","bottom":"20mm","inner":"22mm","outer":"16mm"}',
  data: "{}",
  updatedAt: "2026-10-27 00:00:00",
};

const MARGINS = { top: "20mm", bottom: "20mm", inner: "22mm", outer: "16mm" };

const PARA =
  "It was a quiet morning and the harbour slept while the gulls stayed silent " +
  "over the long grey water, waiting for the first boats to leave the pier.";

const GREEN_TEXT = `## The Beginning

${PARA}

${PARA}

* * *

${PARA}

## The Middle

${PARA}

${PARA}`;

const tmpDirs: string[] = [];
function workDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-qa-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// A memoir page shaped like the real template, with one line forced down into
// the folio zone — the historical 61-page defect, reproduced on purpose.
const OVERLAP_TEX = `\\documentclass[11pt,twoside,openright]{memoir}
\\setstocksize{9in}{6in}
\\settrimmedsize{9in}{6in}{*}
\\setlrmarginsandblock{22mm}{16mm}{*}
\\setulmarginsandblock{20mm}{20mm}{*}
\\checkandfixthelayout
\\usepackage{fontspec}
\\setmainfont{Palatino}
\\pagestyle{plain}
\\aliaspagestyle{chapter}{plain}
\\begin{document}
\\mainmatter
\\chapter{Overlap}
Some normal opening text for the chapter.

\\noindent\\raisebox{-362pt}[0pt][0pt]{This line is pushed down into the folio area of the page.}

More regular text after the overlapping line.
\\end{document}
`;

/** Minimal valid PDF using base-14 Helvetica — a font that is NOT embedded. */
function buildNonEmbeddedFontPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 432 648] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, // content stream, built below
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 12 Tf 72 600 Td (Hello world) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function expectations(overrides?: Partial<QaExpectations>): QaExpectations {
  return {
    chapterTitles: ["The Beginning", "The Middle"],
    separatorCount: 1,
    margins: MARGINS,
    ...overrides,
  };
}

function check(report: QaReport, id: string) {
  const c = report.checks.find((c) => c.id === id);
  expect(c, `check ${id} missing`).toBeDefined();
  return c!;
}

describe("post-render QA suite", () => {
  let greenPdf: string;
  let greenReport: QaReport;

  beforeAll(async () => {
    const { tex } = composeBook(GREEN_TEXT, FORMAT, { title: "T", author: "A" });
    const result = await compileBook(workDir(), tex);
    greenPdf = result.pdfPath;
    greenReport = runQa(greenPdf, expectations());
  }, 180_000);

  it("a clean render passes every check", () => {
    for (const c of greenReport.checks) {
      expect(c.passed, `${c.id}: ${c.detail}`).toBe(true);
    }
    expect(greenReport.passed).toBe(true);
  });

  it("TOC page numbers match the actual chapter pages", () => {
    const toc = check(greenReport, "toc_sync");
    expect(toc.passed).toBe(true);
    expect(toc.detail).toContain("match the printed pages");
  });

  it("a folio overlapping text fails QA naming the affected pages", async () => {
    const result = await compileBook(workDir(), OVERLAP_TEX);
    const report = runQa(
      result.pdfPath,
      expectations({ chapterTitles: ["Overlap"], separatorCount: 0 }),
    );
    const folio = check(report, "folio_overlap");
    expect(folio.passed).toBe(false);
    expect(folio.pages).toEqual([1]);
    expect(report.passed).toBe(false);
  }, 120_000);

  it("a PDF with a non-embedded font fails QA", () => {
    const pdfPath = path.join(workDir(), "nonembedded.pdf");
    fs.writeFileSync(pdfPath, buildNonEmbeddedFontPdf());
    const report = runQa(
      pdfPath,
      expectations({ chapterTitles: [], separatorCount: 0 }),
    );
    const fonts = check(report, "fonts_embedded");
    expect(fonts.passed).toBe(false);
    expect(fonts.detail).toContain("Helvetica");
    expect(report.passed).toBe(false);
  });

  it("writes a readable QA report (json + markdown)", () => {
    const dir = workDir();
    const files = writeQaReport(dir, greenReport, {
      projectTitle: "T",
      pdfVersion: 1,
      textVersion: 2,
      formatHash: "abc123",
      recoveredFromCorruption: false,
      fontUsed: "Palatino",
      fontSubstituted: false,
    });
    const json = JSON.parse(fs.readFileSync(files.jsonPath, "utf8"));
    expect(json.passed).toBe(true);
    expect(json.checks).toHaveLength(greenReport.checks.length);
    const md = fs.readFileSync(files.markdownPath, "utf8");
    expect(md).toContain("✅ PASS");
    expect(md).toContain("Table of contents in sync");
  });

  it("converts dimension strings to points", () => {
    expect(toPt("72pt")).toBe(72);
    expect(toPt("1in")).toBe(72);
    expect(toPt("25.4mm")).toBeCloseTo(72, 5);
  });
});
