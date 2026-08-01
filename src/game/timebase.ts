/**
 * THE TIMEBASE: what one tick is, and what one of the original's numbers means
 * in this port's units.
 *
 * Every velocity and every acceleration decoded off the disks arrives as a small
 * signed word, and none of them means anything until you know how often the
 * original applied it and how far it moved the ball when it did. This file is
 * that answer, measured, in one place, so that nothing downstream has to guess
 * and nothing downstream can disagree.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS: THE BALL WAS IN SPACE
 * ---------------------------------------------------------------------------
 * This project ran for its whole life on a gravity of 24 Q10 per tick squared,
 * inherited as a chosen value from the sibling Pinball Dreams reconstruction and
 * never measured. At 24 a ball falls the playfield's 600 px in about 226 ticks —
 * four and a half seconds. A real machine crosses the table in about one. The
 * defect was found by PLAYING, not by measuring, and it could not have been
 * caught by the suite as it stood: every physics test asserted a DIRECTION (the
 * ball falls, reaches the flippers, drains) and not one asserted a RATE. The
 * rate tests in `tests/timebase.test.ts` are the answer to that, and they are
 * the tests whose absence let this ship.
 *
 * The measured gravity is 128, and the port was 16/3 = 5.33x too weak.
 *
 * ---------------------------------------------------------------------------
 * THE FRAME
 * ---------------------------------------------------------------------------
 * One physics tick is one PAL video frame, 50 Hz. The tick is main.seg00
 * +0x00A618 and each of its seven call sites (+0x0049D4, +0x004D5C, +0x004DB2,
 * +0x004E60, +0x004ED6, +0x004F5C, +0x004FDA) sits in a loop that ends on a
 * raster wait — `cmpi.b #$54,$dff006.l / bcs` — so one iteration is one frame
 * and one call of the tick.
 *
 * `$50(a5)`, which the brief asked us to establish, is NOT a game constant at
 * all. It is read out of the OS at +0x00040E:
 *
 *     000408  movea.l (a5), a6            ; ExecBase
 *     00040E  move.b  $212(a6), d0        ; ExecBase->VBlankFrequency
 *     000412  move.w  d0, $50(a5)
 *
 * so it is 50 on PAL and 60 on NTSC, and its seventeen uses are all `mulu.w` or
 * `divu.w` converting whole SECONDS to frames and back. It anchors every
 * duration in the game — the WAIT opcode, the option records expressed in
 * seconds — and it is not a free parameter of the physics. This port's 50 Hz
 * tick is one original frame, exactly.
 *
 * ---------------------------------------------------------------------------
 * THE SUB-STEP, AND THE HALF THAT EVERY EARLIER READING MISSED
 * ---------------------------------------------------------------------------
 * The tick is unrolled into FOUR collision passes, each followed by TWO calls of
 * the integrator at +0x00B6E8 (+0x00A660/666, +0x00A6AA/6B0, +0x00A6F4/6FA,
 * +0x00A73C/742). Eight integrations per frame. That much was already known here
 * and is what made "the port applies once per tick what the original applies
 * eight times" look like an 8x error.
 *
 * It is not 8x, and the reason is two instructions:
 *
 *     00B70A  movem.w $e(a4), d0-d1     ; vx, vy, sign-extended to long
 *     00B710  asr.w   #$1, d0
 *     00B712  asr.w   #$1, d1           ; <- THE HALVING
 *     00B714  add.l   $1e(a4), d0       ; posX(Q10) += vx>>1
 *     00B718  add.l   $22(a4), d1       ; posY(Q10) += vy>>1
 *     00B71C  movem.l d0-d1, $1e(a4)
 *     00B722  moveq   #$a, d2
 *     00B724  asr.l   d2, d0            ; >>10 -> whole pixels
 *     ...
 *     00B754  add.w   $e8c(a5), d0      ; ax += table x-tilt option
 *     00B758  add.w   $e86(a5), d1      ; ay += GRAVITY
 *     00B768  add.w   d0, $e(a4)        ; vx += ax
 *     00B76C  add.w   d1, $10(a4)       ; vy += ay
 *
 * Each sub-step moves the ball by HALF its velocity, so eight sub-steps travel
 * 4v per frame, not 8v. And the `asr.l #10` proves the original's position is
 * Q10 pixels — the same 1024-per-pixel this port already uses — so the bridge is
 * forced rather than chosen:
 *
 *     1 ORIGINAL VELOCITY UNIT      = 4 Q10 per tick        (8 x v/2)
 *     1 ORIGINAL ACCELERATION UNIT  = 32 Q10 per tick^2     (8 x 4)
 *
 * An independent confirmation of the velocity unit, which does not go through
 * the integrator at all: the engine clamps velocity to +-4095 (`move.w #$f001`
 * / `#$0fff` at +0x00B4D6 and +0x00B692). 4095>>1 = 2047 Q10 is 1.999 px, i.e.
 * the clamp is chosen so a ball moves at most 2 px between collision passes.
 * That only makes sense at 4 Q10 per frame per unit.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PORT USED TO BELIEVE, AND WHY IT NEVER CAUGHT ITSELF
 * ---------------------------------------------------------------------------
 * `table-accel.ts` derived its bridge as
 *
 *     (PLUNGER_REFERENCE_GRAVITY * 8) / (4 * 8)
 *
 * which cancels the eights and is just 24/4 = 6. It never used the sub-step
 * count at all: it asserted "32 original units per frame == 24 Q10 per tick",
 * i.e. that one original velocity unit was one Q10 per tick. It is four. That
 * missing factor of four, times the arbitrary 24/32, is exactly the 16/3.
 * `surface-physics.ts` then derived its VELOCITY bridge from the same constant,
 * so the two were consistent with each other and both wrong.
 *
 * ---------------------------------------------------------------------------
 * THE PLAUSIBILITY BRACKET AGREES, AND WHERE IT DOES NOT, THE CODE WINS
 * ---------------------------------------------------------------------------
 * Two brackets built only from data already decoded off the disks, neither of
 * them touching the integrator:
 *
 *   - THE DEVICE KICKS. Requiring the slingshot (14000 Q10), the kicker (12000)
 *     and the pop bumper (22000) each to throw a ball a plausible distance puts
 *     gravity in 106..209 Q10. Contains 128; excludes 24 by 4.4x. At 24 the
 *     slingshot throws a ball 3987 px — six and a half table lengths.
 *   - THE RAMP DRIVE. Gravity and the drive vectors share units, so their ratio
 *     is scale-free: drives run 1..15 against a gravity of 4, i.e. 0.25x to
 *     3.75x. At the old bridge gravity was 0.75 of a drive unit — BELOW the
 *     smallest value the shipped data uses anywhere — so every driven block on
 *     every table would have out-pulled gravity.
 *
 * ONE BRACKET DISAGREES AND IS RECORDED RATHER THAN OBEYED. Dimensionally, the
 * ball's 17 px is a 27 mm pinball and the 336 px playfield is a 20.25 inch one,
 * both giving about 640 px per metre; a real 6-7 degree table would want
 * 265..320 Q10 per tick squared and a full-table fall of about 1.3 s. The disk's
 * DEFAULT of 4 gives 128 and a 1.98 s fall, an effective incline of about 2.9
 * degrees. Pinball Illusions shipped a deliberately shallow table. It is a
 * scrolling window and the player needs the reaction time, and every Amiga
 * pinball game of the era made the same choice. The disk's MAXIMUM setting (8 ->
 * 256 Q10, 1.39 s) lands squarely inside the real-table bracket, which is the
 * cleanest possible statement of what the slider is for. WE FOLLOW THE CODE:
 * gravity is the shipped default, 128.
 */

