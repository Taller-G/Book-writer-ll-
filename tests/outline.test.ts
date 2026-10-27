import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { setAiFactoryForTests } from "@/lib/jobs/executors";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { proposeOutline } from "@/lib/master/outline";
import { segmentText } from "@/lib/master/segments";
import { listChanges } from "@/lib/repo/changeLog";
import {
  confirmOutline,
  getOutline,
  parseOutlineData,
  saveOutlineEdit,
} from "@/lib/repo/outline";
import { FakeAiClient, PASS_A, seedProseProject } from "./helpers/fakeAi";

const OUTLINE_JSON = JSON.stringify({
  chapters: [
    {
      title: "El patio y el limonero",
      part: "",
      summary: "La infancia en la casa familiar.",
      themes: ["infancia", "casa"],
      segmentIds: [0, 1, 2],
    },
    {
      title: "La mesa compartida",
      part: "",
      summary: "Lo aprendido vuelve en la vida adulta.",
      themes: ["trabajo", "comunidad"],
      segmentIds: [3, 4, 5],
    },
  ],
  leitmotifs: ["la mesa compartida"],
  analysisNotes: "La frase de la abuela se repite: tratarla como leitmotiv.",
});

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = seedProseProject(handle, PASS_A);
});

afterEach(() => setAiFactoryForTests());

describe("outline proposal (propose_outline job)", () => {
  it("produces an editable proposed outline from raw material", async () => {
    const fake = new FakeAiClient(() => "```json\n" + OUTLINE_JSON + "\n```");
    setAiFactoryForTests(() => fake);
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 5,
      type: "propose_outline",
    });
    expect(job.status).toBe("succeeded");
    const outline = getOutline(handle.db, projectId);
    expect(outline?.status).toBe("proposed");
    const data = parseOutlineData(outline);
    expect(data.chapters).toHaveLength(2);
    expect(data.chapters[0].id).toBeTruthy();
    expect(data.chapters[0].segmentIds).toEqual([0, 1, 2]);
    expect(data.leitmotifs).toEqual(["la mesa compartida"]);
    // The analysis is recorded in the change log.
    expect(
      listChanges(handle.db, projectId, 50).some((c) =>
        c.what.includes("AI proposed an outline"),
      ),
    ).toBe(true);
    // The call carried the contract and style profile, not just the prompt.
    expect(fake.requests[0].system.contract?.mode).toBe("prose");
    expect(fake.requests[0].system.styleProfile?.tone).toBe("cálido y directo");
  });

  it("refuses outside editorial prose mode", async () => {
    handle.sqlite
      .prepare("UPDATE editorial_contracts SET mode = 'verbatim' WHERE project_id = ?")
      .run(projectId);
    setAiFactoryForTests(() => new FakeAiClient(() => OUTLINE_JSON));
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 5,
      type: "propose_outline",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/prose mode/);
  });

  it("condenses oversized material with fast-role calls before analyzing", async () => {
    const fake = new FakeAiClient((req) =>
      req.role === "fast" ? "#0: resumen del segmento" : OUTLINE_JSON,
    );
    const segments = segmentText(PASS_A);
    const { aiCalls } = await proposeOutline(
      fake,
      {
        projectId,
        jobId: "j1",
        bookTitle: "Libro",
        segments,
        contract: { projectId, mode: "prose", rules: "", notes: "", signedAt: null },
        styleProfile: {
          projectId,
          tone: "cálido",
          register: "",
          person: "",
          notes: "",
          data: "{}",
          updatedAt: "",
        },
      },
      { analysisInputBudget: 20 }, // force chunked summarization
    );
    const fastCalls = fake.requests.filter((r) => r.role === "fast");
    const largeCalls = fake.requests.filter((r) => r.role === "large");
    expect(fastCalls.length).toBeGreaterThan(1);
    expect(largeCalls).toHaveLength(1);
    expect(aiCalls).toBe(fake.requests.length);
    // Every chunked call re-injects the system context.
    for (const r of fake.requests) {
      expect(r.system.contract).toBeDefined();
      expect(r.system.styleProfile).toBeDefined();
    }
    expect(largeCalls[0].messages[0].content).toContain("resumen del segmento");
  });
});

describe("outline editing (the interactive TOC)", () => {
  beforeEach(async () => {
    setAiFactoryForTests(() => new FakeAiClient(() => OUTLINE_JSON));
    await enqueueAndRun(handle, { projectId, stage: 5, type: "propose_outline" });
  });

  it("reorder and rename are saved and change-logged", () => {
    const data = parseOutlineData(getOutline(handle.db, projectId));
    const reordered = [
      { ...data.chapters[1], title: "La mesa, primero" },
      data.chapters[0],
    ];
    saveOutlineEdit(
      handle.db,
      projectId,
      reordered,
      'Moved chapter "La mesa compartida" to position 1; renamed it',
    );
    const after = parseOutlineData(getOutline(handle.db, projectId));
    expect(after.chapters.map((c) => c.title)).toEqual([
      "La mesa, primero",
      "El patio y el limonero",
    ]);
    // Leitmotifs and notes survive chapter edits.
    expect(after.leitmotifs).toEqual(["la mesa compartida"]);
    expect(
      listChanges(handle.db, projectId, 10).some((c) =>
        c.what.includes("Moved chapter"),
      ),
    ).toBe(true);
  });

  it("confirming locks the outline and is change-logged", () => {
    confirmOutline(handle.db, projectId);
    expect(getOutline(handle.db, projectId)?.status).toBe("confirmed");
    expect(
      listChanges(handle.db, projectId, 10).some((c) =>
        c.what.includes("Outline confirmed"),
      ),
    ).toBe(true);
  });

  it("editing a confirmed outline reopens it as proposed", () => {
    confirmOutline(handle.db, projectId);
    const data = parseOutlineData(getOutline(handle.db, projectId));
    saveOutlineEdit(handle.db, projectId, data.chapters, "Renamed a chapter");
    expect(getOutline(handle.db, projectId)?.status).toBe("proposed");
  });
});
