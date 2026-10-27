# architecture

How the system is put together — layers, boundaries, and how data flows.

## 8-stage pipeline definition is the single source of stage identity

What: The 8 stages (1 Sources, 2 Editorial contract, 3 Style profile, 4 Cleanup pass A, 5 Refine pass B, 6 Review, 7 Format, 8 Export) live in one module with stable 1-based numbers, slugs and the job type each stage runs · Why: every table (jobs.stage, stage_progress.stage, checklist) and every other work order references stage numbers — they must never be renumbered · Where: src/lib/stages.ts

## Data access via repo functions taking Db as first argument

What: All reads/writes go through src/lib/repo/* functions that take the Drizzle Db (or DbHandle when a transaction is needed) as first parameter · Why: tests run against openDatabase(':memory:') with zero mocking, and server actions share the same code path via getDb() · Where: src/lib/repo/

## Stage jobs: versioned input/output, atomic success commit, retry = new row

What: Every stage execution is a jobs row — input snapshot + input_version written at start, output + output_version committed in the SAME sqlite transaction as status='succeeded'; a retry is a NEW row linked by retry_of with attempt+1; on boot, orphaned queued/running jobs are marked failed-retryable · Why: a job that fails can never leave partial output (retry cannot corrupt state), and attempt history is preserved for the audit trail · Where: src/lib/repo/jobs.ts · Learned: commit output atomically with the success status, never before

## Source files: immutable originals under original/, all outputs under derived/

What: File-backed sources live at data/sources/{projectId}/{sourceId}/ with the upload stored once in original/ (temp-write + rename, then chmod 444) and every transformation written via writeDerived() into derived/ — extracted text, extracted audio, anything future · Why: the spec's trust model requires originals to be verifiably untouchable; the stored SHA-1 (sources.checksum_sha1) must match a recomputation at any later time · Where: src/lib/files/store.ts, src/lib/ingest/ingest.ts · Learned: keep a single write-path function for derived artifacts so immutability is enforced by construction, not by review

## Ingestion rolls back completely on any per-file failure

What: ingestFile() validates (extension + magic bytes), checksums, stores the original, extracts, then inserts the source row in one sqlite transaction; any error deletes the source's whole file tree and leaves no DB row · Why: acceptance requires a corrupt upload to leave zero partial state — files on disk without a row (or vice versa) would be orphans · Where: src/lib/ingest/ingest.ts

## Audio↔transcript links are symmetric via sources.linked_source_id

What: After each ingest, an unlinked counterpart with the same normalized filename stem on the opposite side (audio/video vs document/text) is linked both ways in linked_source_id, and the text side's kind is promoted to 'transcript'; manual link/unlink server actions cover non-matching names · Why: enables later clip resolution between a talk's recording and its transcript · Where: src/lib/repo/sources.ts (findLinkCandidate, linkSources), src/lib/actions/content.ts

## AI calls go through the AiClient seam, never a provider directly

What: All AI-dependent slices call createAiClient(db).complete(request) where the request carries a SystemContext payload (task instructions + editorial contract + style profile) and a model role ('large' for writing/restructuring, 'fast' for mass classification); OpenRouter is the only implementation today and a direct Anthropic provider slots in behind the same interface · Why: spec §9 makes this the seam between the BYOK engine and every other work order — provider swaps must not touch stage code · Where: src/lib/ai/index.ts, src/lib/ai/types.ts

## Style profile lifecycle: draft vs confirmed, versioned on confirm

What: style_profiles has status ('draft'|'confirmed') and version — extraction (extract_style job) saves a DRAFT that shapes nothing; confirmStyleProfile() sets status='confirmed' and bumps version only when confirmed_at already existed (first confirm is v1); the stage-3 gate requires a confirmed profile · Why: the spec requires the user to review/adjust the extracted profile before it is applied to everything, and the version bump is what marks downstream texts as written under an older voice · Where: src/lib/repo/editorial.ts, src/lib/gates.ts

## Every AI call auto-injects contract + confirmed profile, logged verbatim

What: createAiClient() wraps the provider in ProjectContextClient, which on every complete() loads the editorial contract and the CONFIRMED style profile (with its few-shot excerpts) from the DB by request.projectId and fills any missing SystemContext fields; `system.bare` opts out (used only by profile extraction); the exact rendered system prompt is stored per call in ai_usage.system_prompt · Why: voice consistency must be structural, never dependent on callers or conversation memory — a project reopened weeks later injects the identical profile because it is read from disk per call, and the call log makes that verifiable · Where: src/lib/ai/index.ts (ProjectContextClient), src/lib/ai/types.ts (buildSystemPrompt), src/lib/repo/aiUsage.ts · Learned: make cross-cutting invariants hold at the seam (client factory), not at each call site

## Stage texts are stamped with the profile version that produced them

What: insertText() automatically stamps stage_texts.style_profile_version with the current confirmed profile version (NULL when none); textsUnderOldProfile() returns the latest passA/passB/final texts whose stamp differs from the current version, feeding the regenerate/keep panel on Stage 3 · Why: a mid-project profile change must list exactly which texts carry the previous voice; regenerating re-runs the producing job (new stamped text), keeping stamps the existing row via stampTextProfileVersion() plus an audit entry · Where: src/lib/repo/texts.ts, src/components/stages/ProfileChangePanel.tsx, src/lib/actions/content.ts (keepTextProfileAction)
