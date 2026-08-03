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
 * The pinned hashes, one per table, recorded at HEAD 57e6d0c (pre-HD) and
 * RE-PINNED for the ball-search stall fix (see below).
 *
 * To re-derive after an INTENDED simulation change (there should be none in an
 * HD round): run this suite, read the "actual" value out of the failure, and
 * update the constant in the same commit that moved the simulation — with the
 * move itself explained in the commit message.
 *
 * RE-PIN, ball-search stall fix: two Law 'n Justice census games stalled
 * forever because a ball wedged in the map pockets flanking the upper bat —
 * (24,304) and (41,339), level 0 — was in mask contact with the RESTING bat
 * on every tick, and any bat contact made it cradle-exempt, so `stillTicks`
 * was reset to 0 forever and the search never fired. The fix narrows the
 * cradle exemption to bats the player is DRIVING and freezes (rather than
 * resets) the clock while every free ball is in a driven bat's grip. That
 * moves `stillTicks` — a field of every per-tick snapshot hashed here — on
 * all three tables, and lets the rescue fire where it previously never
 * could, so the old hashes describe a machine with the stall in it. Verified
 * while re-pinning: with `stillTicks` excluded from the snapshot, all three
 * 4,000-tick scripted games hash identically before and after the fix — no
 * ball position, velocity, score or serve in this script's coverage moved;
 * only the stillness bookkeeping did.
 *
 * RE-PIN, overlapped contact evaluation (the BabeWatch wall-join round): the
 * sweep's bounce used to be computed from the ring at exact first touch,
 * where the hit set is only the leading edge pixels of the surface and their
 * mean tilts into the direction of travel — against the round-8 RAM
 * telemetry that tilt turned the launch guide's wall-slide into a bounce and
 * killed 4.9 px/f at the top-right wall-join where the original loses 0.35.
 * The response probe is now read one collision-pass spacing (|v|/4, whole
 * pixels, zero for a slow ball) INTO the contact along the mean bearing,
 * which is where the original's own penetrating sampler evaluates every
 * contact it resolves (main.seg00 +0x00A618 frame structure; +0x00B54E
 * leaving-gate). Every wall contact on every table can move by up to the
 * tilt of an edge set, so all three hashes moved. The gates that held:
 * census 90 games x 3 tables, 0 write-offs, 0 stalls; anomaly sweep
 * strictly cleaner than HEAD (teleport 2 -> 0, over-clamp 4 -> 1,
 * game-stalled 1 -> 0, search-pulse 1 -> 0, lock-runaway 0 -> 0); tip-flip
 * sweep pass-under 0/1122; film side-by-side byte-identical at
 * 98.4508/99.8645/99.1322.
 */
const PINNED: Record<TableId, string> = {
  "law-n-justice": "284c980c86dd3d2dc8ec82842d47bd6ae5adf020f92f5e89822079d19f9f2576",
  "babewatch": "e8e4afb0543081f6b57c6bb0e67c0fbb1f012ae57c04a650b99e256249645710",
  "extreme-sports": "a74be0c098fa34bd36f2bb96fb5e41635b1d837f70f1926e420f836b63c224f5",
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
