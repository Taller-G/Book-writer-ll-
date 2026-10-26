import { describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { appendChange, listChanges } from "@/lib/repo/changeLog";
import { createProject, deleteProject, listProjects } from "@/lib/repo/projects";

function setup() {
  const handle = openDatabase(":memory:");
  const project = createProject(handle, { title: "Audit me" });
  appendChange(handle.db, {
    projectId: project.id,
    what: "Removed filler word 'um'",
    where: "paragraph 3",
    why: "transcription cleanup",
    authorizedBy: "cleanup_pass_a job",
  });
  return { handle, project };
}

describe("change_log append-only enforcement", () => {
  it("accepts appends and records what/where/why/when/who", () => {
    const { handle, project } = setup();
    const entries = listChanges(handle.db, project.id);
    expect(entries.length).toBeGreaterThanOrEqual(2); // creation entry + append
    const e = entries[0];
    expect(e.what).toContain("filler word");
    expect(e.where).toBe("paragraph 3");
    expect(e.why).toBe("transcription cleanup");
    expect(e.authorizedBy).toContain("cleanup_pass_a");
    expect(e.createdAt).toBeTruthy();
  });

  it("rejects UPDATE at the database level", () => {
    const { handle, project } = setup();
    expect(() =>
      handle.sqlite
        .prepare("UPDATE change_log SET what = 'tampered' WHERE project_id = ?")
        .run(project.id),
    ).toThrowError(/append-only/);
    // Nothing changed
    expect(
      listChanges(handle.db, project.id).some((e) => e.what === "tampered"),
    ).toBe(false);
  });

  it("rejects DELETE at the database level while the project exists", () => {
    const { handle, project } = setup();
    expect(() =>
      handle.sqlite
        .prepare("DELETE FROM change_log WHERE project_id = ?")
        .run(project.id),
    ).toThrowError(/append-only/);
    expect(listChanges(handle.db, project.id).length).toBeGreaterThan(0);
  });

  it("still allows deleting a whole project (full purge)", () => {
    const { handle, project } = setup();
    deleteProject(handle, project.id);
    expect(listProjects(handle.db)).toHaveLength(0);
    expect(listChanges(handle.db, project.id)).toHaveLength(0);
  });
});
