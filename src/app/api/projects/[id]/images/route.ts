import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getDbHandle } from "@/lib/db/client";
import { saveImageFile } from "@/lib/files/store";
import { readImageDimensions } from "@/lib/images/dimensions";
import { addImage, regenerateImageCredits } from "@/lib/repo/images";
import { getProject, touchProject } from "@/lib/repo/projects";
import { newId } from "@/lib/util";

// Image upload endpoint for Stage 7. A route handler (not a server action) so
// large images are not subject to the server-action body-size limit, and so
// each file reports success or a clear error independently. Uploaded images
// land in the review grid (status 'review') with origin 'own' by default; the
// author adjusts origin and placement from the panel.

const ACCEPTED = /^image\/(png|jpe?g|gif|webp)$/i;

export interface ImageUploadResponseItem {
  filename: string;
  ok: boolean;
  error?: string;
  imageId?: string;
  width?: number;
  height?: number;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: projectId } = await context.params;
  const handle = getDbHandle();
  const project = getProject(handle.db, projectId);
  if (!project) {
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
    .filter((f): f is File => f instanceof File && f.size > 0 && f.name !== "");
  if (files.length === 0) {
    return NextResponse.json({ error: "No files received." }, { status: 400 });
  }

  const results: ImageUploadResponseItem[] = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = file.type || "application/octet-stream";
    if (!ACCEPTED.test(mime)) {
      results.push({
        filename: file.name,
        ok: false,
        error: `Unsupported image type "${mime}". Use PNG, JPEG, GIF or WEBP.`,
      });
      continue;
    }
    const imageId = newId();
    const dims = readImageDimensions(buffer);
    const stored = saveImageFile(projectId, imageId, file.name, buffer);
    addImage(handle.db, {
      id: imageId,
      projectId,
      origin: "own",
      filePath: stored.relativePath,
      originalName: file.name,
      mimeType: mime,
      sizeBytes: stored.sizeBytes,
      checksumSha1: stored.checksumSha1,
      widthPx: dims?.width ?? 0,
      heightPx: dims?.height ?? 0,
    });
    results.push({
      filename: file.name,
      ok: true,
      imageId,
      width: dims?.width ?? 0,
      height: dims?.height ?? 0,
    });
  }

  if (results.some((r) => r.ok)) {
    regenerateImageCredits(handle.db, projectId, project.author);
    touchProject(handle.db, projectId);
    revalidatePath(`/projects/${projectId}/stages/7`);
  }
  return NextResponse.json({ results });
}
