# architecture

How the system is put together — layers, boundaries, and how data flows.

## 8-stage pipeline definition is the single source of stage identity

What: The 8 stages (1 Sources, 2 Editorial contract, 3 Style profile, 4 Cleanup pass A, 5 Refine pass B, 6 Review, 7 Format, 8 Export) live in one module with stable 1-based numbers, slugs and the job type each stage runs · Why: every table (jobs.stage, stage_progress.stage, checklist) and every other work order references stage numbers — they must never be renumbered · Where: src/lib/stages.ts

## Data access via repo functions taking Db as first argument

What: All reads/writes go through src/lib/repo/* functions that take the Drizzle Db (or DbHandle when a transaction is needed) as first parameter · Why: tests run against openDatabase(':memory:') with zero mocking, and server actions share the same code path via getDb() · Where: src/lib/repo/

## Stage jobs: versioned input/output, atomic success commit, retry = new row

What: Every stage execution is a jobs row — input snapshot + input_version written at start, output + output_version committed in the SAME sqlite transaction as status='succeeded'; a retry is a NEW row linked by retry_of with attempt+1; on boot, orphaned queued/running jobs are marked failed-retryable · Why: a job that fails can never leave partial output (retry cannot corrupt state), and attempt history is preserved for the audit trail · Where: src/lib/repo/jobs.ts · Learned: commit output atomically with the success status, never before
