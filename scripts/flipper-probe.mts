// THE FLIPPER PROBE — the bat behaviours a player actually complains about.
//
// The two defects this project has been told about by the person playing it are
// both flipper defects: "the ball goes through the flippers when flipping", and
// "if you let the ball roll near the end of the flipper and then flip, the ball
// goes under the flipper instead of shooting up". Neither is visible to a
// census, to the per-frame RAM gate, or to the film gate. Both are visible here.
//
// Four scenarios, run against the REAL loop (`createGame` / `runTicks` /
// `ScriptedInput`) with the ball placed by hand and nothing else touched, so
// what is measured is the shipped machine and not a model of it:
//
//   ROLL   ball set down on the resting bat, allowed to roll toward the tip for
//          k ticks, then flipped. The operator's report, parameterised by k.
//   DROP   ball falling onto the bat at speed, flipped as it arrives. The
//          "through the flippers while flipping" report.
//   HOLD   ball placed on the RAISED bat and left there. Cradle, and the place
//          the resting-ball position constraint would show if it were wrong.
//   GAP    ball dropped straight down the whole width of the bat pair, bats up
//          and bats down. Nothing may end up under a raised bat.
//
// OUTCOMES are read from geometry alone — where the ball is relative to the
// bat's own axis at that tick — so this needs no instrumentation hook and
// survives any refactor of the responder:
//
//   STRUCK        left the bat moving UP, which is what a flipper is for
//   PASSED_UNDER  crossed from the top face to the underside: THE DEFECT
//   CARRIED       still on the blade at the end of the window
//   MISSED        never came within contact range of the bat at all
//
// Usage:
//   npx vite-node scripts/flipper-probe.mts -- [--json=PATH] [--quiet] [tableId ...]

import { readFileSync, writeFileSync } from "node:fs";
import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { Game, InputSource } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { parseTableAccelDocument, registerTableAcceleration } from "../src/game/table-accel.js";
import { parseTableDevicesDocument, registerTableDevices } from "../src/game/table-devices.js";
import { parseTableModesDocument, registerTableModes } from "../src/game/table-modes.js";
import { parseFlipperBatsDocument, registerFlipperBats } from "../src/game/flipper-bats.js";
import { batRadiusAt, flipperAngle, flipperConfigsFor } from "../src/game/flippers.js";
import type { FlipperConfig } from "../src/game/flippers.js";
import { BALL_RADIUS_PIXELS, cosineUnits, sineUnits } from "../src/game/collision-probe.js";
import { Q10_ONE, pixelsToQ10, q10Multiply } from "../src/core/fixed-point.js";
import type {
  FlipperBatsDocument,
  TableAccelDocument,
  TableDevicesDocument,
  TableId,
  TableMapDocument,
  TableModesDocument,
} from "../src/game/contracts.js";

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
// Bat-relative geometry
// ---------------------------------------------------------------------------

/**
 * Where the ball is in the BAT's frame: distance along the blade from the
 * pivot, and signed distance off the blade axis with + on the top face.
 *
 * The normal is chosen as the perpendicular pointing UP the table, which is
 * unambiguous for every bat on all three tables — no lower bat rests within 30
 * degrees of vertical — and means one sign convention serves left bats and
 * right bats alike without a per-bat table to get wrong.
 */
function batAxes(config: FlipperConfig, stroke: number): {
  readonly axisX: number;
  readonly axisY: number;
  readonly normalX: number;
  readonly normalY: number;
} {
  const angle = flipperAngle(config, { stroke, rate: 0 });
  const axisX = cosineUnits(angle);
  const axisY = sineUnits(angle);
  // Of the two perpendiculars, the one pointing UP the table (negative y).
  // `axisX` decides it and never reaches zero: a lower bat's axis runs from 30
  // to -24 degrees on the left and 150 to 204 on the right, so its x component
  // keeps its sign across the whole stroke on every bat of all three tables.
  const up = axisX > 0;
  return {
    axisX,
    axisY,
    normalX: up ? axisY : -axisY,
    normalY: up ? -axisX : axisX,
  };
}

