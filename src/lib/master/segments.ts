// Stable segmentation of the cleaned text. Segment ids are the indexes the
// outline's chapters reference (segmentIds), so the same passA version must
// always segment identically: pure function of the input text.

export interface Segment {
  id: number;
  text: string;
}

export function segmentText(input: string): Segment[] {
  return input
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text, id) => ({ id, text }));
}

export function segmentsById(segments: Segment[], ids: number[]): Segment[] {
  const byId = new Map(segments.map((s) => [s.id, s]));
  return ids.map((id) => byId.get(id)).filter((s): s is Segment => s !== undefined);
}

export function joinSegments(segments: Segment[]): string {
  return segments.map((s) => s.text).join("\n\n");
}

/** Split a list of segments into groups of at most `maxTokens` (by estimate). */
export function chunkSegments(
  segments: Segment[],
  maxTokens: number,
  estimate: (text: string) => number,
): Segment[][] {
  const chunks: Segment[][] = [];
  let current: Segment[] = [];
  let currentTokens = 0;
  for (const seg of segments) {
    const t = estimate(seg.text);
    if (current.length > 0 && currentTokens + t > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(seg);
    currentTokens += t;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
