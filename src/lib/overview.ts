import type { Db } from "./db/client";
import type { ChangeLogEntry, Job, Project } from "./db/schema";
import { listChanges } from "./repo/changeLog";
import { getContract, getStyleProfile } from "./repo/editorial";
import { listJobs } from "./repo/jobs";
import { listChecklist, listPdfVersions } from "./repo/output";
import { getProject, getStageStates, type StageState } from "./repo/projects";
import { countPendingReviews } from "./repo/review";
import { listSources } from "./repo/sources";
import { latestText } from "./repo/texts";
import { STAGE_COUNT } from "./stages";

export interface ProjectOverview {
  project: Project;
  stages: StageState[];
  doneCount: number;
  /** The stage to continue at (first non-done stage, or last stage). */
  resumeStage: number;
  nextAction: string;
  sourceCount: number;
  pendingReviews: number;
  changeCount: number;
  recentChanges: ChangeLogEntry[];
  latestJob?: Job;
  allDone: boolean;
}

/**
 * Everything the "where we are / what's left" summary needs when a project
 * is reopened — possibly days later (spec pain point #13).
 */
export function getProjectOverview(
  db: Db,
  projectId: string,
): ProjectOverview | undefined {
  const project = getProject(db, projectId);
  if (!project) return undefined;

  const stages = getStageStates(db, projectId);
  const doneCount = stages.filter((s) => s.status === "done").length;
  const allDone = doneCount === STAGE_COUNT;
  const resumeStage = allDone
    ? STAGE_COUNT
    : (stages.find((s) => s.status !== "done")?.num ?? 1);

  const sourceCount = listSources(db, projectId).length;
  const pendingReviews = countPendingReviews(db, projectId);
  const changes = listChanges(db, projectId, 5);
  const jobs = listJobs(db, projectId);

  return {
    project,
    stages,
    doneCount,
    resumeStage,
    nextAction: computeNextAction(db, projectId, resumeStage, {
      sourceCount,
      pendingReviews,
      allDone,
    }),
    sourceCount,
    pendingReviews,
    changeCount: listChanges(db, projectId, 100000).length,
    recentChanges: changes,
    latestJob: jobs[0],
    allDone,
  };
}

function computeNextAction(
  db: Db,
  projectId: string,
  stage: number,
  ctx: { sourceCount: number; pendingReviews: number; allDone: boolean },
): string {
  if (ctx.allDone) {
    const checklist = listChecklist(db, projectId);
    const open = checklist.filter((c) => !c.done).length;
    return open > 0
      ? `All stages are done — ${open} checklist item(s) still open in Export.`
      : "All stages complete. The book is ready. 🎉";
  }
  switch (stage) {
    case 1:
      if (ctx.sourceCount === 0)
        return "Add your first source — a transcript, document or notes.";
      if (!latestText(db, projectId, "raw"))
        return `Compile your ${ctx.sourceCount} source(s) into the raw working text.`;
      return "Raw text compiled — mark Sources complete to move on.";
    case 2:
      return getContract(db, projectId)
        ? "Editorial contract signed — mark the stage complete to move on."
        : "Choose the editorial mode (verbatim / prose / hybrid) and sign the contract.";
    case 3:
      return getStyleProfile(db, projectId)
        ? "Style profile saved — mark the stage complete to move on."
        : "Capture the voice: tone, register and narrative person.";
    case 4:
      return latestText(db, projectId, "passA")
        ? "Cleanup pass done — review the result and mark the stage complete."
        : "Run Cleanup Pass A over the raw text.";
    case 5:
      return latestText(db, projectId, "passB")
        ? "Refine pass done — review the result and mark the stage complete."
        : "Run Refine Pass B over the cleaned text.";
    case 6:
      if (ctx.pendingReviews > 0)
        return `Resolve ${ctx.pendingReviews} pending review item(s), then finalize the text.`;
      return latestText(db, projectId, "final")
        ? "Text finalized — mark Review complete to move on."
        : "No pending reviews — finalize the text.";
    case 7:
      return "Check trim size, typography and margins, then mark Format complete.";
    case 8: {
      const exports = listPdfVersions(db, projectId);
      return exports.length === 0
        ? "Generate the first export of the book."
        : "Walk the final checklist and mark Export complete.";
    }
    default:
      return "Continue where you left off.";
  }
}
