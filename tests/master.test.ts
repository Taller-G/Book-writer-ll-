import { describe, expect, it } from "vitest";
import type { NormalizationRule } from "@/lib/db/schema";
import { mergeChapters, type OutlineChapter } from "@/lib/master/chapters";
import { assembleMasterText } from "@/lib/master/generate";
import { checkQuoteBalance, normalizeText } from "@/lib/master/normalize";
import { chunkSegments, segmentText, segmentsById } from "@/lib/master/segments";
import { RULE_SETS } from "@/lib/repo/normalization";

function rulesFor(language: string, enabledKeys?: string[]): NormalizationRule[] {
  return RULE_SETS[language].map((seed, i) => ({
    id: `r${i}`,
    projectId: "p",
    language,
    ruleKey: seed.ruleKey,
    label: seed.label,
    explanation: seed.explanation,
    kind: seed.kind,
    enabled: !enabledKeys || enabledKeys.includes(seed.ruleKey) ? 1 : 0,
    position: i,
  }));
}

describe("segmentation", () => {
  it("assigns stable ids by paragraph and resolves them back", () => {
    const segments = segmentText("uno\n\ndos\n\n\n\ntres");
    expect(segments.map((s) => s.id)).toEqual([0, 1, 2]);
    expect(segmentsById(segments, [2, 0]).map((s) => s.text)).toEqual([
      "tres",
      "uno",
    ]);
  });

  it("chunks by token budget without dropping segments", () => {
    const segments = segmentText(
      Array.from({ length: 10 }, (_, i) => `párrafo ${i} `.repeat(50)).join("\n\n"),
    );
    const chunks = chunkSegments(segments, 100, (t) => Math.ceil(t.length / 4));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map((s) => s.id)).toEqual(segments.map((s) => s.id));
  });
});

describe("Spanish orthotypographic normalization", () => {
  it("converts quotes to «angular», dashes and ellipsis, and reports each rule", () => {
    const input =
      'Ella dijo "hola" y “adiós”.\n\n- No vuelvas tarde... - dijo la abuela.\n\nFin  del  texto .';
    const { output, changes } = normalizeText(input, rulesFor("es"));
    expect(output).toContain("«hola»");
    expect(output).toContain("«adiós»");
    expect(output).toContain("—No vuelvas tarde…");
    expect(output).toContain("Fin del texto.");
    const keys = changes.map((c) => c.ruleKey);
    expect(keys).toContain("angular-quotes");
    expect(keys).toContain("dialogue-dash");
    expect(keys).toContain("ellipsis");
    expect(keys).toContain("spacing");
  });

  it("a disabled rule does not run", () => {
    const { output } = normalizeText(
      '"hola"...',
      rulesFor("es", ["angular-quotes"]),
    );
    expect(output).toBe("«hola»...");
  });

  it("the pluggable English set produces curly quotes instead", () => {
    const { output } = normalizeText('She said "hi"...', rulesFor("en"));
    expect(output).toBe("She said “hi”…");
  });
});

describe("quote-balance check", () => {
  it("passes on balanced normalized text", () => {
    expect(checkQuoteBalance("«hola» y «adiós» dijo.").ok).toBe(true);
  });

  it("fails on unclosed, inverted or leftover quotes", () => {
    expect(checkQuoteBalance("«hola").ok).toBe(false);
    expect(checkQuoteBalance("hola» «chau»").ok).toBe(false);
    expect(checkQuoteBalance('quedó "esto" sin convertir').ok).toBe(false);
  });
});

describe("outline chapter merge", () => {
  const chapters: OutlineChapter[] = [
    { id: "a", title: "Infancia", part: "", summary: "s1", themes: ["casa"], segmentIds: [0, 1] },
    { id: "b", title: "Trabajo", part: "", summary: "s2", themes: ["oficio"], segmentIds: [4] },
  ];

  it("merges source into target keeping target title and all segments", () => {
    const merged = mergeChapters(chapters, "a", "b");
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("Infancia");
    expect(merged[0].segmentIds).toEqual([0, 1, 4]);
    expect(merged[0].themes).toEqual(["casa", "oficio"]);
    expect(merged[0].summary).toBe("s1 s2");
  });
});

describe("master text assembly", () => {
  it("emits part and chapter headings in order", () => {
    const text = assembleMasterText([
      { chapterId: "a", title: "Uno", part: "Parte I", text: "prosa uno", calls: 1 },
      { chapterId: "b", title: "Dos", part: "Parte I", text: "prosa dos", calls: 1 },
      { chapterId: "c", title: "Tres", part: "Parte II", text: "prosa tres", calls: 1 },
    ]);
    expect(text).toBe(
      "## Parte I\n\n## Uno\n\nprosa uno\n\n## Dos\n\nprosa dos\n\n## Parte II\n\n## Tres\n\nprosa tres",
    );
  });
});
