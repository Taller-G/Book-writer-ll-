import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import { PROVEN_DEFAULTS } from "@/lib/format/config";
import {
  estimatePageCount,
  getPaperStock,
  isSpineConfirmed,
  spineWidthMm,
  wordsPerPage,
} from "@/lib/cover/spine";
import {
  BLEED_MM,
  checkUploadFit,
  readPngDimensions,
  spreadDims,
} from "@/lib/cover/spread";
import { setAiFactoryForTests } from "@/lib/jobs/executors";
import { enqueueAndRun, runJob } from "@/lib/jobs/runner";
import { createJob } from "@/lib/repo/jobs";
import {
  addIteration,
  confirmSpine,
  getSpine,
  listBackCover,
  listConcepts,
  listIterations,
  listTitleOptions,
  setConceptStatus,
} from "@/lib/repo/covers";
import { insertText } from "@/lib/repo/texts";
import { FakeAiClient, seedProseProject, PASS_A } from "./helpers/fakeAi";

function words(n: number): string {
  return Array.from({ length: n }, () => "palabra").join(" ");
}

// A book whose FINAL text carries a recognizable line, so the back-cover quote
// can be checked against the book's actual content.
const FINAL_TEXT = [
  "## Prólogo",
  "Cuando era chico vivíamos en una casa con patio y limonero, y la luz entraba por la mañana.",
  "Mi abuela decía siempre que lo importante es la mesa compartida, y con los años entendí que tenía razón.",
  "En el trabajo aprendí que nadie construye solo nada que de verdad dure en el tiempo.",
].join("\n\n");

function coverResponder(req: { system: { instructions: string } }): string {
  const ins = req.system.instructions;
  if (ins.includes("between 2 and 4 distinct cover CONCEPTS")) {
    return JSON.stringify({
      concepts: [
        { approach: "minimalist", title: "La mesa compartida", subtitle: "memorias", tagline: "una vida hablada", rationale: "Tipográfico y sobrio.", palette: ["#102030", "#c0a060"], imagery: "" },
        { approach: "image", title: "La mesa compartida", subtitle: "", tagline: "", rationale: "Imagen evocadora.", palette: ["#204030"], imagery: "un limonero al sol" },
        { approach: "author_photo", title: "La mesa compartida", subtitle: "", tagline: "", rationale: "El rostro del autor.", palette: [], imagery: "retrato del autor" },
      ],
      titleOptions: [
        { label: "A", title: "La mesa compartida", subtitle: "", tagline: "", rationale: "Directo." },
        { label: "B", title: "El limonero", subtitle: "", tagline: "", rationale: "Evocador." },
        { label: "C", title: "La vida hablada", subtitle: "memorias", tagline: "", rationale: "Literal." },
      ],
    });
  }
  if (ins.includes("Propose ONE fresh cover concept")) {
    return JSON.stringify({ approach: "image", title: "TÍTULO REGENERADO", subtitle: "", tagline: "", rationale: "Otra dirección.", palette: ["#000000"], imagery: "otra imagen" });
  }
  if (ins.includes("writing the back cover")) {
    return JSON.stringify({
      blurb: "Un libro sobre volver a casa.\n\nLo que se pierde y lo que vuelve.",
      quote: "lo importante es la mesa compartida",
      bio: "El autor nació en el sur y escribe desde entonces.",
    });
  }
  // iteration agent
  return "Sugiero agrandar el título y moverlo hacia arriba.";
}

let handle: DbHandle;
let projectId: string;

afterEach(() => setAiFactoryForTests());

function seedCoverProject(): void {
  handle = openDatabase(":memory:");
  projectId = seedProseProject(handle, PASS_A);
  insertText(handle.db, {
    projectId,
    stageKey: "final",
    version: 1,
    content: FINAL_TEXT,
  });
}

