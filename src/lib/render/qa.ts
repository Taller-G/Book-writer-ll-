import { execFileSync } from "node:child_process";

// Post-render QA: programmatic checks over the compiled PDF using poppler
// (pdftotext/pdffonts/pdfimages). Every defect class here happened in a real
// book and must be caught by code, not by eyes — each check reports the
// affected physical pages.

export interface QaCheck {
  id: string;
  title: string;
  passed: boolean;
  /** Physical (1-based) page numbers affected when the check fails. */
  pages: number[];
  detail: string;
}

export interface QaReport {
  passed: boolean;
  checks: QaCheck[];
}

export interface QaExpectations {
  /** Chapter titles in book order — drives the TOC sync check. */
  chapterTitles: string[];
  /** Scene separators the composition emitted. */
  separatorCount: number;
  /** Page margins, as written in format_config (e.g. "20mm"). */
  margins: { top: string; bottom: string; inner: string; outer: string };
  minImageDpi?: number;
  /** Widow/orphan pages tolerated before the check fails. */
  widowOrphanTolerance?: number;
}

// --- geometry ---------------------------------------------------------------

interface Box {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

interface Word extends Box {
  text: string;
}

interface Line extends Box {
  words: Word[];
}

interface PageLayout {
  width: number;
  height: number;
  /** All text lines on the page, in reading order. */
  lines: Line[];
}

export function toPt(dim: string): number {
  const m = dim.trim().match(/^([\d.]+)\s*(pt|mm|cm|in)?$/);
  if (!m) return 0;
  const v = Number(m[1]);
  switch (m[2] ?? "pt") {
    case "mm":
      return (v * 72) / 25.4;
    case "cm":
      return (v * 72) / 2.54;
    case "in":
      return v * 72;
    default:
      return v;
  }
}

const ATTR = (tag: string, name: string): number =>
  Number(tag.match(new RegExp(`${name}="([\\d.]+)"`))?.[1] ?? 0);

/** Parse `pdftotext -bbox-layout` XML into per-page lines of words. */
export function parseBboxLayout(xml: string): PageLayout[] {
  const pages: PageLayout[] = [];
  let page: PageLayout | null = null;
  let line: Line | null = null;
  for (const raw of xml.split("\n")) {
    const t = raw.trim();
    if (t.startsWith("<page ")) {
      page = { width: ATTR(t, "width"), height: ATTR(t, "height"), lines: [] };
      pages.push(page);
    } else if (t.startsWith("<line ") && page) {
      line = {
        xMin: ATTR(t, "xMin"),
        yMin: ATTR(t, "yMin"),
        xMax: ATTR(t, "xMax"),
        yMax: ATTR(t, "yMax"),
        words: [],
      };
      page.lines.push(line);
    } else if (t.startsWith("<word ") && line) {
      const text = t.replace(/<[^>]+>/g, "");
      line.words.push({
        xMin: ATTR(t, "xMin"),
        yMin: ATTR(t, "yMin"),
        xMax: ATTR(t, "xMax"),
        yMax: ATTR(t, "yMax"),
        text: decodeXmlEntities(text),
      });
    }
  }
  for (const p of pages) {
    p.lines.sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);
  }
  return pages;
}

