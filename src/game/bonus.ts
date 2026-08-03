/**
 * THE END-OF-BALL BONUS.
 *
 * Everything a ball earned into the bonus accumulator is paid here, and until
 * this module existed none of it was: the mission layer fed `scoring.bonus`
 * correctly — 23 Law 'n Justice elements carry a non-zero bonus and five of the
 * corpus pay 5,000,000 — and then the ball ended and the accumulator was thrown
 * away. Nothing else in the game reads it.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTINE, IN TWO HALVES
 * ---------------------------------------------------------------------------
 * The machine's bonus is an ENGINE half and a TABLE half. `$5136` in
 * main.seg00 is the engine's, called from the ball-end chain by `jsr $5136` at
 * +0x00504C; it multiplies, calls the table's own routine through the
 * descriptor, and adds the result to the score. The table's is reached through
 * DESCRIPTOR +$80 — a relocated code pointer, copied to `$236E(a5)` at load and
 * called at `$51BE` as `jsr ([$236e,a5])` — and it is the whole display.
 *
 * THE ENGINE HALF, +0x005136 to +0x00521C, complete:
 *
 *     005136  tst.b   $23ed(a5)        ; THE TILT FLAG
 *     00513A  bne.w   $521c            ; tilted -> past EVERYTHING below
 *     00513E  clr.l   $2438(a5)        ; the DISPLAY TOTAL, an 8-byte slot
 *     005142  clr.l   $243c(a5)        ; whose BCD field is $243A..$243F
 *     005146  movea.l $dc2(a5), a0     ; the current player record
 *     00514A  move.w  $12(a0), d0      ; ITS BONUS MULTIPLIER
 *     00514E  beq     $5152            ; note: NO `moveq #0,d0` on this arm
 *     005150  subq.w  #1, d0
 *     005152  clr.l   $2440(a5)        ; the PRODUCT, field $2442..$2447
 *     005156  clr.l   $2444(a5)
 *     00515A  lea     $2448(a5), a1    ; loop top — both pointers re-loaded
 *     00515E  lea     $10(a0), a2      ; the player's BONUS, +$0A..+$0F
 *     005162  andi.b  #$EF, ccr
 *     005166  abcd    -(a2), -(a1)     ; x6: product += bonus
 *     005172  dbra    d0, $515a
 *     005176  jsr     $91e / $6d5a / $c094 / $a770 / $63e0 / $64d0
 *     00519A  cmpi.b  #$54, $dff006 / bcs      ; raster wait
 *     0051A4  move.w  #$a000, $dff09a          ; interrupts back on
 *     0051AC  jsr     $6b06
 *     0051B2  clr.b   $d00b            ; THE LAST-KEY BYTE — see the abort below
 *     0051B8  lea     $5766.l, a4      ; the per-table service table
 *     0051BE  jsr     ([$236e,a5])     ; >>> THE TABLE'S OWN ROUTINE <<<
 *     0051C4  jsr     $6b06
 *     0051CA  movea.l $dc2(a5), a0
 *     0051CE  lea     $8(a0), a1       ; the player's SCORE, +$02..+$07
 *     0051D2  lea     $2440(a5), a2    ; the DISPLAY TOTAL
 *     0051D6  andi.b  #$EF, ccr
 *     0051DA  abcd    -(a2), -(a1)     ; x6: SCORE += the displayed total
 *     0051E6  move.w  $dbe(a5), d0 / addi.b #$31, d0 / move.b d0, $4547
 *     0051F4  lea     $453c.l, a0 / jsr $73d0   ; the "PL n" caption
 *     005200  movea.l $dc2(a5), a0 / addq.w #8, a0
 *     005206  move.w  #$140, d3 / #$2, d4 / #$1, d5 / #$1, d6 / jsr $71ba
 *     00521C  ...                      ; where the TILT branch lands
 *
 * so the score moves ONCE, in one `ABCD` chain, AFTER the display has finished.
 * There is no incremental count-up anywhere in the routine — no per-frame
 * decrement of the bonus, no per-frame add to the score, no `SBCD` in either
 * half. What the machine actually does is HOLD a static panel, and the film
 * agrees: across seventeen filmed ball ends the DMD is bit-identical frame to
 * frame for the whole window, maximum inter-frame difference 0.0000.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE HALF: THREE PANELS AND THEIR MEASURED DELAYS
 * ---------------------------------------------------------------------------
 * Law 'n Justice's is hunk 4 +0x29AE (BabeWatch +0x2A10, Extreme Sports
 * +0x29A0); `a4` is the engine's service table at `$5766`, whose entries are
 * `+$04` = $6CD0 (fire a record), `+$08` = $6B06, `+$0C` = $5230 (RUN d0
 * FRAMES), `+$10` = $71BA (draw a packed-BCD field), `+$14` = $73D0 (draw a
 * text record), `+$18` = $6DD0.
 *
 *     0029AE  lea     $9fb6.l, a0 / jsr ([$4,a4])   ; the END-STOP MUSIC RECORD
 *     0029BA  clr.l/clr.l $2438/$243c               ; total := 0
 *     0029C2  clr.b   $2b9a          ; the blink flag
 *     0029C8  move.b  #$8, $2b9b     ; EIGHT half-cycles
 *     0029D0  move.l/move.l $2440 -> $2438          ; total := product
 *     0029DC  tst.l $2440 / bne / tst.l $2444 / beq $2a5c   ; product 0 -> no flash
 *     0029E8  LOOP: jsr ([$8,a4])
 *     0029EE  lea     ([$dc2,a5],$10), a0   ; the RAW bonus, not the product
 *     0029F6  move.w  #$9e,d3 / moveq #$a,d4 / #$4,d5 / #$2,d6 / jsr ([$10,a4])
 *     002A06  lea     $2bc4(pc), a0 / jsr ([$14,a4])   ; the "BONUS" caption
 *     002A10  tst.b   $2b9a / bne $2a44               ; blink: only on the 0 phase
 *     002A18  movea.l $dc2(a5),a0 / move.w $12(a0),d7
 *     002A20  lsr.w #1,d7 / subq.w #1,d7 / bmi $2a44  ; the multiplier's caption
 *     002A26  movea.l ($01d0,PC,d7.w*4), a0          ; table of 5 at +0x2BF8
 *     002A2E  move.w  #$28,(a0) / jsr ([$14,a4])     ; drawn at x=40
 *     002A3A  move.w  #$118,(a0) / jsr ([$14,a4])    ; and again at x=280
 *     002A44  move.w  #$a,d0 / jsr ([$c,a4])         ; TEN FRAMES
 *     002A4E  not.b   $2b9a / subq.b #1,$2b9b / bne $29e8
 *     002A5C  jsr     ([$8,a4])
 *     002A62  move.w  $dbe(a5),d0                    ; the player index
 *     002A66  move.w  ($1ae8,PC,d0.w*2),d0           ; the COMBO COUNT, at +0x4550
 *     002A6C  beq.w   $2b48                          ; no combos -> skip
 *     002A70  clr.l/clr.l $2ba8/$2bac                ; the combo product
 *     002A7C  move.w d0,d1 / subq.w #1,d1
 *     002A80  lea $2bb0.l,a1 / lea $2ba8.l,a2 / andi #$EF,ccr / abcd x6 / dbra
 *                                                    ; comboValue x comboCount
 *     002AA0  lea $2440(a5),a1 / lea $2bb0.l,a2 / andi / abcd x6
 *                                                    ; total += the combo product
 *     002ABA..002B1E  builds "<n> COMBO" + "S" unless the count is exactly 1
 *     002B1E  lea $2bb0(pc),a0 / jsr ([$14,a4])      ; that caption
 *     002B28  lea $2bb0.l,a0 / ... / jsr ([$10,a4])  ; the combo product
 *     002B3E  move.w  #$64,d0 / jsr ([$c,a4])        ; ONE HUNDRED FRAMES
 *     002B48  jsr     ([$8,a4])
 *     002B4E  tst.l $2438 / bne / tst.l $243c / beq $2b84   ; total zero?
 *     002B5A  lea $2bd2(pc),a0 / jsr ([$14,a4])      ; "TOTAL BONUS"
 *     002B64  lea $2440(a5),a0 / ... / jsr ([$10,a4]); the total
 *     002B78  move.w  #$64,d0 / jsr ([$c,a4])        ; ONE HUNDRED FRAMES
 *     002B82  rts
 *     002B84  lea $2be6(pc),a0 / jsr ([$14,a4])      ; "NO BONUS"
 *     002B8E  move.w  #$96,d0 / jsr ([$c,a4])        ; ONE HUNDRED AND FIFTY
 *     002B98  rts
 *
 * The four text records are literal ASCII in the package — Law 'n Justice hunk
 * 4 has "BONUS" at +0x2BC4, "TOTAL BONUS" at +0x2BD2, "NO BONUS" at +0x2BE6 and
 * "0000 COMBOS" at +0x2BB0, each an 8-byte header {x, row, colour, ?} then the
 * text — so the captions are read, not invented. The multiplier captions are
 * five records at +0x2C0C/18/24/30/3C reading "X2" "X4" "X6" "X8" "X10", and
 * the same five on BabeWatch; EXTREME SPORTS has FOUR, "X2" "X3" "X4" "X5", and
 * indexes them with `subq.w #2,d7` (+0x2A12) where the other two use
 * `lsr.w #1,d7 / subq.w #1,d7`. Both formulas land on the caption that spells
 * the multiplier out, which is why `multiplierCaption` derives `X<n>` rather
 * than shipping a table: it reproduces all three tables exactly.
 *
 * THE DELAYS ARE THE SAME ON ALL THREE TABLES — 10 / 100 / 100 / 150 frames,
 * checked at Law 'n Justice +0x2A48/+0x2B42/+0x2B7C/+0x2B92, BabeWatch
 * +0x2AAA/+0x2B98/+0x2BD2/+0x2BE8 and Extreme Sports
 * +0x2A38/+0x2B32/+0x2B6C/+0x2B82.
 *
 * ---------------------------------------------------------------------------
 * THE FLASH AND THE MULTIPLY ARE FILM-MEASURED TOO, ON A REAL EARNED BONUS
 * ---------------------------------------------------------------------------
 * When this module was written no filmed ball had ever earned a bonus, so the
 * flash panel and the multiply shipped on the disassembly alone. Both have since
 * been filmed: `research\view\reference\session5` is one Law 'n Justice ball
 * that took the lower-level zone 13 shot, was paid element 14's 1,000,000 into
 * the accumulator and stepped its ladder onto award effect 5 for a multiplier of
 * two, and then drained with no key touched. Native resolution, one frame per
 * PAL frame, read back as the machine's own 160 x 16 dot matrix:
 *
 *   - EIGHT half-cycles, alternating, the FIRST one LIT; visible lengths
 *     9, 10, 10, 10, 10, 10, 10, 10. The nine is the same one-frame accounting
 *     as the 149-of-150 below: one of the first half-cycle's ten passes falls on
 *     the frame the text plane is still cleared on.
 *   - a LIT frame and a DARK frame differ in EXACTLY the two multiplier caption
 *     columns and in nothing else, so the blink is the caption alone.
 *   - the caption columns measure centre 38.5 and 278.5 on the 320-px strip —
 *     `move.w #$28,(a0)` and `move.w #$118,(a0)`, 240 apart, mirror-symmetric.
 *   - the flash shows 1,000,000, the RAW accumulator, not the 2,000,000 product.
 *   - `TOTAL BONUS` then holds for EXACTLY 100 frames, dot-identical on every
 *     one of them, showing 2,000,000.
 *   - the score goes 375,000 -> 2,375,000 in one step at the end, which is the
 *     multiply — `bonus x max(multiplier, 1)` — checked end to end.
 *
 * X4, X6, X8 and X10 (and Extreme Sports' X3/X5) are still decode-only: only a
 * multiplier of two has ever been filmed. So is the combo panel, whose count was
 * zero on this ball as on every other, and so is the abort, which this capture
 * deliberately never triggered.
 *
 * ---------------------------------------------------------------------------
 * THE 150-FRAME "NO BONUS" HOLD IS FILM-MEASURED, TO THE FRAME
 * ---------------------------------------------------------------------------
 * Seventeen end-of-ball events were read frame by frame out of the nine
 * gameplay captures. Thirteen showed a static `NO BONUS` panel and four were
 * tilted balls that showed no bonus panel at all. EIGHT of the thirteen ran
 * UNINTERRUPTED and every one of the eight lasted exactly 149 frames of visible
 * message — `#$96` is 150 service passes, and the last of them is the frame the
 * panel is replaced on. The decode and the film agree to one frame, eight times
 * over, on three different tables.
 *
 * THE FOUR SHORT ONES ARE THE ABORT, AND IT IS ALSO DECODED. `$5230` is the
 * frame-runner behind `jsr ([$c,a4])`:
 *
 *     005232  move.w  d0, $5288        ; frames to run
 *     005238  move.w  #$19, $528a      ; 25 passes of grace
 *     005240  LOOP: the six per-frame services
 *     005264  tst.w   $528a / bne $5276     ; still in grace -> just count down
 *     00526C  tst.b   $d00b / bne $5284     ; ANY KEY SINCE $51B2 -> exit early
 *     00527C  subq.w  #1, $5288 / bne $5240
 *
 * and `$d00b` is the last KEY-DOWN code, written by the keyboard handler at
 * +0x000850 (`btst #7,d0 / bne` rejects the key-up half). It is cleared once, at
 * `$51B2`, so the abort is sticky for the whole routine. The grace is spent by
 * passes 1..25, so pass 26 is the earliest exit — and the four shortened filmed
 * windows were 37, 44, 80 and 109 frames with a key-down inside each, the
 * shortest of them 26 frames of hold plus the original's own screen-mode
 * teardown. The film called the dismissal "well-supported but an inference";
 * `$5230` settles it, and settles which keys count: any of them, which is why
 * the capture where DEL — inert during play — dismissed the panel behaves the
 * same as the ones where ENTER and SHIFT did.
 *
 * A ten-frame delay can never reach pass 26, so THE FLASH IS NOT ABORTABLE and
 * always runs its full 80 frames. Only the 100- and 150-frame panels can be cut.
 *
 * ---------------------------------------------------------------------------
 * TILT FORFEITS IT, AND THE FILM SHOWS THAT TOO
 * ---------------------------------------------------------------------------
 * `$513A` branches past the multiply, past the table routine and past the score
 * add. A tilted ball pays nothing and shows nothing — not even "NO BONUS" — and
 * the accumulator is then cleared by `$427C` like any other. Four filmed tilted
 * balls confirm it: Extreme Sports take 3 balls 1 and 2 go from the TILT panel
 * straight to `PLAYER 1 / BALL n` with nothing between, and BabeWatch take 2
 * and Law 'n Justice's full game go from TILT straight to `GAME OVER`. It is
 * not only the last ball, which is all the earlier note had.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT RECONSTRUCTED, AND WHY
 * ---------------------------------------------------------------------------
 * THE COMBO TERM. The second half adds `comboValue x comboCount` on top, where
 * the count is a per-player word in a table this port has nothing to fill —
 * NOTHING IN THIS RECONSTRUCTION COUNTS COMBOS, and the only two references to
 * the table in the whole of Law 'n Justice hunk 4 are the two READS above
 * (+0x2A66 and +0x2B0E, both resolving to +0x4550; the table is all zeroes on
 * disk). Where it is written is undecoded, so the count is structurally zero
 * here and the stage never runs. The value it would be multiplied by IS decoded
 * — Law 'n Justice's six BCD bytes at hunk 4 +0x2BA2 read 000001000000, so a
 * combo is worth 1,000,000 — and `BonusPhase` carries the stage so that the day
 * combos are decoded the panel is already there to show them.
 *
 * THE PANEL GEOMETRY. `$73D0` and `$71BA` place their text with a row table and
 * a plane-pair selector this port's 320x16 panel does not model; the captions,
 * their order, their values and their durations are reproduced, the pixel
 * columns are `panel-renderer.ts`'s own. See `renderPanelInto`.
 */