function batFrame(
  config: FlipperConfig,
  stroke: number,
  ballX: number,
  ballY: number,
): { readonly along: number; readonly perp: number } {
  const { axisX, axisY, normalX, normalY } = batAxes(config, stroke);
  const dx = ballX - config.pivotX;
  const dy = ballY - config.pivotY;
  return {
    along: (q10Multiply(dx, axisX) + q10Multiply(dy, axisY)) / Q10_ONE,
    perp: (q10Multiply(dx, normalX) + q10Multiply(dy, normalY)) / Q10_ONE,
  };
}

/** A resting place on the bat's top face: `along` px out, just clear of it. */
function seatOn(
  config: FlipperConfig,
  stroke: number,
  alongPx: number,
): { readonly x: number; readonly y: number } {
  const { axisX, axisY, normalX, normalY } = batAxes(config, stroke);
  const alongQ = pixelsToQ10(alongPx);
  const clear = batRadiusAt(config, alongQ) + pixelsToQ10(BALL_RADIUS_PIXELS + 1);
  return {
    x: (config.pivotX + q10Multiply(alongQ, axisX) + q10Multiply(clear, normalX)) | 0,
    y: (config.pivotY + q10Multiply(alongQ, axisY) + q10Multiply(clear, normalY)) | 0,
  };
}

const BAT_CONTROL: Readonly<Record<string, Control>> = {
  "lower-left": "leftFlipper",
  "lower-right": "rightFlipper",
  upper: "upperFlipper",
};

/**
 * Runs the loop until the serve has actually put a ball on the table.
 *
 * `startGame` only OWES a ball; the trough, the countdown and the chute all
 * take ticks, and a probe that places its ball before the serve has landed is
 * racing the machine — the project has an explicit note about exactly this
 * ("a port probe must let the served ball SETTLE before plunging or it invents
 * a defect"). Sixty ticks is more than twice the longest observed serve.
 */
function servedGame(tableId: TableId): Game {
  const game = createGame(mapFor(tableId), { ballsPerGame: 3 });
  startGame(game);
  const idle = new ScriptedInput(() => []);
  for (let tick = 0; tick < 400; tick += 1) {
    runTicks(game, idle, 1);
    const ball = game.balls.balls.find((one) => one.active);
    // Wait for it to be BOTH served and settled on the lane seat, so the
    // starting velocity a scenario asks for is the only velocity it has.
    if (ball !== undefined && ball.velocityX === 0 && ball.velocityY === 0 && tick > 4) return game;
  }
  throw new Error(`${tableId}: the serve never settled`);
}

/** Puts the game's one ball exactly here, in play, and nowhere else. */
function place(game: Game, x: number, y: number, vx: number, vy: number, level: 0 | 1): void {
  const balls = game.balls.balls;
  if (balls.length === 0) throw new Error("no ball to place: the serve never landed");
  for (let i = 1; i < balls.length; i += 1) balls[i]!.active = false;
  const ball = balls[0]!;
  ball.x = x;
  ball.y = y;
  ball.velocityX = vx;
  ball.velocityY = vy;
  ball.active = true;
  ball.heldBy = null;
  ball.level = level;
}

type Outcome = "STRUCK" | "PASSED_UNDER" | "CARRIED" | "MISSED" | "DRAINED";

interface Trial {
  readonly outcome: Outcome;
  /** `along` when the button went down, px from the pivot. */
  readonly alongAtPress: number;
  /** Highest upward speed the ball reached in the window, Q10 per tick. */
  readonly launchSpeed: number;
  /** Lowest `perp` reached while the bat was raised: negative means underside. */
  readonly minPerp: number;
}

/**
 * Runs one trial: place the ball, wait `settle` ticks, press the bat's button
 * for `hold`, and watch for `window` ticks.
 */