function decodeXmlEntities(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

const FOLIO_RE = /^(\d+|[ivxlcdm]+)$/i;

function lineText(l: Line): string {
  return l.words.map((w) => w.text).join(" ");
}

/**
 * The folio is a page-number word inside the bottom margin band. Detected at
 * WORD level on purpose: when text intrudes into the folio zone, pdftotext
 * merges folio and text into one line — exactly the defect the overlap check
 * must catch, so line-level detection would go blind at the worst moment.
 */
function folioOf(page: PageLayout, bottomMarginPt: number): Word | null {
  const bandTop = page.height - bottomMarginPt;
  const candidates = page.lines
    .flatMap((l) => l.words)
    .filter((w) => w.yMin > bandTop && FOLIO_RE.test(w.text));
  if (candidates.length === 0) return null;
  // Plain pagestyle centers the folio: nearest to the page center wins.
  const center = page.width / 2;
  candidates.sort(
    (a, b) =>
      Math.abs((a.xMin + a.xMax) / 2 - center) -
      Math.abs((b.xMin + b.xMax) / 2 - center),
  );
  return candidates[0];
}

/** Text lines, excluding the folio's own line when it holds only the folio. */
function bodyLines(page: PageLayout, bottomMarginPt: number): Line[] {
  const folio = folioOf(page, bottomMarginPt);
  if (!folio) return page.lines;
  return page.lines.filter(
    (l) => !(l.words.length === 1 && l.words[0] === folio),
  );
}

function intersects(a: Box, b: Box, epsilon = 0.5): boolean {
  return (
    a.xMin < b.xMax - epsilon &&
    b.xMin < a.xMax - epsilon &&
    a.yMin < b.yMax - epsilon &&
    b.yMin < a.yMax - epsilon
  );
}

function isSeparatorLine(l: Line): boolean {
  return l.words.length >= 2 && l.words.every((w) => w.text === "*");
}

// --- checks -----------------------------------------------------------------

function checkFolioOverlap(pages: PageLayout[], bottomPt: number): QaCheck {
  const affected: number[] = [];
  pages.forEach((page, i) => {
    const folio = folioOf(page, bottomPt);
    if (!folio) return;
    const others = page.lines.flatMap((l) => l.words).filter((w) => w !== folio);
    // Direct bbox intersection, or any text sharing the folio's vertical band
    // — both mean the text block ran into the page number.
    const overlapping = others.some(
      (w) =>
        intersects(w, folio) ||
        (w.yMin < folio.yMax - 1 && w.yMax > folio.yMin + 1),
    );
    if (overlapping) affected.push(i + 1);
  });
  return {
    id: "folio_overlap",
    title: "No text overlaps the folio (page number)",
    passed: affected.length === 0,
    pages: affected,
    detail:
      affected.length === 0
        ? "Every folio sits clear of the text block."
        : `Text intersects the folio zone on page(s) ${affected.join(", ")}.`,
  };
}

function checkSeparators(
  pages: PageLayout[],
  exp: QaExpectations,
): QaCheck {
  const offCenter: number[] = [];
  const duplicated: number[] = [];
  let found = 0;
  const inner = toPt(exp.margins.inner);
  const outer = toPt(exp.margins.outer);
  const bottom = toPt(exp.margins.bottom);
  pages.forEach((page, i) => {
    const physical = i + 1;
    const recto = physical % 2 === 1;
    const left = recto ? inner : outer;
    const right = page.width - (recto ? outer : inner);
    const center = (left + right) / 2;
    const tolerance = (right - left) * 0.03;
    const body = bodyLines(page, bottom);
    let previousWasSeparator = false;
    for (const l of body) {
      if (!isSeparatorLine(l)) {
        previousWasSeparator = false;
        continue;
      }
      found++;
      if (Math.abs((l.xMin + l.xMax) / 2 - center) > tolerance) {
        offCenter.push(physical);
      }
      if (previousWasSeparator) duplicated.push(physical);
      previousWasSeparator = true;
    }
  });
  const problems: string[] = [];
  if (offCenter.length > 0) problems.push(`off-center on page(s) ${offCenter.join(", ")}`);
  if (duplicated.length > 0) problems.push(`duplicated on page(s) ${duplicated.join(", ")}`);
  if (found !== exp.separatorCount) {
    problems.push(`expected ${exp.separatorCount} separator(s), found ${found}`);
  }
  return {
    id: "separators",
    title: "Scene separators centered and not duplicated",
    passed: problems.length === 0,
    pages: [...new Set([...offCenter, ...duplicated])],
    detail:
      problems.length === 0
        ? `${found} separator(s), all centered, none duplicated.`
        : problems.join("; "),
  };
}

interface TocEntry {
  chapter: number;
  printedPage: string;
}

/** TOC entries from the Contents page(s) of `pdftotext -layout` text. */
function parseTocEntries(layoutPages: string[]): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const pageText of layoutPages) {
    const lines = pageText.split("\n");
    const firstContent = lines.find((l) => l.trim().length > 0)?.trim();
    if (firstContent !== "Contents") continue;
    for (const l of lines) {
      const m = l.match(/^\s*(\d+)\s+\S.*?\s{2,}(\d+|[ivxlcdm]+)\s*$/i);
      if (m) entries.push({ chapter: Number(m[1]), printedPage: m[2] });
    }
  }
  return entries;
}

