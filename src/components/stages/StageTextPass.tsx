import { getModelConfig } from "@/lib/ai/config";
import { estimateCostUsd, estimateTokens, formatUsd } from "@/lib/ai/estimate";
import type { Db } from "@/lib/db/client";
import { getProjectSpend } from "@/lib/repo/aiUsage";
import { listChanges } from "@/lib/repo/changeLog";
import { latestJobForStage } from "@/lib/repo/jobs";
import { hasApiKey } from "@/lib/repo/prefs";
import { latestText } from "@/lib/repo/texts";
import type { StageTextKey } from "@/lib/stages";
import { JobPanel } from "../JobPanel";

/** Shared body for the two text-pass stages (4: cleanup, 5: refine). */
export async function StageTextPass({
  db,
  projectId,
  stage,
  jobType,
  runLabel,
  inputKey,
  outputKey,
  intro,
}: {
  db: Db;
  projectId: string;
  stage: number;
  jobType: string;
  runLabel: string;
  inputKey: StageTextKey;
  outputKey: StageTextKey;
  intro: string;
}) {
  const input = latestText(db, projectId, inputKey);
  const output = latestText(db, projectId, outputKey);
  const latestJob = latestJobForStage(db, projectId, stage);
  const recentChanges = listChanges(db, projectId, 10);
  const keySet = hasApiKey(db);
  const spend = getProjectSpend(db, projectId);
  // Pre-run cost estimate for this large operation, from the configured
  // 'large' role's pricing (spec §9).
  const estimate =
    input && keySet
      ? estimateCostUsd(await getModelConfig(), "large", input.content)
      : undefined;

  return (
    <>
      <div className="card">
        <h2>{runLabel}</h2>
        <p className="muted">{intro}</p>
        {input ? (
          <p className="muted">
            Input: {inputKey} v{input.version} ·{" "}
            {input.content.split(/\s+/).length} words
          </p>
        ) : (
          <p className="muted">No {inputKey} text yet — produce it in the earlier stage.</p>
        )}
        {input && estimate !== undefined && (
          <p data-testid="cost-estimate">
            Running this pass over {input.content.split(/\s+/).length} words (~
            {estimateTokens(input.content)} tokens) will cost approx.{" "}
            <strong>{formatUsd(estimate)}</strong>. AI spend on this project so
            far: {formatUsd(spend)}.
          </p>
        )}
        <JobPanel
          projectId={projectId}
          stage={stage}
          jobType={jobType}
          runLabel={runLabel}
          latestJob={latestJob}
          disabled={!input}
          disabledReason={
            input ? undefined : `The ${inputKey} text must exist before this pass can run.`
          }
        />
      </div>

      {output && (
        <div className="card">
          <h2>Result — {outputKey} v{output.version}</h2>
          <pre className="text-preview">{output.content}</pre>
        </div>
      )}

      {output && (
        <div className="card">
          <h2>Latest audit log entries</h2>
          <table className="plain">
            <tbody>
              {recentChanges.map((c) => (
                <tr key={c.id}>
                  <td>{c.what}</td>
                  <td className="muted">{c.where}</td>
                  <td className="muted">{c.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
