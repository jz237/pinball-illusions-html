/**
 * WHAT HAPPENS AFTER THE SECOND BALL ARRIVES.
 *
 * `tests/multiball-reach.test.ts` proves a player can GET to a multiball. It
 * then returns on the tick the machine promised a second ball —
 * `if (started && promised >= 2) return { started, promised }` — so everything
 * that runs DURING a multiball was still unexercised when it was green. This
 * project has now caught five instruments that were blind in exactly that way,
 * and the reach test was the sixth: measured against it, all three tables
 * mishandled the end of a multiball and the suite stayed at 1,719 passed.
 *
 * What this file asserts, and why each one is here:
 *
 *   1. THE MISSION WINDS UP WITH THE MULTIBALL. `+0x0057A8` clears the
 *      multiball flag and `+0x0057AC` sets the teardown latch `$d9d`; the
 *      mission frame at `+0x0057B6` then diverts the running `WAIT` to `$db8`
 *      (opcode 30's operand) or, when unset, to the `WAIT`'s own `$db6`.
 *      All thirteen multiball missions in the game park on a `WAIT` with no
 *      clock, so without that latch they have NO WAY TO END: Law 'n Justice's
 *      script 93 and BabeWatch's 179 sat suspended for the whole rest of the
 *      ball, holding the one mission slot shut.
 *   2. AN INDEFINITE `WAIT` IS INDEFINITE. `+0x005E2E`'s `bmi` stores a
 *      negative seconds operand into `$dae` unmultiplied and `+0x0057C0`'s
 *      `bmi` then refuses to decrement it. Extreme Sports script 166 pc 76 is
 *      `WAIT -1, -1, 86` — no element and no clock — and it is the entire body
 *      of that table's three-ball multiball. Read as "no clock, fall through",
 *      that mission ended eleven ticks after `BALLS_UP_TO`, before the second
 *      ball had been served.
 *   3. A BALL IN A SAUCER IS STILL A BALL IN PLAY. `$d7e` is what both the
 *      top-up (`+0x005BD6`) and the end test (`+0x00579E`) count, and the lock
 *      capture handler at `+0x00552A` never decrements it.
 *   4. THE COUNT AND THE CONTACT MODEL HOLD UP UNDER REAL MULTIBALL PLAY: the
 *      machine never has more than its three ball records anywhere, and two
 *      balls never pass through each other.
 *
 * The intervention every driven case makes is the same one `multiball-reach`
 * makes and it is stated there: the ball is parked on a free centre when it
 * falls below the flippers, because a bot cannot keep three balls alive for the
 * thousands of ticks a multiball lasts. Nothing else is touched — every award,
 * every script, the ladder, `BALLS_UP_TO`, the trough and the wind-up are the
 * shipped rules.
 */

import { describe, expect, it } from "vitest";
import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { Game, InputSource } from "../src/browser/game-loop.js";
import { mapFor, modesFor } from "./table-fixtures.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { PlayfieldLevel, TableId } from "../src/game/contracts.js";
import { ballLocksFor, MAX_SIMULTANEOUS_BALLS } from "../src/game/ball-locks.js";
import { BALL_RADIUS_PIXELS } from "../src/game/collision-probe.js";
import {
  createModeState,
  endMission,
  queueScript,
  signalMultiballEnded,
  tickModes,
} from "../src/game/mode-vm.js";
import type { ModeState } from "../src/game/mode-vm.js";

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

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

/** Taps the plunger every 400 ticks and works both bats on a fixed beat. */
function playingInput(): ScriptedInput {
  return new ScriptedInput((tick) => {
    const controls: Control[] = [];
    const beat = tick % 400;
    if (beat >= 40 && beat < 46) controls.push("plunger");
    if (tick % 23 < 3) controls.push("leftFlipper", "rightFlipper");
    return controls;
  });
}

function launchFromLane(game: Game, input: InputSource): boolean {
  for (let tick = 0; tick < 600; tick += 1) {
    runTicks(game, input, 1);
    const state = debugSnapshot(game);
    if (state.laneBallId === null && state.balls.some((one) => one.active)) return true;
  }
  return false;
}