function trial(
  tableId: TableId,
  config: FlipperConfig,
  start: { x: number; y: number; vx: number; vy: number },
  settle: number,
  hold: number,
  windowTicks: number,
): Trial {
  const game = servedGame(tableId);
  const control = BAT_CONTROL[config.id] ?? "leftFlipper";
  const input = new ScriptedInput((tick) =>
    tick >= settle && tick < settle + hold ? [control] : [],
  );
  // ON THE BAT'S OWN COLLISION LINE. `resolveFlipperContacts` skips a bat whose
  // level differs from the ball's, and BabeWatch's (205,115) and Extreme Sports'
  // (182,194) upper bats are level-1 bats sitting over level-0 playfield. A
  // probe that put its ball on level 0 watched it fall straight through them and
  // called that a defect; the ball has to be on the line the bat collides on.
  place(game, start.x, start.y, start.vx, start.vy, config.level);

  let alongAtPress = 0;
  let launchSpeed = 0;
  let minPerp = Number.POSITIVE_INFINITY;
  let touched = false;
  let wasAbove = false;
  let passedUnder = false;
  let drained = false;

  for (let tick = 0; tick < settle + windowTicks; tick += 1) {
    const report = runTicks(game, input, 1)[0];
    if ((report?.drained.length ?? 0) > 0) {
      drained = true;
      break;
    }
    const state = debugSnapshot(game);
    const ball = state.balls.find((one) => one.active);
    if (ball === undefined) break;
    const stroke = state.flippers.find((one) => one.id === config.id)?.stroke ?? 0;
    const frame = batFrame(config, stroke, ball.x, ball.y);
    if (tick === settle) alongAtPress = frame.along;
    const reach = batRadiusAt(config, pixelsToQ10(Math.max(0, frame.along))) / Q10_ONE + 9;
    // ON THE BLADE means between the boss and the tip. Past the tip is not the
    // blade, and a ball that falls past a raised tip has MISSED, not passed
    // under — the old research harness scored those separately for the same
    // reason. 43 px of the 44 px blade, one pixel clear of the tip cap.
    const onBlade = frame.along >= 2 && frame.along <= 43;
    if (onBlade && Math.abs(frame.perp) <= reach + 2) touched = true;
    if (onBlade) {
      // Clearly above, then clearly below, with the blade in between: a
      // grazing perp of -1 is the ball riding the edge, not passing through.
      if (frame.perp > BALL_RADIUS_PIXELS) wasAbove = true;
      if (frame.perp < -(BALL_RADIUS_PIXELS + 2) && wasAbove && tick >= settle) {
        passedUnder = true;
      }
      if (tick >= settle) minPerp = Math.min(minPerp, frame.perp);
    }
    if (ball.velocityY < 0) launchSpeed = Math.max(launchSpeed, -ball.velocityY);
  }

  let outcome: Outcome;
  // A BALL THAT HAD ALREADY LEFT THE BLADE CANNOT PASS UNDER IT. When the
  // button goes down with the ball past the tip (`along` over the 44 px blade),
  // the flip has simply missed: the bat sweeps up behind a ball that is already
  // falling, and the ball ends below the raised blade because that is where it
  // was. The old research harness scored the same band separately — "ballistic
  // falls past the raised tip (44..52 px)" — and calling it a pass-under would
  // convict the engine of a defect the geometry cannot commit.
  const onBladeAtPress = alongAtPress <= 43;
  if (passedUnder && onBladeAtPress) outcome = "PASSED_UNDER";
  else if (launchSpeed >= 2048) outcome = "STRUCK";
  else if (drained) outcome = "DRAINED";
  else if (!touched) outcome = "MISSED";
  else outcome = "CARRIED";
  return {
    outcome,
    alongAtPress,
    launchSpeed,
    minPerp: Number.isFinite(minPerp) ? minPerp : 0,
  };
}

// ---------------------------------------------------------------------------
// The four scenarios
// ---------------------------------------------------------------------------

