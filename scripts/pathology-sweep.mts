// THE PATHOLOGY SWEEP — does the machine's frame still give the ball back?
//
// `aggressive-census.mts` counts ball ENDS: it knows whether a ball drained or
// was written off, and nothing about the twelve thousand ticks in between. Every
// defect the user of this reconstruction has ever reported is one of those
// in-between defects — "the ball goes through the flippers when flipping", "the
// ball goes under the flipper instead of shooting up" — and a census cannot see
// any of them, because a ball that spends nine hundred ticks vibrating in a
// crack and then drains normally is, to a census, a perfectly ordinary ball.
//
// `78bed65` replaced the integrator with the machine's own frame, which charges
// the per-contact friction FOUR TIMES A TICK where the old rule charged it once.
// Effective rolling friction therefore roughly QUADRUPLED. That is a change that
// can be simultaneously more faithful per-frame (it is: RAM error 21089 -> 1790)
// and worse to play, and nothing in the suite would notice. So this sweep looks
// at the ball's WHOLE PATH and asks the questions a player would:
//
//   STUCK        the ball stopped somewhere it should not have stopped
//   OSCILLATING  the ball is vibrating between two surfaces, going nowhere
//   CREEPING     the ball is moving, but so slowly it will never arrive
//   DWELL        the ball spent an outlying amount of time in one 8x8 cell
//   HELD         a device took the ball and did not give it back
//   COVERAGE     which 8x8 cells of which level the ball reached at all
//
// COVERAGE IS THE POINT OF THE JSON. Run this against a control tree (the
// cross-validation round used `git archive c9724a4` for exactly this) and
// `--compare` the two files: a region the ball used to reach and no longer
// does is a regression the per-frame gates cannot see, because per-frame
// fidelity is a local property and reachability is a global one.
//
// Deliberately NOT a test, for the same reason the census is not: it takes
// minutes and pinning its numbers would turn a survey into a change detector.
// Reproductions of what it finds go in the suite as tests; this finds them.
//
// Usage:
//   npx vite-node scripts/pathology-sweep.mts -- [options] [tableId ...]
//     --games=N      games per table per profile (default 12)
//     --ticks=N      tick budget per game (default 40000)
//     --profiles=a,b which players to run (default all: aggressive,passive,cradle)
//     --json=PATH    write the full record, including coverage, here
//     --compare=PATH read a previous --json and report coverage deltas
//     --quiet        summary lines only
//     --trace=t,p,g,from,to   re-run ONE game and dump the ball per tick
//
// EVERY FINDING IS REPRODUCIBLE, which is the point of `--trace` and `--drop`.
// The player for game N is a pure function of N and the simulation is
// deterministic, so a finding reported as "game 136 ball 0 tick 2438" replays
// exactly:
//   --trace=babewatch,aggressive,136,2300,2500
// and a trap site the census names replays from its own release point:
//   --drop=babewatch,1,316,252,900
//
// ---------------------------------------------------------------------------
// WHAT THE FIRST RUN OF THIS SWEEP FOUND, and the verdict on each
// ---------------------------------------------------------------------------
// Measured 2026-08-04 over 900 games x 3 tables x 3 profiles (7.5 M ticks) plus
// the trap census at 4 px (68,620 releases), against `git archive c9724a4` — the
// commit before the machine's frame landed — as the control.
//
//   FIXED. The bat's approach-side reference was a stale POSITION rather than a
//   sign, so a ball still embedded when the stroke reached its stop was ejected
//   DOWNWARD through the blade. This is the operator's own report and it was
//   PRE-EXISTING (worse at c9724a4 than at 822caf5). See `flippers.ts`
//   `touchAt` and `tests/flipper-pass-under.test.ts`.
//
//   PRE-EXISTING, map geometry, left alone. Law 'n Justice (24,304)L0 — the
//   pocket beside the upper-left bat — holds a ball dead still on BOTH trees
//   (still from tick 4 on the control, tick 5 here). BabeWatch (252,57)L0 the
//   same, 11 releases here against 10 on the control. Both are map pockets the
//   ball search exists to answer; `sim-hash-pin`'s own header has recorded the
//   Law 'n Justice one since the ball-search round.
//
//   RECORDED, NOT FIXED — the decoded replacement is already known. BabeWatch's
//   right-hand LEVEL-1 rail: a ball released at (316,252)L1 drains in 93 ticks
//   on the control and here creeps down the rail and stops DEAD at
//   (327.15,363.00)L1 from tick 529, v = (0,0), for ever. 62 releases end there
//   against 9 on the control, and one game in 900 reached it in play. The creep
//   itself is the decoded frame doing what it should — four collision passes a
//   tick charge the machine's own rolling friction four times, which is the
//   whole point of `78bed65` — but the DEAD STOP is the port's stand-in for the
//   machine's undecoded resting-ball ejector, plus one global post-restitution
//   rest threshold where the machine has a per-surface one. Both have since been
//   decoded (`research/spin/SPIN_DECODE.md`): the ejector is at +0x00B6BE inside
//   the substep integrator — ring hit count `$c(a4) >= 6` pushes the ball 0.5 px
//   along the bearing, once per substep — and `$38(a4)` is a per-surface
//   threshold on the RAW approach (-800/-200/-2000/-400/0). A ball the machine
//   bobs cannot come to rest, so this site is a consequence of the two
//   deviations and not a separate defect. Anything hand-tuned here would be
//   thrown away by the round that lands them, and worse, would mask the rule.
//   Extreme Sports shows the same class once, at (176.7,64)L1.
//
//   NOT A DEFECT, and the census figure it explains. Extreme Sports' median fell
//   425,000 -> 347,500 over the machine's-frame round, which looked like a loss
//   and is not: the control keeps balls alive by NOT letting them go. Same
//   player, same budget, control -> 822caf5: ES aggressive burns 885,284 ticks
//   for its 900 ball ends against 707,098, ES cradle 2,021,878 with THIRTEEN
//   games unfinished against 842,233 with none, and the control's coverage
//   histogram has 94,576 ticks parked in one 8x8 cell of the upper deck
//   ((176-183,168-175)L1) against 7,021 here. The old ball loitered; the new one
//   is spent by the friction the machine charges and drains. Level-1 reachability
//   improved with it (Law 'n Justice L1 releases that reach the drain 59.7% ->
//   63.3%, 424 of them freed from one site at (268,436)L1).
//

