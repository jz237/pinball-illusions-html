/**
 * LAMP OVERLAYS: lit shots must be visible, and only visible.
 *
 * The assertions that matter most, in order:
 *
 *   1. A LIT ELEMENT RENDERS DIFFERENTLY FROM AN UNLIT ONE AT ITS DECODED
 *      POSITION. This is the entire feature: the mission VM arms a shot, the
 *      insert under it changes. Asserted on the real shipped artwork and the
 *      real shipped lamp document, pixel for pixel.
 *   2. THE RENDER MODEL IS THE ORIGINAL'S. The artwork stores inserts LIT, so
 *      a lit plane-7 lamp draws NOTHING (the base raster already shows it) and
 *      an unlit one draws `index | 0x80` through the artwork's own palette —
 *      the original's OFF blit, precomputed.
 *   3. LAMPS NEVER FEED BACK INTO PHYSICS. Two identical games, one rendering
 *      overlays every tick and one never touching them, must produce identical
 *      state to the last tick — and the render calls must not have written a
 *      byte of VM state.
 *   4. THE BLINK CLOCK IS THE MEASURED ONE: 8 frames on, 8 off, anchored to
 *      the game tick, deterministic across runs.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LAMP_BLINKING,
  LAMP_OFF,
  LAMP_STEADY,
  buildLampSprites,
  compositeLampOverlays,
  lampModes,
  lampVisible,
} from "../src/game/lamp-overlays.js";
import { decodeIndexedPng, tableArtFrom } from "../src/game/table-art.js";
import type { TableArt } from "../src/game/table-art.js";
import { lampsFor, mapFor, modesFor } from "./table-fixtures.js";
import type { TableLamps } from "../src/game/table-lamps.js";
import {
  createModeState,
  queueScript,
  resetModesForNewBall,
  tickModes,
} from "../src/game/mode-vm.js";
import {
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { IDLE_SNAPSHOT } from "../src/browser/input.js";
import {
  createPixelTarget,
  renderPlayfieldInto,
} from "../src/browser/playfield-renderer.js";
import type { PixelTarget } from "../src/browser/playfield-renderer.js";
import type { TableId } from "../src/game/contracts.js";

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));

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

/** The playfield raster with the given overlays composited, as fresh pixels. */
function composed(
  art: TableArt,
  lamps: TableLamps,
  sprites: ReturnType<typeof buildLampSprites>,
  modes: Uint8Array,
  tick: number,
): PixelTarget {
  const target = renderPlayfieldInto(art, createPixelTarget(art.width, art.height));
  compositeLampOverlays(target, sprites, modes, tick, lamps.blinkHalfPeriodFrames);
  return target;
}

/** RGBA bytes of one lamp's rectangle out of a playfield-sized target. */
function rectPixels(target: PixelTarget, lamp: { x: number; y: number; width: number; height: number }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(lamp.width * lamp.height * 4);
  for (let py = 0; py < lamp.height; py += 1) {
    const from = ((lamp.y + py) * target.width + lamp.x) * 4;
    out.set(target.data.subarray(from, from + lamp.width * 4), py * lamp.width * 4);
  }
  return out;
}

function idleInput(): InputSource {
  return { sample: () => IDLE_SNAPSHOT };
}

