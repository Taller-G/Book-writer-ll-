// Server-side factory for the app's AI client (spec §9). All AI-dependent
// stages obtain their client here: the decrypted key never leaves this module
// scope, model roles come from remote configuration, and every completed call
// is recorded in ai_usage so the project spend counter stays truthful.

import type { Db } from "../db/client";
import { recordAiUsage } from "../repo/aiUsage";
import { getApiKey } from "../repo/prefs";
import { getModelConfig } from "./config";
import { AiAuthError } from "./errors";
import { OpenRouterClient, type OpenRouterClientOptions } from "./openrouter";
import type { AiClient } from "./types";

export type { AiClient, AiRequest, AiResponse, SystemContext } from "./types";
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
 * Build the AI client from the encrypted key in user_prefs. Throws AiAuthError
 * when no key is configured — callers surface that as "add your key in
 * Settings". Only OpenRouter exists today; a direct Anthropic (or other)
 * provider slots in behind the same AiClient interface.
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
  return new OpenRouterClient({
    apiKey,
    getConfig: () => getModelConfig(),
    onUsage: (record) => recordAiUsage(db, record),
    ...overrides,
  });
}