import { readFileSync, writeFileSync } from "node:fs";
import { createBallSet, spawnBall, stepBalls, playfieldViewFor, VIRTUAL_TOP_WALL_ROWS } from "../src/game/ball-physics.js";
import { materialTableFor } from "../src/game/materials.js";
import { tableAccelerationFor } from "../src/game/table-accel.js";
import { tableDevicesFor } from "../src/game/table-devices.js";
import { upperLevelViewFor } from "../src/game/playfield-levels.js";
import { SIMULATION_GRAVITY } from "../src/game/timebase.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { parseTableAccelDocument, registerTableAcceleration } from "../src/game/table-accel.js";
import { parseTableDevicesDocument, registerTableDevices } from "../src/game/table-devices.js";
import { parseTableModesDocument, registerTableModes } from "../src/game/table-modes.js";
import { parseFlipperBatsDocument, registerFlipperBats } from "../src/game/flipper-bats.js";
import type {
  FlipperBatsDocument,
  TableAccelDocument,
  TableDevicesDocument,
  TableId,
  TableMapDocument,
  TableModesDocument,
} from "../src/game/contracts.js";

// ---------------------------------------------------------------------------
// The thresholds, and why each one is where it is
// ---------------------------------------------------------------------------

/**
 * The window every "is it going anywhere?" question is asked over: 500 ticks,
 * ten seconds at the 50 Hz shell clock.
 *
 * Long enough that no legitimate pinball event fills it — the longest authored
 * device hold on any of the three tables is well under a second, a full-table
 * plunge-to-drain is 200-400 ticks, and a cradled ball is under player control
 * so it is excluded by the bat test rather than by the clock. Short enough that
 * a stranded ball is reported while the game is still running rather than at
 * the tick budget, so the site is recoverable from the report.
 */
const WINDOW = 500;
/** Net travel below this over a whole WINDOW is "went nowhere", in pixels. */
const STUCK_SPAN_PX = 2;
/**
 * A ball can be legitimately still: on the lane seat waiting to be launched, in
 * the trough, held by a saucer, or cradled on a raised bat. Only the first two
 * are position tests; the rest are asked of the game state.
 *
 * The lane is the shooter chute, x >= 305 on all three tables (the launcher's
 * own switch zone is (310,540)-(330,560)); the seat is the bottom of it.
 */
const LANE_MIN_X = 300;
/** Below this row on the lane side, a still ball is simply waiting to launch. */
const LANE_MIN_Y = 500;
/**
 * "Creeping": moving, but at under a quarter pixel a tick, for a whole window.
 *
 * At 50 Hz that is 12.5 px/s — a ball crossing the 336 px table would take 27
 * seconds. Nothing on a pinball table legitimately moves that slowly for ten
 * unbroken seconds except a ball rolling to a dead stop, which ends as STUCK
 * and is reported once, not twice.
 */
const CREEP_SPEED_Q10 = 256;
/** Distinct 1-px cells in a window at or below this, with motion, is a rattle. */
const OSCILLATION_CELLS = 4;
/** Coverage cell size in pixels. 8 px is the ball's radius. */
const CELL = 8;
const CELL_COLUMNS = Math.ceil(336 / CELL);
/** Ticks in ONE unbroken visit to one cell that make the visit an outlier. */
const DWELL_TICKS = 400;
/** Ticks a device may hold a ball before the hold is reported. */
const HELD_TICKS = 600;

