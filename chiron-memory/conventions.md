# convention

A rule the codebase follows — naming, patterns, and where things live.

## createJob accepts creation-time params for jobs that need input up front

What: `createJob`/`enqueueAndRun` take an optional `params` persisted into jobs.input at creation, so a job whose input is user-supplied rather than read from the DB (e.g. generate_image's prompt) has it available in the executor via JSON.parse(job.input). Most executors still set their input snapshot in markJobRunning; params is only for genuinely creation-time input. · Where: src/lib/repo/jobs.ts, src/lib/jobs/runner.ts, src/lib/jobs/executors.ts (generate_image)

## Image uploads use a route handler; bytes are served from a scoped GET route

What: Book images upload via `POST /api/projects/[id]/images` (route handler, no body-size cap, parses pixel dims, stores, lands in review) and are served by `GET /api/projects/[id]/images/[imageId]` (scoped to the project id). Mirrors the sources upload convention. · Where: src/app/api/projects/[id]/images/route.ts, .../[imageId]/route.ts, src/components/ImageDropzone.tsx
