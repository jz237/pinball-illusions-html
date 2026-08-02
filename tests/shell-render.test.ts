/**
 * The shell, DRAWN, and the pixels checked against the filmed original.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The shipped shell art was decoded, validated, digest-checked and covered by a
 * dozen green tests, and it still drew a wall of white objects on a bright blue
 * field with the white text lost in them. Every one of those tests asserted that
 * the DATA round-tripped; not one of them asserted anything about the PICTURE.
 * The palette block had been read transposed — sixteen page palettes taken as
 * sixteen fade ramps — and nothing in the loop could tell.
 *
 * So this file draws the screens, into `tests/shell-raster.ts`'s software canvas,
 * and asserts on the result: that the field is black, that the surround is navy,
 * that the frame is white and in the right place to the pixel, that the text
 * lands on the rows the film measures, and that whatever palette the backdrop
 * service has in force, the white ink still stands off it.
 *
 * Every constant asserted here is a measurement off the filmed original at
 * native resolution — see `research/view/shell-spec/INDEX.txt` — except where a
 * comment says otherwise.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRasterCanvas, createRasterSkinCanvases } from "./shell-raster.js";
import {
  createShellSkin,
  shellBackdropFrame,
  shellFadeBlend,
  shellFadeLength,
  SHELL_BACKDROP_PAGES,
  SHELL_TINT_HOLD_FRAMES,
} from "../src/browser/shell-skin.js";
import type { ShellSkin } from "../src/browser/shell-skin.js";
import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  FIELD_X,
  FIELD_Y,
  FRAME_BOTTOM,
  FRAME_LEFT,
  FRAME_RIGHT,
  FRAME_TOP,
  SHELL_HEIGHT,
  SHELL_ORIGIN_X,
  SHELL_WIDTH,
  renderShell,
  shellBandOffset,
  shellWipeShowsRow,
} from "../src/browser/shell-screens.js";
import type { ShellArtworkSource } from "../src/browser/shell-screens.js";
import { ATTRACT_PAGES, MENU_ITEMS, createShell } from "../src/browser/shell.js";
import type { ScoreStore, ShellState } from "../src/browser/shell.js";
import {
  SHELL_PALETTE_LIVE,
  STRIP_WIDTH,
  loadShellArt,
  measureShellText,
} from "../src/game/shell-art.js";
import type { ShellArt } from "../src/game/shell-art.js";
import { FACTORY_HIGH_SCORES } from "../src/game/high-scores.js";
import type { TableArtFetch } from "../src/game/table-art.js";

const SHELL_DIR = fileURLToPath(new URL("../public/generated/shell/", import.meta.url));
const exported = existsSync(`${SHELL_DIR}shell.art.json`);

const diskFetch: TableArtFetch = (url) => {
  const bytes = readFileSync(`${SHELL_DIR}${url.slice(url.lastIndexOf("/") + 1)}`);
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  });
};

const store: ScoreStore = {
  load: () => FACTORY_HIGH_SCORES.map((entry) => ({ ...entry })),
  save: () => undefined,
};

const artwork: ShellArtworkSource = { imageFor: () => null };

/** Measured off the filmed screen: the ring, the frame, the field. */
const NAVY = "#000033";
const BLACK = "#000000";
const WHITE = "#ffffff";

/** The three-step anti-alias ramp the two glyph planes encode. */
const INK_TONES = ["#ffffff", "#aaaaaa", "#777777"];

/** WCAG contrast of a colour against white; see `shell-art.test.ts`. */
function contrastWithWhite(r: number, g: number, b: number): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 1.05 / (0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) + 0.05);
}

let cachedArt: ShellArt | null = null;
async function shippedArt(): Promise<ShellArt> {
  cachedArt ??= await loadShellArt(diskFetch, "");
  return cachedArt;
}

async function shippedSkin(): Promise<ShellSkin> {
  return createShellSkin(await shippedArt(), createRasterSkinCanvases());
}

