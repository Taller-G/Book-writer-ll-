import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getDbHandle } from "@/lib/db/client";
import { parseFormatData } from "@/lib/format/config";
import {
  estimatePageCount,
  getPaperStock,
  spineWidthMm,
} from "@/lib/cover/spine";
import {
  checkUploadFit,
  readPngDimensions,
  spreadDims,
} from "@/lib/cover/spread";
import { saveCoverImage } from "@/lib/files/store";
import { getSpine, insertUploadedConcept } from "@/lib/repo/covers";
import { getFormatConfig } from "@/lib/repo/output";
import { getProject, touchProject } from "@/lib/repo/projects";
import { latestText } from "@/lib/repo/texts";
import { newId } from "@/lib/util";

// PNG cover upload (spec §4 Stage 7). A route handler, not a server action, so
// a print-resolution PNG is not subject to the server-action body-size limit.
// The upload is checked against the full-spread dimensions (back + spine +
// front, including 3 mm bleed) before it is stored as a cover concept.

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: projectId } = await context.params;
  const handle = getDbHandle();
  const { db } = handle;
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
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No file received." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const dims = readPngDimensions(buffer);
  if (!dims) {
    return NextResponse.json(
      { error: "The file is not a valid PNG." },
      { status: 400 },
    );
  }

  // Target spread: the live page-count estimate drives the spine width.
  const format = parseFormatData(getFormatConfig(db, projectId).data);
  const finalText = latestText(db, projectId, "final");
  const pageCount = estimatePageCount(finalText?.content ?? "", format);
  const spine = getSpine(db, projectId);
  const spineMm = spineWidthMm(pageCount, getPaperStock(spine.paperStock));
  const spread = spreadDims(format, spineMm);
  const fit = checkUploadFit(dims, spread);

  const coverId = newId();
  const title =
    (String(form.get("title") ?? "").trim() || file.name).slice(0, 120);
  const filePath = saveCoverImage(projectId, coverId, file.name, buffer);
  const concept = insertUploadedConcept(db, {
    projectId,
    title,
    filePath,
    widthPx: dims.width,
    heightPx: dims.height,
    note: fit.ok
      ? `Matches the ${spread.totalWidthPx}×${spread.totalHeightPx}px spread (incl. bleed).`
      : fit.reasons.join(" "),
  });

  touchProject(db, projectId);
  revalidatePath(`/projects/${projectId}/stages/7`);
  return NextResponse.json({
    ok: true,
    conceptId: concept.id,
    fit,
    spread: {
      totalWidthMm: spread.totalWidthMm,
      totalHeightMm: spread.totalHeightMm,
      totalWidthPx: spread.totalWidthPx,
      totalHeightPx: spread.totalHeightPx,
      spineWidthMm: spineMm,
      pageCount,
    },
  });
}
