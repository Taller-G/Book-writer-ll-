import { addCoverAction, selectCoverAction, toggleChecklistAction } from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import type { Job } from "@/lib/db/schema";
import { latestJobForStage } from "@/lib/repo/jobs";
import { latestRender, listChecklist, listCovers, listPdfVersions } from "@/lib/repo/output";
import { latestText } from "@/lib/repo/texts";
import { JobPanel } from "../JobPanel";

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

        {exportsList.length > 0 && (
          <table className="plain" style={{ marginTop: "1rem" }}>
            <tbody>
              {exportsList.map((v) => (
                <tr key={v.id}>
                  <td>v{v.version}</td>
                  <td className="muted">{v.filePath}</td>
                  <td className="muted">{v.notes}</td>
                  <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
