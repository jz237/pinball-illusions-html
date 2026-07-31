import { describe, expect, it } from "vitest";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import type { MaterialIndex, TableMap, TableMapDocument } from "../src/game/contracts.js";
import { SOLID_BORDER_INDEX, materialTableFor } from "../src/game/materials.js";
import {
  MAX_MATERIAL_INDEX,
  OUT_OF_BOUNDS_MATERIAL,
  TABLE_MAP_SCHEMA,
  loadTableMap,
  materialHistogramOf,
  parseTableMapDocument,
  tableMapUrl,
} from "../src/game/table-map.js";
import type { TableMapFetch, TableMapResponse } from "../src/game/table-map.js";

/**
 * The repo has no @types/node, so a static `import { readFileSync } from
 * "node:fs"` fails `tsc --noEmit`. Holding the specifier in a variable keeps
 * TypeScript out of the resolution while vitest, which runs on node, still
 * loads the real module at runtime.
 */
const NODE_FS = "node:fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: URL, encoding: "utf8") => string;
};

/**
 * Synthetic documents are full size, because the parser is contractually
 * required to reject anything that is not PLAYFIELD_WIDTH x PLAYFIELD_HEIGHT.
 * "Small" here means few runs per row, not few rows.
 */
function fullRow(material = 0): number[] {
  return [PLAYFIELD_WIDTH - 1, material];
}

function makeDocument(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: TABLE_MAP_SCHEMA,
    tableId: "law-n-justice",
    displayName: "Law 'n Justice",
    width: PLAYFIELD_WIDTH,
    height: PLAYFIELD_HEIGHT,
    provenance: {
      sourceClass: "synthetic",
      description: "hand-built fixture",
      authorizationRequired: false,
    },
    materialHistogram: {},
    rows: Array.from({ length: PLAYFIELD_HEIGHT }, () => fullRow(0)),
    ...overrides,
  };
}

/** Replaces one row of an otherwise valid document. */
function documentWithRow(y: number, row: unknown): unknown {
  const rows: unknown[] = Array.from({ length: PLAYFIELD_HEIGHT }, () => fullRow(0));
  rows[y] = row;
  return makeDocument({ rows });
}

/** The parser's declared parameter is typed; these fixtures deliberately are not. */
function parse(doc: unknown): TableMap {
  return parseTableMapDocument(doc as TableMapDocument);
}

describe("parseTableMapDocument, valid documents", () => {
  it("expands a uniform document to one byte per pixel", () => {
    const map = parse(makeDocument());
    expect(map.tableId).toBe("law-n-justice");
    expect(map.displayName).toBe("Law 'n Justice");
    expect(map.width).toBe(PLAYFIELD_WIDTH);
    expect(map.height).toBe(PLAYFIELD_HEIGHT);
    expect(map.pixels).toBeInstanceOf(Uint8Array);
    expect(map.pixels.length).toBe(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT);
    expect(map.pixels.every((value) => value === 0)).toBe(true);
  });

  it("round-trips a multi-run row, honouring inclusive end coordinates", () => {
    // Three runs: x 0..9 = 4, x 10..99 = 5, x 100..335 = 12.
    const map = parse(documentWithRow(7, [9, 4, 99, 5, PLAYFIELD_WIDTH - 1, 12]));
    expect(map.materialAt(0, 7)).toBe(4);
    expect(map.materialAt(9, 7)).toBe(4);
    expect(map.materialAt(10, 7)).toBe(5);
    expect(map.materialAt(99, 7)).toBe(5);
    expect(map.materialAt(100, 7)).toBe(12);
    expect(map.materialAt(PLAYFIELD_WIDTH - 1, 7)).toBe(12);
    // Neighbouring rows must be untouched: a fill that overran by one pixel
    // would corrupt the row above or below and nothing else would notice.
    expect(map.materialAt(0, 6)).toBe(0);
    expect(map.materialAt(PLAYFIELD_WIDTH - 1, 6)).toBe(0);
    expect(map.materialAt(0, 8)).toBe(0);
  });

  it("accepts single-pixel runs at both ends of a row", () => {
    const map = parse(
      documentWithRow(2, [0, 1, PLAYFIELD_WIDTH - 2, 0, PLAYFIELD_WIDTH - 1, 15]),
    );
    expect(map.materialAt(0, 2)).toBe(1);
    expect(map.materialAt(1, 2)).toBe(0);
    expect(map.materialAt(PLAYFIELD_WIDTH - 2, 2)).toBe(0);
    expect(map.materialAt(PLAYFIELD_WIDTH - 1, 2)).toBe(15);
  });

  it("accepts every material index 0..15", () => {
    for (let material = 0; material <= MAX_MATERIAL_INDEX; material += 1) {
      const map = parse(documentWithRow(3, fullRow(material)));
      expect(map.materialAt(200, 3)).toBe(material);
    }
  });

  it("writes each row at its own offset", () => {
    const map = parse(documentWithRow(PLAYFIELD_HEIGHT - 1, fullRow(9)));
    expect(map.pixels[(PLAYFIELD_HEIGHT - 1) * PLAYFIELD_WIDTH]).toBe(9);
    expect(map.pixels[(PLAYFIELD_HEIGHT - 2) * PLAYFIELD_WIDTH]).toBe(0);
    expect(map.materialAt(0, PLAYFIELD_HEIGHT - 1)).toBe(9);
  });
});

