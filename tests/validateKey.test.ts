import { describe, expect, it } from "vitest";
import { validateOpenRouterKey } from "@/lib/ai/validateKey";

const KEY = "sk-or-v1-validate-me";

function fetchWith(status: number, body: unknown): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    // The validation call authenticates via header only.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!headers.Authorization?.includes(KEY)) throw new Error("missing auth header");
    expect(String(url)).toBe("https://openrouter.ai/api/v1/key");
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("OpenRouter key validation on save", () => {
  it("accepts a valid key with remaining credit", async () => {
    const result = await validateOpenRouterKey(
      KEY,
      fetchWith(200, { data: { limit: 10, limit_remaining: 4.2 } }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts an unlimited key (limit null)", async () => {
    const result = await validateOpenRouterKey(
      KEY,
      fetchWith(200, { data: { limit: null, limit_remaining: null } }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("names the 'invalid key' error on 401", async () => {
    const result = await validateOpenRouterKey(KEY, fetchWith(401, {}));
    expect(result).toEqual({ ok: false, error: "invalid key" });
  });

  it("names the 'no credit' error when the key's credit is exhausted", async () => {
    const result = await validateOpenRouterKey(
      KEY,
      fetchWith(200, { data: { limit: 5, limit_remaining: 0 } }),
    );
    expect(result).toEqual({ ok: false, error: "no credit" });
  });

  it("reports network trouble without saving-side effects", async () => {
    const failing = (async () => {
      throw new Error(`connect ECONNREFUSED (key ${KEY})`);
    }) as unknown as typeof fetch;
    const result = await validateOpenRouterKey(KEY, failing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("network");
      // Even a key echoed by the network layer is redacted.
      expect(result.detail).not.toContain(KEY);
    }
  });
});