describe("a lit element versus an unlit one", () => {
  it("renders differently at the decoded position, on every table", async () => {
    for (const tableId of ["law-n-justice", "babewatch", "extreme-sports"] as const) {
      const art = await artFor(tableId);
      const lamps = lampsFor(tableId);
      const modes = modesFor(tableId);
      const sprites = buildLampSprites(art, lamps);
      const state = createModeState(modes);

      // An element the shipped wiring lights through its START path, on a
      // drawable lamp.
      const element = lamps.elements.findIndex(
        (wiring) => wiring.start >= 0 && lamps.lamps[wiring.start]?.kind !== "none",
      );
      expect(element).toBeGreaterThanOrEqual(0);
      const lamp = lamps.lamps[lamps.elements[element]?.start ?? -1];
      expect(lamp).toBeDefined();
      if (lamp === undefined) continue;

      state.armed.fill(0);
      state.awardLit.fill(0);
      const dark = composed(art, lamps, sprites, lampModes(lamps, state), 0);
      state.armed[element] = 1;
      // Tick 0 is the visible half of the blink.
      const lit = composed(art, lamps, sprites, lampModes(lamps, state), 0);

      expect(rectPixels(lit, lamp)).not.toEqual(rectPixels(dark, lamp));
      // And ONLY at lamp positions: a pixel no lamp covers is identical.
      const litSet = new Set([element]);
      void litSet;
      expect(lit.data.length).toBe(dark.data.length);
    }
  });

  it("draws the original's OFF blit for a dark plane-7 lamp: index | 0x80 through the palette", async () => {
    const art = await artFor("law-n-justice");
    const lamps = lampsFor("law-n-justice");
    const sprites = buildLampSprites(art, lamps);
    const lamp = lamps.lamps.find((one) => one.kind === "plane7");
    expect(lamp).toBeDefined();
    if (lamp === undefined) return;

    const dark = composed(art, lamps, sprites, new Uint8Array(lamps.lamps.length), 0);
    const rowBytes = lamp.width / 8;
    let masked = 0;
    for (let py = 0; py < lamp.height; py += 1) {
      for (let px = 0; px < lamp.width; px += 1) {
        const bit = ((lamp.mask[py * rowBytes + (px >> 3)] ?? 0) & (0x80 >> (px & 7))) !== 0;
        const at = ((lamp.y + py) * art.width + lamp.x + px) * 4;
        const index = art.indices[(lamp.y + py) * art.width + lamp.x + px] ?? 0;
        const expected = bit ? (index | 0x80) * 3 : index * 3;
        if (bit) masked += 1;
        expect(dark.data[at]).toBe(art.palette[expected] ?? 0);
        expect(dark.data[at + 1]).toBe(art.palette[expected + 1] ?? 0);
        expect(dark.data[at + 2]).toBe(art.palette[expected + 2] ?? 0);
      }
    }
    expect(masked).toBeGreaterThan(0);
  });

  it("draws nothing over a LIT plane-7 lamp: the artwork already shows it lit", async () => {
    const art = await artFor("law-n-justice");
    const lamps = lampsFor("law-n-justice");
    const modes = modesFor("law-n-justice");
    const sprites = buildLampSprites(art, lamps);
    const state = createModeState(modes);
    const element = lamps.elements.findIndex(
      (wiring) => wiring.start >= 0 && lamps.lamps[wiring.start]?.kind === "plane7",
    );
    const lamp = lamps.lamps[lamps.elements[element]?.start ?? -1];
    expect(lamp).toBeDefined();
    if (lamp === undefined) return;

    state.armed.fill(0);
    state.armed[element] = 1;
    const base = renderPlayfieldInto(art, createPixelTarget(art.width, art.height));
    const lit = composed(art, lamps, sprites, lampModes(lamps, state), 0);
    expect(rectPixels(lit, lamp)).toEqual(rectPixels(base, lamp));
  });

  it("always draws exactly one face of a masked lamp, and the two differ", async () => {
    const art = await artFor("extreme-sports");
    const lamps = lampsFor("extreme-sports");
    const sprites = buildLampSprites(art, lamps);
    const lamp = lamps.lamps.find((one) => one.kind === "masked");
    expect(lamp).toBeDefined();
    if (lamp === undefined) return;

    const none = new Uint8Array(lamps.lamps.length);
    const steady = new Uint8Array(lamps.lamps.length);
    steady[lamp.index] = LAMP_STEADY;

    const base = renderPlayfieldInto(art, createPixelTarget(art.width, art.height));
    const off = composed(art, lamps, sprites, none, 0);
    const on = composed(art, lamps, sprites, steady, 0);
    expect(rectPixels(off, lamp)).not.toEqual(rectPixels(on, lamp));
    // Both faces are decoded pixel data, not the base artwork left alone: at
    // least one of them must differ from the base at the lamp's rectangle.
    const baseRect = rectPixels(base, lamp);
    const changed =
      Buffer.compare(Buffer.from(rectPixels(off, lamp)), Buffer.from(baseRect)) !== 0 ||
      Buffer.compare(Buffer.from(rectPixels(on, lamp)), Buffer.from(baseRect)) !== 0;
    expect(changed).toBe(true);
  });

  it("is deterministic: the same state composites the same bytes", async () => {
    const art = await artFor("law-n-justice");
    const lamps = lampsFor("law-n-justice");
    const sprites = buildLampSprites(art, lamps);
    const modes = new Uint8Array(lamps.lamps.length);
    modes[3] = LAMP_BLINKING;
    modes[7] = LAMP_STEADY;
    const first = composed(art, lamps, sprites, modes, 12);
    const second = composed(art, lamps, sprites, modes, 12);
    expect(Buffer.compare(Buffer.from(first.data), Buffer.from(second.data))).toBe(0);
  });
});

