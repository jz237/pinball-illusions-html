/**
 * Does it actually play?
 *
 * Every other suite checks a part in isolation. This one drives the assembled
 * game through its public interface on the real Law 'n Justice geometry and
 * asserts the things a person would notice: the ball launches, the flipper
 * sends it back up, it drains, and the game ends. A build can be green on 546
 * unit tests and still not be a pinball game; this is the file that would
 * notice.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BALL_SEARCH_BOX_PIXELS,
  BALL_SEARCH_TICKS,
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { Game, InputSource } from "../src/browser/game-loop.js";
import { CONTROLS, IDLE_SNAPSHOT } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import type { TableId, TableMapDocument } from "../src/game/contracts.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { materialTableFor } from "../src/game/materials.js";
import { createBallSet, spawnBall, stepBalls } from "../src/game/ball-physics.js";
import { PLUNGER_REFERENCE_GRAVITY } from "../src/game/plunger.js";
import { freeCentre, levelViewsOf } from "../src/game/level-scan.js";
import type { LevelViews } from "../src/game/level-scan.js";

function mapFor(tableId: TableId) {
  const url = new URL(`../public/generated/tables/${tableId}.map.json`, import.meta.url);
  return parseTableMapDocument(JSON.parse(readFileSync(url, "utf8")) as TableMapDocument);
}

function realMap() {
  return mapFor("law-n-justice");
}

/** Drives controls from a script so a run is exactly reproducible. */
class ScriptedInput implements InputSource {
  private sequence = 0;
  private held = new Set<Control>();
  private previous = new Set<Control>();

  constructor(private readonly plan: (tick: number) => readonly Control[]) {}

