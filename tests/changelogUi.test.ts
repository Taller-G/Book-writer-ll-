import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The page reads the singleton DB resolved against dataDir(); point it at a
// temp dir before importing anything that captures it.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-changelog-ui-"));
process.env.BOOK_WRITER_DATA_DIR = tmpDataDir;

import { getDbHandle } from "@/lib/db/client";
import { appendChange } from "@/lib/repo/changeLog";
import { createProject } from "@/lib/repo/projects";
import ChangeLogPage from "@/app/projects/[id]/changelog/page";

afterAll(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

let projectId: string;

beforeAll(() => {
  const handle = getDbHandle();
  projectId = createProject(handle, { title: "UI changelog" }).id;
  appendChange(handle.db, {
    projectId,
    what: 'Corrected "Tu shé" → "Touché" [Misheard word (ASR)]',
    where: "stage 4 · passA · transcription noise",
    why: 'the transcriber misheard "Touché"',
    authorizedBy: "job cleanup_pass_a (abc123)",
    category: "ASR",
  });
  appendChange(handle.db, {
    projectId,
    what: "Ingested audio source",
    where: "stage 1 · sources",
    why: "uploaded",
    authorizedBy: "source ingestion",
  });
});

describe("change-log UI (criterion 4)", () => {
  it("renders every change human-readably, with its classification", async () => {
    const element = await ChangeLogPage({
      params: Promise.resolve({ id: projectId }),
    });
    const html = renderToStaticMarkup(element);

    // Every change is shown with what/where/why/who/when columns.
    expect(html).toContain("Corrected");
    expect(html).toContain("Touché");
    expect(html).toContain("transcription noise");
    expect(html).toContain('misheard');
    expect(html).toContain("cleanup_pass_a");

    // The classification badge renders the taxonomy label.
    expect(html).toContain("ASR");
    expect(html).toContain("Misheard word");

    // The second (uncategorized) change still appears.
    expect(html).toContain("Ingested audio source");
    // Every change is rendered as its own row (both of ours, plus any the
    // project seeded on creation).
    const rows = html.split('data-testid="change-log-row"').length - 1;
    expect(rows).toBeGreaterThanOrEqual(2);
  });
});
