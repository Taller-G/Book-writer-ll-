// Anchor-based audio clip location for the review queue.
//
// A doubtful transcription item carries a RAW timestamp that is interpolated
// and drifts by as much as ±30 s — trusting it would send the listener to the
// wrong place. Instead we locate the clip by the *validated* neighbouring text
// (the anchors): we find that text in the timestamped transcript, read its
// reliable time, and trim a ±pad-second window around it. The raw timestamp is
// only a last-resort fallback when no anchor can be matched.

/** One timestamped unit of a transcript (as stored on an audio source). */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export type LocatedBy = "anchor" | "timestamp" | "none";

export interface ClipWindow {
  /** Window bounds in seconds; start is clamped to ≥ 0. */
  start: number;
  end: number;
  /** How the window was located — "anchor" is the trustworthy path. */
  locatedBy: LocatedBy;
  /** The anchor text that matched, when located by anchor. */
  matchedAnchor?: string;
}

export interface ClipInputs {
  anchorBefore?: string | null;
  anchorAfter?: string | null;
  /** Interpolated, unreliable timestamp in seconds. */
  rawTimestamp?: number | null;
}

/** Default pad each side of the located point: keeps the clip in the ±10–15 s
 *  band the spec calls for. */
export const DEFAULT_CLIP_PAD_SECONDS = 12;

/** Lowercase, strip punctuation, collapse whitespace — so anchors match the
 *  transcript regardless of casing or incidental punctuation. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read the timestamped transcript off a source's metadata JSON. Tolerant of a
 *  bare array or `{ segments: [...] }`; drops anything without numeric bounds. */
export function parseTranscriptSegments(
  metadata: string | null | undefined,
): TranscriptSegment[] {
  if (!metadata) return [];
  let data: unknown;
  try {
    data = JSON.parse(metadata);
  } catch {
    return [];
  }
  const raw = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { segments?: unknown }).segments)
      ? (data as { segments: unknown[] }).segments
      : [];
  const segments: TranscriptSegment[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const start = Number(seg.start);
    const end = Number(seg.end);
    const text = typeof seg.text === "string" ? seg.text : "";
    if (Number.isFinite(start) && Number.isFinite(end)) {
      segments.push({ start, end, text });
    }
  }
  return segments.sort((a, b) => a.start - b.start);
}

/** Find the segment that carries a given anchor phrase. A segment matches when
 *  its text contains the anchor, or (for short segments) the anchor contains
 *  the segment text. `fromIndex` lets the "after" anchor be searched forward. */
function findAnchorSegment(
  segments: TranscriptSegment[],
  anchor: string,
  fromIndex = 0,
): { seg: TranscriptSegment; index: number } | null {
  const needle = normalize(anchor);
  if (!needle) return null;
  for (let i = Math.max(0, fromIndex); i < segments.length; i++) {
    const hay = normalize(segments[i].text);
    if (!hay) continue;
    if (hay.includes(needle) || needle.includes(hay)) {
      return { seg: segments[i], index: i };
    }
  }
  return null;
}

/**
 * Locate the clip window for a doubtful item. Anchors win over the raw
 * timestamp whenever one matches, so an item whose timestamp is 30 s off still
 * plays the right audio.
 */
export function locateClipWindow(
  segments: TranscriptSegment[],
  inputs: ClipInputs,
  pad: number = DEFAULT_CLIP_PAD_SECONDS,
): ClipWindow {
  const before = inputs.anchorBefore
    ? findAnchorSegment(segments, inputs.anchorBefore)
    : null;
  const after = inputs.anchorAfter
    ? findAnchorSegment(segments, inputs.anchorAfter, before ? before.index + 1 : 0)
    : null;

  if (before || after) {
    const low = before ? before.seg.start : after!.seg.start;
    const high = after ? after.seg.end : before!.seg.end;
    return {
      start: Math.max(0, low - pad),
      end: high + pad,
      locatedBy: "anchor",
      matchedAnchor: before ? inputs.anchorBefore! : inputs.anchorAfter!,
    };
  }

  if (typeof inputs.rawTimestamp === "number" && Number.isFinite(inputs.rawTimestamp)) {
    return {
      start: Math.max(0, inputs.rawTimestamp - pad),
      end: inputs.rawTimestamp + pad,
      locatedBy: "timestamp",
    };
  }

  return { start: 0, end: 0, locatedBy: "none" };
}
