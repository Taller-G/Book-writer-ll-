import { resolveReviewAction } from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import { latestJobForStage } from "@/lib/repo/jobs";
import { listReviewItems } from "@/lib/repo/review";
import { latestText } from "@/lib/repo/texts";
import { JobPanel } from "../JobPanel";

export function Stage6Review({ db, projectId }: { db: Db; projectId: string }) {
  const items = listReviewItems(db, projectId);
  const pending = items.filter((i) => i.status === "pending");
  const finalText = latestText(db, projectId, "final");
  const latestJob = latestJobForStage(db, projectId, 6);

  return (
    <>
      <div className="card">
        <h2>Review queue</h2>
        {items.length === 0 ? (
          <p className="muted">
            Nothing was flagged for review — the refine pass had no doubts.
          </p>
        ) : (
          <table className="plain">
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.question}</strong>
                    {i.excerpt && (
                      <div className="muted" style={{ fontSize: "0.85rem" }}>
                        “{i.excerpt}”
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {i.status === "pending" ? (
                      <span className="row" style={{ justifyContent: "flex-end" }}>
                        <form action={resolveReviewAction}>
                          <input type="hidden" name="projectId" value={projectId} />
                          <input type="hidden" name="itemId" value={i.id} />
                          <input type="hidden" name="status" value="accepted" />
                          <button type="submit">Accept</button>
                        </form>
                        <form action={resolveReviewAction}>
                          <input type="hidden" name="projectId" value={projectId} />
                          <input type="hidden" name="itemId" value={i.id} />
                          <input type="hidden" name="status" value="rejected" />
                          <button type="submit">Reject</button>
                        </form>
                      </span>
                    ) : (
                      <span className={`badge ${i.status === "accepted" ? "done" : "failed"}`}>
                        {i.status}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Finalize</h2>
        <p className="muted">
          Freezes the reviewed text as FINAL. Requires an empty review queue.
        </p>
        <JobPanel
          projectId={projectId}
          stage={6}
          jobType="finalize_text"
          runLabel="Finalize text"
          latestJob={latestJob}
          disabled={pending.length > 0}
          disabledReason={
            pending.length > 0
              ? `${pending.length} item(s) still pending above.`
              : undefined
          }
        />
        {finalText && (
          <>
            <p className="muted">FINAL v{finalText.version} frozen.</p>
            <pre className="text-preview">{finalText.content}</pre>
          </>
        )}
      </div>
    </>
  );
}
