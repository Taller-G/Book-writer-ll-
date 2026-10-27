import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { setAiFactoryForTests } from "@/lib/jobs/executors";
import { enqueueAndRun } from "@/lib/jobs/runner";
import type { OutlineData } from "@/lib/master/chapters";
import { generateMasterText } from "@/lib/master/generate";
import { segmentText } from "@/lib/master/segments";
import { listChanges } from "@/lib/repo/changeLog";
import {
  approveStyleSample,
  getStyleSample,
  saveStyleSample,
} from "@/lib/repo/editorial";
import { ensureRules } from "@/lib/repo/normalization";
import { confirmOutline, saveProposedOutline } from "@/lib/repo/outline";
import { latestText } from "@/lib/repo/texts";
import {
  FakeAiClient,
  PASS_A,
  seedProseProject,
  testContract,
  testStyleProfile,
} from "./helpers/fakeAi";

const OUTLINE: OutlineData = {
  chapters: [
    {
      id: "ch1",
      title: "El patio y el limonero",
      part: "",
      summary: "La infancia en la casa familiar.",
      themes: ["infancia"],
      segmentIds: [0, 1, 2],
    },
    {
      id: "ch2",
      title: "La mesa compartida",
      part: "",
      summary: "Lo aprendido vuelve en la vida adulta.",
      themes: ["comunidad"],
      segmentIds: [3, 4, 5],
    },
  ],
  leitmotifs: ["la mesa compartida"],
  analysisNotes: "",
};

// Prose with issues normalization must fix: straight quotes, hyphen dialogue,
// three-dot ellipsis.
const CHAPTER_PROSE =
  'La abuela decía "lo importante es la mesa compartida".\n\n' +
  "- Volvé temprano... - pedía desde la puerta.";

let handle: DbHandle;
let projectId: string;

function seedReadyProject(): void {
  saveProposedOutline(handle.db, projectId, OUTLINE);
  confirmOutline(handle.db, projectId);
  saveStyleSample(handle.db, projectId, "Así suena el libro: cálido y directo.");
  approveStyleSample(handle.db, projectId);
}

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = seedProseProject(handle, PASS_A);
});

afterEach(() => setAiFactoryForTests());

