// Type detection and literal content extraction for uploaded sources.
// Extraction is deliberately uninterpretive: docx/pdf text comes out exactly
// as the parser reads it — no cleanup, no reformatting. That belongs to the
// later pipeline passes, which work on derived copies.

export class UnsupportedFileError extends Error {}
export class CorruptFileError extends Error {}

export type MediaType = "audio" | "video" | "document" | "image" | "text";

export interface DetectedType {
  mediaType: MediaType;
  /** Normalized lowercase extension, e.g. "docx". */
  format: string;
  mimeType: string;
}

const SUPPORTED: Record<string, { mediaType: MediaType; mimeType: string }> = {
  mp3: { mediaType: "audio", mimeType: "audio/mpeg" },
  m4a: { mediaType: "audio", mimeType: "audio/mp4" },
  wav: { mediaType: "audio", mimeType: "audio/wav" },
  mp4: { mediaType: "video", mimeType: "video/mp4" },
  mov: { mediaType: "video", mimeType: "video/quicktime" },
  webm: { mediaType: "video", mimeType: "video/webm" },
  docx: {
    mediaType: "document",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  pdf: { mediaType: "document", mimeType: "application/pdf" },
  txt: { mediaType: "text", mimeType: "text/plain" },
  md: { mediaType: "text", mimeType: "text/markdown" },
  png: { mediaType: "image", mimeType: "image/png" },
  jpg: { mediaType: "image", mimeType: "image/jpeg" },
  jpeg: { mediaType: "image", mimeType: "image/jpeg" },
};

export const SUPPORTED_EXTENSIONS = Object.keys(SUPPORTED);

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buffer[offset + i] === b);
}

function looksLikeUtf8Text(buffer: Buffer): boolean {
  try {
    const sample = buffer.subarray(0, 64 * 1024);
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return !sample.includes(0);
  } catch {
    return false;
  }
}

/** Magic-byte signature check per format; the cheap corruption gate. */
function matchesSignature(format: string, buffer: Buffer): boolean {
  switch (format) {
    case "docx":
      return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]); // zip local header
    case "pdf":
      return startsWith(buffer, [0x25, 0x50, 0x44, 0x46]); // %PDF
    case "png":
      return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47]);
    case "jpg":
    case "jpeg":
      return startsWith(buffer, [0xff, 0xd8, 0xff]);
    case "wav":
      return (
        startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && // RIFF
        startsWith(buffer, [0x57, 0x41, 0x56, 0x45], 8) // WAVE
      );
    case "mp3":
      return (
        startsWith(buffer, [0x49, 0x44, 0x33]) || // ID3
        (buffer.length > 1 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
      );
    case "m4a":
    case "mp4":
    case "mov":
      return startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4); // ....ftyp
    case "webm":
      return startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3]); // EBML
    case "txt":
    case "md":
      return looksLikeUtf8Text(buffer);
    default:
      return false;
  }
}

/**
 * Decide what an upload is, by extension plus magic bytes. Throws
 * UnsupportedFileError for unknown extensions and CorruptFileError when the
 * content does not match what the extension promises.
 */
export function detectType(filename: string, buffer: Buffer): DetectedType {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const entry = SUPPORTED[ext];
  if (!entry) {
    throw new UnsupportedFileError(
      `"${filename}": .${ext || "?"} files are not supported. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
    );
  }
  if (buffer.length === 0) {
    throw new CorruptFileError(`"${filename}" is empty.`);
  }
  if (!matchesSignature(ext, buffer)) {
    throw new CorruptFileError(
      `"${filename}" does not look like a valid ${ext} file — it may be corrupt or misnamed.`,
    );
  }
  return { mediaType: entry.mediaType, format: ext, mimeType: entry.mimeType };
}

/** Literal text extraction; returns null for formats with no text (audio, images). */
export async function extractText(
  det: DetectedType,
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  try {
    switch (det.format) {
      case "docx": {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
      }
      case "pdf": {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try {
          const result = await parser.getText();
          // Join page texts ourselves: result.text inserts "-- n of m --"
          // separators, which are not literal document content.
          return result.pages.map((p) => p.text).join("\n\n");
        } finally {
          await parser.destroy();
        }
      }
      case "txt":
      case "md":
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      default:
        return null;
    }
  } catch (e) {
    throw new CorruptFileError(
      `Could not read text from "${filename}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Duration in seconds for audio/video, via container metadata. */
export async function detectDuration(
  det: DetectedType,
  buffer: Buffer,
  filename: string,
): Promise<number | null> {
  if (det.mediaType !== "audio" && det.mediaType !== "video") return null;
  try {
    const { parseBuffer } = await import("music-metadata");
    const meta = await parseBuffer(new Uint8Array(buffer), {
      mimeType: det.mimeType,
    });
    return meta.format.duration ?? null;
  } catch (e) {
    throw new CorruptFileError(
      `Could not read media metadata from "${filename}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

// Tiny deterministic language guess over stopword hits — enough for the
// inventory card. The corpus for this product is Spanish/English.
const STOPWORDS: Record<string, string[]> = {
  es: ["el", "la", "los", "las", "de", "que", "y", "en", "un", "una", "es", "por", "con", "para", "del", "se", "no", "su", "al", "como"],
  en: ["the", "of", "and", "to", "in", "a", "is", "that", "it", "for", "was", "on", "are", "as", "with", "his", "they", "at", "be", "this"],
};

export function detectLanguage(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2000);
  if (words.length < 10) return null;
  const scores = Object.entries(STOPWORDS).map(([lang, stops]) => {
    const set = new Set(stops);
    const hits = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    return { lang, hits };
  });
  scores.sort((a, b) => b.hits - a.hits);
  const [best, second] = scores;
  if (best.hits === 0 || best.hits === second.hits) return null;
  return best.lang;
}
