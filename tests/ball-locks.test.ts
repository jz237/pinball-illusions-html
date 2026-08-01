/**
 * BALL LOCKS AND MULTIBALL.
 *
 * The feature this whole engine was written N-ball for, and the last one to
 * arrive. Three things are asserted here and they are deliberately different in
 * kind:
 *
 *   1. THE DEVICE RULES, against `ball-locks.ts` alone: a saucer takes one ball,
 *      refuses a second, freezes what it holds, and gives it back to the trough
 *      rather than to the playfield. These are decoded from the original and the
 *      assertions are literal.
 *   2. THE MACHINE, against the assembled game on real geometry: a captured ball
 *      stops moving and stops draining, the player gets a replacement, the
 *      DECODED lock ladder starts each table's own multiball — BabeWatch's
 *      first counted lock, Law 'n Justice's second lit jail lock, Extreme
 *      Sports none at all — balls come out of the lane one after another, the
 *      camera reframes to the whole table and back, and the game still ends.
 *   3. THAT IT CANNOT HANG. The zero-deadlock guarantee, restated for every path
 *      a lock adds: locking the last ball, locking during a multiball, and
 *      draining out of a multiball with a saucer still full.
 *
 * The rectangles are driven by placing a ball inside them rather than by playing
 * a game into them, because whether a scripted player happens to hit a saucer is
 * a fact about the player. `tests/plays.test.ts` covers the played case.
 */