import type { Q10 } from "../core/fixed-point.js";

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * Physics ticks per second: 50, one per PAL video frame.
 *
 * MEASURED, and measured as being read from the OS rather than as a constant:
 * `$50(a5)` is `ExecBase->VBlankFrequency`, the byte at ExecBase+0x212, copied
 * at main.seg00 +0x00040E and again at +0x00068E. On the target machine it is
 * 50. Nothing in the game counts sub-steps; every timer counts FRAMES.
 */
export const TICKS_PER_SECOND = 50;

/** Whole ticks in `seconds`, the `moveq #N,d0 / mulu.w $50(a5),d0` pattern. */
export function secondsToTicks(seconds: number): number {
  return seconds * TICKS_PER_SECOND;
}

// ---------------------------------------------------------------------------
// The sub-step
// ---------------------------------------------------------------------------

/** Collision passes the unrolled tick at +0x00A618 runs. MEASURED: four. */
export const ORIGINAL_COLLISION_PASSES_PER_FRAME = 4;

/** Calls of the integrator per collision pass. MEASURED: two. */
export const ORIGINAL_INTEGRATIONS_PER_PASS = 2;

/**
 * Integration sub-steps the original ran per 50 Hz frame: EIGHT.
 *
 * MEASURED at +0x00A660/666, +0x00A6AA/6B0, +0x00A6F4/6FA, +0x00A73C/742.
 * +0x00B6E8 is the only routine in the engine that moves a ball under its own
 * velocity — the collision entry at +0x00A7E0 clears three fields and calls the
 * bounce, and never touches $1e/$22.
 */
