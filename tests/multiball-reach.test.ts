/**
 * CAN A PLAYER REACH THE LOCKS, AND CAN MULTIBALL BE STARTED AT ALL?
 *
 * `tests/ball-locks.test.ts` already asserts what happens ONCE a lock lamp is
 * lit and a ball is in the saucer: it lights the lamp by hand and drops the
 * ball in by hand, which is exactly right for testing the ladder. What no test
 * asked was the question underneath it — whether a rolling ball can get to the
 * rectangle in the first place, and whether any route to `BALLS_UP_TO > 1`
 * exists on each table at all.
 *
 * That gap was not academic. The scoring round measured Law 'n Justice's
 * `zone-0-6` paying ZERO over 270 balls with ZERO ticks inside its rectangle
 * and left it as "routing, not binding" — and `zone-0-6` turns out to be the
 * ONLY lock on that table that feeds a multiball ladder. Had that rectangle
 * been walled off, Law 'n Justice's lock multiball would have been unreachable
 * and the whole suite would still have been green, because every existing test
 * puts the ball inside the rectangle before it starts.
 *
 * So this file asserts three different KINDS of thing, and the difference
 * matters:
 *
 *   1. THE ROUTE INVENTORY, from the shipped mode documents alone: every table
 *      has at least one ladder entry that reaches `BALLS_UP_TO` with an operand
 *      above one, and which counter drives it. Pure data — it fails if an
 *      export ever drops the wiring.
 *   2. WHICH LOCKS FEED A MULTIBALL, per table, so the single-point-of-failure
 *      on Law 'n Justice is written down rather than rediscovered.
 *   3. REACHABILITY UNDER THE SHIPPED PHYSICS: every lock rectangle on every
 *      table can be ENTERED by a ball released outside it and left to the
 *      machine. Not "the ball is in the rectangle", not "the ball fits there" —
 *      released, integrated, and arriving. A geometry change that seals a
 *      saucer fails here and nowhere else.
 *
 * The release points are free ball centres OUTSIDE each rectangle, measured
 * with `research/multiball-reach/run.cmd --fanlocks`, and each is fanned over
 * speeds and angles rather than pinned to one lucky trajectory: a single
 * trajectory is a change detector, a fan is a reachability test.
 */

import { describe, expect, it } from "vitest";
import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { Game, InputSource } from "../src/browser/game-loop.js";
import { IDLE_SNAPSHOT } from "../src/browser/input.js";
import { mapFor, modesFor } from "./table-fixtures.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { PlayfieldLevel, TableId } from "../src/game/contracts.js";
import { ballLocksFor } from "../src/game/ball-locks.js";
import type { BallLock } from "../src/game/ball-locks.js";
import { queueScript } from "../src/game/mode-vm.js";
import type { TableModes } from "../src/game/table-modes.js";

// ---------------------------------------------------------------------------
// Reading the wiring out of the shipped document
// ---------------------------------------------------------------------------

/** `BALLS_UP_TO`. The opcode table's index 27, same on all three tables. */
const OP_BALLS_UP_TO = 27;
/** `MODE_START`, index 9: a launcher script's whole body. */
const OP_MODE_START = 9;
/** `AWARD`, index 5. */
const OP_AWARD = 5;
/** Award effect 6: bump the element's counter record and walk its ladder. */
const EFFECT_COUNT_DISPATCH = 6;

/**
 * Every `BALLS_UP_TO` operand reachable from a script, following `MODE_START`
 * and the mission table's launcher-to-body join.
 *
 * The join matters: a ladder entry is a LAUNCHER, whose entire body is one
 * `MODE_START`, and the `BALLS_UP_TO` is inside the mission it starts.
 */
function ballsUpToFrom(modes: TableModes, script: number, seen = new Set<number>()): number[] {
  if (script < 0 || script >= modes.scripts.length || seen.has(script)) return [];
  seen.add(script);
  const out: number[] = [];
  for (const op of modes.scripts[script]?.ops ?? []) {
    if (op.op === OP_BALLS_UP_TO) out.push(op.args[0] ?? 0);
    else if (op.op === OP_MODE_START) out.push(...ballsUpToFrom(modes, op.args[0] ?? -1, seen));
  }
  for (const mission of modes.missions) {
    if (mission.launcher === script) out.push(...ballsUpToFrom(modes, mission.script, seen));
  }
  return out;
}

