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
    parts.push(
      `Style profile — tone: ${s.tone}; register: ${s.register}; ` +
        `person: ${s.person}. Notes:\n${s.notes}`,
    );
  }
  return parts.filter(Boolean).join("\n\n");
}
