# contradiction

A memory that clashes with newer reality — flagged to be resolved.

## Stage 3 is no longer a form-only stage — it runs jobs

What: Since the style-profile work order (2026-10-27), stage 3 spawns two job types, extract_style and style_sample, both registered in EXECUTORS and triggered from Stage3Style via JobPanel; the earlier memory that stages 2, 3 and 7 are form-only with no job type now holds only for 2 and 7 · Why: supersedes the "form-only stages" gotcha and the "3-Style profile (n/a job)" stage map · Where: src/lib/jobs/executors.ts, src/components/stages/Stage3Style.tsx
## Stage 2 is no longer a form-only stage

What: Stage 2 (Editorial contract) now runs the tone_samples job — the first AI-powered executor — so earlier memories saying "stages 2, 3 and 7 are form-only with no job type" and "stage executors are still deterministic placeholders" are stale (3 and 7 remain form-only; all other executors remain deterministic) · Why: the Stage 2 work order added AI-generated tone samples from the user's material · Where: src/lib/stages.ts (stage 2 jobType), src/lib/jobs/executors.ts (toneSamples)