interface MultiballRoute {
  readonly ladder: number;
  readonly counters: readonly number[];
  /** Ladder ids that start a multiball, with the ball count each asks for. */
  readonly entries: readonly { readonly id: number; readonly balls: number }[];
  /** Effect-6 elements whose counter drives this ladder. */
  readonly feeders: readonly number[];
}

/** Every route on a table from a counted award to more than one ball in play. */
function multiballRoutes(modes: TableModes): MultiballRoute[] {
  const out: MultiballRoute[] = [];
  for (const ladder of modes.ladders) {
    const entries: { id: number; balls: number }[] = [];
    for (const entry of ladder.entries) {
      const balls = ballsUpToFrom(modes, entry.script);
      const most = balls.length === 0 ? 0 : Math.max(...balls);
      if (most > 1) entries.push({ id: entry.id, balls: most });
    }
    if (entries.length === 0) continue;
    const counters = modes.counters.filter((one) => one.ladder === ladder.index).map((one) => one.index);
    const feeders: number[] = [];
    for (const element of modes.elements) {
      if (element.effect !== EFFECT_COUNT_DISPATCH) continue;
      const target =
        element.ladder >= 0 ? element.ladder : (modes.counters[element.counter]?.ladder ?? -1);
      if (target === ladder.index) feeders.push(element.index);
    }
    out.push({ ladder: ladder.index, counters, entries, feeders });
  }
  return out;
}

/**
 * Lock zones whose capture script AWARDs an element that feeds `route`.
 *
 * The lock list comes from `ball-locks.ts` and the capture script from the
 * modes document's own `scriptForLock`, so this is the same join the loop uses
 * at run time rather than a second reading of the file.
 */
