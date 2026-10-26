"use client";

import { deleteProjectAction } from "@/lib/actions/projects";

export function DeleteProjectButton({
  projectId,
  title,
}: {
  projectId: string;
  title: string;
}) {
  return (
    <form
      action={deleteProjectAction}
      onSubmit={(e) => {
        if (
          !confirm(
            `Delete "${title}" and all its data (sources, texts, audit log)? This cannot be undone.`,
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" className="danger">
        Delete
      </button>
    </form>
  );
}
