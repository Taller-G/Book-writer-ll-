import type { ModelConfig, ModelRole } from "./config";
import {
  AiAuthError,
  AiCreditsError,
  AiProviderError,
  AiRateLimitError,
  redactSecrets,
} from "./errors";
import {
  buildSystemPrompt,
  type AiClient,
  type AiRequest,
  type AiResponse,
} from "./types";

// OpenRouter implementation of the AiClient seam, against the
// OpenAI-compatible chat completions API. Operational behavior (spec §9):
//   429  -> exponential backoff (honoring Retry-After) and retry, same model
//   402  -> AiCreditsError with the top-up link
//   401  -> AiAuthError ("invalid key")
//   5xx / network -> fall back across the role's Claude variants in order
// The API key lives only in the Authorization header; it is never logged,
// never placed in a request body, and provider text is redacted before it
// can reach an error message (and therefore the jobs.error column / UI).

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Attribution headers OpenRouter asks clients to send. */
export const OPENROUTER_APP_HEADERS = {
  "HTTP-Referer": "https://github.com/book-writer/book-writer",
  "X-Title": "Book Writer",
} as const;

export interface OpenRouterClientOptions {
  apiKey: string;
  getConfig: () => Promise<ModelConfig>;
  /** Called after every successful completion with the real usage/cost. */
  onUsage?: (record: {
    projectId: string;
    jobId?: string;
    role: ModelRole;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  }) => void;
  fetchImpl?: typeof fetch;
  /** Injectable for tests so backoff doesn't slow the suite. */
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  /** Retries per model on 429 (beyond the first attempt). */
  maxRetries?: number;
}

interface CompletionBody {
  choices?: { message?: { content?: string } }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

const BACKOFF_BASE_MS = 500;

export class OpenRouterClient implements AiClient {
  private readonly opts: Required<
    Pick<OpenRouterClientOptions, "fetchImpl" | "sleep" | "baseUrl" | "maxRetries">
  > &
    OpenRouterClientOptions;

  constructor(options: OpenRouterClientOptions) {
    this.opts = {
      fetchImpl: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      baseUrl: OPENROUTER_BASE_URL,
      maxRetries: 3,
      ...options,
    };
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const config = await this.opts.getConfig();
    const roleConfig = config[request.role];
    const models = [roleConfig.primary, ...roleConfig.fallbacks];
    let lastProviderDetail = "";

    for (const model of models) {
      const result = await this.tryModel(model, request);
      if (result.kind === "ok") return result.response;
      // Provider outage on this model — move on to the next Claude variant.
      lastProviderDetail = result.detail;
    }
    throw new AiProviderError(
      `The AI provider is unavailable right now (tried ${models.join(", ")}). ` +
        `Please retry in a few minutes.${lastProviderDetail ? ` Detail: ${lastProviderDetail}` : ""}`,
    );
  }

  private async tryModel(
    model: string,
    request: AiRequest,
  ): Promise<{ kind: "ok"; response: AiResponse } | { kind: "outage"; detail: string }> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.opts.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            "Content-Type": "application/json",
            ...OPENROUTER_APP_HEADERS,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: buildSystemPrompt(request.system) },
              ...request.messages,
            ],
            ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          }),
        });
      } catch (err) {
        // Network failure counts as a provider outage for this model.
        return {
          kind: "outage",
          detail: redactSecrets(err instanceof Error ? err.message : String(err)),
        };
      }

      if (res.ok) {
        return { kind: "ok", response: await this.parseSuccess(res, model, request) };
      }
      if (res.status === 401 || res.status === 403) {
        throw new AiAuthError(
          "Invalid key: OpenRouter rejected the configured API key. " +
            "Check it in Settings and save it again.",
        );
      }
      if (res.status === 402) {
        throw new AiCreditsError(await this.safeErrorDetail(res));
      }
      if (res.status === 429) {
        if (attempt >= this.opts.maxRetries) {
          throw new AiRateLimitError(
            "Rate limited: OpenRouter kept returning 429 after " +
              `${attempt + 1} attempts with backoff. Try again shortly.`,
          );
        }
        await this.opts.sleep(this.backoffMs(res, attempt));
        continue;
      }
      if (res.status >= 500) {
        return { kind: "outage", detail: await this.safeErrorDetail(res) };
      }
      // Other 4xx: a bug on our side or a removed model — not retryable.
      throw new AiProviderError(
        `OpenRouter rejected the request (HTTP ${res.status}) for model ${model}. ` +
          `Detail: ${await this.safeErrorDetail(res)}`,
      );
    }
  }

  private backoffMs(res: Response, attempt: number): number {
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    return BACKOFF_BASE_MS * 2 ** attempt;
  }

  private async safeErrorDetail(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as CompletionBody;
      return redactSecrets(body.error?.message ?? "");
    } catch {
      return "";
    }
  }

  private async parseSuccess(
    res: Response,
    requestedModel: string,
    request: AiRequest,
  ): Promise<AiResponse> {
    const body = (await res.json()) as CompletionBody;
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new AiProviderError(
        "OpenRouter returned a response without text content.",
      );
    }
    const usage = {
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costUsd: body.usage?.cost ?? 0,
    };
    const model = body.model ?? requestedModel;
    this.opts.onUsage?.({
      projectId: request.projectId,
      jobId: request.jobId,
      role: request.role,
      model,
      ...usage,
    });
    return { text, model, usage };
  }
}
