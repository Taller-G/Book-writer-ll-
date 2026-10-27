import {
  resolveBatchAction,
  resolveReactionAction,
  resolveReviewAction,
  resolveReviewBatchAction,
  unlockTextAction,
} from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import type { ReviewItem } from "@/lib/db/schema";
import { checkQuoteBalance } from "@/lib/master/normalize";
import { latestJobForStage, latestJobOfType } from "@/lib/repo/jobs";
import { getLock } from "@/lib/repo/locks";
import { listReviewItems, parseOptions, reviewProgress } from "@/lib/repo/review";
import { getSource } from "@/lib/repo/sources";
import { latestText } from "@/lib/repo/texts";
import {
  locateClipWindow,
  parseTranscriptSegments,
  type ClipWindow,
} from "@/lib/review/clip";
import { JobPanel } from "../JobPanel";
import { ReviewClipPlayer } from "../ReviewClipPlayer";

// Producer types whose items are resolved in bulk rather than one-by-one.
const PUNCTUATION_TYPES = new Set(["punctuation", "orthotypography"]);

const TYPE_LABELS: Record<string, string> = {
  edit: "Edit",
  structure: "Structure",
  audio: "Audio doubt",
  reaction: "Reaction",
  question: "Ambiguous question",
  inconsistency: "Inconsistency",
  punctuation: "Punctuation",
  orthotypography: "Punctuation",
  image: "Low-DPI image",
};

const SEVERITY_LABEL: Record<string, string> = {
  gross: "Gross",
  medium: "Medium",
  minor: "Minor",
};

function typeLabel(itemType: string): string {
  return TYPE_LABELS[itemType] ?? itemType;
}

/** Hidden projectId + itemId fields repeated in every resolution form. */
function ItemFields({ projectId, itemId }: { projectId: string; itemId: string }) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="itemId" value={itemId} />
    </>
  );
}

/** A reaction/question clip stored as a derived WAV, served by the clip route. */
function DerivedClip({ projectId, clipPath }: { projectId: string; clipPath: string }) {
  return (
    <audio
      controls
      preload="none"
      src={`/api/projects/${projectId}/clip?path=${encodeURIComponent(clipPath)}`}
    />
  );
}

function ClipPlayerFor({
  db,
  projectId,
  item,
}: {
  db: Db;
  projectId: string;
  item: ReviewItem;
}) {
  // Reaction / ambiguous-question items carry their own extracted clip.
  if (item.clipPath) {
    return <DerivedClip projectId={projectId} clipPath={item.clipPath} />;
  }
  if (!item.sourceId) return null;
  const source = getSource(db, item.sourceId);
  if (!source) return null;
  const segments = parseTranscriptSegments(source.metadata);
  const window: ClipWindow = locateClipWindow(segments, {
    anchorBefore: item.anchorBefore,
    anchorAfter: item.anchorAfter,
    rawTimestamp: item.rawTimestamp,
  });
  if (window.locatedBy === "none") return null;
  return (
    <ReviewClipPlayer
      src={`/api/projects/${projectId}/sources/${item.sourceId}/audio`}
      start={window.start}
      end={window.end}
      locatedBy={window.locatedBy}
    />
  );
}

/** A detected audience reaction: confirming it flips the reaction row so Pass B
 *  inserts it, which the generic resolution path would not do. */
