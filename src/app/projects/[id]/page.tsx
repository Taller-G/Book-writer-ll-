import Link from "next/link";
import { notFound } from "next/navigation";
import { formatUsd } from "@/lib/ai/estimate";
import { getDb } from "@/lib/db/client";
import { getProjectOverview } from "@/lib/overview";
import { getProjectSpend } from "@/lib/repo/aiUsage";
import { STAGE_STATUS_LABELS } from "@/lib/stages";
import { DeleteProjectButton } from "@/components/DeleteProjectButton";

export const dynamic = "force-dynamic";

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const overview = getProjectOverview(db, id);
  if (!overview) notFound();
  const aiSpend = getProjectSpend(db, id);

  const { project, stages, doneCount, resumeStage, nextAction } = overview;

  return (
    <div>
      <p>
        <Link href="/">← All projects</Link>
      </p>
      <div className="row">
        <div className="grow">
          <h1>{project.title}</h1>
          {project.author && <p className="muted">by {project.author}</p>}
        </div>
        <DeleteProjectButton projectId={project.id} title={project.title} />
      </div>

      <div className="card" data-testid="resume-summary">
        <h2>Where we are</h2>
        <p>
          <strong>
            {doneCount} of {stages.length} stages done.
          </strong>{" "}
          {overview.allDone
            ? "Every stage is complete."
            : `You are on stage ${resumeStage}: ${stages[resumeStage - 1].title}.`}
        </p>
        <div className="progress-track">
          {stages.map((s) => (
            <span
              key={s.num}
              className={`seg ${s.status === "done" ? "done" : s.num === resumeStage ? "current" : ""}`}
            />
          ))}
        </div>
        <p>
          <strong>Next:</strong> {nextAction}
        </p>
        <p className="muted">
          {overview.sourceCount} source(s) ·{" "}
          <Link href={`/projects/${project.id}/changelog`} data-testid="changelog-link">
            {overview.changeCount} audit log entries
          </Link>{" "}
          · {overview.pendingReviews} pending review(s) ·{" "}
          <span data-testid="ai-spend">AI spend: {formatUsd(aiSpend)}</span>
          {overview.latestJob &&
            ` · last job: ${overview.latestJob.type} (${overview.latestJob.status})`}
        </p>
        <Link
          href={`/projects/${project.id}/stages/${resumeStage}`}
          className="btn primary"
          data-testid="continue-button"
        >
          Continue → Stage {resumeStage}: {stages[resumeStage - 1].title}
        </Link>
      </div>

      <div className="card">
        <h2>What&apos;s left</h2>
        <table className="plain">
          <tbody>
            {stages.map((s) => (
              <tr key={s.num}>
                <td style={{ width: "2rem" }} className="muted">
                  {s.num}
                </td>
                <td>
                  {s.status === "locked" ? (
                    <span>{s.title}</span>
                  ) : (
                    <Link href={`/projects/${project.id}/stages/${s.num}`}>
                      {s.title}
                    </Link>
                  )}
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {s.short}
                  </div>
                </td>
                <td style={{ textAlign: "right" }}>
                  <span className={`badge ${s.status}`}>
                    {STAGE_STATUS_LABELS[s.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {overview.recentChanges.length > 0 && (
        <div className="card">
          <h2>Recent activity</h2>
          <table className="plain">
            <tbody>
              {overview.recentChanges.map((c) => (
                <tr key={c.id}>
                  <td>{c.what}</td>
                  <td className="muted">{c.where}</td>
                  <td className="muted">
                    {new Date(c.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
