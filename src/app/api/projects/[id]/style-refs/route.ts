import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { addStyleReference } from "@/lib/ingest/styleRef";
import { getProject, touchProject } from "@/lib/repo/projects";

// Multi-file upload endpoint for Stage 3 style references, mirroring the
// Stage 1 sources route: each file reports success or a clear error
// independently, and a failed file saves nothing.

export interface StyleRefUploadItem {
  filename: string;
  ok: boolean;
  error?: string;
  refId?: string;
  wordCount?: number;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: projectId } = await context.params;
  const db = getDb();
  if (!getProject(db, projectId)) {
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

  const results: StyleRefUploadItem[] = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await addStyleReference(db, projectId, file.name, buffer);
    results.push(
      result.ok
        ? {
            filename: file.name,
            ok: true,
            refId: result.ref.id,
            wordCount: result.ref.wordCount,
          }
        : { filename: file.name, ok: false, error: result.error },
    );
  }

  if (results.some((r) => r.ok)) {
    touchProject(db, projectId);
    revalidatePath(`/projects/${projectId}/stages/3`);
  }
  return NextResponse.json({ results });
}
