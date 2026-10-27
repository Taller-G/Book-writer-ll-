// The internal AI client seam (spec §9). Every other work order calls this
// interface — never a provider SDK or HTTP API directly — so the provider can
// change (direct Anthropic, others) without touching the rest of the app.
// Every call carries the system-context payload: the project's editorial
// contract and style profile shape every piece of generated text.

import {
  authorshipOption,
  destinationOption,
  modeOption,
  toneOption,
} from "../contract/definitions";
import type { EditorialContract, StyleProfile } from "../db/schema";
import type { ModelRole } from "./config";

export interface SystemContext {
  /** Task framing for this call (what the stage is trying to do). */
  instructions: string;
  contract?: EditorialContract;
  styleProfile?: StyleProfile;
  /**
   * Opt out of the automatic injection of the project's contract and
   * confirmed style profile. Reserved for calls that must not be shaped by
   * the project voice — extracting the style profile itself.
   */
  bare?: boolean;
}

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequest {
  /** Which app-configured model role serves this call. */
  role: ModelRole;
  system: SystemContext;
  messages: AiMessage[];
  maxTokens?: number;
  /** Project the spend is attributed to. */
  projectId: string;
  /** Job the call belongs to, when run from a stage job. */
  jobId?: string;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  /** Actual USD cost reported by the provider's usage accounting. */
  costUsd: number;
}

export interface AiResponse {
  text: string;
  /** Model that actually served the call (may be a fallback variant). */
  model: string;
  usage: AiUsage;
}

export interface AiClient {
  complete(request: AiRequest): Promise<AiResponse>;
}

function safeParseExcerpts(json: string): string[] {
  try {
    const arr: unknown = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((e) => typeof e === "string") : [];
  } catch {
    return [];
  }
}

/** Render the system-context payload into one system prompt string. */
export function buildSystemPrompt(system: SystemContext): string {
  const parts = [system.instructions.trim()];
  if (system.contract) {
    const c = system.contract;
    const lines = [
      `Editorial contract v${c.version} — decisions made, do not re-discuss.`,
      `Mode: ${c.mode}. ${modeOption(c.mode).aiDirective}`,
    ];
    if (c.tone) {
      lines.push(`Tone: ${toneOption(c.tone).label}. ${toneOption(c.tone).instruction}`);
    }
    if (c.destination) {
      const d = destinationOption(c.destination);
      lines.push(`Destination: ${d.label}. Downstream: ${d.downstream}`);
    }
    if (c.authorship) {
      lines.push(
        `Authorship: ${authorshipOption(c.authorship).label}.` +
          (c.authorship !== "own"
            ? " Third-party material is involved: never alter quoted or " +
              "third-party passages beyond the mode's allowance, and keep " +
              "attributions intact."
            : ""),
      );
    }
    lines.push(`Rules:\n${c.rules}\nNotes:\n${c.notes}`);
    parts.push(lines.join("\n"));
  }
  if (system.styleProfile) {
    const s = system.styleProfile;
    const traits: Array<[label: string, value: string]> = [
      ["voice", s.voice],
      ["tone", s.tone],
      ["register and vocabulary", s.register],
      ["narrative person", s.person],
      ["sentence rhythm", s.rhythm],
      ["punctuation", s.punctuation],
      ["metaphors and examples", s.metaphors],
      ["how sections open and close", s.openings],
    ];
    const lines = traits
      .filter(([, value]) => value.trim() !== "")
      .map(([label, value]) => `- ${label}: ${value}`);
    parts.push(
      `Style profile (v${s.version}) — every piece of generated text must keep this voice:\n` +
        lines.join("\n") +
        (s.notes.trim() ? `\nNotes:\n${s.notes}` : ""),
    );
    const excerpts = safeParseExcerpts(s.excerpts);
    if (excerpts.length > 0) {
      parts.push(
        "Representative excerpts of the target voice. Match how they sound " +
          "(rhythm, register, punctuation), never copy their content:\n\n" +
          excerpts.map((e, i) => `Excerpt ${i + 1}:\n${e}`).join("\n\n"),
      );
    }
  }
  return parts.filter(Boolean).join("\n\n");
}
