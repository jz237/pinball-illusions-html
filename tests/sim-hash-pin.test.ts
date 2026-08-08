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
 *
 * WHAT THIS PIN DOES NOT DO. A moved hash is not a failure and an unmoved hash
 * is not a success: this is a tripwire that forces a round to STATE what it
 * changed, and the statement is what gets checked — by the physics gate
 * (`tests/physics-gate.test.ts`, the shipped tick against the original's own
 * per-frame RAM), by the census, by the tip-flip sweep, and by the film compare
 * for anything about the picture. `research/FIDELITY_DOSSIER.md` carries the
 * table of which gate proves what; read it before quoting one of them as
 * general reassurance, which is the mistake the film figures below were used to
 * make for several rounds running.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ControlSnapshot } from "../src/browser/input.js";
import { InputRouter } from "../src/browser/input.js";
import type { InputSource } from "../src/browser/game-loop.js";
import type { Game } from "../src/browser/game-loop.js";
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
 *
 * RE-PIN, THE PER-BALL FIRST-HIT RE-ARM (the first-hit round). Two of the three
 * hashes moved, and this is the one entry above where the ARGUMENT is the table
 * that did NOT move.
 *
 * WHAT CHANGED. The first/repeat split is the lamp byte, and the machine clears
 * it every ball. Three sites in main.seg00, re-read for this round straight out
 * of `research/seg_clean/main.bin.seg00.bin` (the file carries the hunk-size
 * longword, so file offset = address + 4):
 *
 *   +0x0055F0  302D 0DBE   move.w $dbe(a5),d0     ; the PLAYER index
 *   +0x0055F4  01D2        bset.b d0,(a2)         ; a2 = long at device +$04
 *              -> beq taken (bit was CLEAR) = FIRST, lea $12(a1),a3 / jsr $6b96
 *              -> fall through (bit was SET)  = REPEAT, lea $1a(a1),a3 / jsr $6bcc
 *   +0x00543A  302D 0DBE / 01D2 at +0x00543E, a2 = long at zone object +$0A,
 *              first lea $1e(a1),a3 -> $6b96, repeat lea $26(a1),a3 -> $6bcc
 *   +0x003F14  266d 2326   movea.l $2326(a5),a3   ; $3F10, the lamp-group table
 *   +0x003F5A  4210        clr.b (a0)             ; +$3F56: the WHOLE byte,
 *              all eight players, on every group-chained lamp
 *
 * `$3F10` has exactly ONE caller in the segment, the ball-start chain's
 * `4EB9 0000 3F10` at +0x0050B6 — and the EXTRA-BALL arm reaches it too: the
 * `subq.b #1,$10(a0) / move.w #$0007,$8e(a5)` at +0x005064 branches to
 * +0x0050B0, two instructions above the call. So every ball start, extra balls
 * included, re-arms every first-hit award whose flag byte hangs off a lamp
 * group. This port did that for the LAMPS and not for the SCORES; now it does
 * both (`resetScoringForNewBall`, `groupBackedFlagIds`).
 *
 * THE CONTROL. Law 'n Justice's hash is UNCHANGED, and it had to be: the
 * affected ids are Law 'n Justice devices 32..36, BabeWatch devices 32..40 and
 * zones 0-7/0-8/0-9, Extreme Sports devices 33..35 and zones 1-7/1-8/1-9, and
 * this script's Law 'n Justice window re-hits none of them across a ball
 * boundary while the other two do. A moved Law 'n Justice hash would have meant
 * something else changed as well.
 *
 * THE DIVERGENCE IS THE PREDICTED EVENT AND NOTHING ELSE. Dumping all 4,000
 * per-tick snapshots on both trees:
 *
 *   law-n-justice   0 of 4,000 ticks differ
 *   babewatch       first differing tick index 1087, ball 2, ball 1 at
 *                   (205,85) L0 — inside zone-0-7 (201..211 x 85..95), the top
 *                   lane: HEAD pays the 5,000 repeat, this tree the 50,000
 *                   first. Again at index 1887 on ball 3. Final score
 *                   525,000 -> 615,000 = +2 x 45,000.
 *   extreme-sports  first differing tick index 1028, ball 2, ball 1 at
 *                   (194,80) L1 — inside zone-1-7: HEAD pays 0, this tree
 *                   50,000. Again at index 1828 on ball 3. Final score
 *                   75,000 -> 175,000 = +2 x 50,000.
 *
 * Across all 12,000 tick-pairs the ONLY field that ever differs is `score` —
 * no ball position, velocity, level, lock, mission, bonus, phase or camera —
 * and zero ticks of BALL ONE differ on any table. The hashes move because a
 * score moved, at the tick the re-armed lane was re-entered, and nowhere else.
 *
 * THE CENSUS, 90 games x 3 tables x 40,000 ticks, aggressive player, HEAD
 * 98e166a -> this tree. Ball-1 medians and every completion and write-off
 * figure are IDENTICAL, which is the signature of a change confined to ball
 * boundaries:
 *
 *   law-n-justice   completed 90/90 -> 90/90, ends 271, drained 271,
 *                   write-offs 0 (0.0%); score median 607,500 -> 635,000,
 *                   min 0 -> 0, max 8,945,000 -> 8,945,000, zeros 3/90 -> 3/90,
 *                   distinct 77 -> 76; BALL 1 median 100,000 -> 100,000,
 *                   zeros 26/90 -> 26/90.
 *   babewatch       completed 90/90 -> 90/90, ends 270, drained 270,
 *                   write-offs 0 (0.0%); score median 917,500 -> 985,000,
 *                   min 680,000 -> 770,000, max 3,770,000 -> 3,840,000,
 *                   zeros 0/90, distinct 71 -> 71; BALL 1 median 410,000 ->
 *                   410,000, zeros 0/90 -> 0/90.
 *   extreme-sports  completed 90/90 -> 90/90, ends 270, drained 268,
 *                   write-offs 2 (0.7%) at the one known site (238,588)L0 on
 *                   both trees; score median 325,000 -> 425,000, min 65,000 ->
 *                   165,000 (+100,000 exactly: the two upper lanes re-arming on
 *                   balls 2 and 3), max 7,550,000 -> 7,700,000, zeros 0/90,
 *                   distinct 70 -> 69; BALL 1 median 92,500 -> 92,500,
 *                   zeros 0/90 -> 0/90.
 *   worst write-off rate 0.7% -> 0.7%.
 *
 * Law 'n Justice's census median moves while its pinned hash does not, and the
 * two are consistent: the table's group-backed ids are its five standups, which
 * the aggressive census player re-hits on later balls and this script's
 * scripted window never does.
 *
 * The other gates: full suite green, `npx tsc --noEmit` clean, public-build
 * guard 286 gated, tip-flip sweep pass-under 0/1044, and the film side-by-side
 * BYTE-IDENTICAL at 98.4508/99.8645/99.1322 — which is its own check here,
 * because the film windows are all ball ONE and a leak into ball one would
 * have moved them.
 *
 * The digests this entry replaced, recorded so the move is auditable:
 *   law-n-justice   6eadefa2a35b3a57cfb5b470096dc237626c082f08f7df537985cfa1dc286955 (UNCHANGED)
 *   babewatch       dd969b9ddcd84edfe046ba8fd6dc2e9663f0ab150e6c3e919fb4784dfcbde2de
 *   extreme-sports  c5e54dfbf1e35ff2def60535c00ba679ce33e1662a0e9db0cb07f9e1b06feef1
 *
 * Nothing else about this pin moved: same 4,000 ticks, same three tables, same
 * scripted input, same `debugSnapshot` fields.
 *
 * RE-PIN, THE MACHINE'S OWN FRAME (the arch-normal round). All three hashes
 * move, there is no unchanged control table this time, and the justification is
 * therefore not a control but a MEASUREMENT AGAINST THE ORIGINAL'S OWN RAM.
 *
 * WHAT CHANGED. `integrateBall` is the original's frame instead of a swept path:
 * eight substeps of `pos += v>>1` with a collision-and-respond pass in front of
 * substeps 0, 2, 4 and 6, the 44-direction ring read WHERE THE BALL STANDS, and
 * no walk of any kind. Two independent defects went with it — the integrator
 * (`v += a; x += v` against eight `x += v>>3; v += a/8`, a systematic +76 Q10 of
 * over-travel on every accelerating tick) and the round-8 overlap-depth rule
 * (the `|v|/4` walk along the contact bearing, which turned out to be the single
 * largest error source in the contact model). Decode, candidate sweep and
 * instrument: `research/ARCH_NORMAL_DECODE.md`.
 *
 * THE EVIDENCE, and it is the strongest this pin has ever carried. Both rules
 * were scored against the machine's own velocity words over the same corpus —
 * 576 traced frames of four untouched Law 'n Justice launches, carrying 218
 * contacts, each frame predicted from the machine's own exact start state so
 * errors cannot accumulate (`research/arch/tools/port-corpus.mts`, which imports
 * the SHIPPED `stepBalls`):
 *
 *                              exact  <=4 units   error sum   positions exact
 *   HEAD (the swept path)        436        440       21089            0 / 576
 *   this tree                    466        517        1790          464 / 576
 *
 * Eleven-point-eight times closer on velocity, and the per-tick POSITION goes
 * from never right to right on 464 of 576 frames. On the arch entry the four
 * traced launches now come out at 14.13 / 14.13 / 10.79 / 14.13 degrees against
 * the machine's measured 14.13 / 14.13 / 10.78 / 14.13, where HEAD turned 7.58
 * and ground. The decode's own unobserved forecast — an approach above cy
 * 118.88525 misses and the NEXT frame turns 17.24 — is reproduced at 17.25
 * (`tests/arch-normal.test.ts`).
 *
 * THE CENSUS, 90 games x 3 tables x 40,000 ticks, aggressive player, HEAD
 * c9724a4 -> this tree, both measured this round. The four-passes-a-frame
 * rolling friction this round adopts is FOUR TIMES what the port charged, and
 * the shallow-slope traps it could have re-opened did not:
 *
 *   law-n-justice   completed 90/90 -> 90/90, ends 271 -> 274, drained 271 ->
 *                   274, written off 0 -> 0; median 635,000 -> 695,000, min 0,
 *                   max 8,945,000 -> 9,165,000, zeros 3/90 -> 2/90, distinct
 *                   76 -> 81; BALL 1 median 100,000 -> 267,500, zeros 26/90 ->
 *                   13/90.
 *   babewatch       completed 90/90 -> 90/90, ends 270, drained 270, written
 *                   off 0 -> 0; median 985,000 -> 1,386,170, min 770,000 ->
 *                   350,000, max 3,840,000 -> 8,910,000, zeros 0/90, distinct
 *                   71 -> 81; BALL 1 median 410,000 -> 320,000, zeros 0/90.
 *   extreme-sports  completed 90/90 -> 90/90, ends 270, drained 268 -> 270,
 *                   WRITTEN OFF 2 (0.7%) -> 0 (0.0%) — the (238,588)L0 spit,
 *                   the only write-off site left on any table, is gone;
 *                   median 425,000 -> 347,500, min 165,000 -> 150,000, max
 *                   7,700,000 -> 9,280,000, zeros 0/90, distinct 69 -> 64;
 *                   BALL 1 median 92,500 -> 65,000, zeros 0/90.
 *   worst write-off rate 0.7% -> 0.0%, zero stalls everywhere.
 *
 * The other gates: full suite green, `npx tsc --noEmit` clean, public-build
 * guard 286 gated; tip-flip sweep pass-under 0 of 882 (0 of 1044 at HEAD — the
 * trial count is lower because the ball now rolls off the blade in 56 ticks
 * instead of 65, so fewer press ticks land while it is still on the bat); film
 * side-by-side BYTE-IDENTICAL at 98.4508/99.8645/99.1322 with every raster
 * identical to its stored reference in 298224/298224 px, which is expected
 * rather than surprising — that instrument renders a fresh `createGame` at tick
 * 0 with the ball pinned at a fixed centre, so it measures artwork, lamps and
 * sprites and no trajectory reaches it.
 *
 * The digests this entry replaced, recorded so the move is auditable:
 *   law-n-justice   6eadefa2a35b3a57cfb5b470096dc237626c082f08f7df537985cfa1dc286955
 *   babewatch       685756c8b1dffff7b177b7673574d39be6b04b346a16df66261691a1fc5829aa
 *   extreme-sports  63896e08d578ebda9e141f78682f982353251ad9b65a8b248046156cc3a62b51
 *
 * Nothing else about this pin moved: same 4,000 ticks, same three tables, same
 * scripted input, same `debugSnapshot` fields. Only the digests.
 *
 * RE-PIN, THE BAT'S APPROACH SIDE IS A SIGN (the pathology round). ONE hash
 * moves, and the two that do not are the argument.
 *
 * WHAT CHANGED. `touchAt` overrides the ring's contact normal when it disagrees
 * with the side the ball came from, which is what stops a bat pushing a ball out
 * through itself. It used to be handed the last POSITION the ball was outside
 * the bat at, and re-derived the side from it against the pose of the moment.
 * While a ball stays in contact there is no new outside position, so on a
 * struck ball the reference stayed at the tick's start while the axis it was
 * measured against went on rotating: the last eight degrees of the stroke are
 * 4.4 px of blade at mid-blade, so on the tick the bat reached its stop the
 * stale point crossed to the far side of the NEW axis, the override fired
 * backwards, and the ball was separated DOWNWARD through the blade with no
 * impulse at all (the stop had already zeroed the rate). `resolveOne` now
 * decides the side WHEN the ball is outside, against the pose it is outside AT,
 * and carries the sign. The mechanism was diagnosed in
 * `research/view/tip-flip/FINDINGS.txt` in the round-8 investigation and never
 * fixed; this is the fix.
 *
 * IT IS THE OPERATOR'S OWN REPORT — "if you let the ball roll near the end of
 * the flipper and then flip, the ball goes under the flipper instead of
 * shooting up" — and it is PRE-EXISTING rather than a regression: the same
 * probe on `c9724a4` scores it worse than `822caf5` does.
 *
 * THE DIVERGENCE IS THE DEFECT ITSELF. Dumping all 4,000 per-tick snapshots on
 * both trees:
 *
 *   law-n-justice   0 of 4,000 ticks differ
 *   extreme-sports  0 of 4,000 ticks differ
 *   babewatch       first differing tick index 567. The ball is on the lower
 *                   bat: HEAD leaves it at (194,544) doing (-7548,+4237) —
 *                   through the blade and falling — and this tree leaves it at
 *                   (199,527) doing (+1457,-16252), launched at the clamp. The
 *                   very first tick that moves is a ball that used to be thrown
 *                   down through the bat and is now shot up it. 3,433 of the
 *                   4,000 differ afterwards, which is what one saved ball does
 *                   to the rest of a game.
 *
 * Two unmoved tables are a real control here and not luck: this script's Law 'n
 * Justice and Extreme Sports windows never present the bat with a ball that is
 * still embedded when the stroke reaches its stop, and if either had moved,
 * something other than the side reference would have changed with it.
 *
 * THE FLIPPER PROBE, `scripts/flipper-probe.mts`, 108 roll-and-flip trials per
 * bat — ball set on the resting blade, allowed to roll toward the tip, flipped
 * after k ticks — counting the trials that end with the ball UNDER a blade it
 * was on top of, at `c9724a4` -> `822caf5` -> this tree:
 *
 *   lower-left   LnJ 10 -> 6 -> 0     lower-right  LnJ 44 -> 29 -> 3
 *                BW   9 -> 4 -> 0                  BW  43 -> 29 -> 3
 *                ES   9 -> 5 -> 0                  ES  44 -> 29 -> 3
 *   all six bats        159 -> 102 -> 9 of 648
 *   outer blade only    138 ->  84 -> 9 of 384   (`along` >= 22 px at the press)
 *   falling onto the blade and flipped on arrival: 30 -> 21 -> 14 of 210
 *
 * `tests/flipper-pass-under.test.ts` is the suite's copy: the canonical case
 * plus a ceiling over the whole outer band, and a cradle check on all six bats
 * so the same rule cannot have made the blade porous the other way.
 *
 * THE CENSUS, 90 games x 3 tables x 40,000 ticks, aggressive player,
 * `822caf5` -> this tree. Every table still completes 90/90 with ZERO
 * write-offs; the ball is simply saved more often, which is what a working
 * flipper does:
 *
 *   law-n-justice   ends 274 -> 279; median 695,000 -> 1,127,500; max
 *                   9,165,000 -> 21,880,000; zeros 2/90 -> 1/90; distinct 81;
 *                   BALL 1 median 267,500 -> 295,000.
 *   babewatch       ends 270; median 1,386,170 -> 1,896,170; min 350,000 ->
 *                   425,000; max 8,910,000 -> 11,994,680; distinct 81 -> 87;
 *                   BALL 1 median 320,000 -> 355,000.
 *   extreme-sports  ends 270; median 347,500 -> 702,500; min 150,000; max
 *                   9,280,000 -> 10,964,000; distinct 64 -> 75; BALL 1 median
 *                   65,000 -> 120,000.
 *   worst write-off rate 0.0% -> 0.0%.
 *
 * The other gates: full suite green, `npx tsc --noEmit` clean, public-build
 * guard 286 gated, and — the one that matters most for a change inside the
 * contact model — THE PHYSICS GATE UNMOVED at its baseline
 * 576/218/466/517/1790/464. It is unmoved by construction: its corpus excludes
 * every frame in which the machine's own ball was in bat contact, so a change
 * confined to `flippers.ts` cannot reach it, and a change that moved it would
 * not have been confined.
 *
 * The digests this entry replaced, recorded so the move is auditable:
 *   law-n-justice   29c573580c2edd9cec313ebfe6c0c827157d121d87ad099e14635a2141652b00 (UNCHANGED)
 *   babewatch       d1358da0fef0abb2038238f211281072b2e4ce850c074fa23eebfd0489a4c9dc
 *   extreme-sports  05cf9bbd1334ff9fac6d5e26aa69708765f364db9678ed2eb064a2f18cb3c823 (UNCHANGED)
 *
 * RE-PIN, THE BALL'S SPIN, THE EJECTOR AND `$38` (the spin round). All three
 * hashes move, and they move on the SAME tick of all three tables, which is the
 * signature of a change in engine geometry rather than in table data.
 *
 * WHAT CHANGED. Three decodes out of `research/spin/SPIN_DECODE.md` and the
 * bytes of `main.seg00`, plus one correction the bytes forced:
 *
 *   `$26(a4)`, THE BALL'S SPIN, is a real field. `BallState.spin` is charged by
 *   `sub.w d4,$26(a4)` at +0x00B640 with the SAME `d4` that puts `5q/8` into
 *   the translation one instruction earlier, and bled one unit per SUBSTEP —
 *   eight a frame, linear, saturating — at +0x00B770. The port used to read it
 *   as a permanent zero, which is the SPINLESS LIMIT and the most the rule can
 *   ever take. Nothing resets it: not a serve, not a drain, not a lock.
 *
 *   THE EJECTOR at +0x00B6BE: six or more of the ring's forty-four points in
 *   solid and the ball is shoved half a pixel out along the contact bearing.
 *   This REPLACES `holdAgainst`, the position constraint `78bed65` had to
 *   invent and disclosed as its deviation 1.
 *
 *   `$38(a4)`, THE TOO-SOFT GATE, is per surface and is tested on the RAW
 *   approach at +0x00B56E: -800 / -200 / -2000 / -400 and ZERO for the bumpers,
 *   where the port used one global 853 Q10 on the outgoing bounce.
 *
 *   AND THE TOLL IS APPLIED TO A SCALAR. The machine has no `keep` fraction; it
 *   adds and subtracts whole units of a signed tangential speed. The port's
 *   `trunc((vt - drop) * 1024 / vt)` lost up to one part in 1024 of the speed at
 *   every contact, always in the slower direction. That, and a FLOORING rather
 *   than truncating exit rotation, is the arch round's unexplained C9 — which is
 *   therefore answered and struck off, not still open.
 *
 * A CORRECTION TO THE DECODE, found in the bytes while implementing it.
 * SPIN_DECODE section 3.1 reports the ejector as running "once per substep, by
 * the integrator — not by the responder, which still cannot move a ball". Both
 * halves are wrong. There is an `rts` at +0x00B6E6, immediately before the
 * integrator's entry at +0x00B6E8: the two are adjacent in memory and separate
 * `jsr` targets, and the unrolled frame calls `$b4ba` FOUR times and `$b6e8`
 * eight. +0x00B6BE is the responder's own last instruction, reached by falling
 * out of the velocity store at +0x00B6B6 that every path converges on — the
 * leaving gate included. So it is four a frame, and the responder can move a
 * ball, at exactly this one instruction. The correction is worth a factor of
 * two in how hard the rule pushes and it was measured as well as read: at eight
 * a frame the physics gate scores 2166 and at four it scores 282.
 *
 * THE EVIDENCE. The physics gate — the shipped `stepBalls` against the
 * machine's own per-frame RAM, one tick from each of its own exact start states:
 *
 *                                            errorSum  exact  <=4  posExact
 *   ed5e01d                                      1790    466  517       464
 *   + scalar tangent (no `keep` fraction)        1743    468  523       469
 *   + the SPIN word                              1527    470  549       484
 *   + per-surface `$38`                          1384    470  550       484
 *   + the ejector at four a frame                 282    470  558       487
 *
 * 6.35x closer; worst single frame 366.17 -> 12.04; contact p90 4.10 -> 1.90.
 * The middle row is a FORECAST THAT HELD: SPIN_DECODE section 7.5 predicted
 * "roughly 1500-1560" for the two changes it modelled, and the port lands on
 * 1527.
 *
 * THE DIVERGENCE IS THE EJECTOR, ON THE FIRST CONTACT OF THE GAME. Dumping all
 * 4,000 per-tick snapshots on both trees, all three tables diverge at the SAME
 * tick — index 25, ball 1, in the return chute at (294,520)L1 — with the
 * velocity identical and the position exactly 724 Q10 further along on both
 * axes. 724 is two ejector pushes of `(512 * 724) >> 10` = 362 along a
 * 45-degree contact normal: the ball is six ring points into the chute wall and
 * the machine shoves it out. The chute is engine geometry shared by all three
 * tables, which is why the tick index is identical; the first differing PIXEL is
 * two ticks later, at 27. 3,975 of 4,000 ticks differ afterwards on every table,
 * which is what a physics change does to three whole games.
 *
 *   law-n-justice   final score 0 -> 420,000
 *   babewatch       final score 2,090,000 -> 2,095,000
 *   extreme-sports  final score 245,000 -> 310,000
 *
 * ONE FIELD IS PROJECTED OUT OF THE HASH and `hashedSnapshot` says why: the spin
 * word itself, which differs from the first contact of every game and would turn
 * "the first divergent tick" into a statement about when a field was added
 * rather than about when the behaviour moved. It is dropped with a JSON replacer
 * rather than by rebuilding the object, so the key order — and therefore every
 * byte of every other field — is untouched, and the projection is a no-op on any
 * tree without the field. VERIFIED: replaying the 4,000-tick script at `ed5e01d`
 * through this exact harness reproduces all three of the digests it replaced.
 *
 * THE CENSUS, 90 games x 3 tables x 40,000 ticks, aggressive player, `ed5e01d`
 * -> this tree. Every table still completes 90/90 with ZERO write-offs:
 *
 *   law-n-justice   ends 279; median 1,127,500 -> 1,612,500; min 0 -> 95,000;
 *                   max 21,880,000 -> 25,355,000; zeros 1/90 -> 0/90;
 *                   distinct 81 -> 86; BALL 1 median 295,000 -> 272,500.
 *   babewatch       ends 270; median 1,896,170 -> 3,207,500; min 425,000 ->
 *                   970,000; max 11,994,680 -> 10,800,000; distinct 87 -> 88;
 *                   BALL 1 median 355,000 -> 732,500.
 *   extreme-sports  ends 270; median 702,500 -> 682,500; min 150,000; max
 *                   10,964,000 -> 11,737,000; distinct 75 -> 81; BALL 1 median
 *                   120,000 -> 135,000.
 *   worst write-off rate 0.0% -> 0.0%, zero stalls everywhere.
 *
 * THE PATHOLOGY SWEEP, 12 games x 3 tables x 3 profiles x 40,000 ticks:
 * findings 6 -> 0. The four creeping, one oscillating and one dwell finding
 * `ed5e01d` reported on Extreme Sports' (51.5,433.4)L0 chain are gone and
 * nothing replaced them. The trap census at 4 px, 68,620 releases: balls that
 * ended FULLY AT REST — dead, v = (0,0), for ever — fall from 12,481 to 1,558,
 * and the BabeWatch level-1 rail site this round was handed drops from 66
 * releases to 2. The two pre-existing map pockets stay, as they must: Law 'n
 * Justice (24,304)L0 2 -> 2 and BabeWatch (252,57)L0 11 -> 8.
 *
 * THE FLIPPER PROBE, and this is the one figure that moved the wrong way.
 * Roll-and-flip pass-under over the six lower bats: 9 -> 12 of 648, all of it on
 * the lower-right outer blade, the known residual `ed5e01d` reduced from 159 to
 * 9 and left. Ablated on the probe itself: the SCALAR TANGENT costs it (9 ->
 * 15), because a ball that keeps the tangential speed the machine leaves it
 * rolls further out the blade before the stroke starts, and the SPIN then wins
 * half of that back (15 -> 12). Drop pass-under 14 -> 13 of 210, and the cradle
 * holds on all six lower bats on both trees. The underlying defect is
 * `flippers.ts` resolving bat contacts once per tick after `stepBalls` instead
 * of inside the four passes — ARCH_NORMAL_DECODE section 9.4 and SPIN_DECODE
 * section 7.4, disclosed and deferred by both — and this round makes the ball
 * arrive at it more faithfully rather than making the bat worse.
 *
 * The digests this entry replaced, recorded so the move is auditable:
 *   law-n-justice   29c573580c2edd9cec313ebfe6c0c827157d121d87ad099e14635a2141652b00
 *   babewatch       6fe25c2e110feeb90805e9b1f75901387e5b70842b8805d9f0354c159aa4818a
 *   extreme-sports  05cf9bbd1334ff9fac6d5e26aa69708765f364db9678ed2eb064a2f18cb3c823
 *
 * RE-PIN, THE BAT JOINS THE FRAME (the per-substep flipper round). All three
 * hashes moved, and all three FIRST DIVERGENT TICKS are the same deleted
 * instruction.
 *
 * WHAT CHANGED. `resolveFlipperContacts` ran once per tick, after `stepBalls`
 * had already spent the whole frame, and recovered the machine's four collision
 * passes by INTERPOLATING four points along the tick's net displacement. The
 * machine has no such seam: main.seg00 +0x00B278 — the routine +0x00A7E0 calls
 * on every pass, for every ball — walks the four flipper records at $2346(a5)
 * BEFORE it blits the map, gated by the ball's own collision plane
 * (`cmp.l $1c(a0),d2` at +0x00B2B0) and by the box the record carries FOR THAT
 * POSE (`movem.w $1fa(a0,d2.w*8),d2-d5` at +0x00B2BE, indexed by `$1a(a0)`).
 * The bat is now resolved from inside `integrateBall`, at substeps 0, 2, 4 and
 * 6, at the position the ball actually stands in — so an impulse landed at pass
 * 0 is carried by the six substeps after it. Three consequences moved ticks:
 *
 *   THE CROSSING-POINT REWIND IS GONE. The swept resolve ended by moving the
 *   ball BACK to the sample that first met the bat, discarding the rest of the
 *   tick — the only honest thing to do with a contact discovered after the fact,
 *   and a thing the machine's responder cannot do at all. Measured on a ball
 *   rolling down the resting Law 'n Justice left bat: 0.13 px of travel a tick
 *   against a velocity of 0.55 to 1.04.
 *
 *   THE POSE AT A PASS IS THE POSE BEFORE THAT PASS'S ANIMATION STEP. `jsr
 *   $bc24` follows the ball loop in every one of the frame's four groups
 *   (+0x00A65A, +0x00A6A4, +0x00A6EE, +0x00A736), so a pass reads the pose the
 *   PREVIOUS step wrote. The port read `steps[pass]`, the state after the step,
 *   which ran a fresh stroke's four passes at rates 20/40/60/80 where the
 *   machine runs them at 0/20/40/60.
 *
 *   THE BAT IS LOADED ONCE PER PASS. `+0x00AED2..+0x00AEE4` subtracts half the
 *   impulse-table entry from `$10(a0)` and writes it back INSIDE the pass, so a
 *   ball lying on a rising blade takes angular momentum out of it four times a
 *   frame. The port charged it once, a four-fold under-count.
 *
 * THE FIRST DIVERGENT TICK, per table, and it is the rewind on all three. Every
 * earlier tick is byte-identical; at the tick named, the velocity is the same to
 * within a few Q10 and only the POSITION moves, by exactly the travel the old
 * resolve threw away.
 *
 *   law-n-justice  t197. Ball (58.826,320.341) v=(2183,11832) entering the
 *                  RESTING upper-left bat at (37,302). HEAD advances it
 *                  (+1.06,+5.81) — half a tick — to (59.889,326.146); this tree
 *                  advances the whole (+2.15,+11.54) to (60.975,331.876), with
 *                  the velocity within 12 Q10 either way.
 *   babewatch      t803. Ball (204.418,550.383) v=(-2270,6800) onto the resting
 *                  lower-right bat. HEAD (203.309,553.730), this tree
 *                  (200.461,554.668): (-1.11,+3.35) against (-3.96,+4.29).
 *   extreme-sports t241. Ball (157.854,190.261)L1 v=(-3452,3153) at the upper
 *                  bat (182,194)L1. HEAD (157.011,191.044) — a QUARTER of the
 *                  tick — against (154.140,192.696).
 *
 * THE GATES.
 *
 *   THE FLIPPER PROBE, which is what this round was for. Roll-and-flip
 *   pass-under over the six lower bats 12 -> 0 of 648 and drop-and-flip
 *   13 -> 0 of 210; the cradle holds on all six lower bats, unchanged, and the
 *   ceiling in `tests/flipper-pass-under.test.ts` is tightened from 12 to 0.
 *   That is the operator's own reported defect, closed.
 *
 *   THE PHYSICS GATE, unmoved and exit 0 at 576/218/470/558/282/487. It is
 *   unmoved by construction — its corpus excludes every frame the machine's own
 *   ball spent in bat contact — and a change that had moved it would not have
 *   been confined to the bat path.
 *
 *   THE CENSUS, 90 games x 3 tables x 40,000 ticks, both trees on one driver.
 *   90/90 completed everywhere. Medians 1,612,500 -> 4,980,000 (LnJ),
 *   3,207,500 -> 4,548,670 (BW), 682,500 -> 1,168,500 (ES); ball-1 medians
 *   272,500 -> 620,000, 732,500 -> 1,140,000, 135,000 -> 120,000; LnJ zero
 *   scores 5/90 -> 2/90 on ball 1 and 0/90 -> 0/90 overall.
 *
 *   AND THE ONE FIGURE THAT MOVED THE WRONG WAY: Law 'n Justice write-offs
 *   0 -> 4 of 288 ball ends (1.4%), zero on the other two tables. All four are
 *   the pocket cluster beside the upper-left bat — (24,304)L0, (25,307)L0 and
 *   (42,341)L0 — which is the PRE-EXISTING map trap `ed5e01d` named and this
 *   file's own re-pin above records as staying. Controlled directly: a ball
 *   released from rest at (42,341)L0 goes DEAD STILL at (42.692,341.999) with
 *   v=(0,0) from tick 8 on BOTH trees, tick for tick, and the 67,620-release
 *   trap census (run with the bats present on both trees, which it had never
 *   been before — see `scripts/pathology-sweep.mts`) moves balls that end fully
 *   at rest 1,580 -> 1,556 and sites 2,143 -> 2,146. The traps are the same
 *   traps; a ball that survives three times as long reaches them more often.
 *   Closing them is map-pocket work and belongs to whoever takes the resting
 *   ball next.
 *
 * The digests this entry replaced, recorded so the move is auditable:
 *   law-n-justice   77b68e4309949efa46c658ecd734a3deaf4d14a5265db0c8989b3f9056e1ea20
 *   babewatch       14a0ed019849b31805b1ea44a04c78cabb05820e2d32701a16fa7f8738506a56
 *   extreme-sports  e62fdc9f1c4611960822e138114666965120247dc8e347e06f0a1927894abefd
 *
 * NOT A RE-PIN — THE EJECTOR'S UNION COUNT (the pocket round). All three
 * digests below are UNCHANGED by the round that made the ejector at +0x00B6BE
 * count its ring over `map OR bat` (`BatUnionMask` in `ball-physics.ts`), and
 * that is recorded here because a reader who knows the round moved the census
 * would otherwise reasonably suspect this instrument of being blind to it.
 *
 * IT IS NOT BLIND; THE SCRIPT SIMPLY NEVER MEETS THE CASE. Instrumented over
 * this pin's own 12,000 ticks — 4,000 on each table, through this exact harness
 * — the ejector was reached with a blade anywhere within the ball's ring THREE
 * times, and on none of those three did the union add a single ring point:
 * reached 3, raised 0, fired 0. The reason is structural rather than lucky. The
 * ejector is reached only through the MAP's own probe (`respondAt` returns on an
 * empty blit), and the shipped collision layers carve the line OUT where a bat
 * sweeps — 95 of 11,371 pixels under BabeWatch's lower-left bat, one under
 * Extreme Sports' upper, none anywhere else — so a ball on a blade almost never
 * has a map contact at the same moment. Where the two DO coincide is the pocket
 * beside Law 'n Justice's upper-left bat, which this script never visits and
 * which the 90-game census reaches on its own: the same counters, run over one
 * release into that pocket, fire 3,609 times.
 *
 * So the change is live and is measured elsewhere — the census, the flipper
 * probe, the trap census, and `tests/ball-spin.test.ts`'s own union counts
 * against the machine's RAM — and it moves no byte of these three games.
 */
/**
 * RE-PINNED — THE BALL SAVER (this round). Same script, same strictness, same
 * 4,000 ticks, three new digests. The old ones were
 *
 *   law-n-justice   a41f900e57cc38f3759aa0bca236600726e5ba3974d40a68def10c46bfce2493
 *   babewatch       4ab5a715fa45de855691e81d78d5338e96682613a36e3dc60f57ae0c690cc3c7
 *   extreme-sports  9ffff59755535963edd0a72d95e5bbe14b6ec327dd68b5d7978f6da25fc9b303
 *
 * and they moved because `$D8A(a5)` is now armed at every charged serve from
 * `.opt` record 5 and spent by the drain reaper. THE FIRST DIVERGENT TICK WAS
 * MEASURED, not assumed: the tree at 1778bf4 was checked out into a second
 * worktree and run through this exact harness, and the two runs' per-tick
 * snapshots were compared with the two NEW fields (`ballSaveTicks`,
 * `ballSaving`) projected out, so what the comparison sees is behaviour and not
 * the arrival of a field.
 *
 *   law-n-justice   TICK 658. Ball 2 drains 75 frames short of the end of its
 *                   five-second save. At 1778bf4 that was the end of the ball
 *                   and `bonusPhase` opened; now `pendingServes` goes to 1,
 *                   `ballSaving` goes up and the same ball comes back. The three
 *                   fields that differ on that tick are `bonusPhase`,
 *                   `pendingServes` and `serveCountdown`, and nothing else.
 *   extreme-sports  TICK 302. The same event on ball 1, 223 frames into its TEN
 *                   second save — the one table whose option record 5 is 10
 *                   rather than 5, which is why it is the earliest of the three.
 *   babewatch       NO BEHAVIOURAL TICK AT ALL. Over the whole 4,000 ticks not
 *                   one projected snapshot differs: this script's drains on that
 *                   table all land after the five seconds are spent. Its digest
 *                   moves for the two new fields alone, and that is the honest
 *                   reading of it rather than a claim that nothing changed.
 *
 * The growing-jackpot half of the same round moves NONE of the three. It is
 * reachable only through award effects 10/14/15/25/27 and opcodes 6/7/13/15/16/18,
 * and this script never starts a mission, so no element carrying one is ever
 * awarded and no ramp is ever started. `tests/growing-jackpots.test.ts` is where
 * that half is measured.
 *
 * RE-PIN, AWARD EFFECTS 17 AND 22 (the chain-and-milestone round). ONE hash
 * moved and the argument is again the two that did not.
 *
 * WHAT CHANGED. Two entries of the award-effect table at 0x5D0E that this port
 * dispatched on and had no case for. Both were read out of
 * `research/seg_clean/main.bin.seg00.bin` (file offset = address + 4) because
 * Capstone drops the `d6.w*2` scale of a brief extension word and would have
 * shown effect 22's two index reads as `$16(a0,d6.w)`:
 *
 *   17 @0x613A  206a 0034 / 4eb9 0000 6c10 / 4e75 — the element's +$34 QUEUED
 *               as a script. Twelve bytes; thirty-four elements carry it.
 *   22 @0x6146  the count dispatch's tail WITHOUT the count: read the player's
 *               total at +$16, walk the ladder at +$50, queue the entry whose
 *               id equals the total. No bump, no wrap.
 *
 * THE DIVERGENCE IS ONE EVENT AND ITS CONSEQUENCES. All 4,000 per-tick
 * snapshots were dumped on this tree and on c622581 and compared field by
 * field:
 *
 *   law-n-justice   0 of 4,000 ticks differ — hash UNMOVED.
 *   extreme-sports  0 of 4,000 ticks differ — hash UNMOVED.
 *   babewatch       FIRST DIVERGENT TICK 923, and on that tick the ONLY field
 *                   that differs in the whole snapshot is `modeMessages`:
 *                   `[]` -> `["GYM MODE ENABLED"]`. That is BabeWatch message
 *                   1, the first instruction of script 82 — ladder 10 rung one,
 *                   fired by the effect-22 award of element 15 when the ball
 *                   reached the lock. Script 82 then `START`s element 21, the
 *                   5,000,000 gym shot that could not be armed at all before.
 *                   Tick 2148 is the first SCORE divergence and it is exactly
 *                   that element: 2,282,340 -> 7,282,340, +5,000,000. Tick 2153
 *                   is the first MISSION divergence: element 21's own effect-6
 *                   award steps counter 4 to one, ladder 1 rung one launches
 *                   script 120, and "JACKPOT VALUE TIME" runs for the first
 *                   time in this port. Final score 3,532,340 -> 8,632,340.
 *
 * The two unmoved tables had to be unmoved: this script never reaches Law 'n
 * Justice's jail lock (the only site that awards its effect-22 element 10) nor
 * Extreme Sports' element 83, and neither table's effect-17 elements are
 * awarded inside its window. A moved hash on either would have meant something
 * else changed with them.
 *
 * ---------------------------------------------------------------------------
 * RE-PIN, THE TWO BAT RULES (this round). All three hashes moved.
 * ---------------------------------------------------------------------------
 *
 * The digests this entry replaced, recorded so the move is auditable:
 *   law-n-justice   9038d64e08bd11116334e6e4e3f77009cad5968b64e585e952dcf7029afac3b9
 *   babewatch       16e02ba974870dd3c768e5e687d1ad879e3a5a67107f575710f7b5585a3fd325
 *   extreme-sports  88834d88e7b19b6d443d558bd840df8110c97dbf00573155b14a77f57922bf78
 *
 * Same 4,000 ticks, same script, same strictness, same `hashedSnapshot`
 * projection. Only the digests. Two rules landed, both decoded out of the
 * collision responder and both measured against the machine's own RAM in
 * `research/flipper-power/BW_RIGHT_BAT.md` and `out/gate-threshold.txt`:
 *
 *   THE TANGENT GATE, `cmpi.w #$fa0,d1 / bhi` at +0x00B534. The along-face term
 *   `$1a(a4)` is added to the contact only when the pending kick and the ball's
 *   own normal velocity are within 4000 doubled units of each other; this port
 *   added it on every kick. Scored on 366 single passes taken 30 us apart out of
 *   the machine's own RAM, with the threshold FITTED rather than assumed and
 *   against five rival comparands, the decoded quantity agrees on 89.3 % where
 *   "the impulse alone" manages 74.3 %, a radius gate 73.2 % and "always add it"
 *   55.5 %. The machine applies the tangent on 100 % of the passes under 3,750
 *   and 0 % of those over 5,250.
 *
 *   THE MID-PASS RATE WRITE-BACK, +0x00AED2. The reduced bat rate is stored to
 *   `$10(a0)` INSIDE the collision pass and the animation step that follows
 *   moves the bat by it, so a ball on the blade slows the blade DURING the tick
 *   and the blade stays under it. This port precomputed all four steps and spent
 *   the deduction in the bank afterwards. Driven from the machine's own ball on
 *   300 loaded ticks over six bats, the blade's advance error goes from +8.19
 *   bat units — one-signed, over-travelling on every bat of every table — to
 *   -0.59, and the machine's own step ladder on `bw-ramp` frame 4969 (80, 93,
 *   105, 111 against the precomputed 80, 100, 120, 120) is now reproduced
 *   exactly.
 *
 * THE FIRST DIVERGENT TICK, per table, and it is the write-back on all three:
 * every earlier tick is byte-identical and at the tick named the bat's own
 * STROKE is short by the deduction the tick has now already spent.
 *
 *   law-n-justice  t1025. The lower-left bat ends the tick at stroke 68 where
 *                  HEAD ends it at 120 — 52 bat units, the ball on the blade
 *                  charging three of the tick's four passes. The ball goes
 *                  (135.653,568.593) v=(8889,-4725) -> (135.185,569.013)
 *                  v=(6973,-3007).
 *   babewatch      t827. Lower-right, stroke 505 against HEAD's 540. The ball's
 *                  vertical word is the clamp on both trees (-16348) and the
 *                  HORIZONTAL one moves, -14459 -> -16380: that is the tangent
 *                  gate as well, dropping an along-face term the machine does
 *                  not apply at that kick.
 *   extreme-sports t565. The upper bat, stroke 364 against HEAD's 420, ball
 *                  (152.091,185.179) v=(-4438,-10438) -> (152.153,185.601)
 *                  v=(-4305,-9571).
 *
 * THE GATES.
 *
 *   THE FLIPPER PROBE. The six lower bats' cradles hold, 0 of 36 lost, unmoved.
 *   Roll-and-flip and drop-and-flip each grow ONE pass-under of 648 and 210 —
 *   and both are scored at bat stroke ZERO, 76 and 77 ticks after the press,
 *   on trials whose ball was launched cleanly at 15.9 px/tick and came back a
 *   second and a half later to drain past a bat parked on its rest stop. The
 *   probe now reports the stroke and the tick offset of every crossing it
 *   scores, so the operator's own defect — a ball going under a bat that is
 *   rising or raised — is separable from a late drain: at 0 of 648 and 0 of 210
 *   it is unmoved.
 *
 *   THE PHYSICS GATE, unmoved and exit 0 at 576/218/470/558/282/487, as it must
 *   be: its corpus excludes every frame the machine's own ball spent in bat
 *   contact.
 *
 *   THE CENSUS, 90 games x 3 tables x 40,000 ticks: 90/90 completed on all
 *   three. Ends per game 3.48 (LnJ), 3.10 (BW), 3.83 (ES); medians 3,197,500 /
 *   5,437,500 / 3,775,000 against 5,977,500 / 5,995,000 / 1,490,000, and
 *   ball-1 medians 375,000 / 777,500 / 485,000. Three write-offs of 313 on Law
 *   'n Justice and none on the other two.
 */
