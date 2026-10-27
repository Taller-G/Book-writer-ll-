// The QA suite rerun after every correction-cycle change (spec §5.1).
//
// Its load-bearing check is the WORD-FOR-WORD verification: the laid-out pages
// must reduce to exactly the approved text's word stream. A layout-only change
// (template adjustment) cannot alter a single word, so it still passes; a
// content change only passes once the approved text itself is updated. The
// suite also reuses the orthotypographic quote-balance check and rejects empty
// pages.

import { checkQuoteBalance } from "../master/normalize";
import { canonicalTokens, tokensFromPages, type Page } from "./paginate";

export interface QaCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface QaResult {
  ok: boolean;
  checks: QaCheck[];
}

/** Index of the first differing token, or -1 when the streams are identical. */
function firstDivergence(a: string[], b: string[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

export function runQaSuite(input: {
  approvedText: string;
  pages: Page[];
}): QaResult {
  const { approvedText, pages } = input;
  const checks: QaCheck[] = [];

  // 1. Word-for-word verification against the approved text.
  const approved = canonicalTokens(approvedText);
  const laid = tokensFromPages(pages);
  const divergence = firstDivergence(approved, laid);
  checks.push({
    name: "word-for-word",
    ok: divergence === -1,
    detail:
      divergence === -1
        ? `All ${approved.length} words of the approved text are present, in order.`
        : `Word ${divergence + 1} differs: approved "${approved[divergence] ?? "∅"}" ` +
          `vs laid-out "${laid[divergence] ?? "∅"}" ` +
          `(${approved.length} approved words, ${laid.length} laid out).`,
  });

  // 2. Quote balance over the laid-out text.
  const balance = checkQuoteBalance(pages.map((p) => p.text).join("\n"));
  checks.push({
    name: "quote-balance",
    ok: balance.ok,
    detail: balance.ok ? "Quotes are balanced." : balance.problems.join(" "),
  });

  // 3. No empty pages.
  const emptyPages = pages
    .filter((p) => p.text.trim() === "")
    .map((p) => p.pageNumber);
  checks.push({
    name: "no-empty-pages",
    ok: emptyPages.length === 0,
    detail:
      emptyPages.length === 0
        ? `${pages.length} page(s), none empty.`
        : `Empty page(s): ${emptyPages.join(", ")}.`,
  });

  return { ok: checks.every((c) => c.ok), checks };
}
