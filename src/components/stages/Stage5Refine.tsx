import {
  markReactionAction,
  resolveReactionAction,
} from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import { latestJobOfType } from "@/lib/repo/jobs";
import { listReactions } from "@/lib/repo/reactions";
import { listReviewItems } from "@/lib/repo/review";
import { listSources } from "@/lib/repo/sources";
import { latestText } from "@/lib/repo/texts";
import { JobPanel } from "../JobPanel";

/**
 * Stage 5 for the faithful (verbatim/hybrid) path: acoustic reaction detection
 * and confirmation, then Pass B — paragraph breaks and genre formatting with no
 * word changed. The editorial-prose path uses Stage5MasterText instead.
 */
export function Stage5Refine({ db, projectId }: { db: Db; projectId: string }) {
  const passA = latestText(db, projectId, "passA");
  const passB = latestText(db, projectId, "passB");
  const sources = listSources(db, projectId);
  const audioSources = sources.filter(
    (s) => s.mediaType === "audio" || s.mediaType === "video" || s.kind === "audio",
  );
  const detectJob = latestJobOfType(db, projectId, "detect_reactions");
  const refineJob = latestJobOfType(db, projectId, "refine_pass_b");

  const items = listReviewItems(db, projectId);
  const candidates = listReactions(db, projectId, "candidate");
  const confirmed = listReactions(db, projectId, "confirmed");
  const reviewItemByReaction = new Map(
    items.filter((i) => i.itemType === "reaction" && i.refId).map((i) => [i.refId!, i]),
  );

  const clipUrl = (p: string | null) =>
    p ? `/api/projects/${projectId}/clip?path=${encodeURIComponent(p)}` : undefined;

  return (
    <>
      <div className="card">
        <h2>Audience reactions</h2>
        <p className="muted">
          Server-side acoustic detection (no AI) finds candidate laughter and
          applause; each candidate also needs the preceding line to read as
          funny or forceful before it reaches you here, with its audio clip. A
          quiet room produces nothing — mark reactions by hand below.
        </p>
        <JobPanel
          projectId={projectId}
          stage={5}
          jobType="detect_reactions"
          runLabel="Detect reactions"
          latestJob={detectJob}
          disabled={audioSources.length === 0}
          disabledReason={
            audioSources.length === 0
              ? "Add an audio recording in Stage 1 (or mark reactions by hand)."
              : undefined
          }
        />

        {candidates.length > 0 && (
          <table className="plain" data-testid="reaction-candidates">
            <tbody>
              {candidates.map((r) => {
                const item = reviewItemByReaction.get(r.id);
                return (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.kind === "laughter" ? "Laughter" : "Applause"}</strong>
                      <div className="muted" style={{ fontSize: "0.85rem" }}>
                        after “{item?.excerpt ?? ""}” · {r.startMs}–{r.endMs} ms
                      </div>
                      {clipUrl(r.clipPath) && (
                        <audio controls preload="none" src={clipUrl(r.clipPath)} />
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className="row" style={{ justifyContent: "flex-end" }}>
                        <form action={resolveReactionAction}>
                          <input type="hidden" name="projectId" value={projectId} />
                          <input type="hidden" name="reactionId" value={r.id} />
                          <input type="hidden" name="itemId" value={item?.id ?? ""} />
                          <input type="hidden" name="decision" value="confirm" />
                          <button type="submit">Confirm</button>
                        </form>
                        <form action={resolveReactionAction}>
                          <input type="hidden" name="projectId" value={projectId} />
                          <input type="hidden" name="reactionId" value={r.id} />
                          <input type="hidden" name="itemId" value={item?.id ?? ""} />
                          <input type="hidden" name="decision" value="reject" />
                          <button type="submit">Reject</button>
                        </form>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {confirmed.length > 0 && (
          <p className="muted" data-testid="confirmed-reactions">
            {confirmed.length} confirmed reaction(s) will be inserted by Pass B as{" "}
            <em>[Laughter]</em> / <em>[Applause]</em>.
          </p>
        )}

        <details>
          <summary>Mark a reaction by hand (quiet-room path)</summary>
          <form action={markReactionAction} className="stack" style={{ marginTop: "0.5rem" }}>
            <input type="hidden" name="projectId" value={projectId} />
            <label>
              Kind{" "}
              <select name="kind" defaultValue="laughter">
                <option value="laughter">Laughter</option>
                <option value="applause">Applause</option>
              </select>
            </label>
            {audioSources.length > 0 && (
              <label>
                Recording{" "}
                <select name="sourceId" defaultValue="">
                  <option value="">(none — text only)</option>
                  {audioSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              At (ms, optional) <input type="number" name="atMs" min={0} step={1} />
            </label>
            <button type="submit">Mark reaction</button>
          </form>
        </details>
      </div>

      <div className="card">
        <h2>Refine — Pass B</h2>
        <p className="muted">
          Inserts paragraph breaks at discourse anchors and applies genre
          conventions (reactions in italic brackets; interviewer questions in
          bold with an em dash, on their own line). Not a single spoken word
          changes. Ambiguous questions go to the review queue, not the page.
        </p>
        {passA ? (
          <p className="muted">
            Input: passA v{passA.version} · {passA.content.split(/\s+/).length} words
          </p>
        ) : (
          <p className="muted">No Pass A text yet — run Cleanup Pass A first.</p>
        )}
        <JobPanel
          projectId={projectId}
          stage={5}
          jobType="refine_pass_b"
          runLabel="Run Refine Pass B"
          latestJob={refineJob}
          disabled={!passA}
          disabledReason={passA ? undefined : "The passA text must exist first."}
        />
      </div>

      {passB && (
        <div className="card">
          <h2>Result — passB v{passB.version}</h2>
          <pre className="text-preview">{passB.content}</pre>
        </div>
      )}
    </>
  );
}
