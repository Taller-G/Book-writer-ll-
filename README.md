# Book Writer

Turns raw material (transcripts, documents, notes) into print-quality books
through a resumable 8-stage pipeline. This slice implements the project
workspace, the stage wizard, the per-project data model and the async job
foundation every other slice builds on.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # vitest suite
npm run build      # production build
```

All state lives in `data/book-writer.db` (SQLite, created on first run).
`BOOK_WRITER_DATA_DIR` overrides the data directory. Exports are written to
`data/exports/<projectId>/`.

## The 8 stages

1. **Sources** — ingest raw material, compile the `raw` working text
2. **Editorial contract** — verbatim / prose / hybrid + rules
3. **Style profile** — tone, register, narrative person
4. **Cleanup — Pass A** — `raw → passA`, every change audit-logged
5. **Refine — Pass B** — `passA → passB`, doubts go to the review queue
6. **Review** — resolve the queue, freeze `final`
7. **Format** — trim size, typography, margins
8. **Export** — versioned exports, covers, final checklist

Stage definitions (numbers, slugs, job types) live in `src/lib/stages.ts` and
must never be renumbered.

## Seams for other slices

- **Data model**: `src/lib/db/bootstrap.ts` (DDL) + `src/lib/db/schema.ts`
  (typed mirror). Repos in `src/lib/repo/*` take the `Db` as first argument.
- **Job contract**: every stage execution is a `jobs` row with a versioned
  input snapshot and versioned output, committed atomically with success.
  Executors are registered in `src/lib/jobs/executors.ts` — replace the
  deterministic baselines with Claude-powered implementations there.
- **Change log**: append-only by database triggers; write via
  `appendChange()` with what / where / why / authorizedBy.
- **API key**: `getApiKey()` in `src/lib/repo/prefs.ts` (AES-256-GCM,
  key file under the data dir).