describe("generate_master_text job", () => {
  it("refuses without a confirmed outline or approved sample", async () => {
    setAiFactoryForTests(() => new FakeAiClient(() => CHAPTER_PROSE));
    let job = await enqueueAndRun(handle, {
      projectId,
      stage: 5,
      type: "generate_master_text",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/outline must be confirmed/);

    saveProposedOutline(handle.db, projectId, OUTLINE);
    confirmOutline(handle.db, projectId);
    job = await enqueueAndRun(handle, {
      projectId,
      stage: 5,
      type: "generate_master_text",
    });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/approve a style sample/);
  });

  it("generates per-chapter, normalizes, passes the quote check and logs it all", async () => {
    seedReadyProject();
    const fake = new FakeAiClient(() => CHAPTER_PROSE);
    setAiFactoryForTests(() => fake);
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 5,
      type: "generate_master_text",
    });
    expect(job.status).toBe("succeeded");

    // One call per chapter; each re-injects contract, style and book state.
    expect(fake.requests).toHaveLength(2);
    for (const r of fake.requests) {
      expect(r.role).toBe("large");
      expect(r.system.contract?.mode).toBe("prose");
      expect(r.system.styleProfile?.tone).toBe("cálido y directo");
      expect(r.messages[0].content).toContain("Book state");
      expect(r.messages[0].content).toContain("Así suena el libro");
    }
    // The second chapter sees the first as written, with its tail to
    // transition from — never implicit model memory.
    expect(fake.requests[1].messages[0].content).toContain("already written");
    expect(fake.requests[1].messages[0].content).toContain(
      "End of the previous chapter",
    );

    const passB = latestText(handle.db, projectId, "passB")!;
    expect(passB.content).toContain("## El patio y el limonero");
    expect(passB.content).toContain("## La mesa compartida");
    // Normalization applied: «angular» quotes, em-dash dialogue, ellipsis.
    expect(passB.content).toContain("«lo importante es la mesa compartida»");
    expect(passB.content).toContain("—Volvé temprano…");
    expect(passB.content).not.toContain('"');

    const output = JSON.parse(job.output!);
    expect(output.quoteBalance.ok).toBe(true);
    expect(output.chapters).toBe(2);

    const changes = listChanges(handle.db, projectId, 100);
    expect(changes.some((c) => c.what.includes('Chapter "El patio y el limonero" written'))).toBe(true);
    expect(changes.some((c) => c.what.includes("Normalization"))).toBe(true);
    expect(changes.some((c) => c.what.includes("quote-balance check passed"))).toBe(true);
  });

  it("disabled mechanical rules are not applied", async () => {
    seedReadyProject();
    const rules = ensureRules(handle.db, projectId);
    expect(rules.length).toBeGreaterThan(0);
    handle.sqlite
      .prepare(
        "UPDATE normalization_rules SET enabled = 0 WHERE project_id = ? AND rule_key = 'angular-quotes'",
      )
      .run(projectId);
    setAiFactoryForTests(() => new FakeAiClient(() => CHAPTER_PROSE));
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 5,
      type: "generate_master_text",
    });
    expect(job.status).toBe("succeeded");
    const passB = latestText(handle.db, projectId, "passB")!;
    expect(passB.content).toContain('"lo importante');
    // And the quote check correctly reports the leftover straight quotes.
    expect(JSON.parse(job.output!).quoteBalance.ok).toBe(false);
  });

  it("the user validates the result against the pre-approved sample", async () => {
    seedReadyProject();
    setAiFactoryForTests(() => new FakeAiClient(() => CHAPTER_PROSE));
    await enqueueAndRun(handle, { projectId, stage: 5, type: "generate_master_text" });
    const { validateAgainstSample } = await import("@/lib/repo/editorial");
    validateAgainstSample(handle.db, projectId);
    expect(getStyleSample(handle.db, projectId)?.validatedAt).toBeTruthy();
    expect(
      listChanges(handle.db, projectId, 20).some((c) =>
        c.what.includes("validated against the approved style sample"),
      ),
    ).toBe(true);
  });
});

describe("books larger than one context window", () => {
  it("splits chapters into sequential calls, re-injecting style and book state every time", async () => {
    const fake = new FakeAiClient((_, i) => `Parte generada ${i}.`);
    const segments = segmentText(PASS_A);
    const { chapters, aiCalls } = await generateMasterText(
      fake,
      {
        projectId,
        jobId: "j1",
        bookTitle: "Libro largo",
        contract: testContract(projectId),
        styleProfile: testStyleProfile(projectId),
        outline: OUTLINE,
        segments,
        promptRules: [],
        approvedSample: "Muestra aprobada.",
      },
      { chapterInputBudget: 20 }, // tiny budget → every chapter needs several calls
    );
    expect(aiCalls).toBeGreaterThan(2);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].calls).toBeGreaterThan(1);
    // Chapter text concatenates all its parts.
    expect(chapters[0].text.split("\n\n").length).toBe(chapters[0].calls);
    for (const [i, r] of fake.requests.entries()) {
      // EVERY chunked call re-injects the style profile and the book state —
      // nothing relies on implicit memory between calls.
      expect(r.system.styleProfile?.tone).toBe("cálido y directo");
      expect(r.messages[0].content).toContain('Book state — "Libro largo"');
      expect(r.messages[0].content).toContain("Muestra aprobada.");
      if (i > 0) {
        // Continuation calls carry the running tail of the text so far.
        expect(r.messages[0].content).toMatch(
          /End of the previous chapter|part \d+/,
        );
      }
    }
  });
});
