// Scratch: the aggressive census with the lock bank emptied, so multiball can
// never start. Same tick budget, same player. Isolates multiball's contribution
// to the write-off rate.
import { readFileSync } from "node:fs";
import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { parseTableAccelDocument, registerTableAcceleration } from "../src/game/table-accel.js";
import type { TableAccelDocument, TableId, TableMapDocument } from "../src/game/contracts.js";

const CENSUS_TICKS = 40_000;
const BALLS_PER_GAME = 3;
const FIRST_PULL = 8;
const LAST_PULL = 97;
const MIN_CADENCE = 17;
const MAX_CADENCE = 30;
const TAP_TICKS = 3;
const PULL_HARDER_TICKS = 4;

const ROOT = "public/generated/tables";

function mapFor(tableId: TableId) {
  registerTableAcceleration(
    parseTableAccelDocument(
      JSON.parse(readFileSync(`${ROOT}/${tableId}.accel.json`, "utf8")) as TableAccelDocument,
    ),
  );
  return parseTableMapDocument(
    JSON.parse(readFileSync(`${ROOT}/${tableId}.map.json`, "utf8")) as TableMapDocument,
  );
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

const mode = process.argv[2] ?? "nolocks";

for (const tableId of ["law-n-justice"] as TableId[]) {
  let drained = 0;
  let writtenOff = 0;
  let completed = 0;
  let games = 0;
  let multiballGames = 0;
  let msTotal = 0;
  let msDrained = 0;
  let msWrittenOff = 0;
  const sites = new Map<string, number>();
  const siteMb = new Map<string, number>();

  for (let hold = FIRST_PULL; hold <= LAST_PULL; hold += 1) {
    games += 1;
    const cadence = MIN_CADENCE + ((hold - FIRST_PULL) % (MAX_CADENCE - MIN_CADENCE + 1));
    const game = createGame(mapFor(tableId), { ballsPerGame: BALLS_PER_GAME });
    startGame(game);
    if (mode === "nolocks") (game.locks as { locks: readonly unknown[] }).locks = [];

    let pull = hold;
    let inFlight = false;
    let sawMultiball = false;
    const input = new ScriptedInput((tick) => {
      const controls: Control[] = [];
      const phase = tick % 400;
      if (phase >= 40 && phase < 40 + pull) controls.push("plunger");
      if (tick % cadence < TAP_TICKS) controls.push("leftFlipper", "rightFlipper");
      if (tick > 0 && tick % 700 < 3) controls.push("nudgeLeft");
      return controls;
    });

    let last = new Map<number, { x: number; y: number; level: number }>();
    let everMachineServed = new Set<number>();
    for (let tick = 0; tick < CENSUS_TICKS; tick += 1) {
      const owedBefore = game.pendingServes > 0;
      const report = runTicks(game, input, 1)[0];
      if (report?.served === true && owedBefore && game.laneBallId !== null) {
        everMachineServed.add(game.laneBallId);
        msTotal += 1;
      }
      if (report?.multiballStarted === true) sawMultiball = true;
      for (const id of report?.drained ?? []) {
        const seen = last.get(id);
        if ((seen?.y ?? -1) >= 590) { drained += 1; if (everMachineServed.has(id)) msDrained += 1; }
        else {
          if (everMachineServed.has(id)) msWrittenOff += 1;
          writtenOff += 1;
          const key = `(${seen?.x},${seen?.y})L${seen?.level}`;
          sites.set(key, (sites.get(key) ?? 0) + 1);
          if (everMachineServed.has(id)) siteMb.set(key, (siteMb.get(key) ?? 0) + 1);
        }
      }
      last = new Map();
      const state = debugSnapshot(game);
      if (report?.served === true && state.pendingServes >= 0) {
        // tag balls served while the machine owed the lane
      }
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
    if (sawMultiball) multiballGames += 1;
  }

  const ends = drained + writtenOff;
  console.log(
    `${mode} ${tableId} completed ${completed}/${games} multiballGames ${multiballGames} machineServed ${msTotal} (drained ${msDrained} writtenOff ${msWrittenOff}) ends ${ends} drained ${drained} writtenOff ${writtenOff} (${((writtenOff / ends) * 100).toFixed(1)}%)`,
  );
  for (const [site, n] of [...sites.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${site} x${n}  (machine-served ${siteMb.get(site) ?? 0})`);
  }
}
