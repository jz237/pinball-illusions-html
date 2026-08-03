/**
 * The HD render layer: loaders, fallback, blit geometry, placements, lamps.
 *
 * Everything here runs in node against the SHIPPED HD assets and a canvas
 * stand-in (a recording fake installed as `OffscreenCanvas`), because the
 * failure this project keeps having to design against is a renderer whose
 * tests never looked at what it actually drew. The properties pinned:
 *
 *  - the loaders decode the shipped files, verify the manifests' digests, and
 *    refuse wrong sizes;
 *  - `drawPlayfield` with no HD master registered is the NATIVE path,
 *    untouched — the whole fallback story in one assertion — and with one
 *    registered it multiplies the SOURCE rectangle by 4 and nothing else;
 *  - the HD lamp path draws dim patches for exactly the lamps
 *    `lampVisible` says are dark, at their recorded HD rectangles — same
 *    decision, new pixels;
 *  - HD sprite placements floor Q10 in HD units (quarter-native-pixel steps)
 *    and anchor bats with the simulation's own `pivot - anchor` arithmetic;
 *  - the HD ball face is occluded per HD pixel by the NATIVE structure
 *    occluder at floor(hd/4) — the ball hides under what the physics says.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { VIEWPORT_HEIGHT } from "../src/browser/camera.js";
import type { CameraState } from "../src/browser/camera.js";
import { HD_SCALE } from "../src/browser/hd-scale.js";
import { drawLampOverlays, invalidateLampLayers, setLampOverlaysHd } from "../src/browser/lamp-layer.js";
import {
  createPixelTarget,
  invalidatePlayfieldRaster,
  playfieldImageSourceHd,
  setPlayfieldArtwork,
  setPlayfieldArtworkHd,
} from "../src/browser/playfield-renderer.js";
import type { BlitContext } from "../src/browser/playfield-renderer.js";
import {
  drawMovingSprites,
  hdBallFace,
  hdMovingSpritePlacements,
  invalidateSpriteLayers,
  setMovingSpritesHd,
} from "../src/browser/sprite-layer.js";
import type { MovingSpritesHd } from "../src/browser/sprite-layer.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import type { TableId, TableMap } from "../src/game/contracts.js";
import { lampVisible, lampModes } from "../src/game/lamp-overlays.js";
import type { ModeState } from "../src/game/mode-vm.js";
import { buildMovingSprites } from "../src/game/moving-sprites.js";
import type { BatFrameState } from "../src/game/moving-sprites.js";
import { loadTableArt } from "../src/game/table-art.js";
import type { TableArtFetch } from "../src/game/table-art.js";
import {
  decodeTruecolorPng,
  loadFlipperBatsHd,
  loadTableArtHd,
  loadTableBallHd,
  loadTableLampsHd,
} from "../src/game/table-art-hd.js";
import type { TableLampsHd } from "../src/game/table-art-hd.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import { encodePng } from "../scripts/hd-pipeline.mjs";
import { ballFor, flipperBatsFixture, lampsFor } from "./table-fixtures.js";

// ---------------------------------------------------------------------------
// A recording canvas, installed as OffscreenCanvas for this file
// ---------------------------------------------------------------------------

interface DrawCall {
  readonly image: unknown;
  readonly args: readonly number[];
  readonly smoothing: boolean;
}

class FakeContext {
  imageSmoothingEnabled = false;
  readonly draws: DrawCall[] = [];
  clears = 0;

  clearRect(): void {
    this.clears += 1;
  }

  drawImage(image: unknown, ...args: number[]): void {
    this.draws.push({ image, args, smoothing: this.imageSmoothingEnabled });
  }

  createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }

  putImageData(): void {
    // The fake keeps no pixels; identity and geometry are what these tests read.
  }
}

class FakeOffscreenCanvas {
  static instances: FakeOffscreenCanvas[] = [];
  readonly context = new FakeContext();

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    FakeOffscreenCanvas.instances.push(this);
  }

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
  FakeOffscreenCanvas.instances = [];
});

/** The overlay canvas of a given size, found among the fakes. */
function overlayOf(width: number, height: number): FakeOffscreenCanvas {
  const found = FakeOffscreenCanvas.instances.find(
    (canvas) => canvas.width === width && canvas.height === height,
  );
  if (found === undefined) throw new Error(`no ${width}x${height} canvas was created`);
  return found;
}

