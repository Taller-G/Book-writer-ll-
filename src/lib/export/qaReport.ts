import fs from "node:fs";
import type { QaCheck, QaReport } from "../render/qa";

// The layout engine (Stage 7) writes qa-v{n}.json next to the PDF it describes.
// Stage 8 reads that persisted report as the authority on whether the PDF may
// ship — the export never re-runs QA, it honours the report already on record.

export interface StoredQaReport extends QaReport {
  /** Context the report was written with (title, versions, font…). */
  [key: string]: unknown;
}

/** Path of the JSON report that sits beside the markdown one. */
export function qaJsonPathFor(markdownPath: string): string {
  return markdownPath.replace(/\.md$/, ".json");
}

/**
 * Load the stored QA report for a render. `markdownPath` is the value kept on
 * the pdf_versions row (qa_report_path); the JSON sibling carries the checks.
 */
export function readQaReport(markdownPath: string): StoredQaReport {
  const jsonPath = qaJsonPathFor(markdownPath);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as StoredQaReport;
  if (!Array.isArray(parsed.checks)) {
    throw new Error(`QA report at ${jsonPath} has no checks array`);
  }
  return parsed;
}

export function qaCheck(report: QaReport, id: string): QaCheck | undefined {
  return report.checks.find((c) => c.id === id);
}

/** The failing checks, in report order — the reasons an export is blocked. */
export function failingChecks(report: QaReport): QaCheck[] {
  return report.checks.filter((c) => !c.passed);
}
