import type { ModelConfig, ModelRole } from "./config";

// Pre-run cost estimation (spec §9): "processing the 5 talks will cost
// approx. $X" before any large operation. The estimate uses the role's
// configured pricing and a chars/4 token approximation — the real spend is
// whatever OpenRouter bills (recorded in ai_usage after each call).

/** Rough token count: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the USD cost of running `role` over `inputText`. Text passes
 * rewrite the text, so the default assumes the output is about as long as
 * the input.
 */
export function estimateCostUsd(
  config: ModelConfig,
  role: ModelRole,
  inputText: string,
  outputRatio = 1,
): number {
  const { pricing } = config[role];
  const promptTokens = estimateTokens(inputText);
  const completionTokens = Math.ceil(promptTokens * outputRatio);
  return (
    (promptTokens * pricing.promptUsdPerMTok +
      completionTokens * pricing.completionUsdPerMTok) /
    1_000_000
  );
}

/** "$0.04", with extra precision for sub-cent amounts. */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
