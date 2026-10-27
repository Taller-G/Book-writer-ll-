import { eq, sum } from "drizzle-orm";
import type { ModelRole } from "../ai/config";
import type { Db } from "../db/client";
import { aiUsage } from "../db/schema";
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
