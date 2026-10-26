import { saveContractAction } from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import { getContract } from "@/lib/repo/editorial";

const MODES = [
  {
    value: "verbatim",
    label: "Verbatim",
    help: "The text stays as spoken/written. Only transcription errors are fixed.",
  },
  {
    value: "prose",
    label: "Prose",
    help: "The material is rewritten as polished prose, preserving meaning.",
  },
  {
    value: "hybrid",
    label: "Hybrid",
    help: "Quotes stay verbatim; narration around them becomes prose.",
  },
] as const;

export function Stage2Contract({ db, projectId }: { db: Db; projectId: string }) {
  const contract = getContract(db, projectId);
  return (
    <div className="card">
      <h2>Editorial contract</h2>
      <p className="muted">
        This is the promise every later edit is judged against. Changing it
        after cleanup starts is possible, but it is recorded in the audit log.
      </p>
      <form action={saveContractAction}>
        <input type="hidden" name="projectId" value={projectId} />
        <label>Mode</label>
        {MODES.map((m) => (
          <p key={m.value} style={{ margin: "0.3rem 0" }}>
            <label style={{ fontWeight: 400, display: "flex", gap: "0.5rem" }}>
              <input
                type="radio"
                name="mode"
                value={m.value}
                defaultChecked={contract ? contract.mode === m.value : m.value === "hybrid"}
              />
              <span>
                <strong>{m.label}</strong> — <span className="muted">{m.help}</span>
              </span>
            </label>
          </p>
        ))}
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
            {contract ? "Update contract" : "Sign contract"}
          </button>
          {contract?.signedAt && (
            <span className="muted" style={{ marginLeft: "0.8rem" }}>
              Signed {new Date(contract.signedAt).toLocaleString()}
            </span>
          )}
        </p>
      </form>
    </div>
  );
}
