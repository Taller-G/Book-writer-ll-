import { JobPanel } from "@/components/JobPanel";
import { saveContractAction } from "@/lib/actions/content";
import {
  AUTHORSHIPS,
  DESTINATIONS,
  MODES,
  TONES,
} from "@/lib/contract/definitions";
import type { Db } from "@/lib/db/client";
import {
  authorshipWarning,
  getContract,
  listContractVersions,
  listDownstreamArtifacts,
} from "@/lib/repo/editorial";
import { latestJobForStage } from "@/lib/repo/jobs";
import { latestText } from "@/lib/repo/texts";

interface ToneSample {
  tone: string;
  label: string;
  text: string;
  model: string;
}

export function Stage2Contract({ db, projectId }: { db: Db; projectId: string }) {
  const contract = getContract(db, projectId);
  const versions = listContractVersions(db, projectId);
  const artifacts = listDownstreamArtifacts(db, projectId);
  const raw = latestText(db, projectId, "raw");
  const samplesJob = latestJobForStage(db, projectId, 2);
  const samples: ToneSample[] =
    samplesJob?.status === "succeeded" && samplesJob.output
      ? (JSON.parse(samplesJob.output).samples ?? [])
      : [];
  const excerpt: string =
    samplesJob?.status === "succeeded" && samplesJob.output
      ? (JSON.parse(samplesJob.output).excerpt ?? "")
      : "";
  const warning = authorshipWarning(contract?.authorship, contract?.destination);

  return (
    <div>
      {contract && artifacts.length > 0 && (
        <div className="warn-box" data-testid="contract-change-warning">
          <strong>
            This contract (v{contract.version}) is already in force.
          </strong>{" "}
          Changing a decision affects {artifacts.length} existing artifact(s),
          which were produced under it and will need re-running:
          <ul style={{ margin: "0.4rem 0 0" }}>
            {artifacts.map((a) => (
              <li key={`${a.stage}-${a.label}`}>
                {a.label} (stage {a.stage})
                {contract.version > 1 && a.createdAt < (contract.signedAt ?? "")
                  ? " — produced under an earlier contract version"
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Editorial contract</h2>
        <p className="muted">
          Four decisions, made once: they are the promise every later edit is
          judged against. Every pass reads this contract — changing it later is
          possible, but it is versioned and recorded in the audit log.
        </p>
        <form action={saveContractAction}>
          <input type="hidden" name="projectId" value={projectId} />

          <h3>1 · How faithful does the text stay?</h3>
          {MODES.map((m) => (
            <div key={m.value} style={{ margin: "0.3rem 0 0.8rem" }}>
              <label style={{ fontWeight: 400, display: "flex", gap: "0.5rem" }}>
                <input
                  type="radio"
                  name="mode"
                  value={m.value}
                  defaultChecked={
                    contract ? contract.mode === m.value : m.value === "hybrid"
                  }
                />
                <span>
                  <strong>{m.label}</strong> —{" "}
                  <span className="muted">{m.help}</span>
                </span>
              </label>
              <details style={{ margin: "0.2rem 0 0 1.6rem" }}>
                <summary className="muted" style={{ cursor: "pointer" }}>
                  See a before/after example
                </summary>
                <div className="sample-grid">
                  <div>
                    <span className="muted">Before (as transcribed)</span>
                    <blockquote>{m.exampleBefore}</blockquote>
                  </div>
                  <div>
                    <span className="muted">After ({m.label})</span>
                    <blockquote>{m.exampleAfter}</blockquote>
                  </div>
                </div>
              </details>
            </div>
          ))}

          <h3>2 · Which tone?</h3>
          <p className="muted">
            Compare the four tones on a passage from your own material before
            deciding — generate the samples below, then pick.
          </p>
          <div className="sample-grid">
            {TONES.map((t) => {
              const sample = samples.find((s) => s.tone === t.value);
              return (
                <div key={t.value} className="card" style={{ margin: 0 }}>
                  <label
                    style={{ fontWeight: 400, display: "flex", gap: "0.5rem" }}
                  >
                    <input
                      type="radio"
                      name="tone"
                      value={t.value}
                      defaultChecked={contract?.tone === t.value}
                    />
                    <span>
                      <strong>{t.label}</strong> —{" "}
                      <span className="muted">{t.help}</span>
                    </span>
                  </label>
                  {sample && (
                    <blockquote data-testid={`tone-sample-${t.value}`}>
                      {sample.text}
                    </blockquote>
                  )}
                </div>
              );
            })}
          </div>

          <h3>3 · Where is the book going?</h3>
          {DESTINATIONS.map((d) => (
            <p key={d.value} style={{ margin: "0.3rem 0" }}>
              <label style={{ fontWeight: 400, display: "flex", gap: "0.5rem" }}>
                <input
                  type="radio"
                  name="destination"
                  value={d.value}
                  defaultChecked={contract?.destination === d.value}
                />
                <span>
                  <strong>{d.label}</strong> —{" "}
                  <span className="muted">
                    {d.help} Downstream: {d.downstream}
                  </span>
                </span>
              </label>
            </p>
          ))}

          <h3>4 · Whose material is it?</h3>
          {AUTHORSHIPS.map((a) => (
            <p key={a.value} style={{ margin: "0.3rem 0" }}>
              <label style={{ fontWeight: 400, display: "flex", gap: "0.5rem" }}>
                <input
                  type="radio"
                  name="authorship"
                  value={a.value}
                  defaultChecked={contract?.authorship === a.value}
                />
                <span>
                  <strong>{a.label}</strong> —{" "}
                  <span className="muted">{a.help}</span>
                </span>
              </label>
            </p>
          ))}
          {warning && (
            <div className="warn-box" data-testid="third-party-warning">
              {warning}
            </div>
          )}
          <label htmlFor="rightsNotes">Rights notes</label>
          <textarea
            id="rightsNotes"
            name="rightsNotes"
            defaultValue={contract?.rightsNotes ?? ""}
            placeholder="Who holds the rights, which permissions you have (or still need)…"
          />
          <label htmlFor="legalText">
            Legal / credits text{" "}
            <span className="muted">
              (proposed from your answers — edit freely; it goes into the
              export&apos;s legal page)
            </span>
          </label>
          <textarea
            id="legalText"
            name="legalText"
            data-testid="legal-text"
            defaultValue={contract?.legalText ?? ""}
            placeholder="Saved with an authorship answer, a proposal appears here."
          />

          <label htmlFor="rules">Rules (one per line)</label>
          <textarea
            id="rules"
            name="rules"
            defaultValue={contract?.rules ?? ""}
            placeholder={"e.g.\nNever change quoted speech\nKeep regional idioms\nSpanish spelling: RAE"}
          />
          <label htmlFor="notes">Notes</label>
          <textarea id="notes" name="notes" defaultValue={contract?.notes ?? ""} />
          <p>
            <button type="submit" className="primary">
              {contract
                ? `Revise contract (creates v${contract.version + 1})`
                : "Sign contract"}
            </button>
            {contract?.signedAt && (
              <span className="muted" style={{ marginLeft: "0.8rem" }}>
                v{contract.version} signed{" "}
                {new Date(contract.signedAt).toLocaleString()}
              </span>
            )}
          </p>
        </form>
      </div>

      <div className="card">
        <h3>Tone samples from your material</h3>
        <p className="muted">
          The same passage of your compiled raw text, rendered once per tone,
          so you compare like with like — nothing canned.
        </p>
        <JobPanel
          projectId={projectId}
          stage={2}
          jobType="tone_samples"
          runLabel="Generate tone samples from my material"
          latestJob={samplesJob}
          disabled={!raw}
          disabledReason="Compile your sources into the raw text (Stage 1) first — the samples are generated from your own material."
        />
        {excerpt && (
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>
              Passage used for the samples
            </summary>
            <blockquote>{excerpt}</blockquote>
          </details>
        )}
      </div>

      {versions.length > 0 && (
        <details className="card">
          <summary>
            Contract history ({versions.length} version
            {versions.length === 1 ? "" : "s"})
          </summary>
          <ul>
            {versions.map((v) => {
              const snap = JSON.parse(v.snapshot) as {
                mode?: string;
                tone?: string | null;
                destination?: string | null;
                authorship?: string | null;
              };
              return (
                <li key={v.id}>
                  <strong>v{v.version}</strong> —{" "}
                  {new Date(v.createdAt).toLocaleString()} · mode{" "}
                  {snap.mode ?? "—"}, tone {snap.tone ?? "—"}, destination{" "}
                  {snap.destination ?? "—"}, authorship {snap.authorship ?? "—"}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