describe("spine estimation", () => {
  it("rounds the page estimate up to a multiple of 4 and grows with the text", () => {
    const small = estimatePageCount(words(1000), PROVEN_DEFAULTS);
    const big = estimatePageCount(words(40000), PROVEN_DEFAULTS);
    expect(small % 4).toBe(0);
    expect(big % 4).toBe(0);
    expect(big).toBeGreaterThan(small);
    expect(estimatePageCount("", PROVEN_DEFAULTS)).toBe(0);
  });

  it("recomputes when the book's page count changes", () => {
    const wpp = wordsPerPage(PROVEN_DEFAULTS);
    expect(wpp).toBeGreaterThan(100);
    const before = estimatePageCount(words(20000), PROVEN_DEFAULTS);
    const after = estimatePageCount(words(30000), PROVEN_DEFAULTS);
    expect(after).toBeGreaterThan(before);
  });

  it("derives spine width from page count × paper caliper", () => {
    const stock = getPaperStock("offset_90_cream");
    // 200 pages = 100 leaves × 0.125 mm = 12.5 mm.
    expect(spineWidthMm(200, stock)).toBeCloseTo(12.5, 5);
    // Thicker stock → wider spine for the same page count.
    expect(spineWidthMm(200, getPaperStock("offset_120_white"))).toBeGreaterThan(
      spineWidthMm(200, stock),
    );
  });

  it("only treats the spine as confirmed for the page count it was confirmed at", () => {
    const pages = estimatePageCount(words(20000), PROVEN_DEFAULTS);
    // Unconfirmed → always to-be-confirmed.
    expect(isSpineConfirmed({ confirmed: 0, confirmedPageCount: null }, pages)).toBe(
      false,
    );
    // Confirmed at the current count → confirmed.
    expect(
      isSpineConfirmed({ confirmed: 1, confirmedPageCount: pages }, pages),
    ).toBe(true);
    // Page count changed since confirmation → re-raises the flag.
    expect(
      isSpineConfirmed({ confirmed: 1, confirmedPageCount: pages }, pages + 4),
    ).toBe(false);
  });
});

describe("cover spread geometry", () => {
  it("adds bleed on every side and a spine between the two covers", () => {
    const spread = spreadDims(PROVEN_DEFAULTS, 12.5);
    // A5 = 148 × 210 mm. Width = 148 + 12.5 + 148 + 2×3 bleed = 314.5 mm.
    expect(spread.totalWidthMm).toBeCloseTo(314.5, 5);
    expect(spread.totalHeightMm).toBeCloseTo(210 + BLEED_MM * 2, 5);
    // 314.5 mm @ 300 DPI = 3715 px (rounded).
    expect(spread.totalWidthPx).toBe(Math.round((314.5 / 25.4) * 300));
  });

  it("reads PNG pixel dimensions from the IHDR chunk", () => {
    // Minimal 1200×800 PNG header (signature + IHDR length/type/width/height).
    const buf = Buffer.alloc(24);
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    buf.write("IHDR", 12, "ascii");
    buf.writeUInt32BE(1200, 16);
    buf.writeUInt32BE(800, 20);
    expect(readPngDimensions(buf)).toEqual({ width: 1200, height: 800 });
    expect(readPngDimensions(Buffer.from("not a png"))).toBeNull();
  });

  it("accepts an upload at the target spread dimensions and rejects a mismatch", () => {
    const spread = spreadDims(PROVEN_DEFAULTS, 12.5);
    const exact = checkUploadFit(
      { width: spread.totalWidthPx, height: spread.totalHeightPx },
      spread,
    );
    expect(exact.ok).toBe(true);
    expect(exact.targetWidthPx).toBe(spread.totalWidthPx);

    // Wrong aspect ratio (a square) is flagged.
    const wrong = checkUploadFit({ width: 2000, height: 2000 }, spread);
    expect(wrong.ok).toBe(false);
    expect(wrong.reasons.join(" ")).toMatch(/aspect ratio/i);

    // Right shape but too few pixels → low DPI is flagged.
    const lowRes = checkUploadFit(
      {
        width: Math.round(spread.totalWidthPx / 2),
        height: Math.round(spread.totalHeightPx / 2),
      },
      spread,
    );
    expect(lowRes.ok).toBe(false);
    expect(lowRes.reasons.join(" ")).toMatch(/DPI/i);
  });
});

describe("spine confirmation through the repo", () => {
  it("stays to-be-confirmed until confirmed, and re-raises when the page count changes", () => {
    handle = openDatabase(":memory:");
    projectId = seedProseProject(handle, PASS_A);
    insertText(handle.db, { projectId, stageKey: "final", version: 1, content: words(20000) });
    const { db } = handle;

    const pages1 = estimatePageCount(words(20000), PROVEN_DEFAULTS);
    // Fresh spine row: not confirmed.
    expect(isSpineConfirmed(getSpine(db, projectId), pages1)).toBe(false);

    confirmSpine(db, projectId, pages1);
    expect(isSpineConfirmed(getSpine(db, projectId), pages1)).toBe(true);

    // The book grows → the page count changes → the flag comes back.
    const pages2 = estimatePageCount(words(40000), PROVEN_DEFAULTS);
    expect(pages2).not.toBe(pages1);
    expect(isSpineConfirmed(getSpine(db, projectId), pages2)).toBe(false);
  });
});