const DEFAULT_GAMES = 12;
const DEFAULT_TICKS = 40_000;
const BALLS_PER_GAME = 3;

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/**
 * Three players, because one player cannot expose all three families of defect.
 *
 * `aggressive` is the census player: both bats on a fixed beat, which keeps the
 * ball alive longest and therefore visits the most table. It is the coverage
 * instrument.
 *
 * `passive` NEVER FLIPS. It plunges and then lets the table do whatever it does,
 * which is the only way to see a shallow-slope stall: an aggressive player's
 * bats knock a stalling ball loose and hide the very thing this sweep exists to
 * find. Its games are short and its coverage is small, and that is fine — it is
 * a stall detector, not a coverage instrument.
 *
 * `cradle` holds both bats DOWN for long stretches and releases briefly, which
 * is how a real player traps. It is the instrument for the resting-ball
 * deviation: the port's position constraint holds a resting ball dead still
 * where the machine bobs it, so anything that depends on a ball at rest —
 * cradles above all — is where that deviation would show.
 */
const PROFILES = ["aggressive", "passive", "cradle"] as const;
type Profile = (typeof PROFILES)[number];

const MIN_CADENCE = 17;
const MAX_CADENCE = 30;
const TAP_TICKS = [2, 3, 4, 5] as const;
const NUDGE_PERIODS = [700, 900, 1100] as const;
const PLUNGE_TICKS = 6;

function planFor(profile: Profile, index: number): (tick: number) => readonly Control[] {
  const span = MAX_CADENCE - MIN_CADENCE + 1;
  const cadence = MIN_CADENCE + (index % span);
  const phase = (index * 5) % cadence;
  const tap = TAP_TICKS[Math.floor(index / span) % TAP_TICKS.length] ?? 3;
  const nudgePeriod = NUDGE_PERIODS[index % NUDGE_PERIODS.length] ?? 700;
  // Every profile plunges the same way: the kick is fixed, so this is a tap.
  const plunging = (tick: number): boolean => {
    const beat = tick % 400;
    return beat >= 40 && beat < 40 + PLUNGE_TICKS;
  };
  if (profile === "passive") {
    return (tick) => (plunging(tick) ? ["plunger"] : []);
  }
  if (profile === "cradle") {
    // Hold both bats for 300 ticks, drop them for 40, repeat: a trap attempt on
    // a fixed beat, with the release long enough for a held ball to leave.
    const period = 340 + (index % 7) * 10;
    return (tick) => {
      const controls: Control[] = [];
      if (plunging(tick)) controls.push("plunger");
      if ((tick + phase) % period < period - 40) controls.push("leftFlipper", "rightFlipper");
      return controls;
    };
  }
  return (tick) => {
    const controls: Control[] = [];
    if (plunging(tick)) controls.push("plunger");
    if ((tick + phase) % cadence < tap) controls.push("leftFlipper", "rightFlipper");
    if (tick > 0 && tick % nudgePeriod < 3) controls.push("nudgeLeft");
    return controls;
  };
}

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

// ---------------------------------------------------------------------------
// Table assembly (four registries, exactly as the census does it)
// ---------------------------------------------------------------------------

function mapFor(tableId: TableId) {
  const batsUrl = new URL(`../public/generated/flipper-bats.json`, import.meta.url);
  registerFlipperBats(
    parseFlipperBatsDocument(JSON.parse(readFileSync(batsUrl, "utf8")) as FlipperBatsDocument),
  );
  const accelUrl = new URL(`../public/generated/tables/${tableId}.accel.json`, import.meta.url);
  registerTableAcceleration(
    parseTableAccelDocument(JSON.parse(readFileSync(accelUrl, "utf8")) as TableAccelDocument),
  );
  const devicesUrl = new URL(`../public/generated/tables/${tableId}.devices.json`, import.meta.url);
  registerTableDevices(
    parseTableDevicesDocument(
      JSON.parse(readFileSync(devicesUrl, "utf8")) as TableDevicesDocument,
    ),
  );
  const modesUrl = new URL(`../public/generated/tables/${tableId}.modes.json`, import.meta.url);
  registerTableModes(
    parseTableModesDocument(JSON.parse(readFileSync(modesUrl, "utf8")) as TableModesDocument),
  );
  const url = new URL(`../public/generated/tables/${tableId}.map.json`, import.meta.url);
  return parseTableMapDocument(JSON.parse(readFileSync(url, "utf8")) as TableMapDocument);
}

// ---------------------------------------------------------------------------
// The per-ball tracker
// ---------------------------------------------------------------------------

interface Sample {
  readonly x: number;
  readonly y: number;
  readonly level: number;
  readonly held: boolean;
}

export interface Finding {
  readonly kind: "stuck" | "oscillating" | "creeping" | "dwell" | "held";
  readonly table: TableId;
  readonly profile: Profile;
  readonly game: number;
  readonly ball: number;
  readonly tick: number;
  readonly x: number;
  readonly y: number;
  readonly level: number;
  readonly ticks: number;
  readonly detail: string;
}

