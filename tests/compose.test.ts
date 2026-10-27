import { describe, expect, it } from "vitest";
import {
  approvedWordStream,
  composeBook,
  composedWordStream,
  CompositionMismatchError,
  parseBook,
  verifyComposition,
} from "@/lib/render/compose";
import type { FormatConfig } from "@/lib/db/schema";

const FORMAT: FormatConfig = {
  projectId: "p1",
  trimSize: "6x9in",
  fontFamily: "Palatino",
  fontSizePt: 11,
  lineHeight: 1.4,
  margins: '{"top":"20mm","bottom":"20mm","inner":"22mm","outer":"16mm"}',
  data: "{}",
  updatedAt: "2026-10-27 00:00:00",
};

const APPROVED = `## The Beginning

It was a quiet morning. The harbour slept.

* * *

Costs rose by 10% & margins fell below $5 — the #1 worry, under_score {braces} and a caret ^ plus ~tilde.

## The Middle

Chapter two carries on with plain prose.`;

describe("parseBook", () => {
  it("splits headings, separators and paragraphs", () => {
    const model = parseBook(APPROVED);
    expect(model.intro).toHaveLength(0);
    expect(model.chapters.map((c) => c.title)).toEqual([
      "The Beginning",
      "The Middle",
    ]);
    expect(model.chapters[0].blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "separator",
      "paragraph",
    ]);
  });

  it("keeps content before the first heading as intro", () => {
    const model = parseBook("A preface line.\n\n## One\n\nBody.");
    expect(model.intro).toEqual([{ kind: "paragraph", text: "A preface line." }]);
  });
});

describe("composition verification", () => {
  it("round-trips: composed word stream equals approved word stream", () => {
    const { tex } = composeBook(APPROVED, FORMAT, { title: "T", author: "A" });
    expect(composedWordStream(tex)).toEqual(approvedWordStream(APPROVED));
    expect(() => verifyComposition(APPROVED, tex)).not.toThrow();
  });

  it("aborts on a one-word discrepancy, naming the position", () => {
    const { tex } = composeBook(APPROVED, FORMAT, { title: "T", author: "A" });
    const tampered = tex.replace("harbour", "harbor");
    expect(() => verifyComposition(APPROVED, tampered)).toThrow(
      CompositionMismatchError,
    );
    try {
      verifyComposition(APPROVED, tampered);
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      // "harbour" is the 9th word: 2 title words + "It was a quiet morning." (5) + "The" (6,7) …
      expect(msg).toMatch(/word 9\b/);
      expect(msg).toContain('"harbour"');
      expect(msg).toContain('"harbor"');
    }
  });

  it("aborts when the composition drops or adds words", () => {
    const { tex } = composeBook(APPROVED, FORMAT, { title: "T", author: "A" });
    const dropped = tex.replace("The harbour slept.", "The slept.");
    expect(() => verifyComposition(APPROVED, dropped)).toThrow(/word 9\b/);
    const added = tex.replace("The harbour slept.", "The old harbour slept.");
    expect(() => verifyComposition(APPROVED, added)).toThrow(/word 9\b/);
  });

  it("aborts when the body markers are missing", () => {
    expect(() => composedWordStream("\\documentclass{memoir}")).toThrow(
      /body markers/,
    );
  });
});
