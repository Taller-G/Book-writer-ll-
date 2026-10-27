import fs from "node:fs";
import path from "node:path";
import type { FormatConfig } from "../db/schema";
import { sha1 } from "../files/store";
import { compileBook } from "./compile";
import {
  composeBook,
  parseMargins,
  verifyComposition,
  type Composition,
  type PlacedImage,
} from "./compose";
import { runQa, type QaReport } from "./qa";
import { writeQaReport, type QaReportFiles } from "./report";

// The full render pipeline: compose → verify word-for-word → compile (twice,
// with auxiliary-cleanup recovery) → post-render QA → versioned artifacts.
// Pure filesystem/computation — all database writes stay in the executor.

export interface RenderInput {
  /**
   * The text to typeset, verified word-for-word against the composition. When
   * the book has images this is the FINAL text with the credits section already
   * appended, so the credits are part of the verified text.
   */
  approvedText: string;
  format: FormatConfig;
  /** Placed images (spec §4 Stage 6.4), positioned in the body in order. */
  images?: PlacedImage[];
  meta: { title: string; author: string };
  /** Persistent per-project build dir — aux files live (and get cleaned) here. */
  buildDir: string;
  /** Where the versioned PDF and QA report land. */
  outDir: string;
  pdfVersion: number;
  textVersion: number;
}

export interface RenderResult {
  pdfPath: string;
  formatHash: string;
  qaReport: QaReport;
  qaFiles: QaReportFiles;
  recoveredFromCorruption: boolean;
  fontUsed: string;
  fontSubstituted: boolean;
}

/** Fingerprint of the format settings that shaped this render. */
export function formatHash(format: FormatConfig): string {
  const relevant = {
    trimSize: format.trimSize,
    fontFamily: format.fontFamily,
    fontSizePt: format.fontSizePt,
    lineHeight: format.lineHeight,
    margins: format.margins,
  };
  return sha1(Buffer.from(JSON.stringify(relevant))).slice(0, 12);
}

export async function renderBook(input: RenderInput): Promise<RenderResult> {
  const composition = composeBook(
    input.approvedText,
    input.format,
    input.meta,
    input.images ?? [],
  );
  return renderComposed(input, composition);
}

/** The pipeline after composition — the verification gate runs here. */
export async function renderComposed(
  input: RenderInput,
  composition: Composition,
): Promise<RenderResult> {
  // Abort gate: the composition must carry the approved text word for word.
  verifyComposition(input.approvedText, composition.tex);

  const compiled = await compileBook(input.buildDir, composition.tex);

  fs.mkdirSync(input.outDir, { recursive: true });
  const pdfPath = path.join(input.outDir, `book-v${input.pdfVersion}.pdf`);
  fs.copyFileSync(compiled.pdfPath, pdfPath);

  const qaReport = runQa(pdfPath, {
    chapterTitles: composition.chapterTitles,
    separatorCount: composition.separatorCount,
    margins: parseMargins(input.format.margins),
  });
  const hash = formatHash(input.format);
  const qaFiles = writeQaReport(input.outDir, qaReport, {
    projectTitle: input.meta.title,
    pdfVersion: input.pdfVersion,
    textVersion: input.textVersion,
    formatHash: hash,
    recoveredFromCorruption: compiled.recoveredFromCorruption,
    fontUsed: composition.font.family,
    fontSubstituted: composition.font.substituted,
  });

  return {
    pdfPath,
    formatHash: hash,
    qaReport,
    qaFiles,
    recoveredFromCorruption: compiled.recoveredFromCorruption,
    fontUsed: composition.font.family,
    fontSubstituted: composition.font.substituted,
  };
}
