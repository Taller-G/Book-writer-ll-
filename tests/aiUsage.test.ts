import { describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { getProjectSpend, listAiUsage, recordAiUsage } from "@/lib/repo/aiUsage";
import { createProject } from "@/lib/repo/projects";

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