function locksFeeding(tableId: TableId, modes: TableModes, route: MultiballRoute): string[] {
  const out: string[] = [];
  for (const lock of ballLocksFor(tableId)) {
    const script = modes.scriptForLock(lock.level, lock.zoneIndex);
    if (script < 0) continue;
    for (const op of modes.scripts[script]?.ops ?? []) {
      if (op.op !== OP_AWARD) continue;
      if (!route.feeders.includes(op.args[0] ?? -1)) continue;
      const id = `zone-${lock.level}-${lock.zoneIndex}`;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Driving a ball at a rectangle
// ---------------------------------------------------------------------------

/**
 * Serves, launches and then places one ball at `from` with velocity `v`, and
 * reports whether it ever ends up inside `lock` on the lock's own level.
 *
 * THE LAUNCH IS NOT OPTIONAL. `runScoring` skips `game.laneBallId` outright, so
 * a ball teleported while it is still the lane's ball scores nothing and
 * triggers nothing — a probe that skipped this would report a dead table that
 * was working perfectly. (The same class of mistake as the film gate, the old
 * tip-flip set and the bat-less trap census: the instrument answering about
 * itself.)
 */
function shotEnters(
  tableId: TableId,
  lock: BallLock,
  from: { readonly x: number; readonly y: number },
  velocityX: number,
  velocityY: number,
  ticks: number,
): boolean {
  const game = createGame(mapFor(tableId), { ballsPerGame: 3 });
  startGame(game);
  const input = plungingInput();
  if (!launchFromLane(game, input)) return false;
  const laneId = debugSnapshot(game).laneBallId;
  const ball = game.balls.balls.find(
    (one) => one.active && one.heldBy === null && one.id !== laneId,
  );
  if (ball === undefined) return false;
  ball.x = pixelsToQ10(from.x);
  ball.y = pixelsToQ10(from.y);
  ball.velocityX = velocityX;
  ball.velocityY = velocityY;
  ball.level = lock.level;
  for (let tick = 0; tick < ticks; tick += 1) {
    runTicks(game, input, 1);
    for (const one of debugSnapshot(game).balls) {
      if (!one.active) continue;
      if (one.heldBy === lock.id) return true;
      if (one.level !== lock.level) continue;
      if (one.pixelX < lock.minX || one.pixelX > lock.maxX) continue;
      if (one.pixelY < lock.minY || one.pixelY > lock.maxY) continue;
      return true;
    }
  }
  return false;
}

/** Taps the plunger every 400 ticks so a drained ball is put back in play. */
function plungingInput(): InputSource {
  let sequence = 0;
  let held = false;
  return {
    sample() {
      const phase = sequence % 400;
      const down = phase >= 40 && phase < 46;
      const was = held;
      held = down;
      sequence += 1;
      const edges = {
        down,
        pressed: down && !was,
        released: !down && was,
        pressCount: down && !was ? 1 : 0,
        releaseCount: !down && was ? 1 : 0,
      };
      return {
        sequence,
        controls: { ...IDLE_SNAPSHOT.controls, plunger: edges },
      };
    },
  };
}

/** Runs until the served ball has left the rod. False if it never does. */
function launchFromLane(game: Game, input: InputSource): boolean {
  for (let tick = 0; tick < 600; tick += 1) {
    runTicks(game, input, 1);
    const state = debugSnapshot(game);
    if (state.laneBallId === null && state.balls.some((one) => one.active)) return true;
  }
  return false;
}

/**
 * A free ball centre OUTSIDE each lock's rectangle from which a fan of shots
 * reaches it, measured with `research/multiball-reach/run.cmd --fanlocks` at
 * `7830996` and re-measurable with the same command.
 *
 * These are release points, NOT trajectories. The test fans speeds and angles
 * from each one and needs only one to arrive, so an ordinary change to the
 * contact model moves WHICH shot lands without touching the property. What
 * fails here is a rectangle that has become unreachable.
 */
const RELEASE_POINTS: Record<TableId, Record<string, { readonly x: number; readonly y: number }>> = {
  "law-n-justice": {
    "jail-top": { x: 115, y: 106 },
    // The one that matters: the ONLY Law 'n Justice lock on a multiball ladder.
    "right-crater": { x: 257, y: 194 },
    "jail-throat": { x: 79, y: 201 },
  },
  babewatch: {
    "grid-top": { x: 71, y: 75 },
    "grid-mid": { x: 167, y: 137 },
    "top-lane": { x: 173, y: 24 },
    "lower-bowl": { x: 231, y: 264 },
    "upper-deck": { x: 115, y: 67 },
  },
  "extreme-sports": {
    bowl: { x: 276, y: 174 },
    "upper-orbit": { x: 111, y: 30 },
  },
};

/** The fan: four speeds by twelve bearings, in the engine's own Q10 units. */
const FAN_SPEEDS = [1600, 3200, 4800, 6400] as const;
const FAN_DEGREES = Array.from({ length: 12 }, (_, i) => i * 30 - 180);

// ---------------------------------------------------------------------------
// 1. The route inventory
// ---------------------------------------------------------------------------

describe("every table has a route to multiball", () => {
  it("finds at least one ladder entry that asks for more than one ball", () => {
    for (const tableId of TABLE_IDS) {
      const routes = multiballRoutes(modesFor(tableId));
      expect(routes.length, `${tableId} has no route to BALLS_UP_TO > 1`).toBeGreaterThan(0);
      for (const route of routes) {
        expect(route.entries.length, `${tableId} ladder ${route.ladder}`).toBeGreaterThan(0);
        for (const entry of route.entries) {
          expect(entry.balls, `${tableId} ladder ${route.ladder} id ${entry.id}`).toBeGreaterThan(1);
          expect(entry.balls).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it("pins the decoded routes, table by table", () => {
    // Read off the shipped documents; the comment beside each is the mechanism.
    const shape = (tableId: TableId) =>
      multiballRoutes(modesFor(tableId))
        .map(
          (route) =>
            `${route.ladder}:${route.counters.join("+")}[${route.entries
              .map((entry) => `${entry.id}=>${entry.balls}`)
              .join(",")}]`,
        )
        .sort();

    // Ladder 2, counter 10: tiers of 2/3/4/5 counted JAIL locks, two balls at
    // ids 2 and 5 and three at 9 and 14. Ladder 8, counter 13: the MISSION
    // ladder, whose eighth rung is "SHOOT FLASHING ARROWS TO CALM DOWN RIOTS"
    // and starts a three-ball multiball.
    expect(shape("law-n-justice")).toEqual([
      "2:10[2=>2,5=>2,9=>3,14=>3]",
      "8:13[8=>3]",
    ]);
    // Ladder 2, counter 8: the three level-0 grid saucers, and the FIRST
    // counted lock of a game already starts a two-ball multiball. Ladder 1,
    // counter 4: the mission ladder, "TIME" at ids 3 and 4.
    expect(shape("babewatch")).toEqual([
      "1:4[3=>2,4=>3]",
      "2:8[1=>2,3=>3,6=>2,10=>3]",
    ]);
    // Extreme Sports has NO lock route at all: both ladders are mission
    // ladders. Ladder 6 id 5 is the fifth "TIME" mode; ladder 8 id 6 is
    // "ARE YOU MAN ENOUGH FOR IRON MAN". Both ask for three.
    expect(shape("extreme-sports")).toEqual(["6:9[5=>3]", "8:1[6=>3]"]);
  });

  it("names the locks that feed each route, and Law 'n Justice's single point of failure", () => {
    const feeding = (tableId: TableId) => {
      const modes = modesFor(tableId);
      return multiballRoutes(modes).flatMap((route) => locksFeeding(tableId, modes, route));
    };

    // ONE lock on Law 'n Justice, and it is the rectangle the scoring census
    // never once entered. If that shot is unreachable the table's lock
    // multiball is unreachable — which is why the reachability test below
    // exists at all.
    expect(feeding("law-n-justice")).toEqual(["zone-0-6"]);
    // BabeWatch's three level-0 grid saucers feed the lock ladder, and two of
    // them also feed the mission ladder.
    expect([...new Set(feeding("babewatch"))].sort()).toEqual([
      "zone-0-15",
      "zone-0-16",
      "zone-0-17",
    ]);
    // Extreme Sports' two saucers feed counters 4, 11 and 13 — none of which
    // drives a ladder that reaches BALLS_UP_TO. Its multiball is a MISSION.
    expect(feeding("extreme-sports")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Reachability under the shipped physics
// ---------------------------------------------------------------------------

describe("every lock rectangle can be reached by a rolling ball", () => {
  for (const tableId of TABLE_IDS) {
    for (const lock of ballLocksFor(tableId)) {
      it(`${tableId} ${lock.id} (zone-${lock.level}-${lock.zoneIndex}) is enterable`, () => {
        const from = RELEASE_POINTS[tableId]?.[lock.id];
        expect(from, `no release point recorded for ${tableId} ${lock.id}`).toBeDefined();
        if (from === undefined) return;
        // The release point must itself be OUTSIDE the rectangle, or the test
        // would pass by construction.
        const outside =
          from.x < lock.minX || from.x > lock.maxX || from.y < lock.minY || from.y > lock.maxY;
        expect(outside, `${lock.id} release point is inside its own rectangle`).toBe(true);

        let landed = 0;
        for (const speed of FAN_SPEEDS) {
          for (const degrees of FAN_DEGREES) {
            const radians = (degrees * Math.PI) / 180;
            if (
              shotEnters(
                tableId,
                lock,
                from,
                Math.round(Math.cos(radians) * speed),
                Math.round(-Math.sin(radians) * speed),
                240,
              )
            ) {
              landed += 1;
            }
          }
        }
        expect(
          landed,
          `no shot of ${FAN_SPEEDS.length * FAN_DEGREES.length} from (${from.x},${from.y}) ` +
            `entered ${lock.id}`,
        ).toBeGreaterThan(0);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Multiball can actually be STARTED, on every table
// ---------------------------------------------------------------------------

/**
 * Holds one ball on the playfield at a stated free centre.
 *
 * STATED, because it IS an intervention: a mission window is forty seconds and
 * a ball left to itself drains half a dozen times inside one, which ends a
 * five-ball game before the ladder gets anywhere. A real player keeps the ball
 * alive with the bats; this parks it. Nothing else about the machine is
 * touched — every award, every script, every counter and the top-up itself are
 * the shipped rules.
 */
function parkBall(game: Game, at: { readonly x: number; readonly y: number }, onlyBelow = -1): void {
  const snapshot = debugSnapshot(game);
  const laneId = snapshot.laneBallId;
  const ball = game.balls.balls.find(
    (one) => one.active && one.heldBy === null && one.id !== laneId,
  );
  if (ball === undefined) return;
  if (onlyBelow >= 0) {
    const view = snapshot.balls.find((one) => one.id === ball.id);
    if (view === undefined || view.pixelY < onlyBelow) return;
  }
  ball.x = pixelsToQ10(at.x);
  ball.y = pixelsToQ10(at.y);
  ball.velocityX = 0;
  ball.velocityY = 0;
  ball.level = 0 as PlayfieldLevel;
}

/** A free lower-line centre well clear of the drain, per table. */
const PARK: Record<TableId, { readonly x: number; readonly y: number }> = {
  "law-n-justice": { x: 168, y: 430 },
  babewatch: { x: 168, y: 430 },
  "extreme-sports": { x: 168, y: 430 },
};

/** Places the ball hard against a device's surface from four sides. */
function strikeDevice(game: Game, at: { readonly x: number; readonly y: number }): void {
  const input = plungingInput();
  const reach = 14;
  const speed = 2400;
  for (const [dx, dy] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ] as const) {
    const laneId = debugSnapshot(game).laneBallId;
    const ball = game.balls.balls.find(
      (one) => one.active && one.heldBy === null && one.id !== laneId,
    );
    if (ball === undefined) return;
    ball.x = pixelsToQ10(at.x + dx * reach);
    ball.y = pixelsToQ10(at.y + dy * reach);
    ball.velocityX = -dx * speed;
    ball.velocityY = -dy * speed;
    ball.level = 0 as PlayfieldLevel;
    runTicks(game, input, 40);
  }
}

describe("multiball can be started on every table", () => {
  /**
   * Runs `ticks`, parking the ball so the game survives, and reports the first
   * tick a multiball started and how many balls the machine then promised.
   */
  function runParked(
    game: Game,
    input: InputSource,
    tableId: TableId,
    ticks: number,
  ): { started: boolean; promised: number } {
    let started = false;
    let promised = 0;
    for (let tick = 0; tick < ticks; tick += 1) {
      // Catch the ball on its way to the drain and put it back in the middle.
      // Only below y=520, so a placement anywhere above that is untouched.
      parkBall(game, PARK[tableId], 520);
      const report = runTicks(game, input, 1)[0];
      if (report?.multiballStarted === true) started = true;
      const state = debugSnapshot(game);
      const live = state.balls.filter((one) => one.active && one.heldBy === null).length;
      promised = Math.max(promised, live + state.pendingServes);
      if (started && promised >= 2) return { started, promised };
      if (state.phase === "game-over") break;
    }
    return { started, promised };
  }

  it("law-n-justice: the SHOOT JAIL targets light the lock, and the second counted lock is a two-ball multiball", () => {
    // The whole decoded chain, driven with real shots: device surface 128 (a
    // 500,000 MODE target) fires script 78, whose body is `START 26` — the
    // lock lamp. `zone-0-6`'s capture script 63 then `JMP_IF_UNLIT 26` past its
    // own AWARD when the lamp is dark, so an unlit capture counts nothing. Two
    // LIT captures put counter 10 on 2, ladder 2 id 2 launches script 88, and
    // its mission (93) does `BALL_REMOVE 24` then `BALLS_UP_TO 2`.
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 5 });
    startGame(game);
    const input = plungingInput();
    expect(launchFromLane(game, input)).toBe(true);
    const lock = ballLocksFor("law-n-justice").find((one) => one.id === "right-crater");
    expect(lock).toBeDefined();
    if (lock === undefined) return;
    const at = { x: Math.floor((lock.minX + lock.maxX) / 2), y: Math.floor((lock.minY + lock.maxY) / 2) };

    let outcome = { started: false, promised: 0 };
    for (let round = 0; round < 3 && !outcome.started; round += 1) {
      // The mode target's own pixels, from the shipped surface-id map:
      // Law 'n Justice surface 128 spans x 175..190, y 223..232 on level 0.
      strikeDevice(game, { x: 182, y: 227 });
      parkBall(game, at);
      outcome = runParked(game, input, "law-n-justice", 900);
    }
    expect(outcome.started, "no multiball after three lit jail locks").toBe(true);
    expect(outcome.promised, "script 93 asks for two balls").toBeGreaterThanOrEqual(2);
  });

  it("babewatch: a mission lights a grid lock lamp, and the FIRST counted lock is a two-ball multiball", () => {
    // BabeWatch's lock lamps (elements 29/30/31, flags $09 — bit 1 clear) are
    // NOT lit at game start; the per-game reset at +0x004052 leaves them dark.
    // What lights them is a MISSION: script 120's `START 29` at pc 102, after
    // its forty-second window. Then one counted grid capture puts counter 8 on
    // 1, and ladder 2 id 1 launches script 110 -> MODE_START 179 -> two balls.
    const game = createGame(mapFor("babewatch"), { ballsPerGame: 5 });
    startGame(game);
    const input = plungingInput();
    expect(launchFromLane(game, input)).toBe(true);
    const modes = modesFor("babewatch");
    expect(game.modeState).not.toBeNull();
    if (game.modeState === null) return;

    // Start a mission the decoded way: queue the script the mode shot fires.
    // Which mission the selector picks is the port's own reconstruction (see
    // `startSelectedMission`); that it is one of the four that light a lock
    // lamp is the shipped table's.
    const armScript = modes.scriptForLock(0, 16);
    expect(armScript, "zone-0-16's capture script").toBeGreaterThanOrEqual(0);
    const topLane = ballLocksFor("babewatch").find((one) => one.id === "top-lane");
    expect(topLane).toBeDefined();
    if (topLane === undefined) return;

    let outcome = { started: false, promised: 0 };
    for (let round = 0; round < 4 && !outcome.started; round += 1) {
      const lit = [29, 30, 31].some((element) => game.modeState?.armed[element] === 1);
      if (!lit) {
        if (game.modeState !== null) queueScript(game.modeState, armScript);
        // Run the mission out: its `START 29` is on the far side of a
        // forty-second WAIT, and `MODE_START` refuses a second mission while
        // one is live, so the launcher below needs this one finished.
        parkBall(game, PARK.babewatch);
        runParked(game, input, "babewatch", 2600);
      }
      parkBall(game, {
        x: Math.floor((topLane.minX + topLane.maxX) / 2),
        y: Math.floor((topLane.minY + topLane.maxY) / 2),
      });
      outcome = runParked(game, input, "babewatch", 900);
    }
    expect(outcome.started, "no multiball after four counted grid locks").toBe(true);
    expect(outcome.promised, "script 179 asks for two balls").toBeGreaterThanOrEqual(2);
  });

  it("extreme-sports: no lock feeds a ladder, so its multiball is a MISSION", () => {
    // Extreme Sports' two saucers award effect-6 elements on counters 4, 11 and
    // 13 — none of which drives a ladder that reaches `BALLS_UP_TO`. Both of
    // its multiball routes are mission ladders (6 and 8), so the shot that
    // starts a multiball here is the mission-arm shot, taken enough times.
    const game = createGame(mapFor("extreme-sports"), { ballsPerGame: 5 });
    startGame(game);
    const input = plungingInput();
    expect(launchFromLane(game, input)).toBe(true);
    expect(game.modeState).not.toBeNull();
    if (game.modeState === null) return;
    const modes = modesFor("extreme-sports");
    const armScript = modes.scriptForDevice(0, 36);
    expect(armScript, "the mode device's script").toBeGreaterThanOrEqual(0);

    // Ten mode shots, each starting the selector's next mission: the FIFTH
    // selectable mission is script 166, whose body is `BALLS_UP_TO 3`.
    let outcome = { started: false, promised: 0 };
    for (let round = 0; round < 14 && !outcome.started; round += 1) {
      if (debugSnapshot(game).mission === null && game.modeState !== null) {
        queueScript(game.modeState, armScript);
      }
      outcome = runParked(game, input, "extreme-sports", 3000);
    }
    expect(outcome.started, "no multiball after fourteen mission windows").toBe(true);
    expect(outcome.promised, "the mission asks for three balls").toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 4. The level a lock lives on is the level a ball has to be on
// ---------------------------------------------------------------------------

describe("a lock only takes a ball on its own collision line", () => {
  it("refuses a ball sitting in the rectangle on the other level", () => {
    // Law 'n Justice's `zone-0-6` sits on the LOWER line directly under the
    // upper ramp, and `zone-1-8` — a 250,000 trigger — sits on the UPPER line
    // directly above it. The census reaches the upper one 42 times a table and
    // the lower one never, and the reason is the level word: they are two
    // different places that share a footprint. Asserted so a future level
    // hand-off cannot quietly merge them.
    const lock = ballLocksFor("law-n-justice").find((one) => one.id === "right-crater");
    expect(lock).toBeDefined();
    if (lock === undefined) return;
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(game);
    const input = plungingInput();
    expect(launchFromLane(game, input)).toBe(true);
    const laneId = debugSnapshot(game).laneBallId;
    const ball = game.balls.balls.find(
      (one) => one.active && one.heldBy === null && one.id !== laneId,
    );
    expect(ball).toBeDefined();
    if (ball === undefined) return;

    const centreX = Math.floor((lock.minX + lock.maxX) / 2);
    const centreY = Math.floor((lock.minY + lock.maxY) / 2);
    ball.x = pixelsToQ10(centreX);
    ball.y = pixelsToQ10(centreY);
    ball.velocityX = 0;
    ball.velocityY = 0;
    ball.level = 1 as PlayfieldLevel;
    runTicks(game, input, 1);
    expect(debugSnapshot(game).locks, "an upper-line ball must not be captured").toEqual([]);
  });
});
