import { describe, expect, it } from "vitest";
import {
  applyCorrections,
  enforceFaithfulContract,
  parseProposedCorrections,
  verifyDiffMatchesCorrections,
  wordDiff,
  type Correction,
} from "@/lib/transcription/corrections";

const asr = (original: string, correction: string): Correction => ({
  type: "ASR",
  original,
  correction,
  justification: `misheard "${original}" as "${correction}"`,
});

describe("noise-correction engine", () => {
  it("applies a unique mishearing and leaves the rest untouched", () => {
    const source = "And then he said Tu shé and walked away.";
    const res = applyCorrections(source, [asr("Tu shé", "Touché")], "verbatim");
    expect(res.output).toBe("And then he said Touché and walked away.");
    expect(res.applied).toHaveLength(1);
    expect(res.doubtful).toHaveLength(0);
    expect(res.rejected).toHaveLength(0);
  });

  it("does NOT apply a correction whose target appears twice — it is doubtful", () => {
    const source = "Tu shé here and Tu shé there.";
    const res = applyCorrections(source, [asr("Tu shé", "Touché")], "verbatim");
    expect(res.applied).toHaveLength(0);
    expect(res.output).toBe(source); // unchanged
    expect(res.doubtful).toHaveLength(1);
    expect(res.doubtful[0].occurrences).toBe(2);
    expect(res.doubtful[0].reason).toMatch(/appears 2 times/);
  });

  it("sends a correction whose target is absent to the doubtful queue", () => {
    const res = applyCorrections("nothing here", [asr("Tu shé", "Touché")], "prose");
    expect(res.applied).toHaveLength(0);
    expect(res.doubtful[0].occurrences).toBe(0);
  });

  it("rejects a rewrite (not noise correction) under a faithful contract, with a reason", () => {
    const rewrite: Correction = {
      type: "ASR",
      original: "he walked slowly to the door and paused for a long time",
      correction: "he approached the threshold, hesitating",
      justification: "nicer phrasing",
    };
    const guard = enforceFaithfulContract(rewrite, "verbatim");
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toMatch(/rewrite|too large/i);
    expect(guard.reason).toMatch(/verbatim/);

    const res = applyCorrections("x", [rewrite], "verbatim");
    expect(res.applied).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
  });

  it("rejects an unknown (non-noise) correction class at parse time", () => {
    const json = JSON.stringify([
      { type: "STYLE", original: "a", correction: "b", justification: "x" },
    ]);
    const parsed = parseProposedCorrections(json);
    expect(parsed.valid).toHaveLength(0);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].reason).toMatch(/Unknown correction class/);
  });

  it("parses a well-formed proposal and normalizes the type", () => {
    const json = JSON.stringify({
      corrections: [
        { type: "asr", original: "Tu shé", correction: "Touché", justification: "misheard" },
        { type: "NOM", original: "Jon", correction: "John", justification: "name" },
      ],
    });
    const parsed = parseProposedCorrections(json);
    expect(parsed.valid).toHaveLength(2);
    expect(parsed.valid[0].type).toBe("ASR");
  });

  it("word-diff verification proves final == source + exactly the logged changes", () => {
    const source = "A Tu shé here and Jon over there.";
    const corrections = [asr("Tu shé", "Touché"), { ...asr("Jon", "John"), type: "NOM" as const }];
    const res = applyCorrections(source, corrections, "verbatim");
    const verdict = verifyDiffMatchesCorrections(source, res.output, res.applied);
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toHaveLength(0);
  });

  it("word-diff verification FAILS when the text changed beyond the logged corrections", () => {
    const source = "A Tu shé here.";
    const res = applyCorrections(source, [asr("Tu shé", "Touché")], "verbatim");
    // Tamper: an extra word was removed that no correction accounts for.
    const tampered = res.output.replace("here", "");
    const verdict = verifyDiffMatchesCorrections(source, tampered, res.applied);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/don't account|does not match/);
  });

  it("wordDiff reports a replace hunk for a single substitution", () => {
    const hunks = wordDiff("the quick brown fox", "the slow brown fox").filter(
      (h) => h.op !== "equal",
    );
    expect(hunks).toHaveLength(1);
    expect(hunks[0].op).toBe("replace");
    expect(hunks[0].from).toEqual(["quick"]);
    expect(hunks[0].to).toEqual(["slow"]);
  });
});
