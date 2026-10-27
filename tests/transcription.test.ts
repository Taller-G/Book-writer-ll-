import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// The file store resolves against dataDir(); point it at a temp dir before any
// import captures it.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-asr-"));
process.env.BOOK_WRITER_DATA_DIR = tmpDataDir;

import { openDatabase, type DbHandle } from "@/lib/db/client";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { ingestFile } from "@/lib/ingest/ingest";
import { createProject } from "@/lib/repo/projects";
import { getSource, listSources } from "@/lib/repo/sources";
import {
  setTranscriptionFactoryForTests,
  type TranscriptionClient,
} from "@/lib/transcription/asr";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");
const WAV = fs.readFileSync(path.join(FIXTURES, "talk-one.wav"));

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "ASR test" }).id;
});

afterEach(() => {
  setTranscriptionFactoryForTests();
});

afterAll(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

/** A canned ASR backend: returns a fixed transcript with word timestamps. */
function fakeClient(text: string): TranscriptionClient {
  return {
    async transcribe() {
      const parts = text.split(/\s+/).filter(Boolean);
      return {
        text,
        words: parts.map((word, i) => ({
          word,
          start: i * 0.5,
          end: i * 0.5 + 0.4,
        })),
        language: "en",
        model: "whisper-large-v3",
      };
    },
  };
}

describe("audio transcription (stage 3.1)", () => {
  it("transcribes an uploaded recording with word-level timestamps and logs it", async () => {
    const ingested = await ingestFile(handle, projectId, "talk-one.wav", WAV);
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;
    // Audio has no extracted text until it is transcribed.
    expect(ingested.source.content).toBe("");

    setTranscriptionFactoryForTests(() => fakeClient("Hello there world."));
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 1,
      type: "transcribe_audio",
    });
    expect(job.status).toBe("succeeded");
    expect(JSON.parse(job.input).total).toBe(1);

    const source = getSource(handle.db, ingested.source.id)!;
    expect(source.content).toBe("Hello there world.");
    expect(source.wordCount).toBe(3);
    expect(source.language).toBe("en");
    const meta = JSON.parse(source.metadata);
    expect(meta.transcription.model).toBe("whisper-large-v3");
    expect(meta.transcription.words).toHaveLength(3);
    expect(meta.transcription.words[0]).toMatchObject({ word: "Hello", start: 0 });

    const rows = handle.sqlite
      .prepare(
        `SELECT what, "where" FROM change_log WHERE project_id = ? AND what LIKE '%Transcribed%'`,
      )
      .all(projectId) as { what: string; where: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].where).toContain("transcription");
  });

  it("fails clearly when there is no audio to transcribe", async () => {
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 1,
      type: "transcribe_audio",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/No audio to transcribe/);
    expect(listSources(handle.db, projectId)).toHaveLength(0);
  });
});
