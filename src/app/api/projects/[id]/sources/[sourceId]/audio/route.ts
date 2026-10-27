import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { dataDir, getDb } from "@/lib/db/client";
import { getProject } from "@/lib/repo/projects";
import { getSource } from "@/lib/repo/sources";

// Streams a source's original audio so the review-queue player can scrub to the
// located clip window. HTTP Range is honoured so the <audio> element can seek
// straight into the window instead of downloading the whole file. The trimming
// to ±10–15 s is done client-side by clamping playback to the located bounds.

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; sourceId: string }> },
): Promise<NextResponse> {
  const { id: projectId, sourceId } = await context.params;
  const db = getDb();
  if (!getProject(db, projectId)) {
    return new NextResponse("Unknown project", { status: 404 });
  }
  const source = getSource(db, sourceId);
  if (!source || source.projectId !== projectId || !source.originalPath) {
    return new NextResponse("No audio for this source", { status: 404 });
  }
  const abs = path.join(dataDir(), source.originalPath);
  let size: number;
  try {
    size = fs.statSync(abs).size;
  } catch {
    return new NextResponse("Audio file is missing", { status: 404 });
  }
  const contentType = source.mimeType || "application/octet-stream";

  const range = request.headers.get("range");
  const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (match) {
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : size - 1;
    if (Number.isFinite(start) && start >= 0 && start < size && start <= end) {
      const clampedEnd = Math.min(end, size - 1);
      const slice = fs.readFileSync(abs).subarray(start, clampedEnd + 1);
      return new NextResponse(new Uint8Array(slice), {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Range": `bytes ${start}-${clampedEnd}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(slice.length),
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
  }

  const buffer = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
