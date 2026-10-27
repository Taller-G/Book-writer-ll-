import { addCoverAction, selectCoverAction, toggleChecklistAction } from "@/lib/actions/content";
import {
  confirmContentAction,
  rejectContentAction,
  rollbackPdfAction,
} from "@/lib/actions/correction";
import type { Db } from "@/lib/db/client";
import type { CorrectionMessage, PdfVersion } from "@/lib/db/schema";
import { getPageSize, parseFormatData } from "@/lib/format/config";
import { listCorrectionMessages } from "@/lib/repo/correction";
import { latestJobForStage } from "@/lib/repo/jobs";
import {
  getFormatConfig,
  latestPdfVersion,
  listChecklist,
  listCovers,
  listPdfVersions,
} from "@/lib/repo/output";
import { parsePages } from "@/lib/preview/diff";
import { latestText } from "@/lib/repo/texts";
import { JobPanel } from "../JobPanel";
import { PdfCorrectionViewer } from "./PdfCorrectionViewer";

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface StoredQa {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}
interface StoredDiff {
  changedPages: number[];
  addedPages: number[];
  removedPages: number[];
  oldPageCount: number;
  newPageCount: number;
}

function diffSummary(diff: StoredDiff): string {
  const parts: string[] = [`${diff.newPageCount} page(s)`];
  const changed = [...diff.changedPages];
  if (changed.length) parts.push(`changed: ${changed.join(", ")}`);
  if (diff.addedPages.length) parts.push(`added: ${diff.addedPages.join(", ")}`);
  if (diff.removedPages.length)
    parts.push(`removed: ${diff.removedPages.join(", ")}`);
  if (changed.length + diff.addedPages.length + diff.removedPages.length === 0) {
    parts.push("no page changes");
  }
  return parts.join(" · ");
}

