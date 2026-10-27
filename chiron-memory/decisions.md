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

## Editorial contract = four versioned decisions, snapshot per change

What: The Stage 2 contract holds four decisions — mode (verbatim/prose/hybrid), tone (neutral/literary_cinematic/academic/conversational), destination (personal/short_run/isbn/digital), authorship (own/third_party/mixed) plus rights notes and legal text; every save that changes a decision bumps editorial_contracts.version and snapshots the full row into contract_versions, while an identical re-save is a no-op · Why: the spec's "decisions made, do not re-discuss" document must be visible and versioned, and the no-op guard keeps version numbers meaningful · Where: src/lib/repo/editorial.ts (saveContract), src/lib/contract/definitions.ts

## Legal text is a deterministic proposal, never overwriting user wording

What: Declaring an authorship auto-fills legal_text from templates (copyright line with project author, third-party/mixed clauses, ISBN + legal-deposit placeholders when destination is isbn) ONLY when the field is empty; the third-party limitation warning is a pure function over authorship+destination · Why: the app cannot verify rights, so it proposes and warns — the user edits and owns the final wording · Where: src/lib/contract/definitions.ts (proposeLegalText, authorshipWarning)

## Tone is chosen by comparing generated samples of the user's own material

What: The tone_samples job (stage 2, 'large' role) rewrites the same excerpt of the latest raw text once per predefined tone and stores {excerpt, samples} in job.output; the editorial contract is deliberately NOT injected into those calls · Why: samples must come from the user's real material compared like-for-like, and the tone is exactly what is being decided, so injecting a (possibly unset) contract tone would bias the comparison · Where: src/lib/jobs/executors.ts (toneSamples, sampleExcerpt)

## Uploads go through a route handler, not a server action

What: Stage-1 file uploads POST multipart FormData to /api/projects/[id]/sources instead of a 'use server' action · Why: server actions have a ~1 MB default body limit that audio/video uploads exceed, and a route handler can return per-file success/error JSON for the dropzone · Where: src/app/api/projects/[id]/sources/route.ts, src/components/SourceDropzone.tsx

## Video ingests fully even without ffmpeg; audio extraction is best-effort

What: Video uploads always store the original with checksum and duration; the audio track is extracted to derived/audio.m4a only when system ffmpeg exists, otherwise the source carries a visible note explaining it · Why: ffmpeg is a system dependency that may be absent — blocking the upload would lose the user's material, and the derived extraction can be redone later · Where: src/lib/ingest/ingest.ts (extractVideoAudio)
