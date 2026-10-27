// Page-by-page visual diff between two PDF versions (spec §5.1).
//
// After a correction is applied the user must see which pages changed and the
// new total page count. Pages are compared positionally by content: a page is
// "changed" when its text differs from the same-numbered page in the previous
// version; pages beyond the shorter version are "added" or "removed".

import type { Page } from "./paginate";

export interface PageDiff {
  /** Page numbers present in both versions whose content differs. */
  changedPages: number[];
  /** Page numbers that exist only in the new version. */
  addedPages: number[];
  /** Page numbers that existed only in the old version. */
  removedPages: number[];
  oldPageCount: number;
  newPageCount: number;
}

/** A page's content, as compared by the diff (trimmed, whitespace-collapsed). */
function pageKey(page: Page): string {
  return page.text.replace(/\s+/g, " ").trim();
}

export function diffVersions(oldPages: Page[], newPages: Page[]): PageDiff {
  const changedPages: number[] = [];
  const addedPages: number[] = [];
  const removedPages: number[] = [];
  const shared = Math.min(oldPages.length, newPages.length);

  for (let i = 0; i < shared; i++) {
    if (pageKey(oldPages[i]) !== pageKey(newPages[i])) {
      changedPages.push(i + 1);
    }
  }
  for (let i = shared; i < newPages.length; i++) addedPages.push(i + 1);
  for (let i = shared; i < oldPages.length; i++) removedPages.push(i + 1);

  return {
    changedPages,
    addedPages,
    removedPages,
    oldPageCount: oldPages.length,
    newPageCount: newPages.length,
  };
}

/** Parse the JSON `pages` column of a pdf_versions row back into Page[]. */
export function parsePages(pagesJson: string | null | undefined): Page[] {
  let raw: unknown;
  try {
    raw = JSON.parse(pagesJson || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is string => typeof p === "string")
    .map((text, i) => ({
      pageNumber: i + 1,
      lines: text.split("\n"),
      text,
    }));
}

/** Serialize Page[] into the JSON string stored in pdf_versions.pages. */
export function serializePages(pages: Page[]): string {
  return JSON.stringify(pages.map((p) => p.text));
}
