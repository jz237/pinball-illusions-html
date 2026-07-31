import { describe, expect, it } from "vitest";
import {
  BYTES_PER_PIXEL,
  createPixelTarget,
  drawPlayfield,
  integerScaleFor,
  invalidatePlayfieldRaster,
  playfieldBlitGeometry,
  playfieldColourAt,
  playfieldRaster,
  renderPlayfield,
  renderPlayfieldInto,
} from "../src/browser/playfield-renderer.js";
import type { BlitContext } from "../src/browser/playfield-renderer.js";
import {
  DECK_TONES,
  LOWER_EDGE_DIM,
  LOWER_EDGE_LIT,
  RAMP_BODY,
  RAMP_DARK,
  RAMP_LIGHT,
  RAMP_SHADOW_OFFSET_X,
  RAMP_SHADOW_OFFSET_Y,
  RAMP_SHADOW_STRENGTH,
  STRUCTURE_BODY,
  STRUCTURE_DARK,
  STRUCTURE_LIGHT,
  UPPER_RAIL_DIM,
  UPPER_RAIL_LIT,
  shade,
  toHex,
} from "../src/browser/palette.js";
import type { Rgb } from "../src/browser/palette.js";
import { VIEWPORT_HEIGHT } from "../src/browser/camera.js";
import type { CameraState } from "../src/browser/camera.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import type { MaterialIndex, TableMap } from "../src/game/contracts.js";
import { OUT_OF_BOUNDS_MATERIAL } from "../src/game/table-map.js";

/**
 * A hand-painted playfield.
 *
 * Real maps are 200,000 pixels of overlapping layers and prove nothing about
 * *which* rule produced a given colour. These fixtures are full-size — so the
 * dither and the camera see the real geometry — but carry a handful of isolated
 * rectangles, far enough apart that no test pixel is accidentally inside
 * another shape's bevel or drop shadow.
 */
interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly index: MaterialIndex;
}

function buildMap(rects: readonly Rect[]): TableMap {
  const pixels = new Uint8Array(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT);
  for (const rect of rects) {
    for (let y = rect.y0; y <= rect.y1; y += 1) {
      pixels.fill(rect.index, y * PLAYFIELD_WIDTH + rect.x0, y * PLAYFIELD_WIDTH + rect.x1 + 1);
    }
  }
  return {
    tableId: "law-n-justice",
    displayName: "Fixture",
    width: PLAYFIELD_WIDTH,
    height: PLAYFIELD_HEIGHT,
    pixels,
    materialAt(x: number, y: number): MaterialIndex {
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (px < 0 || px >= PLAYFIELD_WIDTH || py < 0 || py >= PLAYFIELD_HEIGHT) {
        return OUT_OF_BOUNDS_MATERIAL;
      }
      return (pixels[py * PLAYFIELD_WIDTH + px] ?? 0) as MaterialIndex;
    },
  };
}

/** Lower-level furniture: a bit-2 body ringed by its bit-0 collision line. */
const BODY: Rect[] = [
  { x0: 40, y0: 100, x1: 70, y1: 140, index: 5 }, // bit 0 + bit 2 — the outline
  { x0: 41, y0: 101, x1: 69, y1: 139, index: 4 }, // bit 2 alone — the fill
];

/** Upper level: a ramp deck with a rail down its left edge. */
const RAMP: Rect[] = [
  { x0: 150, y0: 200, x1: 190, y1: 260, index: 8 }, // bit 3 — the raised deck
  { x0: 150, y0: 200, x1: 150, y1: 260, index: 10 }, // bit 3 + bit 1 — its rail
];

/** The raised deck lying over lower-level furniture and a lower-level wall. */
const OVERPASS: Rect[] = [
  { x0: 240, y0: 400, x1: 280, y1: 440, index: 12 }, // bit 2 + bit 3
  { x0: 250, y0: 410, x1: 270, y1: 420, index: 13 }, // bit 0 + bit 2 + bit 3
];

const FIXTURE = buildMap([...BODY, ...RAMP, ...OVERPASS]);

