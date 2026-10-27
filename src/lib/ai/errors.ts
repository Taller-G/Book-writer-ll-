// Operational error taxonomy for the AI client (spec §9). Messages are
// user-facing: they name the condition ("invalid key", "no credit") and, when
// actionable, what to do about it. They must NEVER contain the API key —
// redactSecrets is applied to any provider text before it lands in a message.

export const OPENROUTER_TOPUP_URL = "https://openrouter.ai/settings/credits";

/** The key is missing, malformed, or rejected by the provider (HTTP 401). */
export class AiAuthError extends Error {
  readonly kind = "auth" as const;
}

/** Credits are exhausted (HTTP 402). Actionable: link to top up. */
export class AiCreditsError extends Error {
  readonly kind = "credits" as const;
  constructor(detail?: string) {
    super(
      `No credit: your OpenRouter balance is exhausted${detail ? ` (${detail})` : ""}. ` +
        `Top up at ${OPENROUTER_TOPUP_URL} and retry.`,
    );
  }
}

/** Rate limited (HTTP 429) after all retries were spent. */
export class AiRateLimitError extends Error {
  readonly kind = "rate_limit" as const;
}

/** Provider outage / server error after retries and model fallbacks. */
export class AiProviderError extends Error {
  readonly kind = "provider" as const;
}

/**
 * Strip anything that looks like an API key or bearer token from provider
 * text before it is stored or shown. Defense in depth: we never put the key
 * in request bodies or error strings ourselves, but provider echoes are
 * outside our control.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-or-[A-Za-z0-9-]+/g, "sk-or-***")
    .replace(/sk-ant-[A-Za-z0-9-]+/g, "sk-ant-***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
}
