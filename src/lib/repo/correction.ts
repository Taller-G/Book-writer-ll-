import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { correctionMessages, type CorrectionMessage } from "../db/schema";
import { newId, now } from "../util";

// The persistent correction-cycle conversation, one thread per project. User
// messages may carry an annotation (page + region + marked-region image) or an
// attached screenshot; agent messages carry a classification and, for content
// changes, wait for an explicit confirmation before any closed text is touched.

export interface NewCorrectionMessage {
  projectId: string;
  role: CorrectionMessage["role"];
  body?: string;
  pageNumber?: number | null;
  region?: string | null;
  image?: string | null;
  classification?: CorrectionMessage["classification"];
  status?: CorrectionMessage["status"];
  pdfVersion?: number | null;
  targetRef?: string | null;
  proposal?: string | null;
}

export function addCorrectionMessage(
  db: Db,
  input: NewCorrectionMessage,
): CorrectionMessage {
  const id = newId();
  db.insert(correctionMessages)
    .values({
      id,
      projectId: input.projectId,
      role: input.role,
      body: input.body ?? "",
      pageNumber: input.pageNumber ?? null,
      region: input.region ?? null,
      image: input.image ?? null,
      classification: input.classification ?? null,
      status: input.status ?? "open",
      pdfVersion: input.pdfVersion ?? null,
      targetRef: input.targetRef ?? null,
      proposal: input.proposal ?? null,
      createdAt: now(),
    })
    .run();
  return getCorrectionMessage(db, id)!;
}

export function getCorrectionMessage(
  db: Db,
  id: string,
): CorrectionMessage | undefined {
  return db
    .select()
    .from(correctionMessages)
    .where(eq(correctionMessages.id, id))
    .get();
}

export function listCorrectionMessages(
  db: Db,
  projectId: string,
): CorrectionMessage[] {
  return db
    .select()
    .from(correctionMessages)
    .where(eq(correctionMessages.projectId, projectId))
    .orderBy(asc(correctionMessages.createdAt))
    .all();
}

export function setCorrectionStatus(
  db: Db,
  id: string,
  status: CorrectionMessage["status"],
  patch?: { pdfVersion?: number; proposal?: string },
): void {
  db.update(correctionMessages)
    .set({
      status,
      ...(patch?.pdfVersion !== undefined ? { pdfVersion: patch.pdfVersion } : {}),
      ...(patch?.proposal !== undefined ? { proposal: patch.proposal } : {}),
    })
    .where(eq(correctionMessages.id, id))
    .run();
}
