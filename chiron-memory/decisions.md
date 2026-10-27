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

## PDF rendering is a stage-7 render_pdf job; stage-8 HTML export unchanged

What: Real PDF rendering landed as a NEW job type render_pdf on stage 7 (Format), writing pdf_versions rows with render metadata (text_version, format_hash, qa_passed, qa_report_path); the stage-8 export_book HTML executor was left untouched · Why: the work-order seam is "preview cycle + print output consume versioned PDFs + QA report", which is the Format stage; replacing export_book would have been a cross-cutting slug migration out of scope · Where: src/lib/stages.ts, src/lib/jobs/executors.ts, src/lib/db/bootstrap.ts

## Composition fidelity is verified by inverse-parsing the emitted LaTeX

What: verifyComposition() re-extracts the word stream from the generated .tex (inverse of the composer's own grammar, LaTeX escapes inverted) and compares it word-by-word against the approved text, aborting with the 1-based word position and both contexts · Why: comparing approved text to a decompiled artifact catches any injected/dropped/altered word instead of trusting the composer; PDF-side text is unusable for this because extraction introduces ligatures (ﬁ) and layout noise · Where: src/lib/render/compose.ts · Learned: verify fidelity at the composition seam, not the rendered-PDF seam
## Stage 7 seeds the §7 proven format defaults on first read

What: getFormatConfig seeds a missing format_configs row with PROVEN_DEFAULTS (A5, EB Garamond 11/14.5 pt OldStyle, Inter headings/folios 9 pt small caps, margins inner 2.3 / outer 1.9 / top 1.6 / bottom 2.4 cm, first-line indents, recto chapter openings, 2.4 em whitespace separators), so a user who touches nothing in the Format stage still ends with the proven configuration saved · Why: the spec requires that accepting every default untouched yields exactly the §7 configuration, verifiable in the stored format_config — seeding at first read covers even users who never press Save · Where: src/lib/format/config.ts (PROVEN_DEFAULTS), src/lib/repo/output.ts (getFormatConfig), tests/format.test.ts

## Layout "has begun" means an export job or export version exists

What: layoutHasBegun(db, projectId) is true when the project has any export_book job (even failed) or any pdf_versions row; the Format wizard then shows an explicit re-iteration-cost warning if the user picks a different page size than the saved one · Why: changing page size after layout re-flows the whole book — the real project's 12×18→A5 migration cost a full revision cycle, and this is the earliest signal the app has that layout work started · Where: src/lib/repo/output.ts (layoutHasBegun), src/components/stages/FormatWizard.tsx (page-size-warning)
## Spec stage 4 (master text) lives in pipeline stage 5, prose mode only

What: The editorial-prose master-text flow (outline → sample → chunked generation → apparatus) replaces Stage 5's UI and jobs only when the contract mode is 'prose'; verbatim/hybrid keep the deterministic refine_pass_b. Its job types (propose_outline, generate_style_sample, generate_master_text, propose_apparatus) all run on stage number 5 and the generation writes passB · Why: the spec's stage numbering differs from the repo's 8 stages — repo stage 5 is the one that consumes the cleaned passA and produces the passB that review/format/export already consume, so the master text slots into the existing seam without renumbering · Where: src/app/projects/[id]/stages/[stage]/page.tsx (mode dispatch), src/lib/jobs/executors.ts · Learned: one pipeline stage can host several job types; use latestJobOfType (repo/jobs.ts), not latestJobForStage, to show each job's status independently

## Apparatus assembled at finalize, never baked into passB

What: Accepted apparatus sections are stored as rows and wrapped around the text (front + passB + back) by the finalize_text executor; proposed/discarded sections are simply excluded, and re-proposing never touches sections the user already decided · Why: baking apparatus into passB would make the text stale the moment the user discards a section; assembling at freeze time makes "discard without breaking the book" structural · Where: src/lib/repo/apparatus.ts, src/lib/jobs/executors.ts (finalizeText)

## Normalization rules are per-project rows in two kinds, with pluggable language sets

What: normalization_rules holds the project's visible/adjustable rule list, seeded from RULE_SETS (Spanish/RAE default, English equivalent proves pluggability); kind 'mechanical' rules run as deterministic post-processing transforms, kind 'prompt' rules are injected into the generation instructions for the model to apply while writing · Why: quotes/dashes/ellipsis are exact and auditable as regex passes (one change-log entry per rule), but italics-for-foreign-terms needs judgment only the model has · Where: src/lib/repo/normalization.ts (seeds), src/lib/master/normalize.ts (transforms + quote-balance check)
## Style references keep extracted text only, not immutable originals

What: Stage-3 reference files (txt/md/pdf/docx) are stored as extracted text in the style_refs table via addStyleReference(); unreadable, empty, or non-text files return a per-file error and save nothing — unlike Stage-1 sources there is no original/ file tree · Why: references are inputs to the style profile, not book material under the spec's trust model, so checksummed immutable originals would be dead weight; the no-partial-state rule still applies (a failed reference must never leave a silent partial profile) · Where: src/lib/ingest/styleRef.ts, src/app/api/projects/[id]/style-refs/route.ts

## Profile extraction demands strict JSON and fails loudly on shortfall

What: The extract_style executor calls the 'large' role with system.bare and parses the response as strict JSON (8 trait fields + 3-5 verbatim excerpts); unparseable or incomplete output (fewer than 4 traits or zero excerpts) throws, failing the job with a clear error and writing NO profile · Why: the spec forbids a silent partial profile — a failed extraction must be visibly retryable, never half-saved · Where: src/lib/jobs/executors.ts (parseProfileJson, extractStyle)

## Image credits: automatic by origin, mandatory, assembled at render/export

What: Image credit lines are decided solely by origin — own → "imagen del autor", ai → "generada con inteligencia artificial" (+ one-time AI disclaimer), third_party → the stored source/licence attribution. A credits section (stored as an apparatus_sections row, key `creditos-imagenes`, back matter) is MANDATORY whenever the book has non-discarded images: its content is regenerated from the images after every change, its accept/discard status is the user's decision, and `imageCreditsGate()` blocks Stage-8 completion and the export_book executor when images exist but the section is missing/proposed/discarded. · Why: pain points #7 & #9 — provenance must never be wrong or missing; the real project needed a rights-safe credit for AI images. · Alternatives: assembling credits into the Stage-6 FINAL text via the prose apparatus flow — rejected because images arrive at Stage 7 (after finalize) and the apparatus flow is prose-mode only. · Where: src/lib/images/credits.ts, src/lib/repo/images.ts (regenerateImageCredits, imageCreditsGate, renderableImageCredits), src/lib/gates.ts (case 8), src/lib/jobs/executors.ts (exportBook guard)

## DPI is checked twice: pre-render preflight + post-render QA

What: Printed resolution is verified before any render by pure arithmetic (pixel size ÷ printed size at the chosen column/half/full box vs 300 dpi) in src/lib/images/dpi.ts, surfaced in the placement UI and recorded by the render executor; the existing poppler `image_dpi` QA check still validates the compiled PDF. · Why: the acceptance criterion requires a warning BEFORE a full compile so a too-small image can be swapped early; the post-render check remains the backstop. · Where: src/lib/images/dpi.ts (imageDpiWarnings), src/components/stages/ImagesPanel.tsx + ImageReorderList (badges), src/lib/jobs/executors.ts (renderPdf), src/lib/render/qa.ts (checkImageDpi)
