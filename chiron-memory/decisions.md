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

## Stage 7 seeds the §7 proven format defaults on first read

What: getFormatConfig seeds a missing format_configs row with PROVEN_DEFAULTS (A5, EB Garamond 11/14.5 pt OldStyle, Inter headings/folios 9 pt small caps, margins inner 2.3 / outer 1.9 / top 1.6 / bottom 2.4 cm, first-line indents, recto chapter openings, 2.4 em whitespace separators), so a user who touches nothing in the Format stage still ends with the proven configuration saved · Why: the spec requires that accepting every default untouched yields exactly the §7 configuration, verifiable in the stored format_config — seeding at first read covers even users who never press Save · Where: src/lib/format/config.ts (PROVEN_DEFAULTS), src/lib/repo/output.ts (getFormatConfig), tests/format.test.ts

## Layout "has begun" means an export job or export version exists

What: layoutHasBegun(db, projectId) is true when the project has any export_book job (even failed) or any pdf_versions row; the Format wizard then shows an explicit re-iteration-cost warning if the user picks a different page size than the saved one · Why: changing page size after layout re-flows the whole book — the real project's 12×18→A5 migration cost a full revision cycle, and this is the earliest signal the app has that layout work started · Where: src/lib/repo/output.ts (layoutHasBegun), src/components/stages/FormatWizard.tsx (page-size-warning)
