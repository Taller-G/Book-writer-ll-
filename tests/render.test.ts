import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { listPdfVersions } from "@/lib/repo/output";
import { createProject } from "@/lib/repo/projects";
import { insertText } from "@/lib/repo/texts";
import { composeBook, CompositionMismatchError } from "@/lib/render/compose";
import { renderComposed, type RenderInput } from "@/lib/render/render";
import type { FormatConfig } from "@/lib/db/schema";

// End-to-end acceptance tests for the Stage 6.1–6.2 work order: the whole
// pipeline from approved FINAL text to versioned, QA-checked PDF artifact.

const PARA =
  "It was a quiet morning and the harbour slept while the gulls stayed silent " +
  "over the long grey water, waiting for the first boats to leave the pier.";

const APPROVED = `## The Beginning

${PARA}

* * *

${PARA}

## The Middle

${PARA}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-render-"));
process.env.BOOK_WRITER_DATA_DIR = dataDir;

afterAll(() => {
  delete process.env.BOOK_WRITER_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Render test", author: "A. Author" }).id;
});

function seedFinalText(content = APPROVED): void {
  insertText(handle.db, { projectId, stageKey: "final", version: 1, content });
}

async function runRender() {
  return enqueueAndRun(handle, { projectId, stage: 7, type: "render_pdf" });
}

describe("render_pdf end to end", () => {
  it("a fully passing run produces a versioned PDF and a green QA report with TOC in sync", async () => {
    seedFinalText();
    const job = await runRender();
    expect(job.status).toBe("succeeded");
    const output = JSON.parse(job.output!);
    expect(output.qaPassed).toBe(true);

    const versions = listPdfVersions(handle.db, projectId);
    expect(versions).toHaveLength(1);
    const v = versions[0];
    expect(v.version).toBe(1);
    expect(v.textVersion).toBe(1); // tied to the FINAL text version
    expect(v.formatHash).toMatch(/^[0-9a-f]{12}$/); // tied to the format settings
    expect(v.qaPassed).toBe(1);
    expect(fs.existsSync(v.filePath)).toBe(true);
    expect(v.filePath).toContain("book-v1.pdf");

    const reportJson = JSON.parse(
      fs.readFileSync(v.qaReportPath!.replace(/\.md$/, ".json"), "utf8"),
    );
    expect(reportJson.passed).toBe(true);
    const toc = reportJson.checks.find((c: { id: string }) => c.id === "toc_sync");
    expect(toc.passed).toBe(true);
    const md = fs.readFileSync(v.qaReportPath!, "utf8");
    expect(md).toContain("✅ PASS");
  }, 180_000);

  it("a one-word discrepancy between approved and composed text aborts the render naming the position", async () => {
    seedFinalText();
    const format: FormatConfig = {
      projectId,
      trimSize: "6x9in",
      fontFamily: "Palatino",
      fontSizePt: 11,
      lineHeight: 1.4,
      margins: '{"top":"20mm","bottom":"20mm","inner":"22mm","outer":"16mm"}',
      data: "{}",
      updatedAt: "2026-10-27 00:00:00",
    };
    const composition = composeBook(APPROVED, format, { title: "T", author: "A" });
    // Inject the discrepancy between approval and composition.
    composition.tex = composition.tex.replace("harbour", "harbor");
    const outDir = path.join(dataDir, "exports", projectId);
    const input: RenderInput = {
      approvedText: APPROVED,
      format,
      meta: { title: "T", author: "A" },
      buildDir: path.join(outDir, "build"),
      outDir,
      pdfVersion: 1,
      textVersion: 1,
    };
    await expect(renderComposed(input, composition)).rejects.toThrow(
      CompositionMismatchError,
    );
    await expect(renderComposed(input, composition)).rejects.toThrow(
      /word 10\b.*"harbour".*"harbor"/,
    );
    // The render aborted: no PDF artifact was produced.
    expect(fs.existsSync(path.join(outDir, "book-v1.pdf"))).toBe(false);
  });

  it("a corrupted intermediate state recovers automatically via auxiliary cleanup", async () => {
    seedFinalText();
    // Simulate an aborted earlier run that left broken auxiliaries behind.
    const buildDir = path.join(dataDir, "exports", projectId, "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "book.aux"), "\\relax\n\\thisMacroDoesNotExist{\n");
    fs.writeFileSync(path.join(buildDir, "book.toc"), "\\contentsline {chapter}{\\broken{");

    const job = await runRender();
    expect(job.status).toBe("succeeded");
    const output = JSON.parse(job.output!);
    expect(output.recoveredFromCorruption).toBe(true);
    expect(output.qaPassed).toBe(true);
  }, 180_000);

  it("refuses to render without a FINAL text", async () => {
    const job = await runRender();
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/no FINAL text/);
    expect(listPdfVersions(handle.db, projectId)).toHaveLength(0);
  });

  it("re-rendering bumps the artifact version", async () => {
    seedFinalText();
    const first = await runRender();
    const second = await runRender();
    expect(first.outputVersion).toBe(1);
    expect(second.outputVersion).toBe(2);
    const versions = listPdfVersions(handle.db, projectId);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(fs.existsSync(versions[0].filePath)).toBe(true);
  }, 180_000);
});
