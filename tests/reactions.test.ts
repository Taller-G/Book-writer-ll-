import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// Point the file store at a temp dir before anything captures dataDir().
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-reactions-"));
process.env.BOOK_WRITER_DATA_DIR = tmpDataDir;

import { openDatabase, type DbHandle } from "@/lib/db/client";
import { saveOriginal } from "@/lib/files/store";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { setAiFactoryForTests } from "@/lib/jobs/executors";
import { saveContract } from "@/lib/repo/editorial";
import { createProject } from "@/lib/repo/projects";
import {
  addReaction,
  confirmedReactions,
  listReactions,
} from "@/lib/repo/reactions";
import { listReviewItems } from "@/lib/repo/review";
import { addFileSource, addSource, linkSources } from "@/lib/repo/sources";
import { detectReactions } from "@/lib/reactions/dsp";
import { msToCharOffset } from "@/lib/reactions/detect";
import { encodeWav } from "@/lib/reactions/wav";
import { newId } from "@/lib/util";
import { FakeAiClient } from "./helpers/fakeAi";

let handle: DbHandle;
let projectId: string;

const SR = 16000;

// Deterministic pseudo-noise so tests never flake.
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

/** 5 s: 3 s of a quiet voiced tone, then 2 s of loud broadband applause. */
function talkWithFinalApplause(): Float32Array {
  const n = SR * 5;
  const s = new Float32Array(n);
  const noise = rng(7);
  for (let i = 0; i < SR * 3; i++) s[i] = 0.2 * Math.sin((2 * Math.PI * 170 * i) / SR);
  for (let i = SR * 3; i < n; i++) s[i] = noise() * 0.5;
  return s;
}

/** 5 s of a near-silent room: only low-level ambient noise. */
function quietRoom(): Float32Array {
  const n = SR * 5;
  const s = new Float32Array(n);
  const noise = rng(11);
  for (let i = 0; i < n; i++) s[i] = noise() * 0.02;
  return s;
}

function seedAudioProject(samples: Float32Array, transcript: string): string {
  const id = createProject(handle, { title: "Talk" }).id;
  saveContract(handle.db, { projectId: id, mode: "verbatim", rules: "", notes: "" });
  const audioId = newId();
  const wav = encodeWav(samples, SR);
  const stored = saveOriginal(id, audioId, "talk.wav", wav);
  addFileSource(handle.db, {
    id: audioId,
    projectId: id,
    kind: "audio",
    title: "talk.wav",
    content: "",
    mediaType: "audio",
    originalName: "talk.wav",
    originalPath: stored.relativePath,
    mimeType: "audio/wav",
    sizeBytes: stored.sizeBytes,
    checksumSha1: stored.checksumSha1,
    durationSeconds: samples.length / SR,
    language: "es",
    wordCount: null,
  });
  const textId = addSource(handle.db, {
    projectId: id,
    kind: "transcript",
    title: "talk.txt",
    content: transcript,
  }).id;
  linkSources(handle.db, audioId, textId);
  return id;
}

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "root" }).id;
  // Fake semantic checker: a joke draws laughter, a strong line draws applause.
  setAiFactoryForTests(
    () =>
      new FakeAiClient((req) => {
        const content = req.messages[0]?.content ?? "";
        if (/applause/i.test(content)) return JSON.stringify({ funny: false, forceful: true, note: "rousing" });
        if (/laughter/i.test(content)) return JSON.stringify({ funny: true, forceful: false, note: "joke" });
        return JSON.stringify({ funny: false, forceful: false, note: "" });
      }),
  );
});

afterEach(() => setAiFactoryForTests());
afterAll(() => fs.rmSync(tmpDataDir, { recursive: true, force: true }));

describe("acoustic reaction detection (stage 3.4)", () => {
  it("raw DSP finds a clear final applause and nothing in a quiet room", () => {
    const loud = detectReactions(talkWithFinalApplause(), SR);
    expect(loud.length).toBeGreaterThan(0);
    expect(loud[0].kind).toBe("applause");
    expect(loud[0].startMs).toBeGreaterThanOrEqual(2800);

    expect(detectReactions(quietRoom(), SR)).toHaveLength(0);
  });

  it("a recording with a clear final applause produces a candidate with its clip", async () => {
    const id = seedAudioProject(
      talkWithFinalApplause(),
      "Gracias por venir. Esto cambiará el mundo y lo haremos juntos.",
    );
    const job = await enqueueAndRun(handle, { projectId: id, stage: 5, type: "detect_reactions" });
    expect(job.status).toBe("succeeded");

    const candidates = listReactions(handle.db, id, "candidate");
    expect(candidates.length).toBe(1);
    const r = candidates[0];
    expect(r.kind).toBe("applause");
    expect(r.origin).toBe("acoustic");
    // The clip was extracted to disk.
    expect(r.clipPath).toBeTruthy();
    expect(fs.existsSync(path.join(tmpDataDir, r.clipPath!))).toBe(true);

    // It is in the review queue carrying its clip, pending confirmation.
    const items = listReviewItems(handle.db, id).filter((i) => i.itemType === "reaction");
    expect(items).toHaveLength(1);
    expect(items[0].clipPath).toBe(r.clipPath);
    expect(items[0].refId).toBe(r.id);
    expect(items[0].status).toBe("pending");
  });

  it("a quiet-room recording produces no false positives, and manual marking still works", async () => {
    const id = seedAudioProject(quietRoom(), "Una charla tranquila sin reacciones audibles.");
    const job = await enqueueAndRun(handle, { projectId: id, stage: 5, type: "detect_reactions" });
    expect(job.status).toBe("succeeded");
    expect(JSON.parse(job.output!).candidates).toBe(0);
    expect(listReactions(handle.db, id)).toHaveLength(0);

    // Manual-marking path: the user marks a reaction by hand (quiet room).
    const transcript = "Una charla tranquila sin reacciones audibles.";
    addReaction(handle.db, {
      projectId: id,
      kind: "applause",
      startMs: 0,
      endMs: 0,
      origin: "manual",
      status: "confirmed",
      semantic: "manually marked by user",
      charAnchor: msToCharOffset(0, 1, transcript.length),
    });
    const confirmed = confirmedReactions(handle.db, id);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].origin).toBe("manual");
    expect(confirmed[0].status).toBe("confirmed");
  });
});
