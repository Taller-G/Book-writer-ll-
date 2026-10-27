# gotcha

A non-obvious pitfall or trap, learned the hard way.

## Provider error text must be redacted before it reaches an error message

What: The OpenRouter client passes any provider-echoed text through redactSecrets (strips sk-or-*/sk-ant-*/Bearer tokens) before building an error message · Why: job errors are persisted in jobs.error and rendered in the UI — a provider echoing the key back would otherwise leak it into both · Where: src/lib/ai/errors.ts, src/lib/ai/openrouter.ts · Learned: treat provider error bodies as untrusted output that may contain your own secrets

## New columns on existing tables need the ALTER TABLE loop, not just the DDL

What: bootstrap.ts creates tables with CREATE TABLE IF NOT EXISTS, so adding a column to the DDL does nothing for databases that already exist — new columns must also be added to the idempotent ALTER TABLE block (see addMissingColumns) · Why: the stage-1 file columns silently would not exist in any pre-upgrade project DB otherwise · Where: src/lib/db/bootstrap.ts · Learned: in an additive-only schema, every new column ships in two places: the CREATE DDL and the pragma-guarded ALTER loop
What: bootstrap.ts creates tables with CREATE TABLE IF NOT EXISTS, so adding a column to the DDL does nothing for databases that already exist — new columns must also be added to the idempotent ALTER TABLE block (addMissingColumns, with a per-table column list) · Why: the stage-1 file columns silently would not exist in any pre-upgrade project DB otherwise · Where: src/lib/db/bootstrap.ts · Learned: in an additive-only schema, every new column ships in two places: the CREATE DDL and the pragma-guarded ALTER loop

## Choice-presenting AI calls must opt out of injection with system.bare

What: createAiClient auto-injects the contract and confirmed style profile into every call, so an executor whose purpose is to present a choice (tone_samples comparing tones, extract_style reading references fresh) must set system.bare — merely omitting the fields is no longer enough · Why: during the main-merge of the Stage-2 and Stage-3 work orders, tone_samples relied on "not passing the contract" to keep samples unbiased; the injection wrapper silently defeated that until bare was added · Where: src/lib/jobs/executors.ts (toneSamples, extractStyle), src/lib/ai/index.ts · Learned: when a seam gains default behavior, audit existing callers for ones that depended on the old default's absence