/** One ball's rolling history, enough to answer every window question. */
class BallTrack {
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly levels: number[] = [];
  private cellKey = -1;
  private cellSince = 0;
  private heldSince = -1;
  /** Findings already emitted for this ball, so one strand reports once. */
  private readonly reported = new Set<string>();

  constructor(readonly id: number) {}

  push(tick: number, sample: Sample, coverage: Set<number>, dwell: Finding[], make: (kind: Finding["kind"], tick: number, sample: Sample, ticks: number, detail: string) => Finding): Finding[] {
    const found: Finding[] = [];
    const cell = cellOf(sample.x, sample.y, sample.level);
    coverage.add(cell);

    // ---- unbroken dwell in one cell -------------------------------------
    if (cell !== this.cellKey) {
      const stayed = tick - this.cellSince;
      if (this.cellKey >= 0 && stayed >= DWELL_TICKS && !this.parked(sample)) {
        dwell.push(make("dwell", tick, sample, stayed, `cell ${describeCell(this.cellKey)}`));
      }
      this.cellKey = cell;
      this.cellSince = tick;
    }

    // ---- a device holding on ---------------------------------------------
    if (sample.held) {
      if (this.heldSince < 0) this.heldSince = tick;
      const heldFor = tick - this.heldSince;
      if (heldFor >= HELD_TICKS && this.once(`held@${this.heldSince}`)) {
        found.push(make("held", tick, sample, heldFor, "device did not release"));
      }
    } else {
      this.heldSince = -1;
    }

    // ---- the rolling window ----------------------------------------------
    this.xs.push(sample.x);
    this.ys.push(sample.y);
    this.levels.push(sample.level);
    if (this.xs.length > WINDOW) {
      this.xs.shift();
      this.ys.shift();
      this.levels.shift();
    }
    if (this.xs.length < WINDOW || sample.held || this.parked(sample)) return found;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let steps = 0;
    const cells = new Set<number>();
    for (let i = 0; i < WINDOW; i += 1) {
      const x = this.xs[i] ?? 0;
      const y = this.ys[i] ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      cells.add((Math.round(y) << 10) | Math.round(x));
      if (i > 0) {
        steps += Math.abs(x - (this.xs[i - 1] ?? 0)) + Math.abs(y - (this.ys[i - 1] ?? 0));
      }
    }
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const span = Math.max(spanX, spanY);
    const site = `${Math.round(sample.x)},${Math.round(sample.y)}L${sample.level}`;

    if (span < STUCK_SPAN_PX && steps < 1) {
      if (this.once(`stuck@${site}`)) {
        found.push(
          make("stuck", tick, sample, WINDOW, `span ${span.toFixed(2)} px, path ${steps.toFixed(2)} px`),
        );
      }
    } else if (span < STUCK_SPAN_PX && cells.size <= OSCILLATION_CELLS) {
      if (this.once(`osc@${site}`)) {
        found.push(
          make(
            "oscillating",
            tick,
            sample,
            WINDOW,
            `${cells.size} distinct px over ${WINDOW} ticks, path ${steps.toFixed(1)} px`,
          ),
        );
      }
    } else if (steps / WINDOW < CREEP_SPEED_Q10 / 1024 && span >= STUCK_SPAN_PX) {
      if (this.once(`creep@${Math.round(sample.y / 16)}`)) {
        found.push(
          make(
            "creeping",
            tick,
            sample,
            WINDOW,
            `${(steps / WINDOW).toFixed(3)} px/tick over ${WINDOW} ticks, span ${span.toFixed(1)}`,
          ),
        );
      }
    }
    return found;
  }

  /** True where a still ball is a ball doing its job: the shooter lane seat. */
  private parked(sample: Sample): boolean {
    return sample.x >= LANE_MIN_X && sample.y >= LANE_MIN_Y;
  }

  private once(key: string): boolean {
    if (this.reported.has(key)) return false;
    this.reported.add(key);
    return true;
  }
}

function cellOf(x: number, y: number, level: number): number {
  const column = Math.min(CELL_COLUMNS - 1, Math.max(0, Math.floor(x / CELL)));
  const row = Math.max(0, Math.floor(y / CELL));
  return level * 100_000 + row * CELL_COLUMNS + column;
}

