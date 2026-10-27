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

## Contract mode is enforced inside the executors, not just the prompt

What: cleanup_pass_a and refine_pass_b throw JobInputError without a signed contract and read its mode directly: verbatim blocks filler-word removal in Pass A (each kept candidate logged as "Kept filler … rewrites are blocked") and turns Pass B into an unchanged pass-through; every text/export job records contractVersion+contractMode in its input snapshot, and export_book renders the legal page, ISBN placeholder and color profile from the destination · Why: "faithful mode blocks rewrites" must hold structurally — an AI model ignoring the system prompt could not break the contract · Where: src/lib/jobs/executors.ts · Learned: enforce hard editorial rules in executor code and treat the injected prompt as a second layer, not the only one

## Mid-project contract changes warn by naming the affected artifacts

What: listDownstreamArtifacts() collects passA/passB/final stage_texts plus pdf_versions; the Stage 2 page shows them in a warning card whenever a signed contract exists, and saveContract appends a change_log entry naming each one when a revision happens after they exist · Why: changing the contract invalidates work produced under the previous version — the warning must be both on screen and on the permanent record · Where: src/lib/repo/editorial.ts, src/components/stages/Stage2Contract.tsx

## AI calls go through the AiClient seam, never a provider directly

What: All AI-dependent slices call createAiClient(db).complete(request) where the request carries a SystemContext payload (task instructions + editorial contract + style profile) and a model role ('large' for writing/restructuring, 'fast' for mass classification); OpenRouter is the only implementation today and a direct Anthropic provider slots in behind the same interface · Why: spec §9 makes this the seam between the BYOK engine and every other work order — provider swaps must not touch stage code · Where: src/lib/ai/index.ts, src/lib/ai/types.ts

## Render pipeline lives in src/lib/render/, executor stays thin

What: The Stage 7 layout engine is four modules in src/lib/render/ — compose.ts (approved text → memoir/XeLaTeX + word-for-word verification), compile.ts (double xelatex pass + aux-cleanup recovery), qa.ts (poppler-based post-render checks), report.ts (versioned JSON+markdown QA report) — orchestrated by render.ts; the render_pdf executor only reads inputs and commits DB rows · Why: mirrors the ingest convention (pipeline modules out of the executor) and keeps filesystem/subprocess work out of the jobs layer · Where: src/lib/render/, src/lib/jobs/executors.ts
## Full format config lives in format_configs.data; legacy columns are derived

What: The complete physical-format configuration (FormatConfigData: pageSize, typography, marginsCm, paragraphs, folios, conventions) is stored as JSON in format_configs.data; the legacy columns (trim_size, font_family, font_size_pt, line_height, margins) are derived from it via legacyFields() on every write and kept in sync · Why: the schema must stay additive and the Stage 8 export executor (and any older reader) consumes the legacy columns — data JSON extends the contract without a migration · Where: src/lib/format/config.ts (FormatConfigData, legacyFields, parseFormatData), src/lib/repo/output.ts · Learned: parseFormatData deep-merges stored JSON over PROVEN_DEFAULTS, so older partial rows always read as a complete config
## Master-text engine: pure modules + AiClient-parameterized orchestration

