// Server-side factory for the app's AI client (spec §9). All AI-dependent
// stages obtain their client here: the decrypted key never leaves this module
// scope, model roles come from remote configuration, and every completed call
// is recorded in ai_usage so the project spend counter stays truthful.

import type { Db } from "../db/client";
import { recordAiUsage } from "../repo/aiUsage";
import { getConfirmedStyleProfile, getContract } from "../repo/editorial";
import { getApiKey } from "../repo/prefs";
import { getModelConfig } from "./config";
import { AiAuthError } from "./errors";
import { OpenRouterClient, type OpenRouterClientOptions } from "./openrouter";
import type { AiClient, AiRequest, AiResponse } from "./types";

export type {
  AiClient,
  AiContentPart,
  AiMessage,
  AiRequest,
  AiResponse,
  SystemContext,
} from "./types";
export { buildSystemPrompt } from "./types";
export {
  AiAuthError,
  AiCreditsError,
  AiProviderError,
  AiRateLimitError,
  OPENROUTER_TOPUP_URL,
} from "./errors";
export type { ModelRole } from "./config";

/**
 * Injects the project's editorial contract and CONFIRMED style profile into
 * every call's system context, loaded fresh from the database by projectId.
 * The guarantee is structural: consistency never depends on the caller (or a
 * long conversation) remembering — a project resumed weeks later injects the
 * identical profile because it is read from disk on every single call.
 * Callers may still pass explicit values (kept as-is), and `system.bare`
 * opts out entirely (profile extraction only).
 */
class ProjectContextClient implements AiClient {
  constructor(
    private readonly inner: AiClient,
    private readonly db: Db,
  ) {}

  complete(request: AiRequest): Promise<AiResponse> {
    if (request.system.bare) return this.inner.complete(request);
    const system = {
      ...request.system,
      contract:
        request.system.contract ?? getContract(this.db, request.projectId),
      styleProfile:
        request.system.styleProfile ??
        getConfirmedStyleProfile(this.db, request.projectId),
    };
    return this.inner.complete({ ...request, system });
  }
}

/**
 * Build the AI client from the encrypted key in user_prefs. Throws AiAuthError
 * when no key is configured — callers surface that as "add your key in
 * Settings". Only OpenRouter exists today; a direct Anthropic (or other)
 * provider slots in behind the same AiClient interface. The returned client
 * always wraps the provider in ProjectContextClient, so every call carries
 * the project's contract and confirmed style profile.
 */
export function createAiClient(
  db: Db,
  overrides?: Partial<
    Pick<OpenRouterClientOptions, "fetchImpl" | "sleep" | "baseUrl" | "maxRetries">
  >,
): AiClient {
  const apiKey = getApiKey(db);
  if (!apiKey) {
    throw new AiAuthError(
      "No OpenRouter API key configured. Paste your key in Settings first.",
    );
  }
  const provider = new OpenRouterClient({
    apiKey,
    getConfig: () => getModelConfig(),
    onUsage: (record) => recordAiUsage(db, record),
    ...overrides,
  });
  return new ProjectContextClient(provider, db);
}
