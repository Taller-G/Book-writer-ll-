import { retryJobAction, runStageJobAction } from "@/lib/actions/jobs";
import type { Job } from "@/lib/db/schema";

const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Queued",
  running: "Running…",
  succeeded: "Succeeded",
  failed: "Failed",
};

/**
 * The stage's job control: run, status of the last attempt, error surface
 * and retry. Server-rendered; actions await job completion.
 */
export function JobPanel({
  projectId,
  stage,
  jobType,
  runLabel,
  latestJob,
  disabled,
  disabledReason,
}: {
  projectId: string;
  stage: number;
  jobType: string;
  runLabel: string;
  latestJob?: Job;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div data-testid={`job-panel-${jobType}`}>
      <div className="row">
        <form action={runStageJobAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="stage" value={stage} />
          <input type="hidden" name="type" value={jobType} />
          <button type="submit" className="primary" disabled={disabled}>
            {latestJob?.status === "succeeded" ? `${runLabel} again` : runLabel}
          </button>
        </form>
        {latestJob && (
          <span className={`badge ${latestJob.status}`} data-testid="job-status">
            {STATUS_LABEL[latestJob.status]}
            {latestJob.attempt > 1 ? ` (attempt ${latestJob.attempt})` : ""}
          </span>
        )}
        {latestJob?.outputVersion != null && (
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            in v{latestJob.inputVersion} → out v{latestJob.outputVersion}
          </span>
        )}
      </div>
      {disabled && disabledReason && <p className="muted">{disabledReason}</p>}
      {latestJob?.status === "failed" && (
        <div className="error-box" data-testid="job-error">
          <strong>The job failed:</strong> {latestJob.error}
          <form action={retryJobAction} style={{ marginTop: "0.5rem" }}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="stage" value={stage} />
            <input type="hidden" name="jobId" value={latestJob.id} />
            <button type="submit" data-testid="job-retry">
              Retry
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
