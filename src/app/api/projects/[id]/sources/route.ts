import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getDbHandle } from "@/lib/db/client";
import { ingestFile } from "@/lib/ingest/ingest";
import { getProject, touchProject } from "@/lib/repo/projects";

// Multi-file upload endpoint for Stage 1. A route handler (not a server
// action) so large audio/video uploads are not subject to the server-action
// body size limit, and so each file can report success or a clear error
// independently.

export interface UploadResponseItem {
  filename: string;
  ok: boolean;
  error?: string;
  note?: string;
  sourceId?: string;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: projectId } = await context.params;
  const handle = getDbHandle();
  if (!getProject(handle.db, projectId)) {
    return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid upload: expected multipart form data." },
      { status: 400 },
    );
  }
  const files = form
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size >= 0 && f.name !== "");
  if (files.length === 0) {
    return NextResponse.json({ error: "No files received." }, { status: 400 });
  }

  const results: UploadResponseItem[] = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await ingestFile(handle, projectId, file.name, buffer);
    results.push(
      result.ok
        ? {
            filename: file.name,
            ok: true,
            sourceId: result.source.id,
            note: result.note,
          }
        : { filename: file.name, ok: false, error: result.error },
    );
  }

  if (results.some((r) => r.ok)) {
    touchProject(handle.db, projectId);
    revalidatePath(`/projects/${projectId}/stages/1`);
  }
  return NextResponse.json({ results });
}
