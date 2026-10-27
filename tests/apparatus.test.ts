import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { setAiFactoryForTests } from "@/lib/jobs/executors";
import { enqueueAndRun } from "@/lib/jobs/runner";
import type { OutlineData } from "@/lib/master/chapters";
import { listApparatus, setApparatusStatus } from "@/lib/repo/apparatus";
import { listChanges } from "@/lib/repo/changeLog";
import {
  approveStyleSample,
  saveStyleSample,
} from "@/lib/repo/editorial";
import { confirmOutline, saveProposedOutline } from "@/lib/repo/outline";
import { latestText } from "@/lib/repo/texts";
import { FakeAiClient, PASS_A, seedProseProject } from "./helpers/fakeAi";

const OUTLINE: OutlineData = {
  chapters: [
    {
      id: "ch1",
      title: "Capítulo único",
      part: "",
      summary: "Todo el material.",
      themes: [],
      segmentIds: [0, 1, 2, 3, 4, 5],
    },
  ],
  leitmotifs: [],
  analysisNotes: "",
};

const APPARATUS_JSON = JSON.stringify({
  sections: [
    { key: "prologo", title: "Prólogo", content: "Texto del prólogo." },
    { key: "glosario", title: "Glosario", content: "limonero: árbol de limones." },
    { key: "agradecimientos", title: "Agradecimientos", content: "Gracias a todos." },
    { key: "invented-section", title: "Inventada", content: "No está en el catálogo." },
  ],
});

let handle: DbHandle;
let projectId: string;

beforeEach(async () => {
  handle = openDatabase(":memory:");
  projectId = seedProseProject(handle, PASS_A);
  saveProposedOutline(handle.db, projectId, OUTLINE);
  confirmOutline(handle.db, projectId);
  saveStyleSample(handle.db, projectId, "Muestra.");
  approveStyleSample(handle.db, projectId);
  setAiFactoryForTests(
    () =>
      new FakeAiClient((req) =>
        req.messages[0].content.includes("Table of contents")
          ? APPARATUS_JSON
          : "Prosa del capítulo, sin citas.",
      ),
  );
  await enqueueAndRun(handle, { projectId, stage: 5, type: "generate_master_text" });
});

afterEach(() => setAiFactoryForTests());

describe("editorial apparatus (§6)", () => {
  it("proposes sections, each carrying its plain-language explanation", async () => {
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 5,
      type: "propose_apparatus",
    });
    expect(job.status).toBe("succeeded");
    const sections = listApparatus(handle.db, projectId);
    // The invented key was filtered out; valid ones are stored as proposed.
    expect(sections.map((s) => s.sectionKey).sort()).toEqual([
      "agradecimientos",
      "glosario",
      "prologo",
    ]);
    for (const s of sections) {
      expect(s.status).toBe("proposed");
      expect(s.explanation.length).toBeGreaterThan(20);
    }
    // Placement comes from the catalog, not the model.
    expect(sections.find((s) => s.sectionKey === "prologo")?.placement).toBe("front");
    expect(sections.find((s) => s.sectionKey === "glosario")?.placement).toBe("back");
    expect(
      listChanges(handle.db, projectId, 50).filter((c) =>
        c.what.includes("proposed ("),
      ),
    ).toHaveLength(3);
  });

  it("accept (with edits) and discard are individual and change-logged; finalize assembles only accepted", async () => {
    await enqueueAndRun(handle, { projectId, stage: 5, type: "propose_apparatus" });
    setApparatusStatus(
      handle.db,
      projectId,
      "prologo",
      "accepted",
      "Texto del prólogo, retocado por el autor.",
    );
    setApparatusStatus(handle.db, projectId, "glosario", "discarded");
    setApparatusStatus(handle.db, projectId, "agradecimientos", "accepted");

    const changes = listChanges(handle.db, projectId, 50);
    expect(changes.some((c) => c.what.includes('"Prólogo" accepted with edits'))).toBe(true);
    expect(changes.some((c) => c.what.includes('"Glosario" discarded'))).toBe(true);

    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 6,
      type: "finalize_text",
    });
    expect(job.status).toBe("succeeded");
    const final = latestText(handle.db, projectId, "final")!;
    expect(final.content).toContain("## Prólogo");
    expect(final.content).toContain("retocado por el autor");
    expect(final.content).toContain("## Agradecimientos");
    expect(final.content).not.toContain("Glosario");
    // Front matter before the text, back matter after.
    expect(final.content.indexOf("## Prólogo")).toBeLessThan(
      final.content.indexOf("## Capítulo único"),
    );
    expect(final.content.indexOf("## Agradecimientos")).toBeGreaterThan(
      final.content.indexOf("## Capítulo único"),
    );
  });

  it("discarding every section still finalizes the bare book", async () => {
    await enqueueAndRun(handle, { projectId, stage: 5, type: "propose_apparatus" });
    for (const key of ["prologo", "glosario", "agradecimientos"]) {
      setApparatusStatus(handle.db, projectId, key, "discarded");
    }
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 6,
      type: "finalize_text",
    });
    expect(job.status).toBe("succeeded");
    const final = latestText(handle.db, projectId, "final")!;
    expect(final.content).toContain("## Capítulo único");
    expect(final.content).not.toContain("Prólogo");
  });

  it("re-proposing leaves already-decided sections untouched", async () => {
    await enqueueAndRun(handle, { projectId, stage: 5, type: "propose_apparatus" });
    setApparatusStatus(handle.db, projectId, "prologo", "accepted", "Mi prólogo.");
    await enqueueAndRun(handle, { projectId, stage: 5, type: "propose_apparatus" });
    const prologo = listApparatus(handle.db, projectId).find(
      (s) => s.sectionKey === "prologo",
    )!;
    expect(prologo.status).toBe("accepted");
    expect(prologo.content).toBe("Mi prólogo.");
  });
});