import { addPackedBcd, addToBcdField, multiplyBcdField, newBcdField, readBcdField } from "./scoring.js";
import type { ScoringState } from "./scoring.js";

// ---------------------------------------------------------------------------
// The measured constants
// ---------------------------------------------------------------------------

/** Half-cycles of the flash loop: `move.b #$8,$2b9b` at hunk 4 +0x29C8. */
export const BONUS_FLASH_HALF_CYCLES = 8;

/** Frames in one half-cycle: `move.w #$a,d0` at +0x2A44. Four blinks in all. */
export const BONUS_FLASH_HALF_CYCLE_FRAMES = 10;

/** The whole flash: 8 x 10 frames, 1.6 seconds at 50 Hz. */
export const BONUS_FLASH_FRAMES = BONUS_FLASH_HALF_CYCLES * BONUS_FLASH_HALF_CYCLE_FRAMES;

/** The combo panel and the total panel: `move.w #$64,d0`, two seconds. */
export const BONUS_TOTAL_FRAMES = 100;

/** "NO BONUS": `move.w #$96,d0`, three seconds. Film-measured at 149 visible. */
export const BONUS_NONE_FRAMES = 150;

/**
 * The first pass on which `$5230` will look at the key byte.
 *
 * `$528a` starts at 25 and passes 1..25 spend it, so the test at +0x00526C
 * first runs on pass 26 and 26 is the shortest a delay can be made.
 */
