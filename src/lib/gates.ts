import type { Db } from "./db/client";
import { getConfirmedStyleProfile, getContract } from "./repo/editorial";
import { listChecklist, listPdfVersions } from "./repo/output";
import { countPendingReviews } from "./repo/review";
import { latestText } from "./repo/texts";

export interface StageGate {
  ok: boolean;
  reason?: string;
}

/** What each stage requires before it can be marked complete. */
export function canCompleteStage(
  db: Db,
  projectId: string,
  stage: number,
): StageGate {
  switch (stage) {
    case 1:
      return latestText(db, projectId, "raw")
        ? { ok: true }
        : { ok: false, reason: "Compile your sources into the raw text first." };
    case 2:
      return getContract(db, projectId)
        ? { ok: true }
        : { ok: false, reason: "Sign the editorial contract first." };
    case 3:
      return getConfirmedStyleProfile(db, projectId)
        ? { ok: true }
        : { ok: false, reason: "Confirm the style profile first." };
    case 4:
      return latestText(db, projectId, "passA")
        ? { ok: true }
        : { ok: false, reason: "Run Cleanup Pass A first." };
    case 5:
      return latestText(db, projectId, "passB")
        ? { ok: true }
        : { ok: false, reason: "Run Refine Pass B first." };
    case 6: {
      const pending = countPendingReviews(db, projectId);
      if (pending > 0)
        return { ok: false, reason: `${pending} review item(s) still pending.` };
      return latestText(db, projectId, "final")
        ? { ok: true }
        : { ok: false, reason: "Finalize the text first." };
    }
    case 7:
      return { ok: true };
    case 8: {
      if (listPdfVersions(db, projectId).length === 0)
        return { ok: false, reason: "Generate at least one export first." };
      const open = listChecklist(db, projectId).filter((c) => !c.done).length;
      return open === 0
        ? { ok: true }
        : { ok: false, reason: `${open} checklist item(s) still open.` };
    }
    default:
      return { ok: false, reason: "Unknown stage." };
  }
}