export const ORIGINAL_SUBSTEPS_PER_FRAME =
  ORIGINAL_COLLISION_PASSES_PER_FRAME * ORIGINAL_INTEGRATIONS_PER_PASS;

/**
 * Q10 the ball advances per frame for one unit of the original's velocity word.
 *
 * FOUR, and forced: eight sub-steps of `pos += v >> 1`. The `asr.w #1` at
 * +0x00B710/+0x00B712 is the whole reason this is not eight.
 */
export const Q10_PER_ORIGINAL_VELOCITY_UNIT: Q10 =
  ORIGINAL_SUBSTEPS_PER_FRAME / 2;

/**
 * Q10 per tick squared for one unit of the original's per-SUB-STEP acceleration.
 *
 * THIRTY-TWO: the accel is added to the velocity once per sub-step, eight times
 * a frame, and each of those velocity units is worth four Q10 of travel.
 */
export const Q10_PER_ORIGINAL_ACCEL_UNIT: Q10 =
  ORIGINAL_SUBSTEPS_PER_FRAME * Q10_PER_ORIGINAL_VELOCITY_UNIT;

/**
 * Converts one of the original's VELOCITY words to Q10 per tick.
 *
 * Truncating rather than rounding, so the result is a function of the integers
 * and nothing here depends on a floating-point mode. (Every call site passes a
 * whole number, so the truncation never actually fires; it is there so that it
 * cannot start mattering silently.)
 */
export function originalVelocityToQ10(units: number): Q10 {
  return Math.trunc(units * Q10_PER_ORIGINAL_VELOCITY_UNIT);
}

/** Converts one of the original's per-sub-step ACCELERATION words to Q10/tick^2. */
export function originalAccelerationToQ10(units: number): Q10 {
  return Math.trunc(units * Q10_PER_ORIGINAL_ACCEL_UNIT);
}

// ---------------------------------------------------------------------------
// Gravity
// ---------------------------------------------------------------------------

/**
 * The gravity option, `tableNNN.opt` record 1: (min 2, max 8, cur, DEFAULT 4).
 *
 * MEASURED, and it is an OPTION RECORD rather than a code literal. The loader
 * reads 70 bytes of `tableNNN.opt` at +0x00333C, resets every record's current
 * to its default at +0x0009E6 (`move.w $6(a0),$4(a0)`, seven times), and copies
 * the seven currents into $E84..$E90 at +0x0009FE. Record 1 lands in $E86(a5),
 * which is added to the ball's Y acceleration at +0x00B758 — once per sub-step,
 * with no multiply, no shift and no per-table factor anywhere on the path.
 * $E86 has exactly two readers in the whole 53 KB segment: +0x003504, which
 * seeds a new ball's cached acceleration, and +0x00B758, which is the add.
 *
 * The stored "current" is 0 on every shipped file and 0 is outside 2..8, so the
 * reset-to-default is not optional: the shipping gravity IS 4. The player can
 * pick 2..8 from the options screen.
 */
export const ORIGINAL_GRAVITY_MIN = 2;
export const ORIGINAL_GRAVITY_MAX = 8;
export const ORIGINAL_GRAVITY_DEFAULT = 4;

/**
 * The simulation's downward acceleration, in Q10 per tick squared: 128.
 *
 * MEASURED. The shipped option value of 4, times the 32 Q10 per tick squared one
 * unit of per-sub-step acceleration is worth. A ball dropped from rest falls the
 * playfield's 600 px in 98 ticks — 1.96 seconds — where the port's old 24 took
 * 226 ticks and 4.5 seconds.
 *
 * It replaces `PLUNGER_REFERENCE_GRAVITY`, which lived in `plunger.ts` because
 * the launch ceiling was the only thing thought to depend on it. Gravity is not
 * a property of the plunger; it is the timebase, and it lives here now.
 */
export const SIMULATION_GRAVITY: Q10 =
  ORIGINAL_GRAVITY_DEFAULT * Q10_PER_ORIGINAL_ACCEL_UNIT;

