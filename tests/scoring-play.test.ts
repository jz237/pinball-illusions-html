/**
 * The scoring layer and the surface layer, on the assembled machine.
 *
 * `scoring.test.ts` and `surface-physics.test.ts` check the parts. This file
 * checks that they are actually WIRED: that a played game's score moves, that
 * every value it moves by came off the disks, that a pop bumper pops, and that
 * the two level-change mechanisms the shipped data carries do what the census
 * says they do.
 */

import { describe, expect, it } from "vitest";
import {
  BALL_SEARCH_PULSES,
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { CONTROLS, IDLE_SNAPSHOT } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableId } from "../src/game/contracts.js";
import { pixelsToQ10, q10ToPixel } from "../src/core/fixed-point.js";
import { createBallSet, spawnBall, stepBalls } from "../src/game/ball-physics.js";
import { materialTableFor } from "../src/game/materials.js";
import { devicesFor, mapFor } from "./table-fixtures.js";

class ScriptedInput implements InputSource {
  private sequence = 0;
  private held = new Set<Control>();

  constructor(private readonly plan: (tick: number) => readonly Control[]) {}

  sample(): ControlSnapshot {
    const wanted = new Set(this.plan(this.sequence));
    const previous = this.held;
    this.held = wanted;
    this.sequence += 1;
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
    return { sequence: this.sequence, controls };
  }
}

function idleInput(): InputSource {
  return { sample: () => IDLE_SNAPSHOT };
}

function playingInput(): InputSource {
  return new ScriptedInput((t) => {
    const controls: Control[] = [];
    const phase = t % 400;
    if (phase >= 40 && phase < 100) controls.push("plunger");
    if (t % 23 < 4) controls.push("leftFlipper");
    if ((t + 11) % 29 < 4) controls.push("rightFlipper");
    return controls;
  });
}

/** Every value any shipped record on one table is able to award. */
function awardValuesOf(tableId: TableId): Set<number> {
  const devices = devicesFor(tableId);
  const values = new Set<number>([0]);
  for (const record of [...devices.devices, ...devices.zones]) {
    values.add(record.score);
    values.add(record.repeatScore);
  }
  for (const record of [...devices.bumpers, ...devices.slingshots]) values.add(record.score);
  return values;
}

describe("the machine keeps score", () => {
  it("scores a real game, and only ever by values that are in the shipped data", () => {
    // The whole point of the scoring layer in one assertion: nothing in this
    // reconstruction may invent an award. Every value a played game produces has
    // to be one that came off the disks.
    for (const tableId of TABLE_IDS) {
      const permitted = awardValuesOf(tableId);
      const game = createGame(mapFor(tableId), { ballsPerGame: 3 });
      startGame(game);

      let awarded = 0;
      let total = 0;
      for (const report of runTicks(game, playingInput(), 6_000)) {
        for (const award of report.awards) {
          expect(permitted.has(award.score), `${tableId} awarded ${award.score}`).toBe(true);
          expect(award.bonus, `${tableId} ${award.id} bonus`).toBe(0);
          awarded += 1;
          total += award.score;
        }
      }

      expect(awarded, `${tableId} scored nothing at all in 6000 ticks`).toBeGreaterThan(0);
      // The packed-BCD field and ordinary arithmetic have to agree exactly.
      expect(debugSnapshot(game).score).toBe(total % 1_000_000_000_000);
    }
  });

  it("keeps the score across a drain and clears it only for a new game", () => {
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(game);
    // Long enough for the first ball to end, which is no longer four thousand
    // ticks: the ball is much harder to lose than it was.
    runTicks(game, playingInput(), 20_000);
    const state = debugSnapshot(game);
    expect(state.score).toBeGreaterThan(0);
    expect(state.ballsServed).toBeGreaterThan(1);

    startGame(game);
    expect(debugSnapshot(game).score).toBe(0);
    expect(debugSnapshot(game).bonus).toBe(0);
  });

  it("pays a lock its own award on the tick the saucer swallows the ball", () => {
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(game);
    runTicks(game, idleInput(), 60);
    const before = debugSnapshot(game).score;

    // The CITY JAIL saucer, 250,000 in packed BCD.
    const jail = devicesFor("law-n-justice").zones.find(
      (zone) => zone.kind === "lock" && zone.score === 250000,
    );
    expect(jail).toBeDefined();
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (jail === undefined || ball === undefined) return;
    // Off the rod first: the loop pins the lane ball back to the serve point
    // before the locks run, precisely so a ball waiting on the plunger can never
    // be swallowed by a saucer.
    game.laneBallId = null;
    ball.x = pixelsToQ10(Math.floor((jail.minX + jail.maxX) / 2));
    ball.y = pixelsToQ10(Math.floor((jail.minY + jail.maxY) / 2));
    ball.velocityX = 0;
    ball.velocityY = 0;
    ball.level = 0;

    const reports = runTicks(game, idleInput(), 1);
    const awards = reports.flatMap((report) => report.awards).filter((a) => a.source === "lock");
    expect(awards.map((a) => a.score)).toEqual([250000]);
    expect(debugSnapshot(game).score).toBe(before + 250000);
  });

  it("never scores the ball sitting on the plunger rod", () => {
    // The rod is pinned by the game loop rather than by the map, and the serve
    // point sits in the shooter lane where Law 'n Justice has a zone. A ball
    // held there must not tick that zone over and over.
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(game);
    const reports = runTicks(game, idleInput(), 400);
    expect(debugSnapshot(game).laneBallId).not.toBeNull();
    expect(reports.flatMap((report) => report.awards)).toEqual([]);
    expect(debugSnapshot(game).score).toBe(0);
  });
});

