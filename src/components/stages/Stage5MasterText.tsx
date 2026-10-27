import {
  approveSampleAction,
  loadRuleSetAction,
  resolveApparatusAction,
  toggleRuleAction,
  validateSampleAction,
} from "@/lib/actions/master";
import { getModelConfig } from "@/lib/ai/config";
import { estimateCostUsd, estimateTokens, formatUsd } from "@/lib/ai/estimate";
import type { Db } from "@/lib/db/client";
import { getProjectSpend } from "@/lib/repo/aiUsage";
import { listApparatus } from "@/lib/repo/apparatus";
import { listChanges } from "@/lib/repo/changeLog";
import { getStyleSample } from "@/lib/repo/editorial";
import { latestJobOfType } from "@/lib/repo/jobs";
import { ensureRules, RULE_SETS } from "@/lib/repo/normalization";
import { getOutline, parseOutlineData } from "@/lib/repo/outline";
import { hasApiKey } from "@/lib/repo/prefs";
import { latestText } from "@/lib/repo/texts";
import { JobPanel } from "../JobPanel";
import { OutlineEditor } from "../OutlineEditor";

/**
 * Stage 5 in editorial prose mode (spec §4 stage 4): the master-text flow.
 * Analyze → editable outline → pre-approved voice sample → chunked generation
 * with normalization → editorial apparatus, every step change-logged.
 */
