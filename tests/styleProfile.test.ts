import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiClient } from "@/lib/ai";
import { canCompleteStage } from "@/lib/gates";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { addStyleReference } from "@/lib/ingest/styleRef";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { listAiUsage } from "@/lib/repo/aiUsage";
import { listChanges } from "@/lib/repo/changeLog";
import {
  confirmStyleProfile,
  getConfirmedStyleProfile,
  getStyleProfile,
  parseExcerpts,
  saveContract,
  type StyleProfileFields,
} from "@/lib/repo/editorial";
import { setApiKey } from "@/lib/repo/prefs";
import { createProject } from "@/lib/repo/projects";
import { addSource } from "@/lib/repo/sources";
import { listStyleRefs } from "@/lib/repo/styleRefs";
import {
  latestText,
  stampTextProfileVersion,
  textsUnderOldProfile,
} from "@/lib/repo/texts";

// The crypto helper keeps its key under the data dir — point it at a temp dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "book-writer-style-test-"));
process.env.BOOK_WRITER_DATA_DIR = tmp;

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEST_KEY = "sk-or-v1-style-test-key";

const EXTRACTED = {
  voice: "close and conversational, talks straight to the reader",
  tone: "warm",
  register: "everyday words, no jargon",
  person: "second person",
  rhythm: "short sentences, almost no subordinate clauses",
  punctuation: "almost no semicolons, dashes over parentheses",
  metaphors: "everyday examples",
  openings: "sections open with a question and close with one takeaway",
  notes: "never uses corporate vocabulary",
  excerpts: [
    "You already know this feeling.",
    "Try it once. Just once.",
    "Nobody taught us how to rest.",
  ],
};

function aiResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      model: "anthropic/claude-sonnet-4.6",
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 50, completion_tokens: 40, cost: 0.01 },
    }),
    { status: 200 },
  );
}

/** Stub global fetch with a queue of responses, recording request bodies. */
function stubFetch(queue: Response[]) {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const next = queue.shift();
    if (!next) throw new Error("stub fetch queue exhausted");
    return next;
  });
  return bodies;
}

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Style test" }).id;
  setApiKey(handle.db, TEST_KEY);
});

describe("style reference files", () => {
  it("accepts a readable text reference and stores its extracted text", async () => {
    const result = await addStyleReference(
      handle.db,
      projectId,
      "voice.md",
      Buffer.from("You already know this feeling. Try it once."),
    );
    expect(result.ok).toBe(true);
    const refs = listStyleRefs(handle.db, projectId);
    expect(refs).toHaveLength(1);
    expect(refs[0].wordCount).toBe(8);
  });

  it("rejects an empty file with a clear error and saves nothing", async () => {
    const result = await addStyleReference(
      handle.db,
      projectId,
      "empty.txt",
      Buffer.alloc(0),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/empty/i);
    expect(listStyleRefs(handle.db, projectId)).toHaveLength(0);
    expect(getStyleProfile(handle.db, projectId)).toBeUndefined();
  });

  it("rejects an unreadable (misnamed) file with a clear error", async () => {
    const result = await addStyleReference(
      handle.db,
      projectId,
      "chapter.pdf",
      Buffer.from("this is plain text, not a pdf"),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/corrupt or misnamed/);
    expect(listStyleRefs(handle.db, projectId)).toHaveLength(0);
  });

  it("rejects formats that cannot carry a writing style", async () => {
    const result = await addStyleReference(
      handle.db,
      projectId,
      "song.mp3",
      Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/only txt, md, pdf and docx/);
  });

  it("rejects a whitespace-only file: no readable text, no profile", async () => {
    const result = await addStyleReference(
      handle.db,
      projectId,
      "blank.txt",
      Buffer.from("   \n\n   \n"),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/no readable text/);
    expect(getStyleProfile(handle.db, projectId)).toBeUndefined();
  });
});

