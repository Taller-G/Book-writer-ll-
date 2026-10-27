import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { sources, type Source } from "../db/schema";
import { newId, now } from "../util";

export function addSource(
  db: Db,
  input: {
    projectId: string;
    kind: Source["kind"];
    title: string;
    content: string;
  },
): Source {
  const id = newId();
  db.insert(sources)
    .values({ ...input, id, createdAt: now() })
    .run();
  return db.select().from(sources).where(eq(sources.id, id)).get()!;
}

/** Insert a file-backed source row. The files must already be on disk. */
export function addFileSource(
  db: Db,
  input: {
    id: string;
    projectId: string;
    kind: Source["kind"];
    title: string;
    content: string;
    metadata?: string;
    mediaType: NonNullable<Source["mediaType"]>;
    originalName: string;
    originalPath: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha1: string;
    durationSeconds: number | null;
    language: string | null;
    wordCount: number | null;
  },
): Source {
  db.insert(sources)
    .values({ ...input, createdAt: now() })
    .run();
  return db.select().from(sources).where(eq(sources.id, input.id)).get()!;
}

export function getSource(db: Db, id: string): Source | undefined {
  return db.select().from(sources).where(eq(sources.id, id)).get();
}

export function listSources(db: Db, projectId: string): Source[] {
  return db
    .select()
    .from(sources)
    .where(eq(sources.projectId, projectId))
    .orderBy(desc(sources.createdAt))
    .all();
}

export function removeSource(db: Db, id: string): void {
  // Clear any link pointing at the removed source first.
  db.update(sources)
    .set({ linkedSourceId: null })
    .where(eq(sources.linkedSourceId, id))
    .run();
  db.delete(sources).where(eq(sources.id, id)).run();
}

export function findByChecksum(
  db: Db,
  projectId: string,
  checksumSha1: string,
): Source | undefined {
  return db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.projectId, projectId),
        eq(sources.checksumSha1, checksumSha1),
      ),
    )
    .get();
}

/** Filenames "Talk One.m4a" and "talk_one.docx" share the stem "talk one". */
export function normalizeStem(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Find the unlinked counterpart of a source for audio↔transcript linking:
 * same project, same filename stem, opposite side (media vs text).
 */
export function findLinkCandidate(db: Db, source: Source): Source | undefined {
  if (!source.originalName || !source.mediaType) return undefined;
  const stem = normalizeStem(source.originalName);
  const wantMedia = source.mediaType === "document" || source.mediaType === "text";
  return db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.projectId, source.projectId),
        isNull(sources.linkedSourceId),
        ne(sources.id, source.id),
      ),
    )
    .all()
    .find((s) => {
      if (!s.originalName || !s.mediaType) return false;
      const isMedia = s.mediaType === "audio" || s.mediaType === "video";
      const isText = s.mediaType === "document" || s.mediaType === "text";
      if (wantMedia ? !isMedia : !isText) return false;
      return normalizeStem(s.originalName) === stem;
    });
}

/**
 * Link an audio/video source with its transcript, both ways. The text side's
 * kind becomes 'transcript' so downstream stages treat it as such.
 */
export function linkSources(db: Db, mediaId: string, textId: string): void {
  db.update(sources)
    .set({ linkedSourceId: textId })
    .where(eq(sources.id, mediaId))
    .run();
  db.update(sources)
    .set({ linkedSourceId: mediaId, kind: "transcript" })
    .where(eq(sources.id, textId))
    .run();
}

export function unlinkSources(db: Db, id: string): void {
  const source = getSource(db, id);
  if (!source) return;
  if (source.linkedSourceId) {
    db.update(sources)
      .set({ linkedSourceId: null })
      .where(eq(sources.id, source.linkedSourceId))
      .run();
  }
  db.update(sources).set({ linkedSourceId: null }).where(eq(sources.id, id)).run();
}

/**
 * Store an ASR transcription on an audio/video source: the transcript becomes
 * the source's content (so the existing ingest compile picks it up), and the
 * word-level timestamps + model land in the metadata JSON for later clip
 * resolution. Word count and detected language are stamped too.
 */
export function saveTranscription(
  db: Db,
  id: string,
  result: {
    content: string;
    wordCount: number;
    language: string | null;
    words: unknown;
    model: string;
    provider: string;
    transcribedAt: string;
  },
): void {
  mergeSourceMetadata(db, id, {
    transcription: {
      model: result.model,
      provider: result.provider,
      transcribedAt: result.transcribedAt,
      words: result.words,
    },
  });
  db.update(sources)
    .set({
      content: result.content,
      wordCount: result.wordCount,
      language: result.language,
    })
    .where(eq(sources.id, id))
    .run();
}

/** Merge keys into the source's metadata JSON (e.g. checksum verifications). */
export function mergeSourceMetadata(
  db: Db,
  id: string,
  patch: Record<string, unknown>,
): void {
  const source = getSource(db, id);
  if (!source) return;
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(source.metadata);
  } catch {
    // unreadable metadata — start fresh rather than fail the merge
  }
  db.update(sources)
    .set({ metadata: JSON.stringify({ ...current, ...patch }) })
    .where(eq(sources.id, id))
    .run();
}
