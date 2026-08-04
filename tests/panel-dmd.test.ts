/**
 * The score panel AS A DOT MATRIX — the phase-2 renderer, checked against the
 * film's own census rather than against itself.
 *
 * `panel-renderer.test.ts` proves the 320 x 16 raster and `panel-display.test.ts`
 * proves the wiring that feeds it. What is proved HERE is the lattice: that
 * `panel-dmd.ts` turns that raster into the display the machine actually has,
 * and — the part that matters most — that it does so WITHOUT touching the
 * legacy path.
 *
 * The design was settled by counting pixels in session 5's native-resolution
 * stills (`research/hd/phase23/INDEX.txt` section 1). Three of those counts are
 * invariants rather than numbers, and those are the ones reproduced below on
 * this port's own output:
 *
 *   - THE GAP COUNT NEVER MOVES. The film found 30,720 pure-black pixels in the
 *     band in EVERY state, whatever was displayed. The count here is this port's
 *     own (its band is 336 x 16 cells, not the original's 160 x 16 — its raster
 *     has twice the horizontal dot resolution), but the invariant is the film's:
 *     change what the panel says and the gap total must not move by one pixel.
 *   - EVERY DOT IS ALWAYS DRAWN. unlit + lit came to 4 x 2,560 in every still,
 *     so the lattice is visible even where nothing is written. A blank panel
 *     here must still carry a full set of dots, in a colour that is not the gap.
 *   - THERE IS EXACTLY ONE CELL SHAPE, top-left anchored, and never a second.
 *
 * The fourth proof has no counterpart in the film because it is about this
 * port's seam and not the machine's: REGISTRATION. Logical (x, y) must be the
 * dot at (x * cell, y * cell), so no content is lost and nothing is shifted —
 * the defect class that cost the sibling project a table-wide audit.
 */

import { describe, expect, it } from "vitest";

import {
  DMD_GAP,
  DMD_MIN_SCALE,
  dmdBandOffset,
  dmdGeometryFor,
  renderDmdInto,
} from "../src/browser/panel-dmd.js";
import { createPixelTarget } from "../src/browser/playfield-renderer.js";
import type { PixelTarget } from "../src/browser/playfield-renderer.js";
import {
  MOBILE_MAX_RENDER_SCALE,
  canvasFitFor,
  chooseRenderScale,
} from "../src/browser/canvas-fit.js";
import { PANEL_AMBER, PANEL_UNLIT, PANEL_WHITE } from "../src/browser/palette.js";
import type { Rgb } from "../src/browser/palette.js";
import {
  PANEL_HEIGHT,
  PANEL_WIDTH,
  createPanelState,
  renderPanelInto,
} from "../src/browser/panel-renderer.js";
import { FONT_ATLAS_WIDTH, shellFontFrom } from "../src/game/shell-art.js";
import type { ShellFont } from "../src/game/shell-art.js";
import type { IndexedImage } from "../src/game/table-art.js";

/** The view is 336 source pixels wide; the strip, and the original's, are 320. */
const BAND = 336;

function rasterOf(fill: (x: number, y: number) => Rgb): PixelTarget {
  const target = createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT);
  for (let y = 0; y < PANEL_HEIGHT; y += 1) {
    for (let x = 0; x < PANEL_WIDTH; x += 1) {
      const [r, g, b] = fill(x, y);
      const at = (y * PANEL_WIDTH + x) * 4;
      target.data[at] = r;
      target.data[at + 1] = g;
      target.data[at + 2] = b;
      target.data[at + 3] = 255;
    }
  }
  return target;
}

function pixelAt(target: PixelTarget, x: number, y: number): string {
  const at = (y * target.width + x) * 4;
  return `${target.data[at]},${target.data[at + 1]},${target.data[at + 2]}`;
}

function key(colour: Rgb): string {
  return `${colour[0]},${colour[1]},${colour[2]}`;
}