describe("style profile extraction job", () => {
  it("fails with a clear message when no references are attached", async () => {
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 3,
      type: "extract_style",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/No reference files/);
    expect(getStyleProfile(handle.db, projectId)).toBeUndefined();
  });

  it("extracts a plain-language DRAFT profile with verbatim excerpts", async () => {
    await addStyleReference(
      handle.db,
      projectId,
      "voice.txt",
      Buffer.from("You already know this feeling. Try it once. Just once."),
    );
    stubFetch([aiResponse(JSON.stringify(EXTRACTED))]);
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 3,
      type: "extract_style",
    });
    expect(job.status).toBe("succeeded");

    const profile = getStyleProfile(handle.db, projectId)!;
    expect(profile.status).toBe("draft");
    expect(profile.voice).toBe(EXTRACTED.voice);
    expect(profile.rhythm).toBe(EXTRACTED.rhythm);
    expect(parseExcerpts(profile)).toEqual(EXTRACTED.excerpts);
    // A draft shapes nothing and does not satisfy the stage gate.
    expect(getConfirmedStyleProfile(handle.db, projectId)).toBeUndefined();
    expect(canCompleteStage(handle.db, projectId, 3).ok).toBe(false);
  });

  it("an unparseable AI response fails the job and saves NO profile", async () => {
    await addStyleReference(
      handle.db,
      projectId,
      "voice.txt",
      Buffer.from("Some reference text."),
    );
    stubFetch([aiResponse("Sure! Here is my analysis of the style...")]);
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 3,
      type: "extract_style",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/unparseable/);
    expect(getStyleProfile(handle.db, projectId)).toBeUndefined();
  });

  it("an incomplete profile (no excerpts) fails and saves NO profile", async () => {
    await addStyleReference(
      handle.db,
      projectId,
      "voice.txt",
      Buffer.from("Some reference text."),
    );
    stubFetch([
      aiResponse(JSON.stringify({ ...EXTRACTED, excerpts: [] })),
    ]);
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 3,
      type: "extract_style",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/incomplete/);
    expect(getStyleProfile(handle.db, projectId)).toBeUndefined();
  });
});

const CONFIRMED_FIELDS: StyleProfileFields = {
  voice: EXTRACTED.voice,
  tone: EXTRACTED.tone,
  register: EXTRACTED.register,
  person: EXTRACTED.person,
  rhythm: EXTRACTED.rhythm,
  punctuation: EXTRACTED.punctuation,
  metaphors: EXTRACTED.metaphors,
  openings: EXTRACTED.openings,
  notes: EXTRACTED.notes,
  excerpts: EXTRACTED.excerpts,
};

describe("profile injection into every AI call", () => {
  it("injects the confirmed profile and excerpts, verifiable in the call log", async () => {
    confirmStyleProfile(handle.db, projectId, CONFIRMED_FIELDS);
    expect(canCompleteStage(handle.db, projectId, 3).ok).toBe(true);

    const bodies = stubFetch([aiResponse("some generated text")]);
    const client = createAiClient(handle.db);
    // A downstream call that passes ONLY its task instructions.
    await client.complete({
      role: "large",
      system: { instructions: "Clean up this transcription." },
      messages: [{ role: "user", content: "hello world" }],
      projectId,
    });

    // The request payload carries the profile and every excerpt...
    const systemMessage = JSON.parse(bodies[0]).messages[0];
    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toContain("Style profile (v1)");
    expect(systemMessage.content).toContain(`- voice: ${EXTRACTED.voice}`);
    for (const excerpt of EXTRACTED.excerpts) {
      expect(systemMessage.content).toContain(excerpt);
    }
    // ...and the call log records the exact system prompt sent.
    const log = listAiUsage(handle.db, projectId);
    expect(log).toHaveLength(1);
    expect(log[0].systemPrompt).toBe(systemMessage.content);
    for (const excerpt of EXTRACTED.excerpts) {
      expect(log[0].systemPrompt).toContain(excerpt);
    }
  });

  it("a project reopened from disk injects the identical profile with no user action", async () => {
    const file = path.join(tmp, "resume-test.db");
    const first = openDatabase(file);
    const pid = createProject(first, { title: "Resume" }).id;
    setApiKey(first.db, TEST_KEY);
    confirmStyleProfile(first.db, pid, CONFIRMED_FIELDS);

    const bodiesBefore = stubFetch([aiResponse("before close")]);
    await createAiClient(first.db).complete({
      role: "large",
      system: { instructions: "Task." },
      messages: [{ role: "user", content: "x" }],
      projectId: pid,
    });
    first.sqlite.close();
    vi.unstubAllGlobals();

    // "Weeks later": a brand new connection, no session state carried over.
    const second = openDatabase(file);
    const bodiesAfter = stubFetch([aiResponse("after reopen")]);
    await createAiClient(second.db).complete({
      role: "large",
      system: { instructions: "Task." },
      messages: [{ role: "user", content: "x" }],
      projectId: pid,
    });
    const before = JSON.parse(bodiesBefore[0]).messages[0].content;
    const after = JSON.parse(bodiesAfter[0]).messages[0].content;
    expect(after).toBe(before);
    expect(after).toContain(EXTRACTED.excerpts[0]);
    second.sqlite.close();
  });
});

