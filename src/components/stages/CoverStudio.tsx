import type { Db } from "@/lib/db/client";
import { parseFormatData } from "@/lib/format/config";
import {
  estimatePageCount,
  getPaperStock,
  isSpineConfirmed,
  PAPER_STOCKS,
  spineWidthMm,
} from "@/lib/cover/spine";
import { spreadDims } from "@/lib/cover/spread";
import {
  APPROACH_CATALOG,
  backCoverGuideEntry,
  getSpine,
  listBackCover,
  listConcepts,
  listIterations,
  listTitleOptions,
  parseRegion,
} from "@/lib/repo/covers";
import { getContract, getConfirmedStyleProfile } from "@/lib/repo/editorial";
import { latestJobOfType } from "@/lib/repo/jobs";
import { getFormatConfig } from "@/lib/repo/output";
import { getProject } from "@/lib/repo/projects";
import { latestText } from "@/lib/repo/texts";
import { hasApiKey } from "@/lib/repo/prefs";
import {
  confirmSpineAction,
  resolveBackCoverAction,
  runCoverJobAction,
  selectConceptAction,
  selectTitleOptionAction,
  setConceptStatusAction,
  setPaperStockAction,
} from "@/lib/actions/covers";
import { JobPanel } from "../JobPanel";
import { CoverPreview, type PreviewConcept } from "./CoverPreview";

function approachLabel(key: string): string {
  return (
    APPROACH_CATALOG.find((a) => a.key === key)?.label ??
    (key === "upload" ? "Your upload" : key)
  );
}