/** How many pixels of each colour the whole band holds. The film's instrument. */
function census(target: PixelTarget): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < target.data.length; i += 4) {
    const at = `${target.data[i]},${target.data[i + 1]},${target.data[i + 2]}`;
    counts.set(at, (counts.get(at) ?? 0) + 1);
  }
  return counts;
}

/** The band for a raster at a magnification, exactly as `panel-display` builds it. */
function bandFor(panel: PixelTarget, scale: number): PixelTarget {
  const geometry = dmdGeometryFor(scale);
  if (geometry === null) throw new Error(`no lattice at scale ${scale}`);
  const target = createPixelTarget(BAND * geometry.cell, PANEL_HEIGHT * geometry.cell);
  return renderDmdInto(panel, target, geometry, BAND, dmdBandOffset(BAND, PANEL_WIDTH));
}

/** A digits-and-comma font, enough for the score view. See panel-display.test. */
function syntheticFont(): ShellFont {
  const metrics: number[][] = Array.from({ length: 256 }, () => [0, 0, 0]);
  metrics[",".charCodeAt(0)] = [3, 8, 0];
  for (const c of "0123456789") metrics[c.charCodeAt(0)] = [6, 8, 0];
  const rows = metrics.reduce((sum, [, height = 0]) => sum + height, 0);
  const atlas: IndexedImage = {
    width: FONT_ATLAS_WIDTH,
    height: rows,
    indices: new Uint8Array(FONT_ATLAS_WIDTH * rows).fill(1),
    palette: new Uint8Array(0),
    paletteEntries: 0,
  };
  return shellFontFrom(metrics, atlas, "synthetic");
}

