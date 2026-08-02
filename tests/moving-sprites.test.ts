/**
 * THE BALL SPRITE, AND THE PIXEL GRID.
 *
 * The assertions that matter most, in order:
 *
 *   1. THE BALL IS THE DISK'S BALL. Per table: the sha256 of the 544 source
 *      bytes, a digest over the 289 decoded palette indices, the 17x17 size, the
 *      221-pixel disc and the exact set of palette indices it uses. A ball that
 *      quietly stopped being pixel art would change every one of those.
 *   2. IT IS SEVENTEEN, WITH A TRUE CENTRE PIXEL, and the reconstruction's
 *      centre-based position maps onto the original's top-left one: the sprite's
 *      top-left is `q10ToPixel(centre) - 8` and the ball drawn at a given centre
 *      covers exactly the 221 disc pixels around it.
 *   3. THE PIXEL GRID. Every pixel of a rendered frame — artwork, lamps, bats
 *      and ball — must be a uniform SxS block at integer magnification S. The
 *      filmed original scores ZERO non-uniform blocks over the 327x228
 *      comparison window at 2x; the reconstruction scored 599 / 559 / 621 when
 *      the bats and the ball were canvas vector calls, and the connected
 *      components of the failures were exactly those three things. This file
 *      asserts zero, at S = 1..4, over the same window, on all three tables —
 *      and asserts that the checker itself can fail, so a green result means
 *      something.
 *   4. NOTHING IS BLENDED. Every drawn sprite pixel must be an exact entry of
 *      the table's own artwork palette. An anti-aliased edge produces colours
 *      that are in no palette entry at all, so this catches the defect directly
 *      rather than through its symptom.
 *   5. DRAWING DOES NOT MOVE THE SIMULATION. Two identical games, one
 *      compositing sprites every tick and one never touching them, agree to the
 *      last tick.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BALL_MASK_PIXELS,
  BALL_SPRITE_SIZE,
  STRUCTURE_BIT_BY_LEVEL,
  TABLE_BALL_SCHEMA,
  clearTableBalls,
  loadTableBall,
  parseTableBallDocument,
  registerTableBall,
  tableBallFor,
} from "../src/game/table-ball.js";
import type { TableBall } from "../src/game/table-ball.js";
import {
  FALLBACK_BAT_BOX,
  FALLBACK_MARKER,
  buildMovingSprites,
  compositeMovingSprites,
  mapStructureOccluder,
  movingSpritePlacements,
} from "../src/game/moving-sprites.js";
import { compositeMovingSpriteFrame } from "../src/browser/sprite-layer.js";
import { decodeIndexedPng, tableArtFrom } from "../src/game/table-art.js";
import type { TableArt } from "../src/game/table-art.js";
import {
  createPixelTarget,
  renderPlayfieldInto,
} from "../src/browser/playfield-renderer.js";
import type { PixelTarget } from "../src/browser/playfield-renderer.js";
import { buildLampSprites, compositeLampOverlays, lampModes } from "../src/game/lamp-overlays.js";
import { BALL_RADIUS_PIXELS } from "../src/game/collision-probe.js";
import { pixelsToQ10, q10ToPixel } from "../src/core/fixed-point.js";
import { flipperConfigsFor } from "../src/game/flippers.js";
import type { FlipperConfig } from "../src/game/flippers.js";
import { SERVE_FRAMING_SCROLL, VIEWPORT_HEIGHT } from "../src/browser/camera.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlSnapshot } from "../src/browser/input.js";

/** One table's flipper configuration, by id. */
function configFor(tableId: TableId, id: string): FlipperConfig {
  const config = flipperConfigsFor(tableId).find((entry) => entry.id === id);
  if (config === undefined) throw new Error(`${tableId} configures no flipper "${id}"`);
  return config;
}
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableBallDocument, TableId, TableMap } from "../src/game/contracts.js";
import { ballFor, flipperBatsFixture, lampsFor, mapFor } from "./table-fixtures.js";
import {
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { IDLE_SNAPSHOT } from "../src/browser/input.js";

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));
const bats = flipperBatsFixture();

const artCache = new Map<TableId, Promise<TableArt>>();
function artFor(tableId: TableId): Promise<TableArt> {
  let cached = artCache.get(tableId);
  if (cached === undefined) {
    const bytes = readFileSync(`${TABLES_DIR}${tableId}.art.png`);
    cached = decodeIndexedPng(new Uint8Array(bytes)).then((image) => tableArtFrom(tableId, image));
    artCache.set(tableId, cached);
  }
  return cached;
}

