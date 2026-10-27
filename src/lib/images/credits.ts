// Automatic image credits by origin (spec §4 Stage 6.4, pain points #7 & #9).
// Every image carries where it came from — the author's own work, an AI model,
// or a third party — and that origin alone decides its credit line, so credits
// can never silently go missing or misstate provenance. A book that has images
// MUST carry a credits section; discarding it is flagged before export.
//
// Language: the books are produced in Spanish (see the apparatus catalog), so
// the credit lines and disclaimer are Spanish, matching the rest of the
// editorial apparatus.

export type ImageOrigin = "own" | "ai" | "third_party";

export interface CreditableImage {
  id: string;
  origin: ImageOrigin;
  caption?: string;
  altText?: string;
  sourceCredit?: string;
  licenseNote?: string;
  aiModel?: string;
  status?: "review" | "placed" | "discarded";
  narrativeOrder?: number;
}

/** The apparatus key and placement the image-credits section is stored under. */
export const IMAGE_CREDITS_KEY = "creditos-imagenes";
export const IMAGE_CREDITS_TITLE = "Créditos de las imágenes";
export const IMAGE_CREDITS_PLACEMENT = "back" as const;

/** Shown once in the section whenever any credited image was AI-generated. */
export const AI_DISCLAIMER =
  "Las imágenes señaladas como generadas con inteligencia artificial fueron " +
  "creadas con modelos generativos y no son fotografías de personas, lugares " +
  "o hechos reales.";

function imageName(image: CreditableImage, index: number): string {
  const caption = image.caption?.trim();
  return caption && caption.length > 0 ? caption : `Imagen ${index + 1}`;
}

/** The credit line for one image, decided solely by its origin. */
export function creditLine(
  image: CreditableImage,
  author: string,
  index: number,
): string {
  const name = imageName(image, index);
  switch (image.origin) {
    case "ai": {
      const model = image.aiModel?.trim();
      return (
        `${name}: imagen generada con inteligencia artificial` +
        (model ? ` (${model})` : "") +
        "."
      );
    }
    case "third_party": {
      const source = image.sourceCredit?.trim();
      const license = image.licenseNote?.trim();
      const attribution = source
        ? source
        : "atribución pendiente — completá la fuente de esta imagen de terceros";
      return `${name}: ${attribution}${license ? ` (${license})` : ""}.`;
    }
    case "own":
    default:
      return `${name}: imagen del autor${author.trim() ? ` ${author.trim()}` : ""}.`;
  }
}

/** Images that count toward credits: everything not discarded. */
export function creditedImages(images: CreditableImage[]): CreditableImage[] {
  return images
    .filter((i) => i.status !== "discarded")
    .slice()
    .sort((a, b) => (a.narrativeOrder ?? 0) - (b.narrativeOrder ?? 0));
}

/** True once the book has at least one non-discarded image. */
export function creditsMandatory(images: CreditableImage[]): boolean {
  return creditedImages(images).length > 0;
}

/**
 * The full credits-section body (markdown paragraphs): one credit line per
 * credited image in narrative order, plus the AI disclaimer when any image was
 * AI-generated. Returns "" when there are no credited images.
 */
export function buildCreditsSection(
  images: CreditableImage[],
  author: string,
): string {
  const credited = creditedImages(images);
  if (credited.length === 0) return "";
  const lines = credited.map((img, i) => creditLine(img, author, i));
  if (credited.some((i) => i.origin === "ai")) lines.push(AI_DISCLAIMER);
  return lines.join("\n\n");
}
