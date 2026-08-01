#!/usr/bin/env node
// The AGGRESSIVE-player ball-end census.
//
// `tests/plays.test.ts` runs a *considerate* player: one swing per approach,
// and only when a ball is coming down at the bats. That player is the one whose
// games must always terminate, so it is the one the suite gates on. It is not
// the worst case, and the difference matters: an aggressive player keeps the
// ball alive 60-115% longer and therefore visits far more of the playfield,
// which is how the two deterministic traps this project has already fixed were
// found in the first place. Every one of them was invisible to the considerate
// census.
//
// So this is the harness that finds strand sites. It is deliberately NOT a test:
// it takes minutes, it is a measurement rather than a contract, and pinning its
// exact numbers would turn a survey instrument into a change detector. The
// contracts it feeds live in tests/plays.test.ts.
//
// The player:
//   - taps both bats for 3 ticks on a fixed 17..30 tick cadence, cycling
//     through the whole cadence range so no single beat frequency is special;
//   - plunges at every integer hold from 8 to 97 — 90 games a table, 3 balls a
//     game, 270 ball ends a table;
//   - nudges left every 700 ticks, as the considerate census does.
//
// A ball end is a DRAIN if the ball was on the bottom rows when it went, and a
// WRITE-OFF otherwise — the ball search retiring a ball the playfield stopped
// giving back. Write-offs are reported per site, because a site is a place on
// the table and that is what gets fixed.
//
// Usage:  npx vite-node scripts/aggressive-census.mts [-- [--ticks=N] <tableId> ...]

import { readFileSync } from "node:fs";
import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { parseTableAccelDocument, registerTableAcceleration } from "../src/game/table-accel.js";
import { parseTableDevicesDocument, registerTableDevices } from "../src/game/table-devices.js";
import { parseTableModesDocument, registerTableModes } from "../src/game/table-modes.js";
import type {
  TableAccelDocument,
  TableDevicesDocument,
  TableId,
  TableMapDocument,
  TableModesDocument,
} from "../src/game/contracts.js";

/**
 * Ticks a census game is given. Forty thousand, thirteen minutes of play at
 * 50 Hz, and it was twenty thousand until multiball arrived.
 *
 * That change is a measurement, not a convenience. At 20,000 ticks Extreme
 * Sports scored 88/90 and reported two "stalls" — pull 8 with the ball at
 * (56,327) and pull 9 at (205,486), both mid-third-ball. Re-running the SAME
 * code at 40,000 gives 90/90 with the write-off rate unchanged at 1.1% and the
 * same three sites, so nothing was stuck: the games were simply still being
 * played when the clock ran out. Balls that get locked and given back keep the
 * ball in play longer, and the ball counts moved with it — Law 'n Justice from
 * 270 ball ends to 290 and BabeWatch from 270 to 311 — so a budget tuned to a
 * game without multiball now cuts games off in the middle.
 *
 * A stall reported here therefore means what it says again: the playfield
 * stopped giving the ball back.
 *
 * OVERRIDABLE with `--ticks=N`, and that is not a convenience either. A
 * write-off RATE is only comparable against another rate measured over the same
 * budget: a longer game visits more of the table and ends more balls, so the
 * same absolute number of strands reads as a smaller fraction. Two figures from
 * different budgets are two different measurements, and the census now says
 * which budget produced the one it printed.
 */
const DEFAULT_CENSUS_TICKS = 40_000;
const BALLS_PER_GAME = 3;
/** Plunge holds swept, inclusive. 90 games a table. */
const FIRST_PULL = 8;
const LAST_PULL = 97;
/** Bat cadence range, cycled per game so no single beat frequency is special. */
const MIN_CADENCE = 17;
const MAX_CADENCE = 30;
/** Ticks the bats are held on each tap. */
const TAP_TICKS = 3;
/** Ticks added to the pull when a plunge hands the ball straight back. */
const PULL_HARDER_TICKS = 4;

/**
 * The map, with the table's ramp drive AND scoring layer registered as side
 * effects. `createGame` requires the drive and throws without it (see
 * src/game/table-accel.ts); the scoring layer carries the surface-id map the
 * contact model reads its restitution and its bumper kicks out of, so a census
 * run without it would be measuring a different machine. The mission layer is
 * loaded for the same reason: it fires the multiball opcode and takes balls off
 * the table, so a census without it is not measuring the shipped machine.
 */
