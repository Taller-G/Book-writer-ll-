// Pass A noise-correction engine (spec §4 stage 3.2). Pure functions, no DB:
// an AI proposes a list of structured corrections, and this module decides —
// deterministically and verifiably — which ones may be applied. The golden
// rule of faithful mode holds structurally here, not just in the prompt:
// nothing is cut or rewritten; only transcription-software errors are fixed,
// each one applied ONLY when it can be programmatically confirmed, and the
// result is proven against the source by a word-level diff.

import type { EditorialContract } from "../db/schema";

// The four classes of transcription-software error Pass A may correct.
export type CorrectionType =
  | "ASR" // misheard word
  | "NOM" // proper name
  | "REC" // systematic transcriber pattern
  | "NORM"; // number as pronounced

export const CORRECTION_TYPES: CorrectionType[] = ["ASR", "NOM", "REC", "NORM"];

export const CORRECTION_TYPE_LABELS: Record<CorrectionType, string> = {
  ASR: "Misheard word",
  NOM: "Proper name",
  REC: "Transcriber pattern",
  NORM: "Number as pronounced",
};

/** A single structured correction, as proposed and as applied. */
export interface Correction {
  type: CorrectionType;
  original: string;
  correction: string;
  justification: string;
  /** Informational source offset; verification never relies on it. */
  position?: number;
}

/** An unverifiable correction that is NOT applied — it goes to a human. */
export interface DoubtfulCorrection {
  correction: Correction;
  /** Why it could not be auto-applied (e.g. the target appears twice). */
  reason: string;
  occurrences: number;
}

/** A proposal the faithful-mode contract refuses outright (a rewrite). */
export interface RejectedCorrection {
  correction: Correction;
  reason: string;
}

export interface ApplyResult {
  /** The source with every applied correction, and nothing else, in it. */
  output: string;
  applied: Correction[];
  doubtful: DoubtfulCorrection[];
  rejected: RejectedCorrection[];
}

// A noise correction fixes a short span (a word, a name, a number phrase). A
// change that rewrites a whole clause is not noise correction — it is the kind
// of edit the faithful-mode contract forbids at this stage.
const MAX_SPAN_WORDS = 8;

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/** Count non-overlapping exact occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count += 1;
    from = i + needle.length;
  }
  return count;
}

/**
 * The faithful-mode editorial contract made structural: Pass A may ONLY
 * perform transcription-noise correction. Any proposal that is a rewrite —
 * an unknown class, an empty/no-op edit, or a span too large to be noise —
 * is refused with an explanation that names the contract.
 */
export function enforceFaithfulContract(
  correction: Correction,
  mode: EditorialContract["mode"],
): { allowed: boolean; reason?: string } {
  const contract = `editorial contract (${mode} mode)`;
  if (!CORRECTION_TYPES.includes(correction.type)) {
    return {
      allowed: false,
      reason: `"${correction.type}" is not a transcription-noise class (ASR/NOM/REC/NORM). The ${contract} blocks any edit beyond noise correction at this stage.`,
    };
  }
  if (correction.original.trim() === "" || correction.correction.trim() === "") {
    return {
      allowed: false,
      reason: `Empty original or replacement — not a valid noise correction; rejected under the ${contract}.`,
    };
  }
  if (correction.original === correction.correction) {
    return {
      allowed: false,
      reason: `Original and replacement are identical — no transcription error to correct.`,
    };
  }
  const span = Math.max(
    words(correction.original).length,
    words(correction.correction).length,
  );
  if (span > MAX_SPAN_WORDS) {
    return {
      allowed: false,
      reason: `This spans ${span} words — too large to be transcription noise; it rewrites the text, which the ${contract} forbids. Only noise correction is allowed at this stage.`,
    };
  }
  return { allowed: true };
}

/**
 * Apply the corrections to `source`, enforcing the faithful contract and the
 * exactly-once verification rule:
 *   - a proposal the contract forbids  -> rejected (never applied)
 *   - a target that does not appear, or appears MORE THAN ONCE -> doubtful
 *     (ambiguous; must go to a human, never silently applied)
 *   - a target that appears exactly once -> applied
 * Occurrence counting is done against the IMMUTABLE source so the exactly-once
 * guarantee can't be confused by an earlier replacement.
 */
export function applyCorrections(
  source: string,
  corrections: Correction[],
  mode: EditorialContract["mode"],
): ApplyResult {
  const applied: Correction[] = [];
  const doubtful: DoubtfulCorrection[] = [];
  const rejected: RejectedCorrection[] = [];
  let output = source;

  for (const c of corrections) {
    const guard = enforceFaithfulContract(c, mode);
    if (!guard.allowed) {
      rejected.push({ correction: c, reason: guard.reason! });
      continue;
    }
    const occurrences = countOccurrences(source, c.original);
    if (occurrences === 1) {
      output = output.replace(c.original, c.correction);
      applied.push(c);
    } else if (occurrences === 0) {
      doubtful.push({
        correction: c,
        reason: `The target "${c.original}" does not appear in the text — it cannot be located, so it is not auto-applied.`,
        occurrences,
      });
    } else {
      doubtful.push({
        correction: c,
        reason: `The target "${c.original}" appears ${occurrences} times — which one is the transcription error is ambiguous, so it is not auto-applied.`,
        occurrences,
      });
    }
  }

  return { output, applied, doubtful, rejected };
}

