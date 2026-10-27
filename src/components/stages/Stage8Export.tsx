import { addCoverAction, selectCoverAction, toggleChecklistAction } from "@/lib/actions/content";
import {
  confirmContentAction,
  rejectContentAction,
  rollbackPdfAction,
} from "@/lib/actions/correction";
import type { Db } from "@/lib/db/client";
import type { CorrectionMessage, Job, PdfVersion } from "@/lib/db/schema";
import { getPageSize, parseFormatData } from "@/lib/format/config";
import { listCorrectionMessages } from "@/lib/repo/correction";
import { latestJobForStage } from "@/lib/repo/jobs";
import {
  getFormatConfig,
  latestPdfVersion,
  latestRender,
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

interface ExportSummary {
  oneLiner?: string;
  pageCount?: number;
  colorMode?: string;
  hasQrCodes?: boolean;
  qrReminder?: string | null;
  coverStatus?: "attached" | "pending";
  pdfx?: { required: boolean; produced: boolean };
  interiorPath?: string;
  pdfxPath?: string | null;
  coverPath?: string | null;
  checklistPath?: string;
  oneLinerPath?: string;
  fromRenderVersion?: number;
}

function parseExportSummary(job?: Job): ExportSummary | null {
  if (!job || job.status !== "succeeded" || !job.output) return null;
  try {
    return JSON.parse(job.output) as ExportSummary;
  } catch {
    return null;
  }
}

export function Stage8Export({ db, projectId }: { db: Db; projectId: string }) {
  // Export rows carry no render metadata; Stage-7 render rows (textVersion set)
  // belong to the Format stage's list.
  const exportsList = listPdfVersions(db, projectId).filter(
    (v) => v.textVersion === null,
  );
  const coversList = listCovers(db, projectId);
  const checklist = listChecklist(db, projectId);
  const finalText = latestText(db, projectId, "final");
  const render = latestRender(db, projectId);
  const latestJob = latestJobForStage(db, projectId, 8);
  const summary = parseExportSummary(latestJob);

  const exportBlocked = !finalText
    ? "The FINAL text must exist — finish the Review stage first."
    : !render
      ? "No typeset PDF yet — render the QA-checked PDF in Stage 7 (Format) first."
      : render.qaPassed !== 1
        ? `The latest render (PDF v${render.version}) failed QA. Re-render in Stage 7 until QA passes — the export stays blocked until then.`
        : undefined;

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
        <p className="muted">
          Builds the print-shop deliverables from the QA-passed typeset PDF: the
          interior PDF, an auto-generated checklist and one-line summary, a
          CMYK/PDF-X variant for print destinations, and the cover spread when
          one is attached. Export stays blocked while the latest render fails QA.
        </p>
        <JobPanel
          projectId={projectId}
          stage={8}
          jobType="export_book"
          runLabel="Generate export"
          latestJob={latestJob}
          disabled={Boolean(exportBlocked)}
          disabledReason={exportBlocked}
        />

        {summary?.oneLiner && (
          <div style={{ marginTop: "1rem" }}>
            <h3 style={{ marginBottom: "0.3rem" }}>One-line summary for the printer</h3>
            <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.3rem" }}>
              Paste this to the print shop.
            </p>
            <textarea
              readOnly
              value={summary.oneLiner}
              rows={2}
              style={{ width: "100%", fontFamily: "inherit" }}
            />
            <div className="muted" style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>
              {summary.pageCount} pages · {summary.colorMode}
              {summary.fromRenderVersion ? ` · from PDF v${summary.fromRenderVersion}` : ""}
            </div>
          </div>
        )}

        {summary?.qrReminder && (
          <div className="error-box" style={{ marginTop: "1rem" }}>
            <strong>QR codes:</strong> {summary.qrReminder}
          </div>
        )}

        {summary && (
          <ul className="muted" style={{ fontSize: "0.85rem", marginTop: "1rem" }}>
            {summary.checklistPath && <li>Print-shop checklist: {summary.checklistPath}</li>}
            {summary.interiorPath && <li>Interior PDF: {summary.interiorPath}</li>}
            {summary.pdfx?.required &&
              (summary.pdfxPath ? (
                <li>PDF/X (CMYK): {summary.pdfxPath}</li>
              ) : (
                <li>
                  PDF/X (CMYK) required but not generated here — ask the printer to
                  convert from the interior PDF (Ghostscript was unavailable).
                </li>
              ))}
            <li>
              Cover:{" "}
              {summary.coverStatus === "attached"
                ? "spread attached; spine width to be confirmed with the printer"
                : "pending; spine width to be confirmed with the printer"}
            </li>
          </ul>
        )}
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
                    {c.selected === 1 && !c.filePath && (
                      <span className="badge" style={{ marginLeft: "0.5rem" }}>no file — spread pending</span>
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
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Generated from the exported PDF each run. Tick each item as you confirm
          it with the print shop.
        </p>
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
