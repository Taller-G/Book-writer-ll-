import type { AiClient, AiRequest, AiResponse } from "@/lib/ai";
import type { DbHandle } from "@/lib/db/client";
import { saveContract, saveStyleProfile } from "@/lib/repo/editorial";
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

/** A project ready for the master-text stage: prose contract, style, passA. */
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
  saveStyleProfile(handle.db, {
    projectId,
    tone: "cálido y directo",
    register: "conversacional",
    person: "primera persona",
    notes: "Nunca usar jerga corporativa.",
  });
  insertText(handle.db, {
    projectId,
    stageKey: "passA",
    version: 1,
    content: passAContent,
  });
  return projectId;
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
