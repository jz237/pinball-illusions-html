/**
 * The game loop, driven headlessly.
 *
 * These tests are the reason `game-loop.ts` keeps its logic out of the browser:
 * everything below runs the REAL Law 'n Justice map, the real physics and the
 * real ball lifecycle with nothing faked but the input and, for one test, the
 * clock. If the loop is playable in node it is playable in a browser, and the
 * only thing left to go wrong on the page is the drawing.
 *
 * The input stand-in is a function of the tick INDEX rather than a queue of
 * calls, which is what makes the determinism test mean something: the same
 * script really is the same input, and any difference in the outcome has to
 * have come from the loop.
 */

import { describe, expect, it } from "vitest";

import type { ControlSnapshot } from "../src/browser/input.js";
import { InputRouter } from "../src/browser/input.js";
import type { GameOptions, InputSource } from "../src/browser/game-loop.js";
import {
  DEFAULT_BALLS_PER_GAME,
  GameLoop,
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { Game, GameTickReport } from "../src/browser/game-loop.js";
import type { TableMap } from "../src/game/contracts.js";
import { mapFor } from "./table-fixtures.js";
import { pixelsToQ10, q10ToPixel } from "../src/core/fixed-point.js";
import {
  ballIsOnTheRod,
  plungerConfigFor,
  servePosition,
  troughPlacement,
} from "../src/game/plunger.js";
import { SUBSTEP_GRAVITY } from "../src/game/ball-physics.js";
import { FixedStepScheduler } from "../src/core/fixed-step-scheduler.js";
import { BONUS_NONE_FRAMES } from "../src/game/bonus.js";

/**
 * Ticks an unearned ball end costs: the "NO BONUS" hold, plus a little slack
 * for the drain and the serve that bracket it. Decoded, not chosen — see
 * `bonus.ts` and the test that pins it.
 */
const BONUS_HOLD_TICKS = BONUS_NONE_FRAMES + 10;

/**
 * Parsed once: it is read-only and expanding 336x600 per test is wasteful.
 * `mapFor` also registers the table's ramp drive, which `createGame` requires.
 */
const MAP: TableMap = mapFor("law-n-justice");

const SERVE = servePosition(plungerConfigFor("law-n-justice"));

/** Where a serve on a cold machine puts the ball: the trough, $3E36. */
const TROUGH = troughPlacement();

/** Ticks a cold serve takes to roll down the return chute onto the rod. */
const CHUTE_TICKS = 40;

/**
 * An input source whose whole behaviour is a function of the tick index.
 *
 * It drives a real `InputRouter` rather than fabricating snapshots, so the edge
 * bookkeeping the loop depends on — a press and a release inside one tick, a
 * hold spanning many — is the same code the keyboard goes through.
 */
class ScriptedInput implements InputSource {
  readonly router = new InputRouter();
  readonly #script: (tick: number, router: InputRouter) => void;
  #tick = 0;

  constructor(script: (tick: number, router: InputRouter) => void = () => undefined) {
    this.#script = script;
  }

  sample(): ControlSnapshot {
    this.#script(this.#tick, this.router);
    this.#tick += 1;
    return this.router.sample();
  }
}

/** A started game with short countdowns, so a test is not mostly waiting. */
function startedGame(options: Partial<GameOptions> = {}): Game {
  const game = createGame(MAP, {
    firstServeDelayTicks: 2,
    serveDelayTicks: 3,
    ...options,
  });
  startGame(game);
  return game;
}

function drainedIds(reports: readonly GameTickReport[]): number[] {
  return reports.flatMap((report) => [...report.drained]);
}

describe("attract mode", () => {
  it("serves nothing until start is pressed", () => {
    const game = createGame(MAP);
    const input = new ScriptedInput((tick, router) => {
      if (tick === 20) router.tap("start");
    });

    const before = runTicks(game, input, 20);
    expect(before.every((report) => !report.stepped)).toBe(true);
    expect(game.balls.balls).toHaveLength(0);
    expect(game.phase).toBe("attract");

    runTicks(game, input, 40);
    expect(game.phase).toBe("in-play");
    expect(game.ballsServed).toBe(1);
  });
});

describe("the ball lifecycle", () => {
  it("serves a ball into the shooter lane after the serve delay", () => {
    const game = startedGame();
    const input = new ScriptedInput();

    const reports = runTicks(game, input, 3);
    // Ticks 0 and 1 burn the countdown; the serve lands on tick 2.
    expect(reports.map((report) => report.served)).toEqual([false, false, true]);
    expect(game.ballsServed).toBe(1);
    expect(game.laneBallId).toBe(0);

    // NOT at the seat: the serve is the original's trough at $3E36, on the
    // UPPER line at the mouth of the return chute, pushed off at 512 units in
    // both axes. Read one step after the placement — the serve happens at the
    // top of the tick and the ball has already been integrated once by the time
    // the report comes back — so this pins the LINE and the direction, and
    // `plunger.test.ts` pins the arithmetic to the Q10.
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    expect(ball?.level).toBe(1);
    expect(ball?.active).toBe(true);
    expect(ball?.x).toBeGreaterThanOrEqual(TROUGH.x);
    expect(ball?.y).toBeGreaterThanOrEqual(TROUGH.y);
    // Moving down and to the right, into the chute, at the 2 px/tick the
    // trough's +512 in each axis is worth.
    expect(ball?.velocityX).toBeGreaterThanOrEqual(TROUGH.velocityX);
    expect(ball?.velocityY).toBeGreaterThanOrEqual(TROUGH.velocityY);
  });

  it("rolls the served ball down the return chute and lets the map hold it", () => {
    // This used to assert the lifecycle PIN, on the belief that the collision
    // layer has no floor under the lane. It has one — row 561 is solid from
    // x=310 rightward on all three shipped maps — and the ball that rolls down
    // the chute settles on it and stays, with nothing writing its position.
    const game = startedGame();
    runTicks(game, new ScriptedInput(), 300);

    expect(game.ballsServed).toBe(1);
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    expect(ball?.level).toBe(0);
    expect(ballIsOnTheRod(ball!)).toBe(true);
    // SEATED, WHICH IS NOT FROZEN. The lane ball bobs on the ejector at
    // +0x00B6BE exactly as the original's does — session 4 measured its seat
    // over cy 553.53..553.91 and it never settles — so what is asserted is the
    // residual of a seated ball: the two substeps of gravity between one
    // collision pass and the next, and no drift in x at all.
    expect(ball?.velocityX).toBe(0);
    expect(Math.abs(ball?.velocityY ?? 0)).toBeLessThanOrEqual(2 * SUBSTEP_GRAVITY);
    // On the lane floor, ONE ROW BELOW the seat the lane bounds name — which is
    // the row the ORIGINAL parks it on. `LAW_N_JUSTICE_SHOOTER_LANE.bottomY` is
    // 552 because a centre there keeps the whole probe ring clear of the floor
    // at row 561, and the decoded contact rule does not stop a ball at first
    // touch: it reads the ring where the substep grid puts the ball, which is
    // inside the touch band. The machine's own resting lane ball sits at cy
    // 553.53..553.91 on every cold launch in research/view/reference/session4,
    // i.e. row 553; HEAD settled it at 552.999, 0.77 px high, and that 0.77 px
    // is what put HEAD into the wrong column of the arch staircase.
    expect(q10ToPixel(ball?.y ?? 0)).toBe(q10ToPixel(SERVE.y) + 1);
  });

  it("launches the served ball up the lane on the press edge, once per hold", () => {
    // A1: the original's RETURN byte is edge-consumed — the kick fires the
    // frame the press is seen, and however long the key stays down there is no
    // second launch. This test used to pin release-fires, which was the
    // invented spring's behaviour.
    //
    // The press now has to land on a ball that has REACHED the rod: the serve
    // rolls one down the return chute and the original's launcher kicks the ball
    // index standing in the rod switch's byte, doing nothing at all when that
    // byte is zero (+0x006628). A press at tick 4 used to fire because the serve
    // teleported the ball onto the seat; it is consumed and wasted now, which is
    // the machine's own behaviour.
    const game = startedGame();
    const input = new ScriptedInput((tick, router) => {
      if (tick === CHUTE_TICKS) router.press("plunger");
      if (tick === CHUTE_TICKS + 32) router.release("plunger");
    });

    const reports = runTicks(game, input, CHUTE_TICKS + 36);
    const launches = reports.filter((report) => report.launched);

    expect(launches, "the launcher never fired").toHaveLength(1);
    expect(launches[0]?.tick).toBe(CHUTE_TICKS + 1);
    // The ball is off the rod, so nothing pins it any more.
    expect(game.laneBallId).toBeNull();

    const ball = game.balls.balls[0];
    expect(ball?.active).toBe(true);
    expect(q10ToPixel(ball?.y ?? 0)).toBeLessThan(q10ToPixel(SERVE.y));
  });

  it("launches on ENTER too: a start press during play is the launch edge", () => {
    // The original's RETURN both starts from the shell and launches in play;
    // the loop aliases a `start` press to the launch while a game is running.
    const game = startedGame();
    const input = new ScriptedInput((tick, router) => {
      if (tick === CHUTE_TICKS) router.tap("start");
    });

    const reports = runTicks(game, input, CHUTE_TICKS + 6);
    expect(reports.some((report) => report.launched)).toBe(true);
    expect(game.laneBallId).toBeNull();
    // And it did not restart the game: the same ball count is in progress.
    expect(game.phase).toBe("in-play");
    expect(game.ballsServed).toBe(1);
  });

  it("does not fire on a press with nothing served", () => {
    const game = startedGame({ firstServeDelayTicks: 40 });
    const input = new ScriptedInput((tick, router) => {
      if (tick === 2) router.press("plunger");
      if (tick === 10) router.release("plunger");
    });

    const reports = runTicks(game, input, 20);
    expect(reports.some((report) => report.launched)).toBe(false);
    expect(game.balls.balls).toHaveLength(0);

    // And the edge was CONSUMED, not banked: when the serve finally lands, the
    // stale press from before it must not fire the ball on its own.
    const later = runTicks(game, input, 40);
    expect(later.some((report) => report.served)).toBe(true);
    expect(later.some((report) => report.launched)).toBe(false);
  });

  it("replaces a drained ball with the next one", () => {
    // A drain line partway up the table turns every serve into an immediate
    // drain, which exercises the lifecycle without needing a plausible shot.
    //
    // THE BUDGETS IN THIS BLOCK ARE END-OF-BALL BONUS BUDGETS. Every ball end
    // now runs the decoded bonus phase before the next serve, and a ball that
    // scored nothing gets the "NO BONUS" panel's 150 frames (`bonus.ts`, the
    // `move.w #$96,d0` at Law 'n Justice hunk 4 +0x2B8E, film-measured at 149
    // visible frames eight times over). This player presses nothing, so nothing
    // dismisses it early either. Only the tick counts moved; every assertion
    // below is the one that was here before.
    const game = startedGame({ simulation: { drainY: pixelsToQ10(300) } });
    const reports = runTicks(game, new ScriptedInput(), 8 + BONUS_HOLD_TICKS);

    expect(drainedIds(reports)).toEqual([0, 1]);
    expect(game.ballsServed).toBe(2);
    expect(game.phase).toBe("in-play");
    // Ids are never reused, so two distinct ids is two distinct balls.
    expect(game.balls.nextId).toBe(2);
  });

  it("ends the game once the configured ball count is exhausted", () => {
    const game = startedGame({ simulation: { drainY: pixelsToQ10(300) } });
    expect(game.options.ballsPerGame).toBe(DEFAULT_BALLS_PER_GAME);

    const reports = runTicks(game, new ScriptedInput(), 60 + 3 * BONUS_HOLD_TICKS);

    expect(drainedIds(reports)).toEqual([0, 1, 2]);
    expect(game.ballsServed).toBe(DEFAULT_BALLS_PER_GAME);
    expect(game.phase).toBe("game-over");
    expect(game.balls.balls).toHaveLength(0);
    // The report says so exactly once, so a caller may play the cue on it.
    expect(reports.filter((report) => report.gameOver)).toHaveLength(1);
  });

  it("honours a ball count other than the shipped three", () => {
    const game = startedGame({
      ballsPerGame: 5,
      simulation: { drainY: pixelsToQ10(300) },
    });
    runTicks(game, new ScriptedInput(), 60 + 5 * BONUS_HOLD_TICKS);

    expect(game.ballsServed).toBe(5);
    expect(game.phase).toBe("game-over");
  });

  it("starts a fresh game from game over", () => {
    const game = startedGame({ simulation: { drainY: pixelsToQ10(300) } });
    // Late enough that the third ball's bonus has finished and the game is
    // really over: `start` only restarts from a game that has ended.
    const restartAt = 40 + 3 * BONUS_HOLD_TICKS;
    const input = new ScriptedInput((tick, router) => {
      if (tick === restartAt) router.tap("start");
    });

    runTicks(game, input, restartAt + 1);
    expect(game.phase).toBe("in-play");
    expect(game.ballsServed).toBe(0);
    // Ids restart, so two games are comparable in a debug dump.
    expect(game.balls.nextId).toBe(0);
  });
});

describe("nudge and tilt", () => {
  it("moves the flippers while the table is upright", () => {
    const game = startedGame();
    const input = new ScriptedInput((tick, router) => {
      if (tick === 4) router.press("leftFlipper");
    });

    runTicks(game, input, 12);
    const left = debugSnapshot(game).flippers.find((flipper) => flipper.id === "lower-left");
    expect(left?.stroke).toBeGreaterThan(0);
  });

  it("kills the flippers once the table tilts", () => {
    // FIVE shoves at the filmed cadence, with a ball rolling: the calibrated
    // trip (see tilt.ts — the decoded add-100/trip-200 model predicted press 3
    // and the running machine trips at press 5 at both filmed cadences). The
    // ball is freed from the rod by hand because the counter only warms while
    // a ball is IN PLAY — also filmed: shoves with the ball waiting on the
    // plunger never tilt.
    const nudgeTicks = new Set([5, 8, 11, 14, 17]);
    const game = startedGame();
    runTicks(game, new ScriptedInput(), 3);
    game.laneBallId = null;
    const free = game.balls.balls[0];
    expect(free).toBeDefined();
    if (free !== undefined) {
      free.x = pixelsToQ10(150);
      free.y = pixelsToQ10(120);
    }
    const input = new ScriptedInput((tick, router) => {
      if (nudgeTicks.has(tick)) router.tap("nudgeLeft");
      if (tick === 55) router.press("leftFlipper");
    });

    const reports = runTicks(game, input, 50);
    expect(game.tilt.tilted).toBe(true);
    expect(reports.filter((report) => report.justTilted)).toHaveLength(1);

    runTicks(game, input, 20);
    const snapshot = debugSnapshot(game);
    expect(snapshot.flippersLive).toBe(false);
    for (const flipper of snapshot.flippers) {
      expect(flipper.stroke, `${flipper.id} moved while tilted`).toBe(0);
    }
  });

  it("applies the nudge impulse to every live ball", () => {
    // One ball, hand-placed in open playfield, so the nudge has something it can
    // actually move: a served ball is either rolling down the return chute on
    // the UPPER line, which the cabinet does not reach into, or standing on the
    // rod, which the tilt bookkeeping exempts.
    const game = startedGame();
    runTicks(game, new ScriptedInput(), 3);
    const free = game.balls.balls[0];
    expect(free).toBeDefined();
    game.laneBallId = null;
    if (free !== undefined) {
      free.x = pixelsToQ10(150);
      free.y = pixelsToQ10(120);
      free.velocityX = 0;
      free.level = 0;
    }

    const input = new ScriptedInput((tick, router) => {
      if (tick === 0) router.tap("nudgeRight");
    });
    runTicks(game, input, 1);

    expect(game.balls.balls[0]?.velocityX).toBeGreaterThan(0);
    // One shove's worth of warning, less the one tick of decay the loop has
    // already run: the game loop shoves and then ticks the counter down.
    expect(game.tilt.warning).toBe(
      game.nudgeConfig.sensitivity - game.nudgeConfig.decayPerTick,
    );
  });
});

describe("pause", () => {
  it("stops the simulation without stopping the loop", () => {
    const game = startedGame();
    const input = new ScriptedInput((tick, router) => {
      if (tick === 10) router.tap("pause");
    });

    runTicks(game, input, 10);
    const before = debugSnapshot(game).balls;

    const paused = runTicks(game, input, 30);
    expect(game.paused).toBe(true);
    expect(paused.every((report) => !report.stepped)).toBe(true);
    // The tick counter still advances, so the pause key can be seen.
    expect(game.tick).toBe(40);
    expect(debugSnapshot(game).balls).toEqual(before);
  });
});

describe("determinism", () => {
  const script = (tick: number, router: InputRouter): void => {
    if (tick === 4) router.press("plunger");
    if (tick === 20) router.release("plunger");
    if (tick === 60) router.press("leftFlipper");
    if (tick === 70) router.release("leftFlipper");
    if (tick === 90) router.tap("nudgeLeft");
    if (tick === 120) router.press("rightFlipper");
    if (tick === 140) router.release("rightFlipper");
  };

  it("produces byte-identical state from identical input", () => {
    const first = startedGame();
    runTicks(first, new ScriptedInput(script), 400);

    const second = startedGame();
    runTicks(second, new ScriptedInput(script), 400);

    expect(JSON.stringify(debugSnapshot(second))).toBe(JSON.stringify(debugSnapshot(first)));
  });

  it("does not depend on how the ticks were split into batches", () => {
    const whole = startedGame();
    runTicks(whole, new ScriptedInput(script), 400);

    const split = startedGame();
    const input = new ScriptedInput(script);
    for (let i = 0; i < 400; i += 7) {
      runTicks(split, input, Math.min(7, 400 - i));
    }

    expect(debugSnapshot(split)).toEqual(debugSnapshot(whole));
  });
});

describe("GameLoop", () => {
  /** A frame source driven by hand, so no test waits on a real display. */
  class ManualFrames {
    #next: ((timeMs: number) => void) | null = null;
    #handle = 0;

    request(callback: (timeMs: number) => void): number {
      this.#next = callback;
      this.#handle += 1;
      return this.#handle;
    }

    cancel(): void {
      this.#next = null;
    }

    deliver(timeMs: number): void {
      const callback = this.#next;
      if (callback === null) throw new Error("no frame was requested");
      this.#next = null;
      callback(timeMs);
    }

    get pending(): boolean {
      return this.#next !== null;
    }
  }

  function loopFor(frameCount: number): { ticks: number; renders: number; frames: number } {
    const game = startedGame();
    const frames = new ManualFrames();
    let renders = 0;
    const loop = new GameLoop({
      game,
      input: new ScriptedInput(),
      frames,
      render: () => {
        renders += 1;
      },
      // A generous catch-up ceiling: this test is about the tick TOTAL over a
      // second, and the default clamp of 8 would legitimately discard ticks in
      // the coarse-frame case, which is a different property.
      scheduler: new FixedStepScheduler({ maxCatchUpTicks: 1000 }),
    });

    loop.start();
    for (let frame = 0; frame <= frameCount; frame += 1) {
      expect(frames.pending).toBe(true);
      frames.deliver(Math.round((frame * 1000) / frameCount));
    }
    loop.stop();

    return { ticks: game.tick, renders, frames: loop.frameCount };
  }

  it("steps at exactly 50 Hz however often the browser renders", () => {
    // One second of wall time is fifty ticks whether it arrived as six frames or
    // as a hundred and forty-four. The first frame only seeds the clock.
    const slow = loopFor(6);
    const normal = loopFor(60);
    const fast = loopFor(144);

    expect(slow.ticks).toBe(50);
    expect(normal.ticks).toBe(50);
    expect(fast.ticks).toBe(50);
  });

  it("renders once per frame, decoupled from the tick count", () => {
    const fast = loopFor(144);
    expect(fast.renders).toBe(145);
    expect(fast.frames).toBe(145);
    expect(fast.ticks).toBe(50);
  });

  it("keeps requesting frames until it is stopped", () => {
    const game = startedGame();
    const frames = new ManualFrames();
    const loop = new GameLoop({
      game,
      input: new ScriptedInput(),
      frames,
      render: () => undefined,
    });

    expect(loop.running).toBe(false);
    loop.start();
    expect(loop.running).toBe(true);
    frames.deliver(0);
    frames.deliver(20);
    expect(loop.running).toBe(true);

    loop.stop();
    expect(loop.running).toBe(false);
  });
});

describe("the debug handle", () => {
  it("exposes the ball states, tick count, camera and table", () => {
    const game = startedGame();
    // Long enough for the served ball to finish the return chute, so the snapshot
    // is read off a ball at rest on the rod rather than one still rolling.
    runTicks(game, new ScriptedInput(), CHUTE_TICKS);

    const state = debugSnapshot(game);
    expect(state.tableId).toBe("law-n-justice");
    expect(state.tick).toBe(CHUTE_TICKS);
    expect(state.camera.mode).toBe("scrolling");
    expect(state.balls).toHaveLength(1);
    // The machine's own lane seat row; see "rolls the served ball down the
    // return chute" above for the session-4 measurement it comes from.
    expect(state.balls[0]?.pixelY).toBe(q10ToPixel(SERVE.y) + 1);
    expect(state.ballsRemaining).toBe(DEFAULT_BALLS_PER_GAME - 1);
  });

  it("is a snapshot, not a live view of the mutable balls", () => {
    const game = startedGame();
    runTicks(game, new ScriptedInput(), 5);
    const taken = debugSnapshot(game);
    runTicks(game, new ScriptedInput(), 5);

    expect(taken.tick).toBe(5);
    expect(debugSnapshot(game).tick).toBe(10);
  });
});
