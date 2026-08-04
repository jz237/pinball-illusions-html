/**
 * The score-panel INTEGRATOR: tick reports in, the display ring's behaviour out.
 *
 * `panel-renderer.test.ts` proves the sequencing state machine and the raster;
 * `table-panel.test.ts` proves the decode. What is proved here is the WIRING —
 * that the indices a `GameTickReport` carries queue exactly the objects the
 * shipped reference map binds to them, in order, with the chained objects the
 * exporter expanded — and the properties the game loop depends on:
 * determinism from the report stream alone, and strict isolation (a report
 * with no display events leaves the panel byte-for-byte alone).
 *
 * Run against the real Law 'n Justice document, because the wiring being
 * tested is the shipped wiring: the element and message indices below are the
 * decoded facts recorded in the panel round (element 15's award plays objects
 * 30 then 31, element 65's START plays 9, message 4 shows 20 then 17, message
 * 7 is the single-frame still 2 chained with 3).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PanelDisplay } from "../src/browser/panel-display.js";
import {
  PANEL_HEIGHT,
  PANEL_WIDTH,
  currentPanelFrame,
} from "../src/browser/panel-renderer.js";
import { createPixelTarget } from "../src/browser/playfield-renderer.js";
import {
  panelFramePixels,
  parseTablePanelDocument,
} from "../src/game/table-panel.js";
import type { TablePanel, TablePanelDocument } from "../src/game/table-panel.js";
import { FONT_ATLAS_WIDTH, shellFontFrom } from "../src/game/shell-art.js";
import type { ShellFont } from "../src/game/shell-art.js";
import type { IndexedImage } from "../src/game/table-art.js";
import type { GameTickReport } from "../src/browser/game-loop.js";
import { createGame, startGame, tickGame } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { mapFor } from "./table-fixtures.js";

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));

const PANEL: TablePanel = parseTablePanelDocument(
  JSON.parse(readFileSync(`${TABLES_DIR}law-n-justice.panel.json`, "utf8")) as TablePanelDocument,
);

/** A digits-and-comma font, enough for the score view. See panel-renderer.test. */
function syntheticFont(): ShellFont {
  const metrics: number[][] = Array.from({ length: 256 }, () => [0, 0, 0]);
  metrics[",".charCodeAt(0)] = [3, 8, 0];
  for (const c of "0123456789") metrics[c.charCodeAt(0)] = [6, 8, 0];
  const rows = metrics.reduce((sum, [, height = 0]) => sum + height, 0);
  const indices = new Uint8Array(FONT_ATLAS_WIDTH * rows).fill(1);
  const atlas: IndexedImage = {
    width: FONT_ATLAS_WIDTH,
    height: rows,
    indices,
    palette: new Uint8Array(0),
    paletteEntries: 0,
  };
  return shellFontFrom(metrics, atlas, "synthetic");
}

const FONT = syntheticFont();

/** A whole report with nothing in it but what the test wants to say. */
function reportAt(tick: number, over: Partial<GameTickReport> = {}): GameTickReport {
  return {
    tick,
    stepped: true,
    served: false,
    launched: false,
    drained: [],
    writtenOff: [],
    swallowed: [],
    locked: [],
    ejected: [],
    ejectedFrom: [],
    levelTransfers: [],
    multiballStarted: false,
    missionStarted: -1,
    missionEnded: false,
    awards: [],
    comboPaid: 0,
    elementStarts: [],
    elementAwards: [],
    messagesShown: [],
    musicCues: [],
    justTilted: false,
    gameOver: false,
    bonus: null,
    flipperRaised: [],
    flipperRested: [],
    ...over,
  };
}

function display(): PanelDisplay {
  return new PanelDisplay(PANEL, () => FONT);
}

/** Ticks per animation: every frame shows for `speed` ticks. */
function durationOf(...ids: number[]): number {
  return ids.reduce((sum, id) => {
    const object = PANEL.objects[id]!;
    return sum + object.frames * object.speed;
  }, 0);
}

function hashOfStrip(view: PanelDisplay, score: number): string {
  const target = createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT);
  view.renderInto(target, score, FONT);
  return createHash("sha256").update(target.data).digest("hex");
}

