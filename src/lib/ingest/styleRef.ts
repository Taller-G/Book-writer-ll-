import type { Db } from "../db/client";
import type { StyleRef } from "../db/schema";
import { addStyleRef } from "../repo/styleRefs";
import {
  CorruptFileError,
  countWords,
  detectType,
  extractText,
  UnsupportedFileError,
} from "./extract";

// Reference ingestion for the style profile (Stage 3). Narrower than source
// ingestion: only text-bearing formats are accepted, only the extracted text
// is kept, and ANY failure is a clear per-file error with nothing saved — an
// unreadable reference must never leave a silent partial profile behind.

const REF_FORMATS = new Set(["txt", "md", "pdf", "docx"]);

export type StyleRefResult =
  | { ok: true; ref: StyleRef }
  | { ok: false; error: string };

export async function addStyleReference(
  db: Db,
  projectId: string,
  filename: string,
  buffer: Buffer,
): Promise<StyleRefResult> {
  try {
    const det = detectType(filename, buffer);
    if (!REF_FORMATS.has(det.format)) {
      return {
        ok: false,
        error: `"${filename}": only txt, md, pdf and docx files can be style references.`,
      };
    }
    const text = await extractText(det, buffer, filename);
    if (!text || text.trim() === "") {
      return {
        ok: false,
        error: `"${filename}" contains no readable text, so no style can be extracted from it.`,
      };
    }
    const ref = addStyleRef(db, {
      projectId,
      name: filename,
      content: text,
      wordCount: countWords(text),
    });
    return { ok: true, ref };
  } catch (e) {
    if (e instanceof UnsupportedFileError || e instanceof CorruptFileError) {
      return { ok: false, error: e.message };
    }
    return {
      ok: false,
      error: `Could not read "${filename}": ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