function ReactionCard({
  projectId,
  item,
}: {
  projectId: string;
  item: ReviewItem;
}) {
  return (
    <div className="card review-card" data-testid="reaction-card">
      <div className="row" style={{ alignItems: "baseline" }}>
        <span className="badge">{typeLabel(item.itemType)}</span>
        <strong>{item.question}</strong>
      </div>
      {item.excerpt && <p className="muted">“{item.excerpt}”</p>}
      {item.clipPath && <DerivedClip projectId={projectId} clipPath={item.clipPath} />}
      <div className="row review-actions">
        {(["confirm", "reject"] as const).map((decision) => (
          <form action={resolveReactionAction} key={decision}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="reactionId" value={item.refId ?? ""} />
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="decision" value={decision} />
            <button type="submit" className={decision === "confirm" ? "primary" : ""}>
              {decision === "confirm" ? "Confirm" : "Reject"}
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}

/** One actionable card: the doubtful span in context, the audio clip, and the
 *  full set of resolution choices. */
function ReviewCard({
  db,
  projectId,
  item,
}: {
  db: Db;
  projectId: string;
  item: ReviewItem;
}) {
  const options = parseOptions(item);
  return (
    <div className="card review-card">
      <div className="row" style={{ alignItems: "baseline" }}>
        <span className="badge">{typeLabel(item.itemType)}</span>
        <strong>{item.question}</strong>
      </div>

      {item.doubtfulText ? (
        <p className="doubt-context">
          {item.contextBefore}
          <mark>{item.doubtfulText}</mark>
          {item.contextAfter}
        </p>
      ) : item.excerpt ? (
        <p className="muted">“{item.excerpt}”</p>
      ) : null}

      <ClipPlayerFor db={db} projectId={projectId} item={item} />

      <div className="row review-actions">
        {options.map((option, idx) => (
          <form action={resolveReviewAction} key={option.id}>
            <ItemFields projectId={projectId} itemId={item.id} />
            <input
              type="hidden"
              name="resolution"
              value={idx === 0 ? "option_a" : "option_b"}
            />
            <input type="hidden" name="value" value={option.id} />
            <button type="submit">{option.label}</button>
          </form>
        ))}

        <form action={resolveReviewAction}>
          <ItemFields projectId={projectId} itemId={item.id} />
          <input type="hidden" name="resolution" value="leave_as_is" />
          <button type="submit">Leave as is</button>
        </form>

        <form action={resolveReviewAction}>
          <ItemFields projectId={projectId} itemId={item.id} />
          <input type="hidden" name="resolution" value="cut_sentence" />
          <button type="submit" className="danger">
            Cut this sentence
          </button>
        </form>

        <form action={resolveReviewAction} className="row free-text-form">
          <ItemFields projectId={projectId} itemId={item.id} />
          <input type="hidden" name="resolution" value="free_text" />
          <input
            type="text"
            name="value"
            placeholder="…or type a replacement"
            aria-label="Free-text replacement"
          />
          <button type="submit">Apply text</button>
        </form>
      </div>
    </div>
  );
}

export function Stage6Review({ db, projectId }: { db: Db; projectId: string }) {
  const items = listReviewItems(db, projectId);
  const progress = reviewProgress(db, projectId);
  const pending = items.filter((i) => i.status === "pending");
  const resolved = items.filter((i) => i.status !== "pending");
  const passB = latestText(db, projectId, "passB");
  const finalText = latestText(db, projectId, "final");
  const finalizeJob = latestJobForStage(db, projectId, 6);
  const passCJob = latestJobOfType(db, projectId, "classify_inconsistencies");
  const lock = getLock(db, projectId);
  const locked = lock?.locked === 1;
  const quote = passB ? checkQuoteBalance(passB.content) : { ok: true, problems: [] };

  // Pass C inconsistencies are grouped into their approvable batches; the rest
  // of the pending items split into punctuation (bulk), reactions (their own
  // card) and everything else (the generic doubt card).
  const batches = new Map<string, ReviewItem[]>();
  for (const i of items) {
    if (i.itemType === "inconsistency" && i.batchId) {
      const list = batches.get(i.batchId) ?? [];
      list.push(i);
      batches.set(i.batchId, list);
    }
  }
  const pendingPunct = pending.filter((i) => PUNCTUATION_TYPES.has(i.itemType));
  const pendingReactions = pending.filter((i) => i.itemType === "reaction");
  const pendingOther = pending.filter(
    (i) =>
      !PUNCTUATION_TYPES.has(i.itemType) &&
      i.itemType !== "reaction" &&
      i.itemType !== "inconsistency",
  );

  const pct = progress.total === 0 ? 100 : Math.round((progress.resolved / progress.total) * 100);

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

      <div className="card">
        <h2>Review queue</h2>
        <p className="muted">
          The unified inbox of human decisions — every doubt from every stage,
          resolvable in seconds.
        </p>
        {progress.total === 0 ? (
          <p className="muted">Nothing is flagged for review. The queue is empty.</p>
        ) : (
          <>
            <div className="row" style={{ alignItems: "baseline" }}>
              <strong>
                {progress.resolved}/{progress.total} resolved
              </strong>
              <span className="grow" />
              <span className={`badge ${progress.pending === 0 ? "done" : "queued"}`}>
                {progress.pending} pending
              </span>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: "0.4rem", marginTop: "0.6rem" }}>
              {Object.entries(progress.byType).map(([type, counts]) => (
                <span key={type} className="review-chip">
                  {typeLabel(type)}: {counts.total - counts.pending}/{counts.total}
                </span>
              ))}
            </div>
          </>
        )}
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
                    <td style={{ textAlign: "right" }}>
                      {i.status === "pending" ? (
                        <span className="row" style={{ justifyContent: "flex-end" }}>
                          {(["accepted", "rejected"] as const).map((status) => (
                            <form action={resolveReviewAction} key={status}>
                              <ItemFields projectId={projectId} itemId={i.id} />
                              <input type="hidden" name="status" value={status} />
                              <button type="submit">
                                {status === "accepted" ? "Accept" : "Reject"}
                              </button>
                            </form>
                          ))}
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

      {pendingPunct.length > 0 && (
        <div className="card">
          <h2>Punctuation batch</h2>
          <p className="muted">
            {pendingPunct.length} punctuation suggestion(s) — approve or reject
            them all in one go, or resolve individually below.
          </p>
          <div className="row">
            <form action={resolveReviewBatchAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="resolution" value="approve" />
              {pendingPunct.map((i) => (
                <input key={i.id} type="hidden" name="itemId" value={i.id} />
              ))}
              <button type="submit" className="primary">
                Approve all {pendingPunct.length}
              </button>
            </form>
            <form action={resolveReviewBatchAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="resolution" value="reject" />
              {pendingPunct.map((i) => (
                <input key={i.id} type="hidden" name="itemId" value={i.id} />
              ))}
              <button type="submit">Reject all {pendingPunct.length}</button>
            </form>
          </div>
          <ul className="muted" style={{ marginBottom: 0 }}>
            {pendingPunct.map((i) => (
              <li key={i.id}>{i.question}</li>
            ))}
          </ul>
        </div>
      )}

      {pendingReactions.map((item) => (
        <ReactionCard key={item.id} projectId={projectId} item={item} />
      ))}

      {pendingOther.map((item) => (
        <ReviewCard key={item.id} db={db} projectId={projectId} item={item} />
      ))}

      {resolved.length > 0 && (
        <details className="card">
          <summary>{resolved.length} resolved item(s)</summary>
          <table className="plain">
            <tbody>
              {resolved.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.question}
                    {i.resolutionNote && (
                      <div className="muted" style={{ fontSize: "0.8rem" }}>
                        {i.resolutionNote}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <span className={`badge ${i.status === "accepted" ? "done" : "failed"}`}>
                      {i.resolution ?? i.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

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
              disabled={progress.pending > 0 || !quote.ok}
              disabledReason={
                progress.pending > 0
                  ? `${progress.pending} item(s) still pending above.`
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