describe("parseTableMapDocument, rejected documents", () => {
  it("rejects non-objects", () => {
    expect(() => parse(null)).toThrow(/must be an object/);
    expect(() => parse(undefined)).toThrow(/must be an object/);
    expect(() => parse("not a document")).toThrow(/must be an object/);
  });

  it("rejects a wrong or missing schema", () => {
    expect(() => parse(makeDocument({ schema: "pinball-illusions/table-map/v2" }))).toThrow(
      /schema/,
    );
    expect(() => parse(makeDocument({ schema: undefined }))).toThrow(/schema/);
  });

  it("rejects an unknown tableId", () => {
    expect(() => parse(makeDocument({ tableId: "partyland" }))).toThrow(/unknown tableId/);
    expect(() => parse(makeDocument({ tableId: 3 }))).toThrow(/unknown tableId/);
  });

  it("rejects a missing or empty displayName", () => {
    expect(() => parse(makeDocument({ displayName: "" }))).toThrow(/displayName/);
    expect(() => parse(makeDocument({ displayName: undefined }))).toThrow(/displayName/);
  });

  it("rejects dimensions that are not the playfield's", () => {
    expect(() => parse(makeDocument({ width: PLAYFIELD_WIDTH - 1 }))).toThrow(
      new RegExp(`width .*expected ${PLAYFIELD_WIDTH}`),
    );
    expect(() => parse(makeDocument({ height: PLAYFIELD_HEIGHT + 1 }))).toThrow(
      new RegExp(`height .*expected ${PLAYFIELD_HEIGHT}`),
    );
    // A width that merely stringifies the same is still not the same.
    expect(() => parse(makeDocument({ width: String(PLAYFIELD_WIDTH) }))).toThrow(/width/);
  });

  it("rejects a row count other than exactly the height", () => {
    const short = Array.from({ length: PLAYFIELD_HEIGHT - 1 }, () => fullRow(0));
    expect(() => parse(makeDocument({ rows: short }))).toThrow(
      new RegExp(`${PLAYFIELD_HEIGHT - 1} rows, expected exactly ${PLAYFIELD_HEIGHT}`),
    );
    const long = Array.from({ length: PLAYFIELD_HEIGHT + 1 }, () => fullRow(0));
    expect(() => parse(makeDocument({ rows: long }))).toThrow(/rows, expected exactly/);
    expect(() => parse(makeDocument({ rows: "nope" }))).toThrow(/non-array rows/);
  });

  it("rejects rows that are not arrays of pairs", () => {
    expect(() => parse(documentWithRow(4, "nope"))).toThrow(/row 4 is not an array/);
    expect(() => parse(documentWithRow(4, []))).toThrow(/row 4 is empty/);
    expect(() => parse(documentWithRow(4, [PLAYFIELD_WIDTH - 1]))).toThrow(/must be even/);
    expect(() => parse(documentWithRow(4, [10, 0, PLAYFIELD_WIDTH - 1]))).toThrow(/must be even/);
  });

  it("rejects run ends that do not strictly increase", () => {
    expect(() => parse(documentWithRow(5, [10, 0, 10, 4, PLAYFIELD_WIDTH - 1, 0]))).toThrow(
      /does not advance past/,
    );
    expect(() => parse(documentWithRow(5, [20, 0, 10, 4, PLAYFIELD_WIDTH - 1, 0]))).toThrow(
      /strictly increase/,
    );
    // A leading negative end would otherwise start the row before x=0.
    expect(() => parse(documentWithRow(5, [-1, 0, PLAYFIELD_WIDTH - 1, 0]))).toThrow(
      /does not advance past/,
    );
  });

  it("rejects rows that do not end exactly at width-1", () => {
    expect(() => parse(documentWithRow(6, [PLAYFIELD_WIDTH - 2, 0]))).toThrow(
      new RegExp(`row 6 ends at x=${PLAYFIELD_WIDTH - 2}`),
    );
    expect(() => parse(documentWithRow(6, [PLAYFIELD_WIDTH, 0]))).toThrow(
      new RegExp(`past the last column ${PLAYFIELD_WIDTH - 1}`),
    );
  });

  it("rejects non-integer run ends and materials", () => {
    expect(() => parse(documentWithRow(8, [10.5, 0, PLAYFIELD_WIDTH - 1, 0]))).toThrow(
      /non-integer end_x/,
    );
    expect(() => parse(documentWithRow(8, ["10", 0, PLAYFIELD_WIDTH - 1, 0]))).toThrow(
      /non-integer end_x/,
    );
    expect(() => parse(documentWithRow(8, [10, 1.5, PLAYFIELD_WIDTH - 1, 0]))).toThrow(
      /non-integer material/,
    );
    expect(() => parse(documentWithRow(8, [10, null, PLAYFIELD_WIDTH - 1, 0]))).toThrow(
      /non-integer material/,
    );
    expect(() => parse(documentWithRow(8, [Number.NaN, 0, PLAYFIELD_WIDTH - 1, 0]))).toThrow(
      /non-integer end_x/,
    );
  });

  it("rejects materials outside 0..15, which four bitplanes cannot produce", () => {
    expect(() => parse(documentWithRow(9, fullRow(16)))).toThrow(
      new RegExp(`material 16, outside 0..${MAX_MATERIAL_INDEX}`),
    );
    expect(() => parse(documentWithRow(9, fullRow(-1)))).toThrow(/outside 0\.\./);
  });

  it("names the offending row, so a bad export is traceable", () => {
    expect(() => parse(documentWithRow(123, [PLAYFIELD_WIDTH - 2, 0]))).toThrow(/row 123/);
    expect(() => parse(documentWithRow(123, [PLAYFIELD_WIDTH - 2, 0]))).toThrow(/law-n-justice/);
  });
});