export const BONUS_ABORT_GRACE_FRAMES = 26;

/**
 * What one COMBO is worth: the six packed-BCD bytes `00 00 01 00 00 00` the
 * combo loop multiplies, at Law 'n Justice hunk 4 +0x2BA2 and byte-identical at
 * BabeWatch +0x2BF8 and Extreme Sports +0x2B92.
 *
 * Read-only in all three packages — nothing points at it but the `ABCD` chain
 * walking back from +0x2BA8 — and unreachable here, because the count it is
 * multiplied by is always zero in this port. Kept because it is decoded, and
 * because the term it belongs to is written out rather than folded away.
 */
export const COMBO_VALUE_PER_COMBO = 1_000_000;

// ---------------------------------------------------------------------------
// The phase
// ---------------------------------------------------------------------------

/**
 * Which panel is up.
 *
 * `flash` is the multiplied bonus with its blinking multiplier caption,
 * `combo` the combo term, `total` the sum of the two, `none` the "NO BONUS"
 * hold that a ball with nothing to pay gets instead.
 */
export type BonusStageKind = "flash" | "combo" | "total" | "none";

interface BonusStage {
  readonly kind: BonusStageKind;
  readonly frames: number;
  /**
   * Whether a key can cut this panel short.
   *
   * FALSE FOR THE FLASH, and that is arithmetic rather than policy: the flash
   * is not one 80-frame delay but EIGHT ten-frame ones (+0x2A44 inside the loop
   * at +0x29E8), `$5230` re-arms its 25-pass grace on every call, and ten passes
   * never reach the twenty-sixth. The flash therefore always runs in full and
   * only the 100- and 150-frame holds can be dismissed.
   */
  readonly abortable: boolean;
}