// --- Word-level diff and the structural proof of criterion 3 ---------------

export type DiffOp = "equal" | "replace" | "insert" | "delete";

export interface DiffHunk {
  op: DiffOp;
  /** Source-side words (empty for a pure insert). */
  from: string[];
  /** Result-side words (empty for a pure delete). */
  to: string[];
}

/**
 * A word-level diff between two texts via a longest-common-subsequence
 * backtrace. Consecutive edits are grouped into hunks; equal runs are kept so
 * the hunks reconstruct both sides in order.
 */
export function wordDiff(a: string, b: string): DiffHunk[] {
  const aw = words(a);
  const bw = words(b);
  const n = aw.length;
  const m = bw.length;
  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        aw[i] === bw[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  const push = (op: DiffOp, from: string[], to: string[]) => {
    const last = hunks[hunks.length - 1];
    if (last && last.op === op) {
      last.from.push(...from);
      last.to.push(...to);
    } else {
      hunks.push({ op, from: [...from], to: [...to] });
    }
  };
  while (i < n && j < m) {
    if (aw[i] === bw[j]) {
      push("equal", [aw[i]], [bw[j]]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("delete", [aw[i]], []);
      i++;
    } else {
      push("insert", [], [bw[j]]);
      j++;
    }
  }
  while (i < n) push("delete", [aw[i++]], []);
  while (j < m) push("insert", [], [bw[j++]]);

  // Collapse an adjacent delete+insert (or insert+delete) into a replace.
  const merged: DiffHunk[] = [];
  for (const h of hunks) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      ((prev.op === "delete" && h.op === "insert") ||
        (prev.op === "insert" && h.op === "delete"))
    ) {
      merged[merged.length - 1] = {
        op: "replace",
        from: [...prev.from, ...h.from],
        to: [...prev.to, ...h.to],
      };
    } else {
      merged.push(h);
    }
  }
  return merged;
}

/**
 * Criterion 3, as a hard proof: the output equals the source plus EXACTLY the
 * applied corrections and nothing else. Done via a word-level diff that is
 * INDEPENDENT of how the output was produced — the changed regions of the
 * diff must line up, in order and content, one-for-one with the applied
 * corrections. Any extra, missing or altered change is reported.
 */
export function verifyDiffMatchesCorrections(
  source: string,
  output: string,
  applied: Correction[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const edits = wordDiff(source, output).filter((h) => h.op !== "equal");
  const expected = applied.map((c) => ({
    from: words(c.original),
    to: words(c.correction),
  }));

  if (edits.length !== expected.length) {
    problems.push(
      `The word-level diff shows ${edits.length} changed region(s) but ${expected.length} correction(s) were logged — the text changed in ways the corrections don't account for.`,
    );
  }
  const n = Math.min(edits.length, expected.length);
  for (let k = 0; k < n; k++) {
    const e = edits[k];
    const x = expected[k];
    const eFrom = e.from.join(" ");
    const eTo = e.to.join(" ");
    const xFrom = x.from.join(" ");
    const xTo = x.to.join(" ");
    if (eFrom !== xFrom || eTo !== xTo) {
      problems.push(
        `Change #${k + 1} in the text ("${eFrom}" → "${eTo}") does not match the logged correction ("${xFrom}" → "${xTo}").`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

// --- Strict parsing of an AI correction proposal ---------------------------

export interface ParsedProposal {
  valid: Correction[];
  /** Entries dropped as malformed or non-noise, with why (surfaced as rejects). */
  rejected: RejectedCorrection[];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse the model's JSON correction list strictly. A well-formed array of
 * objects is required; each entry must carry a known noise type and non-empty
 * original/correction. Malformed or non-noise entries are not silently
 * dropped — they become rejections with an explanation.
 */
export function parseProposedCorrections(text: string): ParsedProposal {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    throw new Error(
      "The AI did not return a valid correction list (unparseable response).",
    );
  }
  // Accept either a bare array or an object with a `corrections` array.
  const arr = Array.isArray(data)
    ? data
    : typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).corrections)
      ? ((data as Record<string, unknown>).corrections as unknown[])
      : null;
  if (arr === null) {
    throw new Error(
      "The AI did not return a correction list (expected a JSON array).",
    );
  }
  const valid: Correction[] = [];
  const rejected: RejectedCorrection[] = [];
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const type = asString(e.type).toUpperCase();
    const correction: Correction = {
      type: type as CorrectionType,
      original: asString(e.original),
      correction: asString(e.correction),
      justification: asString(e.justification),
      position: typeof e.position === "number" ? e.position : undefined,
    };
    if (!CORRECTION_TYPES.includes(correction.type)) {
      rejected.push({
        correction,
        reason: `Unknown correction class "${asString(e.type)}" — Pass A only corrects transcription noise (ASR/NOM/REC/NORM).`,
      });
      continue;
    }
    if (correction.original.trim() === "" || correction.correction.trim() === "") {
      rejected.push({
        correction,
        reason: "Empty original or replacement — not a usable correction.",
      });
      continue;
    }
    valid.push(correction);
  }
  return { valid, rejected };
}