/** MEASURED, per table: where the sprite is and what it decodes to. */
const BALLS: Record<TableId, { offset: number; source: string; pixels: string; indices: number }> = {
  "law-n-justice": {
    offset: 54936,
    source: "5a08c2b67f21a2b5846e17d7447984b3687091bd83cfebc0a7879c304c2eb030",
    pixels: "650d501088079c581b13c1c1e9d3773e98440ce3fdd80d364382dd644fb78ca8",
    indices: 32,
  },
  babewatch: {
    offset: 41560,
    source: "4a976a40fc788886263b482dc53df568653d0473a6a341b25ce3092be57b1101",
    pixels: "bf354a4a395712732821f3930de1a311b7e4a19b5d772060e03724f89413d2be",
    indices: 34,
  },
  "extreme-sports": {
    offset: 33936,
    source: "a0451c6c9c8b4f8551bf8047eb78fb5b45a75045644d31fe8bc6e4554b27c3e2",
    pixels: "3cca0ad6ea30f318a0f78dd76f624c202785dd8a3c30ae3e9306eb35bb5ace9f",
    indices: 19,
  },
};

/** MEASURED: main.bin's disc, row by row. */
const DISC_WIDTHS = [5, 9, 11, 13, 15, 15, 17, 17, 17, 17, 17, 15, 15, 13, 11, 9, 5];

/** The comparison window: playfield rows 370..597, columns 0..326. */
const WINDOW = { x: 0, y: 370, width: 327, height: 228 };

// ---------------------------------------------------------------------------
// The ball document
// ---------------------------------------------------------------------------

