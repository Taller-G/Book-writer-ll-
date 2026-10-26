import type { Database } from "better-sqlite3";

// Idempotent DDL. Runs on every connection open; CREATE ... IF NOT EXISTS
// keeps it safe. Schema changes must stay additive (new tables/columns) so
// existing project databases keep working.
const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  current_stage INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stage_progress (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','done')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, stage)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('transcript','audio','document','notes')),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id);

CREATE TABLE IF NOT EXISTS editorial_contracts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('verbatim','prose','hybrid')),
  rules TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  signed_at TEXT
);

CREATE TABLE IF NOT EXISTS style_profiles (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  tone TEXT NOT NULL DEFAULT '',
  register TEXT NOT NULL DEFAULT '',
  person TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Versioned text snapshots per pipeline stage: raw -> passA -> passB -> final.
CREATE TABLE IF NOT EXISTS stage_texts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL CHECK (stage_key IN ('raw','passA','passB','final')),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, stage_key, version)
);

-- Append-only audit log. Deliberately NOT a foreign key to projects: a
-- cascade would collide with the append-only triggers below. Entries are
-- immutable while their project exists; purging a deleted project's entries
-- is the single allowed delete path (project row must be gone first).
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  what TEXT NOT NULL,
  "where" TEXT NOT NULL,
  why TEXT NOT NULL,
  authorized_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_change_log_project ON change_log(project_id);

CREATE TRIGGER IF NOT EXISTS change_log_no_update
BEFORE UPDATE ON change_log
BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only: updates are not allowed');
END;

CREATE TRIGGER IF NOT EXISTS change_log_no_delete
BEFORE DELETE ON change_log
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only: deletes are not allowed');
END;

CREATE TABLE IF NOT EXISTS review_queue (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL DEFAULT 'edit',
  excerpt TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected')),
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_queue_project ON review_queue(project_id);

CREATE TABLE IF NOT EXISTS format_configs (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  trim_size TEXT NOT NULL DEFAULT '6x9in',
  font_family TEXT NOT NULL DEFAULT 'Garamond',
  font_size_pt REAL NOT NULL DEFAULT 11,
  line_height REAL NOT NULL DEFAULT 1.4,
  margins TEXT NOT NULL DEFAULT '{"top":"20mm","bottom":"20mm","inner":"22mm","outer":"16mm"}',
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pdf_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS covers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  file_path TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Async stage jobs: versioned input/output, visible status, retryable.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed')),
  attempt INTEGER NOT NULL DEFAULT 1,
  retry_of TEXT,
  input_version INTEGER NOT NULL DEFAULT 1,
  input TEXT NOT NULL DEFAULT '{}',
  output_version INTEGER,
  output TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);

-- Single-row user preferences, including the encrypted API key slot.
CREATE TABLE IF NOT EXISTS user_prefs (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  preferences TEXT NOT NULL DEFAULT '{}',
  api_key_ciphertext TEXT,
  api_key_iv TEXT,
  api_key_tag TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO user_prefs (id) VALUES (1);
`;

export function applyBootstrap(db: Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(DDL);
  // A server crash mid-job leaves 'running'/'queued' rows behind with no
  // worker attached. Surface them as failed-and-retryable instead of
  // forever-running.
  db.prepare(
    `UPDATE jobs
     SET status = 'failed',
         error = 'Interrupted: the app stopped while this job was in flight. Retry to run it again.',
         finished_at = datetime('now')
     WHERE status IN ('queued','running')`,
  ).run();
}