describe("the lattice appears only where there is room for it", () => {
  it("gives no geometry below DMD_MIN_SCALE, so the legacy path is untouched", () => {
    // This is the whole of the "must not move" guarantee. Scale 1 and 2 are
    // every native build AND every phone, because canvas-fit caps a coarse
    // pointer at 2. If either of these stops returning null the film gate and
    // the mobile build both move.
    expect(DMD_MIN_SCALE).toBe(3);
    expect(dmdGeometryFor(1)).toBeNull();
    expect(dmdGeometryFor(2)).toBeNull();
  });

  it("gives no geometry for a scale that is not a whole number of pixels", () => {
    for (const scale of [0, -1, -4, 2.5, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(dmdGeometryFor(scale)).toBeNull();
    }
  });

  it("is a dot of scale-1 in a cell of scale, with one pixel of gap, at and above 3", () => {
    for (const scale of [3, 4, 5, 6, 8, 12]) {
      expect(dmdGeometryFor(scale)).toEqual({ cell: scale, dot: scale - 1, gap: 1 });
    }
  });

  it("centres the 320-px strip in the 336-px band, eight cells each side", () => {
    expect(dmdBandOffset(BAND, PANEL_WIDTH)).toBe(8);
    expect(dmdBandOffset(PANEL_WIDTH, PANEL_WIDTH)).toBe(0);
  });
});

describe("a phone never gets the lattice, and phase 3 did not change that", () => {
  // `panel-dmd.ts` claims a phone is unaffected "because canvas-fit.ts caps a
  // coarse pointer at MOBILE_MAX_RENDER_SCALE = 2". That is a claim about
  // ANOTHER module, so it is checked against that module here rather than
  // restated. If either constant moves, this fails.
  it("no coarse-pointer render scale ever reaches DMD_MIN_SCALE", () => {
    expect(MOBILE_MAX_RENDER_SCALE).toBeLessThan(DMD_MIN_SCALE);
    for (const dpr of [1, 1.5, 2, 2.625, 3, 4]) {
      for (const width of [320, 360, 375, 390, 412, 430, 768, 1024, 1366]) {
        const scale = chooseRenderScale(width, { devicePixelRatio: dpr, coarsePointer: true });
        expect(dmdGeometryFor(scale)).toBeNull();
      }
    }
  });

  it("the shell's early HD flip does not change a phone's fit at all", () => {
    // Phase 3 flips `hdActive` when the SHELL art lands rather than waiting for
    // a table, which is much earlier. On a coarse pointer the fit was already
    // on the CSS branch, so this must be a no-op — the panel and the touch deck
    // both lay out against the canvas this returns.
    for (const box of [
      { width: 390, height: 844 },
      { width: 360, height: 800 },
      { width: 430, height: 932 },
      { width: 820, height: 1180 },
    ]) {
      for (const dpr of [2, 3]) {
        const before = canvasFitFor(box, { hd: false, coarsePointer: true, devicePixelRatio: dpr });
        const after = canvasFitFor(box, { hd: true, coarsePointer: true, devicePixelRatio: dpr });
        expect(after).toEqual(before);
        // and it still letterboxes inside the box it was given
        expect(after.cssWidth ?? 0).toBeLessThanOrEqual(box.width);
        expect(after.cssHeight ?? 0).toBeLessThanOrEqual(box.height);
      }
    }
  });
});

describe("registration: logical (x, y) is the dot at (x * cell, y * cell)", () => {
  for (const scale of [3, 4, 8]) {
    it(`scale ${scale}: every raster pixel is its own dot, unshifted`, () => {
      // A raster whose every pixel is DIFFERENT, so a shift of even one cell in
      // either axis cannot coincidentally match.
      const panel = rasterOf((x, y) => [(x * 7) % 251, (y * 37) % 251, (x + y * 3) % 251]);
      const band = bandFor(panel, scale);
      const offset = dmdBandOffset(BAND, PANEL_WIDTH);
      const cell = scale;
      for (let y = 0; y < PANEL_HEIGHT; y += 1) {
        for (let x = 0; x < PANEL_WIDTH; x += 1) {
          expect(pixelAt(band, (x + offset) * cell, y * cell)).toBe(pixelAt(panel, x, y));
        }
      }
    });
  }

  it("loses nothing: the top-left pixel of each cell reconstructs the raster exactly", () => {
    const panel = rasterOf((x, y) => [(x * 13) % 256, (y * 61) % 256, (x ^ y) % 256]);
    const band = bandFor(panel, 4);
    const offset = dmdBandOffset(BAND, PANEL_WIDTH);
    const back = createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT);
    for (let y = 0; y < PANEL_HEIGHT; y += 1) {
      for (let x = 0; x < PANEL_WIDTH; x += 1) {
        const from = ((y * 4) * band.width + (x + offset) * 4) * 4;
        const to = (y * PANEL_WIDTH + x) * 4;
        for (let c = 0; c < 4; c += 1) back.data[to + c] = band.data[from + c] ?? 0;
      }
    }
    expect(Array.from(back.data)).toEqual(Array.from(panel.data));
  });
});

