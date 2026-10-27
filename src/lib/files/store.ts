import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../db/client";

// On-disk layout for file-backed sources:
//
//   data/sources/{projectId}/{sourceId}/original/{filename}   — immutable
//   data/sources/{projectId}/{sourceId}/derived/{name}        — all outputs
//
// The original is written once (temp file + atomic rename), then chmod'd
// read-only. Nothing in the codebase opens a path under original/ for
// writing; every transformation goes through writeDerived(). Paths stored in
// the DB are relative to dataDir() so the data directory stays relocatable.

export function sha1(buffer: Buffer): string {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

export function sourceDirAbs(projectId: string, sourceId: string): string {
  return path.join(dataDir(), "sources", projectId, sourceId);
}

/** Keep the original filename recognizable but safe as a single path segment. */
export function safeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\p{L}\p{N}._ -]+/gu, "_").trim();
  return base.length > 0 ? base.slice(0, 120) : "file";
}

export interface StoredOriginal {
  /** Relative to dataDir(), as stored in sources.original_path. */
  relativePath: string;
  absolutePath: string;
  checksumSha1: string;
  sizeBytes: number;
}

/**
 * Store an uploaded file as the immutable original of a source. Written to a
 * temp name first and renamed into place, then made read-only.
 */
export function saveOriginal(
  projectId: string,
  sourceId: string,
  filename: string,
  buffer: Buffer,
): StoredOriginal {
  const dir = path.join(sourceDirAbs(projectId, sourceId), "original");
  fs.mkdirSync(dir, { recursive: true });
  const finalName = safeFilename(filename);
  const finalPath = path.join(dir, finalName);
  const tempPath = path.join(dir, `.${finalName}.tmp`);
  fs.writeFileSync(tempPath, buffer, { mode: 0o644 });
  fs.renameSync(tempPath, finalPath);
  fs.chmodSync(finalPath, 0o444);
  return {
    relativePath: path.relative(dataDir(), finalPath),
    absolutePath: finalPath,
    checksumSha1: sha1(buffer),
    sizeBytes: buffer.length,
  };
}

/**
 * The single write path for anything produced FROM a source: extracted text,
 * extracted audio, future transforms. Always lands under derived/, never
 * under original/.
 */
export function writeDerived(
  projectId: string,
  sourceId: string,
  name: string,
  data: Buffer | string,
): string {
  const dir = path.join(sourceDirAbs(projectId, sourceId), "derived");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, safeFilename(name));
  fs.writeFileSync(filePath, data);
  return path.relative(dataDir(), filePath);
}

export function readOriginal(relativePath: string): Buffer {
  return fs.readFileSync(path.join(dataDir(), relativePath));
}

// Book images (spec §4 Stage 6.4) live under their own tree, separate from the
// source inventory: they are book material (placed, credited, rendered), not
// an input to the text pipeline.
//
//   data/images/{projectId}/{imageId}/{filename}
//
// Stored immutably (temp file + atomic rename, then read-only) exactly like a
// source original, so the bytes the dpi check and the renderer read are the
// bytes that were reviewed.

export function imageDirAbs(projectId: string, imageId: string): string {
  return path.join(dataDir(), "images", projectId, imageId);
}

export function saveImageFile(
  projectId: string,
  imageId: string,
  filename: string,
  buffer: Buffer,
): StoredOriginal {
  const dir = imageDirAbs(projectId, imageId);
  fs.mkdirSync(dir, { recursive: true });
  const finalName = safeFilename(filename);
  const finalPath = path.join(dir, finalName);
  const tempPath = path.join(dir, `.${finalName}.tmp`);
  fs.writeFileSync(tempPath, buffer, { mode: 0o644 });
  fs.renameSync(tempPath, finalPath);
  fs.chmodSync(finalPath, 0o444);
  return {
    relativePath: path.relative(dataDir(), finalPath),
    absolutePath: finalPath,
    checksumSha1: sha1(buffer),
    sizeBytes: buffer.length,
  };
}

export function readImageFile(relativePath: string): Buffer {
  return fs.readFileSync(path.join(dataDir(), relativePath));
}

/** Absolute path for a stored image — graphicx needs an absolute path. */
export function imageAbsolutePath(relativePath: string): string {
  return path.join(dataDir(), relativePath);
}

/** Delete one image's whole file tree (used on removal). */
export function removeImageFiles(projectId: string, imageId: string): void {
  const dir = imageDirAbs(projectId, imageId);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const p = path.join(dir, entry);
    try {
      if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o644);
    } catch {
      // already gone — nothing to restore
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Recompute the original's SHA-1 and compare it to the stored checksum. */
export function verifyChecksum(
  relativePath: string,
  storedSha1: string,
): { ok: boolean; actual: string } {
  const actual = sha1(readOriginal(relativePath));
  return { ok: actual === storedSha1, actual };
}

/** Delete a source's whole file tree (used on ingest failure and removal). */
export function removeSourceFiles(projectId: string, sourceId: string): void {
  const dir = sourceDirAbs(projectId, sourceId);
  // Originals are read-only; restore write permission so rm can delete them.
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { recursive: true }) as string[]) {
      const p = path.join(dir, entry);
      try {
        if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o644);
      } catch {
        // already gone — nothing to restore
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