  sample(): ControlSnapshot {
    const wanted = new Set(this.plan(this.sequence));
    this.previous = this.held;
    this.held = wanted;
    this.sequence += 1;

    const controls = {} as Record<Control, ControlEdges>;
    for (const control of CONTROLS) {
      const down = wanted.has(control);
      const was = this.previous.has(control);
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

function started(): Game {
  const game = createGame(realMap());
  startGame(game);
  return game;
}

/** The ball sitting on the plunger, if there is one. */
function laneBall(game: Game) {
  const state = debugSnapshot(game);
  return state.balls.find((ball) => ball.id === state.laneBallId) ?? null;
}

function liveBalls(game: Game) {
  return debugSnapshot(game).balls.filter((ball) => ball.active);
}

describe("serving", () => {
  it("puts a ball in the shooter lane", () => {
    const game = started();
    runTicks(game, idleInput(), 60);

    const ball = laneBall(game);
    expect(ball).not.toBeNull();
    // The lane is the narrow full-height channel on the right of this table.
    expect(ball?.pixelX).toBeGreaterThan(270);
    expect(ball?.pixelY).toBeGreaterThan(400);
  });

  it("holds the served ball still until it is launched", () => {
    const game = started();
    runTicks(game, idleInput(), 60);
    const before = laneBall(game);
    runTicks(game, idleInput(), 120);
    const after = laneBall(game);

    // A ball that drifts off the rod on its own would make the plunger useless.
    expect(after?.pixelY).toBe(before?.pixelY);
    expect(debugSnapshot(game).phase).toBe("in-play");
  });
});

describe("the plunger", () => {
  it("charges while held and fires on release", () => {
    const game = started();
    // Hold the plunger from tick 60 to 110, then let go.
    const input = new ScriptedInput((t) => (t >= 60 && t < 110 ? ["plunger"] : []));

    runTicks(game, input, 100);
    expect(debugSnapshot(game).plungerCharge).toBeGreaterThan(0);

    const reports = runTicks(game, input, 40);
    expect(reports.some((r) => r.launched)).toBe(true);
  });

  it("sends the ball UP the table, which is the whole point of it", () => {
    const game = started();
    const input = new ScriptedInput((t) => (t >= 60 && t < 110 ? ["plunger"] : []));
    runTicks(game, input, 110);

    const atLaunch = liveBalls(game)[0]?.pixelY ?? 0;
    runTicks(game, input, 200);
    const highest = Math.min(
      ...runTicks(game, input, 100).map(() => liveBalls(game)[0]?.pixelY ?? 9999),
    );

    // Smaller y is further up the table.
    expect(highest).toBeLessThan(atLaunch - 100);
  });

  it("cannot fire the same ball twice", () => {
    const game = started();
    const input = new ScriptedInput((t) => (t >= 60 && t < 110 ? ["plunger"] : []));
    const first = runTicks(game, input, 140);
    expect(first.filter((r) => r.launched)).toHaveLength(1);

    const again = new ScriptedInput((t) => (t >= 0 && t < 40 ? ["plunger"] : []));
    const second = runTicks(game, again, 80);
    // Any further launch must belong to a NEW ball, never the one in flight.
    for (const report of second) {
      if (report.launched) expect(report.served).toBe(false);
    }
  });
});

describe("the flippers", () => {
  it("sends a ball that reaches them back up the table", () => {
    // The single most important behaviour in a pinball game: if this fails the
    // project is a physics demo, not a game.
    //
    // WHY THERE IS A NUDGE IN HERE NOW. On the re-exported maps the scripted
    // plunge lands the ball dead down the middle: it crosses row 558 at x=136,
    // which is 52 px from the left pivot at x=84 and 63 from the right, and the
    // bats are 45 px long. Neither can touch it, and neither should — a ball
    // straight down the middle is a drain on a real machine too. So the ball is
    // steered onto a bat the way a player steers one, with the game's own nudge
    // control, and only then is the flip tested. One shove at row 450 puts it
    // over the left bat at (90,538); the flip then gains 216 px.
    const game = started();
    const input = new ScriptedInput((t) => (t >= 60 && t < 110 ? ["plunger"] : []));
    runTicks(game, input, 150);

    let struck = false;
    let bestGain = 0;
    let nudged = false;
    const flipping = new ScriptedInput(() => ["leftFlipper", "rightFlipper"]);
    const nudging = new ScriptedInput((t) => (t < 2 ? ["nudgeLeft"] : []));
    const idle = idleInput();

    for (let attempt = 0; attempt < 400 && !struck; attempt += 1) {
      const before = liveBalls(game)[0];
      if (before === undefined) break;

      // One shove, on the way down, well before the tilt allowance runs out.
      if (!nudged && before.pixelY >= 450 && before.velocityY > 0) {
        runTicks(game, nudging, 4);
        nudged = true;
        continue;
      }

      // Only flip when a ball is actually down by the bats, as a player would.
      if (before.pixelY > 500 && before.velocityY > 0) {
        runTicks(game, flipping, 6);
        runTicks(game, idle, 24);
        const after = liveBalls(game)[0];
        if (after !== undefined) {
          const gain = before.pixelY - after.pixelY;
          if (gain > bestGain) bestGain = gain;
          if (gain > 20) struck = true;
        }
      } else {
        runTicks(game, idle, 4);
      }
    }

    expect(struck, `best upward gain from a flip was ${bestGain}px`).toBe(true);
  });

  it("goes dead once the table tilts", () => {
    const game = started();
    // Nudge far past the allowance, spacing presses so each one registers.
    const nudging = new ScriptedInput((t) => (t % 20 < 4 ? ["nudgeLeft"] : []));
    runTicks(game, nudging, 600);

    const state = debugSnapshot(game);
    expect(state.tilt.tilted).toBe(true);
    expect(state.flippersLive).toBe(false);
  });
});

describe("a whole game", () => {
  /**
   * This used to be an `it.fails` characterisation of the project's one blocker:
   * with no arch above the shooter lane a launched ball came straight back down
   * it, rested at (290, 552) forever and no ball ever drained. The arch was
   * found — on the UPPER collision line, see `playfield-levels.ts` — so this is
   * a normal assertion again, and the companion test that pinned the parked-ball
   * behaviour is gone because there is no longer a bug for it to assert.
   */
  it("drains, re-serves, and ends after the configured ball count", () => {
    const game = createGame(realMap(), { ballsPerGame: 3 });
    startGame(game);

    // Launch every ball as it arrives, then leave it to its fate.
    const input = new ScriptedInput((t) => (t % 400 >= 60 && t % 400 < 110 ? ["plunger"] : []));
    const reports = runTicks(game, input, 12_000);

    const drains = reports.flatMap((r) => r.drained);
    expect(drains.length).toBeGreaterThan(0);

    const state = debugSnapshot(game);
    expect(state.ballsServed).toBeGreaterThan(1);
    expect(state.phase).toBe("game-over");
    expect(state.ballsServed).toBe(3);
    expect(state.ballsRemaining).toBe(0);
  });

  it("takes a full plunge over the top arch and down onto the playfield", () => {
    // The shot the whole two-level model exists for. The ball must leave the
    // lane sideways, not fall back down it: it climbs the right leg of the arch,
    // crosses the crown and comes down the left, which no ball can do while the
    // upper collision line is treated as passable.
    const game = started();
    const input = new ScriptedInput((t) => (t >= 60 && t < 110 ? ["plunger"] : []));
    runTicks(game, input, 110);

    let onTheRamp = false;
    let crossedTheCrown = false;
    let leftTheRamp = false;
    for (let block = 0; block < 2_000; block += 1) {
      runTicks(game, input, 1);
      const ball = liveBalls(game)[0];
      if (ball === undefined) break;
      if (ball.level === 1) onTheRamp = true;
      // STALE COORDINATES CORRECTED. This read "the crown of the arch is at
      // x=132..156; the lane is at x=290", which are the misframed export's
      // columns. On the corrected maps the arch's two bit-1 caps are at
      // x=164..188 (outer) and x=164..187 (inner) and the lane is at x=321..324
      // — 32 px right, rows unchanged, as a horizontal reframe requires. "Past
      // the crown" is therefore left of the caps, not left of 132.
      if (ball.level === 1 && ball.pixelX < 164) crossedTheCrown = true;
      if (crossedTheCrown && ball.level === 0) {
        leftTheRamp = true;
        // Delivered to the LEFT of the table, not back into the lane.
        expect(ball.pixelX).toBeLessThan(120);
        break;
      }
    }

    expect(onTheRamp, "the ball never reached the upper collision line").toBe(true);
    expect(crossedTheCrown, "the ball never crossed the crown of the arch").toBe(true);
    expect(leftTheRamp, "the ball never came back down onto the playfield").toBe(true);
  });

  it("puts a ball that failed to clear the arch back on the plunger rod", () => {
    // A weak plunge dribbles back down the lane. The lane floor is the rod, so
    // the ball must land back on it and be shootable again; if it merely came to
    // rest in the lane the game would be over with the ball still in play.
    const game = started();
    // Two ticks of hold is nowhere near enough charge to reach the arch.
    const input = new ScriptedInput((t) => (t >= 60 && t < 62 ? ["plunger"] : []));
    runTicks(game, input, 400);

    const state = debugSnapshot(game);
    expect(state.laneBallId).not.toBeNull();
    expect(state.plungerCharge).toBe(0);

    // And it really can be launched again.
    const second = new ScriptedInput((t) => (t < 50 ? ["plunger"] : []));
    const reports = runTicks(game, second, 120);
    expect(reports.some((r) => r.launched)).toBe(true);
  });

  it("gives up on a ball the playfield has stopped returning", () => {
    // The ball search. Not a workaround: a real machine writes off a ball that
    // has not moved for long enough, and this reconstruction has no device layer
    // yet to empty the playfield's kicker holes.
    const game = createGame(realMap(), { ballsPerGame: 3, ballSearchTicks: 40 });
    startGame(game);
    const input = new ScriptedInput((t) => (t >= 60 && t < 110 ? ["plunger"] : []));
    runTicks(game, input, 115);
    expect(debugSnapshot(game).laneBallId).toBeNull();

    // Park it by hand in the one place on this table a ball provably cannot
    // leave under gravity: the spiral around the left spinner, whose lane is
    // walled at x=75..77 and x=94..96 and closed below by the bar at y=168.
    // (It read x=43..45 / x=62..64 and (54,155) until the maps were re-exported
    // on the correct 32 px frame: same spiral, 32 columns right, same row.)
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball !== undefined) {
      ball.x = pixelsToQ10(86);
      ball.y = pixelsToQ10(155);
      ball.velocityX = 0;
      ball.velocityY = 0;
      ball.level = 0;
    }

    const reports = runTicks(game, idleInput(), 200);
    expect(reports.flatMap((r) => r.drained)).toContain(ball?.id);
    expect(debugSnapshot(game).ballsServed).toBeGreaterThan(1);
  });

  it("gives up on a wedged ball even while it jitters by a pixel", () => {
    // The search used to compare the whole-pixel position against the previous
    // tick's, so one pixel of jitter reset its clock and it never fired. A ball
    // rattling inside its own footprint has closed no switch; see
    // BALL_SEARCH_BOX_PIXELS.
    const game = createGame(realMap(), { ballsPerGame: 3, ballSearchTicks: 40 });
    startGame(game);
    const input = new ScriptedInput((t) => (t >= 60 && t < 110 ? ["plunger"] : []));
    runTicks(game, input, 115);

    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball === undefined) return;
    ball.level = 0;
    ball.velocityX = 0;
    ball.velocityY = 0;

    const drained: number[] = [];
    for (let tick = 0; tick < 200; tick += 1) {
      // Hold it in the spiral, alternating between two touching pixels — the
      // signature the old test could never see past.
      //
      // 85/86 rather than 53/54: this test was still parking the ball 32 px left
      // of the spiral it names, on the misframed export's columns, and got away
      // with it because it pins the position by hand every tick. The companion
      // test above ("gives up on a ball the playfield has stopped returning")
      // was corrected to x=86 when the maps were re-exported and this one was
      // missed — which is exactly the class of silent stale number the reframe
      // was supposed to have cleared out.
      ball.x = pixelsToQ10(85 + (tick % 2));
      ball.y = pixelsToQ10(155);
      ball.velocityX = 0;
      ball.velocityY = 0;
      drained.push(...runTicks(game, idleInput(), 1)[0]!.drained);
      if (drained.length > 0) break;
    }

    expect(drained).toContain(ball.id);
  });

  it("cannot be stalled forever by a player who keeps nudging", () => {
    // The regression this asserts: a nudge every 700 ticks used to hold the ball
    // search's clock at exactly 493 of the 500 it needs, for eighteen thousand
    // consecutive ticks, so a ball wedged in the top-left was never written off
    // and the game could not reach ball two. Four games in thirty finished.
    for (const seed of [0, 1, 2]) {
      const game = createGame(realMap(), { ballsPerGame: 3 });
      startGame(game);
      const hold = 60 + seed * 3;
      const input = new ScriptedInput((t) => {
        const controls: Control[] = [];
        const phase = t % 400;
        if (phase >= 40 && phase < 40 + hold) controls.push("plunger");
        if (t % 23 < 4) controls.push("leftFlipper");
        if ((t + 11) % 29 < 4) controls.push("rightFlipper");
        if (t > 0 && t % 700 < 3) controls.push(seed % 2 === 0 ? "nudgeLeft" : "nudgeRight");
        return controls;
      });

      const reports = runTicks(game, input, 20_000);
      const state = debugSnapshot(game);
      expect(
        state.phase,
        `seed ${seed} stalled after ${state.ballsServed} balls with ${reports.filter((r) => r.gameOver).length} game-overs`,
      ).toBe("game-over");
      expect(state.ballsServed).toBe(3);
    }
  });

  it("never lets a ball leave the playfield", () => {
    const game = started();
    const input = new ScriptedInput((t) => (t % 400 >= 60 && t % 400 < 110 ? ["plunger"] : []));

    for (let block = 0; block < 20; block += 1) {
      runTicks(game, input, 300);
      for (const ball of liveBalls(game)) {
        expect(ball.pixelX).toBeGreaterThanOrEqual(0);
        expect(ball.pixelX).toBeLessThan(336);
        expect(ball.pixelY).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(ball.pixelX)).toBe(true);
        expect(Number.isFinite(ball.pixelY)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// All three tables
// ---------------------------------------------------------------------------

/**
 * One ball's end, and how it ended.
 *
 * A ball leaves play in one of two ways, and the difference is the whole point
 * of this section: it goes down the drain, which is the game working, or the
 * ball search writes it off, which is the game admitting the playfield stopped
 * returning it. Both arrive as `drained` ids, so the last position before the
 * ball disappeared is what tells them apart — a real drain is at the bottom row.
 */
interface BallEnd {
  readonly tick: number;
  readonly x: number;
  readonly y: number;
  readonly drained: boolean;
}

interface TableRun {
  readonly phase: string;
  readonly ballsServed: number;
  readonly ends: readonly BallEnd[];
  /** Every distinct (level, whole pixel) the ball visited on the upper line. */
  readonly reachedRamp: boolean;
  readonly leftTheLane: boolean;
  readonly minY: number;
}

/** Plunges every ball to full and lets each one take its chances. */
function playTable(tableId: TableId, ticks = 20_000, hold = 60): TableRun {
  const game = createGame(mapFor(tableId), { ballsPerGame: 3 });
  startGame(game);
  const input = new ScriptedInput((t) =>
    t % 400 >= 60 && t % 400 < 60 + hold ? ["plunger"] : [],
  );

  const ends: BallEnd[] = [];
  let reachedRamp = false;
  let leftTheLane = false;
  let minY = 9999;
  let last = new Map<number, { x: number; y: number }>();
  for (let tick = 0; tick < ticks; tick += 1) {
    const report = runTicks(game, input, 1)[0];
    for (const id of report?.drained ?? []) {
      const seen = last.get(id);
      ends.push({
        tick,
        x: seen?.x ?? -1,
        y: seen?.y ?? -1,
        drained: (seen?.y ?? -1) >= 590,
      });
    }
    last = new Map();
    for (const ball of debugSnapshot(game).balls) {
      if (!ball.active) continue;
      last.set(ball.id, { x: ball.pixelX, y: ball.pixelY });
      if (ball.level === 1) reachedRamp = true;
      // The lane is the narrow channel at x=278..306 on all three tables.
      if (ball.pixelX < 270) leftTheLane = true;
      if (ball.pixelY < minY) minY = ball.pixelY;
    }
  }

  const state = debugSnapshot(game);
  return {
    phase: state.phase,
    ballsServed: state.ballsServed,
    ends,
    reachedRamp,
    leftTheLane,
    minY,
  };
}

const RUNS = new Map<TableId, TableRun>();
function runFor(tableId: TableId): TableRun {
  const cached = RUNS.get(tableId);
  if (cached !== undefined) return cached;
  const fresh = playTable(tableId);
  RUNS.set(tableId, fresh);
  return fresh;
}

/**
 * Free lower-level ball centres from which the drain is reachable at all.
 *
 * Flooded up from the bottom rows, so it answers the only question that makes
 * "sealed pocket" mean anything: could a ball parked here EVER get out, ignoring
 * gravity entirely? A place that fails this is one the geometry has no exit
 * from; a place that passes it but still holds the ball is a cup a real
 * machine's coil would empty, which is a different and much smaller complaint.
 */
const DRAIN_REACH = new Map<TableId, Set<number>>();
function drainConnected(tableId: TableId): Set<number> {
  const cached = DRAIN_REACH.get(tableId);
  if (cached !== undefined) return cached;

  const views: LevelViews = levelViewsOf(mapFor(tableId), materialTableFor(tableId));
  const { width, height } = views.map;
  const seen = new Set<number>();
  const queue: number[] = [];
  const push = (x: number, y: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const key = y * width + x;
    if (seen.has(key) || !freeCentre(views, 0, x, y)) return;
    seen.add(key);
    queue.push(key);
  };
  for (let x = 0; x < width; x += 1) {
    for (let y = height - 6; y < height; y += 1) push(x, y);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const key = queue[head] ?? 0;
    const x = key % width;
    const y = (key / width) | 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  DRAIN_REACH.set(tableId, seen);
  return seen;
}

/**
 * How a table's balls actually leave play, over a spread of real games.
 *
 * `playTable` above plays one shot — a full plunge, no flippers — and is the
 * right instrument for "does the launch shot work". This one is the instrument
 * for "does the machine keep giving the ball back": sixty games at every plunge
 * strength from a fumbled tap to a full pull, a player who flips when a ball is
 * down by the bats, and a shove every seven hundred ticks.
 *
 * A drain is a ball that left through the bottom row. Everything else is the
 * ball search retiring a ball the playfield stopped returning, which is the
 * number that has to stay small.
 */
interface WriteOffCensus {
  readonly drained: number;
  readonly writtenOff: number;
  /** Write-off sites, most frequent first, for a failure message worth reading. */
  readonly sites: readonly (readonly [string, number])[];
  /** Games that reached `game-over` having served every ball. */
  readonly completed: number;
  readonly games: number;
  /** Starting pulls whose game never ended, and where the ball was left. */
  readonly stalls: readonly string[];
}

/**
 * Ticks the player gets. Every completing game in the census finishes well
 * inside this; the budget exists so a stall is reported as a stall rather than
 * running forever.
 */
const CENSUS_TICKS = 20_000;

/**
 * Ticks added to the pull after a plunge that hands the ball straight back.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCRIPTED PLAYER ESCALATES, AND WHY THAT IS NOT A WEAKENED TEST
 * ---------------------------------------------------------------------------
 * The launch shot on these tables is expensive: measured through the real loop,
 * it first completes at a pull of 28/32 on Law 'n Justice, 22/32 on BabeWatch
 * and 26/32 on Extreme Sports (see MAX_LAUNCH_SPEED). Anything weaker dribbles
 * partway up the lane and comes back down, and because the lane floor IS the
 * plunger rod the ball lands back on it and is shootable again — which is
 * exactly what a real machine does, and what `ballBackOnTheRod` implements.
 *
 * The census used to hold its pull fixed for the whole game. That models a
 * player who watches a plunge fail and then makes the identical plunge again,
 * forever, and it is the reason nine of thirty Law 'n Justice games, six of
 * thirty BabeWatch games and three of thirty Extreme Sports games never reached
 * ball two. Those games contributed NOTHING to either counter below — no drains,
 * no write-offs — so the ratio this file budgets was measured over the games
 * that happened to work, and the ones that hung were invisible. That is the
 * failure mode this whole exercise was about.
 *
 * So the player now pulls harder when the ball is handed back, and the sweep
 * over `hold` becomes a sweep over the FIRST pull rather than over every pull of
 * a game. Nothing else about the machine changed to make this pass. And the
 * assertions got stronger, not weaker: every game must now reach `game-over`
 * having served all three balls, which was never asserted at all before.
 */
const PULL_HARDER_TICKS = 4;

/**
 * How high the ball has to get before the player will swing at it again.
 *
 * A player flips at a ball coming down at the bats and then lets go; they do not
 * hold both buttons down for the rest of the game. Holding them down is what the
 * old census did, and on a raised bat it is not a flip, it is a CRADLE: measured
 * on Extreme Sports at a starting pull of 50, the ball came to rest on the left
 * bat at (122,540) and sat there for sixty thousand ticks, because the "is a
 * ball descending below y=470" test kept re-triggering on the same cradled ball
 * and the bat never dropped. The ball was never lost and never in danger; the
 * game simply could not end.
 *
 * One swing per approach, re-armed when the ball gets back above this row, is
 * both the more realistic player and the one whose games terminate.
 */
const REARM_ROW = 430;
const SWING_TICKS = 8;

const CENSUS = new Map<TableId, WriteOffCensus>();
function writeOffCensus(tableId: TableId): WriteOffCensus {
  const cached = CENSUS.get(tableId);
  if (cached !== undefined) return cached;

  let drained = 0;
  let writtenOff = 0;
  let completed = 0;
  let games = 0;
  const sites = new Map<string, number>();
  const stalls: string[] = [];

  for (let hold = 10; hold < 70; hold += 2) {
    games += 1;
    const game = createGame(mapFor(tableId), { ballsPerGame: 3 });
    startGame(game);
    /** The pull this player is currently making, in ticks of hold. */
    let pull = hold;
    /** A ball has been launched and has not been handed back yet. */
    let inFlight = false;
    /** The player is ready to swing at the next ball that comes down. */
    let armed = true;
    /** Ticks up to which the bats are held. */
    let swingUntil = -1;
    const input = new ScriptedInput((tick) => {
      const controls: Control[] = [];
      const phase = tick % 400;
      if (phase >= 40 && phase < 40 + pull) controls.push("plunger");
      if (tick < swingUntil) controls.push("leftFlipper", "rightFlipper");
      if (tick > 0 && tick % 700 < 3) controls.push("nudgeLeft");
      return controls;
    });

    let last = new Map<number, { x: number; y: number }>();
    for (let tick = 0; tick < CENSUS_TICKS; tick += 1) {
      const report = runTicks(game, input, 1)[0];
      for (const id of report?.drained ?? []) {
        const seen = last.get(id);
        if ((seen?.y ?? -1) >= 590) drained += 1;
        else {
          writtenOff += 1;
          const key = `(${seen?.x},${seen?.y})`;
          sites.set(key, (sites.get(key) ?? 0) + 1);
        }
      }
      last = new Map();
      const state = debugSnapshot(game);

      // The plunge either got the ball away or gave it straight back. Giving it
      // back is the signal to pull harder; a fresh serve starts the ladder again.
      if (report?.launched === true) inFlight = true;
      else if (inFlight && state.laneBallId !== null) {
        pull += PULL_HARDER_TICKS;
        inFlight = false;
      }
      if (report?.served === true) {
        pull = hold;
        inFlight = false;
      }

      let batsWanted = false;
      for (const ball of state.balls) {
        if (!ball.active) continue;
        last.set(ball.id, { x: ball.pixelX, y: ball.pixelY });
        if (ball.id === state.laneBallId) continue;
        // The ball got back up the table, so the player is ready to swing again.
        if (ball.pixelY < REARM_ROW) armed = true;
        // A player flips when the ball is coming down at the bats, not always.
        if (ball.pixelY > 470 && ball.velocityY > 0) batsWanted = true;
      }
      if (batsWanted && armed) {
        swingUntil = tick + SWING_TICKS;
        armed = false;
      }

      if (state.phase === "game-over") break;
    }

    const end = debugSnapshot(game);
    if (end.phase === "game-over" && end.ballsServed === game.options.ballsPerGame) {
      completed += 1;
    } else {
      const ball = end.balls.find((one) => one.active);
      stalls.push(
        `pull ${hold}: ${end.ballsServed} balls served, ball left at ` +
          (ball === undefined ? "nowhere" : `(${ball.pixelX},${ball.pixelY}) on level ${ball.level}`),
      );
    }
  }

  const census: WriteOffCensus = {
    drained,
    writtenOff,
    completed,
    games,
    stalls,
    sites: [...sites.entries()].sort((a, b) => b[1] - a[1]),
  };
  CENSUS.set(tableId, census);
  return census;
}

/** The nearest free centre to a resting ball, within a ball radius. */
function nearestFreeCentreKey(tableId: TableId, x: number, y: number): number | null {
  const views = levelViewsOf(mapFor(tableId), materialTableFor(tableId));
  for (let radius = 0; radius <= 8; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || px >= views.map.width || py < 0 || py >= views.map.height) continue;
        if (freeCentre(views, 0, px, py)) return py * views.map.width + px;
      }
    }
  }
  return null;
}

/**
 * Every place the ball search actually retired a ball, before the fix.
 *
 * Collected from write-off censuses over sixty games a table: Law 'n Justice's
 * spiral and its top-left triangle, BabeWatch's left-side pockets, and Extreme
 * Sports' crown corner and the ridge leading down to it. They are historical
 * coordinates, not a wish list — each one is where a real ball really ended.
 *
 * Every column below is 32 larger than it was recorded as. The censuses were run
 * against maps exported a word out of phase, so each site was recorded 32 px left
 * of the geometry it names; the maps have since been re-exported and these are
 * the same sites on the corrected frame. The rows are untouched, which is what
 * makes the translation a translation rather than a re-measurement — a horizontal
 * reframe cannot move a row.
 */
const HISTORIC_STRAND_SITES: Readonly<Record<TableId, readonly (readonly [number, number])[]>> =
  Object.freeze({
    "law-n-justice": [[86, 155], [40, 122], [40, 441], [159, 17], [219, 21], [206, 20]],
    babewatch: [[91, 170], [91, 163], [90, 171], [39, 122], [72, 99], [40, 121]],
    "extreme-sports": [
      [302, 163],
      [247, 144],
      [255, 147],
      [296, 397],
      [276, 380],
      [40, 153],
    ],
  });

describe("the two deterministic ball traps", () => {
  /** Steps one hand-placed ball on the real geometry, with nothing else in play. */
  function settle(
    tableId: TableId,
    x: number,
    y: number,
    level: 0 | 1,
    ticks: number,
  ): { readonly x: number; readonly y: number; readonly level: number; readonly moved: number } {
    const map = mapFor(tableId);
    const materials = materialTableFor(tableId);
    const set = createBallSet();
    const ball = spawnBall(set, pixelsToQ10(x), pixelsToQ10(y), 0, 0, level);
    const startX = ball.x;
    const startY = ball.y;
    for (let tick = 0; tick < ticks; tick += 1) {
      stepBalls(set, map, materials, { gravityY: PLUNGER_REFERENCE_GRAVITY, nudgeX: 0, nudgeY: 0 });
    }
    return {
      x: ball.x / 1024,
      y: ball.y / 1024,
      level: ball.level,
      moved: Math.max(Math.abs(ball.x - startX), Math.abs(ball.y - startY)) / 1024,
    };
  }

  it("law-n-justice: a ball that runs out of speed on the top orbit rolls back down it", () => {
    // TRAP ONE. A ball coasting up the right leg of the top arch on the upper
    // collision line used to stop dead — position and velocity both frozen — and
    // sit there until the ball search retired it. Under an aggressive player
    // (bats every 17-30 ticks, thirty games a table at every integer pull from 8
    // to 97) fifteen of Law 'n Justice's two hundred and seventy balls ended on
    // the single pixel (214,20), and every one of the five games that found it
    // lost ALL THREE of its balls there: the starting pulls were 11, 15, 19, 23
    // and 27, one residue class mod 4, which is what a fixed geometric trap on a
    // deterministic trajectory looks like.
    //
    // It was not a cup. Free upper-line centres at the resting row are [216-231]
    // and the channel runs on down to the shooter lane; the ball was resting on
    // the inner arc's face, which falls one row every four columns — a 14 degree
    // slope a ball plainly rolls down. What held it was the SNAPPED contact
    // normal: the ring's entries are 7.1 degrees apart near the axes, the mean of
    // the two touched pixels is 10.6 degrees off vertical, and rounding it onto
    // the ring gave 7.1 — under the model's own static-friction angle of
    // atan(154/1024) = 8.55 degrees. See `outwardNormalOf` in collision-probe.ts.
    //
    // So the assertion is the physical one: put the ball anywhere along the
    // orbit's right leg and it must LEAVE, not merely stop tidily. A ball search
    // window is 500 ticks, so that is the budget.
    for (const [x, y] of [[214, 21], [216, 21], [218, 22], [222, 23], [226, 24], [230, 25], [240, 28], [250, 31]] as const) {
      const end = settle("law-n-justice", x, y, 1, BALL_SEARCH_TICKS);
      expect(
        end.moved,
        `law-n-justice (${x},${y}) on the orbit crept ${end.moved.toFixed(2)}px in ${BALL_SEARCH_TICKS} ticks`,
      ).toBeGreaterThan(BALL_SEARCH_BOX_PIXELS);
      // And it went DOWN the leg, back toward the lane, rather than anywhere else.
      expect(end.y, `law-n-justice (${x},${y}) did not descend`).toBeGreaterThan(y + 8);
    }
  });

  it("extreme-sports: every ball that enters the crown wedge finds the wireform", () => {
    // TRAP TWO, and this one really was a cup. The wedge between the crown's
    // outermost arc and the shooter lane's outer wall closes to the single free
    // centre (302,162) and has nothing at all at y=163, so a ball that settles in
    // it is lost for the rest of the game. `crown-mouth` used to be one gate at
    // y=158 spanning x=289..291, which catches only a ball that crosses that row
    // in those three columns; a ball falling in from the open top of the table
    // lands below the row and never crosses it, and a ball rolling on the wedge's
    // floor crosses it two to three columns further left. The site the census
    // recorded is (302,162)/(302,163).
    //
    // The fix is `crownMouthGates`: the mouth is the wireform's whole run through
    // the wedge, and its columns on each row are the ramp's own interior. So the
    // test is the exhaustive one — every column of the wedge's open top, at four
    // depths, must end up out of the corner.
    let entered = 0;
    for (let x = 262; x <= 302; x += 1) {
      for (const y of [120, 130, 140, 148]) {
        entered += 1;
        const end = settle("extreme-sports", x, y, 0, 900);
        expect(
          end.y,
          `extreme-sports: a ball entering the crown wedge at (${x},${y}) ended at ` +
            `(${end.x.toFixed(1)},${end.y.toFixed(1)}) on level ${end.level}`,
        ).toBeGreaterThan(200);
      }
    }
    expect(entered).toBe(164);

    // And the corner itself is still what it was measured to be, so this test
    // fails loudly rather than quietly if a re-export moves the wedge.
    const views = levelViewsOf(mapFor("extreme-sports"), materialTableFor("extreme-sports"));
    expect(freeCentre(views, 0, 302, 162)).toBe(true);
    for (let x = 260; x <= 320; x += 1) expect(freeCentre(views, 0, x, 163)).toBe(false);
  });
});

describe("all three tables", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId} launches its ball out of the shooter lane and onto the playfield`, () => {
      // The headline. Before the hand-off was generalised, BabeWatch's ball sat
      // in a 577-cell sealed box at the bottom of its lane and Extreme Sports'
      // died in the funnel beside its own lane — neither reached the playfield
      // at all, at any plunge strength, in twenty thousand ticks.
      const run = runFor(tableId);
      expect(run.leftTheLane, "the ball never left the shooter lane").toBe(true);
      // And it got there by riding the ramp line, which is what the hand-off is.
      expect(run.reachedRamp, "the ball never reached the upper collision line").toBe(true);
      // And it got past the middle of the table, not a dribble: the ball is
      // served at y=544 on all three, so this is more than half the playfield.
      expect(run.minY).toBeLessThan(300);
    });

    it(`${tableId} completes a three-ball game`, () => {
      const run = runFor(tableId);
      expect(run.phase, `stalled after ${run.ballsServed} balls`).toBe("game-over");
      expect(run.ballsServed).toBe(3);
      expect(run.ends).toHaveLength(3);
    });

    it(`${tableId} launches, reaches the playfield and drains out of the bottom`, () => {
      // The three things end to end, on one shot, for one table: it leaves the
      // lane, it gets past the middle of the table, and it leaves through the
      // bottom row rather than being retired where it stopped. Extreme Sports
      // could do none of the third until `crown-mouth` and `crown-end` were
      // found: all ninety of its balls ended at (302,163).
      const run = runFor(tableId);
      expect(run.leftTheLane).toBe(true);
      expect(run.minY).toBeLessThan(300);
      for (const end of run.ends) {
        expect(end.drained, `ball ended at (${end.x},${end.y}), not at the drain`).toBe(true);
        expect(end.y).toBeGreaterThanOrEqual(590);
      }
    });

    it(`${tableId} never writes off a ball that is still moving`, () => {
      // THE REGRESSION TEST FOR THE STRANDING BUG. Every site below is a place
      // the ball search really did retire a ball, taken from the write-off
      // censuses run before the fix. Not one of them was a wedged ball: they
      // were all balls in sustained contact still rolling at a TERMINAL CRAWL of
      // 1 to 37 Q10 per tick — 0.001 to 0.036 px/tick — because `reflectVelocity`
      // took a flat 15% of the whole tangential speed on every tick of contact.
      // The search asks for eight pixels in five hundred ticks, which is 16 Q10
      // a tick, so anything on a slope shallower than about seven degrees could
      // never clear it and was written off while visibly moving.
      //
      // What must be true now is a disjunction, and it is the honest one: put a
      // ball at any of these places and within the search's own window it has
      // either LEFT the box — it rolled out, which is what a ball on a slope
      // does — or it has come to an EXACT stop, velocity zero, which is what a
      // ball in a cup does and is a thing a real machine's coil would clear.
      // What may never happen again is the third case: still inside the box,
      // still carrying velocity, five hundred ticks later.
      const map = mapFor(tableId);
      const materials = materialTableFor(tableId);
      for (const [x, y] of HISTORIC_STRAND_SITES[tableId]) {
        const set = createBallSet();
        const ball = spawnBall(set, pixelsToQ10(x), pixelsToQ10(y));
        let startX = ball.x;
        let startY = ball.y;
        for (let tick = 0; tick < BALL_SEARCH_TICKS && ball.active; tick += 1) {
          stepBalls(set, map, materials, { gravityY: PLUNGER_REFERENCE_GRAVITY, nudgeX: 0, nudgeY: 0 });
          // The search anchors after the ball has settled onto the geometry, so
          // measure from the same place it would.
          if (tick === 0) {
            startX = ball.x;
            startY = ball.y;
          }
        }
        const moved = Math.max(Math.abs(ball.x - startX), Math.abs(ball.y - startY)) / 1024;
        const stopped = ball.velocityX === 0 && ball.velocityY === 0;
        expect(
          !ball.active || moved > BALL_SEARCH_BOX_PIXELS || stopped,
          `${tableId} (${x},${y}): after ${BALL_SEARCH_TICKS} ticks it had crept ${moved.toFixed(2)}px` +
            ` and was still moving at (${ball.velocityX},${ball.velocityY})`,
        ).toBe(true);
      }
    });

    it(`${tableId} never writes a ball off into a sealed pocket`, () => {
      // The ball search is allowed to give up on a ball a cup is holding — a
      // real machine does exactly that, and this reconstruction has no coils to
      // empty one with. What it must NEVER do is give up on a ball in a place
      // the geometry has no way out of, because that means the ball was put
      // somewhere it could not have got to.
      const reach = drainConnected(tableId);
      for (const end of runFor(tableId).ends) {
        if (end.drained) continue;
        const key = nearestFreeCentreKey(tableId, end.x, end.y);
        expect(key, `written off at (${end.x},${end.y}) with no free centre near it`).not.toBeNull();
        expect(
          key === null ? false : reach.has(key),
          `written off at (${end.x},${end.y}), which no path reaches the drain from`,
        ).toBe(true);
      }
    });
  }

  it("finishes a game on every table with a player who keeps nudging", () => {
    // The nudge regression, checked on all three rather than only the table it
    // was found on. Two things had to be true for this: a shove must not reach a
    // ball on the ramp line (`nudgeReachesLevel` — one 2048 Q10 impulse used to
    // be forty times the speed of a ball coasting round an arch, so it replaced
    // the shot rather than perturbing it), and the ball search must judge
    // CONFINEMENT rather than pixel equality, or a nudge every 700 ticks holds
    // its clock at 493 of the 500 it needs, forever.
    //
    // Cadences near the search window itself remain a known residual, worst at
    // exactly 500 — see BALL_SEARCH_BOX_PIXELS. It needs the device layer, not a
    // bigger constant, and it is not what this test is about.
    for (const tableId of TABLE_IDS) {
      for (const cadence of [700, 2000]) {
        const game = createGame(mapFor(tableId), { ballsPerGame: 3 });
        startGame(game);
        const input = new ScriptedInput((t) => {
          const controls: Control[] = [];
          const phase = t % 400;
          if (phase >= 40 && phase < 100) controls.push("plunger");
          if (t % 23 < 4) controls.push("leftFlipper");
          if ((t + 11) % 29 < 4) controls.push("rightFlipper");
          if (t > 0 && t % cadence < 3) controls.push("nudgeLeft");
          return controls;
        });

        runTicks(game, input, 20_000);
        const state = debugSnapshot(game);
        expect(
          state.phase,
          `${tableId} nudged every ${cadence} stalled after ${state.ballsServed} balls`,
        ).toBe("game-over");
        expect(state.ballsServed).toBe(3);
      }
    }
  });

  it("drains every table down the middle, not by ball search", () => {
    // This used to be two tests: a plain assertion for Law 'n Justice and
    // BabeWatch, and an `it.fails` characterisation for Extreme Sports, whose
    // every ball ended as a write-off on the single pixel (302,163) — the corner
    // between the crown ramp's outer arc and the shooter lane's left wall. Its
    // apparent 30-in-30 completion rate was entirely the ball search retiring
    // stuck balls. (That pixel read (270,163) until the maps were re-exported on
    // the correct 32 px frame. It is still exactly one pixel and still a cup, so
    // it was never a framing artefact.)
    //
    // The corner was never the whole story: the crown ramp CONTINUES, on the
    // upper collision line, down a wireform that runs to y=380 and hands back to
    // the lower line at x=274..276. `crown-mouth` and `crown-end` in
    // `playfield-levels.ts` are that pair of hand-offs, both read off the map.
    for (const tableId of TABLE_IDS) {
      const ends = runFor(tableId).ends;
      expect(ends.map((end) => end.drained), `${tableId}`).toEqual([true, true, true]);
      for (const end of ends) expect(end.y).toBeGreaterThanOrEqual(590);
    }
  });

  it("does not lean on the ball search to finish a game", () => {
    // The headline number this whole exercise is about. A ball search firing on
    // one ball in eight is masking a bug, not solving one, so the rate is
    // measured rather than asserted away — over sixty games a table at every
    // plunge strength from a fumbled tap to a full pull, with a player who
    // flips when the ball is down by the bats and shoves the cabinet every
    // fourteen seconds.
    //
    // Where the numbers stood before the physics fix, on this same harness:
    // Law 'n Justice 22.8%, BabeWatch 0.6%, Extreme Sports 82.6% — and Extreme
    // Sports' 17.4% of "drains" were balls that never left the shooter lane's
    // half of the table. What changed is `reflectVelocity`: friction was a flat
    // percentage of the ball's whole tangential speed taken on every tick of
    // contact, which gave a ball on a slope a terminal crawl of 0.001..0.036
    // px/tick instead of letting it accelerate, so the search wrote off balls
    // that were still visibly rolling.
    //
    // Law 'n Justice's budget used to be 0.35, and that was the misframed map.
    // Its residual was blamed on the top-left bowl under the arch, which the
    // fabricated `arch-exit` gate dropped the ball into in free fall from y=46.
    // On the re-exported maps the arch ramp does not end at y=46 — it runs on
    // down the left of the table to y=210 and hands the ball over there, which
    // is authored geometry rather than an invented release point — and the bowl
    // never gets a ball at all. Measured on this harness after the reframe:
    //
    //   law-n-justice   0 written off, 63 drained   (was ~22.8%)
    //   babewatch       0 written off, 72 drained
    //   extreme-sports  2 written off, 73 drained   (was 82.6%)
    //
    // Extreme Sports' two used to be one site, (50,432): a ball balanced on the
    // crown of a post in the left playfield. Free centres there go [20-20]
    // [28-76] at y=432 and [30-46] [54-74] one row lower, so the ball is resting
    // on top of something round with nothing under it — a device, and this
    // reconstruction has no device layer to kick one off. That is what slot 4 and
    // a kicker layer are for, and the budget stays at 5% to say so rather than
    // ratcheting down to a number the next map export would break.
    //
    // Where they stand now, with `crown-mouth` corrected and the census player
    // pulling harder at a ball it has been handed back (see PULL_HARDER_TICKS):
    //
    //   law-n-justice   0 written off, 90 drained
    //   babewatch       0 written off, 90 drained
    //   extreme-sports  0 written off, 90 drained
    //
    // ---------------------------------------------------------------------
    // THIS PLAYER IS NOT THE WORST CASE, AND THE CENSUS THAT IS LIVES BESIDE IT
    // ---------------------------------------------------------------------
    // The player above swings once per approach and only when a ball is coming
    // down at the bats. A more aggressive one — bats tapped on a fixed cadence
    // of 17 to 30 ticks whatever the ball is doing — keeps the ball alive 60 to
    // 115% longer and therefore visits far more of the playfield. Run over
    // thirty games a table at every integer pull from 8 to 97 (270 balls a
    // table) it found two deterministic traps this census never reached, both
    // fixed and both now pinned by "the two deterministic ball traps" above:
    //
    //   law-n-justice   (214,20) on the ramp line, 15 of 270 balls, only at
    //                   starting pulls 11/15/19/23/27 and always all three balls
    //                   of the game — one residue class mod 4.
    //   extreme-sports  (302,162)/(302,163) on the playfield line, the closed
    //                   corner between the crown arc and the shooter lane.
    //
    // Measured on that harness, before and after:
    //
    //                   completed        written off   worst site
    //   law-n-justice   87/90 -> 90/90   39 -> 44      (214,20) 15 -> 0
    //   babewatch       90/90 -> 90/90   46 -> 30      (90,171) 18 -> 7
    //   extreme-sports  89/90 -> 89/90    1 ->  5      (302,16x) 0 -> 0
    //
    // What is left is NOT the two traps and is written down rather than hidden:
    // Law 'n Justice's spiral at (86,155) and the closed foot of its left-edge
    // chute at (8,388), and BabeWatch's (91,171) and (72,99). The first three
    // are cups the geometry has no gravity-driven exit from and the real machine
    // empties with a coil — the device layer this reconstruction does not have
    // yet. (8,388) is a THIRD trap of the same kind as the two fixed here, fully
    // characterised — a chute down the left of the table whose free centres run
    // [8-30] from y=300 and close to [8-8] at y=388 with nothing at y=389 — but
    // its continuation, an upper-line wireform running x=12..13 from y=265 to
    // y=378 and ending at (35,456) over open lower-line space, has NOT been
    // derived to the standard the other hand-offs are held to, so no gate has
    // been invented for it.
    const budget: Readonly<Record<TableId, number>> = {
      "law-n-justice": 0.05,
      babewatch: 0.05,
      "extreme-sports": 0.05,
    };
    for (const tableId of TABLE_IDS) {
      const { drained, writtenOff, sites } = writeOffCensus(tableId);
      expect(drained + writtenOff, `${tableId} produced no ball ends at all`).toBeGreaterThan(50);
      expect(
        writtenOff / (drained + writtenOff),
        `${tableId}: ${writtenOff} written off, ${drained} drained, worst sites ` +
          sites.slice(0, 5).map(([site, count]) => `${site}x${count}`).join(" "),
      ).toBeLessThanOrEqual(budget[tableId]);
    }
  });

  it("finishes every census game on every table, at every starting pull", () => {
    // THE ZERO-DEADLOCK GUARANTEE, and the assertion this file was missing.
    //
    // Nothing here checked that a census game ENDED. A game that hung produced no
    // drains and no write-offs, so it vanished from the ratio above instead of
    // failing anything — and eighteen of the ninety games were hanging: nine on
    // Law 'n Justice, six on BabeWatch, three on Extreme Sports, every one of
    // them a ball sitting back on the plunger rod after a plunge too weak to
    // clear the arch, being re-plunged at the same strength for twenty thousand
    // ticks.
    //
    // What must hold is stated in terms of the machine rather than the script: a
    // player who plays — who pulls harder when the machine hands the ball back,
    // and who swings at a ball coming down at the bats — must always be able to
    // finish the game. On no table, at no starting pull, may the playfield stop
    // giving the ball back.
    for (const tableId of TABLE_IDS) {
      const { completed, games, stalls, drained, writtenOff } = writeOffCensus(tableId);
      expect(completed, `${tableId} stalled ${games - completed} of ${games}:\n${stalls.join("\n")}`)
        .toBe(games);
      // And every one of those games really did play three balls out.
      expect(drained + writtenOff, `${tableId} ball ends`).toBe(games * 3);
    }
  });

  it("ends its census games by draining, not by ball search", () => {
    // The completion above would be worth nothing if the balls were being retired
    // rather than drained — that is exactly the false 30-in-30 Extreme Sports
    // used to score, where every ball ended at (302,163) and none went down the
    // middle. So the completion rate is restated as a DRAIN rate: at least 27 of
    // the 30 games on each table must be three real drains out of three.
    for (const tableId of TABLE_IDS) {
      const { drained, games } = writeOffCensus(tableId);
      expect(
        drained,
        `${tableId} drained only ${drained} of ${games * 3} balls down the bottom row`,
      ).toBeGreaterThanOrEqual(27 * 3);
    }
  });
});

describe("reproducibility", () => {
  it("gives byte-identical results for the same input sequence", () => {
    const plan = (t: number): readonly Control[] => {
      if (t % 400 >= 60 && t % 400 < 110) return ["plunger"];
      if (t % 37 === 0) return ["leftFlipper"];
      if (t % 53 === 0) return ["rightFlipper", "nudgeRight"];
      return [];
    };

    const run = () => {
      const game = createGame(realMap());
      startGame(game);
      runTicks(game, new ScriptedInput(plan), 3_000);
      return JSON.stringify(debugSnapshot(game));
    };

    expect(run()).toBe(run());
  });
});
