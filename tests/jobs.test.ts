import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { enqueueAndRun, retryJob } from "@/lib/jobs/runner";
import { listJobs } from "@/lib/repo/jobs";
import { createProject } from "@/lib/repo/projects";
import { saveContract } from "@/lib/repo/editorial";
import { addReviewItem, resolveReviewItem, listReviewItems } from "@/lib/repo/review";
import { addSource } from "@/lib/repo/sources";
import { insertText, latestText, listTextVersions } from "@/lib/repo/texts";

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Jobs test" }).id;
});

describe("stage job orchestration", () => {
  it("runs a stage job with versioned input and output", async () => {
    addSource(handle.db, {
      projectId,
      kind: "transcript",
      title: "S1",
      content: "Um, hello  there , world.",
    });
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 1,
      type: "ingest_sources",
    });
    expect(job.status).toBe("succeeded");
    expect(job.outputVersion).toBe(1);
    expect(JSON.parse(job.input).sourceCount).toBe(1);
    expect(latestText(handle.db, projectId, "raw")?.version).toBe(1);

    // Running again produces output version 2 — versions never overwrite.
    const again = await enqueueAndRun(handle, {
      projectId,
      stage: 1,
      type: "ingest_sources",
    });
    expect(again.outputVersion).toBe(2);
    expect(latestText(handle.db, projectId, "raw")?.version).toBe(2);
    expect(listTextVersions(handle.db, projectId)).toHaveLength(2);
  });

  it("a failed job records its error and leaves no partial output", async () => {
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 1,
      type: "ingest_sources", // no sources added → must fail
    });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/No sources yet/);
    expect(job.output).toBeNull();
    expect(latestText(handle.db, projectId, "raw")).toBeUndefined();
  });

  it("retry creates a new linked attempt and succeeds after the cause is fixed", async () => {
    const failed = await enqueueAndRun(handle, {
      projectId,
      stage: 1,
      type: "ingest_sources",
    });
    expect(failed.status).toBe("failed");

    addSource(handle.db, {
      projectId,
      kind: "notes",
      title: "Fix",
      content: "Now there is material.",
    });
    const retried = await retryJob(handle, failed.id);
    expect(retried.status).toBe("succeeded");
    expect(retried.attempt).toBe(2);
    expect(retried.retryOf).toBe(failed.id);
    expect(latestText(handle.db, projectId, "raw")?.version).toBe(1);

    // Both attempts remain in history.
    const history = listJobs(handle.db, projectId);
    expect(history).toHaveLength(2);
    expect(history.map((j) => j.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("retrying a succeeded job is rejected", async () => {
    addSource(handle.db, { projectId, kind: "notes", title: "A", content: "x" });
    const ok = await enqueueAndRun(handle, {
      projectId,
      stage: 1,
      type: "ingest_sources",
    });
    await expect(retryJob(handle, ok.id)).rejects.toThrow(/Only failed jobs/);
  });

  it("finalize refuses while review items are pending, then succeeds", async () => {
    insertText(handle.db, {
      projectId,
      stageKey: "passB",
      version: 1,
      content: "The reviewed text.",
    });
    addReviewItem(handle.db, {
      projectId,
      excerpt: "x",
      question: "Split this?",
    });

    const blocked = await enqueueAndRun(handle, {
      projectId,
      stage: 6,
      type: "finalize_text",
    });
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toMatch(/pending/);
    expect(latestText(handle.db, projectId, "final")).toBeUndefined();

    const item = listReviewItems(handle.db, projectId)[0];
    resolveReviewItem(handle.db, item.id, "accepted");
    const done = await retryJob(handle, blocked.id);
    expect(done.status).toBe("succeeded");
    expect(latestText(handle.db, projectId, "final")?.content).toBe(
      "The reviewed text.",
    );
  });

  it("cleanup pass records what/where/why in the change log", async () => {
    saveContract(handle.db, {
      projectId,
      mode: "prose",
      rules: "",
      notes: "",
    });
    insertText(handle.db, {
      projectId,
      stageKey: "raw",
      version: 1,
      content: "Um, this is , um, noisy  text.",
    });
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 4,
      type: "cleanup_pass_a",
    });
    expect(job.status).toBe("succeeded");
    expect(job.inputVersion).toBe(1);
    const rows = handle.sqlite
      .prepare(
        `SELECT what, "where", why, authorized_by FROM change_log WHERE project_id = ? AND what LIKE '%filler%'`,
      )
      .all(projectId) as { what: string; where: string; why: string; authorized_by: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].where).toMatch(/paragraph/);
    expect(rows[0].why).toMatch(/cleanup/);
    expect(rows[0].authorized_by).toContain(job.id);
  });
});
