/**
 * THE SIMULATION DOES NOT MOVE. This file is the proof.
 *
 * The HD pass (see `docs/` and `src/browser/hd-scale.ts`) is presentation only:
 * 4x artwork, 4x sprites, finer sprite placement, a bigger canvas. None of that
 * is allowed to change a single tick of the simulation, and "allowed" is not a
 * promise anyone has to keep by being careful — it is pinned here.
 *
 * Each constant below is the sha256 over the concatenated per-tick
 * `debugSnapshot` JSON of a 4,000-tick scripted game on the shipped table,
 * recorded at commit 57e6d0c — the tree as it stood BEFORE any HD change
 * landed. The script serves, launches, flips, and nudges through several balls,
 * so the hash covers the plunger, the flipper strokes, ball physics on all
 * levels the script reaches, drains, locks, scoring, the mission VM and the
 * camera. If any of these hashes ever changes, a change that claimed to be
 * render-only reached the simulation, and the change — not this pin — is wrong.
 *
 * The harness is deliberately the same shape as the determinism suite in
 * `game-loop.test.ts`: a `ScriptedInput` whose behaviour is a pure function of
 * the tick index, driving the real maps, the real physics and the real mode VM.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ControlSnapshot } from "../src/browser/input.js";
import { InputRouter } from "../src/browser/input.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { TableId } from "../src/game/contracts.js";
import { mapFor } from "./table-fixtures.js";

/** Ticks per table. Long enough to drain balls and re-serve several times. */
const TICKS = 4000;

/**
 * The pinned hashes, one per table, recorded at HEAD 57e6d0c (pre-HD).
 *
 * To re-derive after an INTENDED simulation change (there should be none in an
 * HD round): run this suite, read the "actual" value out of the failure, and
 * update the constant in the same commit that moved the simulation — with the
 * move itself explained in the commit message.
 */
const PINNED: Record<TableId, string> = {
  "law-n-justice": "433677999d399b650e0aecf93a57e792e124e77abe12fce4967a176053e621f7",
  "babewatch": "e97790d64fd29afc21d6cd2c959f2180e51a0536955c4065aebf2d5e3209059e",
  "extreme-sports": "cebec27268e6d422089af559fb7c2e74a5140ba5c2b5a010e623379fe1ad864e",
};

/** Same shape as the determinism harness's input: behaviour = f(tick index). */
class ScriptedInput implements InputSource {
  readonly router = new InputRouter();
  #tick = 0;

  sample(): ControlSnapshot {
    const tick = this.#tick;
    this.#tick += 1;
    // Launch whatever ball is waiting in the lane, over and over: the game
    // re-serves after every drain and each serve must be sent on its way.
    if (tick % 400 === 100) this.router.press("plunger");
    if (tick % 400 === 130) this.router.release("plunger");
    // Flip on two mutually prime periods so the strokes drift across every
    // phase of the ball's approach, and hold long enough for full sweeps.
    if (tick % 97 === 55) this.router.press("leftFlipper");
    if (tick % 97 === 75) this.router.release("leftFlipper");
    if (tick % 131 === 40) this.router.press("rightFlipper");
    if (tick % 131 === 64) this.router.release("rightFlipper");
    // Two nudges, far enough apart that the tilt warning decays between them.
    if (tick === 700) this.router.tap("nudgeLeft");
    if (tick === 2100) this.router.tap("nudgeRight");
    return this.router.sample();
  }
}

function simHash(tableId: TableId): string {
  const game = createGame(mapFor(tableId));
  startGame(game);
  const input = new ScriptedInput();
  const hash = createHash("sha256");
  for (let tick = 0; tick < TICKS; tick += 1) {
    runTicks(game, input, 1);
    hash.update(JSON.stringify(debugSnapshot(game)));
    hash.update("\n");
  }
  return hash.digest("hex");
}

describe("the simulation is byte-identical to pre-HD HEAD", () => {
  for (const tableId of Object.keys(PINNED) as TableId[]) {
    it(`${tableId}: ${TICKS} scripted ticks hash to the pinned value`, () => {
      expect(simHash(tableId)).toBe(PINNED[tableId]);
    });
  }
});
