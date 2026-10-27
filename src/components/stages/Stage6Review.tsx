import {
  resolveBatchAction,
  resolveReviewAction,
  unlockTextAction,
} from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import type { ReviewItem } from "@/lib/db/schema";
import { latestJobForStage, latestJobOfType } from "@/lib/repo/jobs";
import { getLock } from "@/lib/repo/locks";
import { checkQuoteBalance } from "@/lib/master/normalize";
import { listReviewItems } from "@/lib/repo/review";
import { latestText } from "@/lib/repo/texts";
import { JobPanel } from "../JobPanel";

const SEVERITY_LABEL: Record<string, string> = {
  gross: "Gross",
  medium: "Medium",
  minor: "Minor",
};

export function Stage6Review({ db, projectId }: { db: Db; projectId: string }) {
  const items = listReviewItems(db, projectId);
  const pending = items.filter((i) => i.status === "pending");
  const passB = latestText(db, projectId, "passB");
  const finalText = latestText(db, projectId, "final");
  const finalizeJob = latestJobForStage(db, projectId, 6);
  const passCJob = latestJobOfType(db, projectId, "classify_inconsistencies");
  const lock = getLock(db, projectId);
  const locked = lock?.locked === 1;
  const quote = passB ? checkQuoteBalance(passB.content) : { ok: true, problems: [] };

  // Group Pass C inconsistencies into their approvable batches.
  const batches = new Map<string, ReviewItem[]>();
  const loose: ReviewItem[] = [];
  for (const i of items) {
    if (i.itemType === "inconsistency" && i.batchId) {
      const list = batches.get(i.batchId) ?? [];
      list.push(i);
      batches.set(i.batchId, list);
    } else {
      loose.push(i);
    }
  }

  const clipUrl = (p: string | null) =>
    p ? `/api/projects/${projectId}/clip?path=${encodeURIComponent(p)}` : undefined;

  const resolveButtons = (i: ReviewItem) =>
    i.status === "pending" ? (
      <span className="row" style={{ justifyContent: "flex-end" }}>
        {(["accepted", "rejected"] as const).map((status) => (
          <form action={resolveReviewAction} key={status}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="itemId" value={i.id} />
            <input type="hidden" name="status" value={status} />
            <button type="submit">{status === "accepted" ? "Accept" : "Reject"}</button>
          </form>
        ))}
      </span>
    ) : (
      <span className={`badge ${i.status === "accepted" ? "done" : "failed"}`}>
        {i.status}
      </span>
    );

  return (
    <>
      <div className="card">
        <h2>Consistency check — Pass C</h2>
        <p className="muted">
          Classifies gross inconsistencies by severity and presents them in one
          approvable batch. It only flags — it never changes a word.
        </p>
        <JobPanel
          projectId={projectId}
          stage={6}
          jobType="classify_inconsistencies"
          runLabel="Run Pass C"
          latestJob={passCJob}
          disabled={!passB || locked}
          disabledReason={
            !passB
              ? "There is no Pass B text to check yet."
              : locked
                ? "The text is FINAL and locked."
                : undefined
          }
        />
      </div>

      {[...batches.entries()].map(([batchId, batchItems]) => {
        const batchPending = batchItems.filter((i) => i.status === "pending");
        return (
          <div className="card" key={batchId} data-testid="inconsistency-batch">
            <h2>Inconsistency batch</h2>
            <table className="plain">
              <tbody>
                {batchItems.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.severity && (
                        <span className={`badge severity-${i.severity}`}>
                          {SEVERITY_LABEL[i.severity] ?? i.severity}
                        </span>
                      )}{" "}
                      <strong>{i.question}</strong>
                      {i.excerpt && (
                        <div className="muted" style={{ fontSize: "0.85rem" }}>
                          “{i.excerpt}”
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>{resolveButtons(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {batchPending.length > 0 && (
              <span className="row">
                {(["accepted", "rejected"] as const).map((status) => (
                  <form action={resolveBatchAction} key={status}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="batchId" value={batchId} />
                    <input type="hidden" name="status" value={status} />
                    <button type="submit" className={status === "accepted" ? "primary" : ""}>
                      {status === "accepted" ? "Approve batch" : "Reject batch"} ({batchPending.length})
                    </button>
                  </form>
                ))}
              </span>
            )}
          </div>
        );
      })}

      <div className="card">
        <h2>Review queue</h2>
        {loose.length === 0 ? (
          <p className="muted">
            Nothing else flagged — no reactions or ambiguous questions pending.
          </p>
        ) : (
          <table className="plain">
            <tbody>
              {loose.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.question}</strong>
                    {i.excerpt && (
                      <div className="muted" style={{ fontSize: "0.85rem" }}>
                        “{i.excerpt}”
                      </div>
                    )}
                    {clipUrl(i.clipPath) && (
                      <audio controls preload="none" src={clipUrl(i.clipPath)} />
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>{resolveButtons(i)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Finalize</h2>
        {locked ? (
          <>
            <p>
              <span className="badge done">FINAL v{lock?.lockedVersion} · LOCKED</span>
            </p>
            <p className="muted">
              The text is closed. Reopening is an explicit action and is written
              to the audit log, along with every post-closure touch-up.
            </p>
            <form action={unlockTextAction} className="stack">
              <input type="hidden" name="projectId" value={projectId} />
              <label>
                Reason for reopening{" "}
                <input type="text" name="reason" placeholder="e.g. fix a typo on page 40" />
              </label>
              <button type="submit">Unlock FINAL text</button>
            </form>
          </>
        ) : (
          <>
            <p className="muted">
              Freezes and LOCKS the reviewed text as FINAL. Requires an empty
              review queue and perfectly balanced «» quotes.
            </p>
            {!quote.ok && (
              <div className="error-box">
                <strong>Quotes are unbalanced:</strong> {quote.problems.join(" ")}
              </div>
            )}
            <JobPanel
              projectId={projectId}
              stage={6}
              jobType="finalize_text"
              runLabel="Finalize text"
              latestJob={finalizeJob}
              disabled={pending.length > 0 || !quote.ok}
              disabledReason={
                pending.length > 0
                  ? `${pending.length} item(s) still pending above.`
                  : !quote.ok
                    ? "Resolve the quote imbalance first."
                    : undefined
              }
            />
          </>
        )}
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
