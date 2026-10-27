"use client";

import { useRef, useState } from "react";
import {
  confirmOutlineAction,
  saveOutlineEditAction,
} from "@/lib/actions/master";
import { mergeChapters, type OutlineChapter } from "@/lib/master/chapters";

/**
 * The interactive table of contents: drag chapters to reorder, rename them
 * inline, merge one into the previous. Edits stay local until "Save outline"
 * posts them (with a human-readable summary for the change log); "Confirm"
 * locks the structure for master-text generation.
 */
export function OutlineEditor({
  projectId,
  initialChapters,
  status,
}: {
  projectId: string;
  initialChapters: OutlineChapter[];
  status: "proposed" | "confirmed";
}) {
  const [chapters, setChapters] = useState(initialChapters);
  const [edits, setEdits] = useState<string[]>([]);
  const dragFrom = useRef<number | null>(null);
  // Structural comparison, not just recorded edits: a rename is dirty the
  // moment it is typed, before the input ever blurs.
  const dirty = JSON.stringify(chapters) !== JSON.stringify(initialChapters);
  // Renames are derived by diff at submit time; moves/merges are recorded as
  // they happen (their order information is lost in a plain diff).
  const renameEdits = chapters
    .filter((c) => {
      const orig = initialChapters.find((x) => x.id === c.id);
      return orig !== undefined && orig.title !== c.title;
    })
    .map((c) => `Renamed a chapter to "${c.title}"`);
  const editSummary = [...edits, ...renameEdits].join("; ");

  function recordEdit(summary: string) {
    setEdits((e) => [...e, summary]);
  }

  // State updaters must stay pure (StrictMode runs them twice in dev), so the
  // next list and the edit record are computed outside setChapters.
  function onDrop(to: number) {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to) return;
    const next = [...chapters];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setChapters(next);
    recordEdit(`Moved chapter "${moved.title}" to position ${to + 1}`);
  }

  function rename(index: number, title: string) {
    setChapters(chapters.map((c, i) => (i === index ? { ...c, title } : c)));
  }

  function mergeIntoPrevious(index: number) {
    if (index === 0) return;
    const target = chapters[index - 1];
    const source = chapters[index];
    setChapters(mergeChapters(chapters, target.id, source.id));
    recordEdit(`Merged chapter "${source.title}" into "${target.title}"`);
  }

  return (
    <div data-testid="outline-editor">
      <ol className="outline-list">
        {chapters.map((c, i) => (
          <li
            key={c.id}
            draggable
            onDragStart={() => {
              dragFrom.current = i;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(i)}
            className="outline-chapter"
            data-testid={`outline-chapter-${i}`}
          >
            <span className="drag-handle" title="Drag to reorder">
              ⠿
            </span>
            <div className="grow">
              {c.part && <div className="muted outline-part">{c.part}</div>}
              <input
                type="text"
                value={c.title}
                aria-label={`Chapter ${i + 1} title`}
                onChange={(e) => rename(i, e.target.value)}
              />
              {c.summary && <p className="muted outline-summary">{c.summary}</p>}
              <p className="muted outline-meta">
                {c.segmentIds.length} source segment(s)
                {c.themes.length > 0 ? ` · ${c.themes.join(", ")}` : ""}
              </p>
            </div>
            {i > 0 && (
              <button
                type="button"
                onClick={() => mergeIntoPrevious(i)}
                title="Merge this chapter into the one above"
              >
                Merge ↑
              </button>
            )}
          </li>
        ))}
      </ol>

      <div className="row">
        <form action={saveOutlineEditAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="chapters" value={JSON.stringify(chapters)} />
          <input type="hidden" name="editSummary" value={editSummary} />
          <button type="submit" disabled={!dirty}>
            Save outline
          </button>
        </form>
        <form action={confirmOutlineAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <button
            type="submit"
            className="primary"
            disabled={dirty || status === "confirmed"}
            title={dirty ? "Save your edits first" : undefined}
          >
            {status === "confirmed" ? "Outline confirmed" : "Confirm outline"}
          </button>
        </form>
        {dirty && <span className="muted">unsaved edits</span>}
        {status === "confirmed" && !dirty && (
          <span className="badge done">confirmed</span>
        )}
      </div>
    </div>
  );
}
