// Pure outline-chapter model shared by the server repo and the client-side
// outline editor. Must stay free of server-only imports (db, node builtins).

export interface OutlineChapter {
  id: string;
  title: string;
  /** Optional part grouping ("Parte I — ..."). Empty means no part. */
  part: string;
  /** One-paragraph summary from the analysis — reused as book-state memory. */
  summary: string;
  /** Themes/stories the analysis found in this chapter's material. */
  themes: string[];
  /** Indexes into the stable segmentation of the source text. */
  segmentIds: number[];
}

export interface OutlineData {
  chapters: OutlineChapter[];
  /** Repetitions the analysis found, to be treated as deliberate leitmotifs. */
  leitmotifs: string[];
  /** Free-form analysis notes (themes, repetitions, stories found). */
  analysisNotes: string;
}

export const EMPTY_OUTLINE: OutlineData = {
  chapters: [],
  leitmotifs: [],
  analysisNotes: "",
};

/** Merge chapter `sourceId` into chapter `targetId` (title/part of target win). */
export function mergeChapters(
  chapters: OutlineChapter[],
  targetId: string,
  sourceId: string,
): OutlineChapter[] {
  const target = chapters.find((c) => c.id === targetId);
  const source = chapters.find((c) => c.id === sourceId);
  if (!target || !source || targetId === sourceId) return chapters;
  const merged: OutlineChapter = {
    ...target,
    summary: [target.summary, source.summary].filter(Boolean).join(" "),
    themes: [...new Set([...target.themes, ...source.themes])],
    segmentIds: [...target.segmentIds, ...source.segmentIds].sort((a, b) => a - b),
  };
  return chapters
    .filter((c) => c.id !== sourceId)
    .map((c) => (c.id === targetId ? merged : c));
}
