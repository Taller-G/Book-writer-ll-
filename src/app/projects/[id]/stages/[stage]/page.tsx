import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { canCompleteStage } from "@/lib/gates";
import { getProject, getStageStates } from "@/lib/repo/projects";
import { getStage, STAGE_COUNT } from "@/lib/stages";
import { StageFooter } from "@/components/StageFooter";
import { StageNav } from "@/components/StageNav";
import { Stage1Sources } from "@/components/stages/Stage1Sources";
import { Stage2Contract } from "@/components/stages/Stage2Contract";
import { Stage3Style } from "@/components/stages/Stage3Style";
import { Stage6Review } from "@/components/stages/Stage6Review";
import { Stage7Format } from "@/components/stages/Stage7Format";
import { Stage8Export } from "@/components/stages/Stage8Export";
import { StageTextPass } from "@/components/stages/StageTextPass";

export const dynamic = "force-dynamic";

export default async function StagePage({
  params,
}: {
  params: Promise<{ id: string; stage: string }>;
}) {
  const { id, stage } = await params;
  const stageNum = Number(stage);
  const db = getDb();
  const project = getProject(db, id);
  if (!project || !Number.isInteger(stageNum) || stageNum < 1 || stageNum > STAGE_COUNT) {
    notFound();
  }
  const states = getStageStates(db, id);
  if (states[stageNum - 1].status === "locked") {
    // Skipping ahead is not allowed — land on the overview instead.
    redirect(`/projects/${id}`);
  }
  const def = getStage(stageNum)!;
  const gate = canCompleteStage(db, id, stageNum);

  return (
    <div>
      <p>
        <Link href={`/projects/${id}`}>← {project.title}</Link>
      </p>
      <div className="wizard">
        <StageNav projectId={id} states={states} activeStage={stageNum} />
        <div>
          <h1>
            Stage {def.num}: {def.title}
          </h1>
          <p className="muted">{def.description}</p>

          {stageNum === 1 && <Stage1Sources db={db} projectId={id} />}
          {stageNum === 2 && <Stage2Contract db={db} projectId={id} />}
          {stageNum === 3 && <Stage3Style db={db} projectId={id} />}
          {stageNum === 4 && (
            <StageTextPass
              db={db}
              projectId={id}
              stage={4}
              jobType="cleanup_pass_a"
              runLabel="Run Cleanup Pass A"
              inputKey="raw"
              outputKey="passA"
              intro="Fixes transcription noise — filler words, spacing, punctuation — and records every change in the audit log."
            />
          )}
          {stageNum === 5 && (
            <StageTextPass
              db={db}
              projectId={id}
              stage={5}
              jobType="refine_pass_b"
              runLabel="Run Refine Pass B"
              inputKey="passA"
              outputKey="passB"
              intro="Shapes structure and flow within the editorial contract. Doubtful edits are sent to the review queue instead of being applied silently."
            />
          )}
          {stageNum === 6 && <Stage6Review db={db} projectId={id} />}
          {stageNum === 7 && <Stage7Format db={db} projectId={id} />}
          {stageNum === 8 && <Stage8Export db={db} projectId={id} />}

          <StageFooter
            projectId={id}
            stage={stageNum}
            states={states}
            canComplete={gate.ok}
            blockReason={gate.reason}
          />
        </div>
      </div>
    </div>
  );
}
