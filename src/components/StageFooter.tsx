import Link from "next/link";
import { completeStageAction, reopenStageAction } from "@/lib/actions/projects";
import type { StageState } from "@/lib/repo/projects";

/**
 * Back / complete controls shown under every stage. "Mark complete" is
 * gated server-side: `canComplete` + `blockReason` come from the page.
 */
export function StageFooter({
  projectId,
  stage,
  states,
  canComplete,
  blockReason,
}: {
  projectId: string;
  stage: number;
  states: StageState[];
  canComplete: boolean;
  blockReason?: string;
}) {
  const state = states[stage - 1];
  const isDone = state.status === "done";
  return (
    <div className="card">
      <div className="row">
        {stage > 1 ? (
          <Link href={`/projects/${projectId}/stages/${stage - 1}`} className="btn">
            ← Stage {stage - 1}
          </Link>
        ) : (
          <Link href={`/projects/${projectId}`} className="btn">
            ← Overview
          </Link>
        )}
        <div className="grow" />
        {isDone ? (
          <>
            <span className="badge done">Stage complete ✓</span>
            <form action={reopenStageAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="stage" value={stage} />
              <button type="submit">Reopen this stage</button>
            </form>
            {stage < states.length && (
              <Link href={`/projects/${projectId}/stages/${stage + 1}`} className="btn primary">
                Stage {stage + 1} →
              </Link>
            )}
          </>
        ) : (
          <form action={completeStageAction}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="stage" value={stage} />
            <button
              type="submit"
              className="primary"
              disabled={!canComplete}
              data-testid="complete-stage"
            >
              {stage < states.length
                ? `Mark complete & continue →`
                : "Mark the book finished 🎉"}
            </button>
          </form>
        )}
      </div>
      {!isDone && !canComplete && blockReason && (
        <p className="muted" style={{ marginBottom: 0 }}>
          {blockReason}
        </p>
      )}
    </div>
  );
}
