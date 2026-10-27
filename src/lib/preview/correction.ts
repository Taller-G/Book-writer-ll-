import type { AiClient, AiContentPart, AiRequest } from "../ai";
import type { DbHandle } from "../db/client";
import type { CorrectionMessage } from "../db/schema";
import {
  addCorrectionMessage,
  getCorrectionMessage,
  setCorrectionStatus,
} from "../repo/correction";
import { appendChange } from "../repo/changeLog";
import { latestPdfVersion } from "../repo/output";
import { parsePages } from "./diff";
import {
  applyContentChange,
  applyLayoutChange,
  CorrectionError,
} from "./build";

// The correction-cycle agent (spec §5.1). It reads an annotation — a page
// number plus the marked region as an IMAGE — together with the user's words,
// and classifies the request as either a CONTENT change (which reopens the
// closed master text and therefore needs explicit confirmation) or a LAYOUT
// change (which only adjusts the template). The draft-first rule is enforced
// structurally: content changes never touch text until confirmed.

export interface AnnotationInput {
  /** The 1-based page the annotation sits on, if any. */
  pageNumber?: number | null;
  /** Normalized {x,y,w,h} rectangle over the page, if any. */
  region?: { x: number; y: number; w: number; h: number } | null;
  /** Data URI of the marked region (or an attached screenshot). */
  image?: string | null;
}

export interface ParsedCorrection {
  classification: "content" | "layout";
  reply: string;
  /** For content changes: the chapter/section the edit touches. */
  targetRef?: string;
  /** For content changes: the full proposed new FINAL text. */
  proposedText?: string;
  /** For layout changes: a partial format-config patch. */
  formatPatch?: Record<string, unknown>;
}

const CLASSIFY_INSTRUCTIONS = `You are the correction-cycle assistant for a book being prepared for print. The user is looking at a PDF preview and is pointing at a problem (a page number, a marked region shown as an image, and a description).

Classify the request as exactly one of:
- "layout": it is about how the page LOOKS — margins, font size, spacing, folios, where a chapter opens, separators. These adjust the template and must NOT change a single word of the text.
- "content": it is about WHAT the text SAYS — a typo, a rewording, a wrong fact, a sentence to add or remove. These reopen the already-approved master text.

Respond with ONLY a JSON object, no prose and no code fences:
{
  "classification": "layout" | "content",
  "reply": "one or two sentences to the user explaining what you understood and will do",
  "targetRef": "for content only: the chapter or section the change touches, e.g. \\"chapter 3\\"",
  "proposedText": "for content only: the COMPLETE corrected master text, with your edit applied",
  "formatPatch": { "for layout only: a partial format-config object, e.g.": "...", "typography": { "bodySizePt": 12 } }
}
Include only the fields relevant to your classification.`;

/**
 * Build the AI request for an annotation. The user message carries the page
 * number and description as text AND the marked region as an image part, so the
 * agent receives exactly what the user pointed at.
 */
export function buildCorrectionRequest(input: {
  projectId: string;
  userText: string;
  annotation?: AnnotationInput;
  pageText?: string;
}): AiRequest {
  const { annotation } = input;
  const contextLines: string[] = [];
  if (annotation?.pageNumber != null) {
    contextLines.push(`The annotation is on page ${annotation.pageNumber}.`);
  }
  if (annotation?.region) {
    const r = annotation.region;
    contextLines.push(
      `Marked region (normalized): x=${r.x.toFixed(3)}, y=${r.y.toFixed(3)}, ` +
        `w=${r.w.toFixed(3)}, h=${r.h.toFixed(3)}.`,
    );
  }
  if (input.pageText) {
    contextLines.push(`Text currently on that page:\n${input.pageText}`);
  }
  contextLines.push(`The user says: ${input.userText}`);

  const parts: AiContentPart[] = [{ type: "text", text: contextLines.join("\n\n") }];
  if (annotation?.image) {
    parts.push({ type: "image", dataUri: annotation.image });
  }

  return {
    role: "large",
    projectId: input.projectId,
    system: { instructions: CLASSIFY_INSTRUCTIONS },
    messages: [{ role: "user", content: parts }],
    maxTokens: 4000,
  };
}

/** Strictly parse the agent's JSON classification. A bad shape throws. */
export function parseCorrectionResponse(text: string): ParsedCorrection {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    throw new CorrectionError(
      "The correction agent did not return a valid response. Try rephrasing the request.",
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CorrectionError("The correction agent returned an unexpected response.");
  }
  const d = data as Record<string, unknown>;
  const classification =
    d.classification === "content" || d.classification === "layout"
      ? d.classification
      : undefined;
  if (!classification) {
    throw new CorrectionError(
      "The correction agent did not classify the request as content or layout.",
    );
  }
  return {
    classification,
    reply: typeof d.reply === "string" ? d.reply : "",
    targetRef: typeof d.targetRef === "string" ? d.targetRef : undefined,
    proposedText: typeof d.proposedText === "string" ? d.proposedText : undefined,
    formatPatch:
      typeof d.formatPatch === "object" &&
      d.formatPatch !== null &&
      !Array.isArray(d.formatPatch)
        ? (d.formatPatch as Record<string, unknown>)
        : undefined,
  };
}

