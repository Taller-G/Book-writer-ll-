import {
  addSourceAction,
  linkSourcesAction,
  removeSourceAction,
  unlinkSourceAction,
  verifySourceAction,
} from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import type { Source } from "@/lib/db/schema";
import { latestJobForStage, latestJobOfType } from "@/lib/repo/jobs";
import { listSources } from "@/lib/repo/sources";
import { latestText } from "@/lib/repo/texts";
import { JobPanel } from "../JobPanel";
import { SourceDropzone } from "../SourceDropzone";

function isMediaSource(s: Source): boolean {
  return s.mediaType === "audio" || s.mediaType === "video";
}

function fmtMinutes(seconds: number): string {
  const min = seconds / 60;
  if (min < 1) return `${Math.round(seconds)} s`;
  return `${Math.round(min)} min`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtRange(mins: number[]): string {
  const lo = Math.round(Math.min(...mins));
  const hi = Math.round(Math.max(...mins));
  if (hi < 1) return "under a minute";
  return lo === hi ? `${hi} min` : `${Math.max(lo, 1)}–${hi} min`;
}

/** "You have 5 sources: 2 recordings of 15–62 min, 2 transcripts, …" */
function inventorySummary(sources: Source[]): string {
  if (sources.length === 0) return "";
  const media = sources.filter(isMediaSource);
  const transcripts = sources.filter(
    (s) => !isMediaSource(s) && s.kind === "transcript",
  );
  const documents = sources.filter(
    (s) =>
      !isMediaSource(s) &&
      s.kind !== "transcript" &&
      s.mediaType !== "image",
  );
  const images = sources.filter((s) => s.mediaType === "image");
  const parts: string[] = [];
  if (media.length > 0) {
    const mins = media
      .filter((s) => s.durationSeconds != null)
      .map((s) => s.durationSeconds! / 60);
    parts.push(
      `${media.length} recording${media.length > 1 ? "s" : ""}${
        mins.length > 0 ? ` of ${fmtRange(mins)}` : ""
      }`,
    );
  }
  if (transcripts.length > 0) {
    parts.push(`${transcripts.length} transcript${transcripts.length > 1 ? "s" : ""}`);
  }
  if (documents.length > 0) {
    const words = documents.reduce((n, s) => n + (s.wordCount ?? 0), 0);
    parts.push(
      `${documents.length} document${documents.length > 1 ? "s" : ""}${
        words > 0 ? ` (${words.toLocaleString("en-US")} words)` : ""
      }`,
    );
  }
  if (images.length > 0) {
    parts.push(`${images.length} image${images.length > 1 ? "s" : ""}`);
  }
  return `You have ${sources.length} source${sources.length > 1 ? "s" : ""}: ${parts.join(", ")}.`;
}

function parseMeta(s: Source): {
  note?: string;
  lastVerifiedAt?: string;
  lastVerifiedOk?: boolean;
} {
  try {
    return JSON.parse(s.metadata);
  } catch {
    return {};
  }
}

const LANGUAGE_NAMES: Record<string, string> = { es: "Spanish", en: "English" };

function SourceCard({
  source,
  all,
  projectId,
}: {
  source: Source;
  all: Source[];
  projectId: string;
}) {
  const meta = parseMeta(source);
  const linked = source.linkedSourceId
    ? all.find((s) => s.id === source.linkedSourceId)
    : undefined;
  const linkCandidates =
    source.originalPath && !source.linkedSourceId
      ? all.filter(
          (s) =>
            s.id !== source.id &&
            s.originalPath &&
            !s.linkedSourceId &&
            isMediaSource(s) !== isMediaSource(source),
        )
      : [];

  return (
    <div className="card source-card" data-testid="source-card">
      <div className="row">
        <div className="grow">
          <h3>{source.title}</h3>
          <p className="muted">
            <span className="badge in_progress">
              {source.mediaType ?? "pasted"}
            </span>{" "}
            {source.originalName && <>{source.originalName} · </>}
            {source.sizeBytes != null && <>{fmtSize(source.sizeBytes)} · </>}
            {source.durationSeconds != null && (
              <>{fmtMinutes(source.durationSeconds)} · </>
            )}
            {source.wordCount != null && (
              <>{source.wordCount.toLocaleString("en-US")} words · </>
            )}
            {source.language && (
              <>{LANGUAGE_NAMES[source.language] ?? source.language} · </>
            )}
            {source.kind}
          </p>
        </div>
        <form action={removeSourceAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="sourceId" value={source.id} />
          <button type="submit" className="danger">Remove</button>
        </form>
      </div>

      {meta.note && <p className="muted">⚠ {meta.note}</p>}

      {source.checksumSha1 && (
        <div className="muted mono source-checksum">
          <span>sha1 {source.checksumSha1}</span>
          <form action={verifySourceAction} style={{ display: "inline" }}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="sourceId" value={source.id} />
            <button type="submit">Verify integrity</button>
          </form>
          {meta.lastVerifiedAt && (
            <span
              className={meta.lastVerifiedOk ? "verify-ok" : "verify-fail"}
              data-testid="verify-result"
            >
              {meta.lastVerifiedOk
                ? `✓ verified ${new Date(meta.lastVerifiedAt).toLocaleString()}`
                : "✕ CHECKSUM MISMATCH — the original changed on disk"}
            </span>
          )}
        </div>
      )}

      {linked && (
        <div data-testid="link-info" className="source-link">
          🔗 Linked with <strong>{linked.title}</strong>{" "}
          <span className="muted">
            ({isMediaSource(source) ? "its transcript" : "its recording"})
          </span>{" "}
          <form action={unlinkSourceAction} style={{ display: "inline" }}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="sourceId" value={source.id} />
            <button type="submit">Unlink</button>
          </form>
        </div>
      )}

      {linkCandidates.length > 0 && (
        <form action={linkSourcesAction} className="row">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="sourceId" value={source.id} />
          <select name="otherId" defaultValue="">
            <option value="" disabled>
              Link with {isMediaSource(source) ? "a transcript…" : "a recording…"}
            </option>
            {linkCandidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <button type="submit">Link</button>
        </form>
      )}
    </div>
  );
}

export function Stage1Sources({ db, projectId }: { db: Db; projectId: string }) {
  const sources = listSources(db, projectId);
  const raw = latestText(db, projectId, "raw");
  const latestJob = latestJobForStage(db, projectId, 1);
  // Recordings still awaiting a transcript — the ASR job fills these in.
  const untranscribed = sources.filter(
    (s) =>
      (s.mediaType === "audio" || s.mediaType === "video") &&
      !!s.originalPath &&
      s.content.trim() === "",
  );
  const transcribeJob = latestJobOfType(db, projectId, "transcribe_audio");

  return (
    <>
      {sources.length === 0 && (
        <div className="card" data-testid="guided-start">
          <h2>👋 Start here</h2>
          <p>
            Everything begins with your raw material. Drop your recordings,
            transcripts, documents and images below — originals are stored
            untouched with a checksum, and all work happens on derived copies.
            You can also paste text directly.
          </p>
          <ul className="checklist">
            <li>1️⃣ Upload or paste each source</li>
            <li>2️⃣ Check the inventory and audio↔transcript links</li>
            <li>3️⃣ Press “Compile raw text” and move on</li>
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Upload sources</h2>
        <SourceDropzone projectId={projectId} />
      </div>

      <details className="card">
        <summary>
          <strong>Or paste text directly</strong>
        </summary>
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
      </details>

      {sources.length > 0 && (
        <div className="card">
          <h2>Inventory ({sources.length})</h2>
          <p data-testid="inventory-summary">{inventorySummary(sources)}</p>
          {sources.map((s) => (
            <SourceCard key={s.id} source={s} all={sources} projectId={projectId} />
          ))}
        </div>
      )}

      {(untranscribed.length > 0 || transcribeJob) && (
        <div className="card" data-testid="transcribe-card">
          <h2>Transcribe recordings</h2>
          <p className="muted">
            {untranscribed.length > 0
              ? `${untranscribed.length} recording(s) have no transcript yet. ` +
                "Automatic speech recognition turns them into text with " +
                "word-level timestamps, recording every step in the audit log."
              : "All recordings have been transcribed."}
          </p>
          <JobPanel
            projectId={projectId}
            stage={1}
            jobType="transcribe_audio"
            runLabel="Transcribe recordings"
            latestJob={transcribeJob}
            disabled={untranscribed.length === 0}
            disabledReason={
              untranscribed.length === 0
                ? "There are no untranscribed recordings."
                : undefined
            }
          />
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
