import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_CONFIG } from "@/lib/ai/config";
import { estimateCostUsd, estimateTokens, formatUsd } from "@/lib/ai/estimate";

describe("pre-run cost estimation", () => {
  it("approximates tokens at ~4 chars per token", () => {
    expect(estimateTokens("abcd".repeat(100))).toBe(100);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates a large-role pass from the configured pricing", () => {
    // 400k chars -> 100k prompt tokens, output assumed equal.
    const text = "a".repeat(400_000);
    const cost = estimateCostUsd(DEFAULT_MODEL_CONFIG, "large", text);
    const { pricing } = DEFAULT_MODEL_CONFIG.large;
    const expected =
      (100_000 * pricing.promptUsdPerMTok + 100_000 * pricing.completionUsdPerMTok) /
      1_000_000;
    expect(cost).toBeCloseTo(expected, 6);
    // The fast role is cheaper for the same text.
    expect(estimateCostUsd(DEFAULT_MODEL_CONFIG, "fast", text)).toBeLessThan(cost);
  });

  it("formats amounts readably, with sub-cent precision", () => {
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