describe("materialAt", () => {
  const map = parse(documentWithRow(0, fullRow(12)));

  it("returns the solid border material outside the bitmap, so no ball escapes", () => {
    const outside: readonly (readonly [number, number])[] = [
      [-1, 0],
      [PLAYFIELD_WIDTH, 0],
      [0, -1],
      [0, PLAYFIELD_HEIGHT],
      [-1, -1],
      [PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT],
      [-100000, 5],
      [5, 100000],
    ];
    for (const [x, y] of outside) {
      expect(map.materialAt(x, y)).toBe(OUT_OF_BOUNDS_MATERIAL);
    }
    expect(OUT_OF_BOUNDS_MATERIAL).toBe(SOLID_BORDER_INDEX);
  });

  it("makes the out-of-bounds material non-passable in the material table", () => {
    // The whole point of the choice: a probe off the edge must deflect the ball.
    const behaviour = materialTableFor("law-n-justice").behaviourFor(map.materialAt(-1, -1));
    expect(behaviour.passable).toBe(false);
  });

  it("treats non-finite coordinates as out of bounds", () => {
    expect(map.materialAt(Number.NaN, 0)).toBe(OUT_OF_BOUNDS_MATERIAL);
    expect(map.materialAt(0, Number.NaN)).toBe(OUT_OF_BOUNDS_MATERIAL);
    expect(map.materialAt(Number.POSITIVE_INFINITY, 0)).toBe(OUT_OF_BOUNDS_MATERIAL);
    expect(map.materialAt(0, Number.NEGATIVE_INFINITY)).toBe(OUT_OF_BOUNDS_MATERIAL);
  });

  it("floors fractional coordinates into the containing pixel", () => {
    expect(map.materialAt(0.0, 0.0)).toBe(12);
    expect(map.materialAt(0.9, 0.9)).toBe(12);
    expect(map.materialAt(0.5, 1.5)).toBe(0);
    // -0.5 floors to -1, which is off the map, not pixel 0.
    expect(map.materialAt(-0.5, 0)).toBe(OUT_OF_BOUNDS_MATERIAL);
  });

  it("agrees with the raw pixel buffer at every corner", () => {
    const corners: readonly (readonly [number, number])[] = [
      [0, 0],
      [PLAYFIELD_WIDTH - 1, 0],
      [0, PLAYFIELD_HEIGHT - 1],
      [PLAYFIELD_WIDTH - 1, PLAYFIELD_HEIGHT - 1],
    ];
    for (const [x, y] of corners) {
      expect(map.materialAt(x, y)).toBe(map.pixels[y * PLAYFIELD_WIDTH + x]);
    }
  });
});