/** Printed folio (text of the page-number word) per physical page. */
function printedFolios(pages: PageLayout[], bottomPt: number): Array<string | null> {
  return pages.map((p) => folioOf(p, bottomPt)?.text ?? null);
}

function checkTocSync(
  pages: PageLayout[],
  layoutPages: string[],
  exp: QaExpectations,
): QaCheck {
  const entries = parseTocEntries(layoutPages);
  const folios = printedFolios(pages, toPt(exp.margins.bottom));
  // Actual chapter start pages: the page whose body begins "Chapter N".
  const actual = new Map<number, { physical: number; printed: string | null }>();
  layoutPages.forEach((pageText, i) => {
    const first = pageText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    const m = first?.match(/^Chapter (\d+)$/);
    if (m) actual.set(Number(m[1]), { physical: i + 1, printed: folios[i] });
  });
  const problems: string[] = [];
  const affected: number[] = [];
  for (let n = 1; n <= exp.chapterTitles.length; n++) {
    const entry = entries.find((e) => e.chapter === n);
    const act = actual.get(n);
    if (!act) {
      problems.push(`chapter ${n} ("${exp.chapterTitles[n - 1]}") not found in the PDF`);
      continue;
    }
    if (!entry) {
      problems.push(`chapter ${n} has no TOC entry`);
      affected.push(act.physical);
      continue;
    }
    if (entry.printedPage !== act.printed) {
      problems.push(
        `chapter ${n}: TOC says page ${entry.printedPage}, actually starts on page ${act.printed ?? "?"}`,
      );
      affected.push(act.physical);
    }
  }
  if (entries.length !== exp.chapterTitles.length) {
    problems.push(
      `TOC lists ${entries.length} chapter(s), the book has ${exp.chapterTitles.length}`,
    );
  }
  return {
    id: "toc_sync",
    title: "Table of contents in sync with actual page numbers",
    passed: problems.length === 0,
    pages: affected,
    detail:
      problems.length === 0
        ? `All ${exp.chapterTitles.length} TOC entries match the printed pages.`
        : problems.join("; "),
  };
}

function checkChapterRecto(layoutPages: string[]): QaCheck {
  const affected: number[] = [];
  const chapters: number[] = [];
  layoutPages.forEach((pageText, i) => {
    const first = pageText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (first?.match(/^Chapter \d+$/)) {
      chapters.push(i + 1);
      if ((i + 1) % 2 === 0) affected.push(i + 1);
    }
  });
  return {
    id: "chapter_recto",
    title: "Chapters open on recto (odd) pages",
    passed: affected.length === 0,
    pages: affected,
    detail:
      affected.length === 0
        ? `All ${chapters.length} chapter(s) open recto.`
        : `Chapter opening(s) on verso page(s) ${affected.join(", ")}.`,
  };
}

function checkFontsEmbedded(pdfPath: string): QaCheck {
  const out = execFileSync("pdffonts", [pdfPath], { encoding: "utf8" });
  const rows = out.split("\n").slice(2).filter((l) => l.trim().length > 0);
  const notEmbedded: string[] = [];
  for (const row of rows) {
    // Columns from the right: emb sub uni objectID gen — the name/type on the
    // left can contain spaces.
    const tokens = row.trim().split(/\s+/);
    if (tokens.length < 6) continue;
    const emb = tokens[tokens.length - 5];
    if (emb !== "yes") notEmbedded.push(tokens[0]);
  }
  return {
    id: "fonts_embedded",
    title: "All fonts embedded in the PDF",
    passed: notEmbedded.length === 0,
    pages: [],
    detail:
      notEmbedded.length === 0
        ? `${rows.length} font(s), all embedded.`
        : `Font(s) not embedded: ${notEmbedded.join(", ")}.`,
  };
}

