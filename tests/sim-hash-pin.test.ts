/**
 * THE SIMULATION MOVES ONLY WHEN A ROUND MEANS IT TO. This file is the proof.
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
 *
 * RE-PIN, THE SERVE ENTROPY (the trough round): the serve was a teleport onto
 * the lane seat followed by a per-tick pin that held the ball there at rest.
 * The machine has neither. main.seg00 $3E36 puts a ball back in the TROUGH at
 * x=(oldx&7)+284, y=(oldy&7)+510, v=512+(oldv&255) in both axes, on the upper
 * collision line, and the ball rolls down the return chute into the lane on its
 * own; the low bits it carries are the last drained ball's. So every serve now
 * starts from a different pixel, arrives 41 to 212 ticks later instead of on the
 * tick it was served, and comes to rest wherever the lane leaves it — 75
 * distinct rest states on BabeWatch over 2,000 sampled records, against ONE
 * before. Every tick of every table moves; three hashes move with them.
 *
 * `troughRecord` is in the snapshot for this reason, so the pin covers the
 * carried entropy itself and not merely its consequences.
 *
 * The gates that held, measured against fb15432 with one driver run on both
 * trees: census 90 games x 3 tables at 12,000 ticks, 90/90 completed and 270
 * real drains on every table on BOTH trees, and every anomaly detector zero on
 * both (write-offs, swallowed, search pulses, teleport, over-clamp, penetration,
 * wall-crawl, award-burst, lock-runaway, stalls). Distinct census scores widen
 * 1 -> 4 (LnJ), 1 -> 22 (BW), 8 -> 13 (ES). Tip-flip sweep byte-identical to
 * HEAD, pass-under 0/1122. Film side-by-side unchanged at
 * 98.4508/99.8645/99.1322 with byte-identical rasters.
 *
 * RE-PIN, THE BAT JOINS THE RESPONDER (the Law 'n Justice chain round): a bat
 * contact used to be answered by a SECOND contact model. It took its restitution
 * from the flipper row of the 256-entry surface table (through `FLIPPER_SURFACE`)
 * but its tangential loss from this port's own Coulomb rule, and it never saw
 * the row's `$34` graze gate at all. The machine has one responder: the bat's
 * mask blit at main.seg00 +0x00B2A2 and the map's at +0x00B4B0 leave the same
 * 68-byte buffer for the same ring evaluator at +0x00A9C4, and the four words at
 * `$34/$36/$38/$3A` were loaded by `movem.w (a0,d2.w*8),d3-d6` at +0x00AE14 from
 * the surface id under the contact BEFORE the id was even range-checked. For a
 * bat that id is 1..4 — id n selects record slot n-1 (`adda.w #0/$1FA/$3F4/$5EE`
 * at +0xAE80/86/90/9A) — and every shipped surface map PAINTS each bat's swept
 * footprint with its own id over empty collision layer, which is how the id was
 * confirmed per bat rather than assumed (`tests/flippers.test.ts` re-derives all
 * nine). So `flippers.ts` now hands `reflectVelocity` that row.
 *
 * What moved: the tangential toll at a bat. Coulomb charged `friction *
 * normalImpulse` — 36% of the along-face speed at the Law 'n Justice apron
 * contact this was measured on — where the row's `$3A` = 12800 charges
 * `tangent * 160 / $3A` = 1.25% plus the fixed per-contact decay. The NORMAL
 * channel is unchanged: both rules take 115/256 of it. Measured on that contact,
 * a ball arriving on the resting left bat at (2.53,12.45) px/tick left it at
 * (6.69,-1.53) and now leaves at (9.48,2.38), against the film's own measured
 * (10.0-11.5, 2.5-3.5) eastbound roll. Every bat contact on every table moves,
 * so all three hashes move.
 *
 * The gates, measured on both trees with one driver: census 90 games x 3 tables
 * at 12,000 ticks, 90/90 completed everywhere on both; LnJ write-offs 3 -> 0
 * (the (24,304) upper-bat pocket is gone), ES 0 -> 2 at (238,588) — a ball
 * SPITTED on the one-pixel-thick right drain-funnel wall, which holds a ball
 * identically on HEAD (verified by placing one there on both trees) and is
 * therefore a map-geometry trap this change reaches rather than creates. Anomaly
 * sweep 80 games x 3 tables at 20,000: write-offs, swallowed, search pulses,
 * award-burst, award-sub-debounce, kicker-runaway and pinch-orbit all zero on
 * both trees; teleport 3 -> 3 and over-clamp 2 -> 5 across the three tables, all
 * of them the resolver's whole-pixel `separate()` push at a bat rather than a
 * velocity step, and the same events HEAD already had on BabeWatch; one Law 'n
 * Justice game out of 240 is still rallying at 20,000 ticks (37,865,000 by
 * 60,000, ball touring the whole table, ball search never fired). Tip-flip sweep
 * pass-under 0/1044. Film side-by-side unchanged at 98.4508/99.8645/99.1322 with
 * byte-identical rasters.
 *
 * RE-PIN, THE END-OF-BALL BONUS (the bonus round): a ball used to end and the
 * accumulator behind it was thrown away — 23 Law 'n Justice mission elements
 * carry a non-zero bonus and five of the corpus pay 5,000,000, and nothing in
 * the game read a byte of it. `$5136` is now reconstructed (see `bonus.ts`), and
 * it MOVES TICKS as well as score: a ball end that is not a tilt now occupies
 * the machine while its panels run — 150 frames for "NO BONUS", 80 + 100 for a
 * bonus that pays — and the lane stays shut for the whole of it, exactly as the
 * original's state-4 handler does not return until the routine has. Every ball
 * end on every table therefore moves every tick after it, and the three hashes
 * move with them. This script drains and re-serves several times inside its
 * 4,000 ticks, so all three are covered.
 *
 * The 150 frames are `move.w #$96,d0 / jsr ([$c,a4])` at Law 'n Justice hunk 4
 * +0x2B8E, and they are FILM-MEASURED: eight uninterrupted "NO BONUS" panels
 * across three tables each lasted exactly 149 visible frames. The four filmed
 * SHORT ones are the decoded early-out at `$526C` — any key-down after the
 * 25-pass grace — which is reconstructed too, and which is why this script's
 * flipping player sees ~26-tick panels rather than 150-tick ones.
 *
 * The gates, measured on both trees with one driver: census 90 games x 3 tables
 * at 12,000 ticks, 90/90 completed on both everywhere, write-offs 0/0/2 on both,
 * the same single Extreme Sports site (238,588). Score medians moved 647,500 ->
 * 607,500 (LnJ), 912,500 -> 917,500 (BW) and 295,000 -> 325,000 (ES) — they did
 * NOT systematically rise, and the reason is measured rather than guessed: this
 * census player banks a bonus on only 5/270, 9/270 and 19/270 ball ends and
 * never once lights a multiplier, so the paid total over ninety games is
 * 2,500,000 / 1,125,000 / 235,000 and the medians are dominated by the trajectory
 * re-roll the panel's ~28 ticks per ball end causes. Anomaly sweep 80 games x 3
 * tables at 20,000 ticks in the round-5 profile mix: completed 80/80/80 and
 * drains 240/240/240 on both trees, and write-offs, swallowed, search-pulses,
 * wall-crawl, award-burst, kicker-runaway and pinch-orbit ALL ZERO on both;
 * teleport 1/0/1 and over-clamp 0/0/1 unchanged; jitter 117/65/99 -> 126/67/116
 * and award-sub-debounce 2/5/0 -> 2/4/0, both at the known cradle sites the
 * round-5 INDEX already records as parity artefacts. Tip-flip sweep
 * BYTE-IDENTICAL to HEAD, pass-under 0/1044. Film side-by-side unchanged at
 * 98.4508/99.8645/99.1322 with byte-identical rasters.
 */
const PINNED: Record<TableId, string> = {
  "law-n-justice": "6eadefa2a35b3a57cfb5b470096dc237626c082f08f7df537985cfa1dc286955",
  "babewatch": "dd969b9ddcd84edfe046ba8fd6dc2e9663f0ab150e6c3e919fb4784dfcbde2de",
  "extreme-sports": "c5e54dfbf1e35ff2def60535c00ba679ce33e1662a0e9db0cb07f9e1b06feef1",
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
