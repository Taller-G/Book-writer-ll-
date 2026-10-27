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

## Render pipeline lives in src/lib/render/, executor stays thin

What: The Stage 7 layout engine is four modules in src/lib/render/ — compose.ts (approved text → memoir/XeLaTeX + word-for-word verification), compile.ts (double xelatex pass + aux-cleanup recovery), qa.ts (poppler-based post-render checks), report.ts (versioned JSON+markdown QA report) — orchestrated by render.ts; the render_pdf executor only reads inputs and commits DB rows · Why: mirrors the ingest convention (pipeline modules out of the executor) and keeps filesystem/subprocess work out of the jobs layer · Where: src/lib/render/, src/lib/jobs/executors.ts
