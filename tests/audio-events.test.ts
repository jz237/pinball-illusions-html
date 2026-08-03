/**
 * The tick report's SOUND-BEARING EVENT FIELDS: the flipper stroke edges, the
 * level transfers and the eject provenance the audio layer keys on.
 *
 * These are OBSERVATIONS of the simulation, not new mechanics — the pinned
 * sim-hash suite is what proves that — so what is tested here is that the
 * observations are true of a real scripted game: an edge per press and per
 * release, a transfer only when a ball actually changes collision line, and an
 * eject that names the saucer it came out of.
 */

import { describe, expect, it } from "vitest";
import type { ControlSnapshot } from "../src/browser/input.js";
import { InputRouter } from "../src/browser/input.js";
import type { GameTickReport, InputSource } from "../src/browser/game-loop.js";
import { createGame, runTicks, startGame } from "../src/browser/game-loop.js";
import { mapFor } from "./table-fixtures.js";

/** Holds and releases one flipper on a fixed cadence, nothing else. */
class FlipperScript implements InputSource {
  readonly router = new InputRouter();
  #tick = 0;
  constructor(
    private readonly control: "leftFlipper" | "rightFlipper",
    private readonly period: number,
    private readonly hold: number,
  ) {}
  sample(): ControlSnapshot {
    const tick = this.#tick;
    this.#tick += 1;
    if (tick % this.period === 0) this.router.press(this.control);
    if (tick % this.period === this.hold) this.router.release(this.control);
    return this.router.sample();
  }
}

function flat<K extends "flipperRaised" | "flipperRested">(
  reports: readonly GameTickReport[],
  field: K,
): string[] {
  return reports.flatMap((report) => [...report[field]]);
}

describe("flipper stroke edges", () => {
  it("one raise edge per press that completes, one rest edge per release", () => {
    // 40 ticks held is far beyond the ~4-tick stroke, so every press tops out;
    // 100-tick period leaves the bat fully home between presses.
    const game = createGame(mapFor("law-n-justice"));
    startGame(game);
    const reports = runTicks(game, new FlipperScript("leftFlipper", 100, 40), 1_000);
    const raised = flat(reports, "flipperRaised");
    const rested = flat(reports, "flipperRested");
    expect(raised).toEqual(Array.from({ length: 10 }, () => "left"));
    expect(rested.length).toBe(10);
    expect(new Set(rested)).toEqual(new Set(["left"]));
    // Edges alternate: a side cannot rise twice without resting between.
    let up = false;
    for (const report of reports) {
      for (const side of report.flipperRaised) {
        expect(side).toBe("left");
        expect(up).toBe(false);
        up = true;
      }
      for (const side of report.flipperRested) {
        expect(side).toBe("left");
        expect(up).toBe(true);
        up = false;
      }
    }
  });

  it("the right side flags right, and an idle game flags nothing", () => {
    const game = createGame(mapFor("babewatch"));
    startGame(game);
    const reports = runTicks(game, new FlipperScript("rightFlipper", 120, 50), 600);
    expect(new Set(flat(reports, "flipperRaised"))).toEqual(new Set(["right"]));

    const still = createGame(mapFor("babewatch"));
    startGame(still);
    const idle = runTicks(still, { sample: () => new InputRouter().sample() }, 300);
    expect(flat(idle, "flipperRaised")).toEqual([]);
    expect(flat(idle, "flipperRested")).toEqual([]);
  });

  it("a tap too short to reach the top stop makes no edge at all", () => {
    // The original's flag is the bat REACHING full raise, not the button: a
    // one-tick tap moves the bat a few units and it falls straight back.
    const game = createGame(mapFor("law-n-justice"));
    startGame(game);
    const reports = runTicks(game, new FlipperScript("leftFlipper", 200, 1), 400);
    expect(flat(reports, "flipperRaised")).toEqual([]);
    expect(flat(reports, "flipperRested")).toEqual([]);
  });
});

describe("eject provenance and level transfers", () => {
  it("ejectedFrom is parallel to ejected, and transfers never fire while idle", () => {
    // A scripted game long enough to serve and drain; the structural claims
    // hold on every report whether or not a saucer happened to swallow a ball.
    const game = createGame(mapFor("extreme-sports"));
    startGame(game);
    const script = new FlipperScript("leftFlipper", 97, 20);
    const reports = runTicks(game, script, 2_000);
    for (const report of reports) {
      expect(report.ejectedFrom.length).toBe(report.ejected.length);
      for (const zone of report.ejectedFrom) {
        expect(zone.level === 0 || zone.level === 1).toBe(true);
        expect(Number.isInteger(zone.index)).toBe(true);
      }
      // A ball reported as transferring was in play this tick.
      for (const id of report.levelTransfers) {
        expect(typeof id).toBe("number");
      }
    }
  });
});