describe("the shipped Law 'n Justice map", () => {
  const documentUrl = new URL("../public/generated/tables/law-n-justice.map.json", import.meta.url);
  const doc = JSON.parse(readFileSync(documentUrl, "utf8")) as TableMapDocument;
  const map = parseTableMapDocument(doc);

  it("parses to exactly one pixel per playfield cell", () => {
    expect(map.pixels.length).toBe(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT);
    expect(map.tableId).toBe("law-n-justice");
    expect(map.displayName).toBe("Law 'n Justice");
    // Dimensions come from the constants, never a repeated literal. An earlier
    // decode shipped a map of a different height and a hard-coded size here
    // agreed with it, which is exactly the kind of check that cannot fail when
    // it matters most.
    expect(doc.width).toBe(PLAYFIELD_WIDTH);
    expect(doc.height).toBe(PLAYFIELD_HEIGHT);
  });

  it("reproduces the document's histogram exactly", () => {
    // The strongest available check on the run encoding: the exporter counted
    // pixels before encoding, so any off-by-one in run expansion shows up here.
    expect(materialHistogramOf(map)).toEqual(doc.materialHistogram);

    const documentTotal = Object.values(doc.materialHistogram).reduce((sum, n) => sum + n, 0);
    expect(documentTotal).toBe(map.pixels.length);
  });

  it("agrees with the document about which indices are absent", () => {
    // Stated as an invariant rather than naming a specific index: which indices
    // a table uses is a property of the decode, and pinning one by number bakes
    // a particular decode into the suite.
    for (let index = 0; index <= MAX_MATERIAL_INDEX; index += 1) {
      const documented = doc.materialHistogram[String(index)] ?? 0;
      const present = map.pixels.some((value) => value === index);
      expect(present).toBe(documented > 0);
    }
  });

  it("keeps every pixel inside 0..15", () => {
    expect(map.pixels.every((value) => value <= MAX_MATERIAL_INDEX)).toBe(true);
  });

  it("expands the first row's runs to their documented boundaries", () => {
    // Checks the run encoding structurally instead of quoting the fixture's
    // bytes: each run must start where the previous ended, both ends must carry
    // the run's material, and the last must close the row exactly.
    const row0 = doc.rows[0];
    expect(row0).toBeDefined();
    const runs = row0 ?? [];
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.length % 2).toBe(0);

    let x = 0;
    let previousEnd = -1;
    for (let i = 0; i < runs.length; i += 2) {
      const end = runs[i] ?? -1;
      const material = runs[i + 1] ?? -1;
      expect(end).toBeGreaterThan(previousEnd);
      expect(material).toBeGreaterThanOrEqual(0);
      expect(material).toBeLessThanOrEqual(MAX_MATERIAL_INDEX);
      expect(map.materialAt(x, 0)).toBe(material as MaterialIndex);
      expect(map.materialAt(end, 0)).toBe(material as MaterialIndex);
      previousEnd = end;
      x = end + 1;
    }
    expect(x).toBe(PLAYFIELD_WIDTH);
  });

  it("expands every row independently of its neighbours", () => {
    // Walk the document again and compare against the buffer. This is the
    // decode restated from the other direction, which catches a shared cursor
    // or a stale row base that a histogram alone could not.
    for (let y = 0; y < PLAYFIELD_HEIGHT; y += 1) {
      const row = doc.rows[y];
      expect(row).toBeDefined();
      const runs = row ?? [];
      let x = 0;
      for (let i = 0; i < runs.length; i += 2) {
        const end = runs[i] ?? -1;
        const material = runs[i + 1] ?? -1;
        expect(map.materialAt(x, y)).toBe(material as MaterialIndex);
        expect(map.materialAt(end, y)).toBe(material as MaterialIndex);
        x = end + 1;
      }
      expect(x).toBe(PLAYFIELD_WIDTH);
    }
  });
});

describe("loadTableMap", () => {
  function respondWith(body: unknown, ok = true, status = 200): TableMapFetch {
    return () =>
      Promise.resolve<TableMapResponse>({
        ok,
        status,
        statusText: ok ? "OK" : "Not Found",
        json: () => Promise.resolve(body),
      });
  }

  it("builds a relative URL under the generated tables directory", () => {
    expect(tableMapUrl("babewatch")).toBe("generated/tables/babewatch.map.json");
    expect(tableMapUrl("extreme-sports", "/assets/")).toBe(
      "/assets/extreme-sports.map.json",
    );
  });

  it("fetches, then delegates to the pure parser", async () => {
    const requested: string[] = [];
    const fetchImpl: TableMapFetch = (url) => {
      requested.push(url);
      return respondWith(makeDocument())(url);
    };
    const map = await loadTableMap("law-n-justice", fetchImpl);
    expect(requested).toEqual(["generated/tables/law-n-justice.map.json"]);
    expect(map.pixels.length).toBe(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT);
  });

  it("reports the URL and status when the fetch fails", async () => {
    await expect(loadTableMap("babewatch", respondWith(null, false, 404))).rejects.toThrow(
      /generated\/tables\/babewatch\.map\.json: HTTP 404 Not Found/,
    );
  });

  it("propagates validation errors from a corrupt document", async () => {
    const corrupt = makeDocument({ rows: [] });
    await expect(loadTableMap("law-n-justice", respondWith(corrupt))).rejects.toThrow(
      /rows, expected exactly/,
    );
  });
});
