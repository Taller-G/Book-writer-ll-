import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import {
  applyPassB,
  extractWords,
  sameWordSequence,
} from "@/lib/format/passB";
import { enqueueAndRun } from "@/lib/jobs/runner";
import { saveContract } from "@/lib/repo/editorial";
import { createProject } from "@/lib/repo/projects";
import { addReaction } from "@/lib/repo/reactions";
import { listReviewItems } from "@/lib/repo/review";
import { insertText, latestText } from "@/lib/repo/texts";

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Pass B" }).id;
  saveContract(handle.db, { projectId, mode: "verbatim", rules: "", notes: "" });
});

const SPOKEN = [
  "Yo empecé en un garaje pequeño. Trabajábamos de noche sin parar.",
  "Pero todo cambió cuando llegó el primer cliente. Entonces entendí que esto era de verdad.",
  "¿Y acaso no era eso lo que todos soñábamos? Claro que sí, seguimos adelante.",
  "— ¿Cómo fue ese primer día?",
  "¿Cuándo supiste que ibas a triunfar?",
].join("\n\n");

describe("Pass B (stage 3.5) — faithful structuring", () => {
  it("changes only paragraph breaks and formatting marks: the word diff is empty", () => {
    const reactions = [
      { kind: "laughter" as const, charAnchor: 70 },
      { kind: "applause" as const, charAnchor: SPOKEN.length },
    ];
    const r = applyPassB(SPOKEN, { reactions });

    // The spoken-word sequence is identical in and out.
    expect(sameWordSequence(SPOKEN, r.output)).toBe(true);
    expect(extractWords(r.output)).toEqual(extractWords(SPOKEN));

    // It really did add structure and formatting (not a no-op).
    expect(r.paragraphBreaksAdded).toBeGreaterThan(0);
    expect(r.reactionsInserted).toBe(2);
    expect(r.output).toContain("*[Laughter]*");
    expect(r.output).toContain("*[Applause]*");
    // The marked interviewer question is bold with an em dash.
    expect(r.output).toContain("**— ¿Cómo fue ese primer día?**");
  });

  it("routes an ambiguous question to the queue rather than silently formatting it", () => {
    const r = applyPassB(SPOKEN);
    // The embedded rhetorical question stays in its answer, unformatted.
    expect(r.output).toContain("¿Y acaso no era eso lo que todos soñábamos?");
    // The standalone, unmarked question is ambiguous.
    expect(r.ambiguousQuestions.map((q) => q.excerpt)).toContain(
      "¿Cuándo supiste que ibas a triunfar?",
    );
    // It is NOT bold-formatted as an interviewer question.
    expect(r.output).not.toContain("**— ¿Cuándo supiste");
  });

  it("the executor keeps the word diff empty and queues the ambiguous question with a 'question' item", async () => {
    insertText(handle.db, { projectId, stageKey: "passA", version: 1, content: SPOKEN });
    addReaction(handle.db, {
      projectId,
      kind: "applause",
      startMs: 0,
      endMs: 0,
      origin: "manual",
      status: "confirmed",
      charAnchor: SPOKEN.length,
    });

    const job = await enqueueAndRun(handle, { projectId, stage: 5, type: "refine_pass_b" });
    expect(job.status).toBe("succeeded");

    const passB = latestText(handle.db, projectId, "passB")!;
    expect(sameWordSequence(SPOKEN, passB.content)).toBe(true); // AC: word diff empty
    expect(passB.content).toContain("*[Applause]*");

    const questions = listReviewItems(handle.db, projectId).filter(
      (i) => i.itemType === "question",
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].excerpt).toContain("¿Cuándo supiste que ibas a triunfar?");
    expect(questions[0].status).toBe("pending");
  });
});
