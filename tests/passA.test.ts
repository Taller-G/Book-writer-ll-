import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { setAiFactoryForTests } from "@/lib/jobs/executors";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { listChanges } from "@/lib/repo/changeLog";
import { saveContract } from "@/lib/repo/editorial";
import { createProject } from "@/lib/repo/projects";
import { listReviewItems } from "@/lib/repo/review";
import { insertText, latestText } from "@/lib/repo/texts";
import { FakeAiClient } from "./helpers/fakeAi";

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Pass A test" }).id;
});

afterEach(() => setAiFactoryForTests());

/** Seed a signed contract and a raw transcript, then make the AI propose the
 *  given corrections JSON for the Pass A job. */
function seed(mode: "verbatim" | "prose", raw: string, corrections: unknown): void {
  saveContract(handle.db, { projectId, mode, rules: "", notes: "" });
  insertText(handle.db, { projectId, stageKey: "raw", version: 1, content: raw });
  setAiFactoryForTests(
    () => new FakeAiClient(() => JSON.stringify(corrections)),
  );
}

describe("Pass A transcription-noise correction", () => {
  it("corrects a known mishearing, verifies it, and logs it with its justification and classification", async () => {
    seed("verbatim", "And then he said Tu shé and left the room.", [
      {
        type: "ASR",
        original: "Tu shé",
        correction: "Touché",
        justification: 'the transcriber misheard the French "Touché"',
      },
    ]);

    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 4,
      type: "cleanup_pass_a",
    });
    expect(job.status).toBe("succeeded");
    expect(JSON.parse(job.output!).corrections).toBe(1);
    expect(JSON.parse(job.output!).diffVerified).toBe(true);

    const passA = latestText(handle.db, projectId, "passA")!;
    expect(passA.content).toContain("Touché");
    expect(passA.content).not.toContain("Tu shé");

    const row = handle.sqlite
      .prepare(
        `SELECT what, why, category, authorized_by FROM change_log
         WHERE project_id = ? AND category = 'ASR'`,
      )
      .get(projectId) as {
      what: string;
      why: string;
      category: string;
      authorized_by: string;
    };
    expect(row.what).toContain('"Tu shé" → "Touché"');
    expect(row.what).toContain("ASR");
    expect(row.why).toMatch(/misheard/);
    expect(row.category).toBe("ASR");
    expect(row.authorized_by).toContain(job.id);
  });

  it("does not auto-apply a correction whose target appears twice — it surfaces as a doubtful item", async () => {
    seed("verbatim", "Tu shé here, and again Tu shé there.", [
      {
        type: "ASR",
        original: "Tu shé",
        correction: "Touché",
        justification: "misheard",
      },
    ]);

    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 4,
      type: "cleanup_pass_a",
    });
    expect(job.status).toBe("succeeded");
    expect(JSON.parse(job.output!).corrections).toBe(0);
    expect(JSON.parse(job.output!).doubtful).toBe(1);

    // Still present twice — nothing was applied.
    const passA = latestText(handle.db, projectId, "passA")!;
    expect(passA.content).toContain("Tu shé here");
    expect(passA.content).toContain("Tu shé there");

    const items = listReviewItems(handle.db, projectId);
    const doubtful = items.find((i) => i.itemType === "transcription");
    expect(doubtful).toBeDefined();
    expect(doubtful!.question).toMatch(/appears 2 times/);
  });

  it("rejects an attempted rewrite under a faithful contract, with an explanation, and does not apply it", async () => {
    seed("verbatim", "She closed the door quietly and sat down.", [
      {
        type: "ASR",
        original: "She closed the door quietly and sat down.",
        correction: "She shut the door and took a seat, saying nothing at all.",
        justification: "reads better",
      },
    ]);

    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 4,
      type: "cleanup_pass_a",
    });
    expect(job.status).toBe("succeeded");
    expect(JSON.parse(job.output!).corrections).toBe(0);
    expect(JSON.parse(job.output!).rejected).toBe(1);

    // The author's words are untouched.
    const passA = latestText(handle.db, projectId, "passA")!;
    expect(passA.content).toBe("She closed the door quietly and sat down.");

    const rejected = listChanges(handle.db, projectId).find((c) =>
      c.what.startsWith("Rejected proposed edit"),
    );
    expect(rejected).toBeDefined();
    expect(rejected!.why).toMatch(/rewrite|too large/i);
    expect(rejected!.why).toMatch(/verbatim/);
  });
});
