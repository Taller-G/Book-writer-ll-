import { describe, expect, it } from "vitest";
import {
  locateClipWindow,
  parseTranscriptSegments,
  type TranscriptSegment,
} from "@/lib/review/clip";

const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 5, text: "Welcome everyone to the talk." },
  { start: 95, end: 99, text: "the quick brown fox" },
  { start: 99, end: 103, text: "jumps over the lazy dog" },
  { start: 180, end: 184, text: "and that concludes it" },
];

describe("locateClipWindow", () => {
  it("locates the clip by anchor even when the raw timestamp is 30 s off", () => {
    // The real audio is at ~95 s; the interpolated timestamp drifted to 65 s.
    const window = locateClipWindow(
      SEGMENTS,
      { anchorBefore: "the quick brown fox", rawTimestamp: 65 },
      12,
    );
    expect(window.locatedBy).toBe("anchor");
    // Window is centred on the ANCHOR's time (95–99), not the bad timestamp.
    expect(window.start).toBe(83); // 95 - 12
    expect(window.end).toBe(111); // 99 + 12
    // The drifted timestamp's window (53–77) must NOT be what we return.
    expect(window.start).toBeGreaterThan(77);
  });

  it("matches anchors case- and punctuation-insensitively", () => {
    const window = locateClipWindow(SEGMENTS, { anchorBefore: "The Quick, Brown Fox!" });
    expect(window.locatedBy).toBe("anchor");
    expect(window.start).toBe(83);
  });

  it("spans from the before-anchor to the after-anchor when both are given", () => {
    const window = locateClipWindow(
      SEGMENTS,
      { anchorBefore: "the quick brown fox", anchorAfter: "jumps over the lazy dog" },
      10,
    );
    expect(window.locatedBy).toBe("anchor");
    expect(window.start).toBe(85); // 95 - 10
    expect(window.end).toBe(113); // 103 + 10
  });

  it("clamps the window start to zero", () => {
    const window = locateClipWindow(SEGMENTS, { anchorBefore: "Welcome everyone" }, 12);
    expect(window.start).toBe(0); // 0 - 12 clamped
    expect(window.end).toBe(17);
  });

  it("falls back to the raw timestamp only when no anchor matches", () => {
    const window = locateClipWindow(
      SEGMENTS,
      { anchorBefore: "nothing like this is in the transcript", rawTimestamp: 65 },
      12,
    );
    expect(window.locatedBy).toBe("timestamp");
    expect(window.start).toBe(53);
    expect(window.end).toBe(77);
  });

  it("reports none when there is neither an anchor match nor a timestamp", () => {
    const window = locateClipWindow(SEGMENTS, { anchorBefore: "absent" });
    expect(window.locatedBy).toBe("none");
  });
});

describe("parseTranscriptSegments", () => {
  it("parses a { segments: [...] } metadata blob", () => {
    const meta = JSON.stringify({
      segments: [
        { start: 1, end: 2, text: "a" },
        { start: "bad", end: 3, text: "b" }, // dropped: non-numeric start
        { start: 4, end: 5, text: "c" },
      ],
    });
    const segs = parseTranscriptSegments(meta);
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.text)).toEqual(["a", "c"]);
  });

  it("parses a bare array and sorts by start", () => {
    const meta = JSON.stringify([
      { start: 9, end: 10, text: "late" },
      { start: 1, end: 2, text: "early" },
    ]);
    const segs = parseTranscriptSegments(meta);
    expect(segs.map((s) => s.text)).toEqual(["early", "late"]);
  });

  it("returns [] for missing or malformed metadata", () => {
    expect(parseTranscriptSegments(null)).toEqual([]);
    expect(parseTranscriptSegments("{not json")).toEqual([]);
    expect(parseTranscriptSegments("{}")).toEqual([]);
  });
});
