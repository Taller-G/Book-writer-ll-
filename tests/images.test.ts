import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { canCompleteStage } from "@/lib/gates";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { saveImageFile } from "@/lib/files/store";
import { parseFormatData, PROVEN_DEFAULTS } from "@/lib/format/config";
import { imageDpiWarnings } from "@/lib/images/dpi";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { setAiFactoryForTests } from "@/lib/jobs/executors";
import { getFormatConfig } from "@/lib/repo/output";
import {
  addImage,
  getImage,
  getImageCreditsSection,
  listPlacedImages,
  listReviewImages,
  placeImage,
  regenerateImageCredits,
  reorderImages,
  setImageCreditsStatus,
} from "@/lib/repo/images";
import { createProject } from "@/lib/repo/projects";
import { insertText } from "@/lib/repo/texts";
import { composeBook } from "@/lib/render/compose";
import { FakeAiClient, fakePng } from "./helpers/fakeAi";

// Acceptance tests for the Stage 6.4 work order (images inside the book):
// upload / AI generation, early review, placement + dpi, drag-reorder, and
// automatic credits by origin.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-images-"));
process.env.BOOK_WRITER_DATA_DIR = dataDir;

afterAll(() => {
  delete process.env.BOOK_WRITER_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});
afterEach(() => setAiFactoryForTests());

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Con imágenes", author: "A. Autora" }).id;
});

const FORMAT_DATA = PROVEN_DEFAULTS; // A5, proven margins

function seedPlaced(input: {
  widthPx: number;
  heightPx: number;
  sizeOption?: "column" | "half" | "full";
  filePath?: string;
  anchorText?: string;
}): string {
  const img = addImage(handle.db, {
    projectId,
    origin: "own",
    filePath: input.filePath ?? `images/${projectId}/x/img.png`,
    originalName: "img.png",
    mimeType: "image/png",
    sizeBytes: 100,
    checksumSha1: "deadbeef",
    widthPx: input.widthPx,
    heightPx: input.heightPx,
  });
  placeImage(handle.db, img.id, {
    anchorText: input.anchorText ?? "",
    sizeOption: input.sizeOption ?? "column",
  });
  return img.id;
}

describe("dpi preflight (before any render)", () => {
  it("a low-resolution image placed at full-page size triggers a dpi warning", () => {
    seedPlaced({ widthPx: 500, heightPx: 700, sizeOption: "full" });
    const warnings = imageDpiWarnings(
      listPlacedImages(handle.db, projectId).map((i) => ({
        id: i.id,
        widthPx: i.widthPx,
        heightPx: i.heightPx,
        sizeOption: i.sizeOption,
        caption: i.caption,
        originalName: i.originalName,
      })),
      FORMAT_DATA,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].dpi).toBeLessThan(300);
    expect(warnings[0].message).toMatch(/below the 300 dpi/i);
  });

  it("a high-resolution image at full-page size is within the dpi floor", () => {
    seedPlaced({ widthPx: 3000, heightPx: 4200, sizeOption: "full" });
    const warnings = imageDpiWarnings(
      listPlacedImages(handle.db, projectId).map((i) => ({
        id: i.id,
        widthPx: i.widthPx,
        heightPx: i.heightPx,
        sizeOption: i.sizeOption,
      })),
      FORMAT_DATA,
    );
    expect(warnings).toHaveLength(0);
  });
});

describe("narrative order (drag reorder)", () => {
  it("reordering persists and is reflected in the order images compose into the next render", () => {
    const a = seedPlaced({ widthPx: 1000, heightPx: 1000, filePath: "p/a.png" });
    const b = seedPlaced({ widthPx: 1000, heightPx: 1000, filePath: "p/b.png" });

    // Drag b before a.
    reorderImages(handle.db, projectId, [b, a]);

    const placed = listPlacedImages(handle.db, projectId);
    expect(placed.map((i) => i.id)).toEqual([b, a]);

    const format = getFormatConfig(handle.db, projectId);
    const { tex } = composeBook(
      "## Capítulo\n\nUn párrafo cualquiera para anclar el libro.",
      format,
      { title: "T", author: "A" },
      placed.map((i) => ({
        path: i.filePath,
        sizeOption: i.sizeOption,
        anchorText: i.anchorText,
        order: i.narrativeOrder,
      })),
    );
    const idxB = tex.indexOf("p/b.png");
    const idxA = tex.indexOf("p/a.png");
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeLessThan(idxA); // b now renders before a
  });
});

