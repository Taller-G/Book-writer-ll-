import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { listChanges } from "@/lib/repo/changeLog";
import { getLock, isLocked, unlockText } from "@/lib/repo/locks";
import { createProject } from "@/lib/repo/projects";
import { addReviewItem, resolveReviewItem, listReviewItems } from "@/lib/repo/review";
import { insertText, latestText } from "@/lib/repo/texts";

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Finalize & lock" }).id;
});

function run(type: string, stage = 6) {
  return enqueueAndRun(handle, { projectId, stage, type });
}

describe("stage-closing verification and the FINAL lock (stage 3.6)", () => {
  it("refuses to close while a review item is pending", async () => {
    insertText(handle.db, { projectId, stageKey: "passB", version: 1, content: "Texto limpio." });
    addReviewItem(handle.db, { projectId, excerpt: "x", question: "¿Revisar esto?" });
    const job = await run("finalize_text");
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/pending/);
    expect(latestText(handle.db, projectId, "final")).toBeUndefined();
  });

  it("refuses to close with unbalanced «» quotes", async () => {
    insertText(handle.db, {
      projectId,
      stageKey: "passB",
      version: 1,
      content: "Él dijo «hola y nunca cerró la cita.",
    });
    const job = await run("finalize_text");
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/unbalanced quotes/i);
    expect(isLocked(handle.db, projectId)).toBe(false);
  });

  it("closes, locks, and then requires an explicit, logged unlock before re-editing", async () => {
    insertText(handle.db, {
      projectId,
      stageKey: "passB",
      version: 1,
      content: "Él dijo «hola» y todos aplaudieron.",
    });

    // Clean close succeeds and locks.
    const closed = await run("finalize_text");
    expect(closed.status).toBe("succeeded");
    expect(JSON.parse(closed.output!).locked).toBe(true);
    expect(isLocked(handle.db, projectId)).toBe(true);
    expect(getLock(handle.db, projectId)?.lockedVersion).toBe(1);

    // A second finalize is refused while locked — no silent re-close.
    const relocked = await run("finalize_text");
    expect(relocked.status).toBe("failed");
    expect(relocked.error).toMatch(/FINAL and locked/i);

    // Any text-producing pass is also refused while locked.
    insertText(handle.db, { projectId, stageKey: "passA", version: 1, content: "Texto." });
    const blockedPassB = await enqueueAndRun(handle, { projectId, stage: 5, type: "refine_pass_b" });
    expect(blockedPassB.status).toBe("failed");
    expect(blockedPassB.error).toMatch(/FINAL and locked/i);

    // Explicit unlock is the only way back — and it is written to the log.
    unlockText(handle.db, projectId, "fix a typo on page 40");
    expect(isLocked(handle.db, projectId)).toBe(false);
    const unlockEntries = listChanges(handle.db, projectId).filter((c) =>
      /unlocked for editing/i.test(c.what),
    );
    expect(unlockEntries).toHaveLength(1);
    expect(unlockEntries[0].why).toMatch(/typo on page 40/);

    // After unlocking, closing again works and produces a new FINAL version.
    const reclosed = await run("finalize_text");
    expect(reclosed.status).toBe("succeeded");
    expect(latestText(handle.db, projectId, "final")!.version).toBe(2);
    expect(isLocked(handle.db, projectId)).toBe(true);
  });

  it("the whole queue — reactions, questions, inconsistencies — gates the close", async () => {
    insertText(handle.db, { projectId, stageKey: "passB", version: 1, content: "Texto." });
    const item = addReviewItem(handle.db, {
      projectId,
      itemType: "inconsistency",
      severity: "gross",
      excerpt: "",
      question: "Dos fechas distintas para el mismo evento.",
    });
    expect((await run("finalize_text")).status).toBe("failed");
    resolveReviewItem(handle.db, item!.id, "accepted");
    expect(listReviewItems(handle.db, projectId).every((i) => i.status !== "pending")).toBe(true);
    expect((await run("finalize_text")).status).toBe("succeeded");
  });
});
