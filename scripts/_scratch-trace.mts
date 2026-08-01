// Scratch: trace the path of a ball that ends up written off in the left strip.
import { readFileSync } from "node:fs";
import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { parseTableAccelDocument, registerTableAcceleration } from "../src/game/table-accel.js";
import type { TableAccelDocument, TableId, TableMapDocument } from "../src/game/contracts.js";

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

const CENSUS_TICKS = 40_000;
for (let hold = 8; hold <= 97; hold += 1) {
  const cadence = 17 + ((hold - 8) % 14);
  const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
  startGame(game);
  let pull = hold;
  let inFlight = false;
  const input = new ScriptedInput((tick) => {
    const controls: Control[] = [];
    const phase = tick % 400;
    if (phase >= 40 && phase < 40 + pull) controls.push("plunger");
    if (tick % cadence < 3) controls.push("leftFlipper", "rightFlipper");
    if (tick > 0 && tick % 700 < 3) controls.push("nudgeLeft");
    return controls;
  });

  // history per ball: last 4000 samples of (tick,x,y,level)
  const history = new Map<number, { t: number; x: number; y: number; l: number }[]>();
  let last = new Map<number, { x: number; y: number; level: number }>();
  let found = false;
  for (let tick = 0; tick < CENSUS_TICKS && !found; tick += 1) {
    const report = runTicks(game, input, 1)[0];
    for (const id of report?.drained ?? []) {
      const seen = last.get(id);
      if ((seen?.y ?? -1) < 590 && (seen?.y ?? 0) > 340 && (seen?.x ?? 999) < 30) {
        const h = history.get(id) ?? [];
        console.log(`hold ${hold} ball ${id} written off at (${seen?.x},${seen?.y})`);
        // print the path, thinned: only when the pixel changes by >=3
        let px = -99;
        let py = -99;
        for (const p of h) {
          if (Math.abs(p.x - px) + Math.abs(p.y - py) < 6) continue;
          px = p.x;
          py = p.y;
          console.log(`   t=${p.t} (${p.x},${p.y}) L${p.l}`);
        }
        found = true;
      }
    }
    last = new Map();
    const state = debugSnapshot(game);
    if (report?.launched === true) inFlight = true;
    else if (inFlight && state.laneBallId !== null) {
      pull += 4;
      inFlight = false;
    }
    if (report?.served === true) {
      pull = hold;
      inFlight = false;
    }
    for (const ball of state.balls) {
      if (!ball.active) continue;
      last.set(ball.id, { x: ball.pixelX, y: ball.pixelY, level: ball.level });
      const h = history.get(ball.id) ?? [];
      h.push({ t: tick, x: ball.pixelX, y: ball.pixelY, l: ball.level });
      if (h.length > 4000) h.shift();
      history.set(ball.id, h);
    }
    if (state.phase === "game-over") break;
  }
  if (found) break;
}