// ---------------------------------------------------------------------------
// Shipped assets over a file-backed fetch
// ---------------------------------------------------------------------------

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));

const fileFetch: TableArtFetch = async (url) => {
  try {
    const bytes = readFileSync(`${TABLES_DIR}${url.slice(url.lastIndexOf("/") + 1)}`);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  } catch {
    return { ok: false, status: 404, statusText: "Not Found", arrayBuffer: async () => new ArrayBuffer(0) };
  }
};

function mapFixture(tableId: TableId = "law-n-justice"): TableMap {
  return {
    tableId,
    displayName: "Fixture",
    width: PLAYFIELD_WIDTH,
    height: PLAYFIELD_HEIGHT,
    pixels: new Uint8Array(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT),
    materialAt: () => 0,
  };
}

class RecordingBlit implements BlitContext {
  imageSmoothingEnabled = true;
  readonly draws: DrawCall[] = [];

  drawImage(image: CanvasImageSource, ...args: number[]): void {
    this.draws.push({ image, args, smoothing: this.imageSmoothingEnabled });
  }
}

const SCROLLING: CameraState = { scrollY: 100, mode: "scrolling" };
const FULL_TABLE: CameraState = { scrollY: 0, mode: "full-table" };

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

describe("the HD loaders read the shipped set", () => {
  it("loads, digest-verifies and sizes the law-n-justice HD master", async () => {
    const art = await loadTableArtHd("law-n-justice", fileFetch, "");
    expect(art.width).toBe(PLAYFIELD_WIDTH * HD_SCALE);
    expect(art.height).toBe(PLAYFIELD_HEIGHT * HD_SCALE);
    expect(art.data.length).toBe(art.width * art.height * 4);
    // A pixel with alpha: the decode produced opaque RGBA.
    expect(art.data[3]).toBe(255);
  });

  it("loads the lamp atlas with in-bounds patches", async () => {
    const lamps = await loadTableLampsHd("law-n-justice", fileFetch, "");
    expect(lamps.patches.length).toBe(38);
    for (const patch of lamps.patches) {
      expect(patch.atlasX + patch.width).toBeLessThanOrEqual(lamps.atlas.width);
      expect(patch.destX + patch.width).toBeLessThanOrEqual(PLAYFIELD_WIDTH * HD_SCALE);
    }
  });

  it("loads the ball and the 64-pose bat atlas", async () => {
    const ball = await loadTableBallHd("law-n-justice", fileFetch, "");
    expect(ball.width).toBe(68);
    expect(ball.height).toBe(68);
    const bats = await loadFlipperBatsHd("law-n-justice", fileFetch, "");
    expect(bats.cells.size).toBe(64);
    const rest = bats.cells.get(10);
    expect(rest).toBeDefined();
    expect(rest?.width).toBe(48 * HD_SCALE);
    expect(rest?.height).toBe(32 * HD_SCALE);
  });

  it("refuses a missing file, a corrupted digest and a wrong-size master", async () => {
    await expect(loadTableArtHd("law-n-justice", async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      arrayBuffer: async () => new ArrayBuffer(0),
    }), "")).rejects.toThrow(/404/);

    // A fetch that serves the real manifest but tampered image bytes.
    const tampered: TableArtFetch = async (url) => {
      const response = await fileFetch(url);
      if (!url.endsWith(".png")) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      bytes[5000] = (bytes[5000] ?? 0) ^ 0xff;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      };
    };
    await expect(loadTableArtHd("law-n-justice", tampered, "")).rejects.toThrow(/sha256/);

    // A fetch that serves a manifest whose claim matches a small (wrong-size)
    // image: the digest passes, the dimension gate must still refuse.
    const smallPng = encodePng(new Uint8Array(8 * 8 * 3).fill(50), 8, 8, 3);
    const smallDigest = await crypto.subtle.digest("SHA-256", Uint8Array.from(smallPng));
    const smallHex = [...new Uint8Array(smallDigest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const wrongSize: TableArtFetch = async (url) => {
      if (url.endsWith(".json")) {
        const manifest = JSON.stringify({
          schema: "pinball-illusions/table-art-hd/v1",
          tableId: "law-n-justice",
          image: { file: "law-n-justice.art-hd.png", sha256: smallHex },
        });
        const bytes = new TextEncoder().encode(manifest);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => bytes.buffer as ArrayBuffer,
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () =>
          smallPng.buffer.slice(smallPng.byteOffset, smallPng.byteOffset + smallPng.byteLength) as ArrayBuffer,
      };
    };
    await expect(loadTableArtHd("law-n-justice", wrongSize, "")).rejects.toThrow(/1344x2400/);
  });

  it("round-trips the exporter's RGB and RGBA encodings", async () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
    const decodedRgb = await decodeTruecolorPng(Uint8Array.from(encodePng(rgb, 2, 2, 3)));
    expect(decodedRgb.width).toBe(2);
    expect([...decodedRgb.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255]);

    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const decodedRgba = await decodeTruecolorPng(Uint8Array.from(encodePng(rgba, 2, 2, 4)));
    expect([...decodedRgba.data]).toEqual([...rgba]);
  });
});