describe("the shipped ball sprite", () => {
  it("is the disk's raster, byte for byte, on every table", () => {
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const ball = ballFor(tableId);
      const want = BALLS[tableId];
      expect([tableId, ball.sourceSha256]).toEqual([tableId, want.source]);
      expect([tableId, createHash("sha256").update(ball.pixels).digest("hex")]).toEqual([
        tableId,
        want.pixels,
      ]);
      expect([tableId, ball.indicesUsed.length]).toEqual([tableId, want.indices]);
      expect(ball.indicesUsed).not.toContain(0);
    }
  });

  it("is seventeen square, with a true centre pixel", () => {
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const ball = ballFor(tableId);
      expect([ball.width, ball.height]).toEqual([BALL_SPRITE_SIZE, BALL_SPRITE_SIZE]);
      // A 16-wide ball would be half a pixel out on one side and could not be
      // pixel-exact. 17 puts the centre on a pixel, and that pixel is 8,8 —
      // which is exactly the reconstruction's own BALL_RADIUS_PIXELS.
      expect(BALL_SPRITE_SIZE % 2).toBe(1);
      expect([ball.centreX, ball.centreY]).toEqual([BALL_RADIUS_PIXELS, BALL_RADIUS_PIXELS]);
    }
  });

  it("draws exactly main.bin's 221-pixel disc and nothing outside it", () => {
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const ball = ballFor(tableId);
      expect(ball.maskPixels).toBe(BALL_MASK_PIXELS);
      const widths: number[] = [];
      let drawn = 0;
      for (let y = 0; y < ball.height; y += 1) {
        let row = 0;
        for (let x = 0; x < ball.width; x += 1) {
          if ((ball.pixels[y * ball.width + x] ?? 0) !== 0) {
            row += 1;
            drawn += 1;
          }
        }
        widths.push(row);
      }
      expect(widths).toEqual(DISC_WIDTHS);
      expect(drawn).toBe(BALL_MASK_PIXELS);
      expect(DISC_WIDTHS.reduce((sum, n) => sum + n, 0)).toBe(BALL_MASK_PIXELS);
    }
  });

  it("shares the greyscale ramp at entries 48..60 across all three tables", () => {
    // The steel body is a reserved 16-step ramp that is byte-identical in the
    // three palettes; only the tinted crescent and the speckles differ. That is
    // why one 17x17 sprite per table is enough and no colours ship here.
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const ball = ballFor(tableId);
      for (let index = 48; index <= 60; index += 1) {
        expect([tableId, index, ball.indicesUsed.includes(index)]).toEqual([tableId, index, true]);
      }
    }
  });

  it("names the two structure layers the original cuts it against", () => {
    // Bit 2 is the level-0 structure area and bit 3 the level-1 one. Neither
    // blocks the ball; both draw in front of it. See materials.ts.
    expect(STRUCTURE_BIT_BY_LEVEL).toEqual([4, 8]);
  });

  it("refuses a document whose sprite and mask disagree", () => {
    const doc = JSON.parse(
      readFileSync(`${TABLES_DIR}law-n-justice.ball.json`, "utf8"),
    ) as unknown as Record<string, unknown>;
    const pixels = Buffer.from(doc["pixels"] as string, "base64");
    pixels[8 * 17 + 8] = 0; // punch a hole in the centre of the disc
    doc["pixels"] = pixels.toString("base64");
    expect(() => parseTableBallDocument(doc as unknown as TableBallDocument)).toThrow(
      /disagree between the sprite and its mask/,
    );
  });

  it("registers what it loads and hands back null when nothing is registered", async () => {
    clearTableBalls();
    expect(tableBallFor("law-n-justice")).toBeNull();
    const doc = JSON.parse(
      readFileSync(`${TABLES_DIR}law-n-justice.ball.json`, "utf8"),
    ) as TableBallDocument;
    expect(doc.schema).toBe(TABLE_BALL_SCHEMA);
    const loaded = await loadTableBall("law-n-justice", async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => doc,
    }));
    expect(tableBallFor("law-n-justice")).toBe(loaded);
    clearTableBalls();
    for (const tableId of TABLE_IDS as readonly TableId[]) registerTableBall(ballFor(tableId));
  });
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe("placement", () => {
  it("puts the ball's top-left at the centre minus the anchor, in whole pixels", async () => {
    const tableId: TableId = "law-n-justice";
    const sprites = buildMovingSprites(await artFor(tableId), bats, ballFor(tableId));
    // A Q10 position with a fraction must FLOOR, which is `q10ToPixel`'s `>> 10`
    // and the original's own conversion; anything else puts a sprite on a half
    // pixel and smears the blit.
    const placements = movingSpritePlacements(sprites, [], [
      { id: 1, x: pixelsToQ10(100) + 1023, y: pixelsToQ10(200) + 1023, level: 0 },
    ]);
    expect(placements).toHaveLength(1);
    expect([placements[0]?.x, placements[0]?.y]).toEqual([100 - 8, 200 - 8]);
    expect([placements[0]?.width, placements[0]?.height]).toEqual([17, 17]);
  });

  it("places every bat on the SIMULATION's pivot, which IS its record's", async () => {
    // INVERTED, AND THE INVERSION IS THE FIX. This test used to hand the
    // placement "a deliberately wrong pivot" and assert that "a drawn bat must
    // ignore it" — the drawn bat was hung on the pose bank record and the
    // simulation's pivot travelled only to place a fallback marker. That is
    // exactly how the picture and the physics came apart: the simulation ran on
    // an inferred row 558 while the record drew on row 556, the drawn bat sat
    // two pixels ABOVE the colliding one, and a ball resting on the flipper the
    // player could see had nothing under it.
    //
    // So a wrong pivot must now MOVE THE PICTURE, loudly, rather than be
    // ignored quietly — and the pivot the simulation supplies is asserted to be
    // the record's, which is the property that makes the picture right.
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const sprites = buildMovingSprites(await artFor(tableId), bats, ballFor(tableId));
      for (const bat of sprites.bats.values()) {
        const pose = sprites.poses.get(bat.restPose);
        if (pose === undefined) throw new Error(`no pose ${bat.restPose}`);

        // 1. The simulation's own configuration is on the record's pivot.
        const config = flipperConfigsFor(tableId).find((c) => c.id === bat.id);
        if (config === undefined) throw new Error(`${tableId} configures no ${bat.id}`);
        expect([tableId, bat.id, q10ToPixel(config.pivotX), q10ToPixel(config.pivotY)])
          .toEqual([tableId, bat.id, bat.pivotX, bat.pivotY]);

        // 2. Handed that pivot, the bat is drawn where the original draws it.
        const drawn = movingSpritePlacements(
          sprites,
          [{ id: bat.id, stroke: 0, sweep: bat.sweepPoses * 64, pivotX: config.pivotX, pivotY: config.pivotY }],
          [],
        );
        expect([tableId, bat.id, drawn[0]?.kind]).toEqual([tableId, bat.id, "bat"]);
        expect([tableId, bat.id, drawn[0]?.x, drawn[0]?.y]).toEqual([
          tableId,
          bat.id,
          bat.pivotX - pose.anchorX,
          bat.pivotY - pose.anchorY,
        ]);

        // 3. And a pivot two rows out — the exact divergence that shipped —
        //    moves the picture by two rows instead of being swallowed.
        const wrong = movingSpritePlacements(
          sprites,
          [{
            id: bat.id,
            stroke: 0,
            sweep: bat.sweepPoses * 64,
            pivotX: config.pivotX,
            pivotY: config.pivotY + pixelsToQ10(2),
          }],
          [],
        );
        expect([tableId, bat.id, wrong[0]?.y]).toEqual([
          tableId,
          bat.id,
          bat.pivotY + 2 - pose.anchorY,
        ]);
      }
    }
  });

  it("marks a missing sprite instead of inventing a look-alike", () => {
    const placements = movingSpritePlacements(
      null,
      [{ id: "lower-left", stroke: 0, sweep: 1152, pivotX: pixelsToQ10(86), pivotY: pixelsToQ10(556) }],
      [{ id: 1, x: pixelsToQ10(100), y: pixelsToQ10(200), level: 0 }],
    );
    expect(placements.map((p) => p.kind)).toEqual(["bat-missing", "ball-missing"]);
    const target = createPixelTarget(336, 600);
    compositeMovingSprites(target, null, placements);
    // Magenta, hollow, and nothing else: the marker is unmistakable, and it is
    // written as exact pixels so the grid invariant survives the failure case.
    const at = (x: number, y: number): number[] => {
      const i = (y * target.width + x) * 4;
      return [target.data[i] ?? 0, target.data[i + 1] ?? 0, target.data[i + 2] ?? 0];
    };
    expect(at(86 - (FALLBACK_BAT_BOX >> 1), 556 - (FALLBACK_BAT_BOX >> 1))).toEqual([...FALLBACK_MARKER]);
    expect(at(86, 556)).toEqual([0, 0, 0]);
    expect(at(100 - BALL_RADIUS_PIXELS, 200)).toEqual([...FALLBACK_MARKER]);
    expect(at(100, 200)).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Compositing, colours and the grid
// ---------------------------------------------------------------------------

/** A frame with the artwork, every lamp dim, both bats at rest and one ball. */
async function frameFor(
  tableId: TableId,
  ballCentre: { x: number; y: number },
): Promise<{ map: TableMap; art: TableArt; ball: TableBall; frame: PixelTarget }> {
  const map = mapFor(tableId);
  const art = await artFor(tableId);
  const ball = ballFor(tableId);
  const frame = renderPlayfieldInto(art, createPixelTarget(art.width, art.height));
  const lamps = lampsFor(tableId);
  compositeLampOverlays(
    frame,
    buildLampSprites(art, lamps),
    lampModes(lamps, null),
    0,
    lamps.blinkHalfPeriodFrames,
  );
  const sprites = buildMovingSprites(art, bats, ball);
  const batStates = [...sprites.bats.values()].map((bat) => ({
    id: bat.id,
    stroke: 0,
    sweep: bat.sweepPoses * 64,
    pivotX: pixelsToQ10(bat.pivotX),
    pivotY: pixelsToQ10(bat.pivotY),
  }));
  compositeMovingSpriteFrame(frame, map, sprites, batStates, [
    { id: 1, x: pixelsToQ10(ballCentre.x), y: pixelsToQ10(ballCentre.y), level: 0 },
  ]);
  return { map, art, ball, frame };
}

/** The comparison window out of a frame, magnified by `scale`, as RGB. */
function window(frame: PixelTarget, scale: number): { rgb: Uint8Array; width: number; height: number } {
  const width = WINDOW.width * scale;
  const height = WINDOW.height * scale;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((WINDOW.y + Math.floor(y / scale)) * frame.width + WINDOW.x + Math.floor(x / scale)) * 4;
      const to = (y * width + x) * 3;
      rgb[to] = frame.data[from] ?? 0;
      rgb[to + 1] = frame.data[from + 1] ?? 0;
      rgb[to + 2] = frame.data[from + 2] ?? 0;
    }
  }
  return { rgb, width, height };
}

/** Blocks of `scale` square that are not a single uniform colour. */
function nonUniformBlocks(rgb: Uint8Array, width: number, height: number, scale: number): number {
  let bad = 0;
  for (let by = 0; by + scale <= height; by += scale) {
    for (let bx = 0; bx + scale <= width; bx += scale) {
      const at = (by * width + bx) * 3;
      let uniform = true;
      for (let dy = 0; dy < scale && uniform; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const p = ((by + dy) * width + bx + dx) * 3;
          if (rgb[p] !== rgb[at] || rgb[p + 1] !== rgb[at + 1] || rgb[p + 2] !== rgb[at + 2]) {
            uniform = false;
            break;
          }
        }
      }
      if (!uniform) bad += 1;
    }
  }
  return bad;
}