function ConversationMessage({
  projectId,
  m,
}: {
  projectId: string;
  m: CorrectionMessage;
}) {
  const isAgent = m.role === "agent";
  return (
    <div
      className="card"
      style={{
        marginLeft: isAgent ? 0 : "2rem",
        marginRight: isAgent ? "2rem" : 0,
        background: isAgent ? "var(--panel, #f6f6f6)" : undefined,
      }}
    >
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{isAgent ? "Agent" : "You"}</strong>
        <span className="row" style={{ gap: "0.3rem" }}>
          {m.classification && (
            <span className={`badge ${m.classification === "content" ? "failed" : "done"}`}>
              {m.classification}
            </span>
          )}
          {m.pageNumber != null && (
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              page {m.pageNumber}
            </span>
          )}
        </span>
      </div>
      {m.body && <p style={{ margin: "0.4rem 0" }}>{m.body}</p>}
      {m.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={m.image}
          alt="annotation"
          style={{ maxHeight: 80, border: "1px solid #ccc" }}
        />
      )}
      {m.status === "awaiting_confirmation" && (
        <div className="error-box" style={{ marginTop: "0.5rem" }}>
          <strong>This modifies {m.targetRef ?? "the master text"}.</strong> Confirm
          before the closed text is changed.
          <div className="row" style={{ marginTop: "0.5rem" }}>
            <form action={confirmContentAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="messageId" value={m.id} />
              <button type="submit" className="primary">
                Confirm — modify {m.targetRef ?? "text"}
              </button>
            </form>
            <form action={rejectContentAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="messageId" value={m.id} />
              <button type="submit">Reject</button>
            </form>
          </div>
        </div>
      )}
      {m.status === "applied" && (
        <span className="badge done">
          applied{m.pdfVersion ? ` → v${m.pdfVersion}` : ""}
        </span>
      )}
      {m.status === "rejected" && <span className="badge failed">rejected</span>}
    </div>
  );
}

export function Stage8Export({ db, projectId }: { db: Db; projectId: string }) {
  const exportsList = listPdfVersions(db, projectId);
  const coversList = listCovers(db, projectId);
  const checklist = listChecklist(db, projectId);
  const finalText = latestText(db, projectId, "final");
  const latestJob = latestJobForStage(db, projectId, 8);

  const latest = latestPdfVersion(db, projectId);
  const pages = parsePages(latest?.pages).map((p) => p.text);
  const format = parseFormatData(getFormatConfig(db, projectId).data);
  const size = getPageSize(format.pageSize);
  const aspect = size.heightMm / size.widthMm;
  const conversation = listCorrectionMessages(db, projectId);

  return (
    <>
      <div className="card">
        <h2>Exports</h2>
        <JobPanel
          projectId={projectId}
          stage={8}
          jobType="export_book"
          runLabel="Generate export"
          latestJob={latestJob}
          disabled={!finalText}
          disabledReason={
            finalText ? undefined : "The FINAL text must exist — finish the Review stage first."
          }
        />
      </div>

      <div className="card">
        <h2>PDF preview &amp; corrections</h2>
        <PdfCorrectionViewer
          projectId={projectId}
          pages={pages}
          aspect={aspect}
          version={latest?.version ?? null}
        />
      </div>

      {conversation.length > 0 && (
        <div className="card">
          <h2>Conversation</h2>
          {conversation.map((m) => (
            <ConversationMessage key={m.id} projectId={projectId} m={m} />
          ))}
        </div>
      )}

      {exportsList.length > 0 && (
        <div className="card">
          <h2>Version history</h2>
          <table className="plain">
            <thead>
              <tr>
                <th>Version</th>
                <th>Kind</th>
                <th>Pages &amp; diff</th>
                <th>QA</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {exportsList.map((v: PdfVersion, i) => {
                const qa = safeJson<StoredQa>(v.qa, { ok: true, checks: [] });
                const diff = safeJson<StoredDiff>(v.diff, {
                  changedPages: [],
                  addedPages: [],
                  removedPages: [],
                  oldPageCount: 0,
                  newPageCount: v.pageCount,
                });
                const isLatest = i === 0;
                return (
                  <tr key={v.id}>
                    <td>
                      v{v.version}
                      {v.rolledBackFrom != null && (
                        <span className="muted"> (from v{v.rolledBackFrom})</span>
                      )}
                      {isLatest && (
                        <span className="badge done" style={{ marginLeft: "0.4rem" }}>
                          current
                        </span>
                      )}
                    </td>
                    <td className="muted">{v.kind}</td>
                    <td className="muted" style={{ fontSize: "0.85rem" }}>
                      {diffSummary(diff)}
                    </td>
                    <td>
                      <span className={`badge ${qa.ok ? "done" : "failed"}`}>
                        {qa.ok ? "passed" : "failed"}
                      </span>
                      {!qa.ok && (
                        <div className="muted" style={{ fontSize: "0.8rem" }}>
                          {qa.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {!isLatest && (
                        <form action={rollbackPdfAction}>
                          <input type="hidden" name="projectId" value={projectId} />
                          <input type="hidden" name="version" value={v.version} />
                          <button type="submit">Roll back to v{v.version}</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Covers</h2>
        {coversList.length > 0 && (
          <table className="plain">
            <tbody>
              {coversList.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.title}
                    {c.selected === 1 && (
                      <span className="badge done" style={{ marginLeft: "0.5rem" }}>selected</span>
                    )}
                    <div className="muted" style={{ fontSize: "0.85rem" }}>{c.description}</div>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {c.selected !== 1 && (
                      <form action={selectCoverAction}>
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="coverId" value={c.id} />
                        <button type="submit">Select</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form action={addCoverAction} className="row" style={{ marginTop: "0.6rem" }}>
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grow">
            <input type="text" name="title" placeholder="Cover concept title" required />
          </div>
          <div className="grow">
            <input type="text" name="description" placeholder="Short description" />
          </div>
          <button type="submit">Add cover concept</button>
        </form>
      </div>

      <div className="card">
        <h2>Final checklist</h2>
        <ul className="checklist">
          {checklist.map((item) => (
            <li key={item.id}>
              <form action={toggleChecklistAction} style={{ display: "inline" }}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="itemId" value={item.id} />
                <input type="hidden" name="done" value={item.done ? "false" : "true"} />
                <button
                  type="submit"
                  style={{ border: "none", background: "none", cursor: "pointer", padding: 0 }}
                  aria-label={item.done ? `Uncheck ${item.label}` : `Check ${item.label}`}
                >
                  {item.done ? "✅" : "⬜"}
                </button>
              </form>{" "}
              <span style={item.done ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}>
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
