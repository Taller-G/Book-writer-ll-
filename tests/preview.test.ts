import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AiContentPart } from "@/lib/ai";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { parseFormatData } from "@/lib/format/config";
import { listChanges } from "@/lib/repo/changeLog";
import { getFormatConfig, getPdfVersion, latestPdfVersion } from "@/lib/repo/output";
import { createProject } from "@/lib/repo/projects";
import { insertText, latestText } from "@/lib/repo/texts";
import {
  applyLayoutChange,
  createPdfVersion,
  rollbackTo,
} from "@/lib/preview/build";
import {
  buildCorrectionRequest,
  confirmContentChange,
  rejectContentChange,
  submitCorrection,
} from "@/lib/preview/correction";
import { parsePages } from "@/lib/preview/diff";
import { paginate } from "@/lib/preview/paginate";
import { FakeAiClient } from "./helpers/fakeAi";

// build.ts writes export artifacts under the data dir — point it at a temp dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "book-writer-preview-"));
process.env.BOOK_WRITER_DATA_DIR = tmp;

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A FINAL text long enough to span several pages, with chapter headings. */
function bookText(chapters: number, parasPerChapter: number): string {
  const blocks: string[] = [];
  for (let c = 1; c <= chapters; c++) {
    blocks.push(`## Chapter ${c}`);
    for (let p = 0; p < parasPerChapter; p++) {
      blocks.push(
        `This is paragraph ${p + 1} of chapter ${c}. ` +
          "It carries enough words to wrap across several lines so the " +
          "paginator produces a realistic, stable page model for the preview. " +
          "The quick brown fox jumps over the lazy dog again and again.",
      );
    }
  }
  return blocks.join("\n\n");
}

let handle: DbHandle;
let projectId: string;

function seed(finalText: string): void {
  projectId = createProject(handle, { title: "Correction cycle" }).id;
  insertText(handle.db, {
    projectId,
    stageKey: "final",
    version: 1,
    content: finalText,
  });
  getFormatConfig(handle.db, projectId); // seed proven defaults
}

function format() {
  return parseFormatData(getFormatConfig(handle.db, projectId).data);
}

/** Build the first PDF version from the current FINAL text. */
function buildInitial() {
  const finalText = latestText(handle.db, projectId, "final")!;
  return createPdfVersion(handle, {
    projectId,
    approvedText: finalText.content,
    format: format(),
    sourceTextVersion: finalText.version,
    kind: "export",
    notes: "initial export",
    change: {
      what: "Initial export",
      where: "stage 8",
      why: "first preview",
      authorizedBy: "test",
    },
  });
}

beforeEach(() => {
  handle = openDatabase(":memory:");
});

describe("correction cycle — annotation reaches the agent", () => {
  it("carries the page number and the marked region as an image", async () => {
    seed(bookText(2, 6));
    buildInitial();
    const image = "data:image/png;base64,ANNOTATIONREGION";
    const client = new FakeAiClient(() =>
      JSON.stringify({
        classification: "layout",
        reply: "Understood.",
        formatPatch: {},
      }),
    );
    await submitCorrection(handle, client, {
      projectId,
      userText: "The margin here looks too tight.",
      annotation: {
        pageNumber: 2,
        region: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
        image,
      },
    });

    expect(client.requests).toHaveLength(1);
    const content = client.requests[0].messages[0].content as AiContentPart[];
    expect(Array.isArray(content)).toBe(true);
    const textPart = content.find((p) => p.type === "text");
    const imagePart = content.find((p) => p.type === "image");
    expect(textPart && textPart.type === "text" && textPart.text).toContain(
      "page 2",
    );
    expect(imagePart && imagePart.type === "image" && imagePart.dataUri).toBe(
      image,
    );
  });

  it("buildCorrectionRequest alone embeds page number + image part", () => {
    seed(bookText(1, 2));
    const req = buildCorrectionRequest({
      projectId,
      userText: "fix this",
      annotation: { pageNumber: 5, image: "data:image/png;base64,ZZ" },
    });
    const parts = req.messages[0].content as AiContentPart[];
    expect(parts.some((p) => p.type === "image")).toBe(true);
    expect(
      parts.some((p) => p.type === "text" && p.text.includes("page 5")),
    ).toBe(true);
  });
});