// ---------------------------------------------------------------------------
// drawPlayfield: fallback and HD geometry
// ---------------------------------------------------------------------------

describe("drawPlayfield at HD", () => {
  it("with no HD master registered, the native path is untouched", async () => {
    const map = mapFixture();
    setPlayfieldArtwork(map, createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT));
    const context = new RecordingBlit();
    const { drawPlayfield } = await import("../src/browser/playfield-renderer.js");
    drawPlayfield(context, map, SCROLLING, 4);
    const draw = context.draws[0];
    expect(draw).toBeDefined();
    expect(draw?.smoothing).toBe(false);
    // Native source rectangle: unmultiplied.
    expect(draw?.args).toEqual([0, 100, PLAYFIELD_WIDTH, VIEWPORT_HEIGHT, 0, 0, PLAYFIELD_WIDTH * 4, VIEWPORT_HEIGHT * 4]);
  });

  it("with an HD master, multiplies the source rectangle by 4 and nothing else", async () => {
    const map = mapFixture();
    setPlayfieldArtwork(map, createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT));
    setPlayfieldArtworkHd(map, createPixelTarget(PLAYFIELD_WIDTH * HD_SCALE, PLAYFIELD_HEIGHT * HD_SCALE));
    const context = new RecordingBlit();
    const { drawPlayfield } = await import("../src/browser/playfield-renderer.js");
    drawPlayfield(context, map, SCROLLING, 4);
    const draw = context.draws[0];
    expect(draw?.image).toBe(playfieldImageSourceHd(map));
    // The scrolling blit is 1:1 at scale 4 and stays nearest.
    expect(draw?.smoothing).toBe(false);
    expect(draw?.args).toEqual([
      0,
      100 * HD_SCALE,
      PLAYFIELD_WIDTH * HD_SCALE,
      VIEWPORT_HEIGHT * HD_SCALE,
      0,
      0,
      PLAYFIELD_WIDTH * 4,
      VIEWPORT_HEIGHT * 4,
    ]);
  });

  it("full-table mode downsamples the whole HD board with bilinear", async () => {
    const map = mapFixture();
    setPlayfieldArtwork(map, createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT));
    setPlayfieldArtworkHd(map, createPixelTarget(PLAYFIELD_WIDTH * HD_SCALE, PLAYFIELD_HEIGHT * HD_SCALE));
    const context = new RecordingBlit();
    const { drawPlayfield } = await import("../src/browser/playfield-renderer.js");
    drawPlayfield(context, map, FULL_TABLE, 4);
    const draw = context.draws[0];
    expect(draw?.smoothing).toBe(true);
    const viewScale = VIEWPORT_HEIGHT / PLAYFIELD_HEIGHT;
    expect(draw?.args).toEqual([
      0,
      0,
      PLAYFIELD_WIDTH * HD_SCALE,
      PLAYFIELD_HEIGHT * HD_SCALE,
      0,
      0,
      PLAYFIELD_WIDTH * viewScale * 4,
      PLAYFIELD_HEIGHT * viewScale * 4,
    ]);
  });

  it("withdrawing the HD master restores the native path", async () => {
    const map = mapFixture();
    setPlayfieldArtwork(map, createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT));
    setPlayfieldArtworkHd(map, createPixelTarget(PLAYFIELD_WIDTH * HD_SCALE, PLAYFIELD_HEIGHT * HD_SCALE));
    setPlayfieldArtworkHd(map, null);
    const context = new RecordingBlit();
    const { drawPlayfield } = await import("../src/browser/playfield-renderer.js");
    drawPlayfield(context, map, SCROLLING, 4);
    expect(context.draws[0]?.args[2]).toBe(PLAYFIELD_WIDTH);
    expect(playfieldImageSourceHd(map)).toBeNull();
  });

  it("refuses an HD master that is not exactly 4x", () => {
    const map = mapFixture();
    expect(() => setPlayfieldArtworkHd(map, createPixelTarget(1280, 2400))).toThrow(/1344x2400/);
  });
});