/**
 * See the header: the stated intervention, and the only one.
 *
 * Returns the id of the ball it moved, or -1. The swept ball-ball test below
 * has to EXCLUDE that ball for the tick: a park is a 115 px teleport and the
 * chord between its two positions runs through half the lower playfield, which
 * is a fact about this harness and not about the contact model.
 */
function parkBall(game: Game, onlyBelow = -1): number {
  const snapshot = debugSnapshot(game);
  const laneId = snapshot.laneBallId;
  const ball = game.balls.balls.find(
    (one) => one.active && one.heldBy === null && one.id !== laneId,
  );
  if (ball === undefined) return -1;
  if (onlyBelow >= 0) {
    const view = snapshot.balls.find((one) => one.id === ball.id);
    if (view === undefined || view.pixelY < onlyBelow) return -1;
  }
  ball.x = pixelsToQ10(168);
  ball.y = pixelsToQ10(430);
  ball.velocityX = 0;
  ball.velocityY = 0;
  ball.level = 0 as PlayfieldLevel;
  return ball.id;
}

/**
 * ONE BALL PASSED THROUGH THE OTHER — a contact the responder never answered.
 *
 * Three conditions, and all three are load-bearing:
 *
 *   1. Their centres came within a diameter at some point DURING the tick,
 *      minimising |(pa-pb) + t(va-vb)| over t in [0,1]. Per-tick sampling
 *      cannot see this any other way: two balls can be 20 px apart before a
 *      frame and 20 px apart after it and have swapped places in between.
 *   2. The relative position vector REVERSED. A contact that was answered
 *      pushes the pair back the way it came and keeps the sign; only a ball
 *      that went THROUGH another comes out on the far side.
 *   3. They ended CLEAR of each other by a margin. This is the condition that
 *      separates a defect from a fast glancing pass, and it was measured
 *      rather than assumed: across 292,000 ticks of driven multiball,
 *      conditions 1 and 2 alone fired thirteen times and every one of the
 *      thirteen ended at 16.03 to 16.49 px against a 16 px diameter — the
 *      separation rule clamping the pair to exactly touching. A contact that
 *      was MISSED leaves the balls wherever their velocities took them, which
 *      is not within half a pixel of the contact distance.
 */
function passedThrough(
  a0: { x: number; y: number },
  a1: { x: number; y: number },
  b0: { x: number; y: number },
  b1: { x: number; y: number },
  contact: number,
): boolean {
  const before = Math.hypot(a0.x - b0.x, a0.y - b0.y);
  const after = Math.hypot(a1.x - b1.x, a1.y - b1.y);
  if (before <= contact || after <= contact + 2) return false;
  const rx = a0.x - b0.x;
  const ry = a0.y - b0.y;
  const vx = a1.x - a0.x - (b1.x - b0.x);
  const vy = a1.y - a0.y - (b1.y - b0.y);
  const vv = vx * vx + vy * vy;
  const t = vv > 1e-12 ? Math.min(1, Math.max(0, -(rx * vx + ry * vy) / vv)) : 0;
  if (Math.hypot(rx + t * vx, ry + t * vy) >= contact) return false;
  return rx * (a1.x - b1.x) + ry * (a1.y - b1.y) < 0;
}

const OP_MODE_START = 9;
const OP_BALLS_UP_TO = 27;

/**
 * The ladder rungs that launch a multiball, read out of the shipped document.
 *
 * A ladder entry is a LAUNCHER whose body is one `MODE_START`, and the
 * `BALLS_UP_TO` lives inside the mission it starts. Queueing a launcher is
 * doing by hand what the counter does when the shot is made; everything after
 * it is the machine.
 */
function multiballLaunchers(tableId: TableId): number[] {
  const modes = modesFor(tableId);
  const multiballScripts = new Set<number>();
  for (const script of modes.scripts) {
    for (const op of script.ops) {
      if (op.op === OP_BALLS_UP_TO && (op.args[0] ?? 0) > 1) multiballScripts.add(script.index);
    }
  }
  const launchers: number[] = [];
  for (const script of modes.scripts) {
    for (const op of script.ops) {
      if (op.op === OP_MODE_START && multiballScripts.has(op.args[0] ?? -1)) {
        if (!launchers.includes(script.index)) launchers.push(script.index);
      }
    }
  }
  return launchers;
}

