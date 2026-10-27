import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/lib/db/client";
import {
  legacyFields,
  parseFormatData,
  PROVEN_DEFAULTS,
  serializeFormatData,
} from "@/lib/format/config";
import {
  getFormatConfig,
  insertPdfVersion,
  layoutHasBegun,
  saveFormatConfig,
} from "@/lib/repo/output";
import { createProject } from "@/lib/repo/projects";

let handle: DbHandle;
let projectId: string;

beforeEach(() => {
  handle = openDatabase(":memory:");
  projectId = createProject(handle, { title: "Format test" }).id;
});

describe("format config §7 proven defaults", () => {
  it("a project whose user touches nothing ends with the §7 configuration saved", () => {
    // Opening Stage 7 calls getFormatConfig, which seeds the row. The saved
    // format_config must equal the §7 proven configuration exactly.
    const config = getFormatConfig(handle.db, projectId);
    expect(parseFormatData(config.data)).toEqual(PROVEN_DEFAULTS);

    // §7 spot checks, so a drift in PROVEN_DEFAULTS itself also fails here.
    const data = parseFormatData(config.data);
    expect(data.pageSize).toBe("A5");
    expect(data.typography).toEqual({
      bodyFamily: "EB Garamond",
      bodySizePt: 11,
      leadingPt: 14.5,
      headingFamily: "Inter",
      numerals: "oldstyle",
    });
    expect(data.marginsCm.inner).toBeGreaterThan(data.marginsCm.outer);
    expect(data.marginsCm).toEqual({ inner: 2.3, outer: 1.9, top: 1.6, bottom: 2.4 });
    expect(data.paragraphs.style).toBe("indent");
    expect(data.folios).toMatchObject({
      position: "outer-bottom",
      family: "Inter",
      sizePt: 9,
      smallCaps: true,
      frontMatterUnnumbered: true,
      onChapterOpenings: true,
    });
    expect(data.conventions).toEqual({
      chaptersOpenRecto: true,
      technicalBlankPages: true,
      separatorStyle: "whitespace",
      separatorSpaceEm: 2.4,
    });
  });

  it("keeps the legacy columns in sync for the export executor", () => {
    const config = getFormatConfig(handle.db, projectId);
    expect(config.trimSize).toBe("A5");
    expect(config.fontFamily).toBe("EB Garamond");
    expect(config.fontSizePt).toBe(11);
    expect(config.lineHeight).toBeCloseTo(14.5 / 11, 2);
    expect(JSON.parse(config.margins)).toEqual({
      top: "16mm",
      bottom: "24mm",
      inner: "23mm",
      outer: "19mm",
    });
  });

  it("saves a modified configuration and round-trips it", () => {
    const modified = {
      ...PROVEN_DEFAULTS,
      pageSize: "15x23cm" as const,
      marginsCm: { inner: 2.5, outer: 2.0, top: 1.8, bottom: 2.4 },
    };
    saveFormatConfig(handle.db, projectId, modified);
    const config = getFormatConfig(handle.db, projectId);
    expect(parseFormatData(config.data)).toEqual(modified);
    expect(config.trimSize).toBe("15x23cm");
  });

  it("fills missing or malformed stored data from the defaults", () => {
    expect(parseFormatData("not json")).toEqual(PROVEN_DEFAULTS);
    expect(parseFormatData("{}")).toEqual(PROVEN_DEFAULTS);
    const partial = parseFormatData('{"pageSize":"12x18cm","typography":{"bodySizePt":12}}');
    expect(partial.pageSize).toBe("12x18cm");
    expect(partial.typography.bodySizePt).toBe(12);
    expect(partial.typography.bodyFamily).toBe("EB Garamond");
    expect(partial.marginsCm).toEqual(PROVEN_DEFAULTS.marginsCm);
  });

  it("serialize/parse round-trips the full object", () => {
    expect(parseFormatData(serializeFormatData(PROVEN_DEFAULTS))).toEqual(
      PROVEN_DEFAULTS,
    );
  });

  it("derives legacy fields from any configuration", () => {
    const fields = legacyFields({
      ...PROVEN_DEFAULTS,
      typography: { ...PROVEN_DEFAULTS.typography, bodySizePt: 10, leadingPt: 13 },
    });
    expect(fields.lineHeight).toBe(1.3);
    expect(fields.trimSize).toBe("A5");
  });
});

describe("layoutHasBegun", () => {
  it("is false before any export work exists", () => {
    expect(layoutHasBegun(handle.db, projectId)).toBe(false);
  });

  it("is true once an export version exists", () => {
    insertPdfVersion(handle.db, {
      projectId,
      version: 1,
      filePath: "/tmp/book-v1.html",
    });
    expect(layoutHasBegun(handle.db, projectId)).toBe(true);
  });

  it("is true once an export job exists, even a failed one", () => {
    handle.sqlite
      .prepare(
        `INSERT INTO jobs (id, project_id, stage, type, status, error)
         VALUES ('j1', ?, 8, 'export_book', 'failed', 'x')`,
      )
      .run(projectId);
    expect(layoutHasBegun(handle.db, projectId)).toBe(true);
  });
});
