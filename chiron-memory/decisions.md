# decision

A choice made and the reasoning behind it — the path taken over the alternatives.

## Stack: Next.js 15 + SQLite (better-sqlite3 + Drizzle)

What: The app is Next.js 15 (App Router, TS) with a single local SQLite file (better-sqlite3 driver, Drizzle for typed queries); no external services · Why: single-user desktop-style product — one full-stack framework plus an embedded DB gives persistence across sessions with zero infra; alternatives (Express+Vite split, Postgres) add moving parts with no benefit at this scale · Where: src/lib/db/client.ts

## Change log append-only via SQLite triggers, no FK cascade

What: change_log has BEFORE UPDATE/DELETE triggers that RAISE(ABORT); it deliberately has NO foreign key to projects, and the delete trigger allows purging only when the owning project row is already gone · Why: a cascade from project deletion would collide with the append-only triggers (undeletable projects); enforcing at the DB layer means even code that bypasses the repo cannot mutate history · Where: src/lib/db/bootstrap.ts · Learned: when a table must be immutable AND its parent deletable, drop the FK and gate the delete trigger on parent existence

## Schema as idempotent DDL in bootstrap.ts, not drizzle-kit migrations

What: Tables/triggers are created by raw CREATE ... IF NOT EXISTS DDL run on every connection open; src/lib/db/schema.ts is a typed Drizzle mirror kept in sync by hand · Why: triggers and CHECK constraints are first-class in raw DDL, and an empty-to-v1 project doesn't need migration tooling; future schema changes must stay additive · Where: src/lib/db/bootstrap.ts