interface MultiballRun {
  readonly started: boolean;
  /** Tick the count fell back to one, or -1. */
  readonly endedAt: number;
  /** Tick the mission that owned the multiball ended, or -1. */
  readonly missionEndedAt: number;
  readonly maxLive: number;
  /** Was the mission that started it still running when the balls all arrived? */
  readonly missionAliveAtPeak: boolean;
  readonly peakInHand: number;
  readonly worstOverlap: number;
  readonly tunnelTicks: number;
  readonly multiballTicks: number;
}

/**
 * Starts a multiball through the shipped launcher and watches it to the end.
 *
 * `ticks` is a budget, not a duration: it returns as soon as the multiball has
 * ended AND the mission that owned it has ended, so a healthy tree finishes in
 * a second or two and a broken one still has room to prove it.
 */
function runOneMultiball(tableId: TableId, ticks: number): MultiballRun {
  const game = createGame(mapFor(tableId), { ballsPerGame: 5 });
  startGame(game);
  const input = playingInput();
  launchFromLane(game, input);
  const state = game.modeState;
  const launchers = multiballLaunchers(tableId);
  expect(state, `${tableId} has a mission layer`).not.toBeNull();
  expect(launchers.length, `${tableId} has a multiball launcher`).toBeGreaterThan(0);
  if (state === null || launchers.length === 0) {
    return {
      started: false, endedAt: -1, missionEndedAt: -1, maxLive: 0,
      missionAliveAtPeak: false,
      peakInHand: 0, worstOverlap: 0, tunnelTicks: 0, multiballTicks: 0,
    };
  }

  let started = false;
  let endedAt = -1;
  let missionEndedAt = -1;
  let owner = -1;
  let maxLive = 0;
  let missionAliveAtPeak = false;
  let peakInHand = 0;
  let worstOverlap = 0;
  let tunnelTicks = 0;
  let multiballTicks = 0;
  const r2 = BALL_RADIUS_PIXELS * 2;
  let previous = new Map<number, { x: number; y: number; level: number }>();

  for (let tick = 0; tick < ticks; tick += 1) {
    const parked = parkBall(game, 540);
    if (!started && tick % 200 === 0 && debugSnapshot(game).mission === null) {
      queueScript(state, launchers[0] as number);
    }
    const report = runTicks(game, input, 1)[0];
    const snapshot = debugSnapshot(game);
    if (snapshot.phase === "game-over") break;

    if (report?.multiballStarted === true) {
      started = true;
      owner = snapshot.mission?.index ?? -1;
    }
    if (snapshot.multiball) multiballTicks += 1;
    if (started && endedAt < 0 && !snapshot.multiball) endedAt = snapshot.tick;
    if (started && missionEndedAt < 0 && report?.missionEnded === true) {
      missionEndedAt = snapshot.tick;
    }

    const live = snapshot.balls.filter((one) => one.active && one.heldBy === null);
    if (live.length > maxLive) {
      maxLive = live.length;
      // THE MISSION MUST OUTLIVE ITS OWN BALLS ARRIVING. Extreme Sports script
      // 166's body is one clockless WAIT, and read as "fall through" it ended
      // eleven ticks after `BALLS_UP_TO 3` — with two of the three balls still
      // owed to the lane. The wind-up test alone cannot see that: the mission
      // had already ended long BEFORE the count fell, so the interval it
      // measures was negative and passed.
      if (started && live.length >= 2) {
        missionAliveAtPeak = snapshot.mission !== null && snapshot.mission.index === owner;
      }
    }
    const inHand = live.length + snapshot.locks.length + snapshot.pendingServes;
    if (inHand > peakInHand) peakInHand = inHand;

    const now = new Map<number, { x: number; y: number; level: number }>();
    for (const ball of live) now.set(ball.id, { x: ball.pixelX, y: ball.pixelY, level: ball.level });
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i];
        const b = live[j];
        if (a === undefined || b === undefined || a.level !== b.level) continue;
        const d = Math.hypot(a.pixelX - b.pixelX, a.pixelY - b.pixelY);
        if (r2 - d > worstOverlap) worstOverlap = r2 - d;
        if (parked === a.id || parked === b.id) continue;
        const pa = previous.get(a.id);
        const pb = previous.get(b.id);
        if (pa === undefined || pb === undefined) continue;
        if (pa.level !== a.level || pb.level !== b.level) continue;
        if (passedThrough(pa, { x: a.pixelX, y: a.pixelY }, pb, { x: b.pixelX, y: b.pixelY }, r2)) {
          tunnelTicks += 1;
        }
      }
    }
    previous = now;

    if (started && endedAt >= 0 && (missionEndedAt >= 0 || owner < 0)) {
      if (snapshot.tick > endedAt + 200) break;
    }
  }
  return {
    started, endedAt, missionEndedAt, maxLive, missionAliveAtPeak,
    peakInHand, worstOverlap, tunnelTicks, multiballTicks,
  };
}

