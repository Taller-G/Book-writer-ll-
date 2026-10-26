import { describe, expect, it } from "vitest";
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
});