describe("AI generation", () => {
  it("a generated image lands in the review grid and receives an AI-origin credit line", async () => {
    setAiFactoryForTests(
      () => new FakeAiClient(() => "", () => fakePng(1200, 900)),
    );
    insertText(handle.db, {
      projectId,
      stageKey: "final",
      version: 1,
      content: "## Capítulo\n\nTexto del libro.",
    });

    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 7,
      type: "generate_image",
      params: { prompt: "un faro al amanecer" },
    });
    expect(job.status).toBe("succeeded");

    // Appears in the review grid before being placed (not in placed).
    const review = listReviewImages(handle.db, projectId);
    expect(review).toHaveLength(1);
    expect(listPlacedImages(handle.db, projectId)).toHaveLength(0);

    const img = getImage(handle.db, review[0].id)!;
    expect(img.origin).toBe("ai");
    expect(img.status).toBe("review");
    expect(img.widthPx).toBe(1200);
    expect(img.aiPrompt).toBe("un faro al amanecer");

    // The credits section carries the AI-origin line automatically.
    const credits = getImageCreditsSection(handle.db, projectId)!;
    expect(credits.content).toMatch(/inteligencia artificial/i);
  });
});

describe("credits are mandatory when the book has images", () => {
  it("a book with images but a discarded credits section is flagged before export", () => {
    insertText(handle.db, {
      projectId,
      stageKey: "final",
      version: 1,
      content: "## Capítulo\n\nTexto del libro.",
    });
    seedPlaced({ widthPx: 2000, heightPx: 2000 });
    regenerateImageCredits(handle.db, projectId, "A. Autora");

    // Discard the credits — export must be blocked.
    setImageCreditsStatus(handle.db, projectId, "discarded");
    const blocked = canCompleteStage(handle.db, projectId, 8);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/credits/i);

    // The export job itself refuses to run.
    return enqueueAndRun(handle, { projectId, stage: 8, type: "export_book" }).then(
      (job) => {
        expect(job.status).toBe("failed");
        expect(job.error).toMatch(/credits/i);
      },
    );
  });

  it("accepting the credits section clears the export block", () => {
    insertText(handle.db, {
      projectId,
      stageKey: "final",
      version: 1,
      content: "## Capítulo\n\nTexto del libro.",
    });
    seedPlaced({ widthPx: 2000, heightPx: 2000 });
    regenerateImageCredits(handle.db, projectId, "A. Autora");
    setImageCreditsStatus(handle.db, projectId, "accepted");
    // Still needs an export to exist, but the credits block is cleared.
    const gate = canCompleteStage(handle.db, projectId, 8);
    expect(gate.reason ?? "").not.toMatch(/credits/i);
  });
});

describe("render integration with a placed image", () => {
  it("renders a book with a placed image and its accepted credits, recording dpi warnings", async () => {
    insertText(handle.db, {
      projectId,
      stageKey: "final",
      version: 1,
      content:
        "## Capítulo\n\nUn párrafo del libro que sirve de ancla para la imagen.\n\n" +
        "Otro párrafo para dar cuerpo a la página.",
    });
    // A deliberately small image placed full-page — dpi must fall short.
    const imageId = "img-render-1";
    const stored = saveImageFile(projectId, imageId, "small.png", fakePng(400, 560));
    const img = addImage(handle.db, {
      id: imageId,
      projectId,
      origin: "own",
      filePath: stored.relativePath,
      originalName: "small.png",
      mimeType: "image/png",
      sizeBytes: stored.sizeBytes,
      checksumSha1: stored.checksumSha1,
      widthPx: 400,
      heightPx: 560,
    });
    placeImage(handle.db, img.id, { anchorText: "ancla para la imagen", sizeOption: "full" });
    regenerateImageCredits(handle.db, projectId, "A. Autora");
    setImageCreditsStatus(handle.db, projectId, "accepted");

    const job = await enqueueAndRun(handle, { projectId, stage: 7, type: "render_pdf" });
    expect(job.status).toBe("succeeded");
    const output = JSON.parse(job.output!);
    expect(output.placedImages).toBe(1);
    expect(output.dpiWarnings.length).toBeGreaterThan(0);
    // The PDF exists and the format data parsed (sanity on the plumbing).
    expect(fs.existsSync(output.filePath)).toBe(true);
    expect(parseFormatData(getFormatConfig(handle.db, projectId).data).pageSize).toBe("A5");
  });
});