export async function Stage5MasterText({
  db,
  projectId,
}: {
  db: Db;
  projectId: string;
}) {
  const passA = latestText(db, projectId, "passA");
  const passB = latestText(db, projectId, "passB");
  const outlineRow = getOutline(db, projectId);
  const outline = parseOutlineData(outlineRow);
  const sample = getStyleSample(db, projectId);
  const rules = ensureRules(db, projectId);
  const apparatus = listApparatus(db, projectId);
  const recentChanges = listChanges(db, projectId, 12);
  const keySet = hasApiKey(db);
  const spend = getProjectSpend(db, projectId);

  const outlineJob = latestJobOfType(db, projectId, "propose_outline");
  const sampleJob = latestJobOfType(db, projectId, "generate_style_sample");
  const generateJob = latestJobOfType(db, projectId, "generate_master_text");
  const apparatusJob = latestJobOfType(db, projectId, "propose_apparatus");

  const estimate =
    passA && keySet
      ? estimateCostUsd(await getModelConfig(), "large", passA.content)
      : undefined;
  const outlineConfirmed = outlineRow?.status === "confirmed";
  const sampleApproved = Boolean(sample?.approvedAt);
  const generateBlockers = [
    !passA && "the cleaned (passA) text",
    !outlineConfirmed && "a confirmed outline",
    !sampleApproved && "an approved style sample",
  ].filter(Boolean);
  const quoteBalance = parseQuoteBalance(generateJob?.output);
  const language = rules[0]?.language ?? "es";

  return (
    <>
      <div className="card">
        <h2>1 · Structure — analyze the material</h2>
        <p className="muted">
          The AI reads the cleaned text, finds themes, repetitions and stories,
          and proposes chapters with titles. You stay in control: drag to
          reorder, rename, merge — then confirm.
        </p>
        {!passA && (
          <p className="muted">No cleaned text yet — run Cleanup Pass A first.</p>
        )}
        <JobPanel
          projectId={projectId}
          stage={5}
          jobType="propose_outline"
          runLabel={outlineRow ? "Propose outline again" : "Analyze material"}
          latestJob={outlineJob}
          disabled={!passA || !keySet}
          disabledReason={
            !passA
              ? "The cleaned text must exist before analysis."
              : !keySet
                ? "Add your API key in Settings first."
                : undefined
          }
        />
        {outlineRow && outline.chapters.length > 0 && (
          <>
            {outline.analysisNotes && (
              <p className="muted" data-testid="analysis-notes">
                {outline.analysisNotes}
              </p>
            )}
            {outline.leitmotifs.length > 0 && (
              <p className="muted">
                Leitmotifs to keep deliberately: {outline.leitmotifs.join(" · ")}
              </p>
            )}
            <OutlineEditor
              // Remount on every saved revision so the editor's local state
              // (pending edits) resets to what the server now holds.
              key={`${outlineRow.updatedAt}·${outlineRow.status}`}
              projectId={projectId}
              initialChapters={outline.chapters}
              status={outlineRow.status}
            />
          </>
        )}
      </div>

      <div className="card">
        <h2>2 · Voice — approve a sample first</h2>
        <p className="muted">
          A short sample written with your style profile. Approve it before the
          full generation; afterwards you validate the book against it.
        </p>
        <JobPanel
          projectId={projectId}
          stage={5}
          jobType="generate_style_sample"
          runLabel={sample ? "Generate sample again" : "Generate style sample"}
          latestJob={sampleJob}
          disabled={!passA || !keySet}
          disabledReason={!keySet ? "Add your API key in Settings first." : undefined}
        />
        {sample && (
          <>
            <pre className="text-preview" data-testid="style-sample">
              {sample.text}
            </pre>
            {sampleApproved ? (
              <p>
                <span className="badge done">sample approved</span>
              </p>
            ) : (
              <form action={approveSampleAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <button type="submit" className="primary">
                  Approve this voice
                </button>
              </form>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>3 · Orthotypography — the rule list</h2>
        <p className="muted">
          Applied to the generated text ({language === "es" ? "Spanish/RAE" : language}
          {" "}set loaded). Mechanical rules run as exact replacements; writing
          rules are given to the AI while it writes. Toggle any rule off.
        </p>
        <table className="plain" data-testid="normalization-rules">
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.label}</strong>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {r.explanation}
                  </div>
                </td>
                <td className="muted">{r.kind === "mechanical" ? "exact" : "while writing"}</td>
                <td style={{ textAlign: "right" }}>
                  <form action={toggleRuleAction}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="ruleKey" value={r.ruleKey} />
                    <input type="hidden" name="enabled" value={r.enabled === 1 ? "false" : "true"} />
                    <button type="submit">{r.enabled === 1 ? "On — disable" : "Off — enable"}</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row">
          {Object.keys(RULE_SETS).map((lang) => (
            <form key={lang} action={loadRuleSetAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="language" value={lang} />
              <button type="submit" disabled={lang === language}>
                Load “{lang}” rule set
              </button>
            </form>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>4 · Generate the master text</h2>
        <p className="muted">
          One chapter at a time, re-injecting your contract, style profile and
          the book&apos;s state on every call — big books are chunked, never trusted
          to the model&apos;s memory. Repetitions become deliberate leitmotifs;
          timestamps and podcast-style intros disappear.
        </p>
        {passA && estimate !== undefined && (
          <p data-testid="cost-estimate">
            Generating from {passA.content.split(/\s+/).length} words (~
            {estimateTokens(passA.content)} tokens) will cost approx.{" "}
            <strong>{formatUsd(estimate)}</strong>. AI spend on this project so
            far: {formatUsd(spend)}.
          </p>
        )}
        <JobPanel
          projectId={projectId}
          stage={5}
          jobType="generate_master_text"
          runLabel={passB ? "Generate master text again" : "Generate master text"}
          latestJob={generateJob}
          disabled={generateBlockers.length > 0 || !keySet}
          disabledReason={
            generateBlockers.length > 0
              ? `Still needed: ${generateBlockers.join(", ")}.`
              : !keySet
                ? "Add your API key in Settings first."
                : undefined
          }
        />
        {quoteBalance && (
          <p data-testid="quote-balance">
            Quote-balance check:{" "}
            {quoteBalance.ok ? (
              <span className="badge done">passed</span>
            ) : (
              <span className="badge failed">failed — see review queue</span>
            )}
          </p>
        )}
        {passB && (
          <>
            <h3>Master text — passB v{passB.version}</h3>
            <pre className="text-preview">{passB.content}</pre>
            {sample && sampleApproved && (
              <div data-testid="sample-validation">
                <p className="muted">
                  Compare the result with your approved sample above. Does the
                  book keep that voice?
                </p>
                {sample.validatedAt ? (
                  <span className="badge done">validated against the sample</span>
                ) : (
                  <form action={validateSampleAction}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <button type="submit" className="primary">
                      Yes — it matches the approved sample
                    </button>
                  </form>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>5 · Editorial apparatus</h2>
        <p className="muted">
          Prologue, introduction, epilogue… each proposed with an explanation of
          what it&apos;s for. Accept (editing if you like) or discard each one —
          discarding never breaks the book. Accepted sections are assembled
          around the text when you finalize in Review.
        </p>
        <JobPanel
          projectId={projectId}
          stage={5}
          jobType="propose_apparatus"
          runLabel={apparatus.length > 0 ? "Propose apparatus again" : "Propose apparatus"}
          latestJob={apparatusJob}
          disabled={!passB || !keySet}
          disabledReason={
            !passB
              ? "Generate the master text first."
              : !keySet
                ? "Add your API key in Settings first."
                : undefined
          }
        />
        {apparatus.map((s) => (
          <div key={s.id} className="card" data-testid={`apparatus-${s.sectionKey}`}>
            <div className="row">
              <h3 className="grow">
                {s.title} <span className="muted">({s.placement} matter)</span>
              </h3>
              <span
                className={`badge ${
                  s.status === "accepted"
                    ? "done"
                    : s.status === "discarded"
                      ? "failed"
                      : "queued"
                }`}
              >
                {s.status}
              </span>
            </div>
            <p className="muted">
              <strong>What this is for:</strong> {s.explanation}
            </p>
            {s.status === "proposed" ? (
              <form action={resolveApparatusAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="sectionKey" value={s.sectionKey} />
                <textarea name="content" defaultValue={s.content} rows={6} />
                <div className="row">
                  <button type="submit" name="status" value="accepted" className="primary">
                    Accept section
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

      <div className="card">
        <h2>Latest audit log entries</h2>
        <table className="plain">
          <tbody>
            {recentChanges.map((c) => (
              <tr key={c.id}>
                <td>{c.what}</td>
                <td className="muted">{c.where}</td>
                <td className="muted">{c.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function parseQuoteBalance(
  output: string | null | undefined,
): { ok: boolean } | undefined {
  if (!output) return undefined;
  try {
    const parsed = JSON.parse(output) as { quoteBalance?: { ok?: boolean } };
    return typeof parsed.quoteBalance?.ok === "boolean"
      ? { ok: parsed.quoteBalance.ok }
      : undefined;
  } catch {
    return undefined;
  }
}