export function CoverStudio({ db, projectId }: { db: Db; projectId: string }) {
  const project = getProject(db, projectId)!;
  const contract = getContract(db, projectId);
  const keySet = hasApiKey(db);

  const format = parseFormatData(getFormatConfig(db, projectId).data);
  const finalText = latestText(db, projectId, "final");
  const pageCount = estimatePageCount(finalText?.content ?? "", format);
  const spineRow = getSpine(db, projectId);
  const stock = getPaperStock(spineRow.paperStock);
  const spineMm = spineWidthMm(pageCount, stock);
  const spread = spreadDims(format, spineMm);
  const spineConfirmed = isSpineConfirmed(spineRow, pageCount);

  const concepts = listConcepts(db, projectId);
  const backCover = listBackCover(db, projectId);
  const titles = listTitleOptions(db, projectId);
  const iterations = listIterations(db, projectId);
  const proposeJob = latestJobOfType(db, projectId, "propose_cover_concepts");
  const backCoverJob = latestJobOfType(db, projectId, "draft_back_cover");

  const previewConcepts: PreviewConcept[] = concepts
    .filter((c) => c.status !== "discarded")
    .map((c) => ({
      id: c.id,
      approach: c.approach,
      approachLabel: approachLabel(c.approach),
      title: c.title || project.title,
      subtitle: c.subtitle,
      tagline: c.tagline,
      palette: safeArray(c.palette),
      imagery: c.imagery,
      source: c.source,
      hasImage: Boolean(c.filePath),
      status: c.status,
    }));

  return (
    <>
      <div className="card">
        <h2>Cover studio</h2>
        <p className="muted">
          Design the cover as one print spread — back cover, spine and front —
          then propose concepts, draft the back-cover content from the book
          itself, and iterate with the agent by annotating the preview.
        </p>
      </div>

      {/* Full-spread preview, annotations and PNG upload (client island) */}
      <div className="card">
        <h3>Spread preview &amp; iteration</h3>
        <CoverPreview
          projectId={projectId}
          concepts={previewConcepts}
          spread={{
            pageWidthMm: spread.pageWidthMm,
            pageHeightMm: spread.pageHeightMm,
            spineWidthMm: spread.spineWidthMm,
            bleedMm: spread.bleedMm,
            totalWidthMm: spread.totalWidthMm,
            totalHeightMm: spread.totalHeightMm,
            totalWidthPx: spread.totalWidthPx,
            totalHeightPx: spread.totalHeightPx,
          }}
        />
      </div>

      {/* Spine estimator ------------------------------------------------- */}
      <div className="card" data-testid="spine-panel">
        <h3>Spine width</h3>
        <p className="muted">
          The spine is page count × paper thickness. Both depend on the printer,
          so this is always an estimate to confirm with them before going to
          press.
        </p>
        <table className="plain">
          <tbody>
            <tr>
              <td>Estimated page count</td>
              <td>
                <strong>{pageCount || "—"}</strong>{" "}
                <span className="muted">
                  (from the FINAL text and the current format; updates as either
                  changes)
                </span>
              </td>
            </tr>
            <tr>
              <td>Estimated spine width</td>
              <td data-testid="spine-width">
                <strong>{spineMm.toFixed(1)} mm</strong>
              </td>
            </tr>
          </tbody>
        </table>
        <form action={setPaperStockAction} className="row" style={{ alignItems: "flex-end" }}>
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grow">
            <label htmlFor="paperStock">Paper stock</label>
            <select id="paperStock" name="paperStock" defaultValue={spineRow.paperStock}>
              {PAPER_STOCKS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {s.caliperMm} mm/leaf
                </option>
              ))}
            </select>
          </div>
          <button type="submit">Change paper</button>
        </form>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          {stock.blurb}
        </p>
        <div className="row" style={{ alignItems: "center" }}>
          {spineConfirmed ? (
            <span className="badge done" data-testid="spine-confirmed">
              Confirmed with the printer at {spineRow.confirmedPageCount} pages
            </span>
          ) : (
            <span className="badge queued" data-testid="spine-to-confirm">
              ⚠ To be confirmed with the printer
            </span>
          )}
          <form action={confirmSpineAction}>
            <input type="hidden" name="projectId" value={projectId} />
            <button type="submit" disabled={spineConfirmed || pageCount === 0}>
              {spineConfirmed ? "Confirmed" : "Mark confirmed with printer"}
            </button>
          </form>
        </div>
      </div>

      {/* AI concepts ----------------------------------------------------- */}
      <div className="card">
        <h3>Cover concepts</h3>
        <p className="muted">
          Two to four concepts across different approaches (minimalist
          typographic, with an image, with the author&apos;s photo). Keep,
          discard or regenerate each independently.
        </p>
        <JobPanel
          projectId={projectId}
          stage={7}
          jobType="propose_cover_concepts"
          runLabel={concepts.some((c) => c.source === "ai") ? "Propose concepts again" : "Propose concepts"}
          latestJob={proposeJob}
          disabled={!keySet || !contract}
          disabledReason={
            !contract
              ? "Sign the editorial contract (Stage 2) first."
              : !keySet
                ? "Add your API key in Settings first."
                : undefined
          }
        />
        {concepts.map((c) => (
          <div key={c.id} className="card" data-testid={`concept-${c.id}`}>
            <div className="row">
              <h4 className="grow">
                {approachLabel(c.approach)}
                {c.source === "upload" && <span className="muted"> · your upload</span>}
                {c.selected === 1 && (
                  <span className="badge done" style={{ marginLeft: "0.5rem" }}>
                    selected
                  </span>
                )}
              </h4>
              <span
                className={`badge ${
                  c.status === "kept" ? "done" : c.status === "discarded" ? "failed" : "queued"
                }`}
              >
                {c.status}
              </span>
            </div>
            <p className="muted">
              <strong>What this is:</strong> {c.explanation}
            </p>
            {c.source === "ai" && (
              <>
                <p>
                  <strong>{c.title}</strong>
                  {c.subtitle ? ` — ${c.subtitle}` : ""}
                  {c.tagline ? <span className="muted"> · “{c.tagline}”</span> : null}
                </p>
                {c.rationale && <p className="muted">{c.rationale}</p>}
                {c.imagery && (
                  <p className="muted" style={{ fontSize: "0.85rem" }}>
                    Imagery: {c.imagery}
                  </p>
                )}
                {safeArray(c.palette).length > 0 && (
                  <div className="row" style={{ gap: "0.25rem" }}>
                    {safeArray(c.palette).map((hex, i) => (
                      <span
                        key={i}
                        title={hex}
                        style={{
                          display: "inline-block",
                          width: 22,
                          height: 22,
                          borderRadius: 4,
                          background: hex,
                          border: "1px solid #ccc",
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
            {c.source === "upload" && c.filePath && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/projects/${projectId}/covers/${c.id}/image`}
                alt={c.title}
                style={{ maxWidth: 180, height: "auto", border: "1px solid #ccc", marginTop: "0.4rem" }}
              />
            )}
            <div className="row" style={{ marginTop: "0.5rem" }}>
              {c.status !== "discarded" && (
                <form action={setConceptStatusAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="conceptId" value={c.id} />
                  <input type="hidden" name="status" value="kept" />
                  <button type="submit">Keep</button>
                </form>
              )}
              {c.status !== "discarded" ? (
                <form action={setConceptStatusAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="conceptId" value={c.id} />
                  <input type="hidden" name="status" value="discarded" />
                  <button type="submit" data-testid={`discard-${c.id}`}>
                    Discard
                  </button>
                </form>
              ) : (
                <span className="muted">discarded</span>
              )}
              {c.source === "ai" && c.status !== "discarded" && (
                <form action={runCoverJobAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="type" value="regenerate_cover_concept" />
                  <input type="hidden" name="conceptId" value={c.id} />
                  <button type="submit" disabled={!keySet} data-testid={`regenerate-${c.id}`}>
                    Regenerate
                  </button>
                </form>
              )}
              {c.status !== "discarded" && c.selected !== 1 && (
                <form action={selectConceptAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="conceptId" value={c.id} />
                  <button type="submit" className="primary">
                    Select as the cover
                  </button>
                </form>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Title / subtitle / tagline A/B/C -------------------------------- */}
      {titles.length > 0 && (
        <div className="card">
          <h3>Title, subtitle &amp; tagline — compare A / B / C</h3>
          <div className="option-grid">
            {titles.map((t) => (
              <div
                key={t.id}
                className={`option-card${t.selected === 1 ? " selected" : ""}`}
                data-testid={`title-${t.label}`}
              >
                <span className="option-title">
                  {t.label}
                  {t.selected === 1 && (
                    <span className="badge done" style={{ marginLeft: "0.4rem" }}>
                      chosen
                    </span>
                  )}
                </span>
                <strong>{t.title}</strong>
                {t.subtitle && <div className="muted">{t.subtitle}</div>}
                {t.tagline && <div className="muted">“{t.tagline}”</div>}
                {t.rationale && (
                  <p className="muted" style={{ fontSize: "0.82rem" }}>
                    {t.rationale}
                  </p>
                )}
                {t.selected !== 1 && (
                  <form action={selectTitleOptionAction}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="optionId" value={t.id} />
                    <button type="submit">Choose {t.label}</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Back-cover content --------------------------------------------- */}
      <div className="card">
        <h3>Back cover</h3>
        <p className="muted">
          A professional back cover carries a blurb, a highlighted quote from the
          book, and a short author bio — each drafted from the book&apos;s own
          text. Accept (editing if you like) or discard each.
        </p>
        <JobPanel
          projectId={projectId}
          stage={7}
          jobType="draft_back_cover"
          runLabel={backCover.length > 0 ? "Draft back cover again" : "Draft back cover"}
          latestJob={backCoverJob}
          disabled={!keySet || !finalText}
          disabledReason={
            !finalText
              ? "The FINAL text must exist — finish the Review stage first."
              : !keySet
                ? "Add your API key in Settings first."
                : undefined
          }
        />
        {backCover.map((s) => (
          <div key={s.id} className="card" data-testid={`backcover-${s.sectionKey}`}>
            <div className="row">
              <h4 className="grow">{backCoverGuideEntry(s.sectionKey)?.label ?? s.sectionKey}</h4>
              <span
                className={`badge ${
                  s.status === "accepted" ? "done" : s.status === "discarded" ? "failed" : "queued"
                }`}
              >
                {s.status}
              </span>
            </div>
            <p className="muted">
              <strong>What this is for:</strong> {s.explanation}
            </p>
            {s.sectionKey === "quote" && s.sourceExcerpt && (
              <p className="muted" style={{ fontSize: "0.82rem" }}>
                From the book: “{s.sourceExcerpt}”
              </p>
            )}
            {s.status === "proposed" ? (
              <form action={resolveBackCoverAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="sectionKey" value={s.sectionKey} />
                <textarea name="content" defaultValue={s.content} rows={s.sectionKey === "blurb" ? 6 : 3} />
                <div className="row">
                  <button type="submit" name="status" value="accepted" className="primary">
                    Accept
                  </button>
                  <button type="submit" name="status" value="discarded">
                    Discard
                  </button>
                </div>
              </form>
            ) : (
              <pre className="text-preview">{s.content}</pre>
            )}
          </div>
        ))}
      </div>

      {/* Iteration thread ----------------------------------------------- */}
      {iterations.length > 0 && (
        <div className="card">
          <h3>Iteration history</h3>
          {iterations.map((it) => {
            const region = parseRegion(it.region);
            return (
              <div key={it.id} className="card" data-testid={`iteration-${it.id}`}>
                <p>
                  <strong>You ({it.target}</strong>
                  {region
                    ? `, region ${(region.w * 100).toFixed(0)}×${(region.h * 100).toFixed(0)}%`
                    : ""}
                  <strong>):</strong> {it.note}
                </p>
                {it.response ? (
                  <p className="muted">
                    <strong>Agent:</strong> {it.response}
                  </p>
                ) : (
                  <p className="muted">Waiting for the agent…</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}
