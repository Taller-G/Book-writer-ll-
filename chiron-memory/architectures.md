# architecture

How the system is put together — layers, boundaries, and how data flows.

## 8-stage pipeline definition is the single source of stage identity

What: The 8 stages (1 Sources, 2 Editorial contract, 3 Style profile, 4 Cleanup pass A, 5 Refine pass B, 6 Review, 7 Format, 8 Export) live in one module with stable 1-based numbers, slugs and the job type each stage runs · Why: every table (jobs.stage, stage_progress.stage, checklist) and every other work order references stage numbers — they must never be renumbered · Where: src/lib/stages.ts

## Data access via repo functions taking Db as first argument

What: All reads/writes go through src/lib/repo/* functions that take the Drizzle Db (or DbHandle when a transaction is needed) as first parameter · Why: tests run against openDatabase(':memory:') with zero mocking, and server actions share the same code path via getDb() · Where: src/lib/repo/

## Stage jobs: versioned input/output, atomic success commit, retry = new row

What: Every stage execution is a jobs row — input snapshot + input_version written at start, output + output_version committed in the SAME sqlite transaction as status='succeeded'; a retry is a NEW row linked by retry_of with attempt+1; on boot, orphaned queued/running jobs are marked failed-retryable · Why: a job that fails can never leave partial output (retry cannot corrupt state), and attempt history is preserved for the audit trail · Where: src/lib/repo/jobs.ts · Learned: commit output atomically with the success status, never before

## AI calls go through the AiClient seam, never a provider directly

What: All AI-dependent slices call createAiClient(db).complete(request) where the request carries a SystemContext payload (task instructions + editorial contract + style profile) and a model role ('large' for writing/restructuring, 'fast' for mass classification); OpenRouter is the only implementation today and a direct Anthropic provider slots in behind the same interface · Why: spec §9 makes this the seam between the BYOK engine and every other work order — provider swaps must not touch stage code · Where: src/lib/ai/index.ts, src/lib/ai/types.ts