const PINNED: Record<TableId, string> = {
  "law-n-justice": "ed9a8d8da0b6cca1768ded7b835f4b22db9eaf29cb89421bf01b271dea7ae8d3",
  "babewatch": "c66fd3945f17edd996e1b86c1406b64c7067d89f8f469f8a23e7ec2174b660f6",
  "extreme-sports": "5a93dd8751d36331a52472b11af8bc4332bb86746160d93adf665746a7035776",
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

/**
 * The snapshot as this pin hashes it: everything `debugSnapshot` reports EXCEPT
 * the ball's spin word and the copy of it the trough record carries.
 *
 * WHY ONE FIELD IS PROJECTED OUT, and it is the only one. `BallState.spin` is
 * the original's `$26(a4)` and it is real simulation state, so it belongs in a
 * debug dump — but it is charged at the FIRST contact of every game and bled
 * eight units a frame thereafter, so a tree that has it and a tree that does
 * not differ on essentially every tick from the first bounce onward. Hashing it
 * would make "the first divergent tick" a statement about when the field was
 * introduced rather than about when the BEHAVIOUR moved, and that tick is the
 * whole diagnostic value this pin has. Everything the spin actually DOES —
 * every position, every velocity, every score that follows from it — is hashed
 * exactly as before, so nothing about the rule escapes the pin.
 *
 * `research/spin/SPIN_DECODE.md` 7.1 asks for exactly this.
 */
export function hashedSnapshot(game: Game): string {
  // A REPLACER and not a rebuilt object, deliberately: rebuilding would reorder
  // the keys and move all three digests for a reason that is not behaviour,
  // which is the exact failure this projection exists to avoid. Dropping the
  // key in place leaves the JSON byte-for-byte what it was everywhere else —
  // and at any tree without a spin field it is a no-op, so the pin's history
  // stays comparable.
  return JSON.stringify(debugSnapshot(game), (key, value: unknown) =>
    key === "spin" ? undefined : value,
  );
}

function simHash(tableId: TableId): string {
  const game = createGame(mapFor(tableId));
  startGame(game);
  const input = new ScriptedInput();
  const hash = createHash("sha256");
  for (let tick = 0; tick < TICKS; tick += 1) {
    runTicks(game, input, 1);
    hash.update(hashedSnapshot(game));
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
