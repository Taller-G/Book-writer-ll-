import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorshipWarning, proposeLegalText } from "@/lib/contract/definitions";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { enqueueAndRun } from "@/lib/jobs/runner";
import {
  getContract,
  listContractVersions,
  listDownstreamArtifacts,
  saveContract,
} from "@/lib/repo/editorial";
import { setApiKey } from "@/lib/repo/prefs";
import { createProject } from "@/lib/repo/projects";
import { insertText, latestText } from "@/lib/repo/texts";

// The crypto helper keeps its key under the data dir — point it at a temp dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "book-writer-test-"));
process.env.BOOK_WRITER_DATA_DIR = tmp;

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, {
    title: "Contract test",
    author: "María Pérez",
  }).id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SPOKEN_RAW =
  "Um, I arrived in the city in 1952, um, and you know there was no work.\n\n" +
  "Este, my mother said we eat what there is.";

describe("editorial contract — mode is read by downstream passes", () => {
  it("verbatim mode blocks rewrites in Pass A (fillers kept, blocks logged)", async () => {
    saveContract(handle.db, { projectId, mode: "verbatim", rules: "", notes: "" });
    insertText(handle.db, { projectId, stageKey: "raw", version: 1, content: SPOKEN_RAW });

    const job = await enqueueAndRun(handle, { projectId, stage: 4, type: "cleanup_pass_a" });
    expect(job.status).toBe("succeeded");
    const output = JSON.parse(job.output!);
    expect(output.blockedByContract).toBeGreaterThan(0);
    expect(output.contractVersion).toBe(1);
    expect(JSON.parse(job.input).contractMode).toBe("verbatim");

    // The filler words survive — the text was not rewritten.
    const passA = latestText(handle.db, projectId, "passA")!;
    expect(passA.content).toMatch(/Um,/);
    expect(passA.content).toMatch(/Este,/);

    const blocked = handle.sqlite
      .prepare(`SELECT why FROM change_log WHERE project_id = ? AND what LIKE 'Kept filler%'`)
      .all(projectId) as { why: string }[];
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0].why).toMatch(/verbatim — rewrites are blocked/);
  });

  it("prose mode allows the same rewrites Pass A blocks under verbatim", async () => {
    saveContract(handle.db, { projectId, mode: "prose", rules: "", notes: "" });
    insertText(handle.db, { projectId, stageKey: "raw", version: 1, content: SPOKEN_RAW });

    const job = await enqueueAndRun(handle, { projectId, stage: 4, type: "cleanup_pass_a" });
    expect(job.status).toBe("succeeded");
    const passA = latestText(handle.db, projectId, "passA")!;
    expect(passA.content).not.toMatch(/\bUm\b/i);
  });

  it("verbatim mode makes Pass B pass the text through unchanged", async () => {
    saveContract(handle.db, { projectId, mode: "verbatim", rules: "", notes: "" });
    const longParagraph = Array(130).fill("word").join(" ");
    insertText(handle.db, { projectId, stageKey: "passA", version: 1, content: longParagraph });

    const job = await enqueueAndRun(handle, { projectId, stage: 5, type: "refine_pass_b" });
    expect(job.status).toBe("succeeded");
    expect(JSON.parse(job.output!).rewritesBlocked).toBe(true);
    expect(JSON.parse(job.output!).flagged).toBe(0);
    expect(latestText(handle.db, projectId, "passB")!.content).toBe(longParagraph);

    const log = handle.sqlite
      .prepare(`SELECT what FROM change_log WHERE project_id = ? AND what LIKE '%verbatim contract blocks rewrites%'`)
      .all(projectId);
    expect(log.length).toBe(1);
  });

  it("text passes refuse to run without a signed contract", async () => {
    insertText(handle.db, { projectId, stageKey: "raw", version: 1, content: SPOKEN_RAW });
    const job = await enqueueAndRun(handle, { projectId, stage: 4, type: "cleanup_pass_a" });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/No editorial contract/);
  });
});

