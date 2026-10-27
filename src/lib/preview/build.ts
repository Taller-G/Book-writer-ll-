import fs from "node:fs";
import path from "node:path";
import { dataDir, type DbHandle } from "../db/client";
import type { PdfVersion } from "../db/schema";
import { parseFormatData, type FormatConfigData } from "../format/config";
import { appendChange } from "../repo/changeLog";
import { getFormatConfig, saveFormatConfig } from "../repo/output";
import {
  getPdfVersion,
  insertPdfVersion,
  latestPdfVersion,
  nextPdfVersion,
} from "../repo/output";
import { setCorrectionStatus } from "../repo/correction";
import { getProject } from "../repo/projects";
import { insertText, latestText, nextTextVersion } from "../repo/texts";
import { diffVersions, parsePages, serializePages } from "./diff";
import { paginate, type Page } from "./paginate";
import { runQaSuite, type QaResult } from "./qa";

// The recompile → QA → diff pipeline of the correction cycle (spec §5.1).
// Every applied change (layout or content) and every rollback funnels through
// here, so the page model, the QA report and the visual diff are produced the
// same way no matter what triggered the rebuild.

export interface PreviewBuild {
  pages: Page[];
  pageCount: number;
  qa: QaResult;
  diff: ReturnType<typeof diffVersions>;
}

/**
 * Pure: lay the approved text into pages under the given format, run the QA
 * suite against that approved text, and diff the result against the previous
 * version's pages. No DB, no filesystem.
 */
