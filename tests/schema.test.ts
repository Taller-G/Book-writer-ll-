import { describe, expect, it } from "vitest";
import { applyBootstrap } from "@/lib/db/bootstrap";
import { openDatabase } from "@/lib/db/client";
import { createProject, getStageStates, listProjects } from "@/lib/repo/projects";
import { listChecklist } from "@/lib/repo/output";
import { STAGE_COUNT } from "@/lib/stages";

describe("schema bootstrap", () => {
  it("creates all tables and seeds a project correctly", () => {
    const handle = openDatabase(":memory:");
    const tables = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      "projects",
      "stage_progress",
      "sources",
      "editorial_contracts",
      "style_profiles",
      "stage_texts",
      "change_log",
      "review_queue",
      "format_configs",
      "pdf_versions",
      "covers",
      "checklist_items",
      "jobs",
      "user_prefs",
      "outlines",
      "normalization_rules",
      "apparatus_sections",
      "cover_concepts",
      "back_cover_sections",
      "title_options",
      "cover_spine",
      "cover_iterations",
    ]) {
      expect(tables).toContain(t);
    }

    const project = createProject(handle, { title: "My Book" });
    expect(listProjects(handle.db)).toHaveLength(1);

    const states = getStageStates(handle.db, project.id);
    expect(states).toHaveLength(STAGE_COUNT);
    expect(states[0].status).toBe("in_progress");
    expect(states[1].status).toBe("locked");

    expect(listChecklist(handle.db, project.id).length).toBeGreaterThan(0);
  });

  it("adds render metadata columns to pdf_versions (fresh and legacy DBs)", () => {
    const fresh = openDatabase(":memory:");
    const cols = (fresh.sqlite.pragma("table_info(pdf_versions)") as Array<{ name: string }>)
      .map((c) => c.name);
    for (const c of ["text_version", "format_hash", "qa_passed", "qa_report_path"]) {
      expect(cols).toContain(c);
    }
    // Legacy DB: table exists without the columns; re-bootstrap adds them.
    const legacy = openDatabase(":memory:");
    legacy.sqlite.exec("DROP TABLE pdf_versions");
    legacy.sqlite.exec(
      `CREATE TABLE pdf_versions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL,
        file_path TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', job_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (project_id, version)
      )`,
    );
    applyBootstrap(legacy.sqlite);
    const migrated = (legacy.sqlite.pragma("table_info(pdf_versions)") as Array<{ name: string }>)
      .map((c) => c.name);
    for (const c of ["text_version", "format_hash", "qa_passed", "qa_report_path"]) {
      expect(migrated).toContain(c);
    }
  });
});