describe("the surfaces the ball is touching", () => {
  it("sends a ball off a pop bumper faster than it arrived", () => {
    // The measured kick: 5500 of the original's velocity units added to the
    // inward normal speed BEFORE restitution. No wall can do this — at the
    // measured plain-wall restitution of 304/1024 a ball always leaves slower.
    const tableId: TableId = "law-n-justice";
    const map = mapFor(tableId);
    const devices = devicesFor(tableId);
    const materials = materialTableFor(tableId);
    const weightless = { gravityY: 0, nudgeX: 0, nudgeY: 0 };

    let best = 0;
    for (let y = 0; y < 600; y += 1) {
      for (let x = 0; x < 336; x += 1) {
        if (devices.surfaceIdAt(0, x, y) !== 16) continue;
        const set = createBallSet();
        const ball = spawnBall(set, pixelsToQ10(x), pixelsToQ10(y - 22), 0, 1000, 0);
        for (let tick = 0; tick < 20; tick += 1) {
          stepBalls(set, map, materials, weightless, { surfaces: devices });
          if (-ball.velocityY > best) best = -ball.velocityY;
        }
      }
    }
    // Arrived at 1000 Q10/tick; a pop bumper hands back far more than that.
    expect(best, "no pop bumper pixel on this table returned a ball at all").toBeGreaterThan(1000);
  });

  it("hands a ball off the habitrail back to the playfield instead of stranding it", () => {
    // Surface id 11, "level change to lower": a flat bar across the foot of Law
    // 'n Justice's left habitrail channel at x 23..47, y 465..467. Before it was
    // implemented the aggressive census wrote off fifty-seven balls one radius
    // above that bar, at (36,456) and (37,456) on the upper collision line.
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(game);
    runTicks(game, idleInput(), 60);
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball === undefined) return;
    game.laneBallId = null;
    ball.x = pixelsToQ10(36);
    ball.y = pixelsToQ10(430);
    ball.velocityX = 0;
    ball.velocityY = 200;
    ball.level = 1;

    let landed = false;
    for (let tick = 0; tick < 300 && !landed; tick += 1) {
      runTicks(game, idleInput(), 1);
      landed = (ball.level as number) === 0;
    }
    expect(
      landed,
      `ball stayed on the ramp line at (${q10ToPixel(ball.x)},${q10ToPixel(ball.y)})`,
    ).toBe(true);
  });

  it("takes the engine's own hand-off box, which a three-column gate row missed", () => {
    // Law 'n Justice's left ramp exit is a 21-pixel box at (25,180)-(45,200) in
    // the shipped zone list. A ball crossing the reconstructed `ramp-end` gate
    // row at x=38 missed it by two pixels, stayed on the upper line and was
    // eventually tipped into a strip that is sealed on the lower one. The box
    // catches it; the row did not.
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(game);
    runTicks(game, idleInput(), 60);
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball === undefined) return;
    game.laneBallId = null;
    ball.x = pixelsToQ10(38);
    ball.y = pixelsToQ10(190);
    ball.velocityX = 0;
    ball.velocityY = 0;
    ball.level = 1;

    runTicks(game, idleInput(), 1);
    expect(ball.level as number).toBe(0);
  });
});

describe("the ball search fires the coils first", () => {
  /** Parks a ball in Law 'n Justice's sealed left spiral. */
  function park(game: ReturnType<typeof createGame>): void {
    const ball = game.balls.balls[0];
    if (ball === undefined) return;
    ball.x = pixelsToQ10(86);
    ball.y = pixelsToQ10(155);
    ball.velocityX = 0;
    ball.velocityY = 0;
    ball.level = 0;
  }

  it("pulses a wedged ball before it writes it off, and writes it off in the end", () => {
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3, ballSearchTicks: 40 });
    startGame(game);
    runTicks(game, new ScriptedInput((t) => (t >= 60 && t < 110 ? ["plunger"] : [])), 115);
    expect(debugSnapshot(game).laneBallId).toBeNull();
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball === undefined) return;
    park(game);

    expect(debugSnapshot(game).searchPulses).toBe(BALL_SEARCH_PULSES);
    // One window of stillness buys a coil pulse, not a write-off.
    runTicks(game, idleInput(), 41);
    expect(debugSnapshot(game).searchPulses).toBe(BALL_SEARCH_PULSES - 1);
    expect(ball.active).toBe(true);
  });

  it("cannot be earned back by a ball that keeps being shoved around", () => {
    // The bound that keeps the search a search. `searchPulses` is refilled by a
    // SERVE and by nothing else, so however far a pulse moves a ball, the budget
    // only ever goes down within one ball and the write-off still arrives.
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3, ballSearchTicks: 40 });
    startGame(game);
    runTicks(game, new ScriptedInput((t) => (t >= 60 && t < 110 ? ["plunger"] : [])), 115);
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball === undefined) return;

    let pulses = 0;
    let previous = debugSnapshot(game).searchPulses;
    for (let tick = 0; tick < 2_000 && ball.active; tick += 1) {
      // Re-parked every tick, so the pulse never buys the ball anything: this is
      // the worst case the bound exists for.
      park(game);
      runTicks(game, idleInput(), 1);
      const now = debugSnapshot(game).searchPulses;
      if (now < previous) pulses += 1;
      previous = now;
    }
    expect(ball.active).toBe(false);
    expect(pulses).toBe(BALL_SEARCH_PULSES);
  });
});
