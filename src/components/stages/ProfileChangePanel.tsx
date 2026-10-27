import { keepTextProfileAction } from "@/lib/actions/content";
import { runStageJobAction } from "@/lib/actions/jobs";
import type { Db } from "@/lib/db/client";
import { getConfirmedStyleProfile } from "@/lib/repo/editorial";
import { textsUnderOldProfile } from "@/lib/repo/texts";
import type { StageTextKey } from "@/lib/stages";

/** Which job re-produces each generated text. */
const PRODUCERS: Partial<
  Record<StageTextKey, { stage: number; type: string; label: string }>
> = {
  passA: { stage: 4, type: "cleanup_pass_a", label: "Cleanup Pass A" },
  passB: { stage: 5, type: "refine_pass_b", label: "Refine Pass B" },
  final: { stage: 6, type: "finalize_text", label: "Finalize" },
};

/**
 * After a mid-project profile change: the texts written under a previous
 * profile version, each with a regenerate-or-keep choice. Invisible while
 * everything is in sync.
 */
export function ProfileChangePanel({
  db,
  projectId,
}: {
  db: Db;
  projectId: string;
}) {
  const profile = getConfirmedStyleProfile(db, projectId);
  if (!profile) return null;
  const stale = textsUnderOldProfile(db, projectId, profile.version);
  if (stale.length === 0) return null;

  return (
    <div className="card" data-testid="profile-change-panel">
      <h2>Texts written with the previous profile</h2>
      <p className="muted">
        The style profile is now v{profile.version}. These texts were written
        under an older profile — regenerate them with the new voice, or keep
        them as they are.
      </p>
      <table className="plain">
        <tbody>
          {stale.map((t) => {
            const producer = PRODUCERS[t.stageKey as StageTextKey]!;
            return (
              <tr key={t.id} data-testid={`stale-text-${t.stageKey}`}>
                <td>
                  {t.stageKey} v{t.version}
                </td>
                <td className="muted">
                  written under profile{" "}
                  {t.styleProfileVersion == null
                    ? "— none —"
                    : `v${t.styleProfileVersion}`}
                </td>
                <td>
                  <div className="row">
                    <form action={runStageJobAction}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="stage" value={producer.stage} />
                      <input type="hidden" name="type" value={producer.type} />
                      <button type="submit" className="primary">
                        Regenerate ({producer.label})
                      </button>
                    </form>
                    <form action={keepTextProfileAction}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="textId" value={t.id} />
                      <input type="hidden" name="stageKey" value={t.stageKey} />
                      <button type="submit">Keep as is</button>
                    </form>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
