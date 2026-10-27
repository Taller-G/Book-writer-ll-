import type { AiClient, AiRequest, AiResponse } from "@/lib/ai";
import type { DbHandle } from "@/lib/db/client";
import type { EditorialContract, StyleProfile } from "@/lib/db/schema";
import { confirmStyleProfile, saveContract } from "@/lib/repo/editorial";
import { createProject } from "@/lib/repo/projects";
import { insertText } from "@/lib/repo/texts";

/** Records every request and answers via the provided responder. */
export class FakeAiClient implements AiClient {
  requests: AiRequest[] = [];

  constructor(
    private responder: (req: AiRequest, callIndex: number) => string,
  ) {}

  async complete(request: AiRequest): Promise<AiResponse> {
    const text = this.responder(request, this.requests.length);
    this.requests.push(request);
    return {
      text,
      model: "fake/model",
      usage: { promptTokens: 10, completionTokens: 10, costUsd: 0.001 },
    };
  }
}

/** A project ready for the master-text stage: prose contract, CONFIRMED
 *  style profile, passA. */
export function seedProseProject(
  handle: DbHandle,
  passAContent: string,
): string {
  const projectId = createProject(handle, { title: "La vida hablada" }).id;
  saveContract(handle.db, {
    projectId,
    mode: "prose",
    rules: "Mantener las historias; quitar muletillas.",
    notes: "",
  });
  confirmStyleProfile(handle.db, projectId, {
    tone: "cálido y directo",
    register: "conversacional",
    person: "primera persona",
    notes: "Nunca usar jerga corporativa.",
    voice: "la del autor hablando a un amigo",
    rhythm: "frases cortas",
    punctuation: "",
    metaphors: "ejemplos cotidianos",
    openings: "",
    excerpts: ["Lo importante es la mesa compartida."],
  });
  insertText(handle.db, {
    projectId,
    stageKey: "passA",
    version: 1,
    content: passAContent,
  });
  return projectId;
}

/** Full typed contract/profile literals for calling engine functions directly. */
export function testContract(projectId: string): EditorialContract {
  return {
    projectId,
    mode: "prose",
    rules: "",
    notes: "",
    signedAt: null,
    tone: null,
    destination: null,
    authorship: null,
    rightsNotes: "",
    legalText: "",
    version: 1,
  };
}

export function testStyleProfile(projectId: string): StyleProfile {
  return {
    projectId,
    tone: "cálido y directo",
    register: "conversacional",
    person: "primera",
    notes: "",
    data: "{}",
    updatedAt: "",
    voice: "",
    rhythm: "",
    punctuation: "",
    metaphors: "",
    openings: "",
    excerpts: "[]",
    status: "confirmed",
    version: 1,
    confirmedAt: null,
    sample: "",
  };
}

/** Six-paragraph cleaned material used across the master-text tests. */
export const PASS_A = [
  "[00:01:12] Bienvenidos al podcast, hoy vamos a hablar de la infancia.",
  "Cuando era chico vivíamos en una casa con patio y limonero.",
  "Mi abuela decía siempre: lo importante es la mesa compartida.",
  "Años después entendí lo del limonero, cuando me fui de casa.",
  "En el trabajo aprendí que nadie construye solo nada que dure.",
  "Mi abuela decía siempre: lo importante es la mesa compartida. Eso vuelve.",
].join("\n\n");