function colour(map: TableMap, x: number, y: number): Rgb {
  return playfieldColourAt(map, x, y);
}

function isSame(a: Rgb, b: Rgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function isOneOf(value: Rgb, options: readonly Rgb[]): boolean {
  return options.some((option) => isSame(value, option));
}

/** Reads a pixel back out of a rasterised target. */
function pixelAt(target: { width: number; data: Uint8ClampedArray }, x: number, y: number): Rgb {
  const offset = (y * target.width + x) * BYTES_PER_PIXEL;
  return [target.data[offset] ?? 0, target.data[offset + 1] ?? 0, target.data[offset + 2] ?? 0];
}

describe("raster shape", () => {
  it("rasterises exactly one pixel per map pixel", () => {
    const raster = renderPlayfield(FIXTURE);
    expect(raster.width).toBe(PLAYFIELD_WIDTH);
    expect(raster.height).toBe(PLAYFIELD_HEIGHT);
    expect(raster.data.length).toBe(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT * BYTES_PER_PIXEL);
  });

  it("leaves every pixel fully opaque", () => {
    const raster = renderPlayfield(FIXTURE);
    let transparent = 0;
    for (let i = 3; i < raster.data.length; i += BYTES_PER_PIXEL) {
      if (raster.data[i] !== 255) transparent += 1;
    }
    expect(transparent).toBe(0);
  });

  it("refuses a target that is not the map's size, rather than scaling", () => {
    const wrong = createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT - 1);
    expect(() => renderPlayfieldInto(FIXTURE, wrong)).toThrow(/1:1/);
  });

  it("fills the target it was given", () => {
    const target = createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT);
    expect(renderPlayfieldInto(FIXTURE, target)).toBe(target);
    expect(pixelAt(target, 10, 10)).toEqual(colour(FIXTURE, 10, 10));
  });
});

describe("bare playfield", () => {
  it("renders index 0 as a deck tone", () => {
    // (10, 10) is far from every fixture shape, so nothing can be shading it.
    expect(FIXTURE.materialAt(10, 10)).toBe(0);
    expect(isOneOf(colour(FIXTURE, 10, 10), DECK_TONES)).toBe(true);
  });

  it("dithers the deck between exactly two tones and nothing else", () => {
    const empty = buildMap([]);
    const seen = new Set<string>();
    for (let y = 0; y < PLAYFIELD_HEIGHT; y += 7) {
      for (let x = 0; x < PLAYFIELD_WIDTH; x += 5) {
        seen.add(toHex(colour(empty, x, y)));
      }
    }
    expect([...seen].sort()).toEqual([...DECK_TONES].map(toHex).sort());
  });

  it("shades the deck darker toward the top of the table", () => {
    const empty = buildMap([]);
    let topLight = 0;
    let bottomLight = 0;
    for (let x = 0; x < PLAYFIELD_WIDTH; x += 1) {
      if (isSame(colour(empty, x, 5), DECK_TONES[1] ?? [0, 0, 0])) topLight += 1;
      if (isSame(colour(empty, x, PLAYFIELD_HEIGHT - 5), DECK_TONES[1] ?? [0, 0, 0])) bottomLight += 1;
    }
    expect(bottomLight).toBeGreaterThan(topLight);
  });
});

describe("lower-level structure (bit 2)", () => {
  it("renders a bit-2 pixel as furniture, not as background", () => {
    const inside = colour(FIXTURE, 55, 120);
    expect(FIXTURE.materialAt(55, 120)).toBe(4);
    expect(isSame(inside, STRUCTURE_BODY)).toBe(true);
    expect(isOneOf(inside, DECK_TONES)).toBe(false);
  });

  it("bevels the body: lit where it meets open space above, shaded below", () => {
    // Column 55 crosses the fill between the outline rows at y=100 and y=140.
    expect(isSame(colour(FIXTURE, 55, 101), STRUCTURE_LIGHT)).toBe(false);
    const strip = buildMap([{ x0: 100, y0: 300, x1: 120, y1: 320, index: 4 }]);
    expect(isSame(colour(strip, 110, 300), STRUCTURE_LIGHT)).toBe(true);
    expect(isSame(colour(strip, 110, 320), STRUCTURE_DARK)).toBe(true);
    expect(isSame(colour(strip, 110, 310), STRUCTURE_BODY)).toBe(true);
  });
});

