# decision

A choice made and the reasoning behind it — the path taken over the alternatives.

## Stack: Next.js 15 + SQLite (better-sqlite3 + Drizzle)

What: The app is Next.js 15 (App Router, TS) with a single local SQLite file (better-sqlite3 driver, Drizzle for typed queries); no external services · Why: single-user desktop-style product — one full-stack framework plus an embedded DB gives persistence across sessions with zero infra; alternatives (Express+Vite split, Postgres) add moving parts with no benefit at this scale · Where: src/lib/db/client.ts

## Change log append-only via SQLite triggers, no FK cascade

What: change_log has BEFORE UPDATE/DELETE triggers that RAISE(ABORT); it deliberately has NO foreign key to projects, and the delete trigger allows purging only when the owning project row is already gone · Why: a cascade from project deletion would collide with the append-only triggers (undeletable projects); enforcing at the DB layer means even code that bypasses the repo cannot mutate history · Where: src/lib/db/bootstrap.ts · Learned: when a table must be immutable AND its parent deletable, drop the FK and gate the delete trigger on parent existence

## Schema as idempotent DDL in bootstrap.ts, not drizzle-kit migrations

What: Tables/triggers are created by raw CREATE ... IF NOT EXISTS DDL run on every connection open; src/lib/db/schema.ts is a typed Drizzle mirror kept in sync by hand · Why: triggers and CHECK constraints are first-class in raw DDL, and an empty-to-v1 project doesn't need migration tooling; future schema changes must stay additive · Where: src/lib/db/bootstrap.ts

## Model roles come from remote config, not user settings

What: The 'large' and 'fast' model roles resolve from a remote JSON at BOOK_WRITER_MODEL_CONFIG_URL (5-min TTL cache, last-good kept on fetch failure) with bundled Claude-variant defaults when unset; the user never picks a model · Why: spec §9 requires models preconfigured by the app and updatable without user involvement; an env-pointed JSON lets the operator change roles with zero user-facing change · Where: src/lib/ai/config.ts

## Real AI spend from OpenRouter usage.cost; config pricing only for estimates

What: Every completed call records OpenRouter's usage.cost into ai_usage (the project spend counter is SUM(cost_usd)); the pricing numbers inside the model config feed only the pre-run cost estimate · Why: OpenRouter already meters the exact charge per call — estimating spend locally would drift from the real bill · Where: src/lib/repo/aiUsage.ts, src/lib/ai/openrouter.ts · Learned: when the provider reports actual cost, never substitute your own arithmetic for the ledger

## Uploads keep the fixed sources.kind enum; real file type lives in media_type

What: Uploaded files map onto the existing kind CHECK constraint (audio/video → 'audio', documents/text/images → 'document', promoted to 'transcript' when linked) while a new nullable media_type column records the true type (audio|video|document|image|text) · Why: the kind CHECK is baked into existing databases and cannot be widened additively; extracted text still lands in sources.content so the ingest_sources executor and all downstream stages work unchanged · Where: src/lib/db/schema.ts, src/lib/ingest/ingest.ts

## Uploads go through a route handler, not a server action

What: Stage-1 file uploads POST multipart FormData to /api/projects/[id]/sources instead of a 'use server' action · Why: server actions have a ~1 MB default body limit that audio/video uploads exceed, and a route handler can return per-file success/error JSON for the dropzone · Where: src/app/api/projects/[id]/sources/route.ts, src/components/SourceDropzone.tsx

## Video ingests fully even without ffmpeg; audio extraction is best-effort

What: Video uploads always store the original with checksum and duration; the audio track is extracted to derived/audio.m4a only when system ffmpeg exists, otherwise the source carries a visible note explaining it · Why: ffmpeg is a system dependency that may be absent — blocking the upload would lose the user's material, and the derived extraction can be redone later · Where: src/lib/ingest/ingest.ts (extractVideoAudio)

## Spec stage 4 (master text) lives in pipeline stage 5, prose mode only

What: The editorial-prose master-text flow (outline → sample → chunked generation → apparatus) replaces Stage 5's UI and jobs only when the contract mode is 'prose'; verbatim/hybrid keep the deterministic refine_pass_b. Its job types (propose_outline, generate_style_sample, generate_master_text, propose_apparatus) all run on stage number 5 and the generation writes passB · Why: the spec's stage numbering differs from the repo's 8 stages — repo stage 5 is the one that consumes the cleaned passA and produces the passB that review/format/export already consume, so the master text slots into the existing seam without renumbering · Where: src/app/projects/[id]/stages/[stage]/page.tsx (mode dispatch), src/lib/jobs/executors.ts · Learned: one pipeline stage can host several job types; use latestJobOfType (repo/jobs.ts), not latestJobForStage, to show each job's status independently

## Apparatus assembled at finalize, never baked into passB

What: Accepted apparatus sections are stored as rows and wrapped around the text (front + passB + back) by the finalize_text executor; proposed/discarded sections are simply excluded, and re-proposing never touches sections the user already decided · Why: baking apparatus into passB would make the text stale the moment the user discards a section; assembling at freeze time makes "discard without breaking the book" structural · Where: src/lib/repo/apparatus.ts, src/lib/jobs/executors.ts (finalizeText)

## Normalization rules are per-project rows in two kinds, with pluggable language sets

What: normalization_rules holds the project's visible/adjustable rule list, seeded from RULE_SETS (Spanish/RAE default, English equivalent proves pluggability); kind 'mechanical' rules run as deterministic post-processing transforms, kind 'prompt' rules are injected into the generation instructions for the model to apply while writing · Why: quotes/dashes/ellipsis are exact and auditable as regex passes (one change-log entry per rule), but italics-for-foreign-terms needs judgment only the model has · Where: src/lib/repo/normalization.ts (seeds), src/lib/master/normalize.ts (transforms + quote-balance check)
