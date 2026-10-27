// Model roles (spec §9): the app — not the user — decides which model serves
// each role. "large" writes and restructures text; "fast" does mass
// classifications. Roles resolve from a remote JSON config when
// BOOK_WRITER_MODEL_CONFIG_URL is set (updatable without user involvement,
// cached with a TTL, last-good kept on fetch failure) and otherwise from the
// bundled defaults below.

export type ModelRole = "large" | "fast";

export interface ModelPricing {
  /** USD per million prompt tokens. */
  promptUsdPerMTok: number;
  /** USD per million completion tokens. */
  completionUsdPerMTok: number;
}

export interface ModelRoleConfig {
  /** OpenRouter model slug tried first. */
  primary: string;
  /** Claude variants tried in order when the primary's provider is down. */
  fallbacks: string[];
  /** Pricing of the primary, used for pre-run cost estimates only — actual
   * spend always comes from OpenRouter's per-call usage.cost. */
  pricing: ModelPricing;
}

export type ModelConfig = Record<ModelRole, ModelRoleConfig>;

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  large: {
    primary: "anthropic/claude-sonnet-4.6",
    fallbacks: ["anthropic/claude-opus-4.8", "anthropic/claude-sonnet-4.5"],
    pricing: { promptUsdPerMTok: 3, completionUsdPerMTok: 15 },
  },
  fast: {
    primary: "anthropic/claude-haiku-4.5",
    fallbacks: ["anthropic/claude-sonnet-4.6"],
    pricing: { promptUsdPerMTok: 1, completionUsdPerMTok: 5 },
  },
};

const CACHE_TTL_MS = 5 * 60 * 1000;

interface ConfigCache {
  config: ModelConfig;
  fetchedAt: number;
  url: string;
}

let cache: ConfigCache | undefined;

/** Test hook: drop the cached remote config. */
export function resetModelConfigCache(): void {
  cache = undefined;
}

function isRoleConfig(value: unknown): value is ModelRoleConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const pricing = v.pricing as Record<string, unknown> | undefined;
  return (
    typeof v.primary === "string" &&
    Array.isArray(v.fallbacks) &&
    v.fallbacks.every((f) => typeof f === "string") &&
    typeof pricing === "object" &&
    pricing !== null &&
    typeof pricing.promptUsdPerMTok === "number" &&
    typeof pricing.completionUsdPerMTok === "number"
  );
}

function parseModelConfig(data: unknown): ModelConfig | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (isRoleConfig(d.large) && isRoleConfig(d.fast)) {
    return { large: d.large, fast: d.fast };
  }
  return undefined;
}

/**
 * Resolve the current model config. Never throws: a missing URL means the
 * bundled defaults; a failing or malformed remote means the last good config
 * (or the defaults when there is none).
 */
export async function getModelConfig(
  fetchImpl: typeof fetch = fetch,
): Promise<ModelConfig> {
  const url = process.env.BOOK_WRITER_MODEL_CONFIG_URL;
  if (!url) return DEFAULT_MODEL_CONFIG;
  if (cache && cache.url === url && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.config;
  }
  try {
    const res = await fetchImpl(url);
    if (res.ok) {
      const parsed = parseModelConfig(await res.json());
      if (parsed) {
        cache = { config: parsed, fetchedAt: Date.now(), url };
        return parsed;
      }
    }
  } catch {
    // fall through to last-good / defaults
  }
  return cache?.url === url ? cache.config : DEFAULT_MODEL_CONFIG;
}