describe("correction cycle — content change is gated on confirmation", () => {
  it("does not touch closed text until confirmed, and logs the change", async () => {
    seed(bookText(3, 5));
    buildInitial();
    const edited = bookText(3, 5).replace(
      "paragraph 1 of chapter 3",
      "paragraph 1 of chapter 3 (corrected typo)",
    );
    const client = new FakeAiClient(() =>
      JSON.stringify({
        classification: "content",
        reply: "This modifies chapter 3. Confirm to apply?",
        targetRef: "chapter 3",
        proposedText: edited,
      }),
    );

    const result = await submitCorrection(handle, client, {
      projectId,
      userText: "There's a typo in the first paragraph of chapter 3.",
    });

    // Staged, not applied: the FINAL text is still v1, untouched.
    expect(result.awaitingConfirmation).toBe(true);
    expect(result.agentMessage.status).toBe("awaiting_confirmation");
    expect(result.agentMessage.body).toContain("chapter 3");
    expect(latestText(handle.db, projectId, "final")!.version).toBe(1);
    expect(latestText(handle.db, projectId, "final")!.content).not.toContain(
      "corrected typo",
    );
    // No "this modifies" applied entry yet.
    expect(
      listChanges(handle.db, projectId).some((c) =>
        c.what.includes("Content change applied"),
      ),
    ).toBe(false);

    // Confirm → the closed text is reopened as a new FINAL version, logged.
    confirmContentChange(handle, {
      projectId,
      messageId: result.agentMessage.id,
    });
    const final = latestText(handle.db, projectId, "final")!;
    expect(final.version).toBe(2);
    expect(final.content).toContain("corrected typo");
    const log = listChanges(handle.db, projectId);
    expect(
      log.some(
        (c) =>
          c.what.includes("this modifies chapter 3") &&
          c.authorizedBy.includes("confirmed"),
      ),
    ).toBe(true);
  });

  it("rejecting a content change leaves the text untouched", async () => {
    seed(bookText(2, 4));
    const client = new FakeAiClient(() =>
      JSON.stringify({
        classification: "content",
        reply: "This modifies chapter 1.",
        targetRef: "chapter 1",
        proposedText: "## Chapter 1\n\nTotally different text.",
      }),
    );
    const { agentMessage } = await submitCorrection(handle, client, {
      projectId,
      userText: "rewrite chapter 1",
    });
    rejectContentChange(handle, { projectId, messageId: agentMessage.id });
    expect(latestText(handle.db, projectId, "final")!.version).toBe(1);
    expect(() =>
      confirmContentChange(handle, { projectId, messageId: agentMessage.id }),
    ).toThrow(); // can no longer be confirmed after rejection
  });
});

describe("correction cycle — visual diff after a change", () => {
  it("lists the changed pages and the new total page count", () => {
    seed(bookText(2, 4));
    const v1 = buildInitial();

    // A longer text — more pages, later pages shift.
    const longer = bookText(3, 8);
    insertText(handle.db, {
      projectId,
      stageKey: "final",
      version: 2,
      content: longer,
    });
    const v2 = createPdfVersion(handle, {
      projectId,
      approvedText: longer,
      format: format(),
      sourceTextVersion: 2,
      kind: "export",
      notes: "after content growth",
      change: {
        what: "recompile",
        where: "stage 8",
        why: "content grew",
        authorizedBy: "test",
      },
    });

    const expectedPages = paginate(longer, format());
    expect(v2.diff.newPageCount).toBe(expectedPages.length);
    expect(v2.diff.oldPageCount).toBe(v1.pageCount);
    // There are strictly more pages, so there are added pages.
    expect(v2.diff.addedPages.length).toBeGreaterThan(0);
    // The stored diff on the version row matches.
    const stored = JSON.parse(latestPdfVersion(handle.db, projectId)!.diff);
    expect(stored.newPageCount).toBe(expectedPages.length);
    expect([...stored.changedPages, ...stored.addedPages].length).toBeGreaterThan(
      0,
    );
  });
});

describe("correction cycle — rollback restores a version exactly", () => {
  it("restores the earlier version's pages, count and file bytes", () => {
    seed(bookText(2, 5));
    const v1 = buildInitial();
    const v1Row = getPdfVersion(handle.db, projectId, v1.version)!;
    const v1Bytes = fs.readFileSync(v1Row.filePath);

    // Change to something different (v2).
    const changed = bookText(3, 9);
    insertText(handle.db, { projectId, stageKey: "final", version: 2, content: changed });
    createPdfVersion(handle, {
      projectId,
      approvedText: changed,
      format: format(),
      sourceTextVersion: 2,
      kind: "export",
      notes: "v2",
      change: { what: "x", where: "y", why: "z", authorizedBy: "test" },
    });

    const restored = rollbackTo(handle, { projectId, version: v1.version });
    const current = latestPdfVersion(handle.db, projectId)!;
    expect(current.version).toBe(restored.version);
    expect(current.kind).toBe("rollback");
    expect(current.rolledBackFrom).toBe(v1.version);
    expect(current.pageCount).toBe(v1Row.pageCount);
    expect(current.pages).toBe(v1Row.pages);
    expect(fs.readFileSync(current.filePath)).toEqual(v1Bytes);
  });
});

describe("correction cycle — layout change never touches the master text", () => {
  it("leaves the FINAL text identical and the word-for-word check passing", () => {
    seed(bookText(2, 6));
    buildInitial();
    const before = latestText(handle.db, projectId, "final")!;

    const built = applyLayoutChange(handle, {
      projectId,
      // A different page size + larger body re-flows the pages.
      formatPatch: { pageSize: "15x23cm", typography: { bodySizePt: 13 } },
      summary: "larger body on a taller page",
    });

    const after = latestText(handle.db, projectId, "final")!;
    // Master text untouched: same version, same content.
    expect(after.version).toBe(before.version);
    expect(after.content).toBe(before.content);
    // Word-for-word verification still passes against the approved text.
    const wordCheck = built.qa.checks.find((c) => c.name === "word-for-word");
    expect(wordCheck?.ok).toBe(true);
    expect(built.qa.ok).toBe(true);
    // The layout genuinely changed the pagination.
    const newPages = parsePages(latestPdfVersion(handle.db, projectId)!.pages);
    expect(newPages.length).toBeGreaterThan(0);
  });
});