What: src/lib/master/ holds the stage-5 prose engine — chapters.ts (pure chapter model, safe for client import), segments.ts/normalize.ts/json.ts (pure functions), outline.ts/generate.ts/apparatus.ts (orchestration taking an AiClient parameter). Executors resolve the client through a swappable aiFactory (setAiFactoryForTests in executors.ts) so jobs are testable with a fake. Every generation call re-injects the contract + style profile (SystemContext) plus an explicit book-state summary (TOC with written/pending marks, leitmotifs, previous chapter tail, approved sample); oversized material is chunked by token budgets overridable via BOOK_WRITER_ANALYSIS_INPUT_TOKENS and BOOK_WRITER_CHAPTER_INPUT_TOKENS · Why: nothing may rely on implicit model memory between calls (spec §4), and the stage-5 voice-benchmark sample lives in style_profiles.data JSON (sample.approvedAt gates generation, sample.validatedAt records the user's post-generation check) — distinct from the stage-3 draft-preview `sample` COLUMN. Master-text executors gate on getConfirmedStyleProfile (a draft profile shapes nothing) and pass contract/profile explicitly, which ProjectContextClient keeps as-is · Where: src/lib/master/, src/lib/jobs/executors.ts, src/lib/repo/editorial.ts

## Style profile lifecycle: draft vs confirmed, versioned on confirm

What: style_profiles has status ('draft'|'confirmed') and version — extraction (extract_style job) saves a DRAFT that shapes nothing; confirmStyleProfile() sets status='confirmed' and bumps version only when confirmed_at already existed (first confirm is v1); the stage-3 gate requires a confirmed profile · Why: the spec requires the user to review/adjust the extracted profile before it is applied to everything, and the version bump is what marks downstream texts as written under an older voice · Where: src/lib/repo/editorial.ts, src/lib/gates.ts

## Every AI call auto-injects contract + confirmed profile, logged verbatim

What: createAiClient() wraps the provider in ProjectContextClient, which on every complete() loads the editorial contract and the CONFIRMED style profile (with its few-shot excerpts) from the DB by request.projectId and fills any missing SystemContext fields; `system.bare` opts out (used only by profile extraction); the exact rendered system prompt is stored per call in ai_usage.system_prompt · Why: voice consistency must be structural, never dependent on callers or conversation memory — a project reopened weeks later injects the identical profile because it is read from disk per call, and the call log makes that verifiable · Where: src/lib/ai/index.ts (ProjectContextClient), src/lib/ai/types.ts (buildSystemPrompt), src/lib/repo/aiUsage.ts · Learned: make cross-cutting invariants hold at the seam (client factory), not at each call site

## Stage texts are stamped with the profile version that produced them

What: insertText() automatically stamps stage_texts.style_profile_version with the current confirmed profile version (NULL when none); textsUnderOldProfile() returns the latest passA/passB/final texts whose stamp differs from the current version, feeding the regenerate/keep panel on Stage 3 · Why: a mid-project profile change must list exactly which texts carry the previous voice; regenerating re-runs the producing job (new stamped text), keeping stamps the existing row via stampTextProfileVersion() plus an audit entry · Where: src/lib/repo/texts.ts, src/components/stages/ProfileChangePanel.tsx, src/lib/actions/content.ts (keepTextProfileAction)

## Book images domain (Stage 6.4): book_images table + own file tree + Stage 7 UI

What: Illustrations are a domain separate from Stage-1 sources: a `book_images` table (origin own/ai/third_party, pixel dims, caption, size_option column/half/full, anchor_text, narrative_order, status review/placed/discarded, AI provenance), image bytes stored immutably at `data/images/{projectId}/{imageId}/` (saveImageFile, read-only original, like sources), repo in src/lib/repo/images.ts (injectable db), and a management UI in Stage 7 (src/components/stages/ImagesPanel.tsx + client ImageDropzone/ImageReorderList). Lifecycle: new images (upload or AI) land in `review`, placement moves them to `placed`, artifacts go to `discarded`. · Why: images are book material (placed, credited, rendered), not inputs to the text pipeline; the spec §4 Stage 6.4 seam feeds placed images into the layout engine. · Where: src/lib/db/{bootstrap,schema}.ts, src/lib/repo/images.ts, src/lib/files/store.ts, src/lib/images/, src/components/stages/ImagesPanel.tsx

## AiClient.generateImage is the image-generation seam

What: Image generation goes through the same AiClient interface as text via a new `generateImage(AiImageRequest): AiImageResponse` method; OpenRouterClient implements it against the chat-completions endpoint with `modalities:["image","text"]`, parsing the returned data-URL to bytes and recording ai_usage. The model is configured separately from the large/fast text roles (Claude can't make images) via `imageModelSlug()` / `BOOK_WRITER_IMAGE_MODEL`. The `generate_image` executor (stage 7) files the bytes as an origin=ai image in the review grid. · Why: §9 provider seam must cover images too; Claude text roles can't generate images so the image model is its own config knob. · Where: src/lib/ai/types.ts, src/lib/ai/openrouter.ts, src/lib/ai/index.ts (ProjectContextClient delegates), src/lib/jobs/executors.ts (generate_image) · Learned: the live OpenRouter image call is not verified against a real provider — only the FakeAiClient path is tested.

## Placed images and image-credits enter the layout engine's verified text

What: renderBook/composeBook take `images: PlacedImage[]`; compose splices each image (as a `\bookimage{path}{opts}` macro, inline-centered, graphicx) after the paragraph matching its anchor_text, in narrative_order. The credits section is appended to the FINAL text as a back chapter BEFORE word-for-word verification, so credits are verified with the text; image macros carry no words and are skipped by both word streams, so verifyComposition still holds. · Where: src/lib/render/compose.ts (placeImages, IMAGE_SIZE_OPTIONS, composedWordStream skip), src/lib/render/render.ts (RenderInput.images), src/lib/jobs/executors.ts (renderPdf builds effective text + placed images)
