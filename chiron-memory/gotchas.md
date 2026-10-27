# gotcha

A non-obvious pitfall or trap, learned the hard way.

## Reaction detection only decodes WAV; non-WAV recordings are silently skipped

What: src/lib/reactions/wav.ts is a dependency-free PCM WAV codec; detect_reactions and the clip actions try decodeWav and skip a source on failure (mp3/m4a/video need ffmpeg, treated as absent). Reaction↔transcript alignment is proportional (ms ↔ char offset via duration), not forced-alignment, so char_anchor and ambiguous-question clip timings are approximate and rely on human confirmation · Why: spec requires AI-free DSP and the project already treats ffmpeg as possibly-absent; exact alignment is out of scope · Where: src/lib/reactions/wav.ts, src/lib/reactions/detect.ts (msToCharOffset), src/lib/jobs/executors.ts · Learned: to exercise detection in a test, write a WAV via encodeWav + saveOriginal + addFileSource and inject a FakeAiClient for the semantic check (setAiFactoryForTests)

## Provider error text must be redacted before it reaches an error message

What: The OpenRouter client passes any provider-echoed text through redactSecrets (strips sk-or-*/sk-ant-*/Bearer tokens) before building an error message · Why: job errors are persisted in jobs.error and rendered in the UI — a provider echoing the key back would otherwise leak it into both · Where: src/lib/ai/errors.ts, src/lib/ai/openrouter.ts · Learned: treat provider error bodies as untrusted output that may contain your own secrets

## New columns on existing tables need the ALTER TABLE loop, not just the DDL

What: bootstrap.ts creates tables with CREATE TABLE IF NOT EXISTS, so adding a column to the DDL does nothing for databases that already exist — new columns must also be added to the idempotent ALTER TABLE block (see addMissingSourceColumns) · Why: the stage-1 file columns silently would not exist in any pre-upgrade project DB otherwise · Where: src/lib/db/bootstrap.ts · Learned: in an additive-only schema, every new column ships in two places: the CREATE DDL and the pragma-guarded ALTER loop

## pdftotext merges text that overlaps the folio into one line

What: When body text intrudes into the folio zone, pdftotext -bbox-layout merges folio and text into a single line, so "lowest line = single number word" folio detection goes blind exactly when the overlap defect occurs — the QA folio check detects the folio at WORD level inside the bottom-margin band and flags any word sharing its vertical band · Why: the folio-overlap check exists precisely for that defect class (61 overlapped pages in a real book); a line-level detector would have passed it · Where: src/lib/render/qa.ts (folioOf, checkFolioOverlap) · Learned: build QA detectors against the defective output, not the clean one

## BSD sed does not understand \f — use real form-feed splitting for pdftotext pages

What: pdftotext -layout separates pages with form-feed (0x0C); piping through BSD sed 's/\f/…/' replaces literal "f" characters and silently corrupts the text · Why: macOS sed has no \f escape; page splitting must happen on the actual control character (split("\f") in JS) · Where: src/lib/render/qa.ts · Learned: verify extraction plumbing on a known PDF before trusting parsed results
## SSR'd client stage components hydrate — watch HTML nesting and locale dates

What: Stage components rendered as "use client" children of the server stage page are SSR'd and hydrated: a <p> inside a <span> or a new Date().toLocaleString() without suppressHydrationWarning triggers React hydration-mismatch errors that regenerate the whole tree · Why: SSR output must byte-match the client render; invalid HTML nesting gets re-parsed differently by the browser and locale formatting differs between the Node server and the browser · Where: src/components/stages/FormatWizard.tsx · Learned: in hybrid stage UIs use <Fragment> instead of wrapper spans around block elements, and suppressHydrationWarning on locale-formatted timestamps
## Client-component state survives server revalidation — remount by key

What: After a server action saves the outline and revalidates, OutlineEditor's useState (pending edits) survives because React preserves client-component state when only props change; the editor must be remounted via key={outline.updatedAt + status} to reset to server truth. Related: React StrictMode runs setState updater functions twice in dev, so side effects (recording an edit) must live outside the updater · Where: src/components/stages/Stage5MasterText.tsx, src/components/OutlineEditor.tsx · Learned: for form-like client widgets fed by server components, key them on the server row's updated_at

## Playwright's dragTo cannot test HTML5 drag-and-drop

What: browser dragTo performs mouse moves, which do not fire HTML5 dragstart/dragover/drop on draggable elements; to exercise the outline editor's drag reorder, dispatch DragEvent objects with a DataTransfer via page.evaluate · Where: src/components/OutlineEditor.tsx · Learned: keep drag logic in small handlers so a synthetic-event dispatch covers it
What: bootstrap.ts creates tables with CREATE TABLE IF NOT EXISTS, so adding a column to the DDL does nothing for databases that already exist — new columns must also be added to the idempotent ALTER TABLE block (see addMissingColumns) · Why: the stage-1 file columns silently would not exist in any pre-upgrade project DB otherwise · Where: src/lib/db/bootstrap.ts · Learned: in an additive-only schema, every new column ships in two places: the CREATE DDL and the pragma-guarded ALTER loop
What: bootstrap.ts creates tables with CREATE TABLE IF NOT EXISTS, so adding a column to the DDL does nothing for databases that already exist — new columns must also be added to the idempotent ALTER TABLE block (addMissingColumns, with a per-table column list) · Why: the stage-1 file columns silently would not exist in any pre-upgrade project DB otherwise · Where: src/lib/db/bootstrap.ts · Learned: in an additive-only schema, every new column ships in two places: the CREATE DDL and the pragma-guarded ALTER loop

## Choice-presenting AI calls must opt out of injection with system.bare

What: createAiClient auto-injects the contract and confirmed style profile into every call, so an executor whose purpose is to present a choice (tone_samples comparing tones, extract_style reading references fresh) must set system.bare — merely omitting the fields is no longer enough · Why: during the main-merge of the Stage-2 and Stage-3 work orders, tone_samples relied on "not passing the contract" to keep samples unbiased; the injection wrapper silently defeated that until bare was added · Where: src/lib/jobs/executors.ts (toneSamples, extractStyle), src/lib/ai/index.ts · Learned: when a seam gains default behavior, audit existing callers for ones that depended on the old default's absence
## cleanup_pass_a now makes an AI call; tests with a key must stub it

What: Pass A (cleanup_pass_a) now asks the AI to propose transcription-noise corrections before the deterministic mechanical cleanup. It gracefully SKIPS the AI phase only on AiAuthError (no key configured) — any other AI/provider error fails the job (visible, retryable). So any test that sets an API key (setApiKey) and runs cleanup_pass_a must stub the AI (setAiFactoryForTests(() => new FakeAiClient(() => "[]"))) or it will attempt a live network call · Why: the no-key skip keeps the deterministic path working offline, but a configured-but-unstubbed key triggers a real OpenRouter request · Where: src/lib/jobs/executors.ts (proposePassACorrections, cleanupPassA), tests/styleProfile.test.ts (mid-project profile change describe) · Learned: when adding an AI call to a previously-deterministic executor, audit existing tests that set a key but didn't expect an AI call
