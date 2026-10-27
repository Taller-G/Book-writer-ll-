"use client";

import { Fragment, useMemo, useState } from "react";
import { saveFormatAction } from "@/lib/actions/content";
import {
  getPageSize,
  MARGIN_RANGES_CM,
  PAGE_SIZES,
  PROVEN_DEFAULTS,
  serializeFormatData,
  type FormatConfigData,
  type PageSizeId,
} from "@/lib/format/config";

// Preview font stacks: the real face when installed/loaded, graceful print-like
// fallbacks otherwise. The Google Fonts link below covers the two defaults.
const FONT_STACKS: Record<string, string> = {
  "EB Garamond": `"EB Garamond", Garamond, "Apple Garamond", Georgia, serif`,
  Baskerville: `Baskerville, "Libre Baskerville", "Times New Roman", serif`,
  Palatino: `Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif`,
  Inter: `Inter, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`,
  "Gill Sans": `"Gill Sans", "Gill Sans MT", Calibri, sans-serif`,
  "Helvetica Neue": `"Helvetica Neue", Helvetica, Arial, sans-serif`,
};
const stack = (family: string) =>
  FONT_STACKS[family] ?? `"${family}", Georgia, serif`;

const TYPEFACE_PAIRS = [
  {
    id: "garamond-inter",
    body: "EB Garamond",
    heading: "Inter",
    label: "EB Garamond + Inter",
    blurb:
      "A classic old-style serif for long reading, with a quiet modern sans for headings and folios. The pairing both finished books shipped with.",
    recommended: true,
  },
  {
    id: "baskerville-gill",
    body: "Baskerville",
    heading: "Gill Sans",
    label: "Baskerville + Gill Sans",
    blurb:
      "A brighter transitional serif with more contrast; reads slightly more formal. Good for essays and non-fiction.",
    recommended: false,
  },
  {
    id: "palatino-helvetica",
    body: "Palatino",
    heading: "Helvetica Neue",
    label: "Palatino + Helvetica",
    blurb:
      "A sturdy calligraphic serif that stays readable at small sizes; a neutral sans on top. Forgiving on lower-quality paper.",
    recommended: false,
  },
];

const PAGE_SIZE_INFO: Record<
  PageSizeId,
  { blurb: string; recommended: boolean }
> = {
  A5: {
    blurb:
      "The proven choice: standard everywhere, cheapest to print, and comfortable in the hand for memoir-length prose. Both real projects ended here.",
    recommended: true,
  },
  "12x18cm": {
    blurb:
      "Smaller and more intimate, but lines get short and page count (and cost) grows. The first project started here and had to migrate to A5 — painfully.",
    recommended: false,
  },
  "15x23cm": {
    blurb:
      "Larger trade format. Suits illustrated or technical books; for plain prose the lines run long unless margins grow with them.",
    recommended: false,
  },
};

const MM_PER_PT = 0.3528;

function Reco({ children }: { children: React.ReactNode }) {
  return <span className="reco-chip">Recommended · {children}</span>;
}

/* ------------------------------------------------------------------ */
/* Live sample-page preview                                            */
/* ------------------------------------------------------------------ */

