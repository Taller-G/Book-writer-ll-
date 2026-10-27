import type { NormalizationRule } from "../db/schema";

// Deterministic orthotypographic normalization. Each 'mechanical' rule is a
// pure transform that reports how many times it fired, so the executor can
// write one change-log entry per rule application. 'prompt' rules are not
// handled here — they are injected into the generation instructions.

export interface NormalizationChange {
  ruleKey: string;
  label: string;
  count: number;
}

export interface NormalizationResult {
  output: string;
  changes: NormalizationChange[];
}

type Transform = (text: string) => { output: string; count: number };

function countReplace(text: string, re: RegExp, replacement: string): {
  output: string;
  count: number;
} {
  const count = text.match(re)?.length ?? 0;
  return { output: count > 0 ? text.replace(re, replacement) : text, count };
}

/** «angular» quotes: pair straight/curly double quotes per paragraph. */
function angularQuotes(text: string): { output: string; count: number } {
  let count = 0;
  const output = text
    .split("\n")
    .map((line) => {
      // Curly quotes convert directly; straight quotes pair up left-to-right.
      let out = line;
      const curlyOpen = out.match(/“/g)?.length ?? 0;
      const curlyClose = out.match(/”/g)?.length ?? 0;
      if (curlyOpen > 0) out = out.replace(/“/g, "«");
      if (curlyClose > 0) out = out.replace(/”/g, "»");
      count += curlyOpen + curlyClose;
      let open = true;
      out = out.replace(/"/g, () => {
        count++;
        const ch = open ? "«" : "»";
        open = !open;
        return ch;
      });
      return out;
    })
    .join("\n");
  return { output, count };
}

/** English curly quotes from straight quotes (the pluggable 'en' equivalent). */
function curlyQuotes(text: string): { output: string; count: number } {
  let count = 0;
  const output = text
    .split("\n")
    .map((line) => {
      let open = true;
      return line.replace(/"/g, () => {
        count++;
        const ch = open ? "“" : "”";
        open = !open;
        return ch;
      });
    })
    .join("\n");
  return { output, count };
}

/** Dialogue lines open with an em dash glued to the first word (RAE). */
function dialogueDash(text: string): { output: string; count: number } {
  return countReplace(text, /^[-–]\s*(?=\S)/gm, "—");
}

function ellipsis(text: string): { output: string; count: number } {
  return countReplace(text, /\.{3}/g, "…");
}

function spacing(text: string): { output: string; count: number } {
  const doubles = countReplace(text, / {2,}/g, " ");
  const before = countReplace(doubles.output, / +([,.;:!?»])/g, "$1");
  return { output: before.output, count: doubles.count + before.count };
}

const TRANSFORMS: Record<string, Transform> = {
  "angular-quotes": angularQuotes,
  "curly-quotes": curlyQuotes,
  "dialogue-dash": dialogueDash,
  ellipsis,
  spacing,
};

/** Apply the enabled mechanical rules in their listed order. */
export function normalizeText(
  text: string,
  rules: NormalizationRule[],
): NormalizationResult {
  let output = text;
  const changes: NormalizationChange[] = [];
  for (const rule of rules) {
    if (rule.kind !== "mechanical" || rule.enabled !== 1) continue;
    const transform = TRANSFORMS[rule.ruleKey];
    if (!transform) continue;
    const result = transform(output);
    output = result.output;
    if (result.count > 0) {
      changes.push({ ruleKey: rule.ruleKey, label: rule.label, count: result.count });
    }
  }
  return { output, changes };
}

export interface QuoteBalanceResult {
  ok: boolean;
  problems: string[];
}

/**
 * The quote-balance check: every « must close with » (never nested wrongly),
 * and no stray straight double quotes may survive normalization.
 */
export function checkQuoteBalance(text: string): QuoteBalanceResult {
  const problems: string[] = [];
  let depth = 0;
  for (const ch of text) {
    if (ch === "«") depth++;
    else if (ch === "»") {
      depth--;
      if (depth < 0) {
        problems.push("A closing » appears before its opening «.");
        depth = 0;
      }
    }
  }
  if (depth > 0) problems.push(`${depth} « quote(s) are never closed.`);
  const straight = text.match(/"/g)?.length ?? 0;
  if (straight > 0) {
    problems.push(`${straight} straight double quote(s) survived normalization.`);
  }
  const curlyOpen = text.match(/“/g)?.length ?? 0;
  const curlyClose = text.match(/”/g)?.length ?? 0;
  if (curlyOpen !== curlyClose) {
    problems.push("Curly double quotes are unbalanced.");
  }
  return { ok: problems.length === 0, problems };
}