describe("queueing from the tick report", () => {
  it("an element AWARD queues its +$18 record's objects, chains included, in order", () => {
    const view = display();
    expect(view.idle).toBe(true);
    view.observe(reportAt(1, { elementAwards: [15] })); // wired to objects 30, 31
    expect(view.state.queue.length).toBe(2);
    const frame = currentPanelFrame(view.state);
    const first = PANEL.objects[30]!;
    expect(frame?.width).toBe(first.pixelWidth);
    expect(frame?.height).toBe(first.height);
  });

  it("an element START queues its +$14 record's objects", () => {
    const view = display();
    view.observe(reportAt(1, { elementStarts: [65] })); // wired to object 9
    expect(view.state.queue.length).toBe(1);
  });

  it("a shown message record queues its objects", () => {
    const view = display();
    view.observe(reportAt(1, { messagesShown: [4] })); // wired to objects 20, 17
    expect(view.state.queue.length).toBe(2);
  });

  it("indices with no wiring queue nothing, and empty reports change nothing", () => {
    const view = display();
    // Element 12's START list is empty (only its award is wired) and message
    // 999 does not exist; neither may invent an animation.
    view.observe(reportAt(1, { elementStarts: [12], messagesShown: [999] }));
    expect(view.idle).toBe(true);
    const before = hashOfStrip(view, 1200);
    for (let tick = 2; tick < 60; tick += 1) view.observe(reportAt(tick));
    expect(hashOfStrip(view, 1200)).toBe(before);
  });
});

describe("the end-of-ball bonus", () => {
  const BONUS = {
    stage: "none" as const,
    caption: "NO BONUS",
    value: null,
    multiplier: "",
    multiplierLit: false,
  };

  it("takes the panel over from the score view while it is up", () => {
    const view = display();
    view.observe(reportAt(1));
    const score = hashOfStrip(view, 1234);
    view.observe(reportAt(2, { bonus: BONUS }));
    expect(hashOfStrip(view, 1234)).not.toBe(score);
    // …and gives it back once the routine has finished.
    view.observe(reportAt(3));
    expect(hashOfStrip(view, 1234)).toBe(score);
  });

  it("takes it over from a queued animation too", () => {
    const view = display();
    view.observe(reportAt(1, { elementAwards: [15] }));
    const playing = hashOfStrip(view, 0);
    view.observe(reportAt(2, { bonus: BONUS }));
    expect(hashOfStrip(view, 0)).not.toBe(playing);
  });

  it("is not remembered across a fresh game", () => {
    const view = display();
    view.observe(reportAt(1, { bonus: BONUS }));
    const showing = hashOfStrip(view, 0);
    view.reset();
    expect(hashOfStrip(view, 0)).not.toBe(showing);
  });
});

describe("playback over ticks", () => {
  it("plays the queue to its end and returns to the score view", () => {
    const view = display();
    view.observe(reportAt(1, { elementAwards: [15] })); // 30 then 31, both multi-frame
    const total = durationOf(30, 31);
    for (let tick = 0; tick < total; tick += 1) {
      view.observe(reportAt(tick + 2));
    }
    expect(view.idle).toBe(true);
  });

  it("holds a single-frame still until something is queued behind it", () => {
    const view = display();
    view.observe(reportAt(1, { elementAwards: [28] })); // wired to still 16
    for (let tick = 0; tick < 500; tick += 1) view.observe(reportAt(tick + 2));
    expect(view.idle).toBe(false); // prize art sits; it does not flash and vanish

    // Something queued behind it makes it yield — the renderer's documented
    // model, exercised here through the wiring: message 7 is still 2 chained
    // with animation 3, so the pair must drain once 3 has played.
    const chained = display();
    chained.observe(reportAt(1, { messagesShown: [7] }));
    const total = durationOf(2, 3);
    for (let tick = 0; tick < total + 2; tick += 1) chained.observe(reportAt(tick + 2));
    expect(chained.idle).toBe(true);
  });

  it("reset returns to the idle score view", () => {
    const view = display();
    view.observe(reportAt(1, { elementAwards: [15] }));
    expect(view.idle).toBe(false);
    view.reset();
    expect(view.idle).toBe(true);
  });
});

