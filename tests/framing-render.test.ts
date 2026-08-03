/**
 * THE SWITCHABLE VIEW IS A RENDER-LAYER FRAMING. This file is the proof.
 *
 * The Fantasies-parity round (research/FANTASIES_PARITY_BRIEF.md §2) made the
 * full table the default presentation and the film-verified 336 x 256 Amiga
 * window the toggle — and the whole of it lives on the presentation side of
 * the line `hd-scale.ts` drew: `game.camera` and `game.forceFullTable` are
 * hashed simulation state (`tests/sim-hash-pin.test.ts`) and the framing must
 * never touch either. The properties pinned here:
 *
 *  - the full-table geometry is the WHOLE board at scale 1, and it does not
 *    read the camera at all — any scroll, any mode, same blit;
 *  - the Amiga framing is byte-for-byte the old windowed pass;
 *  - `renderGame` in full-table framing sizes a 336 x 616 frame, hangs the
 *    board under the 16-row cabinet band with one translate, and draws the
 *    panel band at the top of the canvas;
 *  - rendering — in either framing, and toggling BETWEEN framings mid-game —
 *    leaves the simulation's serialized state identical to a run that never
 *    rendered a frame. That is the §2 acceptance criterion restated at this
 *    file's scale; the pin test holds the same line against history.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { VIEWPORT_HEIGHT } from "../src/browser/camera.js";
import type { CameraState } from "../src/browser/camera.js";
import {
  FULL_TABLE_FRAMING_ROWS,
  createGame,
  debugSnapshot,
  framingRows,
  renderGame,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { InputSource, RenderFraming } from "../src/browser/game-loop.js";
import type { ControlSnapshot } from "../src/browser/input.js";
import { InputRouter } from "../src/browser/input.js";
import { PANEL_HEIGHT } from "../src/browser/panel-renderer.js";
import {
  createPixelTarget,
  drawPlayfield,
  invalidatePlayfieldRaster,
  playfieldFullTableGeometry,
  setPlayfieldArtwork,
  setPlayfieldArtworkHd,
} from "../src/browser/playfield-renderer.js";
import type { BlitContext } from "../src/browser/playfield-renderer.js";
import { invalidateLampLayers } from "../src/browser/lamp-layer.js";
import { invalidateSpriteLayers } from "../src/browser/sprite-layer.js";
import { HD_SCALE } from "../src/browser/hd-scale.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import type { TableMap } from "../src/game/contracts.js";
import { canvasFitFor, fitWindowInto } from "../src/browser/canvas-fit.js";
import { flipperBatsFixture, mapFor } from "./table-fixtures.js";

// ---------------------------------------------------------------------------
// A recording canvas, the hd-render.test.ts pattern
// ---------------------------------------------------------------------------

interface DrawCall {
  readonly image: unknown;
  readonly args: readonly number[];
  readonly smoothing: boolean;
}

class FakeContext {
  imageSmoothingEnabled = false;

  clearRect(): void {}

  drawImage(): void {}

  createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }

  putImageData(): void {}
}

class FakeOffscreenCanvas {
  readonly context = new FakeContext();

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  getContext(): FakeContext {
    return this.context;
  }
}

vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  invalidatePlayfieldRaster();
  invalidateLampLayers();
  invalidateSpriteLayers();
});

class RecordingBlit implements BlitContext {
  imageSmoothingEnabled = true;
  readonly draws: DrawCall[] = [];

  drawImage(image: CanvasImageSource, ...args: number[]): void {
    this.draws.push({ image, args, smoothing: this.imageSmoothingEnabled });
  }
}

/**
 * The slice of `CanvasRenderingContext2D` that `renderGame` uses, recording
 * every transform, fill and blit so the frame's geometry is assertable.
 */
class RecordingFrameContext {
  imageSmoothingEnabled = false;
  fillStyle = "";
  font = "";
  textBaseline = "";
  readonly transforms: number[][] = [];
  readonly fills: { rect: number[]; style: string }[] = [];
  readonly draws: DrawCall[] = [];
  readonly texts: string[] = [];

  setTransform(...args: number[]): void {
    this.transforms.push(args);
  }

  fillRect(...rect: number[]): void {
    this.fills.push({ rect, style: this.fillStyle });
  }

  drawImage(image: unknown, ...args: number[]): void {
    this.draws.push({ image, args, smoothing: this.imageSmoothingEnabled });
  }

  fillText(text: string): void {
    this.texts.push(text);
  }
}

function mapFixture(): TableMap {
  return {
    tableId: "law-n-justice",
    displayName: "Fixture",
    width: PLAYFIELD_WIDTH,
    height: PLAYFIELD_HEIGHT,
    pixels: new Uint8Array(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT),
    materialAt: () => 0,
  };
}

const SCROLLED: CameraState = { scrollY: 217, mode: "scrolling" };
const MULTIBALL: CameraState = { scrollY: 0, mode: "full-table" };

// ---------------------------------------------------------------------------
// The geometry
// ---------------------------------------------------------------------------

