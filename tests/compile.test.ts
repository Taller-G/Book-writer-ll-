import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { composeBook } from "@/lib/render/compose";
import { compileBook, isValidPdf } from "@/lib/render/compile";
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

const TEXT = `## One

A short first chapter.

## Two

And a second one.`;

const tmpDirs: string[] = [];
function workDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-compile-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("compileBook", () => {
  it("compiles a composed book to a valid PDF", async () => {
    const { tex } = composeBook(TEXT, FORMAT, { title: "T", author: "A" });
    const result = await compileBook(workDir(), tex);
    expect(result.recoveredFromCorruption).toBe(false);
    expect(isValidPdf(result.pdfPath)).toBe(true);
  }, 120_000);

  it("recovers from a corrupted intermediate state by cleaning auxiliaries", async () => {
    const dir = workDir();
    // A stale, broken .aux from an aborted earlier run: the first compile
    // attempt fails on it, the driver must clean up and compile again.
    fs.writeFileSync(path.join(dir, "book.aux"), "\\relax\n\\thisMacroDoesNotExist{\n");
    fs.writeFileSync(path.join(dir, "book.toc"), "\\contentsline {chapter}{\\broken{");
    const { tex } = composeBook(TEXT, FORMAT, { title: "T", author: "A" });
    const result = await compileBook(dir, tex);
    expect(result.recoveredFromCorruption).toBe(true);
    expect(isValidPdf(result.pdfPath)).toBe(true);
  }, 120_000);

  it("fails with the TeX error when the source itself is broken", async () => {
    await expect(
      compileBook(workDir(), "\\documentclass{memoir}\\begin{document}\\badmacro\\end{document}"),
    ).rejects.toThrow(/xelatex failed/);
  }, 120_000);

  it("rejects non-PDF files as invalid", () => {
    const dir = workDir();
    const fake = path.join(dir, "fake.pdf");
    fs.writeFileSync(fake, "this is not a pdf");
    expect(isValidPdf(fake)).toBe(false);
    expect(isValidPdf(path.join(dir, "missing.pdf"))).toBe(false);
  });
});
