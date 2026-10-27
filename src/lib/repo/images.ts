import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  apparatusSections,
  bookImages,
  type ApparatusSection,
  type BookImage,
} from "../db/schema";
import {
  buildCreditsSection,
  creditsMandatory,
  IMAGE_CREDITS_KEY,
  IMAGE_CREDITS_PLACEMENT,
  IMAGE_CREDITS_TITLE,
} from "../images/credits";
import { newId, now } from "../util";
import { appendChange } from "./changeLog";

// Book images (spec §4 Stage 6.4). Every repo function takes an injectable
// `db` so tests run against an in-memory SQLite instance. Narrative order is a
// first-class column: new images append to the end, drag-reorder rewrites it,
// and the layout engine reads placed images in that order.

export interface AddImageInput {
  /** Caller-generated id so the file can be stored before the row is written. */
  id?: string;
  projectId: string;
  origin: BookImage["origin"];
  filePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha1: string;
  widthPx: number;
  heightPx: number;
  caption?: string;
  altText?: string;
  sourceCredit?: string;
  licenseNote?: string;
  aiModel?: string;
  aiPrompt?: string;
}

/** Next free narrative slot — new images land after everything existing. */
function nextOrder(db: Db, projectId: string): number {
  const rows = db
    .select({ order: bookImages.narrativeOrder })
    .from(bookImages)
    .where(eq(bookImages.projectId, projectId))
    .all();
  return rows.reduce((max, r) => Math.max(max, r.order), 0) + 1;
}

