import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { dataDir, getDbHandle } from "@/lib/db/client";
import { getProject } from "@/lib/repo/projects";

// Streams a reaction/question audio clip to the review player. The clip path is
// a stored relative path (sources/<projectId>/<sourceId>/derived/<file>); it is
// resolved against dataDir() and must stay inside this project's source tree —
// a traversal attempt (../) or a path for another project is refused.
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: projectId } = await context.params;
  const handle = getDbHandle();
  if (!getProject(handle.db, projectId)) {
    return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  }
  const rel = new URL(request.url).searchParams.get("path") ?? "";
  if (!rel) return NextResponse.json({ error: "Missing path." }, { status: 400 });

  const root = path.resolve(dataDir(), "sources", projectId);
  const abs = path.resolve(dataDir(), rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return NextResponse.json({ error: "Forbidden path." }, { status: 403 });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return NextResponse.json({ error: "Clip not found." }, { status: 404 });
  }
  const data = fs.readFileSync(abs);
  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(data.length),
      "Cache-Control": "no-store",
    },
  });
}
