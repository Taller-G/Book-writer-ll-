import { resolveReviewAction, resolveReviewBatchAction } from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import type { ReviewItem } from "@/lib/db/schema";
import { latestJobForStage } from "@/lib/repo/jobs";
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
  punctuation: "Punctuation",
  orthotypography: "Punctuation",
  image: "Low-DPI image",
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

function ClipPlayerFor({
  db,
  projectId,
  item,
}: {
  db: Db;
  projectId: string;
  item: ReviewItem;
}) {
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
  const pendingPunct = pending.filter((i) => PUNCTUATION_TYPES.has(i.itemType));
  const pendingOther = pending.filter((i) => !PUNCTUATION_TYPES.has(i.itemType));
  const finalText = latestText(db, projectId, "final");
  const latestJob = latestJobForStage(db, projectId, 6);

  const pct = progress.total === 0 ? 100 : Math.round((progress.resolved / progress.total) * 100);

  return (
    <>
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
        <p className="muted">
          Freezes the reviewed text as FINAL. Requires an empty review queue.
        </p>
        <JobPanel
          projectId={projectId}
          stage={6}
          jobType="finalize_text"
          runLabel="Finalize text"
          latestJob={latestJob}
          disabled={progress.pending > 0}
          disabledReason={
            progress.pending > 0
              ? `${progress.pending} review item(s) still pending above.`
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