/** Insert an image (uploaded or AI-generated). Lands in the review grid. */
export function addImage(db: Db, input: AddImageInput): BookImage {
  const id = input.id ?? newId();
  const ts = now();
  db.insert(bookImages)
    .values({
      id,
      projectId: input.projectId,
      origin: input.origin,
      filePath: input.filePath,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      checksumSha1: input.checksumSha1,
      widthPx: input.widthPx,
      heightPx: input.heightPx,
      caption: input.caption ?? "",
      altText: input.altText ?? "",
      sourceCredit: input.sourceCredit ?? "",
      licenseNote: input.licenseNote ?? "",
      aiModel: input.aiModel ?? "",
      aiPrompt: input.aiPrompt ?? "",
      anchorText: "",
      sizeOption: "column",
      narrativeOrder: nextOrder(db, input.projectId),
      status: "review",
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return getImage(db, id)!;
}

export function getImage(db: Db, id: string): BookImage | undefined {
  return db.select().from(bookImages).where(eq(bookImages.id, id)).get();
}

/** All images in narrative order (then intake order as a stable tiebreak). */
export function listImages(db: Db, projectId: string): BookImage[] {
  return db
    .select()
    .from(bookImages)
    .where(eq(bookImages.projectId, projectId))
    .orderBy(asc(bookImages.narrativeOrder), asc(bookImages.createdAt))
    .all();
}

/** Images still awaiting review — the grid that catches artifacts early. */
export function listReviewImages(db: Db, projectId: string): BookImage[] {
  return listImages(db, projectId).filter((i) => i.status === "review");
}

/** Placed images, in narrative order — the layout engine's image input. */
export function listPlacedImages(db: Db, projectId: string): BookImage[] {
  return listImages(db, projectId).filter((i) => i.status === "placed");
}

/** True once the project has at least one non-discarded image. */
export function hasImages(db: Db, projectId: string): boolean {
  return listImages(db, projectId).some((i) => i.status !== "discarded");
}

function touchImage(db: Db, id: string, patch: Partial<BookImage>): void {
  db.update(bookImages)
    .set({ ...patch, updatedAt: now() })
    .where(eq(bookImages.id, id))
    .run();
}

/** Anchor an image to a passage at a printed size — moves it out of review. */
export function placeImage(
  db: Db,
  id: string,
  input: { anchorText: string; sizeOption: BookImage["sizeOption"] },
): void {
  touchImage(db, id, {
    anchorText: input.anchorText,
    sizeOption: input.sizeOption,
    status: "placed",
  });
}

export function setImageSize(
  db: Db,
  id: string,
  sizeOption: BookImage["sizeOption"],
): void {
  touchImage(db, id, { sizeOption });
}

/** Set the origin and its origin-specific credit inputs. */
export function setImageOrigin(
  db: Db,
  id: string,
  input: {
    origin: BookImage["origin"];
    sourceCredit?: string;
    licenseNote?: string;
  },
): void {
  touchImage(db, id, {
    origin: input.origin,
    ...(input.sourceCredit !== undefined ? { sourceCredit: input.sourceCredit } : {}),
    ...(input.licenseNote !== undefined ? { licenseNote: input.licenseNote } : {}),
  });
}

export function setImageCaption(
  db: Db,
  id: string,
  input: { caption?: string; altText?: string },
): void {
  touchImage(db, id, {
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
    ...(input.altText !== undefined ? { altText: input.altText } : {}),
  });
}

/** Mark an image as an artifact to leave out of the book. */
export function discardImage(db: Db, id: string): void {
  touchImage(db, id, { status: "discarded" });
}

export function removeImage(db: Db, id: string): void {
  db.delete(bookImages).where(eq(bookImages.id, id)).run();
}

/**
 * Persist a new narrative order from a drag-and-drop reorder. IDs are assigned
 * sequential positions; any image not named keeps its row but is pushed after
 * the listed ones so the order stays total.
 */
export function reorderImages(
  db: Db,
  projectId: string,
  orderedIds: string[],
): void {
  const owned = new Set(
    listImages(db, projectId).map((i) => i.id),
  );
  let position = 1;
  for (const id of orderedIds) {
    if (!owned.has(id)) continue;
    touchImage(db, id, { narrativeOrder: position });
    position++;
  }
  // Unlisted images (defensive) keep a stable order after the listed ones.
  for (const img of listImages(db, projectId)) {
    if (!orderedIds.includes(img.id)) {
      touchImage(db, img.id, { narrativeOrder: position });
      position++;
    }
  }
  appendChange(db, {
    projectId,
    what: `Reordered ${orderedIds.length} image(s) by narrative order`,
    where: "stage 7 · images",
    why: "user set the order images appear in the book by drag and drop",
    authorizedBy: "user",
  });
}

// --- Image-credits section ---------------------------------------------------
// Stored as an apparatus section (key creditos-imagenes, back matter) so it
// assembles into the book exactly like the other back matter. Its content is
// regenerated from the images' origins; its accept/discard status is the user's
// decision and is what the pre-export gate checks.

export function getImageCreditsSection(
  db: Db,
  projectId: string,
): ApparatusSection | undefined {
  return db
    .select()
    .from(apparatusSections)
    .where(
      and(
        eq(apparatusSections.projectId, projectId),
        eq(apparatusSections.sectionKey, IMAGE_CREDITS_KEY),
      ),
    )
    .get();
}

/**
 * Rebuild the credits content from the current images and upsert the section.
 * The accept/discard status is preserved on update (the user owns it); a new
 * section starts as 'proposed'. No-op when there is nothing to credit.
 */
export function regenerateImageCredits(
  db: Db,
  projectId: string,
  author: string,
): ApparatusSection | undefined {
  const images = listImages(db, projectId);
  if (!creditsMandatory(images)) return getImageCreditsSection(db, projectId);
  const content = buildCreditsSection(
    images.map((i) => ({
      id: i.id,
      origin: i.origin,
      caption: i.caption,
      altText: i.altText,
      sourceCredit: i.sourceCredit,
      licenseNote: i.licenseNote,
      aiModel: i.aiModel,
      status: i.status,
      narrativeOrder: i.narrativeOrder,
    })),
    author,
  );
  const existing = getImageCreditsSection(db, projectId);
  const ts = now();
  if (existing) {
    db.update(apparatusSections)
      .set({ content, title: IMAGE_CREDITS_TITLE, updatedAt: ts })
      .where(eq(apparatusSections.id, existing.id))
      .run();
    return getImageCreditsSection(db, projectId);
  }
  db.insert(apparatusSections)
    .values({
      id: newId(),
      projectId,
      sectionKey: IMAGE_CREDITS_KEY,
      title: IMAGE_CREDITS_TITLE,
      explanation:
        "Créditos de las imágenes del libro, generados automáticamente según " +
        "el origen de cada una (propia, IA o terceros). Es obligatorio cuando " +
        "el libro tiene imágenes.",
      content,
      placement: IMAGE_CREDITS_PLACEMENT,
      status: "proposed",
      // After the regular back matter (positions come from the §6 catalog).
      position: 100,
      jobId: null,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  appendChange(db, {
    projectId,
    what: "Image-credits section generated from image origins",
    where: "stage 7 · image credits",
    why: "a credits section is mandatory whenever the book has images",
    authorizedBy: "system",
  });
  return getImageCreditsSection(db, projectId);
}

export function setImageCreditsStatus(
  db: Db,
  projectId: string,
  status: "accepted" | "discarded",
  editedContent?: string,
): void {
  const section = getImageCreditsSection(db, projectId);
  if (!section) return;
  const edited =
    status === "accepted" &&
    editedContent !== undefined &&
    editedContent !== section.content;
  db.update(apparatusSections)
    .set({
      status,
      ...(edited ? { content: editedContent } : {}),
      updatedAt: now(),
    })
    .where(eq(apparatusSections.id, section.id))
    .run();
  appendChange(db, {
    projectId,
    what:
      status === "accepted"
        ? `Image-credits section accepted${edited ? " with edits" : ""}`
        : "Image-credits section discarded",
    where: "stage 7 · image credits",
    why:
      status === "accepted"
        ? "user approved the image credits for the book"
        : "user discarded the image credits",
    authorizedBy: "user",
  });
}

export interface CreditsGate {
  ok: boolean;
  reason?: string;
}

/**
 * The pre-export rule: a book with images MUST carry an accepted credits
 * section. Missing, still-proposed, or discarded credits all fail — the single
 * check shared by the Stage 8 gate and the export executor.
 */
export function imageCreditsGate(db: Db, projectId: string): CreditsGate {
  if (!hasImages(db, projectId)) return { ok: true };
  const section = getImageCreditsSection(db, projectId);
  if (!section) {
    return {
      ok: false,
      reason:
        "This book has images but no credits section. Generate and accept the " +
        "image credits before exporting.",
    };
  }
  if (section.status === "discarded") {
    return {
      ok: false,
      reason:
        "The image-credits section was discarded, but a credits section is " +
        "mandatory whenever the book has images. Restore and accept it before exporting.",
    };
  }
  if (section.status !== "accepted") {
    return {
      ok: false,
      reason: "Accept the image-credits section before exporting.",
    };
  }
  return { ok: true };
}

/** Content to render in the book: the credits section unless it was discarded. */
export function renderableImageCredits(
  db: Db,
  projectId: string,
): { title: string; content: string } | null {
  if (!hasImages(db, projectId)) return null;
  const section = getImageCreditsSection(db, projectId);
  if (!section || section.status === "discarded" || section.content.trim() === "") {
    return null;
  }
  return { title: section.title, content: section.content };
}