/** One end-of-ball bonus, from the drain that started it to the score it pays. */
export interface BonusPhase {
  /** The stages this bonus will show, in order, decided when it started. */
  readonly stages: readonly BonusStage[];
  /** Which of them is up. Equal to `stages.length` once the phase is over. */
  at: number;
  /** Frames the current stage has been up. */
  framesShown: number;
  /**
   * A key has gone down since the phase started — the `$d00b` byte, which
   * `$51B2` clears once and nothing inside the routine clears again.
   */
  keyed: boolean;
  /** The accumulator as it stood at the drain, which the flash panel shows. */
  readonly bonus: number;
  /** The player record's `+$12` as it stood at the drain. */
  readonly multiplier: number;
  /** `bonus x max(multiplier, 1)`, the product `$5136` builds. */
  readonly product: number;
  /** The combo term. Structurally zero here; see the header. */
  readonly comboCount: number;
  readonly comboTotal: number;
  /** The display total: product plus combo term, and what the score is paid. */
  readonly total: Uint8Array;
}

/**
 * Builds the phase a drained ball owes, or null when it owes none.
 *
 * Null on a TILT, and that is the whole of `$513A`: no multiply, no panel, no
 * score. Everything else — including a ball that scored nothing at all — owes a
 * phase, because the zero case is not "skip it", it is the "NO BONUS" hold.
 *
 * The scoring state is READ, never written: the accumulator survives the phase
 * and is cleared afterwards by `clearBonusForNewBall`, which is `$427C` and
 * which the hold flags can veto.
 */