function checkImageDpi(pdfPath: string, minDpi: number): QaCheck {
  const out = execFileSync("pdfimages", ["-list", pdfPath], { encoding: "utf8" });
  const rows = out.split("\n").slice(2).filter((l) => l.trim().length > 0);
  const affected: number[] = [];
  let images = 0;
  for (const row of rows) {
    const t = row.trim().split(/\s+/);
    if (t.length < 14 || t[2] !== "image") continue;
    images++;
    const dpi = Math.min(Number(t[12]), Number(t[13]));
    if (Number.isFinite(dpi) && dpi < minDpi) affected.push(Number(t[0]));
  }
  return {
    id: "image_dpi",
    title: `Images at ≥${minDpi} dpi at printed size`,
    passed: affected.length === 0,
    pages: [...new Set(affected)],
    detail:
      images === 0
        ? "No raster images in the PDF."
        : affected.length === 0
          ? `${images} image(s), all at or above ${minDpi} dpi.`
          : `Image(s) below ${minDpi} dpi on page(s) ${[...new Set(affected)].join(", ")}.`,
  };
}

function checkWidowsOrphans(
  pages: PageLayout[],
  exp: QaExpectations,
): QaCheck {
  const tolerance = exp.widowOrphanTolerance ?? 0;
  const inner = toPt(exp.margins.inner);
  const outer = toPt(exp.margins.outer);
  const bottom = toPt(exp.margins.bottom);
  const widows: number[] = [];
  const orphans: number[] = [];
  const contentPages = pages
    .map((p, i) => ({ page: p, physical: i + 1, body: bodyLines(p, bottom) }))
    .filter((p) => p.body.length > 0);
  for (let k = 0; k < contentPages.length; k++) {
    const { physical, body } = contentPages[k];
    const left = physical % 2 === 1 ? inner : outer;
    const atMargin = (l: Line) => Math.abs(l.xMin - left) < 2;
    const indented = (l: Line) => l.xMin - left > 5 && l.xMin - left < 45;
    // Widow: a lone continuation line (flush at the margin) at the top of the
    // page, immediately followed by a new (indented) paragraph or nothing.
    const first = body[0];
    if (
      atMargin(first) &&
      !isSeparatorLine(first) &&
      !lineText(first).match(/^Chapter \d+$/) &&
      (body.length === 1 || indented(body[1]) || isSeparatorLine(body[1]))
    ) {
      widows.push(physical);
    }
    // Orphan: the last line of the page opens a paragraph (indented) and that
    // paragraph continues at the margin on the next content page.
    const last = body[body.length - 1];
    const next = contentPages[k + 1];
    if (
      next &&
      indented(last) &&
      !isSeparatorLine(last) &&
      atMargin(next.body[0])
    ) {
      orphans.push(physical);
    }
  }
  const affected = [...new Set([...widows, ...orphans])];
  return {
    id: "widows_orphans",
    title: `Widows/orphans within tolerance (≤${tolerance})`,
    passed: affected.length <= tolerance,
    pages: affected,
    detail:
      affected.length === 0
        ? "No widow or orphan lines detected."
        : `${widows.length} widow(s) on page(s) [${widows.join(", ")}], ` +
          `${orphans.length} orphan(s) on page(s) [${orphans.join(", ")}].`,
  };
}

// --- runner -----------------------------------------------------------------

export function runQa(pdfPath: string, exp: QaExpectations): QaReport {
  const bboxXml = execFileSync("pdftotext", ["-bbox-layout", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const layoutText = execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const pages = parseBboxLayout(bboxXml);
  const layoutPages = layoutText.split("\f");

  const checks: QaCheck[] = [
    checkFolioOverlap(pages, toPt(exp.margins.bottom)),
    checkSeparators(pages, exp),
    checkTocSync(pages, layoutPages, exp),
    checkChapterRecto(layoutPages),
    checkFontsEmbedded(pdfPath),
    checkImageDpi(pdfPath, exp.minImageDpi ?? 300),
    checkWidowsOrphans(pages, exp),
  ];
  return { passed: checks.every((c) => c.passed), checks };
}
