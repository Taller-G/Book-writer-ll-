import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DbHandle } from "../db/client";
import { dataDir } from "../db/client";
import type { Source } from "../db/schema";
import {
  removeSourceFiles,
  saveOriginal,
  sha1,
  writeDerived,
} from "../files/store";
import { appendChange } from "../repo/changeLog";
import {
  addFileSource,
  findByChecksum,
  findLinkCandidate,
  getSource,
  linkSources,
} from "../repo/sources";
import { newId } from "../util";
import {
  CorruptFileError,
  countWords,
  detectDuration,
  detectLanguage,
  detectType,
  extractText,
  UnsupportedFileError,
  type MediaType,
} from "./extract";

export type IngestResult =
  | { ok: true; source: Source; note?: string }
  | { ok: false; filename: string; error: string };

/** Map a media type onto the fixed sources.kind enum. */
function kindFor(mediaType: MediaType): Source["kind"] {
  switch (mediaType) {
    case "audio":
    case "video":
      return "audio";
    default:
      return "document";
  }
}

function titleFromFilename(filename: string): string {
  const stem = path.basename(filename).replace(/\.[^.]+$/, "");
  return stem.replace(/[_-]+/g, " ").trim() || filename;
}

function ffmpegAvailable(): boolean {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

/**
 * Extract the audio track of a video into derived/ using system ffmpeg.
 * Returns the derived relative path, or null when ffmpeg is not installed.
 * Reads the original; writes only under derived/.
 */
function extractVideoAudio(
  projectId: string,
  sourceId: string,
  originalAbs: string,
): string | null {
  if (!ffmpegAvailable()) return null;
  const derivedDir = path.join(
    path.dirname(path.dirname(originalAbs)),
    "derived",
  );
  fs.mkdirSync(derivedDir, { recursive: true });
  const outPath = path.join(derivedDir, "audio.m4a");
  try {
    // Try a lossless stream copy first; fall back to AAC re-encode.
    execFileSync(
      "ffmpeg",
      ["-y", "-i", originalAbs, "-vn", "-acodec", "copy", outPath],
      { stdio: "ignore" },
    );
  } catch {
    execFileSync(
      "ffmpeg",
      ["-y", "-i", originalAbs, "-vn", "-c:a", "aac", outPath],
      { stdio: "ignore" },
    );
  }
  return path.relative(dataDir(), outPath);
}

/**
 * Ingest one uploaded file into a project:
 *
 *   validate → checksum → store immutable original → extract to derived
 *   copies → insert the source row + auto-link, atomically.
 *
 * Any failure rolls back completely: the source's file tree is deleted and
 * no database row exists, so a rejected upload leaves no partial state.
 */
export async function ingestFile(
  handle: DbHandle,
  projectId: string,
  filename: string,
  buffer: Buffer,
): Promise<IngestResult> {
  const { db, sqlite } = handle;
  const sourceId = newId();
  try {
    const det = detectType(filename, buffer);
    const checksum = sha1(buffer);
    const duplicate = findByChecksum(db, projectId, checksum);
    if (duplicate) {
      return {
        ok: false,
        filename,
        error: `"${filename}" has the same content as the existing source "${duplicate.title}" — not added again.`,
      };
    }

    const stored = saveOriginal(projectId, sourceId, filename, buffer);

    // Everything computed FROM the original goes to derived copies.
    const text = await extractText(det, buffer, filename);
    const durationSeconds = await detectDuration(det, buffer, filename);
    if (text !== null) {
      writeDerived(projectId, sourceId, "extracted.txt", text);
    }
    let note: string | undefined;
    if (det.mediaType === "video") {
      const audioPath = extractVideoAudio(
        projectId,
        sourceId,
        stored.absolutePath,
      );
      if (audioPath === null) {
        note =
          "Audio track not extracted: ffmpeg is not installed. The video was stored intact; install ffmpeg and re-upload to extract its audio.";
      }
    }

    const wordCount = text !== null ? countWords(text) : null;
    const language = text !== null ? detectLanguage(text) : null;

    sqlite.transaction(() => {
      const inserted = addFileSource(db, {
        id: sourceId,
        projectId,
        kind: kindFor(det.mediaType),
        title: titleFromFilename(filename),
        content: text ?? "",
        metadata: note ? JSON.stringify({ note }) : "{}",
        mediaType: det.mediaType,
        originalName: path.basename(filename),
        originalPath: stored.relativePath,
        mimeType: det.mimeType,
        sizeBytes: stored.sizeBytes,
        checksumSha1: checksum,
        durationSeconds,
        language,
        wordCount,
      });
      const counterpart = findLinkCandidate(db, inserted);
      if (counterpart) {
        const mediaSide =
          inserted.mediaType === "audio" || inserted.mediaType === "video"
            ? inserted
            : counterpart;
        const textSide = mediaSide.id === inserted.id ? counterpart : inserted;
        linkSources(db, mediaSide.id, textSide.id);
        appendChange(db, {
          projectId,
          what: `Linked audio "${mediaSide.title}" with transcript "${textSide.title}" (matching filenames)`,
          where: "stage 1 · sources",
          why: "same material in two forms; enables clip resolution later",
          authorizedBy: "source ingestion",
        });
      }
      appendChange(db, {
        projectId,
        what: `Ingested ${det.mediaType} source "${inserted.title}" (${path.basename(filename)}, sha1 ${checksum.slice(0, 10)}…)`,
        where: "stage 1 · sources",
        why: "original stored immutably with checksum; content extracted to a derived copy",
        authorizedBy: "source ingestion",
      });
    })();

    // Re-read: the transaction may have linked and re-kinded this row.
    const source = getSource(db, sourceId)!;
    return { ok: true, source, note };
  } catch (e) {
    removeSourceFiles(projectId, sourceId);
    const message =
      e instanceof UnsupportedFileError || e instanceof CorruptFileError
        ? e.message
        : `"${filename}" could not be ingested: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, filename, error: message };
  }
}