/** Gravity for one setting of the shipped 2..8 slider, for tests and tooling. */
export function gravityForOption(setting: number): Q10 {
  if (
    !Number.isInteger(setting) ||
    setting < ORIGINAL_GRAVITY_MIN ||
    setting > ORIGINAL_GRAVITY_MAX
  ) {
    throw new RangeError(
      `gravity option must be a whole number in ${ORIGINAL_GRAVITY_MIN}..${ORIGINAL_GRAVITY_MAX}: ${setting}`,
    );
  }
  return setting * Q10_PER_ORIGINAL_ACCEL_UNIT;
}

/**
 * The TABLE X-TILT option, `tableNNN.opt` record 4: (min -3, max +3, DEFAULT 0).
 *
 * MEASURED and deliberately not applied. $E8C(a5) is added to the X acceleration
 * beside gravity at +0x00B754 and read nowhere else except +0x0034FC, where it
 * seeds a new ball. It DOES NOT SCALE GRAVITY — full scale is +-96 Q10 per tick
 * squared of sideways drift, up to three quarters of gravity — and the shipped
 * default is zero on all three tables, so the simulation runs with no lateral
 * lean and this constant records the range rather than steering anything.
 */
export const ORIGINAL_X_TILT_MIN = -3;
export const ORIGINAL_X_TILT_MAX = 3;
export const ORIGINAL_X_TILT_DEFAULT = 0;
export const SIMULATION_X_TILT: Q10 = ORIGINAL_X_TILT_DEFAULT * Q10_PER_ORIGINAL_ACCEL_UNIT;

// ---------------------------------------------------------------------------
// The velocity clamp
// ---------------------------------------------------------------------------

/**
 * The original's velocity clamp: +-4095 units on each axis.
 *
 * MEASURED, twice over, at +0x00B4D6 (`move.w #$f001,d4 / #$0fff,d5`, applied
 * with the nudge bias in) and again at +0x00B692 (with it out). It is the single
 * strongest independent check on the unit bridge: 4095>>1 is 2047 Q10, one
 * whisker under 2 px, so the clamp is exactly "the ball may not move more than
 * two pixels between collision passes".
 */
export const ORIGINAL_VELOCITY_CLAMP = 4095;

/**
 * The same clamp in this port's units: +-16380 Q10 per tick, i.e. 16 px a tick
 * or 800 px a second.
 *
 * This port used to clamp at the signed-16-bit limit of 32767, which is not a
 * number the original can produce and was only ever a guard against overflow in
 * `q10IntegrateSigned16Velocity`. The measured bound is half that and is a real
 * behaviour: it is what stops a flipper tip, whose measured stroke can throw a
 * ball at 17.7 px a tick, from putting a ball through a wall.
 */
export const VELOCITY_CLAMP_Q10: Q10 =
  ORIGINAL_VELOCITY_CLAMP * Q10_PER_ORIGINAL_VELOCITY_UNIT;

// ---------------------------------------------------------------------------
// The bat's angle scale
// ---------------------------------------------------------------------------

/**
 * Angle units in a full turn of the original's FLIPPER angle, and units per
 * drawn pose.
 *
 * MEASURED from the animation at +0x00BD46: the bat's angle word at $12 of the
 * flipper record is shifted right by six (`asr.w #6` at +0x00BDB8) to give a
 * POSE OFFSET, which is added to the record's base pose and wrapped modulo
 * $78 = 120 (+0x00AEF8..+0x00AF10). 120 poses to a turn is the three degrees a
 * frame that `flippers.ts` already measured out of `flipdat1.bin`, so one angle
 * unit is 3/64 of a degree and a turn is 7680 of them.
 */
export const ORIGINAL_ANGLE_UNITS_PER_POSE = 64;
export const ORIGINAL_POSES_PER_TURN = 120;
export const ORIGINAL_ANGLE_UNITS_PER_TURN =
  ORIGINAL_ANGLE_UNITS_PER_POSE * ORIGINAL_POSES_PER_TURN;

/**
 * Times the bat's angle is advanced per 50 Hz frame: FOUR.
 *
 * MEASURED, and this is the number the brief listed as unfound. The flipper
 * animation is not a routine of its own — it is the tail of $BC24, entered at
 * +0x00BD46 with no `rts` between it and the entry point, and $BC24 is called
 * once per COLLISION PASS: +0x00A65A, +0x00A6A4, +0x00A6EE, +0x00A736, and four
 * times again in each of the two no-ball paths at +0x00A750 and +0x00A770.
 * Four, not one and not eight.
 */
export const ORIGINAL_FLIPPER_STEPS_PER_FRAME = ORIGINAL_COLLISION_PASSES_PER_FRAME;