/** Where each table's filmed frame has its ball, as a playfield-pixel centre. */
const FILM_BALL: Record<TableId, { x: number; y: number }> = {
  "law-n-justice": { x: 87, y: 537 },
  babewatch: { x: 152, y: 564 },
  "extreme-sports": { x: 34, y: 458 },
};

describe("the pixel grid", () => {
  it("has no non-uniform block at any integer scale, on any table", async () => {
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const { frame } = await frameFor(tableId, FILM_BALL[tableId]);
      for (const scale of [1, 2, 3, 4]) {
        const view = window(frame, scale);
        // The original scores exactly zero over this window at 2x. So does
        // this. Do NOT relax it to a tolerance.
        expect([tableId, scale, nonUniformBlocks(view.rgb, view.width, view.height, scale)]).toEqual([
          tableId,
          scale,
          0,
        ]);
      }
      // The window at 2x is the 74,556 blocks the comparison pipeline measures.
      expect((WINDOW.width * WINDOW.height)).toBe(74556);
    }
  });

  it("would notice a sprite drawn off the grid", async () => {
    // The checker has to be able to fail, or "zero non-uniform blocks" means
    // nothing. Shifting one row of a 2x view by a pixel is exactly what a
    // device-resolution vector call does at the edge of a shape.
    const { frame } = await frameFor("law-n-justice", FILM_BALL["law-n-justice"]);
    const view = window(frame, 2);
    const at = (200 * view.width + 200) * 3;
    view.rgb[at] = (view.rgb[at] ?? 0) ^ 0xff;
    expect(nonUniformBlocks(view.rgb, view.width, view.height, 2)).toBe(1);
  });

  it("draws every sprite pixel as an exact artwork palette entry", async () => {
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const { art, frame } = await frameFor(tableId, FILM_BALL[tableId]);
      const entries = new Set<number>();
      for (let index = 0; index < art.paletteEntries; index += 1) {
        entries.add(
          ((art.palette[index * 3] ?? 0) << 16) |
            ((art.palette[index * 3 + 1] ?? 0) << 8) |
            (art.palette[index * 3 + 2] ?? 0),
        );
      }
      // An anti-aliased edge blends two palette entries and lands on a colour
      // that is in no entry at all, so this catches the defect at its cause.
      let foreign = 0;
      for (let i = 0; i < frame.width * frame.height; i += 1) {
        const rgb =
          ((frame.data[i * 4] ?? 0) << 16) |
          ((frame.data[i * 4 + 1] ?? 0) << 8) |
          (frame.data[i * 4 + 2] ?? 0);
        if (!entries.has(rgb)) foreign += 1;
      }
      expect([tableId, foreign]).toEqual([tableId, 0]);
    }
  });

  it("covers exactly the 221-pixel disc when the ball is over open playfield", async () => {
    const tableId: TableId = "law-n-justice";
    const map = mapFor(tableId);
    const art = await artFor(tableId);
    const ball = ballFor(tableId);
    const sprites = buildMovingSprites(art, bats, ball);
    const occluder = mapStructureOccluder(map);
    // A spot with no structure on level 0 under any of the 17x17 window.
    let centre: { x: number; y: number } | null = null;
    for (let y = 400; y < 520 && centre === null; y += 1) {
      for (let x = 40; x < 300; x += 1) {
        let clear = true;
        for (let dy = -8; dy <= 8 && clear; dy += 1) {
          for (let dx = -8; dx <= 8; dx += 1) {
            if (occluder.blocks(x + dx, y + dy, 0)) {
              clear = false;
              break;
            }
          }
        }
        if (clear) {
          centre = { x, y };
          break;
        }
      }
    }
    if (centre === null) throw new Error("no unobstructed spot on the lower level");

    const base = renderPlayfieldInto(art, createPixelTarget(art.width, art.height));
    const drawn = renderPlayfieldInto(art, createPixelTarget(art.width, art.height));
    compositeMovingSpriteFrame(drawn, map, sprites, [], [
      { id: 1, x: pixelsToQ10(centre.x), y: pixelsToQ10(centre.y), level: 0 },
    ]);
    let changed = 0;
    let outside = 0;
    for (let i = 0; i < base.width * base.height; i += 1) {
      const same =
        base.data[i * 4] === drawn.data[i * 4] &&
        base.data[i * 4 + 1] === drawn.data[i * 4 + 1] &&
        base.data[i * 4 + 2] === drawn.data[i * 4 + 2];
      if (same) continue;
      changed += 1;
      const x = i % base.width;
      const y = (i - x) / base.width;
      const inSprite =
        x >= centre.x - 8 && x <= centre.x + 8 && y >= centre.y - 8 && y <= centre.y + 8;
      if (!inSprite) outside += 1;
    }
    // Some disc pixels may coincidentally equal the paint under them, so the
    // count is a ceiling; what must be exact is that NOTHING outside the disc
    // moved — no anti-aliased fringe, no soft edge.
    expect(outside).toBe(0);
    expect(changed).toBeGreaterThan(180);
    expect(changed).toBeLessThanOrEqual(BALL_MASK_PIXELS);
  });

  it("hides the ball behind structure the way the original cuts its mask", async () => {
    const tableId: TableId = "law-n-justice";
    const map = mapFor(tableId);
    const art = await artFor(tableId);
    const sprites = buildMovingSprites(art, bats, ballFor(tableId));
    const occluder = mapStructureOccluder(map);
    // A spot where the level-0 structure layer covers part of the ball.
    let centre: { x: number; y: number } | null = null;
    for (let y = 200; y < 520 && centre === null; y += 1) {
      for (let x = 40; x < 300; x += 1) {
        let covered = 0;
        for (let dy = -8; dy <= 8; dy += 1) {
          for (let dx = -8; dx <= 8; dx += 1) {
            if (occluder.blocks(x + dx, y + dy, 0)) covered += 1;
          }
        }
        if (covered > 40 && covered < 200) {
          centre = { x, y };
          break;
        }
      }
    }
    if (centre === null) throw new Error("no partly covered spot found");

    const base = renderPlayfieldInto(art, createPixelTarget(art.width, art.height));
    const drawn = renderPlayfieldInto(art, createPixelTarget(art.width, art.height));
    compositeMovingSpriteFrame(drawn, map, sprites, [], [
      { id: 1, x: pixelsToQ10(centre.x), y: pixelsToQ10(centre.y), level: 0 },
    ]);
    let structurePixelsTouched = 0;
    for (let dy = -8; dy <= 8; dy += 1) {
      for (let dx = -8; dx <= 8; dx += 1) {
        if (!occluder.blocks(centre.x + dx, centre.y + dy, 0)) continue;
        const i = ((centre.y + dy) * base.width + centre.x + dx) * 4;
        if (
          base.data[i] !== drawn.data[i] ||
          base.data[i + 1] !== drawn.data[i + 1] ||
          base.data[i + 2] !== drawn.data[i + 2]
        ) {
          structurePixelsTouched += 1;
        }
      }
    }
    expect(structurePixelsTouched).toBe(0);
  });
});

