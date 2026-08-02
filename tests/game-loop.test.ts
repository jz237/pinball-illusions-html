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
import { plungerConfigFor, servePosition } from "../src/game/plunger.js";
import { FixedStepScheduler } from "../src/core/fixed-step-scheduler.js";

/**
 * Parsed once: it is read-only and expanding 336x600 per test is wasteful.
 * `mapFor` also registers the table's ramp drive, which `createGame` requires.
 */
const MAP: TableMap = mapFor("law-n-justice");

const SERVE = servePosition(plungerConfigFor("law-n-justice"));

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

    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    expect(ball?.x).toBe(SERVE.x);
    expect(ball?.y).toBe(SERVE.y);
    expect(ball?.active).toBe(true);
  });

  it("holds the served ball on the plunger rod, which the map does not contain", () => {
    // The shipped collision layer has no floor under the lane, so without the
    // lifecycle pinning it there the ball would simply fall out and drain
    // before the player could touch the plunger.
    const game = startedGame();
    runTicks(game, new ScriptedInput(), 300);

    expect(game.ballsServed).toBe(1);
    const ball = game.balls.balls[0];
    expect(ball?.y).toBe(SERVE.y);
    expect(ball?.velocityY).toBe(0);
  });

  it("launches the served ball up the lane on the press edge, once per hold", () => {
    // A1: the original's RETURN byte is edge-consumed — the kick fires the
    // frame the press is seen, and however long the key stays down there is no
    // second launch. This test used to pin release-fires, which was the
    // invented spring's behaviour.
    const game = startedGame();
    const input = new ScriptedInput((tick, router) => {
      if (tick === 4) router.press("plunger");
      if (tick === 36) router.release("plunger");
    });

    const reports = runTicks(game, input, 40);
    const launches = reports.filter((report) => report.launched);

    expect(launches, "the launcher never fired").toHaveLength(1);
    expect(launches[0]?.tick).toBe(5);
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
      if (tick === 4) router.tap("start");
    });

    const reports = runTicks(game, input, 10);
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
    const game = startedGame({ simulation: { drainY: pixelsToQ10(300) } });
    const reports = runTicks(game, new ScriptedInput(), 8);

    expect(drainedIds(reports)).toEqual([0, 1]);
    expect(game.ballsServed).toBe(2);
    expect(game.phase).toBe("in-play");
    // Ids are never reused, so two distinct ids is two distinct balls.
    expect(game.balls.nextId).toBe(2);
  });

  it("ends the game once the configured ball count is exhausted", () => {
    const game = startedGame({ simulation: { drainY: pixelsToQ10(300) } });
    expect(game.options.ballsPerGame).toBe(DEFAULT_BALLS_PER_GAME);

    const reports = runTicks(game, new ScriptedInput(), 60);

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
    runTicks(game, new ScriptedInput(), 60);

    expect(game.ballsServed).toBe(5);
    expect(game.phase).toBe("game-over");
  });

  it("starts a fresh game from game over", () => {
    const game = startedGame({ simulation: { drainY: pixelsToQ10(300) } });
    const input = new ScriptedInput((tick, router) => {
      if (tick === 40) router.tap("start");
    });

    runTicks(game, input, 41);
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
    // Two balls, one of them hand-placed in open playfield, so the nudge has
    // something it can actually move: the lane ball is pinned to the rod.
    const game = startedGame();
    runTicks(game, new ScriptedInput(), 3);
    const free = game.balls.balls[0];
    expect(free).toBeDefined();
    game.laneBallId = null;
    if (free !== undefined) {
      free.x = pixelsToQ10(150);
      free.y = pixelsToQ10(120);
      free.velocityX = 0;
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
    runTicks(game, new ScriptedInput(), 5);

    const state = debugSnapshot(game);
    expect(state.tableId).toBe("law-n-justice");
    expect(state.tick).toBe(5);
    expect(state.camera.mode).toBe("scrolling");
    expect(state.balls).toHaveLength(1);
    expect(state.balls[0]?.pixelY).toBe(q10ToPixel(SERVE.y));
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
