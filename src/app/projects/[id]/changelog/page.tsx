import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { listChanges } from "@/lib/repo/changeLog";
import { getProject } from "@/lib/repo/projects";
import { CORRECTION_TYPE_LABELS } from "@/lib/transcription/corrections";

export const dynamic = "force-dynamic";

const KNOWN = CORRECTION_TYPE_LABELS as Record<string, string>;

/** Human-readable label for a change's classification, when it has one. */
function categoryLabel(category: string | null): string | null {
  if (!category) return null;
  return KNOWN[category] ? `${category} · ${KNOWN[category]}` : category;
}

export default async function ChangeLogPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const project = getProject(db, id);
  if (!project) notFound();
  // Every project change, newest first — this is the whole audit trail, not
  // just one stage's.
  const changes = listChanges(db, id, 100_000);

  return (
    <div>
      <p>
        <Link href={`/projects/${id}`}>← {project.title}</Link>
      </p>
      <h1>Change log</h1>
      <p className="muted">
        Every change made to this book, in order: what changed, where, why,
        when, and who authorized it. Nothing is ever edited or removed — the log
        is append-only.
      </p>

      {changes.length === 0 ? (
        <div className="card">
          <p className="muted">No changes recorded yet.</p>
        </div>
      ) : (
        <div className="card">
          <p className="muted">{changes.length} entries</p>
          <table className="plain" data-testid="change-log-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>What</th>
                <th>Where</th>
                <th>Why</th>
                <th>Who</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => {
                const label = categoryLabel(c.category);
                return (
                  <tr key={c.id} data-testid="change-log-row">
                    <td>
                      {label ? (
                        <span
                          className="badge in_progress"
                          data-testid="change-category"
                        >
                          {label}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{c.what}</td>
                    <td className="muted">{c.where}</td>
                    <td className="muted">{c.why}</td>
                    <td className="muted">{c.authorizedBy}</td>
                    <td className="muted">
                      {new Date(c.createdAt).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
