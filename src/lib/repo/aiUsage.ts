import { and, eq, sql, sum } from "drizzle-orm";
import type { ModelRole } from "../ai/config";
import type { Db } from "../db/client";
import { aiUsage, jobs } from "../db/schema";
import { getStage } from "../stages";
import { newId, now } from "../util";

// Per-call AI spend, sourced from OpenRouter's usage accounting (usage.cost
// on every completion). The project's cumulative spend counter is the sum of
// these rows — never an estimate.

export interface AiUsageInput {
  projectId: string;
  jobId?: string;
  role: ModelRole;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Exact system prompt sent with the call, so injection is verifiable. */
  systemPrompt: string;
}

export function recordAiUsage(db: Db, input: AiUsageInput): void {
  db.insert(aiUsage)
    .values({ id: newId(), createdAt: now(), ...input })
    .run();
}

/** Cumulative AI spend (USD) for one project. */
export function getProjectSpend(db: Db, projectId: string): number {
  const row = db
    .select({ total: sum(aiUsage.costUsd) })
    .from(aiUsage)
    .where(eq(aiUsage.projectId, projectId))
    .get();
  return row?.total ? Number(row.total) : 0;
}

export function listAiUsage(db: Db, projectId: string) {
  return db.select().from(aiUsage).where(eq(aiUsage.projectId, projectId)).all();
}

export const UNASSIGNED_STAGE_TITLE = "Not tied to a stage";

export interface SpendTotals {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
}

export interface StageSpendRow extends SpendTotals {
  /** Pipeline stage, or null when the call has no job (or its job is gone). */
  stage: number | null;
  title: string;
}

export interface ModelSpendRow extends SpendTotals {
  model: string;
  role: ModelRole;
}

export interface ProjectSpendBreakdown {
  total: number;
  byStage: StageSpendRow[];
  byModel: ModelSpendRow[];
}

const totals = {
  costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)`,
  promptTokens: sql<number>`coalesce(sum(${aiUsage.promptTokens}), 0)`,
  completionTokens: sql<number>`coalesce(sum(${aiUsage.completionTokens}), 0)`,
};

/**
 * Where a project's AI spend went: per pipeline stage (through each call's
 * job) and per model. Read-only over recorded ai_usage rows; each list sums
 * to getProjectSpend. Calls without a job — or whose job is missing or
 * belongs to another project — land in one "Not tied to a stage" row and are
 * never guessed into a stage.
 */
export function getProjectSpendBreakdown(
  db: Db,
  projectId: string,
): ProjectSpendBreakdown {
  const stageRows = db
    .select({ stage: jobs.stage, ...totals })
    .from(aiUsage)
    .leftJoin(
      jobs,
      and(eq(jobs.id, aiUsage.jobId), eq(jobs.projectId, aiUsage.projectId)),
    )
    .where(eq(aiUsage.projectId, projectId))
    .groupBy(jobs.stage)
    .all();

  const byStage: StageSpendRow[] = stageRows
    .map((r) => ({
      stage: r.stage ?? null,
      title:
        r.stage == null
          ? UNASSIGNED_STAGE_TITLE
          : (getStage(r.stage)?.title ?? `Stage ${r.stage}`),
      costUsd: Number(r.costUsd),
      promptTokens: Number(r.promptTokens),
      completionTokens: Number(r.completionTokens),
    }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        (a.stage ?? Number.MAX_SAFE_INTEGER) -
          (b.stage ?? Number.MAX_SAFE_INTEGER),
    );

  const modelRows = db
    .select({ model: aiUsage.model, role: aiUsage.role, ...totals })
    .from(aiUsage)
    .where(eq(aiUsage.projectId, projectId))
    .groupBy(aiUsage.model, aiUsage.role)
    .all();

  const byModel: ModelSpendRow[] = modelRows
    .map((r) => ({
      model: r.model,
      role: r.role,
      costUsd: Number(r.costUsd),
      promptTokens: Number(r.promptTokens),
      completionTokens: Number(r.completionTokens),
    }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        a.model.localeCompare(b.model) ||
        a.role.localeCompare(b.role),
    );

  return { total: getProjectSpend(db, projectId), byStage, byModel };
}
