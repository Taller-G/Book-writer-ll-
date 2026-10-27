import type { Db } from "@/lib/db/client";
import { parseFormatData } from "@/lib/format/config";
import { latestJobForStage } from "@/lib/repo/jobs";
import { getFormatConfig, layoutHasBegun, listPdfVersions } from "@/lib/repo/output";
import { latestText } from "@/lib/repo/texts";
import { JobPanel } from "../JobPanel";
import { FormatWizard } from "./FormatWizard";

export function Stage7Format({ db, projectId }: { db: Db; projectId: string }) {
  const config = getFormatConfig(db, projectId);
  const data = parseFormatData(config.data);
  // The preview sets the user's own words: the most advanced text available.
  const sample =
    latestText(db, projectId, "final") ??
    latestText(db, projectId, "passB") ??
    latestText(db, projectId, "passA") ??
    latestText(db, projectId, "raw");
  // Only real renders — rows written by the Stage 8 HTML export carry no
  // render metadata and belong to that stage's list.
  const renders = listPdfVersions(db, projectId).filter(
    (v) => v.textVersion !== null,
  );
  const finalText = latestText(db, projectId, "final");
  const latestJob = latestJobForStage(db, projectId, 7);
  return (
    <>
      <FormatWizard
        projectId={projectId}
        saved={data}
        sampleText={(sample?.content ?? "").slice(0, 6000)}
        layoutStarted={layoutHasBegun(db, projectId)}
        updatedAt={config.updatedAt}
      />

      <div className="card">
        <h2>Typeset PDF</h2>
        <p className="muted">
          Renders the approved FINAL text with these format settings — verified
          word-for-word before compiling, then QA-checked page by page (folios,
          TOC, fonts, separators, recto openings, widows).
        </p>
        <JobPanel
          projectId={projectId}
          stage={7}
          jobType="render_pdf"
          runLabel="Render PDF"
          latestJob={latestJob}
          disabled={!finalText}
          disabledReason={
            finalText
              ? undefined
              : "The FINAL text must exist — finish the Review stage first."
          }
        />
        {renders.length > 0 && (
          <table className="plain">
            <tbody>
              {renders.map((v) => (
                <tr key={v.id}>
                  <td>v{v.version}</td>
                  <td>
                    <span className={`badge ${v.qaPassed === 1 ? "done" : ""}`}>
                      {v.qaPassed === 1 ? "QA pass" : "QA fail"}
                    </span>
                  </td>
                  <td className="muted">FINAL v{v.textVersion}</td>
                  <td className="muted">{v.filePath}</td>
                  <td className="muted">{v.qaReportPath}</td>
                  <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