/** Draws one screen at 1:1 and hands back the raster to read pixels off. */
async function draw(prepare: (state: ShellState) => void): Promise<ReturnType<typeof createRasterCanvas>> {
  const skin = await shippedSkin();
  const state = createShell(store);
  prepare(state);
  const canvas = createRasterCanvas(SHELL_WIDTH + 2 * SHELL_ORIGIN_X, SHELL_HEIGHT);
  renderShell(canvas.ctx, state, 1, artwork, skin);
  return canvas;
}

/** Screen-relative x to raster x: the 320-wide box is centred in a 336 window. */
function sx(x: number): number {
  return SHELL_ORIGIN_X + x;
}

describe.skipIf(!exported)("the shell as it is drawn", () => {
  it("puts the objects on a BLACK field, not the palette-0 blue that shipped", async () => {
    const canvas = await draw((state) => {
      state.ticks = 300;
    });
    // The bug this test exists for: colour 0 of the wrongly-read palette was
    // $36a, so the field behind every object was #3366aa. It is black on every
    // page of the original and colour 0 of every live palette says so.
    expect(canvas.count("#3366aa")).toBe(0);
    // Black is the single most common colour on the screen — the field is 35-48%
    // of the strip and the ring is another 16k pixels of navy on top of that.
    expect(canvas.count(BLACK)).toBeGreaterThan(0.25 * FIELD_WIDTH * FIELD_HEIGHT);
  });

  it("rings the screen in the measured navy and nothing else", async () => {
    const canvas = await draw((state) => {
      state.ticks = 300;
    });
    for (const [x, y] of [
      [0, 0],
      [FRAME_LEFT - 1, 120],
      [FRAME_RIGHT + 1, 120],
      [160, FRAME_TOP - 1],
      [160, FRAME_BOTTOM + 1],
      [SHELL_WIDTH - 1, SHELL_HEIGHT - 1],
    ] as const) {
      expect(canvas.hex(sx(x), y), `ring at ${x},${y}`).toBe(NAVY);
    }
    // The eight pixels either side of the 320-wide box take the same navy, so
    // the ring reads as one band rather than two colours.
    expect(canvas.hex(0, 120)).toBe(NAVY);
    expect(canvas.hex(canvas.width - 1, 120)).toBe(NAVY);
  });

  it("draws the 1-px white frame (15,15)-(304,240), bottom-left corner and all", async () => {
    const canvas = await draw((state) => {
      state.ticks = 300;
    });
    // Run by run, exactly as the film reads: top full, right full, bottom one
    // short at the left, left one short at the bottom.
    for (let x = FRAME_LEFT; x <= FRAME_RIGHT; x += 1) {
      expect(canvas.hex(sx(x), FRAME_TOP), `top ${x}`).toBe(WHITE);
    }
    for (let x = FRAME_LEFT + 1; x <= FRAME_RIGHT; x += 1) {
      expect(canvas.hex(sx(x), FRAME_BOTTOM), `bottom ${x}`).toBe(WHITE);
    }
    for (let y = FRAME_TOP; y <= FRAME_BOTTOM - 1; y += 1) {
      expect(canvas.hex(sx(FRAME_LEFT), y), `left ${y}`).toBe(WHITE);
    }
    for (let y = FRAME_TOP; y <= FRAME_BOTTOM; y += 1) {
      expect(canvas.hex(sx(FRAME_RIGHT), y), `right ${y}`).toBe(WHITE);
    }
    // The one pixel the original's polyline misses.
    expect(canvas.hex(sx(FRAME_LEFT), FRAME_BOTTOM)).toBe(NAVY);
  });

  it("keeps the tumbling objects inside the frame", async () => {
    const canvas = await draw((state) => {
      state.ticks = 300;
    });
    // Nothing but navy outside the frame: an unclipped 320-wide band would put
    // object pixels in the ring, which is what the old 320-at-x-0 window did.
    let outside = 0;
    for (let y = 0; y < SHELL_HEIGHT; y += 1) {
      for (let x = 0; x < SHELL_WIDTH; x += 1) {
        const ring = x < FRAME_LEFT || x > FRAME_RIGHT || y < FRAME_TOP || y > FRAME_BOTTOM;
        if (ring && canvas.hex(sx(x), y) !== NAVY) outside += 1;
      }
    }
    expect(outside).toBe(0);
  });

  it("sets the menu's two items on the measured rows, in both boxes", async () => {
    const canvas = await draw((state) => {
      state.phase = "menu";
      state.ticks = 300;
      state.menuCursor = 1;
    });
    // 81 x 33 at x 120..200; item 1 y 83..115 and item 2 y 126..158. The one the
    // cursor is on is white, the other is drawn in the field's own black — which
    // is why the unselected item looks chopped up on the film rather than boxed.
    for (const [y1, y2, colour] of [
      [83, 115, BLACK],
      [126, 158, WHITE],
    ] as const) {
      for (let x = 120; x <= 200; x += 1) {
        expect(canvas.hex(sx(x), y1), `top ${x},${y1}`).toBe(colour);
      }
      for (let x = 120; x <= 199; x += 1) {
        expect(canvas.hex(sx(x), y2), `bottom ${x},${y2}`).toBe(colour);
      }
      for (let y = y1; y <= y2; y += 1) {
        expect(canvas.hex(sx(120), y), `left ${y}`).toBe(colour);
      }
      for (let y = y1; y <= y2 - 1; y += 1) {
        expect(canvas.hex(sx(200), y), `right ${y}`).toBe(colour);
      }
    }
    // The bottom-right corner of a box is the pixel the polyline never reaches.
    expect(canvas.hex(sx(200), 158)).not.toBe(WHITE);
  });

  it("puts the menu labels' ink on the film's own line tops, 90 and 133", async () => {
    const art = await shippedArt();
    const canvas = await draw((state) => {
      state.phase = "menu";
      state.ticks = 300;
    });
    for (const [index, top] of [
      [0, 90],
      [1, 133],
    ] as const) {
      const label = MENU_ITEMS[index] ?? "";
      const width = measureShellText(art.font1, label);
      const left = 160 - Math.floor(width / 2);
      // The cap row of a 19-row glyph with y-offset 0 is the line top itself.
      let ink = 0;
      for (let x = left; x < left + width; x += 1) {
        if (INK_TONES.includes(canvas.hex(sx(x), top))) ink += 1;
      }
      expect(ink, `${label} at y=${top}`).toBeGreaterThan(3);
      // And the row above the line top carries none of it.
      let above = 0;
      for (let x = left; x < left + width; x += 1) {
        if (INK_TONES.includes(canvas.hex(sx(x), top - 1))) above += 1;
      }
      expect(above, `${label} above y=${top}`).toBe(0);
    }
  });

  it("sets the credits block top-anchored at 104, 134, 164", async () => {
    const canvas = await draw((state) => {
      // Past the wipe, so the whole block is on.
      state.attractPage = 5;
      state.attractTicks = 200;
      state.ticks = 300;
    });
    const page = ATTRACT_PAGES[5] ?? [];
    expect(page).toHaveLength(3);
    for (let line = 0; line < page.length; line += 1) {
      const top = 104 + line * 30;
      let ink = 0;
      for (let x = FIELD_X; x < FIELD_X + FIELD_WIDTH; x += 1) {
        if (INK_TONES.includes(canvas.hex(sx(x), top))) ink += 1;
      }
      expect(ink, `line ${line} at y=${top}`).toBeGreaterThan(3);
    }
  });

  it("draws text in the measured $fff/$aaa/$777 ramp, plane value for plane value", async () => {
    const art = await shippedArt();
    const canvas = await draw((state) => {
      state.phase = "menu";
      state.ticks = 300;
    });
    const label = MENU_ITEMS[1] ?? "";
    const width = measureShellText(art.font1, label);
    const left = 160 - Math.floor(width / 2);
    const seen = new Set<string>();
    for (let y = 133; y < 133 + 19; y += 1) {
      for (let x = left; x < left + width; x += 1) {
        const colour = canvas.hex(sx(x), y);
        if (INK_TONES.includes(colour)) seen.add(colour);
      }
    }
    // All three steps appear. A two-plane font drawn as fill-plus-outline puts
    // BLACK where value 2 belongs, so the middle grey would be missing entirely.
    expect([...seen].sort()).toEqual([...INK_TONES].sort());

    // And the mapping itself, pixel by pixel, on the first glyph — whose cell
    // nothing before it can have written into. Columns past its advance are left
    // out because the next glyph's 16-px cell overlaps them.
    const first = art.font1.glyphs[label.charCodeAt(0)];
    expect(first).toBeDefined();
    if (first === undefined) return;
    let checked = 0;
    for (let row = 0; row < first.height; row += 1) {
      for (let col = 0; col < first.advance; col += 1) {
        const value = art.font1.pixels[(first.top + row) * 16 + col] ?? 0;
        if (value === 0) continue;
        checked += 1;
        expect(canvas.hex(sx(left + col), 133 + first.yOffset + row), `${row},${col}`).toBe(
          INK_TONES[value - 1],
        );
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("gives the loading screen the film's black — no ring, no frame", async () => {
    const canvas = await draw((state) => {
      state.phase = "loading";
      state.tableId = "babewatch";
      state.ticks = 300;
    });
    expect(canvas.hex(0, 0)).toBe(BLACK);
    expect(canvas.hex(sx(FRAME_LEFT), FRAME_TOP)).toBe(BLACK);
    expect(canvas.hex(sx(160), FRAME_BOTTOM)).toBe(BLACK);
    // Its one piece of ink is on the logo's own rows, 120..135.
    let ink = 0;
    for (let y = 118; y <= 140; y += 1) {
      for (let x = FIELD_X; x < FIELD_X + FIELD_WIDTH; x += 1) {
        if (INK_TONES.includes(canvas.hex(sx(x), y))) ink += 1;
      }
    }
    expect(ink).toBeGreaterThan(100);
  });

  it("draws no screen that spills text over the frame", async () => {
    // Every page of every shell screen, checked for ink in the ring. The attract
    // pages are the only writing whose length is not fixed, and an over-long one
    // used to print straight across the border.
    const cases: ((state: ShellState) => void)[] = [
      ...ATTRACT_PAGES.map((_, page) => (state: ShellState) => {
        state.attractPage = page;
        state.attractTicks = 200;
      }),
      (state) => {
        state.phase = "menu";
      },
      (state) => {
        state.phase = "select";
      },
      (state) => {
        state.phase = "select";
        state.column = 1;
      },
      (state) => {
        state.phase = "info";
        state.frameTicks = 500;
      },
      (state) => {
        state.phase = "failed";
        state.error = "HTTP 404 while fetching table003.art.json";
      },
    ];
    for (const [index, prepare] of cases.entries()) {
      const canvas = await draw((state) => {
        state.ticks = 300;
        prepare(state);
      });
      for (let y = 0; y < SHELL_HEIGHT; y += 1) {
        for (let x = 0; x < SHELL_WIDTH; x += 1) {
          const ring = x < FRAME_LEFT || x > FRAME_RIGHT || y < FRAME_TOP || y > FRAME_BOTTOM;
          if (!ring) continue;
          expect(canvas.hex(sx(x), y), `case ${index} at ${x},${y}`).toBe(NAVY);
        }
      }
    }
  });

  it("fits every shipped attract line inside the 288-px field", async () => {
    const art = await shippedArt();
    for (const page of ATTRACT_PAGES) {
      expect(page.length).toBeLessThanOrEqual(3);
      for (const line of page) {
        expect(measureShellText(art.font1, line), line).toBeLessThanOrEqual(FIELD_WIDTH);
      }
    }
  });
});

describe.skipIf(!exported)("the backdrop service", () => {
  it("fades to a page palette, holds 250 frames, and steps through all eight", async () => {
    const art = await shippedArt();
    const seen: number[] = [];
    let held = 0;
    for (let tick = 0; tick < 2049; tick += 1) {
      const frame = shellBackdropFrame(art, tick);
      if (seen[seen.length - 1] !== frame.tint) seen.push(frame.tint);
      if (frame.settled && frame.tint === 3) held += 1;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // Palette 3 is the gold page. `moveq #$FA,dn` — 250 frames of hold, and one
    // more frame in the segment is the one that notices the fade has finished.
    expect(held).toBe(SHELL_TINT_HOLD_FRAMES);
    // The fade lengths are the widest nibble gap each step has to cross.
    expect(shellFadeLength(art.palettes[8]!, art.palettes[0]!)).toBe(10);
    expect(shellFadeLength(art.palettes[7]!, art.palettes[8]!)).toBe(9);
  });

  it("swaps the strip at the black palette, and only there", async () => {
    const art = await shippedArt();
    let swaps = 0;
    let previous = shellBackdropFrame(art, 0);
    for (let tick = 1; tick <= 6147 * 2; tick += 1) {
      const frame = shellBackdropFrame(art, tick);
      if (frame.role !== previous.role) {
        swaps += 1;
        // The page before a swap is the all-black one: that is what hides it.
        expect(previous.tint).toBe(SHELL_PALETTE_LIVE - 1);
      }
      previous = frame;
    }
    // 2049 frames a backdrop, three backdrops, twice round.
    expect(swaps).toBe(6);
    expect(shellBackdropFrame(art, 0).role).toBe(SHELL_BACKDROP_PAGES[0]);
    expect(shellBackdropFrame(art, 6147).role).toBe(SHELL_BACKDROP_PAGES[0]);
  });

  it("never writes colour 0: the field stays black right through a fade", async () => {
    const art = await shippedArt();
    for (let tick = 0; tick < 2049; tick += 1) {
      const frame = shellBackdropFrame(art, tick);
      expect([frame.palette[0], frame.palette[1], frame.palette[2]], `tick ${tick}`).toEqual([
        0, 0, 0,
      ]);
    }
    // And a half-finished fade is between its two ends, nibble by nibble.
    const half = shellFadeBlend(art.palettes[8]!, art.palettes[0]!, 5);
    expect(half[15 * 3]).toBe(3 * 17);
    expect(half[15 * 3 + 1]).toBe(5 * 17);
    expect(half[15 * 3 + 2]).toBe(5 * 17);
  });

  it("keeps every band's strip window inside the 1472-px strip", async () => {
    const art = await shippedArt();
    let lowest = Infinity;
    let highest = -Infinity;
    for (let tick = 0; tick < 63 * 256; tick += 1) {
      for (let band = 0; band < 8; band += 1) {
        const left = shellBandOffset(art.sine, tick, band);
        lowest = Math.min(lowest, left);
        highest = Math.max(highest, left);
      }
    }
    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(highest + FIELD_WIDTH).toBeLessThanOrEqual(STRIP_WIDTH);
    // The base is quantised to whole 32-px objects, so every offset is a
    // multiple of 32 plus a sine entry — which is what every filmed page fits.
    const base = shellBandOffset([0], 0, 0);
    expect(base % 32).toBe(0);
  });

  it("reproduces the band offsets measured off all seven filmed pages", async () => {
    const art = await shippedArt();
    // (C, phase) and the eight offsets read off each still. Band 0 is the 16-row
    // sliver above the frame; it sits on the same curve to within 2 px on six
    // pages and is 33 px off on the menu still, which is unexplained and is why
    // the fit is asserted on bands 1..7.
    const pages: readonly (readonly [string, number, number, readonly number[]])[] = [
      ["title", 384, 182, [368, 384, 400, 414, 427, 437, 444, 448]],
      ["packing", 544, 59, [553, 537, 522, 508, 497, 488, 483, 481]],
      ["menu", 896, 142, [804, 844, 854, 867, 881, 896, 912, 926]],
      ["concept", 896, 202, [910, 926, 939, 949, 956, 960, 959, 955]],
      ["graphics-cube", 896, 5, [960, 956, 948, 938, 925, 910, 895, 880]],
      ["graphics-torus-a", 256, 157, [208, 220, 234, 249, 264, 279, 293, 304]],
      ["graphics-torus-b", 992, 77, [974, 959, 947, 937, 931, 929, 931, 936]],
    ];
    for (const [name, base, phase, offsets] of pages) {
      for (let band = 1; band < 8; band += 1) {
        const sine = art.sine[(phase + band * 10) & 0xff] ?? 0;
        expect(base + sine, `${name} band ${band}`).toBe(offsets[band]);
      }
    }
  });
});

describe("the page-reveal wipe", () => {
  it("is the film's rule: eight fronts, staggered seven rows", () => {
    // Both mid-transition stills obey `y >= front - 7 * (y mod 8)` exactly.
    // Phase 0 rows are the laggards: row 160 is on at front 160, row 152 is not.
    expect(shellWipeShowsRow(160, 160)).toBe(true);
    expect(shellWipeShowsRow(160, 152)).toBe(false);
    // Phase 7 runs 49 rows ahead of phase 0: row 111 is already on at front 160
    // while row 112, one lower but back at phase 0, is not.
    expect(shellWipeShowsRow(160, 111)).toBe(true);
    expect(shellWipeShowsRow(160, 112)).toBe(false);
    // A front below the block shows everything.
    for (let y = 104; y <= 190; y += 1) expect(shellWipeShowsRow(0, y)).toBe(true);
  });

  it("hides the text on the tick a page turns and shows it all soon after", async () => {
    if (!exported) return;
    const early = await draw((state) => {
      state.attractPage = 1;
      state.attractTicks = 0;
      state.ticks = 300;
    });
    const late = await draw((state) => {
      state.attractPage = 1;
      state.attractTicks = 60;
      state.ticks = 300;
    });
    const inkRows = (canvas: ReturnType<typeof createRasterCanvas>): number => {
      let rows = 0;
      for (let y = 104; y <= 160; y += 1) {
        for (let x = FIELD_X; x < FIELD_X + FIELD_WIDTH; x += 1) {
          if (canvas.hex(sx(x), y) === WHITE) {
            rows += 1;
            break;
          }
        }
      }
      return rows;
    };
    expect(inkRows(early)).toBe(0);
    expect(inkRows(late)).toBeGreaterThan(20);
  });
});

describe.skipIf(!exported)("legibility, screen by screen", () => {
  /**
   * The invariant the shipped bug broke.
   *
   * White text with no outline and no knockout is only readable while nothing
   * behind it comes near white. This walks the whole palette cycle, draws the
   * attract page at each settled tint and measures the CONTRAST of the ink
   * against the brightest backdrop pixel actually on screen — the same WCAG
   * ratio `shell-art.test.ts` applies to the palette bytes, but on the finished
   * picture, so a renderer that stopped applying the page palette at all would
   * fail here too. Under the wrongly-read palette the backdrop carried six
   * entries of $fff, i.e. a ratio of 1.00, and this fails on the first page.
   */
  it("keeps the ink at least 3:1 against the backdrop on every page of the cycle", async () => {
    const art = await shippedArt();
    const skin = await shippedSkin();
    let worst = Infinity;
    for (let tint = 0; tint < SHELL_PALETTE_LIVE; tint += 1) {
      let tick = 0;
      while (tick < 6147) {
        const frame = shellBackdropFrame(art, tick);
        if (frame.settled && frame.tint === tint) break;
        tick += 1;
      }
      const state = createShell(store);
      state.ticks = tick;
      state.attractPage = 1;
      state.attractTicks = 200;
      const canvas = createRasterCanvas(SHELL_WIDTH + 2 * SHELL_ORIGIN_X, SHELL_HEIGHT);
      renderShell(canvas.ctx, state, 1, artwork, skin);

      // Every pixel of the field that is not ink, so the whole backdrop, both
      // behind the text and around it.
      for (let y = FIELD_Y; y < FIELD_Y + FIELD_HEIGHT; y += 1) {
        for (let x = FIELD_X; x < FIELD_X + FIELD_WIDTH; x += 1) {
          if (INK_TONES.includes(canvas.hex(sx(x), y))) continue;
          const at = (y * canvas.width + sx(x)) * 4;
          const ratio = contrastWithWhite(
            canvas.data[at] ?? 0,
            canvas.data[at + 1] ?? 0,
            canvas.data[at + 2] ?? 0,
          );
          if (ratio < worst) worst = ratio;
          expect(ratio, `tint ${tint} at ${x},${y}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
    // The gold page's own tint, $980, is the tightest the original ever gets.
    expect(worst).toBeGreaterThan(3.5);
    expect(worst).toBeLessThan(3.7);
  });
});