describe("sample passage with the draft profile", () => {
  it("rewrites the user's own material and stores the sample", async () => {
    addSource(handle.db, {
      projectId,
      kind: "transcript",
      title: "S1",
      content: "We were talking about rest and why nobody values it.",
    });
    confirmStyleProfile(handle.db, projectId, CONFIRMED_FIELDS);
    const bodies = stubFetch([aiResponse("You already know what rest is.")]);
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 3,
      type: "style_sample",
    });
    expect(job.status).toBe("succeeded");
    expect(getStyleProfile(handle.db, projectId)!.sample).toBe(
      "You already know what rest is.",
    );
    // The sample call itself carried the profile.
    expect(JSON.parse(bodies[0]).messages[0].content).toContain("Style profile");
    // And the user's own material was the input.
    expect(JSON.parse(bodies[0]).messages[1].content).toContain(
      "talking about rest",
    );
  });
});

describe("mid-project profile change", () => {
  async function producePassA(): Promise<void> {
    await enqueueAndRun(handle, { projectId, stage: 1, type: "ingest_sources" });
    await enqueueAndRun(handle, { projectId, stage: 4, type: "cleanup_pass_a" });
  }

  it("lists texts written under the previous profile; keep and regenerate both clear them", async () => {
    addSource(handle.db, {
      projectId,
      kind: "transcript",
      title: "S1",
      content: "Um, first paragraph.\n\nSecond paragraph here.",
    });
    // Text passes refuse to run without a signed editorial contract.
    saveContract(handle.db, { projectId, mode: "prose", rules: "", notes: "" });
    confirmStyleProfile(handle.db, projectId, CONFIRMED_FIELDS);
    await producePassA();

    const passA = latestText(handle.db, projectId, "passA")!;
    expect(passA.styleProfileVersion).toBe(1);
    // In sync: nothing to offer.
    expect(textsUnderOldProfile(handle.db, projectId, 1)).toHaveLength(0);

    // The user changes the profile mid-project -> v2.
    const v2 = confirmStyleProfile(handle.db, projectId, {
      ...CONFIRMED_FIELDS,
      rhythm: "long, winding sentences",
    });
    expect(v2.version).toBe(2);
    const stale = textsUnderOldProfile(handle.db, projectId, 2);
    expect(stale.map((t) => t.stageKey)).toEqual(["passA"]);

    // Choice 1 — KEEP: the text is stamped with the current version, untouched.
    stampTextProfileVersion(handle.db, passA.id, 2);
    expect(textsUnderOldProfile(handle.db, projectId, 2)).toHaveLength(0);
    expect(latestText(handle.db, projectId, "passA")!.content).toBe(passA.content);

    // A third profile version, then choice 2 — REGENERATE: a new text version
    // is produced and stamped with the current profile.
    const v3 = confirmStyleProfile(handle.db, projectId, {
      ...CONFIRMED_FIELDS,
      tone: "clinical",
    });
    expect(v3.version).toBe(3);
    expect(textsUnderOldProfile(handle.db, projectId, 3)).toHaveLength(1);
    await enqueueAndRun(handle, { projectId, stage: 4, type: "cleanup_pass_a" });
    const regenerated = latestText(handle.db, projectId, "passA")!;
    expect(regenerated.version).toBe(passA.version + 1);
    expect(regenerated.styleProfileVersion).toBe(3);
    expect(textsUnderOldProfile(handle.db, projectId, 3)).toHaveLength(0);
  });

  it("confirming records the change in the audit log", () => {
    confirmStyleProfile(handle.db, projectId, CONFIRMED_FIELDS);
    confirmStyleProfile(handle.db, projectId, {
      ...CONFIRMED_FIELDS,
      tone: "drier",
    });
    const changes = listChanges(handle.db, projectId, 10).map((c) => c.what);
    expect(changes.some((w) => w.includes("Style profile v1 confirmed"))).toBe(true);
    expect(changes.some((w) => w.includes("Style profile v2 confirmed"))).toBe(true);
  });
});