// ---------------------------------------------------------------------------
// 1. The mission winds up with the multiball
// ---------------------------------------------------------------------------

describe("a multiball mission ends when its multiball does", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId}: the mission that started the multiball has ended shortly after it`, () => {
      const run = runOneMultiball(tableId, 30_000);
      expect(run.started, `${tableId} never started a multiball`).toBe(true);
      expect(run.maxLive, "more than one ball was on the playfield").toBeGreaterThanOrEqual(2);
      expect(run.endedAt, `${tableId}'s multiball never ended`).toBeGreaterThan(0);
      expect(
        run.missionEndedAt,
        `${tableId}'s multiball mission never ended — the teardown latch at +0x0057AC is not reaching the WAIT`,
      ).toBeGreaterThan(0);
      // The wind-up is a straight run of LAMP_OFFs, a MUSIC restore and an
      // AWARD: a couple of dozen instructions, one per frame. Two hundred ticks
      // is four seconds and is generous by an order of magnitude.
      expect(run.missionEndedAt - run.endedAt).toBeLessThanOrEqual(200);
    });

    it(`${tableId}: the multiball lasts as long as the balls do, not one tick`, () => {
      const run = runOneMultiball(tableId, 30_000);
      // Extreme Sports script 166's whole body is `WAIT -1,-1,86`, so a port
      // that falls through an indefinite wait ends the mission before the
      // second ball is served. Measured at 4dd3a76: 11 ticks.
      expect(run.multiballTicks, `${tableId}'s multiball was over almost at once`).toBeGreaterThan(
        100,
      );
      expect(
        run.missionAliveAtPeak,
        `${tableId}: the mission ended before its own balls reached the playfield`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The WAIT operand signs, as the handler stores them
// ---------------------------------------------------------------------------

describe("WAIT's seconds operand", () => {
  /** Runs one script as a mission, from a clean state, for `ticks` frames. */
  function runScript(tableId: TableId, script: number, ticks: number): ModeState {
    const modes = modesFor(tableId);
    const state = createModeState(modes);
    state.mission = script;
    state.missionPc = 0;
    state.missionIndex = modes.missions.findIndex((one) => one.script === script);
    for (let tick = 0; tick < ticks; tick += 1) tickModes(modes, state);
    return state;
  }

  it("parks indefinitely when it is negative and there is no element to watch", () => {
    // Extreme Sports script 166: `... BALLS_UP_TO 3 / WAIT -1,-1,86 / CLEAR_BYTE ...`
    const modes = modesFor("extreme-sports");
    const body = modes.scripts[166];
    expect(body, "extreme-sports script 166").toBeDefined();
    const wait = body?.ops.find((op) => op.op === 28 && (op.args[0] ?? 0) < 0 && (op.args[1] ?? 0) < 0);
    expect(wait, "script 166's clockless, elementless WAIT").toBeDefined();
    expect(wait?.args[2], "its wind-up branch").toBe(86);

    const state = runScript("extreme-sports", 166, 4_000);
    expect(state.mission, "the mission ran to the WAIT and stayed there").toBe(166);
    expect(state.suspended, "it is parked").toBe(true);
    expect(state.waitIndefinite, "$dae is negative, so it never counts down").toBe(true);
    expect(state.missionPc, "parked at the instruction after the WAIT").toBe(86);
  });

  it("still times out when it is positive", () => {
    // Nothing above may weaken the ordinary timed wait. Script 166's FIRST
    // wait is `WAIT -1, 3, 60` at pc 50 — three seconds, 150 frames at the
    // 50 Hz clock — and both the clock and the branch after it must still work.
    const modes = modesFor("extreme-sports");
    const state = createModeState(modes);
    state.mission = 166;
    state.missionPc = 0;
    state.missionIndex = modes.missions.findIndex((one) => one.script === 166);
    let armed = -1;
    for (let tick = 0; tick < 20; tick += 1) {
      tickModes(modes, state);
      if (state.suspended) {
        armed = tick;
        break;
      }
    }
    expect(armed, "the mission reached its opening WAIT").toBeGreaterThanOrEqual(0);
    expect(state.waitIndefinite, "a positive operand is a real clock").toBe(false);
    expect(state.waitTicks, "three seconds at 50 Hz").toBeGreaterThan(100);
    // And it runs out and takes the branch, rather than parking for ever.
    for (let tick = 0; tick < 400 && state.suspended; tick += 1) tickModes(modes, state);
    expect(state.suspended, "the clock expired and the script moved on").toBe(false);
    expect(state.missionPc, "resumed at the WAIT's own timeout PC").toBe(60);
  });
});

// ---------------------------------------------------------------------------
// 3. The teardown latch
// ---------------------------------------------------------------------------

describe("the multiball teardown latch", () => {
  it("sends a parked mission to its WAIT's timeout branch when no SET_RESUME is set", () => {
    const modes = modesFor("extreme-sports");
    const state = runToPark(modes, 166);
    expect(state.suspended).toBe(true);
    expect(state.resumePc, "script 166 never runs SET_RESUME").toBe(-1);
    signalMultiballEnded(state);
    tickModes(modes, state);
    // `+0x0057E8 beq.b $57fc` — no `$db8`, so the WAIT's own `$db6` is used.
    expect(state.missionPc, "resumed at the WAIT's timeout PC").toBe(86);
    expect(state.suspended).toBe(false);
  });

  it("prefers SET_RESUME's operand when the script set one", () => {
    // Law 'n Justice script 202 opens `SET_RESUME 178` and its shot loop waits
    // on elements 125 and 124 with timeout 178 as well, so the operand is
    // exercised here on a synthetic park rather than by luck.
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);
    state.mission = 202;
    state.missionPc = 0;
    state.suspended = true;
    state.waitElement = -1;
    state.waitTimeoutPc = 999;
    state.resumePc = 178;
    signalMultiballEnded(state);
    tickModes(modes, state);
    expect(state.missionPc, "`$db8` wins over `$db6`").not.toBe(999);
    expect(state.resumePc, "`+0x0057F6 clr.w $db8(a5)` — it is consumed").toBe(-1);
  });

  it("does not survive the mission it tore down", () => {
    const modes = modesFor("extreme-sports");
    const state = createModeState(modes);
    state.mission = 166;
    signalMultiballEnded(state);
    expect(state.abortWait).toBe(true);
    endMission(state);
    expect(state.abortWait, "`+0x005864 clr.b $d9d(a5)`").toBe(false);
  });

  it("is not set when no mission is running", () => {
    const state = createModeState(modesFor("extreme-sports"));
    signalMultiballEnded(state);
    expect(state.abortWait).toBe(false);
  });

  function runToPark(modes: ReturnType<typeof modesFor>, script: number): ModeState {
    const state = createModeState(modes);
    state.mission = script;
    state.missionPc = 0;
    state.missionIndex = modes.missions.findIndex((one) => one.script === script);
    for (let tick = 0; tick < 4_000; tick += 1) tickModes(modes, state);
    return state;
  }
});

// ---------------------------------------------------------------------------
// 4. A ball in a saucer is still a ball in play
// ---------------------------------------------------------------------------

describe("a ball a saucer is holding counts against the machine's three", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId}: locking one ball of a live multiball does not end it`, () => {
      // The decisive case, and it is cheap to set up: get a multiball running,
      // then put one of its balls in a saucer. `$d7e` counts it — the capture
      // handler at `+0x00552A..+0x005588` sets the HELD flag, bumps `$23e4` and
      // queues the lock's script, and never touches the count — so the end test
      // at `+0x00579E` still sees two and the multiball runs on until the
      // saucer spits it back. Counting only the ROLLING balls ends it here.
      const game = createGame(mapFor(tableId), { ballsPerGame: 5 });
      startGame(game);
      const input = playingInput();
      expect(launchFromLane(game, input)).toBe(true);
      const state = game.modeState;
      const launchers = multiballLaunchers(tableId);
      expect(state).not.toBeNull();
      if (state === null) return;

      let reached = false;
      for (let tick = 0; tick < 30_000 && !reached; tick += 1) {
        parkBall(game, 540);
        if (tick % 200 === 0 && debugSnapshot(game).mission === null) {
          queueScript(state, launchers[0] as number);
        }
        runTicks(game, input, 1);
        const now = debugSnapshot(game);
        if (now.phase === "game-over") break;
        reached =
          now.multiball &&
          now.balls.filter((one) => one.active && one.heldBy === null).length >= 2 &&
          now.pendingServes === 0 &&
          now.locks.length === 0;
      }
      expect(reached, `${tableId}: two balls rolling and none owed`).toBe(true);

      // Put balls in saucers until exactly ONE is left rolling. A capture is
      // unconditional — the lamp only gates what the capture's script AWARDS —
      // so any saucer will do, and each one is tried in turn.
      const rollingNow = (): number =>
        debugSnapshot(game).balls.filter((one) => one.active && one.heldBy === null).length;
      const locks = ballLocksFor(tableId);
      for (const lock of locks) {
        if (rollingNow() <= 1) break;
        const laneId = debugSnapshot(game).laneBallId;
        const victim = game.balls.balls.find(
          (one) => one.active && one.heldBy === null && one.id !== laneId,
        );
        if (victim === undefined) break;
        victim.x = pixelsToQ10(Math.floor((lock.minX + lock.maxX) / 2));
        victim.y = pixelsToQ10(Math.floor((lock.minY + lock.maxY) / 2));
        victim.velocityX = 0;
        victim.velocityY = 0;
        victim.level = lock.level;
        runTicks(game, input, 3);
      }

      const after = debugSnapshot(game);
      expect(after.locks.length, "at least one saucer is holding a ball").toBeGreaterThan(0);
      expect(
        after.balls.filter((one) => one.active && one.heldBy === null).length,
        "exactly one ball left rolling",
      ).toBe(1);
      expect(after.pendingServes, "and nothing owed to the lane").toBe(0);
      expect(
        after.multiball,
        `${tableId}: the multiball ended because a saucer was holding one of its balls`,
      ).toBe(true);
    });
  }

  it("never lets the machine hold more than its three ball records", () => {
    for (const tableId of TABLE_IDS) {
      const run = runOneMultiball(tableId, 30_000);
      expect(
        run.peakInHand,
        `${tableId} promised more balls than the original's array at data 0x3536 has`,
      ).toBeLessThanOrEqual(MAX_SIMULTANEOUS_BALLS);
    }
  });

  it("counts a held ball in the top-up, so a two-ball ask does not become three", () => {
    // `+0x005BD6  move.w $d7e(a5),d0 / add.w $d86(a5),d0`, and `$d7e` includes
    // the saucers. BabeWatch is the table that reaches this in play: its ladder
    // is driven by a grid CAPTURE, so a ball is in a saucer when the top-up
    // runs, and none of its two-ball scripts does a `BALL_REMOVE` first. One
    // held, one rolling, so the machine sees two and queues NOTHING. Counting
    // only the rolling ball queues one more and ends with three, which
    // `oweServes`'s trough cap does not catch, because three is legal.
    //
    // THE HOLD IS PLACED BY HAND, and that is stated. A real capture ejects on
    // the saucer's own timer well before a mission's three-second intro `WAIT`
    // reaches `BALLS_UP_TO` — measured: BabeWatch's grid spits the ball back
    // inside eight ticks — so a driven capture cannot hold the state open long
    // enough to observe the top-up. The two writes below are exactly what
    // `captureBalls` does and nothing else: the bank's entry and the ball's
    // own `heldBy`.
    const tableId: TableId = "babewatch";
    const game = createGame(mapFor(tableId), { ballsPerGame: 5 });
    startGame(game);
    const input = playingInput();
    expect(launchFromLane(game, input)).toBe(true);
    // Two balls, one of which is about to be put in a saucer.
    game.pendingServes += 1;
    for (let tick = 0; tick < 2_000; tick += 1) {
      parkBall(game, 540);
      runTicks(game, input, 1);
      const now = debugSnapshot(game);
      if (now.balls.filter((one) => one.active && one.heldBy === null).length >= 2) break;
    }
    const laneId = debugSnapshot(game).laneBallId;
    const victim = game.balls.balls.find(
      (one) => one.active && one.heldBy === null && one.id !== laneId,
    );
    const device = ballLocksFor(tableId)[0];
    expect(victim).toBeDefined();
    expect(device).toBeDefined();
    if (victim === undefined || device === undefined) return;
    victim.heldBy = device.id;
    victim.velocityX = 0;
    victim.velocityY = 0;
    game.locks.held.set(device.id, victim.id);

    const before = debugSnapshot(game);
    expect(before.locks.length, "one ball held").toBe(1);
    const rolling = before.balls.filter((one) => one.active && one.heldBy === null).length;
    expect(rolling, "one ball rolling").toBe(1);
    expect(before.pendingServes, "and nothing owed").toBe(0);

    const state = game.modeState;
    expect(state).not.toBeNull();
    if (state === null) return;
    // Launcher 110 -> MODE_START 179 -> `BALLS_UP_TO 2`.
    queueScript(state, 110);
    let inHand = -1;
    for (let tick = 0; tick < 1_000; tick += 1) {
      parkBall(game, 540);
      runTicks(game, input, 1);
      const now = debugSnapshot(game);
      if (now.multiball) {
        inHand =
          now.balls.filter((one) => one.active && one.heldBy === null).length +
          now.locks.length +
          now.pendingServes;
        break;
      }
      if (now.phase === "game-over") break;
    }
    expect(inHand, "the multiball started").toBeGreaterThan(0);
    expect(inHand, "one held plus one rolling is already two: nothing more is owed").toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. The contact model, under real multiball play
// ---------------------------------------------------------------------------

describe("balls in play together", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId}: never pass through one another`, () => {
      const run = runOneMultiball(tableId, 30_000);
      expect(run.started).toBe(true);
      // The swept test: two centres clear of each other at both ends of a tick
      // but within a diameter in between. The original gates the same contact
      // on the collision line — `+0x00B7B6  move.b $8(a4),d0 / cmp.b $8(a1),d0
      // / bne` — and so does this measurement.
      expect(run.tunnelTicks, `${tableId}: a ball went through another ball`).toBe(0);
    });

    it(`${tableId}: never overlap past the original's own contact box`, () => {
      const run = runOneMultiball(tableId, 30_000);
      expect(run.started).toBe(true);
      // `+0x00B7D8  cmpi.w #$11,d0 / bhi` and `+0x00B7E8` the same on the other
      // axis: the machine's ball-ball neighbourhood is 17 px on the `$12/$14`
      // corners, one more than this port's 16 px diameter. A penetration deeper
      // than half a radius is outside anything the machine's own table could
      // be resolving and is the number to watch. Measured over 292,000 ticks of
      // driven multiball at this commit: worst 4.82 px.
      expect(run.worstOverlap).toBeLessThan(BALL_RADIUS_PIXELS / 2);
    });
  }
});