export function computePreview(
  approvedText: string,
  format: FormatConfigData,
  previousPages: Page[],
): PreviewBuild {
  const pages = paginate(approvedText, format);
  const qa = runQaSuite({ approvedText, pages });
  const diff = diffVersions(previousPages, pages);
  return { pages, pageCount: pages.length, qa, diff };
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A simple page-structured HTML artifact for the built version. */
export function renderPreviewHtml(pages: Page[], title: string): string {
  const body = pages
    .map(
      (p) =>
        `<section class="page" data-page="${p.pageNumber}">\n` +
        p.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n") +
        `\n<div class="folio">${p.pageNumber}</div>\n</section>`,
    )
    .join("\n");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>\n` +
    `<style>.page{page-break-after:always;max-width:40em;margin:2em auto;min-height:60vh;` +
    `border-bottom:1px dashed #ccc;position:relative}.folio{text-align:center;color:#888}</style>\n` +
    `</head><body>${body}</body></html>`
  );
}

function writeVersionFile(
  projectId: string,
  version: number,
  html: string,
): string {
  const dir = path.join(dataDir(), "exports", projectId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `book-v${version}.html`);
  fs.writeFileSync(filePath, html);
  return filePath;
}

export interface CreatedVersion extends PreviewBuild {
  version: number;
  filePath: string;
}

/**
 * Recompile a new PDF version from the approved text and format, writing its
 * artifact and recording the version (with its QA report and visual diff). The
 * caller supplies the change-log entry fields and, optionally, the correction
 * message to mark applied — all committed in one transaction.
 */
export function createPdfVersion(
  handle: DbHandle,
  input: {
    projectId: string;
    approvedText: string;
    format: FormatConfigData;
    sourceTextVersion?: number;
    kind: PdfVersion["kind"];
    notes: string;
    change: { what: string; where: string; why: string; authorizedBy: string };
    messageId?: string;
  },
): CreatedVersion {
  const { db, sqlite } = handle;
  const previous = latestPdfVersion(db, input.projectId);
  const build = computePreview(
    input.approvedText,
    input.format,
    parsePages(previous?.pages),
  );
  const title = getProject(db, input.projectId)?.title ?? "Book";
  const version = nextPdfVersion(db, input.projectId);
  const filePath = writeVersionFile(
    input.projectId,
    version,
    renderPreviewHtml(build.pages, `${title} — v${version}`),
  );
  sqlite.transaction(() => {
    insertPdfVersion(db, {
      projectId: input.projectId,
      version,
      filePath,
      notes: input.notes,
      pages: serializePages(build.pages),
      pageCount: build.pageCount,
      sourceTextVersion: input.sourceTextVersion,
      kind: input.kind,
      qa: JSON.stringify(build.qa),
      diff: JSON.stringify(build.diff),
    });
    appendChange(db, { projectId: input.projectId, ...input.change });
    if (input.messageId) {
      setCorrectionStatus(db, input.messageId, "applied", { pdfVersion: version });
    }
  })();
  return { ...build, version, filePath };
}

export class CorrectionError extends Error {}

/**
 * Deep-merge a partial format patch over the current configuration. Arrays and
 * primitives in the patch replace; nested objects merge.
 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (
    typeof base !== "object" ||
    base === null ||
    Array.isArray(base) ||
    typeof patch !== "object" ||
    patch === null ||
    Array.isArray(patch)
  ) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

/**
 * Apply a LAYOUT change: adjust the template (format config) and recompile.
 * The master text is never read for writing and never changed — the draft-first
 * rule means a layout request can be applied straight away.
 */
export function applyLayoutChange(
  handle: DbHandle,
  input: {
    projectId: string;
    formatPatch: Partial<FormatConfigData> | Record<string, unknown>;
    messageId?: string;
    authorizedBy?: string;
    summary?: string;
  },
): CreatedVersion {
  const { db } = handle;
  const finalText = latestText(db, input.projectId, "final");
  if (!finalText) {
    throw new CorrectionError(
      "There is no approved FINAL text yet — finalize the text before correcting the layout.",
    );
  }
  const current = parseFormatData(getFormatConfig(db, input.projectId).data);
  const merged = deepMerge(current, input.formatPatch);
  saveFormatConfig(db, input.projectId, merged);
  return createPdfVersion(handle, {
    projectId: input.projectId,
    approvedText: finalText.content,
    format: merged,
    sourceTextVersion: finalText.version,
    kind: "preview",
    notes: `Layout change: ${input.summary ?? "template adjusted"}`,
    change: {
      what: `Layout change applied — ${input.summary ?? "template adjusted"} (master text untouched)`,
      where: "stage 8 · correction cycle · layout",
      why: "layout-only correction request; the draft text stays as approved",
      authorizedBy: input.authorizedBy ?? "user (correction cycle)",
    },
    messageId: input.messageId,
  });
}

/**
 * Apply a CONTENT change: reopen the closed master text. This modifies text the
 * user already approved, so it MUST be gated behind an explicit confirmation —
 * the caller is responsible for only calling this after the user confirmed, and
 * the server action enforces it via the message's awaiting_confirmation status.
 * The edit lands as a new FINAL text version through the same insertText +
 * change_log mechanism as every other edit, then the preview recompiles.
 */
export function applyContentChange(
  handle: DbHandle,
  input: {
    projectId: string;
    newFinalText: string;
    targetRef: string;
    messageId?: string;
    authorizedBy?: string;
  },
): CreatedVersion & { textVersion: number } {
  const { db, sqlite } = handle;
  const current = latestText(db, input.projectId, "final");
  if (!current) {
    throw new CorrectionError(
      "There is no approved FINAL text to modify. Finalize the text first.",
    );
  }
  if (input.newFinalText.trim() === "") {
    throw new CorrectionError("The content change produced no text — nothing applied.");
  }
  const format = parseFormatData(getFormatConfig(db, input.projectId).data);
  const authorizedBy = input.authorizedBy ?? "user (confirmed content change)";
  // Reopen the closed text: a new FINAL version, logged, before recompiling.
  const textVersion = nextTextVersion(db, input.projectId, "final");
  sqlite.transaction(() => {
    insertText(db, {
      projectId: input.projectId,
      stageKey: "final",
      version: textVersion,
      content: input.newFinalText,
    });
    appendChange(db, {
      projectId: input.projectId,
      what: `Content change applied — this modifies ${input.targetRef} (FINAL text v${textVersion})`,
      where: "stage 8 · correction cycle · content",
      why: "confirmed content-change request reopened the closed master text",
      authorizedBy,
    });
  })();
  const created = createPdfVersion(handle, {
    projectId: input.projectId,
    approvedText: input.newFinalText,
    format,
    sourceTextVersion: textVersion,
    kind: "export",
    notes: `Content change: ${input.targetRef}`,
    change: {
      what: `Recompiled export after content change to ${input.targetRef}`,
      where: "stage 8 · correction cycle · content",
      why: "re-render the approved text after a confirmed content change",
      authorizedBy,
    },
    messageId: input.messageId,
  });
  return { ...created, textVersion };
}

/**
 * Roll back to an earlier PDF version by creating a NEW version that restores it
 * exactly: the same pages, page count, QA report and file bytes. History is
 * preserved (nothing is deleted) and the restored version becomes the current
 * one.
 */
export function rollbackTo(
  handle: DbHandle,
  input: { projectId: string; version: number; authorizedBy?: string },
): PdfVersion {
  const { db, sqlite } = handle;
  const target = getPdfVersion(db, input.projectId, input.version);
  if (!target) {
    throw new CorrectionError(`PDF version ${input.version} does not exist.`);
  }
  const version = nextPdfVersion(db, input.projectId);
  const dir = path.join(dataDir(), "exports", input.projectId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `book-v${version}.html`);
  // Copy the exact bytes so the restored artifact is byte-identical.
  try {
    fs.copyFileSync(target.filePath, filePath);
  } catch {
    // Source artifact missing: reconstruct from the stored pages so the
    // restored version still carries identical content.
    fs.writeFileSync(
      filePath,
      renderPreviewHtml(parsePages(target.pages), `Restored v${target.version}`),
    );
  }
  let restored: PdfVersion;
  sqlite.transaction(() => {
    restored = insertPdfVersion(db, {
      projectId: input.projectId,
      version,
      filePath,
      notes: `Rolled back to v${target.version}`,
      pages: target.pages,
      pageCount: target.pageCount,
      sourceTextVersion: target.sourceTextVersion ?? undefined,
      kind: "rollback",
      rolledBackFrom: target.version,
      qa: target.qa,
      diff: target.diff,
    });
    appendChange(db, {
      projectId: input.projectId,
      what: `Rolled back to PDF v${target.version} (restored as v${version})`,
      where: "stage 8 · correction cycle · version history",
      why: "user restored an earlier PDF version exactly",
      authorizedBy: input.authorizedBy ?? "user (correction cycle)",
    });
  })();
  return restored!;
}
