import Link from "next/link";
import { createProjectAction } from "@/lib/actions/projects";
import { getDb } from "@/lib/db/client";
import { getStageStates, listProjects } from "@/lib/repo/projects";
import { getStage, STAGE_COUNT } from "@/lib/stages";
import { DeleteProjectButton } from "@/components/DeleteProjectButton";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const db = getDb();
  const projects = listProjects(db);

  return (
    <div>
      <h1>Your book projects</h1>
      <p className="muted">
        Each project walks the same 8-stage path from raw material to a
        print-ready book. You can close the app at any point — a project always
        remembers where you left off.
      </p>

      <div className="card">
        <h2>Start a new book</h2>
        <form action={createProjectAction} className="row">
          <div className="grow">
            <input
              type="text"
              name="title"
              placeholder="Working title (required)"
              required
            />
          </div>
          <div className="grow">
            <input type="text" name="author" placeholder="Author (optional)" />
          </div>
          <button type="submit" className="primary">
            Create project
          </button>
        </form>
      </div>

      {projects.length === 0 ? (
        <div className="card empty-state">
          <div className="big">📚</div>
          <h2>No projects yet</h2>
          <p className="muted">
            Create your first project above. You&apos;ll be guided from the very
            first step: adding the raw material — transcripts, documents, notes —
            your book will be built from.
          </p>
        </div>
      ) : (
        projects.map((p) => {
          const states = getStageStates(db, p.id);
          const doneCount = states.filter((s) => s.status === "done").length;
          const current = getStage(p.currentStage);
          return (
            <div className="card" key={p.id}>
              <div className="row">
                <div className="grow">
                  <h2>
                    <Link href={`/projects/${p.id}`}>{p.title}</Link>
                  </h2>
                  <p className="muted" style={{ margin: 0 }}>
                    {p.author ? `by ${p.author} · ` : ""}
                    {doneCount === STAGE_COUNT
                      ? "All stages complete 🎉"
                      : `Stage ${p.currentStage} of ${STAGE_COUNT}: ${current?.title ?? ""}`}
                    {" · last touched "}
                    {new Date(p.updatedAt).toLocaleString()}
                  </p>
                  <div className="progress-track">
                    {states.map((s) => (
                      <span
                        key={s.num}
                        className={`seg ${s.status === "done" ? "done" : s.num === p.currentStage ? "current" : ""}`}
                        title={`${s.num}. ${s.title}: ${s.status}`}
                      />
                    ))}
                  </div>
                </div>
                <Link href={`/projects/${p.id}`} className="btn primary">
                  Open
                </Link>
                <DeleteProjectButton projectId={p.id} title={p.title} />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
