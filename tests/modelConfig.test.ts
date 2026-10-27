import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CONFIG,
  getModelConfig,
  resetModelConfigCache,
  type ModelConfig,
} from "@/lib/ai/config";

const REMOTE: ModelConfig = {
  large: {
    primary: "anthropic/claude-opus-4.8",
    fallbacks: ["anthropic/claude-sonnet-4.6"],
    pricing: { promptUsdPerMTok: 5, completionUsdPerMTok: 25 },
  },
  fast: {
    primary: "anthropic/claude-haiku-4.5",
    fallbacks: [],
    pricing: { promptUsdPerMTok: 1, completionUsdPerMTok: 5 },
  },
};

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
    })) as typeof fetch;
}

describe("model role configuration", () => {
  beforeEach(() => resetModelConfigCache());
  afterEach(() => {
    delete process.env.BOOK_WRITER_MODEL_CONFIG_URL;
    resetModelConfigCache();
  });

  it("uses bundled defaults when no remote URL is configured", async () => {
    expect(await getModelConfig()).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it("model roles change via remote configuration, no user involvement", async () => {
    process.env.BOOK_WRITER_MODEL_CONFIG_URL = "https://config.example/models.json";
    const config = await getModelConfig(fetchReturning(REMOTE));
    expect(config.large.primary).toBe("anthropic/claude-opus-4.8");
    expect(config.fast.primary).toBe("anthropic/claude-haiku-4.5");
  });

  it("falls back to defaults when the remote is unreachable", async () => {
    process.env.BOOK_WRITER_MODEL_CONFIG_URL = "https://config.example/models.json";
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await getModelConfig(failing)).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it("keeps the last good remote config when a later fetch fails", async () => {
    process.env.BOOK_WRITER_MODEL_CONFIG_URL = "https://config.example/models.json";
    await getModelConfig(fetchReturning(REMOTE));
    resetModelConfigCache();
    // Cache dropped: a fresh failure falls back to defaults...
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await getModelConfig(failing)).toEqual(DEFAULT_MODEL_CONFIG);
    // ...but with a warm cache the last good config survives a bad fetch.
    await getModelConfig(fetchReturning(REMOTE));
    expect(await getModelConfig(failing)).toEqual(REMOTE);
  });

  it("rejects malformed remote config shapes", async () => {
    process.env.BOOK_WRITER_MODEL_CONFIG_URL = "https://config.example/models.json";
    const config = await getModelConfig(fetchReturning({ large: "nope" }));
    expect(config).toEqual(DEFAULT_MODEL_CONFIG);
  });
});