function mapFor(tableId: TableId) {
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

export interface CensusResult {
  readonly tableId: TableId;
  /** Ticks each game was given. A rate is only comparable at an equal budget. */
  readonly censusTicks: number;
  readonly games: number;
  readonly completed: number;
  readonly drained: number;
  readonly writtenOff: number;
  readonly sites: readonly (readonly [string, number])[];
  readonly stalls: readonly string[];
}

export function aggressiveCensus(
  tableId: TableId,
  censusTicks: number = DEFAULT_CENSUS_TICKS,
): CensusResult {
  let drained = 0;
  let writtenOff = 0;
  let completed = 0;
  let games = 0;
  const sites = new Map<string, number>();
  const stalls: string[] = [];

  for (let hold = FIRST_PULL; hold <= LAST_PULL; hold += 1) {
    games += 1;
    const cadence = MIN_CADENCE + ((hold - FIRST_PULL) % (MAX_CADENCE - MIN_CADENCE + 1));
    const game = createGame(mapFor(tableId), { ballsPerGame: BALLS_PER_GAME });
    startGame(game);

    let pull = hold;
    let inFlight = false;
    const input = new ScriptedInput((tick) => {
      const controls: Control[] = [];
      const phase = tick % 400;
      if (phase >= 40 && phase < 40 + pull) controls.push("plunger");
      // The aggressive part: the bats fire on their own beat, not the ball's.
      if (tick % cadence < TAP_TICKS) controls.push("leftFlipper", "rightFlipper");
      if (tick > 0 && tick % 700 < 3) controls.push("nudgeLeft");
      return controls;
    });

    let last = new Map<number, { x: number; y: number; level: number }>();
    for (let tick = 0; tick < censusTicks; tick += 1) {
      const report = runTicks(game, input, 1)[0];
      const retired = new Set(report?.writtenOff ?? []);
      for (const id of report?.drained ?? []) {
        const seen = last.get(id);
        // Asked, not inferred from the ball's last row: at the measured gravity
        // a ball crossing the drain line is last sampled at y=586..589, and the
        // old `y >= 590` test counted twelve ordinary drains a table as
        // strandings. See GameTickReport.writtenOff.
        if (!retired.has(id)) drained += 1;
        else {
          writtenOff += 1;
          const key = `(${seen?.x},${seen?.y})L${seen?.level}`;
          sites.set(key, (sites.get(key) ?? 0) + 1);
        }
      }
      last = new Map();
      const state = debugSnapshot(game);

      if (report?.launched === true) inFlight = true;
      else if (inFlight && state.laneBallId !== null) {
        pull += PULL_HARDER_TICKS;
        inFlight = false;
      }
      if (report?.served === true) {
        pull = hold;
        inFlight = false;
      }
      for (const ball of state.balls) {
        if (!ball.active) continue;
        last.set(ball.id, { x: ball.pixelX, y: ball.pixelY, level: ball.level });
      }
      if (state.phase === "game-over") break;
    }

    const end = debugSnapshot(game);
    if (end.phase === "game-over" && end.ballsServed === BALLS_PER_GAME) completed += 1;
    else {
      const ball = end.balls.find((one) => one.active);
      stalls.push(
        `pull ${hold}: ${end.ballsServed} balls served, ball left at ` +
          (ball === undefined ? "nowhere" : `(${ball.pixelX},${ball.pixelY}) on level ${ball.level}`),
      );
    }
  }

  return {
    tableId,
    censusTicks,
    games,
    completed,
    drained,
    writtenOff,
    stalls,
    sites: [...sites.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function main(argv: readonly string[]): number {
  const wanted = argv.filter((arg) => !arg.startsWith("-"));
  const ticksArg = argv.find((arg) => arg.startsWith("--ticks="));
  const censusTicks = ticksArg === undefined ? DEFAULT_CENSUS_TICKS : Number(ticksArg.slice(8));
  if (!Number.isInteger(censusTicks) || censusTicks < 1) {
    console.error(`--ticks must be a positive whole number, got ${ticksArg}`);
    return 1;
  }
  const tables = wanted.length > 0 ? (wanted as TableId[]) : [...TABLE_IDS];
  let worst = 0;
  console.log(`tick budget ${censusTicks.toLocaleString()} per game`);
  for (const tableId of tables) {
    const result = aggressiveCensus(tableId, censusTicks);
    const ends = result.drained + result.writtenOff;
    const rate = ends === 0 ? 0 : result.writtenOff / ends;
    worst = Math.max(worst, rate);
    console.log(
      `${tableId.padStart(15)}  completed ${result.completed}/${result.games}  ` +
        `ends ${ends}  drained ${result.drained}  written off ${result.writtenOff} ` +
        `(${(rate * 100).toFixed(1)}%)  @${result.censusTicks} ticks`,
    );
    for (const [site, count] of result.sites.slice(0, 8)) {
      console.log(`${" ".repeat(17)}${site} x${count}  (${((count / ends) * 100).toFixed(1)}% of ends)`);
    }
    for (const stall of result.stalls) console.log(`${" ".repeat(17)}STALL ${stall}`);
  }
  console.log(`worst write-off rate ${(worst * 100).toFixed(1)}% at ${censusTicks} ticks per game`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
