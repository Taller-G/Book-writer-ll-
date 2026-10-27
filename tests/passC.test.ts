import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { setAiFactoryForTests } from "@/lib/jobs/executors";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { saveContract } from "@/lib/repo/editorial";
import { createProject } from "@/lib/repo/projects";
import { listReviewItems, resolveBatch } from "@/lib/repo/review";
import { insertText } from "@/lib/repo/texts";
import { FakeAiClient } from "./helpers/fakeAi";

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Pass C" }).id;
  saveContract(handle.db, { projectId, mode: "verbatim", rules: "", notes: "" });
  insertText(handle.db, {
    projectId,
    stageKey: "passB",
    version: 1,
    content: "En 1998 fundé la empresa. Más tarde dije que fue en 1999.",
  });
  setAiFactoryForTests(
    () =>
      new FakeAiClient(() =>
        JSON.stringify([
          { severity: "gross", description: "El año de fundación se da como 1998 y 1999.", excerpt: "En 1998 fundé la empresa" },
          { severity: "minor", description: "Variación de mayúsculas en un nombre.", excerpt: "empresa" },
        ]),
      ),
  );
});

afterEach(() => setAiFactoryForTests());

describe("Pass C (stage 3.6) — inconsistencies by severity in approvable batches", () => {
  it("emits severity-tagged items sharing one batch id, approvable in one step", async () => {
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 6,
      type: "classify_inconsistencies",
    });
    expect(job.status).toBe("succeeded");
    const out = JSON.parse(job.output!);
    expect(out.flagged).toBe(2);
    expect(out.bySeverity.gross).toBe(1);

    const items = listReviewItems(handle.db, projectId).filter(
      (i) => i.itemType === "inconsistency",
    );
    expect(items).toHaveLength(2);
    const batchIds = new Set(items.map((i) => i.batchId));
    expect(batchIds.size).toBe(1);
    expect(items.map((i) => i.severity).sort()).toEqual(["gross", "minor"]);

    // One-step batch approval resolves the whole batch.
    const resolved = resolveBatch(handle.db, projectId, out.batchId, "accepted");
    expect(resolved).toBe(2);
    expect(
      listReviewItems(handle.db, projectId).every((i) => i.status !== "pending"),
    ).toBe(true);
  });
});
