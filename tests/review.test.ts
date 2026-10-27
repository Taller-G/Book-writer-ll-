import { describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { canCompleteStage } from "@/lib/gates";
import { listChanges } from "@/lib/repo/changeLog";
import { createProject } from "@/lib/repo/projects";
import {
  addReviewItem,
  countPendingReviews,
  listReviewItems,
  reviewProgress,
  resolveReviewBatch,
  resolveReviewItem,
} from "@/lib/repo/review";
import { addSource } from "@/lib/repo/sources";
import { insertText, latestText } from "@/lib/repo/texts";
import { locateClipWindow, parseTranscriptSegments } from "@/lib/review/clip";

function setup(content = "") {
  const handle = openDatabase(":memory:");
  const project = createProject(handle, { title: "Inbox" });
  if (content) {
    insertText(handle.db, {
      projectId: project.id,
      stageKey: "passB",
      version: 1,
      content,
    });
  }
  return { db: handle.db, projectId: project.id };
}

describe("review queue — resolving applies to the text and logs it", () => {
  it("free-text resolution replaces the span and records the decision", () => {
    const { db, projectId } = setup("The meeting is at tree o'clock sharp.");
    addReviewItem(db, {
      projectId,
      itemType: "audio",
      stageKey: "passB",
      contextBefore: "The meeting is at ",
      doubtfulText: "tree",
      contextAfter: " o'clock sharp.",
      question: "Did they say 'tree' or 'three'?",
    });
    const item = listReviewItems(db, projectId)[0];
    resolveReviewItem(db, item.id, "free_text", { value: "three", note: "heard 'three' in the clip" });

    expect(latestText(db, projectId, "passB")?.content).toBe(
      "The meeting is at three o'clock sharp.",
    );
    const log = listChanges(db, projectId);
    expect(log.some((e) => /free text/i.test(e.what) && /three/.test(e.what))).toBe(true);
    expect(listReviewItems(db, projectId)[0].status).toBe("accepted");
  });

  it("option A/B resolution applies the chosen option", () => {
    const { db, projectId } = setup("We went to see the Sea Lions.");
    addReviewItem(db, {
      projectId,
      itemType: "audio",
      stageKey: "passB",
      contextBefore: "We went to see the ",
      doubtfulText: "Sea Lions",
      contextAfter: ".",
      options: [
        { id: "a", label: "Sea Lions", value: "Sea Lions" },
        { id: "b", label: "see lines", value: "see lines" },
      ],
      question: "Sea Lions or see lines?",
    });
    const item = listReviewItems(db, projectId)[0];
    resolveReviewItem(db, item.id, "option_b", { value: "b" });
    expect(latestText(db, projectId, "passB")?.content).toBe("We went to see the see lines.");
  });

  it("cut-sentence removes the span and tidies the seam", () => {
    const { db, projectId } = setup("First part. Remove me. Second part.");
    addReviewItem(db, {
      projectId,
      stageKey: "passB",
      contextBefore: "First part.",
      doubtfulText: " Remove me.",
      contextAfter: " Second part.",
      question: "Cut this aside?",
    });
    const item = listReviewItems(db, projectId)[0];
    resolveReviewItem(db, item.id, "cut_sentence");
    expect(latestText(db, projectId, "passB")?.content).toBe("First part. Second part.");
  });

  it("leave-as-is records the decision but changes no text", () => {
    const { db, projectId } = setup("Leave this exactly as written.");
    addReviewItem(db, {
      projectId,
      stageKey: "passB",
      doubtfulText: "exactly as written",
      question: "Reword?",
    });
    const item = listReviewItems(db, projectId)[0];
    resolveReviewItem(db, item.id, "leave_as_is");
    expect(latestText(db, projectId, "passB")?.content).toBe("Leave this exactly as written.");
    expect(listChanges(db, projectId).some((e) => /left as is/i.test(e.what))).toBe(true);
  });
});

describe("review queue — leave-as-is is never flagged again", () => {
  it("suppresses a re-flag of the same span after leave-as-is", () => {
    const { db, projectId } = setup();
    const first = addReviewItem(db, {
      projectId,
      itemType: "structure",
      doubtfulText: "A very long paragraph that got flagged for splitting.",
      question: "Split paragraph 2?",
    });
    expect(first).not.toBeNull();
    resolveReviewItem(db, first!.id, "leave_as_is");

    // A later pass re-flags the identical paragraph (different index/question).
    const second = addReviewItem(db, {
      projectId,
      itemType: "structure",
      doubtfulText: "A very long paragraph that got flagged for splitting.",
      question: "Split paragraph 5?",
    });
    expect(second).toBeNull();
    expect(countPendingReviews(db, projectId)).toBe(0);
    // Only the original item exists — no duplicate was created.
    expect(listReviewItems(db, projectId)).toHaveLength(1);
  });

  it("does not duplicate an identical pending item", () => {
    const { db, projectId } = setup();
    addReviewItem(db, { projectId, itemType: "edit", doubtfulText: "same", question: "q1" });
    const dup = addReviewItem(db, { projectId, itemType: "edit", doubtfulText: "same", question: "q2" });
    expect(dup).toBeNull();
    expect(listReviewItems(db, projectId)).toHaveLength(1);
  });
});

describe("review queue — 15 items resolved consecutively", () => {
  it("resolves fifteen items in a row and empties the queue", () => {
    const { db, projectId } = setup();
    for (let i = 0; i < 15; i++) {
      addReviewItem(db, {
        projectId,
        itemType: i % 2 === 0 ? "audio" : "punctuation",
        doubtfulText: `doubt number ${i}`,
        question: `Decision ${i}?`,
      });
    }
    expect(countPendingReviews(db, projectId)).toBe(15);

    const items = listReviewItems(db, projectId);
    for (const item of items) {
      resolveReviewItem(db, item.id, "leave_as_is");
    }
    expect(countPendingReviews(db, projectId)).toBe(0);
    const progress = reviewProgress(db, projectId);
    expect(progress.resolved).toBe(15);
    expect(progress.pending).toBe(0);
  });

  it("resolves a punctuation batch in one call", () => {
    const { db, projectId } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const item = addReviewItem(db, {
        projectId,
        itemType: "punctuation",
        doubtfulText: `punctuation issue ${i}`,
        question: `Punctuation ${i}?`,
      });
      ids.push(item!.id);
    }
    const resolved = resolveReviewBatch(db, ids, "approve");
    expect(resolved).toBe(12);
    expect(countPendingReviews(db, projectId)).toBe(0);
  });
});

