import type { AiClient } from "../ai";
import type { EditorialContract, StyleProfile } from "../db/schema";

// Pass C (spec §4 stage 3.6): find GROSS inconsistencies in the structured text
// and classify each by severity so the user approves them in batches. It only
// FLAGS — it never edits the text (the faithful contract forbids rewrites). The
// detection is an AI call behind the swappable client; the parse is strict so a
// bad response fails the job cleanly rather than silently losing findings.

export type Severity = "gross" | "medium" | "minor";

export interface Inconsistency {
  severity: Severity;
  description: string;
  /** A short verbatim snippet locating the issue in the text. */
  excerpt: string;
}

export interface PassCResult {
  items: Inconsistency[];
  aiCalls: number;
}

const INSTRUCTIONS = `You are a meticulous editor checking a faithful transcript of spoken talks for INTERNAL INCONSISTENCIES only. Do NOT rewrite or suggest wording — only report problems.

Look for: contradictions (a fact stated two different ways), names/dates/numbers that disagree with each other, broken cross-references ("as I said earlier" with no earlier mention), and obvious factual self-contradictions.

Classify each by severity:
- "gross": a clear contradiction a reader would notice and that damages credibility
- "medium": a likely inconsistency worth a human check
- "minor": a small discrepancy (spelling of a name varies, a rounding difference)

Reply with ONLY a JSON array (no prose, no code fences). Each element is an object with exactly:
{"severity": "gross"|"medium"|"minor", "description": string, "excerpt": string}
The "excerpt" must be copied verbatim from the text. If there are no inconsistencies, reply with [].`;

function parseInconsistencies(text: string): Inconsistency[] {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    throw new Error(
      "Pass C did not return valid JSON. Nothing was flagged — run it again.",
    );
  }
  if (!Array.isArray(data)) {
    throw new Error("Pass C must return a JSON array of inconsistencies.");
  }
  const valid: Severity[] = ["gross", "medium", "minor"];
  const items: Inconsistency[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const d = raw as Record<string, unknown>;
    const severity = valid.includes(d.severity as Severity)
      ? (d.severity as Severity)
      : "minor";
    const description = typeof d.description === "string" ? d.description.trim() : "";
    const excerpt = typeof d.excerpt === "string" ? d.excerpt.trim() : "";
    if (description) items.push({ severity, description, excerpt });
  }
  return items;
}

/** Severity ordering for batch display: gross first. */
export function severityRank(s: Severity): number {
  return s === "gross" ? 0 : s === "medium" ? 1 : 2;
}

export async function classifyInconsistencies(
  client: AiClient,
  params: {
    projectId: string;
    jobId?: string;
    text: string;
    contract?: EditorialContract;
    styleProfile?: StyleProfile;
  },
): Promise<PassCResult> {
  const res = await client.complete({
    role: "large",
    projectId: params.projectId,
    jobId: params.jobId,
    // bare: consistency checking must read the text plainly, not through the
    // book's voice.
    system: { instructions: INSTRUCTIONS, bare: true },
    messages: [{ role: "user", content: params.text }],
    maxTokens: 1500,
  });
  const items = parseInconsistencies(res.text).sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );
  return { items, aiCalls: 1 };
}