export function beginBonusPhase(scoring: ScoringState, tilted: boolean): BonusPhase | null {
  if (tilted) return null;

  const product = multiplyBcdField(scoring.bonus, scoring.multiplier);
  // THE COMBO TERM, and the one part of the routine this port cannot run. The
  // count is a per-player word at the counter object's `+$06`, and nothing here
  // fills it — see the header. Written out as a term rather than folded away so
  // that the stage list below reads as the routine does, and so that the day the
  // count is decoded there is one expression to change.
  const comboCount = 0;
  const comboValue = newBcdField();
  addToBcdField(comboValue, COMBO_VALUE_PER_COMBO);
  const comboProduct = comboCount === 0 ? newBcdField() : multiplyBcdField(comboValue, comboCount);

  // `$29D0` copies the product into the display total, and `$2AA0` adds the
  // combo term on top of it. The total is what the score is finally paid.
  const total = newBcdField();
  total.set(product);
  addPackedBcd(total, comboProduct);

  const stages: BonusStage[] = [];
  // `$29DC`: the flash runs only when the PRODUCT is non-zero, so a ball with a
  // bonus and a multiplier of zero still flashes (the product is bonus x 1).
  if (readBcdField(product) !== 0) {
    stages.push({ kind: "flash", frames: BONUS_FLASH_FRAMES, abortable: false });
  }
  if (comboCount !== 0) {
    stages.push({ kind: "combo", frames: BONUS_TOTAL_FRAMES, abortable: true });
  }
  // `$2B4E`: the TOTAL panel or, when there is nothing to total, "NO BONUS".
  stages.push(
    readBcdField(total) !== 0
      ? { kind: "total", frames: BONUS_TOTAL_FRAMES, abortable: true }
      : { kind: "none", frames: BONUS_NONE_FRAMES, abortable: true },
  );

  return {
    stages,
    at: 0,
    framesShown: 0,
    keyed: false,
    bonus: readBcdField(scoring.bonus),
    multiplier: scoring.multiplier,
    product: readBcdField(product),
    comboCount,
    comboTotal: readBcdField(comboProduct),
    total,
  };
}