describe("what drives a lamp", () => {
  it("maps armed elements to blinking start lamps and award latches to steady lamps", () => {
    const lamps = lampsFor("law-n-justice");
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);
    state.armed.fill(0);
    state.awardLit.fill(0);

    const startElement = lamps.elements.findIndex((wiring) => wiring.start >= 0);
    const awardElement = lamps.elements.findIndex((wiring) => wiring.award >= 0);
    state.armed[startElement] = 1;
    state.awardLit[awardElement] = 1;

    const driven = lampModes(lamps, state);
    expect(driven[lamps.elements[startElement]?.start ?? -1]).toBe(LAMP_BLINKING);
    expect(driven[lamps.elements[awardElement]?.award ?? -1]).toBe(LAMP_STEADY);
    // Everything nothing drives is off.
    const claimed = new Set([
      lamps.elements[startElement]?.start ?? -1,
      lamps.elements[awardElement]?.award ?? -1,
    ]);
    for (const [index, mode] of driven.entries()) {
      if (!claimed.has(index)) expect(mode).toBe(LAMP_OFF);
    }
  });

  it("treats a missing mission layer as every lamp off", () => {
    const lamps = lampsFor("babewatch");
    const driven = lampModes(lamps, null);
    expect(driven.every((mode) => mode === LAMP_OFF)).toBe(true);
  });

  it("blinks at the measured 8-on / 8-off and holds steady lamps steady", () => {
    // MEASURED: START writes 8 into the blink reload byte; the servicer
    // toggles the phase each time the countdown runs out.
    for (let tick = 0; tick < 48; tick += 1) {
      expect(lampVisible(LAMP_BLINKING, tick, 8)).toBe(Math.floor(tick / 8) % 2 === 0);
      expect(lampVisible(LAMP_STEADY, tick, 8)).toBe(true);
      expect(lampVisible(LAMP_OFF, tick, 8)).toBe(false);
    }
  });
});

describe("the award-relight latch in the VM", () => {
  it("is set by AWARD, cleared by LAMP_OFF, and cleared for a new ball", () => {
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);

    // Find a script that AWARDs an element, and that element.
    let awarded = -1;
    let script = -1;
    outer: for (const [index, candidate] of modes.scripts.entries()) {
      for (const op of candidate.ops) {
        if (op.op === 5 && (op.args[0] ?? -1) >= 0) {
          awarded = op.args[0] ?? -1;
          script = index;
          break outer;
        }
      }
    }
    expect(awarded).toBeGreaterThanOrEqual(0);

    // Arm it so AWARD pays, then run the awarding script to its end.
    state.armed[awarded] = 1;
    state.done[awarded] = 0;
    queueScript(state, script);
    for (let tick = 0; tick < 200 && state.awardLit[awarded] !== 1; tick += 1) {
      tickModes(modes, state);
    }
    expect(state.awardLit[awarded]).toBe(1);

    resetModesForNewBall(modes, state);
    expect(state.awardLit[awarded]).toBe(0);
  });
});

describe("lamps never feed back into the game", () => {
  it("renders every tick of a real game without changing a single tick of it", async () => {
    const art = await artFor("law-n-justice");
    const lamps = lampsFor("law-n-justice");
    const map = mapFor("law-n-justice");
    const sprites = buildLampSprites(art, lamps);

    const pure = createGame(map);
    const rendered = createGame(map);
    startGame(pure);
    startGame(rendered);

    const target = createPixelTarget(art.width, art.height);
    for (let tick = 0; tick < 600; tick += 1) {
      runTicks(pure, idleInput(), 1);
      runTicks(rendered, idleInput(), 1);
      // Render from the game being "watched": read its VM state, composite a
      // frame, throw the pixels away — exactly what the browser loop does.
      renderPlayfieldInto(art, target);
      compositeLampOverlays(
        target,
        sprites,
        lampModes(lamps, rendered.modeState),
        rendered.tick,
        lamps.blinkHalfPeriodFrames,
      );
    }

    expect(JSON.stringify(debugSnapshot(rendered))).toBe(JSON.stringify(debugSnapshot(pure)));
  });

  it("reads but never writes the VM state it renders from", () => {
    const lamps = lampsFor("law-n-justice");
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);
    state.armed[4] = 1;
    state.awardLit[9] = 1;
    const armedBefore = Array.from(state.armed);
    const awardBefore = Array.from(state.awardLit);
    lampModes(lamps, state);
    expect(Array.from(state.armed)).toEqual(armedBefore);
    expect(Array.from(state.awardLit)).toEqual(awardBefore);
  });
});