describe("review queue — Stage 6 close is blocked with a named count", () => {
  it("names how many items remain pending", () => {
    const { db, projectId } = setup("Some reviewed text.");
    for (let i = 0; i < 3; i++) {
      addReviewItem(db, { projectId, doubtfulText: `x${i}`, question: `q${i}` });
    }
    const gate = canCompleteStage(db, projectId, 6);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/3/);
    expect(gate.reason).toMatch(/pending/i);
  });
});

describe("review queue — audio clip located by anchor despite timestamp drift", () => {
  it("uses the item's anchor over its drifted raw timestamp", () => {
    const { db, projectId } = setup();
    // An audio source carrying a timestamped transcript in its metadata.
    const source = addSource(db, {
      projectId,
      kind: "audio",
      title: "talk.wav",
      content: "",
    });
    const segments = JSON.stringify({
      segments: [
        { start: 0, end: 4, text: "opening remarks" },
        { start: 120, end: 124, text: "the anchor phrase is here" },
      ],
    });
    // Mirror what the Stage 6 component does to build the clip window.
    const parsed = parseTranscriptSegments(segments);
    const window = locateClipWindow(parsed, {
      anchorBefore: "the anchor phrase is here",
      rawTimestamp: 90, // 30 s off from the real ~120 s
    });
    expect(window.locatedBy).toBe("anchor");
    expect(window.start).toBeGreaterThan(100); // centred on 120, not 90
    expect(source.id).toBeTruthy();
  });
});
