import { addCoverAction, selectCoverAction, toggleChecklistAction } from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import { latestJobForStage } from "@/lib/repo/jobs";
import { listChecklist, listCovers, listPdfVersions } from "@/lib/repo/output";
import { latestText } from "@/lib/repo/texts";
import { JobPanel } from "../JobPanel";

export function Stage8Export({ db, projectId }: { db: Db; projectId: string }) {
  const exportsList = listPdfVersions(db, projectId);
  const coversList = listCovers(db, projectId);
  const checklist = listChecklist(db, projectId);
  const finalText = latestText(db, projectId, "final");
  const latestJob = latestJobForStage(db, projectId, 8);

  return (
    <>
      <div className="card">
        <h2>Exports</h2>
        <JobPanel
          projectId={projectId}
          stage={8}
          jobType="export_book"
          runLabel="Generate export"
          latestJob={latestJob}
          disabled={!finalText}
          disabledReason={
            finalText ? undefined : "The FINAL text must exist — finish the Review stage first."
          }
        />
        {exportsList.length > 0 && (
          <table className="plain">
            <tbody>
              {exportsList.map((v) => (
                <tr key={v.id}>
                  <td>v{v.version}</td>
                  <td className="muted">{v.filePath}</td>
                  <td className="muted">{v.notes}</td>
                  <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Covers</h2>
        {coversList.length > 0 && (
          <table className="plain">
            <tbody>
              {coversList.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.title}
                    {c.selected === 1 && (
                      <span className="badge done" style={{ marginLeft: "0.5rem" }}>selected</span>
                    )}
                    <div className="muted" style={{ fontSize: "0.85rem" }}>{c.description}</div>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {c.selected !== 1 && (
                      <form action={selectCoverAction}>
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="coverId" value={c.id} />
                        <button type="submit">Select</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form action={addCoverAction} className="row" style={{ marginTop: "0.6rem" }}>
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grow">
            <input type="text" name="title" placeholder="Cover concept title" required />
          </div>
          <div className="grow">
            <input type="text" name="description" placeholder="Short description" />
          </div>
          <button type="submit">Add cover concept</button>
        </form>
      </div>

      <div className="card">
        <h2>Final checklist</h2>
        <ul className="checklist">
          {checklist.map((item) => (
            <li key={item.id}>
              <form action={toggleChecklistAction} style={{ display: "inline" }}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="itemId" value={item.id} />
                <input type="hidden" name="done" value={item.done ? "false" : "true"} />
                <button
                  type="submit"
                  style={{ border: "none", background: "none", cursor: "pointer", padding: 0 }}
                  aria-label={item.done ? `Uncheck ${item.label}` : `Check ${item.label}`}
                >
                  {item.done ? "✅" : "⬜"}
                </button>
              </form>{" "}
              <span style={item.done ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}>
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
