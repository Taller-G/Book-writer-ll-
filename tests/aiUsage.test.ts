import { describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import {
  type AiUsageInput,
  getProjectSpend,
  getProjectSpendBreakdown,
  listAiUsage,
  recordAiUsage,
  UNASSIGNED_STAGE_TITLE,
} from "@/lib/repo/aiUsage";
import { createJob } from "@/lib/repo/jobs";
import { createProject } from "@/lib/repo/projects";
import { getStage } from "@/lib/stages";

describe("ai_usage spend counter", () => {
  it("accumulates per-project spend from recorded calls", () => {
    const handle = openDatabase(":memory:");
    const { db } = handle;
    const a = createProject(handle, { title: "Book A" });
    const b = createProject(handle, { title: "Book B" });

    expect(getProjectSpend(db, a.id)).toBe(0);

    recordAiUsage(db, {
      projectId: a.id,
      role: "large",
      model: "anthropic/claude-sonnet-4.6",
      promptTokens: 1000,
      completionTokens: 800,
      costUsd: 0.015,
      systemPrompt: "",
    });
    recordAiUsage(db, {
      projectId: a.id,
      jobId: "job-1",
      role: "fast",
      model: "anthropic/claude-haiku-4.5",
      promptTokens: 200,
      completionTokens: 50,
      costUsd: 0.0005,
      systemPrompt: "",
    });
    recordAiUsage(db, {
      projectId: b.id,
      role: "large",
      model: "anthropic/claude-sonnet-4.6",
      promptTokens: 100,
      completionTokens: 100,
      costUsd: 0.002,
      systemPrompt: "",
    });

    expect(getProjectSpend(db, a.id)).toBeCloseTo(0.0155, 6);
    expect(getProjectSpend(db, b.id)).toBeCloseTo(0.002, 6);
    expect(listAiUsage(db, a.id)).toHaveLength(2);
  });
});

describe("ai_usage spend breakdown", () => {
  const LARGE = "anthropic/claude-sonnet-4.6";
  const FAST = "anthropic/claude-haiku-4.5";

  function setup() {
    const handle = openDatabase(":memory:");
    const { db } = handle;
    const a = createProject(handle, { title: "Book A" });
    const b = createProject(handle, { title: "Book B" });
    const call = (
      input: Partial<AiUsageInput> & Pick<AiUsageInput, "projectId" | "costUsd">,
    ) =>
      recordAiUsage(db, {
        role: "large",
        model: LARGE,
        promptTokens: 0,
        completionTokens: 0,
        systemPrompt: "",
        ...input,
      });
    return { db, a, b, call };
  }

  const sumCost = (rows: { costUsd: number }[]) =>
    rows.reduce((s, r) => s + r.costUsd, 0);

  it("lists one row per stage with number, title, cost and tokens summing to the total", () => {
    const { db, a, call } = setup();
    const j4 = createJob(db, { projectId: a.id, stage: 4, type: "cleanup_pass_a" });
    const j5 = createJob(db, { projectId: a.id, stage: 5, type: "refine_pass_b" });
    call({ projectId: a.id, jobId: j4.id, costUsd: 0.01, promptTokens: 100, completionTokens: 50 });
    call({ projectId: a.id, jobId: j4.id, costUsd: 0.02, promptTokens: 200, completionTokens: 70 });
    call({ projectId: a.id, jobId: j5.id, costUsd: 0.05, promptTokens: 900, completionTokens: 400 });

    const { total, byStage } = getProjectSpendBreakdown(db, a.id);
    expect(total).toBeCloseTo(getProjectSpend(db, a.id), 9);
    expect(byStage).toHaveLength(2);
    expect(byStage[0]).toMatchObject({
      stage: 5,
      title: getStage(5)!.title,
      promptTokens: 900,
      completionTokens: 400,
    });
    expect(byStage[0].costUsd).toBeCloseTo(0.05, 9);
    expect(byStage[1]).toMatchObject({
      stage: 4,
      title: getStage(4)!.title,
      promptTokens: 300,
      completionTokens: 120,
    });
    expect(byStage[1].costUsd).toBeCloseTo(0.03, 9);
    expect(sumCost(byStage)).toBeCloseTo(total, 9);
  });

  it("puts calls without a job, or with a missing job, under 'Not tied to a stage'", () => {
    const { db, a, call } = setup();
    const j = createJob(db, { projectId: a.id, stage: 4, type: "cleanup_pass_a" });
    call({ projectId: a.id, jobId: j.id, costUsd: 0.01, promptTokens: 10 });
    call({ projectId: a.id, costUsd: 0.004, promptTokens: 20, completionTokens: 5 });
    call({ projectId: a.id, jobId: "gone-job", costUsd: 0.002, promptTokens: 1 });

    const { total, byStage } = getProjectSpendBreakdown(db, a.id);
    const unassigned = byStage.find((r) => r.stage === null);
    expect(unassigned).toMatchObject({
      title: UNASSIGNED_STAGE_TITLE,
      promptTokens: 21,
      completionTokens: 5,
    });
    expect(unassigned!.costUsd).toBeCloseTo(0.006, 9);
    expect(byStage.filter((r) => r.stage === null)).toHaveLength(1);
    expect(sumCost(byStage)).toBeCloseTo(total, 9);
    expect(total).toBeCloseTo(0.016, 9);
  });

  it("breaks spend down per model with its role, summing to the total", () => {
    const { db, a, call } = setup();
    call({ projectId: a.id, role: "large", model: LARGE, costUsd: 0.03, promptTokens: 1000, completionTokens: 800 });
    call({ projectId: a.id, role: "large", model: LARGE, costUsd: 0.01, promptTokens: 100, completionTokens: 100 });
    call({ projectId: a.id, role: "fast", model: FAST, costUsd: 0.0005, promptTokens: 200, completionTokens: 50 });

    const { total, byModel } = getProjectSpendBreakdown(db, a.id);
    expect(byModel).toHaveLength(2);
    expect(byModel[0]).toMatchObject({ model: LARGE, role: "large", promptTokens: 1100, completionTokens: 900 });
    expect(byModel[0].costUsd).toBeCloseTo(0.04, 9);
    expect(byModel[1]).toMatchObject({ model: FAST, role: "fast", promptTokens: 200, completionTokens: 50 });
    expect(byModel[1].costUsd).toBeCloseTo(0.0005, 9);
    expect(sumCost(byModel)).toBeCloseTo(total, 9);
  });

  it("never includes another project's spend", () => {
    const { db, a, b, call } = setup();
    const ja = createJob(db, { projectId: a.id, stage: 4, type: "cleanup_pass_a" });
    const jb = createJob(db, { projectId: b.id, stage: 6, type: "review" });
    call({ projectId: a.id, jobId: ja.id, costUsd: 0.01 });
    call({ projectId: b.id, jobId: jb.id, model: "other/model", costUsd: 0.5 });
    // A call on project A pointing at project B's job is not attributed to B's stage.
    call({ projectId: a.id, jobId: jb.id, costUsd: 0.003 });

    const { total, byStage, byModel } = getProjectSpendBreakdown(db, a.id);
    expect(byStage.map((r) => r.stage)).toEqual([4, null]);
    expect(byModel.map((r) => r.model)).toEqual([LARGE]);
    expect(total).toBeCloseTo(0.013, 9);
    expect(sumCost(byStage)).toBeCloseTo(total, 9);
    expect(sumCost(byModel)).toBeCloseTo(total, 9);
  });

  it("orders rows from costliest to cheapest", () => {
    const { db, a, call } = setup();
    const costs: [number, number][] = [[2, 0.001], [4, 0.05], [5, 0.02], [7, 0.3]];
    for (const [stage, cost] of costs) {
      const j = createJob(db, { projectId: a.id, stage, type: "t" });
      call({ projectId: a.id, jobId: j.id, model: `m/${stage}`, costUsd: cost });
    }
    call({ projectId: a.id, model: "m/none", costUsd: 0.01 });

    const { byStage, byModel } = getProjectSpendBreakdown(db, a.id);
    expect(byStage.map((r) => r.stage)).toEqual([7, 4, 5, null, 2]);
    expect(byModel.map((r) => r.model)).toEqual(["m/7", "m/4", "m/5", "m/none", "m/2"]);
  });

  it("is empty for a project with no AI calls", () => {
    const { db, a } = setup();
    expect(getProjectSpendBreakdown(db, a.id)).toEqual({
      total: 0,
      byStage: [],
      byModel: [],
    });
  });
});
