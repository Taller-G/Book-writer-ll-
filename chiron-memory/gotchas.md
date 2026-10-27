# gotcha

A non-obvious pitfall or trap, learned the hard way.

## Provider error text must be redacted before it reaches an error message

What: The OpenRouter client passes any provider-echoed text through redactSecrets (strips sk-or-*/sk-ant-*/Bearer tokens) before building an error message · Why: job errors are persisted in jobs.error and rendered in the UI — a provider echoing the key back would otherwise leak it into both · Where: src/lib/ai/errors.ts, src/lib/ai/openrouter.ts · Learned: treat provider error bodies as untrusted output that may contain your own secrets

## New columns on existing tables need the ALTER TABLE loop, not just the DDL

What: bootstrap.ts creates tables with CREATE TABLE IF NOT EXISTS, so adding a column to the DDL does nothing for databases that already exist — new columns must also be added to the idempotent ALTER TABLE block (see addMissingSourceColumns) · Why: the stage-1 file columns silently would not exist in any pre-upgrade project DB otherwise · Where: src/lib/db/bootstrap.ts · Learned: in an additive-only schema, every new column ships in two places: the CREATE DDL and the pragma-guarded ALTER loop

## pdftotext merges text that overlaps the folio into one line

What: When body text intrudes into the folio zone, pdftotext -bbox-layout merges folio and text into a single line, so "lowest line = single number word" folio detection goes blind exactly when the overlap defect occurs — the QA folio check detects the folio at WORD level inside the bottom-margin band and flags any word sharing its vertical band · Why: the folio-overlap check exists precisely for that defect class (61 overlapped pages in a real book); a line-level detector would have passed it · Where: src/lib/render/qa.ts (folioOf, checkFolioOverlap) · Learned: build QA detectors against the defective output, not the clean one

## BSD sed does not understand \f — use real form-feed splitting for pdftotext pages

What: pdftotext -layout separates pages with form-feed (0x0C); piping through BSD sed 's/\f/…/' replaces literal "f" characters and silently corrupts the text · Why: macOS sed has no \f escape; page splitting must happen on the actual control character (split("\f") in JS) · Where: src/lib/render/qa.ts · Learned: verify extraction plumbing on a known PDF before trusting parsed results