// ---------------------------------------------------------------------------
// The HD lamp path
// ---------------------------------------------------------------------------

describe("drawLampOverlays at HD", () => {
  async function hdLampSetup(): Promise<{
    map: TableMap;
    lamps: ReturnType<typeof lampsFor>;
    doc: TableLampsHd;
  }> {
    const map = mapFixture();
    setPlayfieldArtworkHd(map, createPixelTarget(PLAYFIELD_WIDTH * HD_SCALE, PLAYFIELD_HEIGHT * HD_SCALE));
    const doc = await loadTableLampsHd("law-n-justice", fileFetch, "");
    setLampOverlaysHd(map, doc);
    return { map, lamps: lampsFor("law-n-justice"), doc };
  }

  it("with every lamp dark, draws every patch at its recorded HD rectangle", async () => {
    const { map, lamps, doc } = await hdLampSetup();
    const context = new RecordingBlit();
    drawLampOverlays(context, map, SCROLLING, 4, lamps, null, 0);

    const overlay = overlayOf(PLAYFIELD_WIDTH * HD_SCALE, PLAYFIELD_HEIGHT * HD_SCALE);
    expect(overlay.context.draws.length).toBe(doc.patches.length);
    for (const [i, patch] of doc.patches.entries()) {
      expect(overlay.context.draws[i]?.args).toEqual([patch.destX, patch.destY]);
    }
    // The overlay blit multiplies the source rectangle by 4.
    expect(context.draws[0]?.args).toEqual([
      0,
      100 * HD_SCALE,
      PLAYFIELD_WIDTH * HD_SCALE,
      VIEWPORT_HEIGHT * HD_SCALE,
      0,
      0,
      PLAYFIELD_WIDTH * 4,
      VIEWPORT_HEIGHT * 4,
    ]);
  });

  it("skips exactly the lamps lampVisible lights, on the same tick arithmetic", async () => {
    const { map, lamps, doc } = await hdLampSetup();
    // Arm every element, which drives every wired lamp to BLINKING: at tick 0
    // the blink phase shows them all lit, at tick 8 dark again.
    const armed = new Uint8Array(1024).fill(1);
    const state = { armed, awardLit: new Uint8Array(1024) } as unknown as ModeState;
    const modes = lampModes(lamps, state);

    const context = new RecordingBlit();
    drawLampOverlays(context, map, SCROLLING, 4, lamps, state, 0);
    const overlay = overlayOf(PLAYFIELD_WIDTH * HD_SCALE, PLAYFIELD_HEIGHT * HD_SCALE);
    const expectDark = doc.patches.filter(
      (patch) => !lampVisible(modes[patch.index] ?? 0, 0, lamps.blinkHalfPeriodFrames),
    );
    expect(overlay.context.draws.length).toBe(expectDark.length);
    // Some lamps on this table are wired to elements, so the two tick phases
    // really differ — this test would be vacuous otherwise.
    expect(expectDark.length).toBeLessThan(doc.patches.length);

    const later = new RecordingBlit();
    drawLampOverlays(later, map, SCROLLING, 4, lamps, state, lamps.blinkHalfPeriodFrames);
    const expectDarkLater = doc.patches.filter(
      (patch) => !lampVisible(modes[patch.index] ?? 0, lamps.blinkHalfPeriodFrames, lamps.blinkHalfPeriodFrames),
    );
    // The blink phase flipped: the dark set grew back to everything wired.
    expect(expectDarkLater.length).toBeGreaterThan(expectDark.length);
  });

  it("without the HD master, the native overlay path draws instead", async () => {
    const map = mapFixture();
    const doc = await loadTableLampsHd("law-n-justice", fileFetch, "");
    setLampOverlaysHd(map, doc); // atlas present, master absent
    const art = await loadTableArt("law-n-justice", fileFetch, "");
    setPlayfieldArtwork(map, art);
    const context = new RecordingBlit();
    drawLampOverlays(context, map, SCROLLING, 4, lampsFor("law-n-justice"), null, 0);
    // The blit read the NATIVE overlay: source rectangle unmultiplied.
    expect(context.draws[0]?.args).toEqual([0, 100, PLAYFIELD_WIDTH, VIEWPORT_HEIGHT, 0, 0, PLAYFIELD_WIDTH * 4, VIEWPORT_HEIGHT * 4]);
    expect(context.draws[0]?.smoothing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HD sprite placements and occlusion
// ---------------------------------------------------------------------------

describe("HD moving sprites", () => {
  async function spriteSetup(): Promise<{
    map: TableMap;
    sprites: ReturnType<typeof buildMovingSprites>;
    assets: MovingSpritesHd;
  }> {
    const map = mapFixture();
    const art = await loadTableArt("law-n-justice", fileFetch, "");
    setPlayfieldArtwork(map, art);
    const bats = flipperBatsFixture();
    const ball = ballFor("law-n-justice");
    const sprites = buildMovingSprites(art, bats, ball);
    const assets: MovingSpritesHd = {
      ball: await loadTableBallHd("law-n-justice", fileFetch, ""),
      bats: await loadFlipperBatsHd("law-n-justice", fileFetch, ""),
    };
    return { map, sprites, assets };
  }

  /** The lower-left Law 'n Justice bat at rest, as the simulation frames it. */
  function restingBat(): BatFrameState {
    return {
      id: "lower-left",
      stroke: 0,
      sweep: 18 * 64,
      pivotX: pixelsToQ10(86),
      pivotY: pixelsToQ10(556),
    };
  }

  it("places a resting bat at the simulation pivot minus the scaled anchor", async () => {
    const { sprites, assets } = await spriteSetup();
    const placements = hdMovingSpritePlacements(sprites, assets, [restingBat()], []);
    expect(placements).not.toBeNull();
    const bat = placements?.[0];
    const record = sprites.bats.get("lower-left");
    expect(bat?.key).toBe(record?.restPose);
    const pose = sprites.poses.get(record?.restPose ?? -1);
    expect(bat?.x).toBe(86 * HD_SCALE - (pose?.anchorX ?? 0) * HD_SCALE);
    expect(bat?.y).toBe(556 * HD_SCALE - (pose?.anchorY ?? 0) * HD_SCALE);
    expect(bat?.width).toBe((pose?.width ?? 0) * HD_SCALE);
  });

  it("places balls in quarter-native-pixel steps", async () => {
    const { sprites, assets } = await spriteSetup();
    const at = (q10: number): number => {
      const placements = hdMovingSpritePlacements(
        sprites,
        assets,
        [],
        [{ id: 0, x: q10, y: pixelsToQ10(300), level: 0 }],
      );
      const x = placements?.[0]?.x;
      if (x === undefined) throw new Error("no ball placement");
      return x;
    };
    const base = pixelsToQ10(100);
    // Four sub-pixel positions inside one native pixel: four HD pixels.
    expect([at(base), at(base + 256), at(base + 512), at(base + 768)]).toEqual([
      400 - sprites.ballCentreX * HD_SCALE,
      401 - sprites.ballCentreX * HD_SCALE,
      402 - sprites.ballCentreX * HD_SCALE,
      403 - sprites.ballCentreX * HD_SCALE,
    ]);
    // The native path would put all four on the same pixel; the HD y matches
    // the same mapping the pin test covers.
    expect(at(base + 1023)).toBe(403 - sprites.ballCentreX * HD_SCALE);
  });

  it("returns null — sending the caller to the loud native path — when a pose cell is missing", async () => {
    const { sprites, assets } = await spriteSetup();
    const gapped: MovingSpritesHd = {
      ball: assets.ball,
      bats: {
        tableId: assets.bats.tableId,
        atlas: assets.bats.atlas,
        cells: new Map([...assets.bats.cells].filter(([pose]) => pose !== 10)),
      },
    };
    expect(hdMovingSpritePlacements(sprites, gapped, [restingBat()], [])).toBeNull();
    // With the full set it resolves.
    expect(hdMovingSpritePlacements(sprites, assets, [restingBat()], [])).not.toBeNull();
  });

  it("occludes the HD ball per native structure pixel, floor(hd/4)", async () => {
    const { assets } = await spriteSetup();
    const placement = {
      kind: "ball" as const,
      key: 0,
      x: 352,
      y: 1200,
      width: 68,
      height: 68,
      level: 0 as const,
    };
    const out = new Uint8ClampedArray(68 * 68 * 4);
    // A wall covering native columns >= 95: HD columns >= 380.
    hdBallFace(assets, placement, { blocks: (x) => x >= 95 }, out);
    for (let y = 0; y < 68; y += 1) {
      for (let x = 0; x < 68; x += 1) {
        const at = (y * 68 + x) * 4;
        const source = assets.ball.data[at + 3] ?? 0;
        const expected = Math.floor((placement.x + x) / HD_SCALE) >= 95 ? 0 : source;
        if ((out[at + 3] ?? 0) !== expected) {
          throw new Error(`alpha at ${x},${y}: ${out[at + 3]} != ${expected}`);
        }
      }
    }
  });

  it("draws the frame through the 4x overlay with the source rectangle multiplied", async () => {
    const { map, assets } = await spriteSetup();
    setPlayfieldArtworkHd(map, createPixelTarget(PLAYFIELD_WIDTH * HD_SCALE, PLAYFIELD_HEIGHT * HD_SCALE));
    setMovingSpritesHd(map, assets);
    const context = new RecordingBlit();
    drawMovingSprites(
      context,
      map,
      SCROLLING,
      4,
      flipperBatsFixture(),
      ballFor("law-n-justice"),
      [restingBat()],
      [{ id: 0, x: pixelsToQ10(160), y: pixelsToQ10(300), level: 0 }],
    );
    const overlay = overlayOf(PLAYFIELD_WIDTH * HD_SCALE, PLAYFIELD_HEIGHT * HD_SCALE);
    // One bat, one ball landed on the overlay.
    expect(overlay.context.draws.length).toBe(2);
    expect(context.draws[0]?.args).toEqual([
      0,
      100 * HD_SCALE,
      PLAYFIELD_WIDTH * HD_SCALE,
      VIEWPORT_HEIGHT * HD_SCALE,
      0,
      0,
      PLAYFIELD_WIDTH * 4,
      VIEWPORT_HEIGHT * 4,
    ]);
    expect(context.draws[0]?.smoothing).toBe(false);
  });

  it("falls back to the native overlay when the HD sprite set is withdrawn", async () => {
    const { map, assets } = await spriteSetup();
    setPlayfieldArtworkHd(map, createPixelTarget(PLAYFIELD_WIDTH * HD_SCALE, PLAYFIELD_HEIGHT * HD_SCALE));
    setMovingSpritesHd(map, assets);
    setMovingSpritesHd(map, null);
    const context = new RecordingBlit();
    drawMovingSprites(
      context,
      map,
      SCROLLING,
      4,
      flipperBatsFixture(),
      ballFor("law-n-justice"),
      [restingBat()],
      [],
    );
    // Source rectangle unmultiplied: the native overlay was blitted.
    expect(context.draws[0]?.args).toEqual([0, 100, PLAYFIELD_WIDTH, VIEWPORT_HEIGHT, 0, 0, PLAYFIELD_WIDTH * 4, VIEWPORT_HEIGHT * 4]);
  });
});
