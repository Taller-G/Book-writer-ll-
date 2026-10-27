import type { Db } from "@/lib/db/client";
import { parseFormatData } from "@/lib/format/config";
import { getFormatConfig, layoutHasBegun } from "@/lib/repo/output";
import { latestText } from "@/lib/repo/texts";
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
  return (
    <FormatWizard
      projectId={projectId}
      saved={data}
      sampleText={(sample?.content ?? "").slice(0, 6000)}
      layoutStarted={layoutHasBegun(db, projectId)}
      updatedAt={config.updatedAt}
    />
  );
}