describe("the full-table framing geometry", () => {
  it("is the whole board at scale 1: 616 logical rows with the panel band", () => {
    expect(FULL_TABLE_FRAMING_ROWS).toBe(PANEL_HEIGHT + PLAYFIELD_HEIGHT);
    expect(FULL_TABLE_FRAMING_ROWS).toBe(616);
    expect(framingRows("full-table")).toBe(616);
    expect(framingRows("amiga")).toBe(VIEWPORT_HEIGHT);

    const geometry = playfieldFullTableGeometry(mapFixture(), 2);
    expect(geometry).toEqual({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: PLAYFIELD_WIDTH,
      sourceHeight: PLAYFIELD_HEIGHT,
      destWidth: PLAYFIELD_WIDTH * 2,
      destHeight: PLAYFIELD_HEIGHT * 2,
    });
  });

  it("never reads the camera: any scroll, any mode, the same blit", () => {
    const map = mapFixture();
    setPlayfieldArtwork(map, createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT));

    const expected = [
      0,
      0,
      PLAYFIELD_WIDTH,
      PLAYFIELD_HEIGHT,
      0,
      0,
      PLAYFIELD_WIDTH * 3,
      PLAYFIELD_HEIGHT * 3,
    ];
    for (const camera of [SCROLLED, MULTIBALL, { scrollY: 344, mode: "scrolling" as const }]) {
      const context = new RecordingBlit();
      drawPlayfield(context, map, camera, 3, true);
      expect(context.draws[0]?.args).toEqual(expected);
    }
  });

  it("keeps the Amiga framing byte-for-byte the old windowed pass", () => {
    const map = mapFixture();
    setPlayfieldArtwork(map, createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT));
    const context = new RecordingBlit();
    drawPlayfield(context, map, SCROLLED, 3);
    // The window: 256 source rows from the camera's scroll, exactly as before.
    expect(context.draws[0]?.args).toEqual([
      0,
      217,
      PLAYFIELD_WIDTH,
      VIEWPORT_HEIGHT,
      0,
      0,
      PLAYFIELD_WIDTH * 3,
      VIEWPORT_HEIGHT * 3,
    ]);
  });

  it("reads the HD master 1:1 at the master's own scale, supersampled below it", () => {
    const map = mapFixture();
    setPlayfieldArtwork(map, createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT));
    setPlayfieldArtworkHd(
      map,
      createPixelTarget(PLAYFIELD_WIDTH * HD_SCALE, PLAYFIELD_HEIGHT * HD_SCALE),
    );

    const atMaster = new RecordingBlit();
    drawPlayfield(atMaster, map, SCROLLED, HD_SCALE, true);
    expect(atMaster.draws[0]?.args).toEqual([
      0,
      0,
      PLAYFIELD_WIDTH * HD_SCALE,
      PLAYFIELD_HEIGHT * HD_SCALE,
      0,
      0,
      PLAYFIELD_WIDTH * HD_SCALE,
      PLAYFIELD_HEIGHT * HD_SCALE,
    ]);
    // 1:1 — nearest keeps the pixels exact.
    expect(atMaster.draws[0]?.smoothing).toBe(false);

    const below = new RecordingBlit();
    drawPlayfield(below, map, SCROLLED, 2, true);
    // A 2:1 supersampled downscale — bilinear resolves it.
    expect(below.draws[0]?.smoothing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

describe("renderGame with a framing", () => {
  function renderedFrame(framing: RenderFraming | undefined, scale = 2): RecordingFrameContext {
    flipperBatsFixture();
    // The armed fixture map: createGame refuses a table whose ramp drive,
    // devices, modes or bats are missing, and this test is about the frame,
    // not the loaders.
    const map = mapFor("law-n-justice");
    setPlayfieldArtwork(map, createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT));
    const game = createGame(map);
    startGame(game);
    const context = new RecordingFrameContext();
    renderGame(
      context as unknown as CanvasRenderingContext2D,
      game,
      scale,
      null,
      ...(framing === undefined ? [] : ([framing] as const)),
    );
    return context;
  }

  it("full-table: a 336 x 616 frame, the board translated under the band", () => {
    const context = renderedFrame("full-table");
    // The frame fill covers the tall canvas.
    expect(context.fills[0]?.rect).toEqual([
      0,
      0,
      PLAYFIELD_WIDTH * 2,
      FULL_TABLE_FRAMING_ROWS * 2,
    ]);
    // One identity reset, then the +16-row translate for the board pass,
    // then back to identity before the panel/HUD.
    expect(context.transforms[0]).toEqual([1, 0, 0, 1, 0, 0]);
    expect(context.transforms[1]).toEqual([1, 0, 0, 1, 0, PANEL_HEIGHT * 2]);
    expect(context.transforms[2]).toEqual([1, 0, 0, 1, 0, 0]);
    // The board blit under that translate is the whole table at scale 1.
    expect(context.draws[0]?.args).toEqual([
      0,
      0,
      PLAYFIELD_WIDTH,
      PLAYFIELD_HEIGHT,
      0,
      0,
      PLAYFIELD_WIDTH * 2,
      PLAYFIELD_HEIGHT * 2,
    ]);
  });

  it("amiga: the 336 x 256 frame it has always drawn", () => {
    const context = renderedFrame("amiga");
    expect(context.fills[0]?.rect).toEqual([0, 0, PLAYFIELD_WIDTH * 2, VIEWPORT_HEIGHT * 2]);
    // No framing translate: one transform, the identity reset.
    expect(context.transforms).toEqual([[1, 0, 0, 1, 0, 0]]);
  });

  it("defaults to the Amiga framing, so every old caller is untouched", () => {
    const defaulted = renderedFrame(undefined);
    const amiga = renderedFrame("amiga");
    expect(defaulted.fills).toEqual(amiga.fills);
    expect(defaulted.transforms).toEqual(amiga.transforms);
    expect(defaulted.draws.map((d) => d.args)).toEqual(amiga.draws.map((d) => d.args));
  });
});

// ---------------------------------------------------------------------------
// The sim stays sealed
// ---------------------------------------------------------------------------

/** The sim-hash-pin harness's script, verbatim, so coverage matches the pin. */
class ScriptedInput implements InputSource {
  readonly router = new InputRouter();
  #tick = 0;

  sample(): ControlSnapshot {
    const tick = this.#tick;
    this.#tick += 1;
    if (tick % 400 === 100) this.router.press("plunger");
    if (tick % 400 === 130) this.router.release("plunger");
    if (tick % 97 === 55) this.router.press("leftFlipper");
    if (tick % 97 === 75) this.router.release("leftFlipper");
    if (tick % 131 === 40) this.router.press("rightFlipper");
    if (tick % 131 === 64) this.router.release("rightFlipper");
    if (tick === 700) this.router.tap("nudgeLeft");
    if (tick === 2100) this.router.tap("nudgeRight");
    return this.router.sample();
  }
}

describe("the framing cannot reach the simulation", () => {
  it("a run that renders and toggles hashes identically to one that never renders", () => {
    const TICKS = 600;

    const hashOf = (render: boolean): string => {
      invalidatePlayfieldRaster();
      invalidateLampLayers();
      invalidateSpriteLayers();
      const map = mapFor("law-n-justice");
      if (render) setPlayfieldArtwork(map, createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT));
      const game = createGame(map);
      startGame(game);
      const input = new ScriptedInput();
      const hash = createHash("sha256");
      const context = new RecordingFrameContext() as unknown as CanvasRenderingContext2D;
      for (let tick = 0; tick < TICKS; tick += 1) {
        runTicks(game, input, 1);
        if (render) {
          // Toggle the framing every 40 ticks and render EVERY tick — far
          // harsher than a player with F9 — while the control run renders
          // nothing at all.
          renderGame(context, game, 2, null, tick % 80 < 40 ? "full-table" : "amiga");
        }
        hash.update(JSON.stringify(debugSnapshot(game)));
        hash.update("\n");
      }
      return hash.digest("hex");
    };

    expect(hashOf(true)).toBe(hashOf(false));
  });

  it("the hashed forceFullTable field stays false through every render", () => {
    const map = mapFor("law-n-justice");
    setPlayfieldArtwork(map, createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT));
    const game = createGame(map);
    startGame(game);
    const input = new ScriptedInput();
    const context = new RecordingFrameContext() as unknown as CanvasRenderingContext2D;
    for (let tick = 0; tick < 100; tick += 1) {
      runTicks(game, input, 1);
      renderGame(context, game, 2, null, "full-table");
    }
    expect(debugSnapshot(game).forceFullTable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The canvas fit follows the framing
// ---------------------------------------------------------------------------

describe("fitting the framing's canvas", () => {
  it("fits the 616-row picture into a portrait phone, height free", () => {
    const fitted = fitWindowInto({ width: 382, height: 700 }, FULL_TABLE_FRAMING_ROWS);
    // Height-bound: 700/616 < 382/336.
    expect(fitted.height).toBe(700);
    expect(fitted.width).toBe(Math.round((700 * PLAYFIELD_WIDTH) / FULL_TABLE_FRAMING_ROWS));
  });

  it("defaults to the 256-row window, so every old caller is untouched", () => {
    expect(fitWindowInto({ width: 382, height: 560 })).toEqual(
      fitWindowInto({ width: 382, height: 560 }, VIEWPORT_HEIGHT),
    );
  });

  it("sizes the backing store by the framing's rows", () => {
    const fit = canvasFitFor(
      { width: 900, height: 1200 },
      { hd: true, logicalHeight: FULL_TABLE_FRAMING_ROWS },
    );
    expect(fit.canvasHeight).toBe(FULL_TABLE_FRAMING_ROWS * fit.scale);
    expect(fit.canvasWidth).toBe(PLAYFIELD_WIDTH * fit.scale);

    const native = canvasFitFor(
      { width: 900, height: 1300 },
      { hd: false, logicalHeight: FULL_TABLE_FRAMING_ROWS },
    );
    // 1300 / 616 floors to 2: a whole-number magnification of the tall frame.
    expect(native.scale).toBe(2);
    expect(native.canvasHeight).toBe(FULL_TABLE_FRAMING_ROWS * 2);
  });
});
