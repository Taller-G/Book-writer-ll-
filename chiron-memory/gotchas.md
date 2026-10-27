# gotcha

A non-obvious pitfall or trap, learned the hard way.

## Provider error text must be redacted before it reaches an error message

What: The OpenRouter client passes any provider-echoed text through redactSecrets (strips sk-or-*/sk-ant-*/Bearer tokens) before building an error message · Why: job errors are persisted in jobs.error and rendered in the UI — a provider echoing the key back would otherwise leak it into both · Where: src/lib/ai/errors.ts, src/lib/ai/openrouter.ts · Learned: treat provider error bodies as untrusted output that may contain your own secrets

## New columns on existing tables need the ALTER TABLE loop, not just the DDL

What: bootstrap.ts creates tables with CREATE TABLE IF NOT EXISTS, so adding a column to the DDL does nothing for databases that already exist — new columns must also be added to the idempotent ALTER TABLE block (see addMissingSourceColumns) · Why: the stage-1 file columns silently would not exist in any pre-upgrade project DB otherwise · Where: src/lib/db/bootstrap.ts · Learned: in an additive-only schema, every new column ships in two places: the CREATE DDL and the pragma-guarded ALTER loop

## SSR'd client stage components hydrate — watch HTML nesting and locale dates

What: Stage components rendered as "use client" children of the server stage page are SSR'd and hydrated: a <p> inside a <span> or a new Date().toLocaleString() without suppressHydrationWarning triggers React hydration-mismatch errors that regenerate the whole tree · Why: SSR output must byte-match the client render; invalid HTML nesting gets re-parsed differently by the browser and locale formatting differs between the Node server and the browser · Where: src/components/stages/FormatWizard.tsx · Learned: in hybrid stage UIs use <Fragment> instead of wrapper spans around block elements, and suppressHydrationWarning on locale-formatted timestamps