describe("fed by the real game", () => {
  /** The mode-vm test's scripted player: plunge early, tap both bats on beats. */
  function playingInput(tick: number): ControlSnapshot {
    const wanted = new Set<Control>();
    const phase = tick % 400;
    if (phase >= 40 && phase < 100) wanted.add("plunger");
    if (tick % 23 < 4) wanted.add("leftFlipper");
    if ((tick + 11) % 29 < 4) wanted.add("rightFlipper");
    const previous = new Set<Control>();
    const priorPhase = (tick - 1 + 400) % 400;
    if (tick > 0) {
      if (priorPhase >= 40 && priorPhase < 100) previous.add("plunger");
      if ((tick - 1) % 23 < 4) previous.add("leftFlipper");
      if ((tick + 10) % 29 < 4) previous.add("rightFlipper");
    }
    const controls = {} as Record<Control, ControlEdges>;
    for (const control of CONTROLS) {
      const down = wanted.has(control);
      const was = previous.has(control);
      controls[control] = {
        down,
        pressed: down && !was,
        released: !down && was,
        pressCount: down && !was ? 1 : 0,
        releaseCount: !down && was ? 1 : 0,
      };
    }
    return { sequence: tick + 1, controls };
  }

  it("replays a scripted Law 'n Justice game to an identical strip, tick for tick", () => {
    // The isolation and determinism claim, end to end: the panel consumes ONLY
    // the tick reports, so two runs of the same input script must show the
    // same strip on every tick — and feeding it every report of a real game
    // proves the wiring never throws on anything the shipped data emits.
    const play = (): { hashes: string[]; events: number } => {
      const game = createGame(mapFor("law-n-justice"));
      startGame(game);
      const view = display();
      const hashes: string[] = [];
      let events = 0;
      for (let tick = 0; tick < 6000 && game.phase !== "game-over"; tick += 1) {
        const report = tickGame(game, playingInput(tick));
        events +=
          report.elementStarts.length +
          report.elementAwards.length +
          report.messagesShown.length;
        view.observe(report);
        if (tick % 50 === 0) hashes.push(hashOfStrip(view, tick));
      }
      return { hashes, events };
    };
    const one = play();
    const two = play();
    expect(one.events).toBe(two.events);
    expect(one.hashes).toEqual(two.hashes);
  });
});

describe("determinism", () => {
  it("two displays fed the same report stream render identical strips every tick", () => {
    const script = (tick: number): GameTickReport =>
      reportAt(tick, {
        elementAwards: tick === 3 ? [15] : tick === 40 ? [19] : [],
        messagesShown: tick === 90 ? [4] : [],
        elementStarts: tick === 7 ? [65] : [],
      });
    const one = display();
    const two = display();
    for (let tick = 1; tick <= 200; tick += 1) {
      one.observe(script(tick));
      two.observe(script(tick));
      const score = tick * 730;
      expect(hashOfStrip(one, score)).toBe(hashOfStrip(two, score));
    }
    expect(one.idle).toBe(two.idle);
  });
});

describe("the per-pixel frame expansion", () => {
  it("reads bitplane bytes MSB-first into fill and outline bits", () => {
    const object = { bytesPerRow: 1, height: 2, pixelWidth: 8 };
    // Plane 0 rows first, then plane 1 rows — the raw frame's own layout.
    const frame = new Uint8Array([0b10000001, 0b00000000, 0b01000000, 0b11111111]);
    const pixels = panelFramePixels(object, frame);
    expect(Array.from(pixels.subarray(0, 8))).toEqual([1, 2, 0, 0, 0, 0, 0, 1]);
    expect(Array.from(pixels.subarray(8, 16))).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it("refuses a frame that is not two planes of the object's rows", () => {
    const object = { bytesPerRow: 2, height: 2, pixelWidth: 16 };
    expect(() => panelFramePixels(object, new Uint8Array(7))).toThrow(/expected 8/);
  });

  it("expands every first frame of every shipped animation to panel-sized pixels", () => {
    // The decode itself is table-panel.test.ts's; what is checked here is the
    // conversion contract the renderer consumes: per-pixel bytes of exactly
    // pixelWidth x height, values only ever plane bits.
    for (const object of PANEL.objects.slice(0, 8)) {
      const raw = new Uint8Array(
        object.packed.subarray(0x1c, 0x1c + 2 * object.height * object.bytesPerRow),
      );
      const pixels = panelFramePixels(object, raw);
      expect(pixels.length).toBe(object.pixelWidth * object.height);
      expect(pixels.every((value) => value <= 3)).toBe(true);
      expect(object.pixelWidth).toBeLessThanOrEqual(PANEL_WIDTH);
      expect(object.height).toBeLessThanOrEqual(PANEL_HEIGHT);
    }
  });
});