export interface BatReport {
  readonly table: TableId;
  readonly bat: string;
  readonly roll: Readonly<Record<string, number>>;
  readonly drop: Readonly<Record<string, number>>;
  /** Roll trials whose press found the ball on the OUTER half of the blade. */
  readonly rollOuter: Readonly<Record<string, number>>;
  /** Median launch speed of the struck roll trials, Q10 per tick. */
  readonly rollLaunchMedian: number;
  /** Cradle: `along` after 600 held ticks from each seat, and whether it left. */
  readonly holdEnd: readonly (readonly [number, number, number])[];
  readonly holdLost: number;
  /** Gap drops: how many ended under a raised bat. */
  readonly gapUnder: number;
  readonly gapDrained: number;
  readonly gapStruck: number;
}

const ROLL_SETTLES = [
  0, 4, 8, 12, 16, 20, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60,
  64, 68,
];
const ROLL_SEATS = [8, 12, 16, 20];
const DROP_ALONGS = [10, 16, 22, 28, 34, 40, 44];
const DROP_SPEEDS = [2048, 4096, 8192, 12288, 16384];
const HOLD_SEATS = [10, 16, 22, 28, 34, 40];
const HOLD_TICKS = 600;

function tally(list: readonly Outcome[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const one of list) out[one] = (out[one] ?? 0) + 1;
  return out;
}