describe("lower-level collision line (bit 0)", () => {
  it("renders a bit-0 pixel as an edge colour", () => {
    expect(FIXTURE.materialAt(55, 100)).toBe(5);
    expect(isOneOf(colour(FIXTURE, 55, 100), [LOWER_EDGE_LIT, LOWER_EDGE_DIM])).toBe(true);
  });

  it("lights the top of the outline and dims its underside", () => {
    expect(isSame(colour(FIXTURE, 55, 100), LOWER_EDGE_LIT)).toBe(true);
    expect(isSame(colour(FIXTURE, 55, 140), LOWER_EDGE_DIM)).toBe(true);
  });

  it("draws the edge over the body it rings, never the other way round", () => {
    // Index 5 is bit 0 AND bit 2; the collision line must win.
    const both = buildMap([{ x0: 100, y0: 300, x1: 120, y1: 320, index: 5 }]);
    expect(isOneOf(colour(both, 110, 310), [LOWER_EDGE_LIT, LOWER_EDGE_DIM])).toBe(true);
    expect(isSame(colour(both, 110, 310), STRUCTURE_BODY)).toBe(false);
  });
});

describe("upper level (bits 1 and 3)", () => {
  it("renders the raised deck in its own colours", () => {
    expect(FIXTURE.materialAt(170, 230)).toBe(8);
    expect(isOneOf(colour(FIXTURE, 170, 230), [RAMP_LIGHT, RAMP_BODY, RAMP_DARK])).toBe(true);
    expect(isSame(colour(FIXTURE, 170, 200), RAMP_LIGHT)).toBe(true);
    expect(isSame(colour(FIXTURE, 170, 260), RAMP_DARK)).toBe(true);
  });

  it("renders a bit-1 rail in the upper-level colour, distinct from the lower edge", () => {
    expect(FIXTURE.materialAt(150, 230)).toBe(10);
    expect(isOneOf(colour(FIXTURE, 150, 230), [UPPER_RAIL_LIT, UPPER_RAIL_DIM])).toBe(true);
    expect(isOneOf(colour(FIXTURE, 150, 230), [LOWER_EDGE_LIT, LOWER_EDGE_DIM])).toBe(false);
  });

  it("occludes the lower level, the way the original's ball blitter does", () => {
    // 12 = lower structure under a raised deck; 13 = a lower wall under one.
    expect(FIXTURE.materialAt(245, 430)).toBe(12);
    expect(isOneOf(colour(FIXTURE, 245, 430), [RAMP_LIGHT, RAMP_BODY, RAMP_DARK])).toBe(true);
    expect(FIXTURE.materialAt(260, 415)).toBe(13);
    expect(isOneOf(colour(FIXTURE, 260, 415), [LOWER_EDGE_LIT, LOWER_EDGE_DIM])).toBe(false);
  });

  it("casts an offset shadow onto the deck below, so ramps read as raised", () => {
    // Just past the bottom-right corner of the ramp block, inside the offset.
    const x = 190 + RAMP_SHADOW_OFFSET_X;
    const y = 260 + RAMP_SHADOW_OFFSET_Y;
    expect(FIXTURE.materialAt(x, y)).toBe(0);

    // The same coordinates on an empty table give the unshadowed deck tone.
    // Comparing against a neighbouring pixel instead would compare across the
    // dither and prove nothing.
    const unshadowed = colour(buildMap([]), x, y);
    expect(isOneOf(unshadowed, DECK_TONES)).toBe(true);

    const shadowed = colour(FIXTURE, x, y);
    expect(isOneOf(shadowed, DECK_TONES)).toBe(false);
    expect(isSame(shadowed, shade(unshadowed, RAMP_SHADOW_STRENGTH))).toBe(true);
  });
});