describe("tone samples from the user's own material", () => {
  function stubOpenRouter(seen: { userContent: string[]; systemContent: string[] }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        seen.systemContent.push(body.messages[0].content);
        seen.userContent.push(body.messages[1].content);
        return new Response(
          JSON.stringify({
            model: body.model,
            choices: [{ message: { content: `rewritten: ${body.messages[1].content.slice(0, 40)}` } }],
            usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.001 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
  }

  it("generates one sample per tone from the uploaded material", async () => {
    setApiKey(handle.db, "sk-or-v1-test-key");
    insertText(handle.db, { projectId, stageKey: "raw", version: 1, content: SPOKEN_RAW });
    const seen = { userContent: [] as string[], systemContent: [] as string[] };
    stubOpenRouter(seen);

    const job = await enqueueAndRun(handle, { projectId, stage: 2, type: "tone_samples" });
    expect(job.status).toBe("succeeded");

    const output = JSON.parse(job.output!);
    expect(output.samples).toHaveLength(4);
    expect(output.samples.map((s: { tone: string }) => s.tone).sort()).toEqual([
      "academic",
      "conversational",
      "literary_cinematic",
      "neutral",
    ]);
    // The passage sent to the model is the user's real material, and all four
    // tones received the SAME passage — a side-by-side comparison.
    expect(output.excerpt).toContain("I arrived in the city in 1952");
    expect(seen.userContent).toHaveLength(4);
    for (const content of seen.userContent) expect(content).toBe(output.excerpt);
    // Each call carried a different tone instruction.
    expect(new Set(seen.systemContent).size).toBe(4);
  });

  it("refuses to run before the user's material is compiled", async () => {
    setApiKey(handle.db, "sk-or-v1-test-key");
    const job = await enqueueAndRun(handle, { projectId, stage: 2, type: "tone_samples" });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/your own material/);
  });
});

describe("authorship and rights", () => {
  it("declaring third-party material proposes a legal text and warns", () => {
    const { contract } = saveContract(handle.db, {
      projectId,
      mode: "hybrid",
      authorship: "third_party",
      destination: "isbn",
      rules: "",
      notes: "",
    });
    expect(contract.legalText).toMatch(/third parties/);
    expect(contract.legalText).toMatch(/María Pérez/);
    expect(contract.legalText).toMatch(/ISBN/);

    const warning = authorshipWarning("third_party", "isbn");
    expect(warning).toMatch(/cannot verify rights/);
    expect(warning).toMatch(/infringe copyright/);
    expect(authorshipWarning("own")).toBeNull();
  });

  it("the user's own legal text is never overwritten by the proposal", () => {
    const { contract } = saveContract(handle.db, {
      projectId,
      mode: "hybrid",
      authorship: "mixed",
      legalText: "My own legal wording.",
      rules: "",
      notes: "",
    });
    expect(contract.legalText).toBe("My own legal wording.");
    expect(proposeLegalText({ authorship: "mixed" })).toMatch(/third parties/);
  });
});

describe("contract versioning and mid-project changes", () => {
  it("every decision change bumps the version and snapshots it", () => {
    saveContract(handle.db, { projectId, mode: "hybrid", rules: "", notes: "" });
    const second = saveContract(handle.db, {
      projectId,
      mode: "verbatim",
      tone: "neutral",
      rules: "",
      notes: "",
    });
    expect(second.contract.version).toBe(2);
    expect(second.changed).toContain("mode");
    expect(second.changed).toContain("tone");

    const versions = listContractVersions(handle.db, projectId);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(JSON.parse(versions[1].snapshot).mode).toBe("hybrid");

    // Saving the identical contract again is a no-op, not a new version.
    const third = saveContract(handle.db, {
      projectId,
      mode: "verbatim",
      tone: "neutral",
      rules: "",
      notes: "",
    });
    expect(third.changed).toEqual([]);
    expect(third.contract.version).toBe(2);
  });

  it("changing the contract after later stages ran names the affected artifacts", () => {
    saveContract(handle.db, { projectId, mode: "prose", rules: "", notes: "" });
    insertText(handle.db, { projectId, stageKey: "passA", version: 1, content: "a" });
    insertText(handle.db, { projectId, stageKey: "passB", version: 1, content: "b" });

    const result = saveContract(handle.db, {
      projectId,
      mode: "verbatim",
      rules: "",
      notes: "",
    });
    expect(result.affected.map((a) => a.label)).toEqual([
      "Cleanup Pass A text v1",
      "Refine Pass B text v1",
    ]);

    // The warning is on the record, naming each artifact.
    const log = handle.sqlite
      .prepare(`SELECT what, why FROM change_log WHERE project_id = ? AND what LIKE 'Contract change%'`)
      .all(projectId) as { what: string; why: string }[];
    expect(log).toHaveLength(1);
    expect(log[0].what).toContain("Cleanup Pass A text v1");
    expect(log[0].what).toContain("Refine Pass B text v1");
    expect(log[0].why).toMatch(/produced under contract v1/);
  });

  it("the first signature affects nothing — no artifacts exist under it yet", () => {
    const first = saveContract(handle.db, { projectId, mode: "hybrid", rules: "", notes: "" });
    expect(first.affected).toEqual([]);
    expect(getContract(handle.db, projectId)!.version).toBe(1);
    expect(listDownstreamArtifacts(handle.db, projectId)).toEqual([]);
  });
});