import { describe, expect, it } from "vitest";
import {
  AUTO_LAUNCH_DELAY_TICKS,
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { Game, InputSource } from "../src/browser/game-loop.js";
import { CONTROLS, IDLE_SNAPSHOT } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { resolveMode } from "../src/browser/camera.js";
import { DEFAULT_CAMERA_OPTIONS } from "../src/browser/camera.js";
import { mapFor } from "./table-fixtures.js";
import { pixelsToQ10, q10ToPixel } from "../src/core/fixed-point.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { BallState, TableId } from "../src/game/contracts.js";
import { materialTableFor } from "../src/game/materials.js";
import {
  BALL_LOCKS_BY_TABLE,
  BALL_LOCK_RULES_NOTE,
  MAX_SIMULTANEOUS_BALLS,
  ballLocksFor,
  ballsToTopUp,
  captureBalls,
  createLockBank,
  heldBallCount,
  heldBallIn,
  lockCovers,
  lockForZone,
  releaseHeldBalls,
  releaseLock,
} from "../src/game/ball-locks.js";
import { queueScript } from "../src/game/mode-vm.js";
import { modesFor } from "./table-fixtures.js";
import type { BallLock } from "../src/game/ball-locks.js";
import { createBallSet, freeBallCount, spawnBall, stepBalls } from "../src/game/ball-physics.js";
import { SIMULATION_GRAVITY } from "../src/game/timebase.js";
import { freeCentre, levelViewsOf } from "../src/game/level-scan.js";

function idleInput(): InputSource {
  return { sample: () => IDLE_SNAPSHOT };
}

/**
 * A player who shoots and swings, because most of what is asserted below only
 * happens once the ball is off the rod: the machine's serve queue is blocked
 * while the PLAYER's ball is sitting on it, exactly as a real lane is, so an
 * idle player never sees a second ball at all.
 */
function playingInput(): InputSource {
  let sequence = 0;
  let previous = new Set<Control>();
  return {
    sample(): ControlSnapshot {
      const wanted = new Set<Control>();
      const phase = sequence % 400;
      if (phase >= 20 && phase < 80) wanted.add("plunger");
      if (sequence % 23 < 3) {
        wanted.add("leftFlipper");
        wanted.add("rightFlipper");
      }
      const was = previous;
      previous = wanted;
      sequence += 1;
      const controls = {} as Record<Control, ControlEdges>;
      for (const control of CONTROLS) {
        const down = wanted.has(control);
        const before = was.has(control);
        controls[control] = {
          down,
          pressed: down && !before,
          released: !down && before,
          pressCount: down && !before ? 1 : 0,
          releaseCount: !down && before ? 1 : 0,
        };
      }
      return { sequence, controls };
    },
  };
}

/**
 * Steers a ball the player already has into a saucer's mouth.
 *
 * Different from `dropInto` on purpose. `dropInto` adds a ball, which is right
 * for driving one device in isolation but wrong for a whole game: a test that
 * conjures a fresh ball every time a saucer empties is a test with an infinite
 * supply of balls, and the game correctly never ends. This moves a ball that is
 * already in play, which is what a shot to the saucer does.
 */
function steerIntoLock(game: Game, device: BallLock): boolean {
  const state = debugSnapshot(game);
  const ball = game.balls.balls.find(
    (one) => one.active && one.heldBy === null && one.id !== state.laneBallId,
  );
  if (ball === undefined) return false;
  const at = centreOf(device);
  ball.x = pixelsToQ10(at.x);
  ball.y = pixelsToQ10(at.y);
  ball.velocityX = 0;
  ball.velocityY = 0;
  ball.level = device.level;
  return true;
}

/** Runs until the player's served ball has left the rod, or gives up. */
function clearTheLane(game: Game, input: InputSource): void {
  for (let tick = 0; tick < 600; tick += 1) {
    runTicks(game, input, 1);
    if (debugSnapshot(game).laneBallId === null) return;
  }
  throw new Error("the player never got the ball out of the lane");
}

function started(tableId: TableId): Game {
  const game = createGame(mapFor(tableId));
  startGame(game);
  return game;
}

/** Centre of a lock's rectangle, in whole pixels. */
function centreOf(device: BallLock): { readonly x: number; readonly y: number } {
  return {
    x: Math.floor((device.minX + device.maxX) / 2),
    y: Math.floor((device.minY + device.maxY) / 2),
  };
}

/**
 * Drops a ball into a saucer's mouth by hand and runs one tick.
 *
 * Placed rather than played: which saucers a scripted player reaches is a fact
 * about the player, and every one of them has to work.
 */
function dropInto(game: Game, device: BallLock): BallState {
  const at = centreOf(device);
  const ball = spawnBall(
    game.balls,
    pixelsToQ10(at.x),
    pixelsToQ10(at.y),
    0,
    0,
    device.level,
  );
  return ball;
}

// ---------------------------------------------------------------------------
// 1. The device rules
// ---------------------------------------------------------------------------

describe("the decoded lock rectangles", () => {
  it("gives every table at least one lock, each bound to a capture script", () => {
    for (const tableId of TABLE_IDS) {
      const locks = ballLocksFor(tableId);
      expect(locks.length, `${tableId} locks`).toBeGreaterThan(0);
      // Every rectangle carries the zone index its capture script is bound
      // under in the mission layer, and the binding must exist: the decoded
      // multiball rule is script data, so a saucer without its script is a
      // saucer disconnected from the rules.
      const modes = modesFor(tableId);
      for (const device of locks) {
        expect(
          modes.scriptForLock(device.level, device.zoneIndex),
          `${tableId} ${device.id} has no capture script bound at zone ${device.zoneIndex}`,
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("names every lock uniquely, and gives each a rectangle a ball fits in", () => {
    for (const tableId of TABLE_IDS) {
      const seen = new Set<string>();
      for (const device of ballLocksFor(tableId)) {
        expect(seen.has(device.id), `${tableId} repeats lock id ${device.id}`).toBe(false);
        seen.add(device.id);
        expect(device.maxX, `${tableId} ${device.id}`).toBeGreaterThan(device.minX);
        expect(device.maxY, `${tableId} ${device.id}`).toBeGreaterThan(device.minY);
        expect(device.minX, `${tableId} ${device.id}`).toBeGreaterThanOrEqual(0);
        expect(device.maxX, `${tableId} ${device.id}`).toBeLessThan(336);
        expect(device.maxY, `${tableId} ${device.id}`).toBeLessThan(600);
      }
    }
  });

  it("puts every lock somewhere a ball can actually stand", () => {
    // A rectangle whose centre is inside a wall would be a saucer that swallows
    // nothing, and the decode would be wrong rather than merely unused. Checked
    // against the collision line the device declares, with the engine's own ring.
    for (const tableId of TABLE_IDS) {
      const views = levelViewsOf(mapFor(tableId), materialTableFor(tableId));
      for (const device of ballLocksFor(tableId)) {
        let standable = 0;
        for (let x = device.minX; x <= device.maxX; x += 1) {
          for (let y = device.minY; y <= device.maxY; y += 1) {
            if (freeCentre(views, device.level, x, y)) standable += 1;
          }
        }
        expect(
          standable,
          `${tableId} ${device.id} has no free ball centre anywhere in its rectangle`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("matches the ball centre against the rectangle, and only on the device's own level", () => {
    const device = ballLocksFor("law-n-justice")[0]!;
    const at = centreOf(device);
    const set = createBallSet();
    const inside = spawnBall(set, pixelsToQ10(at.x), pixelsToQ10(at.y), 0, 0, device.level);
    expect(lockCovers(device, inside)).toBe(true);

    // One pixel outside each edge.
    for (const [x, y] of [
      [device.minX - 1, at.y],
      [device.maxX + 1, at.y],
      [at.x, device.minY - 1],
      [at.x, device.maxY + 1],
    ] as const) {
      const outside = spawnBall(set, pixelsToQ10(x), pixelsToQ10(y), 0, 0, device.level);
      expect(lockCovers(device, outside), `(${x},${y}) should be outside ${device.id}`).toBe(false);
    }

    const wrongLevel = spawnBall(set, pixelsToQ10(at.x), pixelsToQ10(at.y), 0, 0, 1);
    expect(lockCovers(device, wrongLevel)).toBe(false);
  });
});

describe("capture", () => {
  it("takes one ball, freezes it where it stood, and leaves it active", () => {
    const bank = createLockBank("law-n-justice");
    const device = bank.locks[0]!;
    const at = centreOf(device);
    const set = createBallSet();
    const ball = spawnBall(set, pixelsToQ10(at.x), pixelsToQ10(at.y), 500, -700, device.level);

    const captured = captureBalls(bank, set.balls);
    expect(captured).toEqual([{ deviceId: device.id, ballId: ball.id }]);
    expect(ball.heldBy).toBe(device.id);
    expect(ball.active).toBe(true);
    // The original's capture handler never touches the position, so nor does this.
    expect(q10ToPixel(ball.x)).toBe(at.x);
    expect(q10ToPixel(ball.y)).toBe(at.y);
    expect(ball.velocityX).toBe(0);
    expect(ball.velocityY).toBe(0);
    expect(heldBallIn(bank, device.id)).toBe(ball.id);
  });

  it("refuses a second ball into an occupied saucer", () => {
    const bank = createLockBank("law-n-justice");
    const device = bank.locks[0]!;
    const at = centreOf(device);
    const set = createBallSet();
    const first = spawnBall(set, pixelsToQ10(at.x), pixelsToQ10(at.y), 0, 0, device.level);
    const second = spawnBall(set, pixelsToQ10(at.x), pixelsToQ10(at.y), 0, 0, device.level);

    expect(captureBalls(bank, set.balls).map((one) => one.ballId)).toEqual([first.id]);
    expect(captureBalls(bank, set.balls)).toEqual([]);
    expect(second.heldBy).toBe(null);
    expect(heldBallCount(bank)).toBe(1);
  });

  it("never takes a ball a saucer already has", () => {
    const bank = createLockBank("babewatch");
    const [a, b] = [bank.locks[0]!, bank.locks[1]!];
    const set = createBallSet();
    const atA = centreOf(a);
    const ball = spawnBall(set, pixelsToQ10(atA.x), pixelsToQ10(atA.y), 0, 0, a.level);
    captureBalls(bank, set.balls);

    // Teleport the held ball into the OTHER saucer's rectangle. It is already
    // held, so nothing may happen — the engine's first refusal.
    const atB = centreOf(b);
    ball.x = pixelsToQ10(atB.x);
    ball.y = pixelsToQ10(atB.y);
    ball.level = b.level;
    expect(captureBalls(bank, set.balls)).toEqual([]);
    expect(ball.heldBy).toBe(a.id);
  });

  it("ignores drained balls", () => {
    const bank = createLockBank("law-n-justice");
    const device = bank.locks[0]!;
    const at = centreOf(device);
    const set = createBallSet();
    const ball = spawnBall(set, pixelsToQ10(at.x), pixelsToQ10(at.y), 0, 0, device.level);
    ball.active = false;
    expect(captureBalls(bank, set.balls)).toEqual([]);
  });
});

describe("release", () => {
  it("empties every saucer and sends the balls to the trough, not the playfield", () => {
    const bank = createLockBank("babewatch");
    const set = createBallSet();
    const held: BallState[] = [];
    for (const device of bank.locks.slice(0, 2)) {
      const at = centreOf(device);
      held.push(spawnBall(set, pixelsToQ10(at.x), pixelsToQ10(at.y), 0, 0, device.level));
    }
    captureBalls(bank, set.balls);
    expect(heldBallCount(bank)).toBe(2);

    const freed = releaseHeldBalls(bank, set.balls);
    expect(freed).toEqual(held.map((ball) => ball.id));
    expect(heldBallCount(bank)).toBe(0);
    for (const ball of held) {
      expect(ball.heldBy).toBe(null);
      // Deactivated, because opcode $68 re-initialises the ball object and puts
      // it back in the serve queue. It comes out of the plunger lane.
      expect(ball.active).toBe(false);
    }
  });
});

describe("the top-up, which is what the multiball opcode really is", () => {
  it("asks for the shortfall, not for the whole target", () => {
    expect(ballsToTopUp(3, 0, 0)).toBe(3);
    expect(ballsToTopUp(3, 1, 0)).toBe(2);
    expect(ballsToTopUp(3, 0, 2)).toBe(1);
    expect(ballsToTopUp(3, 2, 1)).toBe(0);
    expect(ballsToTopUp(3, 3, 0)).toBe(0);
    // Already over the target: still nothing, never negative.
    expect(ballsToTopUp(2, 3, 0)).toBe(0);
  });

  it("refuses outright above the engine's ceiling of three", () => {
    // `cmpi.w #$3,d1 / bhi` at main.seg00 data 0x5BD0 — a request for four does
    // not clamp to three, it does nothing at all.
    expect(MAX_SIMULTANEOUS_BALLS).toBe(3);
    expect(ballsToTopUp(4, 0, 0)).toBe(0);
    expect(ballsToTopUp(6, 0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. The machine
// ---------------------------------------------------------------------------

describe("a lock in a running game", () => {
  it("takes the ball out of the physics entirely", () => {
    const tableId: TableId = "law-n-justice";
    const device = ballLocksFor(tableId)[0]!;
    const at = centreOf(device);
    const map = mapFor(tableId);
    const materials = materialTableFor(tableId);
    const set = createBallSet();
    const ball = spawnBall(set, pixelsToQ10(at.x), pixelsToQ10(at.y), 0, 0, device.level);
    ball.heldBy = "some-saucer";

    for (let tick = 0; tick < 200; tick += 1) {
      stepBalls(set, map, materials, {
        gravityY: SIMULATION_GRAVITY,
        nudgeX: 0,
        nudgeY: 0,
      });
    }
    // Two hundred ticks of gravity and it has not moved a Q10 unit.
    expect(q10ToPixel(ball.x)).toBe(at.x);
    expect(q10ToPixel(ball.y)).toBe(at.y);
    expect(ball.velocityY).toBe(0);
    expect(ball.active).toBe(true);
  });

  it("does not drain a held ball even below the drain line", () => {
    const map = mapFor("law-n-justice");
    const materials = materialTableFor("law-n-justice");
    const set = createBallSet();
    const held = spawnBall(set, pixelsToQ10(168), pixelsToQ10(599), 0, 4000, 0);
    held.heldBy = "some-saucer";
    const rolling = spawnBall(set, pixelsToQ10(168), pixelsToQ10(599), 0, 4000, 0);

    const step = stepBalls(set, map, materials, {
      gravityY: SIMULATION_GRAVITY,
      nudgeX: 0,
      nudgeY: 0,
    });
    expect(step.drained).toEqual([rolling.id]);
    expect(held.active).toBe(true);
  });

  // -------------------------------------------------------------------------
  // THE DECODED LADDER, per table. These used to assert the port's "two
  // saucers held lights a three-ball multiball" reconstruction; the dispatch
  // is now decoded (award effect 6 — see ball-locks.ts and mode-vm.ts) and the
  // expectations below are the decoded rules, table by table. The correction
  // is deliberate and is exactly the "never weaken a test" case working as
  // intended: the old expectations encoded a reconstruction, not a measurement.
  // -------------------------------------------------------------------------

  /** Runs until a tick reports the multiball starting, or -1. */
  function runToMultiball(game: Game, input: InputSource, budget: number): number {
    for (let tick = 0; tick < budget; tick += 1) {
      if (runTicks(game, input, 1)[0]?.multiballStarted === true) return tick;
    }
    return -1;
  }

  /** Every display line shown over a stretch of ticks. */
  function collectMessages(game: Game, input: InputSource, ticks: number): Set<string> {
    const seen = new Set<string>();
    for (let tick = 0; tick < ticks; tick += 1) {
      runTicks(game, input, 1);
      for (const line of debugSnapshot(game).modeMessages) seen.add(line);
    }
    return seen;
  }

  it("babewatch starts a TWO-ball multiball on the FIRST counted lock", () => {
    // The decoded ladder h4+0x49F8: id 1 -> launcher script 110, "BALL 1
    // LOCKED", MODE_START 179 ("SHOW YOUR MUSCLES", BALLS_UP_TO 2). The lock
    // lamp is lit at game start (the labelled reconstruction in
    // table-modes.ts), so the very first grid saucer capture counts.
    const game = started("babewatch");
    runTicks(game, idleInput(), 60);
    const grid = ballLocksFor("babewatch").find((one) => one.id === "grid-top");
    expect(grid).toBeDefined();
    if (grid === undefined) return;

    const ball = dropInto(game, grid);
    const report = runTicks(game, idleInput(), 1)[0];
    expect(report?.locked, "capture").toContain(ball.id);
    // Not instantly: the capture script, the launcher and the mode's intro all
    // run through the queue at one opcode a frame first.
    expect(report?.multiballStarted).toBe(false);
    const servedBefore = debugSnapshot(game).ballsServed;

    expect(runToMultiball(game, idleInput(), 600), "multiball never started").toBeGreaterThanOrEqual(0);
    const state = debugSnapshot(game);
    expect(state.multiball).toBe(true);
    // TWO balls, because script 179 says BALLS_UP_TO 2 — not the old three.
    expect(freeBallCount(game.balls) + state.pendingServes, "balls promised").toBe(2);
    // The capture script's PUSH ejected the held ball back through the trough.
    expect(state.locks, "saucer emptied by the scripted eject").toEqual([]);
    // The player is never charged for any of it.
    expect(state.ballsServed).toBe(servedBefore);
  });

  it("babewatch's second counted lock is the positional alternate: 1 MORE TO START MODE", () => {
    // Ladder id 2 -> launcher 111, which prints and starts nothing. The
    // alternates are not a fallback for a busy mode — they are ordinary ladder
    // positions, settled by the decoded table.
    const game = started("babewatch");
    runTicks(game, idleInput(), 60);
    const grid = ballLocksFor("babewatch").find((one) => one.id === "grid-top");
    if (grid === undefined) return;

    dropInto(game, grid);
    expect(runToMultiball(game, idleInput(), 600)).toBeGreaterThanOrEqual(0);

    dropInto(game, grid);
    const seen = collectMessages(game, idleInput(), 300);
    expect([...seen].some((line) => line.includes("1 MORE TO START MODE")), [...seen].join(" | ")).toBe(true);
  });

  it("law-n-justice's jail counts nothing while its lamp is unlit: the capture just ejects", () => {
    // Script 63's JMP_IF_UNLIT(26) — the jail lamp is lit by the SHOOT JAIL
    // targets (device surface ids 128/129), decoded, so a fresh game's first
    // jail capture is spat back out uncounted.
    const game = started("law-n-justice");
    const modes = modesFor("law-n-justice");
    runTicks(game, idleInput(), 60);
    const jail = ballLocksFor("law-n-justice").find((one) => one.id === "right-crater");
    expect(jail).toBeDefined();
    if (jail === undefined) return;
    const ladder = modes.elements[26]?.ladder ?? -1;
    expect(ladder, "element 26 must carry the multiball ladder").toBeGreaterThanOrEqual(0);

    dropInto(game, jail);
    runTicks(game, idleInput(), 200);
    expect(game.modeState?.ladderCounts[ladder]).toBe(0);
    const state = debugSnapshot(game);
    expect(state.multiball).toBe(false);
    expect(state.locks, "ejected, not held").toEqual([]);
  });

  it("law-n-justice starts a TWO-ball multiball on the second LIT jail lock", () => {
    // The decoded ladder h4+0x40F4: tiers of 2/3/4/5 jail locks, multiball at
    // ids 2/5/9/14. Id 1 -> launcher 80 ("1 MORE FOR M-BALL", ejects the
    // jail); id 2 -> launcher 88 -> MODE_START 93 (BALL_REMOVE jail,
    // BALLS_UP_TO 2).
    const game = started("law-n-justice");
    const modes = modesFor("law-n-justice");
    runTicks(game, idleInput(), 60);
    const jail = ballLocksFor("law-n-justice").find((one) => one.id === "right-crater");
    if (jail === undefined) return;
    const ladder = modes.elements[26]?.ladder ?? -1;

    // Light the jail lamp the decoded way: the script the SHOOT JAIL targets
    // fire, which STARTs element 26.
    const shootJail = modes.scriptForDevice(0, 128);
    expect(shootJail).toBeGreaterThanOrEqual(0);
    expect(game.modeState).not.toBeNull();
    if (game.modeState === null) return;
    queueScript(game.modeState, shootJail);
    runTicks(game, idleInput(), 10);

    // First counted lock: the alternate. Ball ejected, no multiball.
    dropInto(game, jail);
    const seen = collectMessages(game, idleInput(), 200);
    expect(game.modeState.ladderCounts[ladder]).toBe(1);
    expect([...seen].some((line) => line.includes("MORE FOR M-BALL")), [...seen].join(" | ")).toBe(true);
    expect(debugSnapshot(game).multiball).toBe(false);
    expect(debugSnapshot(game).locks, "intermediate locks eject").toEqual([]);

    // Second counted lock completes the tier: the ball stays held for the
    // mode's BALL_REMOVE, and the mode tops the table up to two.
    dropInto(game, jail);
    expect(runToMultiball(game, idleInput(), 600), "multiball never started").toBeGreaterThanOrEqual(0);
    expect(game.modeState.ladderCounts[ladder]).toBe(2);
    const state = debugSnapshot(game);
    expect(state.multiball).toBe(true);
    expect(state.locks, "BALL_REMOVE emptied the jail").toEqual([]);
    expect(freeBallCount(game.balls) + state.pendingServes, "balls promised").toBe(2);
    // Script 93 puts the jail lamp out again: the next multiball needs the
    // SHOOT JAIL targets first.
    expect(game.modeState.armed[26]).toBe(0);
  });

  it("extreme-sports locks eject the ball and start no multiball", () => {
    // Decoded as far as it goes: ES's lock capture scripts (36/37) award
    // effect-17 elements — a direct event dispatch whose handler is NOT
    // decoded — and always PUSH the ball back out. Until effect 17 is traced,
    // an ES lock is a scoring eject, and this asserts exactly that rather than
    // inventing a rule. See docs/GAMEPLAY_PARITY.md.
    const game = started("extreme-sports");
    runTicks(game, idleInput(), 60);
    const bowl = ballLocksFor("extreme-sports").find((one) => one.id === "bowl");
    expect(bowl).toBeDefined();
    if (bowl === undefined) return;

    const ball = dropInto(game, bowl);
    const report = runTicks(game, idleInput(), 1)[0];
    expect(report?.locked).toContain(ball.id);
    runTicks(game, idleInput(), 200);
    const state = debugSnapshot(game);
    expect(state.locks, "ejected by the capture script's PUSH").toEqual([]);
    expect(state.multiball).toBe(false);
  });

  it("feeds a three-ball multiball out of the lane one at a time and gets three rolling", () => {
    // BabeWatch tier 2: two locks counted, the third completes the tier and
    // MODE_STARTs script 182 ("SURF THEM WAVES", BALLS_UP_TO 3). The counter
    // is preset to 2 exactly as the decoded SET_COUNT opcode does it, so one
    // capture completes the tier without three minutes of steering.
    const game = started("babewatch");
    const modes = modesFor("babewatch");
    const input = playingInput();
    clearTheLane(game, input);
    const ladder = modes.elements[29]?.ladder ?? -1;
    expect(ladder).toBeGreaterThanOrEqual(0);
    expect(game.modeState).not.toBeNull();
    if (game.modeState === null) return;
    game.modeState.ladderCounts[ladder] = 2;

    const grid = ballLocksFor("babewatch").find((one) => one.id === "grid-top");
    if (grid === undefined) return;
    dropInto(game, grid);
    expect(runToMultiball(game, input, 900), "multiball never started").toBeGreaterThanOrEqual(0);
    expect(debugSnapshot(game).multiball).toBe(true);

    let peak = 0;
    for (let tick = 0; tick < 1500; tick += 1) {
      runTicks(game, input, 1);
      const state = debugSnapshot(game);
      // Never two balls on the rod at once, whatever else happens: one lane, one
      // ball, exactly as the original's `$D88/$D89(a5)` interlock enforces.
      const onRod = state.balls.filter(
        (ball) => ball.active && ball.id === state.laneBallId,
      ).length;
      expect(onRod).toBeLessThanOrEqual(1);
      peak = Math.max(peak, freeBallCount(game.balls));
      if (peak >= 3) break;
    }
    expect(peak, "balls simultaneously in play").toBe(3);
    expect(peak).toBeLessThanOrEqual(MAX_SIMULTANEOUS_BALLS);
  });

  it("auto-launches the balls it served itself, and only those", () => {
    const patient = started("law-n-justice");
    // The player's own ball is never auto-launched: it sits on the rod for as
    // long as the player likes, which is the whole point of a plunger.
    runTicks(patient, idleInput(), 60 + AUTO_LAUNCH_DELAY_TICKS * 6);
    expect(
      debugSnapshot(patient).laneBallId,
      "the player's ball was fired for them",
    ).not.toBeNull();

    // The machine's own do go, and nothing on the input has to ask for it: the
    // count below is taken while the player holds no control at all. The
    // three-ball tier is used so the machine owes at least two serves — the
    // scripted eject of the captured ball plus the top-up.
    const game = started("babewatch");
    const modes = modesFor("babewatch");
    clearTheLane(game, playingInput());
    const ladder = modes.elements[29]?.ladder ?? -1;
    if (game.modeState === null) return;
    game.modeState.ladderCounts[ladder] = 2;
    const grid = ballLocksFor("babewatch").find((one) => one.id === "grid-top");
    if (grid === undefined) return;
    dropInto(game, grid);

    let launches = 0;
    for (let tick = 0; tick < 900; tick += 1) {
      if (runTicks(game, idleInput(), 1)[0]?.launched === true) launches += 1;
    }
    expect(launches, "machine-served balls left the lane on their own").toBeGreaterThanOrEqual(2);
  });

  it("reframes the camera to the whole table for multiball, and not for a locked ball", () => {
    const rolling = (id: number, y: number): BallState => ({
      id,
      x: pixelsToQ10(168),
      y: pixelsToQ10(y),
      velocityX: 0,
      velocityY: 0,
      active: true,
      heldBy: null,
      level: 0,
    });
    const held = (id: number, y: number): BallState => ({ ...rolling(id, y), heldBy: "saucer" });

    // One rolling ball and one in a saucer is not multiball, and the close view
    // is what the player wants.
    expect(resolveMode([rolling(0, 400), held(1, 100)], DEFAULT_CAMERA_OPTIONS)).toBe("scrolling");
    // Give it back and it is.
    expect(resolveMode([rolling(0, 400), rolling(1, 100)], DEFAULT_CAMERA_OPTIONS)).toBe(
      "full-table",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. It cannot hang
// ---------------------------------------------------------------------------

describe("the zero-deadlock guarantee, restated for locks", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId} keeps playing when a lock swallows the only ball on the table`, () => {
      const game = started(tableId);
      runTicks(game, idleInput(), 60);
      // Get rid of the served ball so the locked one is genuinely the last.
      for (const ball of game.balls.balls) ball.active = false;
      game.laneBallId = null;

      const device = ballLocksFor(tableId)[0]!;
      dropInto(game, device);
      runTicks(game, idleInput(), 1);
      expect(heldBallCount(game.locks), `${tableId} capture`).toBe(1);
      expect(freeBallCount(game.balls), `${tableId} table emptied`).toBe(0);

      // The machine owes a replacement and pays it.
      expect(debugSnapshot(game).pendingServes, `${tableId} replacement queued`).toBe(1);

      // Watched every tick rather than sampled at the end, and the difference is
      // the timebase. A replacement the MACHINE owes is auto-launched — the
      // player is not asked to wind a spring for a ball they did not lose — and
      // at the measured gravity that ball can complete its whole trip and drain
      // inside the four hundred ticks this waits, leaving the table empty again
      // with a fresh serve pending. That is the machine working, and the sample
      // at the end read it as the machine never having paid at all.
      let everFree = 0;
      for (let tick = 0; tick < 400; tick += 1) {
        runTicks(game, idleInput(), 1);
        everFree = Math.max(everFree, freeBallCount(game.balls));
      }
      const state = debugSnapshot(game);
      expect(state.phase, `${tableId} phase`).toBe("in-play");
      expect(everFree, `${tableId} never got its replacement ball`).toBeGreaterThan(0);
    });

    it(`${tableId} ends the ball when the last one drains with a saucer still full`, () => {
      // The hang this is here to stop: a held ball is ACTIVE, so an end-of-ball
      // test written against the active count never fires, no serve is ever
      // queued, and the ball search is right to ignore the only ball left.
      const game = started(tableId);
      runTicks(game, idleInput(), 60);

      const device = ballLocksFor(tableId)[0]!;
      dropInto(game, device);
      runTicks(game, idleInput(), 1);
      expect(heldBallCount(game.locks)).toBe(1);

      // Drain everything that is not held, and cancel what the machine owes, so
      // the only thing left on the table is the ball in the saucer.
      for (const ball of game.balls.balls) {
        if (ball.heldBy === null) ball.active = false;
      }
      game.laneBallId = null;
      game.pendingServes = 0;
      game.serveCountdown = 0;

      // One tick with a drain in it takes the end-of-ball path.
      const spare = spawnBall(game.balls, pixelsToQ10(168), pixelsToQ10(599), 0, 4000, 0);
      expect(spare.active).toBe(true);
      runTicks(game, idleInput(), 1);

      expect(heldBallCount(game.locks), `${tableId} saucer not emptied at end of ball`).toBe(0);
      // And the machine moves on rather than sitting there.
      runTicks(game, idleInput(), 400);
      const state = debugSnapshot(game);
      expect(
        state.phase === "game-over" || freeBallCount(game.balls) > 0,
        `${tableId} neither served nor ended`,
      ).toBe(true);
    });

    it(`${tableId} still finishes a three-ball game with every saucer used`, () => {
      // The whole lifecycle end to end: lock, replace, multiball, drain out of
      // it, and reach game over inside a generous budget.
      const game = createGame(mapFor(tableId), { ballsPerGame: 3 });
      startGame(game);
      const input = playingInput();
      let overflow = 0;
      // THE STIMULUS IS BOUNDED AND THE BUDGET IS A MEASUREMENT.
      //
      // Steering a ball into a saucer every 500 ticks is not a neutral probe: a
      // capture the machine has to replace, and a second capture that lights
      // multiball and tops the table back up to three, together MANUFACTURE
      // BALLS. Run without a bound it is an infinite free-ball supply, and the
      // only thing that ever ended the game was the ball being lost. That used
      // to happen often enough to hide it; it does not now, because the ball is
      // much harder to lose — the habitrail delivery (surface id 11) hands a
      // stranded ball back to the inlane, and the measured pop-bumper kick is
      // 5500 of the original's velocity units where this project had been
      // guessing 560. Left unbounded, Extreme Sports plays forever: six hundred
      // thousand ticks, three hundred million points and still on ball one, with
      // no ball ever stuck.
      //
      // So the steering stops after 40,000 ticks — eighty capture opportunities,
      // which is "over and over" by any reading — and the game is then required
      // to finish on its own. Measured to game-over that way:
      // Law 'n Justice 39,586, BabeWatch 41,819, Extreme Sports 47,527, all
      // three with `ballsServed` at 3.
      const STEER_UNTIL = 40_000;
      for (let tick = 0; tick < 100_000; tick += 1) {
        runTicks(game, input, 1);
        // Drop a ball into a saucer whenever one is free, so the locks are
        // exercised over and over rather than once.
        if (tick % 500 === 250 && tick < STEER_UNTIL) {
          const empty = ballLocksFor(tableId).find(
            (device) => heldBallIn(game.locks, device.id) === null,
          );
          if (empty !== undefined) steerIntoLock(game, empty);
        }
        overflow = Math.max(overflow, freeBallCount(game.balls));
        if (debugSnapshot(game).phase === "game-over") break;
      }
      expect(debugSnapshot(game).phase, `${tableId} never finished`).toBe("game-over");
      expect(
        overflow,
        `${tableId} put ${overflow} balls on the playfield at once`,
      ).toBeLessThanOrEqual(MAX_SIMULTANEOUS_BALLS);
    });
  }

  it("returns a ball stranded in an occupied saucer to the trough, not the drain", () => {
    // The site the first census at the measured flipper found, reproduced
    // literally: BabeWatch's lower-bowl saucer holds ball one, and the
    // replacement ball settles at the physical bottom of the same bowl —
    // (219,290), inside the saucer's (200,250)-(230,295) rectangle — where
    // capture must refuse it (the engine's occupied-means-ignore) and gravity,
    // the ramp drive and the slingshot pulses cannot return it. The ball search
    // used to retire it as a write-off; the fix swallows it to the trough as an
    // owed serve, which is what the decoded release path ($68) does with every
    // ball that leaves a saucer. See `runBallSearch` in game-loop.ts.
    const game = createGame(mapFor("babewatch"), { ballsPerGame: 3, ballSearchTicks: 40 });
    startGame(game);
    runTicks(game, idleInput(), 60);

    // The served ball comes off the rod and is parked at the strand site.
    const state = debugSnapshot(game);
    const stray = game.balls.balls.find((one) => one.id === state.laneBallId);
    expect(stray).toBeDefined();
    if (stray === undefined) return;
    game.laneBallId = null;
    stray.x = pixelsToQ10(219);
    stray.y = pixelsToQ10(290);
    stray.velocityX = 0;
    stray.velocityY = 0;
    stray.level = 0;

    // The bowl is occupied by a DIFFERENT ball, held exactly as a capture
    // leaves one. Set directly rather than via captureBalls, which would take
    // the parked ball first — it is also inside the rectangle, which is the
    // whole point.
    const bowl = ballLocksFor("babewatch").find((device) => device.id === "lower-bowl");
    expect(bowl).toBeDefined();
    if (bowl === undefined) return;
    const held = spawnBall(game.balls, pixelsToQ10(228), pixelsToQ10(257), 0, 0, bowl.level);
    held.heldBy = bowl.id;
    game.locks.held.set(bowl.id, held.id);

    // Run until the search acts, and stop there: the re-served ball would go on
    // to drain under an idle player, which is the ordinary end of ball one and
    // not what this test is about.
    const swallowed: number[] = [];
    const drained: number[] = [];
    for (let tick = 0; tick < 400 && swallowed.length === 0; tick += 1) {
      const report = runTicks(game, idleInput(), 1)[0]!;
      swallowed.push(...report.swallowed);
      drained.push(...report.drained);
    }

    // Swallowed to the trough, never drained and never written off.
    expect(swallowed).toContain(stray.id);
    expect(drained).not.toContain(stray.id);
    // The saucer keeps the ball it was legitimately holding.
    expect(heldBallIn(game.locks, bowl.id)).toBe(held.id);
    // The machine owes itself the serve, and the player is not charged a ball
    // for it: this is still ball one, and it comes back out of the lane.
    expect(debugSnapshot(game).pendingServes).toBe(1);
    runTicks(game, idleInput(), 60);
    const after = debugSnapshot(game);
    expect(after.phase).toBe("in-play");
    expect(after.ballsServed).toBe(1);
    expect(after.laneBallId !== null || freeBallCount(game.balls) > 0).toBe(true);
  });
});

describe("what is decoded and what is not", () => {
  it("says so out loud", () => {
    // A reader has to be able to find out which half of this is measured without
    // reading the disassembly, so the note is part of the module's interface.
    expect(BALL_LOCK_RULES_NOTE).toMatch(/reconstruction, not decoded fact/);
    // And the decoded half now includes the multiball rule itself.
    expect(BALL_LOCK_RULES_NOTE).toMatch(/multiball lock ladder/);
  });

  it("releases exactly the saucer a scripted eject names", () => {
    const bank = createLockBank("law-n-justice");
    const set = createBallSet();
    const jail = lockForZone(bank, 0, 6);
    expect(jail?.id).toBe("right-crater");
    if (jail === null || jail === undefined) return;
    const at = centreOf(jail);
    const ball = spawnBall(set, pixelsToQ10(at.x), pixelsToQ10(at.y), 0, 0, jail.level);
    captureBalls(bank, set.balls);
    expect(heldBallIn(bank, jail.id)).toBe(ball.id);

    // A miss releases nothing.
    expect(releaseLock(bank, "grid-top", set.balls)).toBe(null);
    expect(heldBallCount(bank)).toBe(1);
    // The named device gives its ball to the trough.
    expect(releaseLock(bank, jail.id, set.balls)).toBe(ball.id);
    expect(ball.active).toBe(false);
    expect(ball.heldBy).toBe(null);
    expect(heldBallCount(bank)).toBe(0);
  });

  it("keeps the rectangles exactly as they were read off the table modules", () => {
    // A change-detector on purpose, and the only one in this file: these numbers
    // came out of `Table00N.seg04`'s zone lists and nothing in this repository
    // may quietly adjust them to make a ball behave. Re-decode the module if they
    // need to move. The zone index is part of the decode: it is the slot the
    // mission layer's `triggers.locks` binds the capture script under.
    expect(BALL_LOCKS_BY_TABLE["law-n-justice"].map((one) => [one.id, one.level, one.zoneIndex, one.minX, one.minY, one.maxX, one.maxY])).toEqual([
      ["jail-top", 0, 5, 85, 60, 145, 100],
      ["right-crater", 0, 6, 235, 165, 260, 190],
      ["jail-throat", 0, 7, 55, 170, 85, 200],
    ]);
    expect(BALL_LOCKS_BY_TABLE["babewatch"].map((one) => [one.id, one.level, one.zoneIndex, one.minX, one.minY, one.maxX, one.maxY])).toEqual([
      ["grid-top", 0, 15, 66, 48, 86, 68],
      ["grid-mid", 0, 16, 152, 110, 172, 130],
      ["top-lane", 0, 17, 145, 14, 165, 34],
      ["lower-bowl", 0, 18, 200, 250, 230, 295],
      ["upper-deck", 1, 8, 70, 40, 110, 80],
    ]);
    expect(BALL_LOCKS_BY_TABLE["extreme-sports"].map((one) => [one.id, one.level, one.zoneIndex, one.minX, one.minY, one.maxX, one.maxY])).toEqual([
      ["bowl", 0, 12, 249, 159, 269, 179],
      ["upper-orbit", 1, 10, 65, 10, 105, 50],
    ]);
  });
});