/** The page's text from the current preview version, for the agent's context. */
function pageTextFor(
  handle: DbHandle,
  projectId: string,
  pageNumber?: number | null,
): string | undefined {
  if (pageNumber == null) return undefined;
  const latest = latestPdfVersion(handle.db, projectId);
  if (!latest) return undefined;
  const pages = parsePages(latest.pages);
  return pages.find((p) => p.pageNumber === pageNumber)?.text;
}

export interface SubmitResult {
  userMessage: CorrectionMessage;
  agentMessage: CorrectionMessage;
  classification: "content" | "layout";
  /** True when a content change is now waiting for the user's confirmation. */
  awaitingConfirmation: boolean;
}

/**
 * Submit a user correction (optionally an annotation): record it, ask the agent
 * to classify, and either apply a layout change immediately or stage a content
 * change for explicit confirmation. Never modifies closed text here.
 */
export async function submitCorrection(
  handle: DbHandle,
  client: AiClient,
  input: {
    projectId: string;
    userText: string;
    annotation?: AnnotationInput;
  },
): Promise<SubmitResult> {
  const { db } = handle;
  const userMessage = addCorrectionMessage(db, {
    projectId: input.projectId,
    role: "user",
    body: input.userText,
    pageNumber: input.annotation?.pageNumber ?? null,
    region: input.annotation?.region
      ? JSON.stringify(input.annotation.region)
      : null,
    image: input.annotation?.image ?? null,
    status: "answered",
  });

  const request = buildCorrectionRequest({
    projectId: input.projectId,
    userText: input.userText,
    annotation: input.annotation,
    pageText: pageTextFor(handle, input.projectId, input.annotation?.pageNumber),
  });
  const response = await client.complete(request);
  const parsed = parseCorrectionResponse(response.text);

  if (parsed.classification === "layout") {
    const built = applyLayoutChange(handle, {
      projectId: input.projectId,
      formatPatch: parsed.formatPatch ?? {},
      authorizedBy: "correction-cycle agent (layout)",
      summary: parsed.reply || "template adjusted",
    });
    const agentMessage = addCorrectionMessage(db, {
      projectId: input.projectId,
      role: "agent",
      body: parsed.reply,
      classification: "layout",
      status: "applied",
      pdfVersion: built.version,
    });
    return {
      userMessage,
      agentMessage,
      classification: "layout",
      awaitingConfirmation: false,
    };
  }

  // Content change: stage it, do NOT touch the text until the user confirms.
  const agentMessage = addCorrectionMessage(db, {
    projectId: input.projectId,
    role: "agent",
    body:
      parsed.reply ||
      `This modifies ${parsed.targetRef ?? "the master text"}. Confirm to apply?`,
    classification: "content",
    status: "awaiting_confirmation",
    targetRef: parsed.targetRef ?? "the master text",
    proposal: parsed.proposedText ?? null,
  });
  appendChange(db, {
    projectId: input.projectId,
    what: `Content change proposed for ${parsed.targetRef ?? "the master text"} — awaiting confirmation`,
    where: "stage 8 · correction cycle · content",
    why: "a correction request was classified as a content change; closed text is not touched until confirmed",
    authorizedBy: "correction-cycle agent (content)",
  });
  return {
    userMessage,
    agentMessage,
    classification: "content",
    awaitingConfirmation: true,
  };
}

/**
 * Confirm a staged content change. Only an agent message in the
 * awaiting_confirmation state can be confirmed — this is the gate that keeps
 * closed text from being modified without the user's explicit go-ahead.
 */
export function confirmContentChange(
  handle: DbHandle,
  input: { projectId: string; messageId: string },
): { textVersion: number; version: number } {
  const { db } = handle;
  const message = getCorrectionMessage(db, input.messageId);
  if (!message || message.projectId !== input.projectId) {
    throw new CorrectionError("That correction request no longer exists.");
  }
  if (message.classification !== "content" || message.status !== "awaiting_confirmation") {
    throw new CorrectionError(
      "This request is not a content change awaiting confirmation.",
    );
  }
  if (!message.proposal || message.proposal.trim() === "") {
    throw new CorrectionError(
      "The agent did not propose a concrete edit; nothing to apply.",
    );
  }
  const result = applyContentChange(handle, {
    projectId: input.projectId,
    newFinalText: message.proposal,
    targetRef: message.targetRef ?? "the master text",
    messageId: input.messageId,
    authorizedBy: "user (confirmed content change)",
  });
  return { textVersion: result.textVersion, version: result.version };
}

/** Decline a staged content change; the closed text is left untouched. */
export function rejectContentChange(
  handle: DbHandle,
  input: { projectId: string; messageId: string },
): void {
  const { db } = handle;
  const message = getCorrectionMessage(db, input.messageId);
  if (!message || message.projectId !== input.projectId) return;
  if (message.status !== "awaiting_confirmation") return;
  setCorrectionStatus(db, input.messageId, "rejected");
  appendChange(db, {
    projectId: input.projectId,
    what: `Content change to ${message.targetRef ?? "the master text"} declined — text left unchanged`,
    where: "stage 8 · correction cycle · content",
    why: "the user rejected the proposed content change",
    authorizedBy: "user (correction cycle)",
  });
}