describe("the static cache", () => {
  it("returns the identical raster twice", () => {
    invalidatePlayfieldRaster();
    const first = playfieldRaster(FIXTURE);
    const second = playfieldRaster(FIXTURE);
    expect(second).toBe(first);
  });

  it("rebuilds byte-for-byte identical pixels after invalidation", () => {
    invalidatePlayfieldRaster();
    const before = playfieldRaster(FIXTURE);
    const snapshot = Uint8ClampedArray.from(before.data);
    invalidatePlayfieldRaster(FIXTURE);
    const after = playfieldRaster(FIXTURE);
    expect(after).not.toBe(before);
    expect(after.data).toEqual(snapshot);
  });

  it("does not hand one map's pixels to another", () => {
    invalidatePlayfieldRaster();
    const other = buildMap([{ x0: 0, y0: 0, x1: 335, y1: 599, index: 4 }]);
    expect(playfieldRaster(other)).not.toBe(playfieldRaster(FIXTURE));
    expect(pixelAt(playfieldRaster(other), 10, 10)).not.toEqual(pixelAt(playfieldRaster(FIXTURE), 10, 10));
  });
});

describe("determinism", () => {
  it("renders the same bytes on every run", () => {
    expect(renderPlayfield(FIXTURE).data).toEqual(renderPlayfield(FIXTURE).data);
  });

  it("agrees pixel for pixel with the per-pixel colour function", () => {
    const raster = renderPlayfield(FIXTURE);
    for (const [x, y] of [
      [0, 0],
      [55, 100],
      [55, 120],
      [150, 230],
      [170, 230],
      [245, 430],
      [335, 599],
    ] as const) {
      expect(pixelAt(raster, x, y)).toEqual(colour(FIXTURE, x, y));
    }
  });
});

describe("blitting", () => {
  const scrolling: CameraState = { scrollY: 200, mode: "scrolling" };
  const fullTable: CameraState = { scrollY: 0, mode: "full-table" };

  it("picks the largest whole magnification that fits, never below 1", () => {
    expect(integerScaleFor(PLAYFIELD_WIDTH * 3, VIEWPORT_HEIGHT * 3)).toBe(3);
    expect(integerScaleFor(PLAYFIELD_WIDTH * 3, VIEWPORT_HEIGHT * 2)).toBe(2);
    expect(integerScaleFor(10, 10)).toBe(1);
    expect(Number.isInteger(integerScaleFor(1000, 700))).toBe(true);
  });

  it("reads a viewport-sized window at the camera's scroll position", () => {
    const geometry = playfieldBlitGeometry(FIXTURE, scrolling, 2);
    expect(geometry.sourceY).toBe(200);
    expect(geometry.sourceWidth).toBe(PLAYFIELD_WIDTH);
    expect(geometry.sourceHeight).toBe(VIEWPORT_HEIGHT);
    expect(geometry.destWidth).toBe(PLAYFIELD_WIDTH * 2);
    expect(geometry.destHeight).toBe(VIEWPORT_HEIGHT * 2);
  });

  it("clamps a scroll position that never went through the camera", () => {
    const geometry = playfieldBlitGeometry(FIXTURE, { scrollY: 9999, mode: "scrolling" }, 1);
    expect(geometry.sourceY).toBe(PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT);
  });

  it("shows the whole table in multiball, scaled to the viewport height", () => {
    const geometry = playfieldBlitGeometry(FIXTURE, fullTable, 1);
    expect(geometry.sourceY).toBe(0);
    expect(geometry.sourceHeight).toBe(PLAYFIELD_HEIGHT);
    expect(geometry.destHeight).toBeCloseTo(VIEWPORT_HEIGHT);
    expect(geometry.destWidth).toBeLessThan(PLAYFIELD_WIDTH);
  });

  it("turns smoothing off every frame, because the context is shared", () => {
    let drawn = 0;
    const context: BlitContext = {
      imageSmoothingEnabled: true,
      drawImage(): void {
        drawn += 1;
      },
    };
    // Uploading the raster needs a canvas, which node has not got. The flag is
    // set before the upload is attempted, which is what this asserts.
    expect(() => drawPlayfield(context, FIXTURE, scrolling, 2)).toThrow();
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(drawn).toBe(0);
  });
});
