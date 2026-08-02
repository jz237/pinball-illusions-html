/**
 * The shipped SCORE-PANEL ANIMATION documents, their loader and their decoder.
 *
 * Three kinds of assertion, deliberately different in provenance:
 *
 *   1. THE FORMAT PROPERTY THAT PROVED THE DECODE. Every object of every
 *      shipped table decodes with every frame consuming exactly its byte
 *      range — frame 0 raw, then RLE deltas landing exactly on each plane-row
 *      width, the final byte of the final frame being the final packed byte.
 *      This is the property the research round used to establish the format,
 *      re-run here on every test run over all 201 shipped objects.
 *   2. PINNED FACTS FROM THE INDEPENDENT DECODE. Inventory counts, header
 *      fields of known objects, and a frame-0 hash are pinned against the
 *      research tooling's numbers, so a regression in the exporter or the
 *      decoder shows up as a coordinate, not a vibe.
 *   3. THE PARSER AND DECODER REFUSE what they do not fully understand, like
 *      every other loader in this project: the JSON fields are claims about
 *      the packed bytes and any disagreement, truncation or malformed RLE
 *      throws instead of shipping a sheared frame.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  PANEL_HEIGHT,
  PANEL_PLANES,
  PANEL_WIDTH,
  TABLE_PANEL_SCHEMA,
  clearTablePanel,
  decodePanelObjectFrames,
  loadTablePanel,
  panelFrameBytes,
  parseTablePanelDocument,
  registerTablePanel,
  tablePanelFor,
  tablePanelUrl,
} from "../src/game/table-panel.js";
import type { PanelObject, TablePanel, TablePanelDocument } from "../src/game/table-panel.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableId } from "../src/game/contracts.js";
import { modesFor } from "./table-fixtures.js";

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));

function shippedDocument(tableId: TableId): TablePanelDocument {
  return JSON.parse(
    readFileSync(`${TABLES_DIR}${tableId}.panel.json`, "utf8"),
  ) as TablePanelDocument;
}

const parsed = new Map<TableId, TablePanel>();
function panelFor(tableId: TableId): TablePanel {
  let panel = parsed.get(tableId);
  if (panel === undefined) {
    panel = parseTablePanelDocument(shippedDocument(tableId));
    parsed.set(tableId, panel);
  }
  return panel;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("the shipped panel documents", () => {
  it("parse for every table and declare the gated provenance class", () => {
    for (const tableId of TABLE_IDS) {
      const doc = shippedDocument(tableId);
      expect(doc.provenance.sourceClass).toBe("disk-derived-panel-animations");
      expect(doc.provenance.authorizationRequired).toBe(true);
      const panel = panelFor(tableId);
      expect(panel.tableId).toBe(tableId);
    }
  });

  it("carry the decoded inventory: 49 / 64 / 88 objects, blobs on Law 'n Justice only", () => {
    const counts = new Map<TableId, { objects: number; blobs: number; short: number }>([
      // `short` is the count of 15-row objects; every other object is 16 rows.
      ["law-n-justice", { objects: 49, blobs: 2, short: 0 }],
      ["babewatch", { objects: 64, blobs: 0, short: 1 }],
      ["extreme-sports", { objects: 88, blobs: 0, short: 1 }],
    ]);
    for (const tableId of TABLE_IDS) {
      const panel = panelFor(tableId);
      const expected = counts.get(tableId);
      expect(panel.objects.length).toBe(expected?.objects);
      expect(panel.blobs.length).toBe(expected?.blobs);
      expect(panel.objects.filter((object) => object.height === 15).length).toBe(expected?.short);
    }
  });

  it("ship Law 'n Justice's two 48x15 indicator blobs at their heap offsets", () => {
    const blobs = panelFor("law-n-justice").blobs;
    expect(blobs.map((blob) => blob.id)).toEqual(["indicator-pattern", "indicator-mask"]);
    // Pattern at h5+$0, $78 bytes; mask at h5+$78, ending where object 0
    // begins (h5+$B4) — the measured extents.
    expect(blobs[0]?.offset).toBe(0x00);
    expect(blobs[0]?.bytes.length).toBe(0x78);
    expect(blobs[1]?.offset).toBe(0x78);
    expect(blobs[1]?.bytes.length).toBe(0x3c);
    for (const blob of blobs) {
      expect(blob.width).toBe(48);
      expect(blob.height).toBe(15);
    }
  });

  it("decodes EVERY object of every table with every frame consuming exactly its byte range", () => {
    // The exact-consumption property is asserted inside the decoder — a stream
    // not landing on its row width, or the object not ending on its last
    // packed byte, throws. This loop is that property, table-wide.
    for (const tableId of TABLE_IDS) {
      for (const object of panelFor(tableId).objects) {
        const frames = decodePanelObjectFrames(object);
        expect(frames.length).toBe(object.frames);
        for (const frame of frames) {
          expect(frame.length).toBe(panelFrameBytes(object));
        }
      }
    }
  });

  it("carries the objects byte-identical to the heap: pinned packed totals", () => {
    // The sum of packed object bytes equals the slot-5 heap minus the blobs
    // and the measured single-byte alignment pads.
    const totals = new Map<TableId, number>([
      ["law-n-justice", 406291],
      ["babewatch", 364835],
      ["extreme-sports", 502435],
    ]);
    for (const tableId of TABLE_IDS) {
      const total = panelFor(tableId)
        .objects.reduce((sum, object) => sum + object.packed.length, 0);
      expect(total).toBe(totals.get(tableId));
    }
  });

  it("agrees with the independent research decode on pinned objects", () => {
    const panel = panelFor("law-n-justice");
    // Object 0 sits right after the blobs at h5+$B4 = 180: full-width
    // ($A0 field = 40 bytes/row/plane), 16 rows, 28 frames, speed 1.
    const first = panel.objects[0] as PanelObject;
    expect(first.offset).toBe(180);
    expect(first.speed).toBe(1);
    expect(first.width).toBe(0xa0);
    expect(first.bytesPerRow).toBe(40);
    expect(first.pixelWidth).toBe(PANEL_WIDTH);
    expect(first.height).toBe(PANEL_HEIGHT);
    expect(first.frames).toBe(28);
    // Frame 0 raw, hashed: 2 planes x 16 rows x 40 bytes.
    const frames = decodePanelObjectFrames(first);
    expect(frames[0]?.length).toBe(PANEL_PLANES * 16 * 40);
    expect(sha256(frames[0] as Uint8Array)).toBe(
      "22d92f18d37f3b66d0353849479447a4e741d79fa9a39f66819c140acfd26a28",
    );
    // The 79-frame mission sequence — the longest animation on any table.
    const longest = panel.objects.reduce((a, b) => (a.frames >= b.frames ? a : b));
    expect(longest.id).toBe(35);
    expect(longest.frames).toBe(79);
    // The measured speed-divider outliers: BabeWatch's 50, Extreme Sports' 8.
    expect(panelFor("babewatch").objects.some((object) => object.speed === 50)).toBe(true);
    expect(panelFor("extreme-sports").objects.some((object) => object.speed === 8)).toBe(true);
  });

  it("wires the trailer and credits identically on all three tables", () => {
    for (const tableId of TABLE_IDS) {
      const panel = panelFor(tableId);
      // The descriptor +$84 attract/score-trailer record queues four objects,
      // and the one directive site nothing decoded claims — the credits
      // record — names the heap's LAST object, on every table.
      expect(panel.references.trailer.length).toBe(4);
      expect(panel.references.other.length).toBe(1);
      expect(panel.references.other[0]?.object).toBe(panel.objects.length - 1);
    }
  });

  it("keeps every wiring index inside the shipped modes document's pools", () => {
    for (const tableId of TABLE_IDS) {
      const panel = panelFor(tableId);
      const modes = modesFor(tableId);
      for (const wiring of panel.references.elements) {
        expect(wiring.element).toBeLessThan(modes.elements.length);
        expect(wiring.start.length + wiring.award.length).toBeGreaterThan(0);
      }
      for (const wiring of panel.references.messages) {
        expect(wiring.message).toBeLessThan(modes.messages.length);
        expect(wiring.objects.length).toBeGreaterThan(0);
      }
      // Type-1 device animations (+$06) are empty on every shipped table —
      // measured, not assumed. A table where they appear must update this.
      expect(panel.references.devices.length).toBe(0);
    }
  });

  it("decodes a single-frame object as exactly its raw bitmap", () => {
    for (const tableId of TABLE_IDS) {
      const single = panelFor(tableId).objects.find((object) => object.frames === 1);
      expect(single).toBeDefined();
      if (single === undefined) continue;
      expect(single.packed.length).toBe(0x1c + panelFrameBytes(single));
      const frames = decodePanelObjectFrames(single);
      expect(frames.length).toBe(1);
      expect(frames[0]).toEqual(single.packed.slice(0x1c));
    }
  });
});

describe("the parser's and decoder's refusals", () => {
  const base = shippedDocument("law-n-justice");

  it("refuses a wrong schema", () => {
    expect(() =>
      parseTablePanelDocument({ ...base, schema: "pinball-illusions/table-panel/v0" } as never),
    ).toThrow(/schema/);
    expect(TABLE_PANEL_SCHEMA).toBe("pinball-illusions/table-panel/v1");
  });

  it("refuses a non-dense object list", () => {
    const objects = structuredClone(base.objects).slice().reverse();
    expect(() => parseTablePanelDocument({ ...base, objects } as never)).toThrow(/dense/);
  });

  it("refuses a JSON field that disagrees with the packed header", () => {
    const objects = structuredClone(base.objects) as Record<string, unknown>[];
    (objects[0] as Record<string, unknown>)["speed"] = ((objects[0] as { speed: number }).speed % 50) + 1;
    expect(() => parseTablePanelDocument({ ...base, objects } as never)).toThrow(/packed header/);
  });

  it("refuses packed bytes too short for the declared raw frame", () => {
    const objects = structuredClone(base.objects) as Record<string, unknown>[];
    const victim = objects[0] as Record<string, unknown>;
    victim["packed"] = (victim["packed"] as string).slice(0, 64);
    expect(() => parseTablePanelDocument({ ...base, objects } as never)).toThrow(/fewer than/);
  });

  it("refuses out-of-range wiring", () => {
    const panel = panelFor("law-n-justice");
    const references = structuredClone(
      (base as unknown as { references: Record<string, unknown> }).references,
    );
    references["trailer"] = [panel.objects.length];
    expect(() => parseTablePanelDocument({ ...base, references } as never)).toThrow(/trailer/);
  });

  it("throws on a truncated object rather than decoding partially", () => {
    const object = panelFor("law-n-justice").objects[0] as PanelObject;
    const truncated: PanelObject = {
      ...object,
      packed: object.packed.subarray(0, object.packed.length - 1),
    };
    expect(() => decodePanelObjectFrames(truncated)).toThrow(/runs out|truncated|exactly/);
  });

  it("throws on a trailing byte the frames do not consume", () => {
    const object = panelFor("law-n-justice").objects[0] as PanelObject;
    const padded = new Uint8Array(object.packed.length + 1);
    padded.set(object.packed);
    expect(() => decodePanelObjectFrames({ ...object, packed: padded })).toThrow(/exactly/);
  });

  it("throws on an RLE stream that overruns its row", () => {
    const object = panelFor("law-n-justice").objects[0] as PanelObject;
    const corrupt = object.packed.slice();
    // The first delta token of frame 1. A SKIP of 127 overruns the 40-byte row.
    corrupt[0x1c + panelFrameBytes(object)] = 0x7f;
    expect(() => decodePanelObjectFrames({ ...object, packed: corrupt })).toThrow(/produced/);
  });

  it("throws on a literal run of zero bytes", () => {
    const object = panelFor("law-n-justice").objects[0] as PanelObject;
    const corrupt = object.packed.slice();
    corrupt[0x1c + panelFrameBytes(object)] = 0x80;
    expect(() => decodePanelObjectFrames({ ...object, packed: corrupt })).toThrow(/literal run of zero/);
  });
});

describe("the registry and the loader", () => {
  it("registers, answers and clears", () => {
    clearTablePanel();
    expect(tablePanelFor("law-n-justice")).toBeNull();
    const panel = panelFor("law-n-justice");
    registerTablePanel(panel);
    expect(tablePanelFor("law-n-justice")).toBe(panel);
    clearTablePanel();
    expect(tablePanelFor("law-n-justice")).toBeNull();
  });

  it("loads through a fetch and registers the result", async () => {
    clearTablePanel();
    const doc = shippedDocument("babewatch");
    const fetched: string[] = [];
    const loaded: TablePanel = await loadTablePanel("babewatch", (url) => {
      fetched.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(doc),
      });
    });
    expect(fetched).toEqual([tablePanelUrl("babewatch")]);
    expect(loaded.tableId).toBe("babewatch");
    expect(tablePanelFor("babewatch")).toBe(loaded);
    clearTablePanel();
  });

  it("throws on a failed fetch", async () => {
    await expect(
      loadTablePanel("law-n-justice", () =>
        Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: () => Promise.resolve({}),
        }),
      ),
    ).rejects.toThrow(/404/);
  });
});