function PagePreview({
  data,
  paragraphs,
  usingRealText,
}: {
  data: FormatConfigData;
  paragraphs: string[];
  usingRealText: boolean;
}) {
  // Fixed px-per-mm scale so the three trim sizes visibly differ in size.
  const scale = 1.35;
  const size = getPageSize(data.pageSize);
  const pageW = size.widthMm * scale;
  const pageH = size.heightMm * scale;
  const cm = (v: number) => v * 10 * scale;
  const pt = (v: number) => v * MM_PER_PT * scale;

  const bodyStyle: React.CSSProperties = {
    fontFamily: stack(data.typography.bodyFamily),
    fontSize: pt(data.typography.bodySizePt),
    lineHeight: `${pt(data.typography.leadingPt)}px`,
    fontVariantNumeric:
      data.typography.numerals === "oldstyle" ? "oldstyle-nums" : "lining-nums",
    textAlign: "justify",
  };
  const paraStyle = (first: boolean): React.CSSProperties =>
    data.paragraphs.style === "indent"
      ? {
          margin: 0,
          textIndent: first ? 0 : `${data.paragraphs.indentEm}em`,
        }
      : { margin: `0 0 ${data.paragraphs.spacingEm * 0.5}em` };

  const folioStyle: React.CSSProperties = {
    position: "absolute",
    bottom: data.folios.position === "outer-top" ? undefined : cm(data.marginsCm.bottom) * 0.45,
    top: data.folios.position === "outer-top" ? cm(data.marginsCm.top) * 0.4 : undefined,
    fontFamily: stack(data.folios.family),
    fontSize: Math.max(pt(data.folios.sizePt), 5),
    fontVariant: data.folios.smallCaps ? "small-caps" : "normal",
    fontVariantNumeric:
      data.typography.numerals === "oldstyle" ? "oldstyle-nums" : "lining-nums",
    color: "#555",
  };

  const separator =
    data.conventions.separatorStyle === "whitespace" ? (
      <div
        aria-label="scene separator"
        style={{ height: `${data.conventions.separatorSpaceEm}em` }}
      />
    ) : (
      <hr
        style={{
          border: "none",
          borderTop: "1px solid #999",
          width: "30%",
          margin: "0.9em auto",
        }}
      />
    );

  function folio(side: "verso" | "recto", num: string) {
    const horizontal =
      data.folios.position === "center-bottom"
        ? { left: 0, right: 0, textAlign: "center" as const }
        : side === "verso"
          ? { left: cm(data.marginsCm.outer) }
          : { right: cm(data.marginsCm.outer) };
    return <span style={{ ...folioStyle, ...horizontal }}>{num}</span>;
  }

  const page = (side: "verso" | "recto"): React.CSSProperties => ({
    position: "relative",
    width: pageW,
    height: pageH,
    background: "#fffdf8",
    border: "1px solid #d8d4cc",
    boxShadow:
      side === "verso" ? "-2px 2px 6px rgba(0,0,0,.08)" : "2px 2px 6px rgba(0,0,0,.08)",
    overflow: "hidden",
    paddingTop: cm(data.marginsCm.top),
    paddingBottom: cm(data.marginsCm.bottom),
    paddingLeft: cm(side === "verso" ? data.marginsCm.outer : data.marginsCm.inner),
    paddingRight: cm(side === "verso" ? data.marginsCm.inner : data.marginsCm.outer),
  });

  const versoParas = paragraphs.slice(0, 6);
  const rectoParas = paragraphs.slice(1, 5);
  const chapterOnRecto = data.conventions.chaptersOpenRecto;

  return (
    <div>
      <div className="page-spread" data-testid="format-preview">
        {/* Verso: running text, with the separator sample mid-page. */}
        <div style={page("verso")} data-testid="preview-verso">
          <div style={bodyStyle}>
            {versoParas.map((p, i) => (
              <Fragment key={i}>
                {i === 2 && separator}
                <p style={paraStyle(false)}>{p}</p>
              </Fragment>
            ))}
          </div>
          {folio("verso", "24")}
        </div>
        {/* Recto: chapter opening when chapters open recto. */}
        <div style={page("recto")} data-testid="preview-recto">
          {chapterOnRecto ? (
            <div style={bodyStyle}>
              <div
                style={{
                  fontFamily: stack(data.typography.headingFamily),
                  fontWeight: 600,
                  fontSize: pt(data.typography.bodySizePt * 1.5),
                  lineHeight: 1.25,
                  margin: `${pageH * 0.12}px 0 ${pt(data.typography.leadingPt) * 1.5}px`,
                }}
              >
                Chapter 3
              </div>
              {rectoParas.map((p, i) => (
                <p key={i} style={paraStyle(i === 0)}>
                  {p}
                </p>
              ))}
            </div>
          ) : (
            <div style={bodyStyle}>
              {rectoParas.map((p, i) => (
                <p key={i} style={paraStyle(false)}>
                  {p}
                </p>
              ))}
            </div>
          )}
          {(!chapterOnRecto || data.folios.onChapterOpenings) &&
            folio("recto", "25")}
        </div>
      </div>
      <p className="muted preview-caption">
        {usingRealText
          ? "Set with your own text — "
          : "No project text yet, showing placeholder — "}
        left page runs on; right page {chapterOnRecto ? "opens a chapter" : "runs on"}
        {data.folios.frontMatterUnnumbered
          ? ". Front matter stays unnumbered."
          : ". Front matter is numbered."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Margin diagram: why inner > outer                                   */
/* ------------------------------------------------------------------ */

function MarginDiagram({ margins }: { margins: FormatConfigData["marginsCm"] }) {
  const w = 110;
  const h = 150;
  const s = 7; // px per cm, diagram scale
  const pad = (side: "verso" | "recto") => ({
    top: margins.top * s,
    bottom: margins.bottom * s,
    left: (side === "verso" ? margins.outer : margins.inner) * s,
    right: (side === "verso" ? margins.inner : margins.outer) * s,
  });
  const pageBox = (side: "verso" | "recto") => {
    const p = pad(side);
    return (
      <div className="margin-diagram-page" style={{ width: w, height: h }}>
        <div
          className="margin-diagram-text"
          style={{
            top: p.top,
            bottom: p.bottom,
            left: p.left,
            right: p.right,
          }}
        />
      </div>
    );
  };
  return (
    <div className="margin-diagram">
      <div className="margin-diagram-spread">
        {pageBox("verso")}
        <div className="margin-diagram-spine" title="spine / binding" />
        {pageBox("recto")}
      </div>
      <p className="muted" style={{ fontSize: "0.82rem", margin: "0.5rem 0 0" }}>
        The grey blocks are your text. The binding swallows part of the inner
        (spine-side) margin — the glue and the page curvature hide 3–5&nbsp;mm —
        so the inner margin must be <strong>larger</strong> than the outer one
        for the two to <em>look</em> equal in the opened book.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The wizard                                                          */
/* ------------------------------------------------------------------ */

const PLACEHOLDER_TEXT = [
  "That winter the house smelled of woodsmoke and oranges, and nobody imagined it would be the last one we spent all together.",
  "My grandfather kept his tools in a wooden crate under the stairs, each one wrapped in cloth like something precious, and in a way they were.",
  "We would walk to the river on Sunday mornings, my mother in front, the rest of us trailing behind like ducklings in no particular hurry.",
  "Years later I understood that the stories he told us were not entirely true, and that this was precisely what made them worth retelling.",
  "The letters arrived every month for eleven years, always in the same blue envelopes, always signed with a single initial.",
  "There is a photograph of that afternoon, creased down the middle, and everyone in it is laughing at something outside the frame.",
].join("\n\n");

export function FormatWizard({
  projectId,
  saved,
  sampleText,
  layoutStarted,
  updatedAt,
}: {
  projectId: string;
  saved: FormatConfigData;
  sampleText: string;
  layoutStarted: boolean;
  updatedAt: string;
}) {
  const [data, setData] = useState<FormatConfigData>(saved);

  const usingRealText = sampleText.trim().length > 0;
  const paragraphs = useMemo(() => {
    const text = usingRealText ? sampleText : PLACEHOLDER_TEXT;
    return text
      .split(/\n\n+/)
      .map((p) => p.replace(/^##\s+/, "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 8);
  }, [sampleText, usingRealText]);

  const setTypo = (patch: Partial<FormatConfigData["typography"]>) =>
    setData((d) => ({ ...d, typography: { ...d.typography, ...patch } }));
  const setMargins = (patch: Partial<FormatConfigData["marginsCm"]>) =>
    setData((d) => ({ ...d, marginsCm: { ...d.marginsCm, ...patch } }));
  const setParas = (patch: Partial<FormatConfigData["paragraphs"]>) =>
    setData((d) => ({ ...d, paragraphs: { ...d.paragraphs, ...patch } }));
  const setFolios = (patch: Partial<FormatConfigData["folios"]>) =>
    setData((d) => ({ ...d, folios: { ...d.folios, ...patch } }));
  const setConv = (patch: Partial<FormatConfigData["conventions"]>) =>
    setData((d) => ({ ...d, conventions: { ...d.conventions, ...patch } }));

  const pageSizeChanged = data.pageSize !== saved.pageSize;
  const innerNotLarger = data.marginsCm.inner <= data.marginsCm.outer;
  const activePair =
    TYPEFACE_PAIRS.find(
      (p) =>
        p.body === data.typography.bodyFamily &&
        p.heading === data.typography.headingFamily,
    )?.id ?? "custom";

  function marginField(
    key: keyof FormatConfigData["marginsCm"],
    label: string,
  ) {
    const [lo, hi] = MARGIN_RANGES_CM[key];
    return (
      <div>
        <label htmlFor={`margin-${key}`}>{label} (cm)</label>
        <input
          id={`margin-${key}`}
          type="number"
          step="0.1"
          min="0.5"
          max="5"
          value={data.marginsCm[key]}
          onChange={(e) => setMargins({ [key]: Number(e.target.value) })}
          style={{ width: "6rem" }}
        />
        <span className="muted range-hint">
          proven {lo === hi ? `${lo}` : `${lo}–${hi}`}
        </span>
      </div>
    );
  }

  return (
    <div className="format-wizard">
      {/* Load the two default faces so the preview is truthful when online. */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital@0;1&family=Inter:wght@400;600&display=swap"
      />
      <div className="format-decisions">
        <p className="muted">
          Every choice below ships with the configuration that two finished
          books were actually printed with. If you change nothing, you get
          exactly that proven setup — adjust only what you have a reason to.
        </p>

        {/* 1 · Page size ------------------------------------------------ */}
        <section className="card" data-testid="section-page-size">
          <h2>1 · Page size</h2>
          <p className="muted">
            The physical trim of the printed page. It determines line length,
            page count and printing cost — every other decision sits on top of
            it. <strong>Decide it now, before any layout work:</strong> changing
            it later means re-flowing and re-checking every page.
          </p>
          {layoutStarted && pageSizeChanged && (
            <div className="warning-box" data-testid="page-size-warning">
              <strong>Layout has already begun on this project.</strong>{" "}
              Changing the page size now re-flows the whole book: every page
              break, margin check and chapter opening must be re-iterated and
              re-proofed. The real project that migrated 12 × 18 → A5 paid for
              this with a full extra revision cycle. Only proceed if the
              current size is genuinely wrong.
            </div>
          )}
          <div className="option-grid">
            {PAGE_SIZES.map((p) => (
              <label
                key={p.id}
                className={`option-card${data.pageSize === p.id ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="pageSize"
                  value={p.id}
                  checked={data.pageSize === p.id}
                  onChange={() => setData((d) => ({ ...d, pageSize: p.id }))}
                />
                <span className="option-title">
                  {p.label}
                  {PAGE_SIZE_INFO[p.id].recommended && <Reco>A5</Reco>}
                </span>
                <span className="muted option-blurb">{PAGE_SIZE_INFO[p.id].blurb}</span>
              </label>
            ))}
          </div>
        </section>

        {/* 2 · Typefaces ------------------------------------------------- */}
        <section className="card" data-testid="section-typefaces">
          <h2>2 · Typefaces</h2>
          <p className="muted">
            A book needs two voices: a serif for the body (long-form reading)
            and a contrasting sans for headings and page numbers. Old-style
            numerals (1965, not 1965 in lining caps) sit inside running prose
            without shouting.
          </p>
          <div className="option-grid">
            {TYPEFACE_PAIRS.map((pair) => (
              <label
                key={pair.id}
                className={`option-card${activePair === pair.id ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="typefacePair"
                  value={pair.id}
                  checked={activePair === pair.id}
                  onChange={() => {
                    setTypo({ bodyFamily: pair.body, headingFamily: pair.heading });
                    setFolios({ family: pair.heading });
                  }}
                />
                <span className="option-title" style={{ fontFamily: stack(pair.body) }}>
                  {pair.label}
                  {pair.recommended && <Reco>the proven pair</Reco>}
                </span>
                <span className="muted option-blurb">{pair.blurb}</span>
                <span
                  className="type-sample"
                  style={{ fontFamily: stack(pair.body) }}
                >
                  The quick brown fox, 1878 —{" "}
                  <span style={{ fontFamily: stack(pair.heading), fontWeight: 600 }}>
                    Heading Sample
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="row" style={{ marginTop: "0.6rem" }}>
            <div>
              <label htmlFor="bodySize">Body size (pt)</label>
              <select
                id="bodySize"
                value={String(data.typography.bodySizePt)}
                onChange={(e) => setTypo({ bodySizePt: Number(e.target.value) })}
              >
                {[10, 10.5, 11, 11.5, 12].map((v) => (
                  <option key={v} value={v}>
                    {v}{v === 11 ? " — recommended" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="leading">Leading (pt)</label>
              <select
                id="leading"
                value={String(data.typography.leadingPt)}
                onChange={(e) => setTypo({ leadingPt: Number(e.target.value) })}
              >
                {[13, 13.5, 14, 14.5, 15, 15.5, 16].map((v) => (
                  <option key={v} value={v}>
                    {v}{v === 14.5 ? " — recommended" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="numerals">Numerals</label>
              <select
                id="numerals"
                value={data.typography.numerals}
                onChange={(e) =>
                  setTypo({ numerals: e.target.value as "oldstyle" | "lining" })
                }
              >
                <option value="oldstyle">Old-style — recommended for prose</option>
                <option value="lining">Lining (all full-height)</option>
              </select>
            </div>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            11 pt on 14.5 pt leading is the proven body setting for A5: about
            60–66 characters per line, the comfortable range for sustained
            reading.
          </p>
        </section>

        {/* 3 · Margins ---------------------------------------------------- */}
        <section className="card" data-testid="section-margins">
          <h2>3 · Margins</h2>
          <p className="muted">
            Margins are not wasted paper: they hold the book open, give thumbs
            somewhere to rest, and balance the text block on the page. The
            bottom margin runs deeper than the top so the text block sits
            slightly high — optically centered, and with room for the folio.
          </p>
          <MarginDiagram margins={data.marginsCm} />
          {innerNotLarger && (
            <div className="warning-box" data-testid="margin-warning">
              The inner margin should be <strong>larger</strong> than the outer
              one — the binding will swallow the difference and the inner text
              will look cramped.
            </div>
          )}
          <div className="row" style={{ alignItems: "flex-end" }}>
            {marginField("inner", "Inner / spine")}
            {marginField("outer", "Outer")}
            {marginField("top", "Top")}
            {marginField("bottom", "Bottom")}
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Preloaded with the proven A5 values. Stay inside the proven ranges
            unless your printer specifies otherwise.
          </p>
        </section>

        {/* 4 · Paragraphs -------------------------------------------------- */}
        <section className="card" data-testid="section-paragraphs">
          <h2>4 · Paragraphs: indent or spacing</h2>
          <p className="muted">
            Books mark a new paragraph one of two ways — never both. First-line
            indents keep the text block solid and quiet; blank-line spacing
            breaks it into blocks, like a website.
          </p>
          <div className="option-grid">
            <label
              className={`option-card${data.paragraphs.style === "indent" ? " selected" : ""}`}
            >
              <input
                type="radio"
                name="paragraphStyle"
                value="indent"
                checked={data.paragraphs.style === "indent"}
                onChange={() => setParas({ style: "indent" })}
              />
              <span className="option-title">
                First-line indent
                <Reco>memoir, fiction, narrative</Reco>
              </span>
              <span className="muted option-blurb">
                The book convention for continuous prose. The first paragraph
                after a heading stays flush.
              </span>
              <span className="mini-example serif">
                <span className="mini-line">The letters arrived every month</span>
                <span className="mini-line">for eleven years, in blue envelopes.</span>
                <span className="mini-line indent">Years later I understood that</span>
                <span className="mini-line">the stories were not entirely true.</span>
              </span>
            </label>
            <label
              className={`option-card${data.paragraphs.style === "spaced" ? " selected" : ""}`}
            >
              <input
                type="radio"
                name="paragraphStyle"
                value="spaced"
                checked={data.paragraphs.style === "spaced"}
                onChange={() => setParas({ style: "spaced" })}
              />
              <span className="option-title">Paragraph spacing</span>
              <span className="muted option-blurb">
                Better for technical books, manuals and workbooks, where
                paragraphs are independent units the reader scans.
              </span>
              <span className="mini-example serif">
                <span className="mini-line">The letters arrived every month</span>
                <span className="mini-line">for eleven years, in blue envelopes.</span>
                <span className="mini-line gap">Years later I understood that</span>
                <span className="mini-line">the stories were not entirely true.</span>
              </span>
            </label>
          </div>
        </section>

        {/* 5 · Folios ------------------------------------------------------ */}
        <section className="card" data-testid="section-folios">
          <h2>5 · Page numbers (folios)</h2>
          <p className="muted">
            Folios live where a browsing thumb finds them. The proven setup:
            outer bottom corner, set small in the heading face —{" "}
            {data.folios.family} {data.folios.sizePt} pt
            {data.folios.smallCaps ? ", small caps" : ""}.
          </p>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="grow">
              <label htmlFor="folioPosition">Position</label>
              <select
                id="folioPosition"
                value={data.folios.position}
                onChange={(e) =>
                  setFolios({
                    position: e.target.value as FormatConfigData["folios"]["position"],
                  })
                }
              >
                <option value="outer-bottom">
                  Outer bottom — recommended (easiest to find while flipping)
                </option>
                <option value="center-bottom">Centered bottom</option>
                <option value="outer-top">Outer top</option>
              </select>
            </div>
            <div>
              <label htmlFor="folioSize">Size (pt)</label>
              <select
                id="folioSize"
                value={String(data.folios.sizePt)}
                onChange={(e) => setFolios({ sizePt: Number(e.target.value) })}
              >
                {[8, 8.5, 9, 9.5, 10].map((v) => (
                  <option key={v} value={v}>
                    {v}{v === 9 ? " — recommended" : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={data.folios.smallCaps}
              onChange={(e) => setFolios({ smallCaps: e.target.checked })}
            />{" "}
            Small caps styling (recommended — quieter on the page)
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={data.folios.frontMatterUnnumbered}
              onChange={(e) => setFolios({ frontMatterUnnumbered: e.target.checked })}
            />{" "}
            Front matter unnumbered (recommended — title page, copyright and
            dedication never show folios)
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={data.folios.onChapterOpenings}
              onChange={(e) => setFolios({ onChapterOpenings: e.target.checked })}
            />{" "}
            Folios on chapter openings (the real projects kept them — readers
            land on openings when navigating from the table of contents)
          </label>
        </section>

        {/* 6 · Conventions -------------------------------------------------- */}
        <section className="card" data-testid="section-conventions">
          <h2>6 · Book conventions</h2>
          <p className="muted">
            Invisible rules that make a book feel professionally made. All
            three were kept in the finished books.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={data.conventions.chaptersOpenRecto}
              onChange={(e) => setConv({ chaptersOpenRecto: e.target.checked })}
            />{" "}
            <span>
              <strong>Chapters open on the right-hand page (recto).</strong>{" "}
              Recommended — it is where the eye lands when opening a book, and
              what readers unconsciously expect.
            </span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={data.conventions.technicalBlankPages}
              onChange={(e) => setConv({ technicalBlankPages: e.target.checked })}
            />{" "}
            <span>
              <strong>Allow technical blank pages.</strong> Recommended — when a
              chapter ends on a recto, the following verso stays blank so the
              next chapter can open recto. The blank is intentional, not an
              error.
            </span>
          </label>
          <div style={{ marginTop: "0.6rem" }}>
            <label htmlFor="separatorStyle">Scene / section separators</label>
            <select
              id="separatorStyle"
              value={data.conventions.separatorStyle}
              onChange={(e) =>
                setConv({
                  separatorStyle: e.target.value as "whitespace" | "rule",
                })
              }
            >
              <option value="whitespace">
                White space (2.4 em) — recommended: a quiet pause, no ornament
              </option>
              <option value="rule">A short rule line</option>
            </select>
          </div>
        </section>

        {/* Save ------------------------------------------------------------- */}
        <form action={saveFormatAction} className="card">
          <input type="hidden" name="projectId" value={projectId} />
          <input
            type="hidden"
            name="formatData"
            value={serializeFormatData(data)}
          />
          <div className="row">
            <button type="submit" className="primary" data-testid="save-format">
              Save format
            </button>
            <button type="button" onClick={() => setData(PROVEN_DEFAULTS)}>
              Reset to proven defaults
            </button>
            <span className="muted" suppressHydrationWarning>
              Last saved {new Date(updatedAt).toLocaleString()}
            </span>
          </div>
        </form>
      </div>

      {/* Live preview ---------------------------------------------------- */}
      <div className="format-preview-pane">
        <h2>Sample spread</h2>
        <PagePreview
          data={data}
          paragraphs={paragraphs}
          usingRealText={usingRealText}
        />
      </div>
    </div>
  );
}
