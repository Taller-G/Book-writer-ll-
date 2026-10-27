import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readImageFile } from "@/lib/files/store";
import { getImage } from "@/lib/repo/images";

// Serve a stored image's bytes — the review grid, placement previews and
// thumbnails all load through here. Scoped to the project so an image id from
// another project cannot be fetched via this project's URL.

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; imageId: string }> },
): Promise<NextResponse> {
  const { id: projectId, imageId } = await context.params;
  const image = getImage(getDb(), imageId);
  if (!image || image.projectId !== projectId) {
    return NextResponse.json({ error: "Image not found." }, { status: 404 });
  }
  let bytes: Buffer;
  try {
    bytes = readImageFile(image.filePath);
  } catch {
    return NextResponse.json({ error: "Image file missing." }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": image.mimeType || "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