function median(list: readonly number[]): number {
  if (list.length === 0) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

export function probeBat(tableId: TableId, config: FlipperConfig): BatReport {
  // ---- ROLL: set down on the resting bat, flipped k ticks later ----------
  const roll: Outcome[] = [];
  const rollOuter: Outcome[] = [];
  const rollLaunch: number[] = [];
  for (const seat of ROLL_SEATS) {
    const at = seatOn(config, 0, seat);
    for (const settle of ROLL_SETTLES) {
      const result = trial(tableId, config, { ...at, vx: 0, vy: 0 }, settle, 25, 90);
      // Every pass-under names itself, because a residual count is only useful
      // if the next round can reproduce the residue: `--trace=<table>,<bat>,
      // <seat>,<settle>` replays exactly this trial.
      if (result.outcome === "PASSED_UNDER") {
        console.log(
          `    UNDER ${tableId} ${config.id} seat ${seat} settle ${settle} ` +
            `along ${result.alongAtPress.toFixed(2)} minPerp ${result.minPerp.toFixed(2)}`,
        );
      }
      roll.push(result.outcome);
      if (result.alongAtPress >= 22) rollOuter.push(result.outcome);
      if (result.outcome === "STRUCK") rollLaunch.push(result.launchSpeed);
    }
  }

  // ---- DROP: falling onto the blade, flipped on arrival ------------------
  const drop: Outcome[] = [];
  for (const along of DROP_ALONGS) {
    const at = seatOn(config, 0, along);
    for (const speed of DROP_SPEEDS) {
      // Start a whole fall above the seat so the ball arrives AT the seat with
      // roughly `speed`, and press on the tick it gets there.
      const ticks = 6;
      const rise = (speed * ticks) / Q10_ONE;
      const from = { x: at.x, y: (at.y - pixelsToQ10(Math.round(rise))) | 0, vx: 0, vy: speed };
      drop.push(trial(tableId, config, from, ticks, 25, 90).outcome);
    }
  }

  // ---- HOLD: the cradle --------------------------------------------------
  const holdEnd: (readonly [number, number, number])[] = [];
  let holdLost = 0;
  for (const seat of HOLD_SEATS) {
    const game = servedGame(tableId);
    const control = BAT_CONTROL[config.id] ?? "leftFlipper";
    const input = new ScriptedInput(() => [control]);
    // Raise the bat first, THEN put the ball on the raised face: a ball placed
    // where a rising bat is about to be is a different experiment.
    runTicks(game, input, 8);
    const at = seatOn(game.flippers.configs.find((one) => one.id === config.id) ?? config, 1152, seat);
    place(game, at.x, at.y, 0, 0, config.level);
    let lost = false;
    for (let tick = 0; tick < HOLD_TICKS; tick += 1) {
      const report = runTicks(game, input, 1)[0];
      if ((report?.drained.length ?? 0) > 0) {
        lost = true;
        break;
      }
    }
    const state = debugSnapshot(game);
    const ball = state.balls.find((one) => one.active);
    const stroke = state.flippers.find((one) => one.id === config.id)?.stroke ?? 0;
    if (lost || ball === undefined) {
      holdLost += 1;
      holdEnd.push([seat, -1, -1]);
    } else {
      const frame = batFrame(config, stroke, ball.x, ball.y);
      holdEnd.push([seat, Math.round(frame.along * 10) / 10, Math.round(frame.perp * 10) / 10]);
      if (frame.along > 52 || frame.perp < -2) holdLost += 1;
    }
  }

  return {
    table: tableId,
    bat: config.id,
    roll: tally(roll),
    rollOuter: tally(rollOuter),
    drop: tally(drop),
    rollLaunchMedian: median(rollLaunch),
    holdEnd,
    holdLost,
    gapUnder: 0,
    gapDrained: 0,
    gapStruck: 0,
  };
}

/**
 * THE GAP. Balls dropped straight down across the whole width spanned by the
 * two lower bats, with the bats HELD UP, from above the pivot line.
 *
 * A ball may drain — the gap between the raised bats is the drain, and that is
 * the game working. What it may not do is end up UNDER a raised bat, which is
 * the operator's first report ("goes through the flippers when flipping") in
 * its purest form.
 */
function probeGap(tableId: TableId, configs: readonly FlipperConfig[], raised: boolean): {
  under: number;
  drained: number;
  struck: number;
  trials: number;
} {
  const lower = configs.filter((one) => one.id !== "upper");
  const left = lower[0]!;
  const right = lower[1]!;
  const minX = Math.min(left.pivotX, right.pivotX) / Q10_ONE - 10;
  const maxX = Math.max(left.pivotX, right.pivotX) / Q10_ONE + 10;
  const pivotY = Math.max(left.pivotY, right.pivotY) / Q10_ONE;
  let under = 0;
  let drained = 0;
  let struck = 0;
  let trials = 0;
  for (let x = Math.round(minX); x <= Math.round(maxX); x += 2) {
    for (const speed of [4096, 10240, 16384]) {
      trials += 1;
      const game = servedGame(tableId);
      const input = new ScriptedInput(() => (raised ? ["leftFlipper", "rightFlipper"] : []));
      if (raised) runTicks(game, input, 8);
      place(game, pixelsToQ10(x), pixelsToQ10(pivotY - 40), 0, speed, 0);
      let wentUnder = false;
      let gone = false;
      let up = false;
      // A ball is only UNDER a bat if it was OVER it first. Without that the
      // test convicts every honest miss: a ball falling down the gap outside
      // the blade is below the axis from the moment it passes the pivot line,
      // and the drain is where it is supposed to go.
      const wasAbove = new Set<string>();
      for (let tick = 0; tick < 120; tick += 1) {
        const report = runTicks(game, input, 1)[0];
        if ((report?.drained.length ?? 0) > 0) {
          gone = true;
          break;
        }
        const state = debugSnapshot(game);
        const ball = state.balls.find((one) => one.active);
        if (ball === undefined) break;
        if (ball.velocityY < -2048) up = true;
        for (const config of lower) {
          const stroke = state.flippers.find((one) => one.id === config.id)?.stroke ?? 0;
          const frame = batFrame(config, stroke, ball.x, ball.y);
          if (frame.along <= 4 || frame.along >= 44) continue;
          if (frame.perp > BALL_RADIUS_PIXELS) wasAbove.add(config.id);
          // Under the BLADE, not merely below the pivot: between the boss and
          // the tip, on the wrong side, and deeper than the bat is thick.
          if (frame.perp < -(BALL_RADIUS_PIXELS + 2) && wasAbove.has(config.id)) {
            wentUnder = true;
          }
        }
      }
      if (wentUnder) under += 1;
      else if (up) struck += 1;
      else if (gone) drained += 1;
    }
  }
  return { under, drained, struck, trials };
}

/**
 * One trial, printed tick by tick in the bat's own frame.
 *
 * `--trace=<table>,<bat>,<seat>,<settle>` — the four numbers a summary line
 * reports, so every count above is walkable back to the geometry that made it.
 */
function traceTrial(spec: string): void {
  const [table, bat, seat, settle] = spec.split(",");
  const tableId = table as TableId;
  const config = flipperConfigsFor(tableId).find((one) => one.id === bat);
  if (config === undefined) throw new Error(`no bat "${bat}" on ${tableId}`);
  const at = seatOn(config, 0, Number(seat ?? 16));
  const pressAt = Number(settle ?? 30);
  const game = servedGame(tableId);
  const control = BAT_CONTROL[config.id] ?? "leftFlipper";
  const input = new ScriptedInput((tick) =>
    tick >= pressAt && tick < pressAt + 25 ? [control] : [],
  );
  place(game, at.x, at.y, 0, 0, config.level);
  console.log(`trace ${tableId} ${config.id} seat ${seat} press at tick ${pressAt}`);
  for (let tick = 0; tick < pressAt + 60; tick += 1) {
    const report = runTicks(game, input, 1)[0];
    const state = debugSnapshot(game);
    const ball = state.balls.find((one) => one.active);
    if (ball === undefined) {
      console.log(`t${tick} no ball`);
      break;
    }
    const stroke = state.flippers.find((one) => one.id === config.id)?.stroke ?? 0;
    const frame = batFrame(config, stroke, ball.x, ball.y);
    console.log(
      `t${String(tick).padStart(4)} stroke ${String(stroke).padStart(5)} ` +
        `along ${frame.along.toFixed(2).padStart(7)} perp ${frame.perp.toFixed(2).padStart(7)} ` +
        `xy (${(ball.x / 1024).toFixed(2)},${(ball.y / 1024).toFixed(2)}) ` +
        `v (${ball.velocityX},${ball.velocityY})` +
        `${(report?.drained.length ?? 0) > 0 ? " DRAIN" : ""}`,
    );
    if ((report?.drained.length ?? 0) > 0) break;
  }
}

function main(argv: readonly string[]): number {
  const traceArg = argv.find((arg) => arg.startsWith("--trace="));
  if (traceArg !== undefined) {
    traceTrial(traceArg.slice(8));
    return 0;
  }
  const wanted = argv.filter((arg) => !arg.startsWith("-"));
  const tables = wanted.length > 0 ? (wanted as TableId[]) : [...TABLE_IDS];
  const jsonArg = argv.find((arg) => arg.startsWith("--json="));
  const reports: BatReport[] = [];
  for (const tableId of tables) {
    const configs = flipperConfigsFor(tableId);
    for (const config of configs) {
      const report = probeBat(tableId, config);
      reports.push(report);
      const show = (label: string, counts: Record<string, number>): string =>
        `${label} ${Object.entries(counts)
          .map(([key, value]) => `${key[0]}${value}`)
          .join(" ")}`;
      console.log(
        `${tableId.padStart(15)} ${config.id.padEnd(12)} ` +
          `${show("roll", report.roll)} | ${show("outer", report.rollOuter)} | ` +
          `${show("drop", report.drop)} | launch ${report.rollLaunchMedian} | ` +
          `cradle lost ${report.holdLost}/${report.holdEnd.length} ` +
          `[${report.holdEnd.map(([seat, along]) => `${seat}->${along}`).join(" ")}]`,
      );
    }
    for (const raised of [true, false]) {
      const gap = probeGap(tableId, configs, raised);
      console.log(
        `${tableId.padStart(15)} GAP bats ${raised ? "UP  " : "DOWN"}  trials ${gap.trials}  ` +
          `UNDER ${gap.under}  struck ${gap.struck}  drained ${gap.drained}`,
      );
    }
  }
  if (jsonArg !== undefined) {
    writeFileSync(jsonArg.slice(7), JSON.stringify(reports), "utf8");
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
