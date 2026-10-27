import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { apparatusSections, type ApparatusSection } from "../db/schema";
import { newId, now } from "../util";
import { appendChange } from "./changeLog";

// Editorial apparatus (spec §6): sections proposed around the master text
// (prologue, introduction, epilogue, glossary…). Each proposal carries a
// plain-language explanation of what the section is for; the user accepts,
// edits or discards each one individually. Only accepted sections are
// assembled into the FINAL text — discarding never breaks the book.

export interface ApparatusGuideEntry {
  key: string;
  placement: "front" | "back";
  /** Plain-language "what is this for", shown with every proposal. */
  explanation: string;
}

/** The §6 catalog the AI proposes from. Order = assembly order. */
export const APPARATUS_GUIDE: ApparatusGuideEntry[] = [
  {
    key: "dedicatoria",
    placement: "front",
    explanation:
      "Una línea íntima que dedica el libro a alguien. Da calidez humana " +
      "antes de empezar; se descarta sin afectar al texto.",
  },
  {
    key: "prologo",
    placement: "front",
    explanation:
      "Texto de apertura que presenta el libro y su origen, idealmente con " +
      "la voz de alguien cercano al autor. Prepara al lector para el tono.",
  },
  {
    key: "introduccion",
    placement: "front",
    explanation:
      "Explica de qué trata el libro, de dónde sale el material y cómo " +
      "leerlo. Orienta al lector sin adelantar el contenido.",
  },
  {
    key: "nota-editorial",
    placement: "front",
    explanation:
      "Cuenta cómo se editó el material (qué se limpió, qué se conservó). " +
      "Da transparencia sobre el paso de palabra hablada a libro.",
  },
  {
    key: "epilogo",
    placement: "back",
    explanation:
      "Cierre que retoma los hilos del libro y deja una última reflexión. " +
      "Da sensación de final deliberado en vez de corte abrupto.",
  },
  {
    key: "glosario",
    placement: "back",
    explanation:
      "Lista de términos propios del autor o técnicos con su significado. " +
      "Útil cuando el libro usa vocabulario que no todo lector conoce.",
  },
  {
    key: "agradecimientos",
    placement: "back",
    explanation:
      "Reconocimiento a quienes hicieron posible el libro. Convencional " +
      "pero esperado; se descarta sin afectar al texto.",
  },
  {
    key: "nota-autor",
    placement: "back",
    explanation:
      "Breve semblanza del autor: quién es y por qué habla de esto. Ayuda " +
      "al lector que llega al libro sin conocerlo.",
  },
];

export function apparatusGuideEntry(key: string): ApparatusGuideEntry | undefined {
  return APPARATUS_GUIDE.find((g) => g.key === key);
}

export function listApparatus(db: Db, projectId: string): ApparatusSection[] {
  return db
    .select()
    .from(apparatusSections)
    .where(eq(apparatusSections.projectId, projectId))
    .orderBy(asc(apparatusSections.position))
    .all();
}

export function acceptedApparatus(
  db: Db,
  projectId: string,
  placement: "front" | "back",
): ApparatusSection[] {
  return listApparatus(db, projectId).filter(
    (s) => s.status === "accepted" && s.placement === placement,
  );
}

/** Replace the project's proposed sections with a fresh AI proposal.
 *  Sections the user already accepted or discarded are left untouched. */
export function saveProposedApparatus(
  db: Db,
  projectId: string,
  proposals: Array<{ sectionKey: string; title: string; content: string }>,
  jobId?: string,
): ApparatusSection[] {
  const existing = listApparatus(db, projectId);
  const decided = new Set(
    existing.filter((s) => s.status !== "proposed").map((s) => s.sectionKey),
  );
  const ts = now();
  const saved: ApparatusSection[] = [];
  for (const p of proposals) {
    const guide = apparatusGuideEntry(p.sectionKey);
    if (!guide || decided.has(p.sectionKey)) continue;
    const position = APPARATUS_GUIDE.findIndex((g) => g.key === p.sectionKey);
    const prior = existing.find((s) => s.sectionKey === p.sectionKey);
    if (prior) {
      db.update(apparatusSections)
        .set({ title: p.title, content: p.content, jobId, updatedAt: ts })
        .where(eq(apparatusSections.id, prior.id))
        .run();
      saved.push({ ...prior, title: p.title, content: p.content });
    } else {
      const id = newId();
      db.insert(apparatusSections)
        .values({
          id,
          projectId,
          sectionKey: p.sectionKey,
          title: p.title,
          explanation: guide.explanation,
          content: p.content,
          placement: guide.placement,
          status: "proposed",
          position,
          jobId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      saved.push(
        db.select().from(apparatusSections).where(eq(apparatusSections.id, id)).get()!,
      );
    }
  }
  return saved;
}

export function setApparatusStatus(
  db: Db,
  projectId: string,
  sectionKey: string,
  status: "accepted" | "discarded",
  editedContent?: string,
): void {
  const section = db
    .select()
    .from(apparatusSections)
    .where(
      and(
        eq(apparatusSections.projectId, projectId),
        eq(apparatusSections.sectionKey, sectionKey),
      ),
    )
    .get();
  if (!section) return;
  const edited =
    status === "accepted" &&
    editedContent !== undefined &&
    editedContent !== section.content;
  db.update(apparatusSections)
    .set({
      status,
      ...(edited ? { content: editedContent } : {}),
      updatedAt: now(),
    })
    .where(eq(apparatusSections.id, section.id))
    .run();
  appendChange(db, {
    projectId,
    what:
      status === "accepted"
        ? `Apparatus section "${section.title}" accepted${edited ? " with edits" : ""}`
        : `Apparatus section "${section.title}" discarded`,
    where: `stage 5 · apparatus · ${sectionKey}`,
    why:
      status === "accepted"
        ? "user approved this section for the final book"
        : "user decided the book does not need this section",
    authorizedBy: "user",
  });
}