function describeCell(key: number): string {
  const level = Math.floor(key / 100_000);
  const rest = key % 100_000;
  const row = Math.floor(rest / CELL_COLUMNS);
  const column = rest % CELL_COLUMNS;
  return `(${column * CELL}..${column * CELL + CELL - 1},${row * CELL}..${row * CELL + CELL - 1})L${level}`;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface TableSweep {
  readonly table: TableId;
  readonly profile: Profile;
  readonly games: number;
  readonly ticks: number;
  readonly completed: number;
  readonly drained: number;
  readonly writtenOff: number;
  readonly ticksPlayed: number;
  readonly findings: readonly Finding[];
  /** Coverage cell keys, sorted, so two runs can be compared exactly. */
  readonly coverage: readonly number[];
  /** Ticks spent in each covered cell, parallel to `coverage`. */
  readonly occupancy: readonly number[];
  readonly maxConcurrentBalls: number;
  readonly multiballTicks: number;
  readonly locks: number;
  readonly ejects: number;
  readonly drainSites: readonly (readonly [string, number])[];
  readonly scores: readonly number[];
}

export function sweepTable(
  tableId: TableId,
  profile: Profile,
  games: number,
  ticks: number,
): TableSweep {
  const findings: Finding[] = [];
  const coverage = new Map<number, number>();
  const drainSites = new Map<string, number>();
  const scores: number[] = [];
  let completed = 0;
  let drained = 0;
  let writtenOff = 0;
  let ticksPlayed = 0;
  let maxConcurrentBalls = 0;
  let multiballTicks = 0;
  let locks = 0;
  let ejects = 0;

  for (let index = 0; index < games; index += 1) {
    const game = createGame(mapFor(tableId), { ballsPerGame: BALLS_PER_GAME });
    startGame(game);
    const input = new ScriptedInput(planFor(profile, index));
    const tracks = new Map<number, BallTrack>();
    const seen = new Set<number>();
    const visited = new Set<number>();
    let last = new Map<number, { x: number; y: number; level: number }>();

    for (let tick = 0; tick < ticks; tick += 1) {
      const report = runTicks(game, input, 1)[0];
      ticksPlayed += 1;
      locks += report?.locked.length ?? 0;
      ejects += report?.ejected.length ?? 0;
      const retired = new Set(report?.writtenOff ?? []);
      for (const id of report?.drained ?? []) {
        const where = last.get(id);
        if (retired.has(id)) writtenOff += 1;
        else drained += 1;
        const key = `(${where?.x},${where?.y})L${where?.level}${retired.has(id) ? " WRITE-OFF" : ""}`;
        drainSites.set(key, (drainSites.get(key) ?? 0) + 1);
        tracks.delete(id);
      }

      const state = debugSnapshot(game);
      last = new Map();
      let live = 0;
      for (const ball of state.balls) {
        if (!ball.active) continue;
        live += 1;
        last.set(ball.id, { x: ball.pixelX, y: ball.pixelY, level: ball.level });
        // A ball id is reused across balls of a game, so a track is retired
        // whenever the id goes away and rebuilt when it comes back.
        let track = tracks.get(ball.id);
        if (track === undefined) {
          track = new BallTrack(ball.id);
          tracks.set(ball.id, track);
        }
        const sample: Sample = {
          x: ball.x / 1024,
          y: ball.y / 1024,
          level: ball.level,
          held: ball.heldBy !== null,
        };
        visited.add(cellOf(sample.x, sample.y, sample.level));
        const cell = cellOf(sample.x, sample.y, sample.level);
        coverage.set(cell, (coverage.get(cell) ?? 0) + 1);
        const make = (
          kind: Finding["kind"],
          at: number,
          where: Sample,
          span: number,
          detail: string,
        ): Finding => ({
          kind,
          table: tableId,
          profile,
          game: index,
          ball: ball.id,
          tick: at,
          x: Math.round(where.x * 10) / 10,
          y: Math.round(where.y * 10) / 10,
          level: where.level,
          ticks: span,
          detail,
        });
        const dwell: Finding[] = [];
        for (const finding of track.push(tick, sample, visited, dwell, make)) {
          findings.push(finding);
        }
        for (const finding of dwell) findings.push(finding);
        seen.add(ball.id);
      }
      if (live > maxConcurrentBalls) maxConcurrentBalls = live;
      if (live > 1) multiballTicks += 1;
      if (state.phase === "game-over") break;
    }

    const end = debugSnapshot(game);
    scores.push(end.score);
    if (end.phase === "game-over" && end.ballsServed === BALLS_PER_GAME) completed += 1;
  }

  const cells = [...coverage.keys()].sort((a, b) => a - b);
  return {
    table: tableId,
    profile,
    games,
    ticks,
    completed,
    drained,
    writtenOff,
    ticksPlayed,
    findings,
    coverage: cells,
    occupancy: cells.map((cell) => coverage.get(cell) ?? 0),
    maxConcurrentBalls,
    multiballTicks,
    locks,
    ejects,
    drainSites: [...drainSites.entries()].sort((a, b) => b[1] - a[1]),
    scores: [...scores].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function summarise(sweep: TableSweep, quiet: boolean): void {
  const byKind = new Map<string, number>();
  for (const finding of sweep.findings) {
    byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
  }
  const kinds =
    byKind.size === 0
      ? "none"
      : [...byKind.entries()].map(([kind, count]) => `${kind} ${count}`).join(", ");
  console.log(
    `${sweep.table.padStart(15)} ${sweep.profile.padEnd(10)} ` +
      `games ${sweep.completed}/${sweep.games}  ends ${sweep.drained + sweep.writtenOff} ` +
      `(${sweep.writtenOff} written off)  ticks ${sweep.ticksPlayed.toLocaleString()}  ` +
      `cells ${sweep.coverage.length}  maxballs ${sweep.maxConcurrentBalls}  ` +
      `locks ${sweep.locks}/ejects ${sweep.ejects}  findings: ${kinds}`,
  );
  if (quiet) return;
  // One line per DISTINCT site, so a hundred hits on one crack read as one.
  const sites = new Map<string, { count: number; sample: Finding }>();
  for (const finding of sweep.findings) {
    const key = `${finding.kind}@${Math.round(finding.x / 4)},${Math.round(finding.y / 4)}L${finding.level}`;
    const seen = sites.get(key);
    if (seen === undefined) sites.set(key, { count: 1, sample: finding });
    else seen.count += 1;
  }
  for (const [, { count, sample }] of [...sites.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      `${" ".repeat(17)}${sample.kind.toUpperCase().padEnd(12)} x${String(count).padEnd(4)} ` +
        `(${sample.x},${sample.y})L${sample.level} game ${sample.game} ball ${sample.ball} ` +
        `tick ${sample.tick} — ${sample.detail}`,
    );
  }
}

function compare(now: readonly TableSweep[], before: readonly TableSweep[]): void {
  console.log("");
  console.log("=== COVERAGE vs CONTROL ===");
  for (const sweep of now) {
    const control = before.find(
      (one) => one.table === sweep.table && one.profile === sweep.profile,
    );
    if (control === undefined) continue;
    const mine = new Set(sweep.coverage);
    const theirs = new Set(control.coverage);
    const lost = [...theirs].filter((cell) => !mine.has(cell));
    const gained = [...mine].filter((cell) => !theirs.has(cell));
    console.log(
      `${sweep.table.padStart(15)} ${sweep.profile.padEnd(10)} ` +
        `cells ${control.coverage.length} -> ${sweep.coverage.length}  ` +
        `LOST ${lost.length}  gained ${gained.length}`,
    );
    // Lost cells matter most: somewhere the ball used to reach and no longer
    // does. Print them grouped so a lost REGION reads as a region.
    const heavy = lost
      .map((cell) => [cell, control.occupancy[control.coverage.indexOf(cell)] ?? 0] as const)
      .sort((a, b) => b[1] - a[1]);
    for (const [cell, ticks] of heavy.slice(0, 14)) {
      console.log(`${" ".repeat(17)}LOST ${describeCell(cell)} (control spent ${ticks} ticks there)`);
    }
    if (heavy.length > 14) console.log(`${" ".repeat(17)}... and ${heavy.length - 14} more`);
  }
}

// ---------------------------------------------------------------------------
// THE TRAP CENSUS — release a ball from rest EVERYWHERE and see what happens
// ---------------------------------------------------------------------------

/**
 * The playing sweep above is a sample: it goes where its ninety players happen
 * to send the ball, and a pocket nothing ever rolls into is a pocket it never
 * finds. This is the exhaustive complement. It puts a ball at rest on EVERY
 * free centre of a grid over the whole 336x600 playfield, on BOTH collision
 * lines, gives it gravity and nothing else, and asks one question: did it get
 * to the drain?
 *
 * Nothing but gravity, deliberately. No flippers, no devices, no nudge, no ramp
 * kicks from a player — so what it measures is a property of the MAP, the
 * responder and the integrator together, which is exactly the triple that
 * `78bed65` changed. A start that never reaches the drain is a place the table
 * will not give the ball back from without help, and the clustered final
 * positions ARE the trap sites.
 *
 * Two classes of honest non-drain exist and are reported separately rather than
 * hidden: the shooter lane (x >= 300 near the bottom, where a ball is supposed
 * to sit until it is launched) and the upper level's rails, which on a real
 * table hand the ball back through geometry the drive pushes it along.
 */
interface TrapCensus {
  readonly table: TableId;
  readonly level: number;
  readonly starts: number;
  readonly drained: number;
  readonly stranded: number;
  readonly laneSeats: number;
  /** Final resting sites of stranded balls, most populous first. */
  readonly sites: readonly (readonly [string, number])[];
  /** Of the stranded, how many came fully to rest (v = 0) rather than moving. */
  readonly atRest: number;
  /**
   * EVERY start, flattened as `[x, y, code, endX, endY, endLevel]` with code
   * 0 drained / 1 lane seat / 2 stranded.
   *
   * This is what makes a control comparison exact rather than statistical. The
   * grid and the freeness test are both properties of the MAP, which no physics
   * change can move, so two trees enumerate the same starts in the same order
   * and the diff is per-start: which releases used to reach the drain and no
   * longer do, and which now do that did not.
   */
  readonly outcomes: readonly number[];
}

/** Ticks a released ball is given to find the drain. 900 = eighteen seconds. */
const TRAP_TICKS = 900;

function trapCensus(tableId: TableId, level: 0 | 1, step: number): TrapCensus {
  const map = mapFor(tableId);
  const materials = materialTableFor(tableId);
  const view =
    level === 0 ? playfieldViewFor(map, VIRTUAL_TOP_WALL_ROWS[tableId]) : upperLevelViewFor(map);
  const forces = { gravityY: SIMULATION_GRAVITY, tiltX: 0, nudgeX: 0, nudgeY: 0 };
  // THE DRIVE AND THE SURFACE IDS ARE NOT OPTIONAL. `mapFor` registers both,
  // and `stepBalls` defaults them to null: a census run without the drive would
  // make every shallow ramp a trap by construction and every figure it printed
  // would be about a machine this project does not ship. `game-loop.ts` spreads
  // exactly these two in for the same reason.
  const options = { rampDrive: tableAccelerationFor(tableId), surfaces: tableDevicesFor(tableId) };
  const sites = new Map<string, number>();
  let starts = 0;
  let drained = 0;
  let stranded = 0;
  let laneSeats = 0;
  let atRest = 0;
  const outcomes: number[] = [];

  for (let y = 4; y < 596; y += step) {
    for (let x = 4; x < 332; x += step) {
      // Only start where the ball's own centre is legal on this line: the view
      // already carries the level's collision bit and the virtual top wall.
      if ((view.materialAt(x, y) & 1) === 1) continue;
      starts += 1;
      const set = createBallSet();
      const ball = spawnBall(set, pixelsToQ10(x), pixelsToQ10(y), 0, 0, level);
      let gone = false;
      for (let tick = 0; tick < TRAP_TICKS; tick += 1) {
        const result = stepBalls(set, map, materials, forces, options);
        if (result.drained.length > 0) {
          gone = true;
          break;
        }
      }
      const endX = Math.round(ball.x / 1024);
      const endY = Math.round(ball.y / 1024);
      if (gone) {
        drained += 1;
        outcomes.push(x, y, 0, endX, endY, ball.level);
        continue;
      }
      if (endX >= LANE_MIN_X && endY >= LANE_MIN_Y) {
        laneSeats += 1;
        outcomes.push(x, y, 1, endX, endY, ball.level);
        continue;
      }
      outcomes.push(x, y, 2, endX, endY, ball.level);
      stranded += 1;
      if (ball.velocityX === 0 && ball.velocityY === 0) atRest += 1;
      // Sites are quantised to 4 px: one pocket is one site however many
      // sub-pixel resting points it has.
      const key = `(${(endX >> 2) << 2},${(endY >> 2) << 2})L${ball.level}`;
      sites.set(key, (sites.get(key) ?? 0) + 1);
    }
  }
  return {
    table: tableId,
    level,
    starts,
    drained,
    stranded,
    laneSeats,
    atRest,
    outcomes,
    sites: [...sites.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/**
 * Releases ONE ball from rest at one place and prints where it goes.
 *
 * `--drop=<table>,<level>,<x>,<y>[,<ticks>]` — the same machine the trap
 * census runs, so a site the census names is walkable back to the tick that
 * made it. Gravity and the table's own drive, nothing else.
 */
function dropOne(spec: string): void {
  const [table, level, x, y, ticks] = spec.split(",");
  const tableId = table as TableId;
  const map = mapFor(tableId);
  const materials = materialTableFor(tableId);
  const forces = { gravityY: SIMULATION_GRAVITY, tiltX: 0, nudgeX: 0, nudgeY: 0 };
  const options = { rampDrive: tableAccelerationFor(tableId), surfaces: tableDevicesFor(tableId) };
  const set = createBallSet();
  const ball = spawnBall(
    set,
    pixelsToQ10(Number(x)),
    pixelsToQ10(Number(y)),
    0,
    0,
    Number(level) === 1 ? 1 : 0,
  );
  const budget = Number(ticks ?? TRAP_TICKS);
  console.log(`drop ${tableId} (${x},${y})L${level} for ${budget} ticks`);
  let stillFor = 0;
  let lastX = ball.x;
  let lastY = ball.y;
  for (let tick = 0; tick < budget; tick += 1) {
    const result = stepBalls(set, map, materials, forces, options);
    const moved = Math.abs(ball.x - lastX) + Math.abs(ball.y - lastY);
    if (tick < 40 || tick % 25 === 0 || moved === 0) {
      console.log(
        `t${String(tick).padStart(4)} (${(ball.x / 1024).toFixed(3)},${(ball.y / 1024).toFixed(3)})` +
          `L${ball.level} v=(${ball.velocityX},${ball.velocityY}) moved=${(moved / 1024).toFixed(4)}`,
      );
    }
    if (moved === 0) {
      stillFor += 1;
      if (stillFor > 3) {
        console.log(`DEAD STILL from tick ${tick - stillFor + 1}`);
        return;
      }
    } else stillFor = 0;
    lastX = ball.x;
    lastY = ball.y;
    if (result.drained.length > 0) {
      console.log(`DRAINED at tick ${tick}`);
      return;
    }
  }
  console.log(`still on the table after ${budget} ticks`);
}

/** Replays one game with the tick-by-tick ball state printed. */
function trace(spec: string): void {
  const [table, profile, game, from, to] = spec.split(",");
  const first = Number(from ?? 0);
  const last = Number(to ?? 400);
  const tableId = table as TableId;
  const built = createGame(mapFor(tableId), { ballsPerGame: BALLS_PER_GAME });
  startGame(built);
  const input = new ScriptedInput(planFor((profile ?? "aggressive") as Profile, Number(game ?? 0)));
  console.log(`trace ${tableId} ${profile} game ${game} ticks ${first}..${last}`);
  for (let tick = 0; tick <= last; tick += 1) {
    const report = runTicks(built, input, 1)[0];
    const state = debugSnapshot(built);
    if (tick >= first) {
      for (const ball of state.balls) {
        if (!ball.active) continue;
        console.log(
          `t${String(tick).padStart(6)} ball ${ball.id} ` +
            `(${(ball.x / 1024).toFixed(3)},${(ball.y / 1024).toFixed(3)})L${ball.level} ` +
            `v=(${ball.velocityX},${ball.velocityY}) held=${ball.heldBy ?? "-"} ` +
            `flip=[${state.flippers.map((f) => f.stroke).join(",")}] ` +
            `${(report?.drained.length ?? 0) > 0 ? "DRAIN" : ""}`,
        );
      }
    }
    if (state.phase === "game-over") {
      console.log(`game over at tick ${tick}`);
      break;
    }
  }
}

function main(argv: readonly string[]): number {
  const wanted = argv.filter((arg) => !arg.startsWith("-"));
  const flag = (name: string): string | undefined => {
    const found = argv.find((arg) => arg.startsWith(`--${name}=`));
    return found === undefined ? undefined : found.slice(name.length + 3);
  };
  const games = Number(flag("games") ?? DEFAULT_GAMES);
  const ticks = Number(flag("ticks") ?? DEFAULT_TICKS);
  const quiet = argv.includes("--quiet");
  const profiles = (flag("profiles") ?? PROFILES.join(",")).split(",") as Profile[];
  const tables = wanted.length > 0 ? (wanted as TableId[]) : [...TABLE_IDS];
  const jsonPath = flag("json");
  const comparePath = flag("compare");
  const tracePath = flag("trace");
  if (tracePath !== undefined) {
    trace(tracePath);
    return 0;
  }
  const dropSpec = flag("drop");
  if (dropSpec !== undefined) {
    dropOne(dropSpec);
    return 0;
  }
  const trapStep = flag("traps");
  if (trapStep !== undefined) {
    const step = Number(trapStep === "" ? 3 : trapStep);
    console.log(`trap census: every ${step} px, ${TRAP_TICKS} ticks, gravity only`);
    const all: TrapCensus[] = [];
    for (const tableId of tables) {
      for (const level of [0, 1] as const) {
        const census = trapCensus(tableId, level, step);
        all.push(census);
        console.log(
          `${tableId.padStart(15)} L${level}  starts ${census.starts}  ` +
            `drained ${census.drained} (${((census.drained / census.starts) * 100).toFixed(1)}%)  ` +
            `lane ${census.laneSeats}  STRANDED ${census.stranded} ` +
            `(${census.atRest} fully at rest)  sites ${census.sites.length}`,
        );
        for (const [site, count] of census.sites.slice(0, 12)) {
          console.log(`${" ".repeat(17)}${site} x${count}`);
        }
      }
    }
    if (jsonPath !== undefined) {
      writeFileSync(jsonPath, JSON.stringify(all), "utf8");
      console.log(`wrote ${jsonPath}`);
    }
    return 0;
  }

  console.log(
    `pathology sweep: ${games} games x ${ticks.toLocaleString()} ticks, ` +
      `profiles ${profiles.join("/")}, window ${WINDOW}`,
  );
  const sweeps: TableSweep[] = [];
  for (const tableId of tables) {
    for (const profile of profiles) {
      const sweep = sweepTable(tableId, profile, games, ticks);
      sweeps.push(sweep);
      summarise(sweep, quiet);
    }
  }
  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, JSON.stringify(sweeps), "utf8");
    console.log(`wrote ${jsonPath}`);
  }
  if (comparePath !== undefined) {
    compare(sweeps, JSON.parse(readFileSync(comparePath, "utf8")) as TableSweep[]);
  }
  const total = sweeps.reduce((sum, sweep) => sum + sweep.findings.length, 0);
  console.log(`\n${total} findings across ${sweeps.length} table/profile sweeps`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
