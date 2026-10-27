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
  type AiImageRequest,
  type AiImageResponse,
  type AiMessage,
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

/**
 * The model used for AI image generation. Claude writes the text; image
 * generation needs an image-capable model, so it is configured separately from
 * the large/fast text roles (overridable via BOOK_WRITER_IMAGE_MODEL).
 */
export function imageModelSlug(): string {
  return process.env.BOOK_WRITER_IMAGE_MODEL ?? "google/gemini-2.5-flash-image";
}

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
    /** The exact system prompt sent — the verifiable call-log payload. */
    systemPrompt: string;
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

interface ImageCompletionBody {
  choices?: {
    message?: {
      images?: { image_url?: { url?: string } }[];
    };
  }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

/** Decode a `data:image/...;base64,...` URL into bytes + mime type. */
function decodeDataUrl(url: string): { data: Buffer; mimeType: string } | null {
  const m = url.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return null;
  return { mimeType: m[1], data: Buffer.from(m[2], "base64") };
}

const BACKOFF_BASE_MS = 500;

/**
 * Map an AiMessage to the OpenAI-compatible wire shape. A string stays a
 * string; a multimodal part array becomes the content-block form, with image
 * parts rendered as `image_url` blocks carrying the data URI.
 */
function toWireMessage(message: AiMessage): {
  role: AiMessage["role"];
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
} {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: message.content.map((part) =>
      part.type === "text"
        ? { type: "text" as const, text: part.text }
        : { type: "image_url" as const, image_url: { url: part.dataUri } },
    ),
  };
}

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

  async generateImage(request: AiImageRequest): Promise<AiImageResponse> {
    const model = request.model ?? imageModelSlug();
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
            // OpenRouter returns generated images in message.images when the
            // image modality is requested on an image-capable model.
            modalities: ["image", "text"],
            messages: [{ role: "user", content: request.prompt }],
          }),
        });
      } catch (err) {
        throw new AiProviderError(
          "The image generator is unreachable right now. Please retry in a few " +
            `minutes. Detail: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
        );
      }

      if (res.ok) return this.parseImage(res, model, request);
      if (res.status === 401 || res.status === 403) {
        throw new AiAuthError(
          "Invalid key: OpenRouter rejected the configured API key. " +
            "Check it in Settings and save it again.",
        );
      }
      if (res.status === 402) throw new AiCreditsError(await this.safeErrorDetail(res));
      if (res.status === 429) {
        if (attempt >= this.opts.maxRetries) {
          throw new AiRateLimitError(
            "Rate limited: OpenRouter kept returning 429 while generating the " +
              "image. Try again shortly.",
          );
        }
        await this.opts.sleep(this.backoffMs(res, attempt));
        continue;
      }
      throw new AiProviderError(
        `OpenRouter could not generate the image (HTTP ${res.status}) with model ${model}. ` +
          `Detail: ${await this.safeErrorDetail(res)}`,
      );
    }
  }

  private async parseImage(
    res: Response,
    model: string,
    request: AiImageRequest,
  ): Promise<AiImageResponse> {
    const body = (await res.json()) as ImageCompletionBody;
    const url = body.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    const decoded = typeof url === "string" ? decodeDataUrl(url) : null;
    if (!decoded) {
      throw new AiProviderError(
        "The image generator returned no usable image. Retry the generation.",
      );
    }
    const usage = {
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costUsd: body.usage?.cost ?? 0,
    };
    const served = body.model ?? model;
    this.opts.onUsage?.({
      projectId: request.projectId,
      jobId: request.jobId,
      role: "large",
      model: served,
      systemPrompt: `image generation: ${request.prompt}`,
      ...usage,
    });
    return { data: decoded.data, mimeType: decoded.mimeType, model: served, usage };
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
              ...request.messages.map(toWireMessage),
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
      systemPrompt: buildSystemPrompt(request.system),
      ...usage,
    });
    return { text, model, usage };
  }
}
