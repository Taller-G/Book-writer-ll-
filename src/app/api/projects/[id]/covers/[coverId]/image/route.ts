import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { dataDir, getDbHandle } from "@/lib/db/client";
import { getConcept } from "@/lib/repo/covers";

// Serves an uploaded cover PNG so the preview can show the real design. Only
// files that belong to this project's concept and sit under data/covers are
// served — the stored path is validated against the covers directory.

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; coverId: string }> },
): Promise<NextResponse> {
  const { id: projectId, coverId } = await context.params;
  const { db } = getDbHandle();
  const concept = getConcept(db, coverId);
  if (!concept || concept.projectId !== projectId || !concept.filePath) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const abs = path.resolve(dataDir(), concept.filePath);
  const coversRoot = path.resolve(dataDir(), "covers");
  if (!abs.startsWith(coversRoot + path.sep) || !fs.existsSync(abs)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const body = fs.readFileSync(abs);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
}
