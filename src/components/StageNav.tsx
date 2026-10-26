import Link from "next/link";
import type { StageState } from "@/lib/repo/projects";
import { STAGE_STATUS_LABELS } from "@/lib/stages";

export function StageNav({
  projectId,
  states,
  activeStage,
}: {
  projectId: string;
  states: StageState[];
  activeStage: number;
}) {
  return (
    <nav className="stage-nav" aria-label="Pipeline stages">
      {states.map((s) =>
        s.status === "locked" ? (
          <span className="stage-item" key={s.num} title="Finish the previous stages to unlock">
            <span>
              <span className="stage-num">{s.num}</span>
              {s.title}
            </span>
            <span className="badge locked">🔒</span>
          </span>
        ) : (
          <Link
            key={s.num}
            href={`/projects/${projectId}/stages/${s.num}`}
            className={s.num === activeStage ? "active" : ""}
          >
            <span>
              <span className="stage-num">{s.num}</span>
              {s.title}
            </span>
            <span className={`badge ${s.status}`}>
              {s.status === "done" ? "✓" : STAGE_STATUS_LABELS[s.status]}
            </span>
          </Link>
        ),
      )}
    </nav>
  );
}
