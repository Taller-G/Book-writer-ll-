import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// The file store resolves everything against dataDir(); point it at a temp
// directory before importing anything that captures it.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-ingest-"));
process.env.BOOK_WRITER_DATA_DIR = tmpDataDir;

import { openDatabase, type DbHandle } from "@/lib/db/client";
import { sha1, verifyChecksum, writeDerived } from "@/lib/files/store";
import { ingestFile } from "@/lib/ingest/ingest";
import { createProject } from "@/lib/repo/projects";
import { listSources } from "@/lib/repo/sources";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");
const DOCX = fs.readFileSync(path.join(FIXTURES, "talk-one.docx"));
const DOCX_WORDS = 35; // the fixture's known word count
const WAV = fs.readFileSync(path.join(FIXTURES, "talk-one.wav"));
const PDF = fs.readFileSync(path.join(FIXTURES, "sample.pdf"));

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Ingest test" }).id;
});

afterAll(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("source ingestion (stage 1)", () => {
  it("stores a checksum that matches a later recomputation", async () => {
    const result = await ingestFile(handle, projectId, "talk-one.docx", DOCX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { source } = result;
    expect(source.checksumSha1).toBe(sha1(DOCX));
    // "At any later time": recompute from what is actually on disk.
    const verification = verifyChecksum(
      source.originalPath!,
      source.checksumSha1!,
    );
    expect(verification.ok).toBe(true);
    expect(verification.actual).toBe(source.checksumSha1);
  });

  it("never modifies the original: extraction and derived writes leave its bytes and permissions intact", async () => {
    const result = await ingestFile(handle, projectId, "talk-one.docx", DOCX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const originalAbs = path.join(tmpDataDir, result.source.originalPath!);

    // The original is read-only on disk.
    expect(fs.statSync(originalAbs).mode & 0o222).toBe(0);

    // Extraction already ran; a further transformation goes to derived/.
    const derivedRel = writeDerived(
      projectId,
      result.source.id,
      "uppercased.txt",
      result.source.content.toUpperCase(),
    );
    expect(derivedRel).toContain(`${path.sep}derived${path.sep}`);
    expect(derivedRel).not.toContain(`${path.sep}original${path.sep}`);

    // The original's bytes are untouched by everything above.
    expect(sha1(fs.readFileSync(originalAbs))).toBe(sha1(DOCX));

    // The extracted text exists as a derived copy, separate from the original.
    const extractedAbs = path.join(
      tmpDataDir,
      "sources",
      projectId,
      result.source.id,
      "derived",
      "extracted.txt",
    );
    expect(fs.existsSync(extractedAbs)).toBe(true);
  });

  it("extracts literal text from a docx and records its word count", async () => {
    const result = await ingestFile(handle, projectId, "talk-one.docx", DOCX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.wordCount).toBe(DOCX_WORDS);
    expect(result.source.content.trim().split(/\s+/)).toHaveLength(DOCX_WORDS);
    expect(result.source.language).toBe("es");
  });

  it("extracts literal text from a pdf", async () => {
    const result = await ingestFile(handle, projectId, "sample.pdf", PDF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.content).toContain("Hello literal extraction world");
    expect(result.source.wordCount).toBe(4);
  });

  it("links an audio file and a docx transcript of the same talk, both ways", async () => {
    const audio = await ingestFile(handle, projectId, "talk-one.wav", WAV);
    const doc = await ingestFile(handle, projectId, "Talk One.docx", DOCX);
    expect(audio.ok && doc.ok).toBe(true);
    if (!audio.ok || !doc.ok) return;

    const all = listSources(handle.db, projectId);
    const audioRow = all.find((s) => s.id === audio.source.id)!;
    const docRow = all.find((s) => s.id === doc.source.id)!;
    expect(audioRow.linkedSourceId).toBe(docRow.id);
    expect(docRow.linkedSourceId).toBe(audioRow.id);
    // The linked text side is now a transcript, and the audio has a duration.
    expect(docRow.kind).toBe("transcript");
    expect(audioRow.durationSeconds).toBeCloseTo(3, 1);
  });

  it("rejects a corrupt file with a clear error and leaves no partial state", async () => {
    const corrupt = Buffer.from("this is definitely not a zip archive");
    const result = await ingestFile(handle, projectId, "broken.docx", corrupt);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("broken.docx");
    expect(result.error).toMatch(/corrupt|not.*valid/i);

    // No database row…
    expect(listSources(handle.db, projectId)).toHaveLength(0);
    // …and no files left behind for this project.
    const projectDir = path.join(tmpDataDir, "sources", projectId);
    expect(
      !fs.existsSync(projectDir) || fs.readdirSync(projectDir).length === 0,
    ).toBe(true);
  });

  it("rejects a docx whose zip structure is broken (valid magic, corrupt body)", async () => {
    // Valid zip signature followed by garbage: passes the cheap gate, fails
    // in the real parser — must still roll back completely.
    const sneaky = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("garbage garbage garbage"),
    ]);
    const result = await ingestFile(handle, projectId, "sneaky.docx", sneaky);
    expect(result.ok).toBe(false);
    expect(listSources(handle.db, projectId)).toHaveLength(0);
    const projectDir = path.join(tmpDataDir, "sources", projectId);
    expect(
      !fs.existsSync(projectDir) || fs.readdirSync(projectDir).length === 0,
    ).toBe(true);
  });

  it("rejects unsupported extensions with a clear message", async () => {
    const result = await ingestFile(
      handle,
      projectId,
      "slides.pptx",
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not supported");
    expect(listSources(handle.db, projectId)).toHaveLength(0);
  });

  it("rejects an exact duplicate instead of ingesting it twice", async () => {
    const first = await ingestFile(handle, projectId, "talk-one.docx", DOCX);
    expect(first.ok).toBe(true);
    const second = await ingestFile(handle, projectId, "copy.docx", DOCX);
    expect(second.ok).toBe(false);
    expect(listSources(handle.db, projectId)).toHaveLength(1);
  });

  it("detects tampering: a modified original fails verification", async () => {
    const result = await ingestFile(handle, projectId, "talk-one.docx", DOCX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const originalAbs = path.join(tmpDataDir, result.source.originalPath!);
    fs.chmodSync(originalAbs, 0o644);
    fs.appendFileSync(originalAbs, "tamper");
    const verification = verifyChecksum(
      result.source.originalPath!,
      result.source.checksumSha1!,
    );
    expect(verification.ok).toBe(false);
  });
});