describe("drawing does not move the simulation", () => {
  it("produces identical state whether or not sprites are composited", async () => {
    const tableId: TableId = "law-n-justice";
    const art = await artFor(tableId);
    const sprites = buildMovingSprites(art, bats, ballFor(tableId));
    const idle: InputSource = { sample: () => IDLE_SNAPSHOT };

    const quiet = createGame(mapFor(tableId));
    startGame(quiet);
    const drawing = createGame(mapFor(tableId));
    startGame(drawing);
    const target = createPixelTarget(art.width, art.height);

    for (let tick = 0; tick < 120; tick += 1) {
      runTicks(quiet, idle, 1);
      runTicks(drawing, idle, 1);
      const snapshot = debugSnapshot(drawing);
      compositeMovingSpriteFrame(
        target,
        drawing.map,
        sprites,
        snapshot.flippers.map((flipper) => ({
          id: flipper.id,
          stroke: flipper.stroke,
          sweep: sprites.bats.get(flipper.id)!.sweepPoses * 64,
          // The simulation's own pivot: a placement is hung on this now, so
          // handing it zero would draw all three bats in the top-left corner.
          pivotX: configFor(tableId, flipper.id).pivotX,
          pivotY: configFor(tableId, flipper.id).pivotY,
        })),
        snapshot.balls
          .filter((ball) => ball.active)
          .map((ball) => ({ id: ball.id, x: ball.x, y: ball.y, level: ball.level })),
      );
    }
    expect(debugSnapshot(drawing)).toEqual(debugSnapshot(quiet));
  });
});