describe("the cell shape the film measured, and no second shape", () => {
  it("is one dot anchored top-left, the rest gap, in every cell of the band", () => {
    const panel = rasterOf((x, y) => (((x + y) & 1) === 0 ? PANEL_AMBER : PANEL_UNLIT));
    const scale = 4;
    const band = bandFor(panel, scale);
    const geometry = dmdGeometryFor(scale);
    expect(geometry).not.toBeNull();
    const { cell, dot } = geometry as { cell: number; dot: number };
    const gap = key(DMD_GAP);
    let checked = 0;
    for (let row = 0; row < PANEL_HEIGHT; row += 1) {
      for (let column = 0; column < BAND; column += 1) {
        const ink = pixelAt(band, column * cell, row * cell);
        for (let y = 0; y < cell; y += 1) {
          for (let x = 0; x < cell; x += 1) {
            const lit = y < dot && x < dot;
            expect(pixelAt(band, column * cell + x, row * cell + y)).toBe(lit ? ink : gap);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(BAND * PANEL_HEIGHT * cell * cell);
  });

  it("writes every pixel of the target, so nothing needs clearing first", () => {
    const panel = rasterOf(() => PANEL_AMBER);
    const geometry = dmdGeometryFor(4);
    expect(geometry).not.toBeNull();
    const target = createPixelTarget(BAND * 4, PANEL_HEIGHT * 4);
    // A sentinel no legitimate output can be: if any survives, a pixel was skipped.
    for (let i = 0; i < target.data.length; i += 4) {
      target.data[i] = 7;
      target.data[i + 1] = 9;
      target.data[i + 2] = 11;
    }
    const band = renderDmdInto(
      panel,
      target,
      geometry as { cell: number; dot: number; gap: number },
      BAND,
      dmdBandOffset(BAND, PANEL_WIDTH),
    );
    expect(census(band).get("7,9,11")).toBeUndefined();
    for (let i = 3; i < band.data.length; i += 4) expect(band.data[i]).toBe(255);
  });

  it("refuses a target that is not the exact size of the band", () => {
    const panel = rasterOf(() => PANEL_AMBER);
    const geometry = dmdGeometryFor(4) as { cell: number; dot: number; gap: number };
    const offset = dmdBandOffset(BAND, PANEL_WIDTH);
    for (const [w, h] of [
      [BAND * 4 - 1, PANEL_HEIGHT * 4],
      [BAND * 4, PANEL_HEIGHT * 4 + 1],
      [BAND, PANEL_HEIGHT],
    ]) {
      expect(() =>
        renderDmdInto(panel, createPixelTarget(w as number, h as number), geometry, BAND, offset),
      ).toThrow(RangeError);
    }
  });
});

describe("the film's census, reproduced on this port's own band", () => {
  const scale = 4;
  const cells = BAND * PANEL_HEIGHT;

  it("the gap count NEVER MOVES, whatever the panel says", () => {
    // The film's central finding: 30,720 pure-black pixels in every state. The
    // number here is this port's own band, but the invariant is the film's.
    //
    // Counted BY COLOUR, exactly as the film counted it off a photograph, and
    // over the panel's REAL registers — none of which is pure black, which is
    // precisely what makes a colour census sound on this surface. The blind
    // spot it does have is closed by the positional test below.
    const expected = cells * (scale * scale - (scale - 1) * (scale - 1));
    const states: PixelTarget[] = [
      rasterOf(() => PANEL_UNLIT),
      rasterOf(() => PANEL_AMBER),
      rasterOf((x, y) => (((x + y) & 1) === 0 ? PANEL_WHITE : PANEL_UNLIT)),
      rasterOf((x) => (x < 40 ? PANEL_AMBER : PANEL_UNLIT)),
    ];
    for (const panel of states) {
      expect(census(bandFor(panel, scale)).get(key(DMD_GAP)) ?? 0).toBe(expected);
    }
    expect(expected).toBe(cells * 7);
  });

  it("every gap POSITION is black, even where the raster itself is black", () => {
    // Strictly stronger than the colour census above, and immune to its one
    // blind spot: a raster pixel that is ITSELF (0,0,0) makes a dot no colour
    // census can tell from a gap, so a renderer that wrongly painted a gap
    // could hide behind it. Counted by position, it cannot. This raster does
    // contain pure-black pixels — that is why it is the one used here.
    const panel = rasterOf((x, y) => [(x * 7) % 251, (y * 37) % 251, (x + y * 3) % 251]);
    const band = bandFor(panel, scale);
    let gaps = 0;
    let blackDots = 0;
    for (let row = 0; row < PANEL_HEIGHT; row += 1) {
      for (let column = 0; column < BAND; column += 1) {
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            const inDot = y < scale - 1 && x < scale - 1;
            const at = pixelAt(band, column * scale + x, row * scale + y);
            if (inDot) {
              if (at === key(DMD_GAP)) blackDots += 1;
              continue;
            }
            expect(at).toBe(key(DMD_GAP));
            gaps += 1;
          }
        }
      }
    }
    expect(gaps).toBe(cells * 7);
    // Proves the blind spot is real and this test is the one that sees past it.
    expect(blackDots).toBeGreaterThan(0);
  });

  it("draws all its dots even on a blank panel, so the lattice is always visible", () => {
    const blank = rasterOf(() => PANEL_UNLIT);
    const band = bandFor(blank, scale);
    const counts = census(band);
    // Every cell still carries its dot, and the dot is a dimmed amber and not
    // the gap — the whole point of the measured (68,34,0) unlit register.
    expect(counts.get(key(PANEL_UNLIT))).toBe(cells * (scale - 1) * (scale - 1));
    expect(key(PANEL_UNLIT)).not.toBe(key(DMD_GAP));
    // Exactly two colours on a blank panel: the unlit dot and the gap.
    expect([...counts.keys()].sort()).toEqual([key(DMD_GAP), key(PANEL_UNLIT)].sort());
  });

  it("lit + unlit dots always total one dot per cell, in every state", () => {
    const dots = cells * (scale - 1) * (scale - 1);
    for (const panel of [
      rasterOf(() => PANEL_UNLIT),
      rasterOf((x) => (x < 160 ? PANEL_AMBER : PANEL_UNLIT)),
      rasterOf((x, y) => (((x * y) & 3) === 0 ? PANEL_WHITE : PANEL_UNLIT)),
    ]) {
      const counts = census(bandFor(panel, scale));
      let total = 0;
      for (const [colour, n] of counts) if (colour !== key(DMD_GAP)) total += n;
      expect(total).toBe(dots);
    }
  });

  it("the margins are unlit DOTS, not flat glass, so the band reads as one display", () => {
    const panel = rasterOf(() => PANEL_AMBER);
    const band = bandFor(panel, scale);
    const offset = dmdBandOffset(BAND, PANEL_WIDTH);
    for (const column of [0, 3, offset - 1, offset + PANEL_WIDTH, BAND - 1]) {
      // the dot
      expect(pixelAt(band, column * scale, 0)).toBe(key(PANEL_UNLIT));
      // and its gap, which flat glass would not have
      expect(pixelAt(band, column * scale + scale - 1, 0)).toBe(key(DMD_GAP));
    }
    // the strip itself is lit right up to both its edges
    expect(pixelAt(band, offset * scale, 0)).toBe(key(PANEL_AMBER));
    expect(pixelAt(band, (offset + PANEL_WIDTH - 1) * scale, 0)).toBe(key(PANEL_AMBER));
  });

  it("carries the raster's OWN inks, so palette.ts is not overruled", () => {
    const panel = rasterOf((x) =>
      x < 100 ? PANEL_AMBER : x < 200 ? PANEL_WHITE : PANEL_UNLIT,
    );
    const counts = census(bandFor(panel, scale));
    for (const ink of [PANEL_AMBER, PANEL_WHITE, PANEL_UNLIT]) {
      expect(counts.get(key(ink)) ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("it composes with the real panel renderer", () => {
  it("a genuine score raster keeps every invariant the film measured", () => {
    const panel = createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT);
    renderPanelInto(createPanelState(), 2_375_000, syntheticFont(), panel, null, null);
    const scale = 4;
    const band = bandFor(panel, scale);
    const cells = BAND * PANEL_HEIGHT;
    expect(census(band).get(key(DMD_GAP))).toBe(cells * 7);
    // and the raster still reads back out of the band, unshifted
    const offset = dmdBandOffset(BAND, PANEL_WIDTH);
    for (let x = 0; x < PANEL_WIDTH; x += 17) {
      expect(pixelAt(band, (x + offset) * scale, 8 * scale)).toBe(pixelAt(panel, x, 8));
    }
  });

  it("a changed score moves the dots but not one pixel of the gap", () => {
    const font = syntheticFont();
    const cells = BAND * PANEL_HEIGHT;
    const a = createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT);
    const b = createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT);
    renderPanelInto(createPanelState(), 1_000, font, a, null, null);
    renderPanelInto(createPanelState(), 987_654_321, font, b, null, null);
    const bandA = bandFor(a, 4);
    const bandB = bandFor(b, 4);
    expect(Array.from(bandA.data)).not.toEqual(Array.from(bandB.data));
    expect(census(bandA).get(key(DMD_GAP))).toBe(cells * 7);
    expect(census(bandB).get(key(DMD_GAP))).toBe(cells * 7);
  });
});