/** True once every panel has had its frames and the score may be paid. */
export function bonusPhaseFinished(phase: BonusPhase): boolean {
  return phase.at >= phase.stages.length;
}

/** The panel up right now, or null once the phase is over. */
export function bonusStage(phase: BonusPhase): BonusStageKind | null {
  return phase.stages[phase.at]?.kind ?? null;
}

/**
 * Advances one frame.
 *
 * `keyDown` is the `$d00b` write: true on any tick a control went down. It
 * latches, because the byte does — `$51B2` clears it once, before the table
 * routine, and nothing inside clears it again, so one tap shortens every
 * abortable panel that follows it and not merely the one it landed in.
 */
export function stepBonusPhase(phase: BonusPhase, keyDown: boolean): void {
  if (bonusPhaseFinished(phase)) return;
  if (keyDown) phase.keyed = true;

  const stage = phase.stages[phase.at];
  if (stage === undefined) return;
  phase.framesShown += 1;

  const ranOut = phase.framesShown >= stage.frames;
  // The early-out, exactly as `$5230` reaches it: the grace has to be spent
  // first, and a stage made of ten-frame delays never spends one.
  const dismissed =
    stage.abortable && phase.keyed && phase.framesShown >= BONUS_ABORT_GRACE_FRAMES;
  if (!ranOut && !dismissed) return;

  phase.at += 1;
  phase.framesShown = 0;
}

/**
 * True while the multiplier caption is lit.
 *
 * `$2b9a` starts cleared (+0x29C2) and is `not.b`-ed at the END of each
 * half-cycle (+0x2A4E), and the caption is drawn only when it reads zero
 * (`tst.b / bne` at +0x2A10). So the first ten frames are lit, the next ten
 * dark, four times over. False outside the flash panel, and false when there is
 * no multiplier caption to show — `bmi` at +0x2A24 on Law 'n Justice and
 * BabeWatch skips it for a multiplier below 2, which is the value every ball
 * starts with.
 */
export function bonusMultiplierLit(phase: BonusPhase): boolean {
  if (bonusStage(phase) !== "flash") return false;
  if (phase.multiplier < 2) return false;
  const half = Math.floor(phase.framesShown / BONUS_FLASH_HALF_CYCLE_FRAMES);
  return half % 2 === 0;
}

/** The caption over the current panel, or "" once the phase is over. */
export function bonusCaption(phase: BonusPhase): string {
  const stage = bonusStage(phase);
  if (stage === "flash") return "BONUS";
  if (stage === "total") return "TOTAL BONUS";
  if (stage === "none") return "NO BONUS";
  // "<n> COMBO", plus an "S" unless the count is exactly one: the digits are
  // built at +0x2ABA..+0x2B1A with leading zeroes stripped and the `cmpi.w #$1`
  // at +0x2B0C deciding the plural.
  if (stage === "combo") return `${phase.comboCount} COMBO${phase.comboCount === 1 ? "" : "S"}`;
  return "";
}

/**
 * The number under the caption.
 *
 * The flash panel shows the RAW accumulator, not the product — `$29EE` draws
 * `player+$10`, which is the bonus field's end pointer — and the total panel
 * shows the display total. It is the multiplier caption beside the raw figure
 * that tells the player what it is about to become.
 */
export function bonusValue(phase: BonusPhase): number {
  const stage = bonusStage(phase);
  if (stage === "flash") return phase.bonus;
  if (stage === "combo") return phase.comboTotal;
  if (stage === "total") return readBcdField(phase.total);
  return 0;
}

/** The multiplier caption, e.g. `X4`, or "" when there is none. See the header. */
export function bonusMultiplierCaption(phase: BonusPhase): string {
  return phase.multiplier < 2 ? "" : `X${phase.multiplier}`;
}
