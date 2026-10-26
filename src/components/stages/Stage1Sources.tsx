import { addSourceAction, removeSourceAction } from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import { latestJobForStage } from "@/lib/repo/jobs";
import { listSources } from "@/lib/repo/sources";
import { latestText } from "@/lib/repo/texts";
import { JobPanel } from "../JobPanel";

export function Stage1Sources({ db, projectId }: { db: Db; projectId: string }) {
  const sources = listSources(db, projectId);
  const raw = latestText(db, projectId, "raw");
  const latestJob = latestJobForStage(db, projectId, 1);

  return (
    <>
      {sources.length === 0 && (
        <div className="card" data-testid="guided-start">
          <h2>👋 Start here</h2>
          <p>
            Everything begins with your raw material. Paste a transcript, a
            document, or your notes below — one source at a time. When they are
            all in, compile them into the <em>raw working text</em> the rest of
            the pipeline builds on.
          </p>
          <ul className="checklist">
            <li>1️⃣ Add each source with a recognizable title</li>
            <li>2️⃣ Press “Compile raw text”</li>
            <li>3️⃣ Mark the stage complete and move to the editorial contract</li>
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Add a source</h2>
        <form action={addSourceAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <div className="row">
            <div className="grow">
              <label htmlFor="src-title">Title</label>
              <input id="src-title" type="text" name="title" required placeholder="e.g. Interview — session 1" />
            </div>
            <div>
              <label htmlFor="src-kind">Type</label>
              <select id="src-kind" name="kind" defaultValue="transcript">
                <option value="transcript">Transcript</option>
                <option value="audio">Audio (transcribed)</option>
                <option value="document">Document</option>
                <option value="notes">Notes</option>
              </select>
            </div>
          </div>
          <label htmlFor="src-content">Content</label>
          <textarea id="src-content" name="content" required placeholder="Paste the text here…" />
          <p>
            <button type="submit" className="primary">Add source</button>
          </p>
        </form>
      </div>

      {sources.length > 0 && (
        <div className="card">
          <h2>Sources ({sources.length})</h2>
          <table className="plain">
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td>{s.title}</td>
                  <td className="muted">{s.kind}</td>
                  <td className="muted">{s.content.split(/\s+/).length} words</td>
                  <td style={{ textAlign: "right" }}>
                    <form action={removeSourceAction}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="sourceId" value={s.id} />
                      <button type="submit" className="danger">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Raw working text</h2>
        <JobPanel
          projectId={projectId}
          stage={1}
          jobType="ingest_sources"
          runLabel="Compile raw text"
          latestJob={latestJob}
        />
        {raw && (
          <>
            <p className="muted">
              raw v{raw.version} · {raw.content.split(/\s+/).length} words ·{" "}
              {new Date(raw.createdAt).toLocaleString()}
            </p>
            <pre className="text-preview">{raw.content}</pre>
          </>
        )}
      </div>
    </>
  );
}