describe("cover AI jobs", () => {
  it("proposes concepts and A/B/C titles, each kept/discarded/regenerated independently", async () => {
    seedCoverProject();
    setAiFactoryForTests(() => new FakeAiClient(coverResponder));

    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 7,
      type: "propose_cover_concepts",
    });
    expect(job.status).toBe("succeeded");

    let concepts = listConcepts(handle.db, projectId);
    expect(concepts.map((c) => c.approach).sort()).toEqual([
      "author_photo",
      "image",
      "minimalist",
    ]);
    expect(listTitleOptions(handle.db, projectId)).toHaveLength(3);

    // Discard one concept — the others are untouched.
    const image = concepts.find((c) => c.approach === "image")!;
    setConceptStatus(handle.db, projectId, image.id, "discarded");
    concepts = listConcepts(handle.db, projectId);
    expect(concepts.find((c) => c.approach === "image")!.status).toBe("discarded");
    expect(concepts.find((c) => c.approach === "minimalist")!.status).toBe("proposed");

    // Regenerate a different concept — only it changes; the discarded one stays discarded.
    const minimal = concepts.find((c) => c.approach === "minimalist")!;
    const regenJob = createJob(handle.db, {
      projectId,
      stage: 7,
      type: "regenerate_cover_concept",
      params: { conceptId: minimal.id },
    });
    const done = await runJob(handle, regenJob.id);
    expect(done.status).toBe("succeeded");

    concepts = listConcepts(handle.db, projectId);
    const regenerated = concepts.find((c) => c.id === minimal.id)!;
    expect(regenerated.title).toBe("TÍTULO REGENERADO");
    expect(regenerated.status).toBe("proposed");
    // The discarded concept was not resurrected or altered.
    expect(concepts.find((c) => c.approach === "image")!.status).toBe("discarded");
    // The author_photo concept kept its original title.
    expect(concepts.find((c) => c.approach === "author_photo")!.title).toBe(
      "La mesa compartida",
    );
  });

  it("drafts the back-cover blurb and quote from the book's actual content", async () => {
    seedCoverProject();
    const fake = new FakeAiClient(coverResponder);
    setAiFactoryForTests(() => fake);

    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 7,
      type: "draft_back_cover",
    });
    expect(job.status).toBe("succeeded");

    // The call was grounded in the FINAL text itself (not generic).
    const material = fake.requests[0].messages[0].content;
    expect(material).toContain("limonero");

    const sections = listBackCover(handle.db, projectId);
    const quote = sections.find((s) => s.sectionKey === "quote")!;
    const blurb = sections.find((s) => s.sectionKey === "blurb")!;
    expect(blurb.content.length).toBeGreaterThan(0);
    // The quote is a verbatim line from the book's FINAL text.
    expect(FINAL_TEXT.toLowerCase()).toContain(quote.content.toLowerCase());
  });

  it("falls back to a real sentence when the model's quote is not in the book", async () => {
    seedCoverProject();
    setAiFactoryForTests(
      () =>
        new FakeAiClient((req) => {
          if (req.system.instructions.includes("writing the back cover")) {
            return JSON.stringify({
              blurb: "Dos párrafos.\n\nSegundo.",
              quote: "una frase totalmente inventada que no está en el libro",
              bio: "El autor.",
            });
          }
          return coverResponder(req);
        }),
    );

    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 7,
      type: "draft_back_cover",
    });
    expect(job.status).toBe("succeeded");
    const quote = listBackCover(handle.db, projectId).find(
      (s) => s.sectionKey === "quote",
    )!;
    // Even on a hallucinated quote, the stored quote is the book's own words.
    expect(FINAL_TEXT.toLowerCase()).toContain(quote.content.toLowerCase());
  });

  it("delivers a cover annotation, with its marked region, to the agent", async () => {
    seedCoverProject();
    const fake = new FakeAiClient(coverResponder);
    setAiFactoryForTests(() => fake);

    addIteration(handle.db, {
      projectId,
      target: "front",
      region: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
      note: "make the title bigger here",
    });
    const job = await enqueueAndRun(handle, {
      projectId,
      stage: 7,
      type: "iterate_cover",
    });
    expect(job.status).toBe("succeeded");

    // The agent received the user's note AND the marked region coordinates.
    const sent = fake.requests[0].messages[0].content;
    expect(sent).toContain("make the title bigger here");
    expect(sent).toMatch(/x=0\.10/);
    expect(sent).toMatch(/width=0\.50/);

    // The reply is recorded against the annotation.
    const [iteration] = listIterations(handle.db, projectId);
    expect(iteration.response).toMatch(/agrandar el título/);
  });
});