// ---------------------------------------------------------------------------
// Every bat draws, in every state a player passes through
// ---------------------------------------------------------------------------

describe("the bats a player actually sees", () => {
  /**
   * WHY THIS EXISTS. The fourth play-test report opened "still missing flippers
   * on the first board". Three independent read-only investigations — two
   * headless through `renderGame` and one driving the shipped page in a real
   * Chrome with real key events, real requestAnimationFrame and the player's own
   * route through the menus — failed to reproduce a bat that does not draw, on
   * Law 'n Justice or on either of the others. That is a reason to PIN the
   * property, not a reason to assume it: this walks a real game through every
   * state a player passes through and asserts that all three bats produce a real
   * sprite placement, at the pixel the original draws it, every time.
   *
   * `movingSpritePlacements` emits a MAGENTA MARKER rather than nothing when a
   * pose or a record is unavailable, so "bat-missing" is what this catches,
   * along with a blit box that has fallen off the overlay.
   */
  const held = (...down: readonly Control[]): ControlSnapshot => ({
    sequence: 1,
    controls: Object.fromEntries(
      CONTROLS.map((control) => [
        control,
        {
          down: down.includes(control),
          pressed: down.includes(control),
          released: false,
          pressCount: down.includes(control) ? 1 : 0,
          releaseCount: 0,
        },
      ]),
    ) as ControlSnapshot["controls"],
  });

  function assertEveryBatDraws(
    tableId: TableId,
    sprites: ReturnType<typeof buildMovingSprites>,
    game: ReturnType<typeof createGame>,
    where: string,
  ): void {
    const snapshot = debugSnapshot(game);
    const states = snapshot.flippers.map((flipper) => {
      const config = configFor(tableId, flipper.id);
      return {
        id: flipper.id,
        stroke: flipper.stroke,
        sweep: config.sweep,
        pivotX: config.pivotX,
        pivotY: config.pivotY,
      };
    });
    expect({ where, bats: states.length }).toEqual({ where, bats: 3 });
    const placements = movingSpritePlacements(sprites, states, []);
    expect({ where, kinds: placements.map((p) => p.kind) })
      .toEqual({ where, kinds: ["bat", "bat", "bat"] });
    for (const [index, placement] of placements.entries()) {
      const id = states[index]?.id ?? "?";
      // The pose resolved to one the bank actually ships.
      expect({ where, id, shipped: sprites.batPoses.has(placement.key) })
        .toEqual({ where, id, shipped: true });
      // The whole block is inside the 336 x 600 playfield overlay, so nothing
      // is clipped away before the camera has had a chance to frame it.
      const inside =
        placement.x >= 0 &&
        placement.y >= 0 &&
        placement.x + placement.width <= PLAYFIELD_WIDTH &&
        placement.y + placement.height <= PLAYFIELD_HEIGHT;
      expect({ where, id, inside }).toEqual({ where, id, inside: true });
      // And it is where the ORIGINAL draws it: the record's pivot, less the
      // pose's own anchor. The simulation supplied that pivot, which is the
      // property the whole round is about.
      const record = sprites.bats.get(id);
      const pose = sprites.poses.get(placement.key);
      if (record === undefined || pose === undefined) throw new Error(`no ${id}`);
      expect({ where, id, at: [placement.x, placement.y] }).toEqual({
        where,
        id,
        at: [record.pivotX - pose.anchorX, record.pivotY - pose.anchorY],
      });
    }
  }

  it("draws all three bats in every state, on all three tables", async () => {
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const sprites = buildMovingSprites(await artFor(tableId), bats, ballFor(tableId));
      const game = createGame(mapFor(tableId));

      // 1. Attract: the table is loaded and nothing has been started.
      assertEveryBatDraws(tableId, sprites, game, `${tableId}/attract`);

      // 2. The instant a game starts, before a single tick — the frame the
      //    camera spends at the TOP of the table during the filmed serve snap,
      //    and the one state in which a player really does see no flippers.
      startGame(game);
      assertEveryBatDraws(tableId, sprites, game, `${tableId}/started`);

      // 3. Every tick of the serve countdown and the run-down after it, which
      //    is the 0.8 s a player watches before the ball appears.
      const idle: InputSource = { sample: () => IDLE_SNAPSHOT };
      for (let tick = 0; tick < 160; tick += 1) {
        runTicks(game, idle, 1);
        assertEveryBatDraws(tableId, sprites, game, `${tableId}/serve+${tick}`);
      }

      // 4. Ball in play, plunged and flipped at, sampled through 2,000 ticks —
      //    across a drain and the next ball's serve.
      let beat = 0;
      for (let tick = 0; tick < 2000; tick += 1) {
        beat += 1;
        const down: Control[] = [];
        if (beat % 23 < 3) down.push("leftFlipper", "upperFlipper");
        if (beat % 31 < 3) down.push("rightFlipper");
        if (beat % 17 === 0) down.push("plunger");
        const snapshot = held(...down);
        runTicks(game, { sample: () => snapshot }, 1);
        if (tick % 7 === 0) assertEveryBatDraws(tableId, sprites, game, `${tableId}/play+${tick}`);
      }

      // 5. Both bats held all the way up and all the way back down, tick by
      //    tick: every pose of every stroke has to resolve to a shipped frame.
      const bothDown = held("leftFlipper", "rightFlipper", "upperFlipper");
      for (let tick = 0; tick < 12; tick += 1) {
        runTicks(game, { sample: () => bothDown }, 1);
        assertEveryBatDraws(tableId, sprites, game, `${tableId}/held+${tick}`);
      }
      for (let tick = 0; tick < 20; tick += 1) {
        runTicks(game, idle, 1);
        assertEveryBatDraws(tableId, sprites, game, `${tableId}/released+${tick}`);
      }

      // 6. Tilt: three nudges inside half a second trips it, and a tilted table
      //    still has flippers drawn on it — they simply stop responding.
      const nudge = held("nudgeLeft");
      for (let tick = 0; tick < 40; tick += 1) {
        runTicks(game, { sample: () => (tick % 10 === 0 ? nudge : IDLE_SNAPSHOT) }, 1);
        assertEveryBatDraws(tableId, sprites, game, `${tableId}/tilt+${tick}`);
      }

      // 7. Game over: the card the player reads before the high-score entry.
      const over = createGame(mapFor(tableId), { ballsPerGame: 1 });
      startGame(over);
      for (let tick = 0; tick < 20000 && over.phase !== "game-over"; tick += 1) {
        const down: Control[] = [];
        if (tick % 29 < 3) down.push("leftFlipper", "rightFlipper", "upperFlipper");
        if (tick % 19 === 0) down.push("plunger");
        const snapshot = held(...down);
        runTicks(over, { sample: () => snapshot }, 1);
      }
      expect({ tableId, phase: over.phase }).toEqual({ tableId, phase: "game-over" });
      assertEveryBatDraws(tableId, sprites, over, `${tableId}/game-over`);
    }
  });

  it("keeps the lower pair inside the window wherever the camera settles", async () => {
    // The camera holds at the bottom stop for most of a ball, and that is the
    // frame the operator was looking at when he reported the bats missing. Both
    // lower bats' blit blocks have to be wholly inside the 256-row window there,
    // on every table.
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const sprites = buildMovingSprites(await artFor(tableId), bats, ballFor(tableId));
      for (const id of ["lower-left", "lower-right"] as const) {
        const record = sprites.bats.get(id);
        if (record === undefined) throw new Error(`${tableId} has no ${id}`);
        for (let step = 0; step <= record.sweepPoses; step += 1) {
          const pose = sprites.poses.get(
            ((record.restPose + record.direction * step) % 120 + 120) % 120,
          );
          if (pose === undefined) throw new Error(`${tableId} ${id} is missing a pose`);
          const top = record.pivotY - pose.anchorY;
          expect({ tableId, id, step, top: top >= SERVE_FRAMING_SCROLL })
            .toEqual({ tableId, id, step, top: true });
          expect({
            tableId,
            id,
            step,
            bottom: top + pose.height <= SERVE_FRAMING_SCROLL + VIEWPORT_HEIGHT,
          }).toEqual({ tableId, id, step, bottom: true });
        }
      }
    }
  });
});
