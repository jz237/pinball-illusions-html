/**
 * THE MISSION MACHINE: the interpreter that runs the decoded mode bytecode.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MISSING, AND WHAT THIS IS
 * ---------------------------------------------------------------------------
 * Until now a mode START awarded its 500,000 and nothing else happened: the
 * mission itself never ran, because the thing the mode records point at was
 * being read as a data record when it is a PROGRAM. `jsr $6C10` is seven
 * instructions and appends to a 64-slot ring; the interpreters are elsewhere.
 * This module is those interpreters, and `table-modes.ts` loads the programs.
 *
 * There are two of them and they share one 31-entry dispatch table:
 *
 *   THE BACKGROUND QUEUE, main.seg00 0x58BC. Scripts fired by a physical shot go
 *   here. It runs ONE OPCODE PER FRAME: if `$239A(a5)` holds a record it
 *   continues that one, otherwise it dequeues the next. A twenty-instruction
 *   script therefore takes twenty frames, which is why arming a bank of targets
 *   visibly ripples rather than happening at once.
 *
 *   THE MISSION INTERPRETER, main.seg00 0x57AC/0x57B0. It runs the single script
 *   in `$daa(a5)` and owns the wait machinery: `$d9c` suspends it, `$db2` is the
 *   element it is watching, `$dae` the frames left, `$db6` the PC to resume at.
 *   One mission at a time — `MODE_START` is a no-op while `$d9b` is set.
 *
 * ---------------------------------------------------------------------------
 * HOW A MISSION ACTUALLY PROGRESSES, WHICH IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * A mission is a chain of `START` / `WAIT` pairs. `START` sets the per-player
 * ARMED bit of an element — the shot is now lit. `WAIT` parks the mission on
 * that element with a timeout. Meanwhile the player shoots; the surface id or
 * the zone under the ball is bound to a script; that script runs `AWARD` on the
 * element, which CLEARS the armed bit and pays the element's packed-BCD score.
 * The mission's wait sees the bit go out and falls through to the next
 * instruction. If instead the timer runs out first, the wait branches to its
 * third operand, which is the mission's timeout path.
 *
 * So the join between the physics and the rules is one bit per element, and the
 * rest of this file is bookkeeping around it.
 *
 * ---------------------------------------------------------------------------
 * MEASURED, RECONSTRUCTED, AND DELIBERATELY DIFFERENT
 * ---------------------------------------------------------------------------
 * MEASURED, from the disassembly quoted above and in the exporter:
 *   - the queue, the two interpreters, one opcode per frame, one mission at a time
 *   - the wait: timeout first, then the armed bit, then fall through
 *   - `AWARD`'s refusals (done bit set, or armed bit already clear) and its
 *     packed-BCD payment through $6B96
 *   - `BALLS_UP_TO`'s ceiling of three, and `BALL_REMOVE` taking a lock
 *     device's held ball off the table into the trough
 *   - award effects 6 (the COUNT DISPATCH — the multiball lock ladder, see
 *     `applyAwardEffect`), 21 (advance the ladder) and 23 (add time)
 *   - the AWARD relight for elements whose flags carry a bit of $A, which is
 *     what keeps a lock-lit lamp lit across its own award (0x5CA8)
 *   - `SET_COUNT` writing a counter record's per-player counts (0x5C64), which
 *     is how BabeWatch's jackpot missions arm the multiball tiers
 *   - `PUSH`/`PUSH_LINKED` on a lock DEVICE record ejecting the held ball
 *     (0x5BFC/0x5C14 push it at `$23DC`, the popper 0x7078 ejects), and the
 *     exporter's "element" reading of those operands being a misclassification
 *
 * RECONSTRUCTED, and labelled `RECONSTRUCTION` at each site:
 *   - `TICKS_PER_SECOND`. The engine multiplies a wait's operand by `$50(a5)`,
 *     which is loaded from a system field rather than being an immediate, so the
 *     constant is not pinned in the code. 50 is used because everything else in
 *     this reconstruction is per PAL field.
 *   - a `WAIT` with no element and no timer falls through immediately. The
 *     engine would sit there forever; nothing in the shipped data does it, and a
 *     reconstruction that can deadlock is not one worth shipping.
 *
 * DELIBERATELY DIFFERENT, and this one is a divergence rather than a gap: the
 * original REFUSES TO END THE BALL while a mission is running (0x4F12-0x4F28
 * will not advance the game state while `$daa(a5)` is non-zero, so the epilogue
 * always finishes). This reconstruction ends the mission when the ball ends
 * instead. Reproducing the original would make every mission a potential hang —
 * the ball is already gone, so nothing can advance the script — and the ball
 * search cannot help because there is no ball to search for.
 *
 * ---------------------------------------------------------------------------
 * EIGHT OPCODES DO NOTHING, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `KICK_IF`, `LINK_RESTORE`, `SET_VALUE`, `RESET_GROUP`, `RESTORE_POS`,
 * `CLEAR_BYTE`, `SET_MAX` and `SET_COUNT_SELF` take a pointer to a record type
 * nobody has identified — their operands fail the packed-BCD test that every
 * real element passes, which is how they were caught. Guessing at them would
 * put invented behaviour into the middle of a decoded mission. They are counted
 * in `ModeTickReport.unimplemented` so the cost of not knowing is visible
 * rather than silent. `SET_COUNT` used to be on this list; its record is now
 * identified (the effect-6/effect-21 counter record) and its handler decoded,
 * so it runs — except where its record hosts no decoded ladder, which is still
 * counted.
 */

import { deviceFlagId, zoneFlagId } from "./scoring.js";
import {
  COUNTER_FLAG_REBUILD_ACCUMULATOR,
  ELEMENT_FLAG_LIT_AT_GAME_START,
  GROUP_FLAG_KEEP_ALWAYS_ON,
  GROUP_FLAG_SUPPRESS_FIRE,
} from "./table-modes.js";
import type { LockDevice, ModeElement, ModeScript, TableModes } from "./table-modes.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * RECONSTRUCTION. Frames a `WAIT`'s time operand is worth.
 *
 * The handler at 0x5E16 multiplies the operand by `$50(a5)` and the display
 * divides `$dae` by the same word, so the operand is in whole display units —
 * seconds — and the number the player reads is the number in the script. What is
 * NOT pinned is the multiplier itself: `$50(a5)` is written at 0x0414 and 0x0690
 * from a byte at `$212(a6)`, a system field, not an immediate. 50 is the PAL
 * field rate this whole reconstruction is built on, so the wall-clock durations
 * here are the PAL ones.
 */
export const TICKS_PER_SECOND = 50;

/** Slots in the background ring at `$2396(a5)`: `andi.w #$3f` at 0x6C26. */
export const MODE_QUEUE_SLOTS = 64;

/** The engine's own ceiling on `BALLS_UP_TO`: `cmpi.w #$3,d1 / bhi` at 0x5BD0. */
export const MODE_MAX_BALLS = 3;

/** Opcode indices this module acts on. Names are in the shipped opcode table. */
const OP_END = 0;
const OP_START = 1;
const OP_START_TIMED = 2;
const OP_COMPLETE = 3;
const OP_AWARD = 5;
const OP_PUSH = 8;
const OP_MODE_START = 9;
const OP_JMP = 10;
const OP_SET_BALL_SAVE = 11;
const OP_CLEAR_DONE = 12;
const OP_LAMP_OFF = 14;
/**
 * The running-step opcodes. The exporter's names are kept — they were given
 * before the record types were known and renaming them would break the operand
 * table's join with the shipped documents — but the handlers are:
 * 6 = restore the step, 7 = set the step, 13 = reset the whole record,
 * 15 = start a ramp, 16 = stop a ramp, 18 = set the accumulator.
 */
const OP_LINK_RESTORE = 6;
const OP_SET_VALUE = 7;
const OP_RESET_GROUP = 13;
const OP_RAMP_START = 15;
const OP_RAMP_STOP = 16;
const OP_SET_MAX = 18;
const OP_MESSAGE = 17;
/**
 * Opcode 19: POST A MUSIC COMMAND. Decoded; it used to be called OP_ANIMATE on
 * nothing but the shape of its handler. The dispatch at 0x58FC bases its
 * handlers at 0x5916 (`jsr ($0E,PC,D0.w)` at 0x5906, extension word at
 * 0x5908), and the table entry at 0x5912 + 4*19 is {disp $0228, len 6}, so the
 * handler is +0x005B3E — two instructions:
 *
 *     005B3E  movea.l $2(a1),a0
 *     005B42  bra.w   $6868
 *
 * and $6868 is the music player's MAILBOX POSTER: the kind-4 record's command
 * (+$2), order position (+$4) and bank (+$6) go to $2412/$2416/$2418, which
 * the player reads on its next frame. It does not go through the record
 * dispatcher $6CD0 at all, so the operand is ALWAYS a music record.
 *
 * That makes this the instruction a mission switches its background tune with:
 * the missions open with a `-2 <mode section>` and close with `-2 pos 1` or
 * the queued `-1 pos 1` back to the main tune. The simulation has no idea what
 * a tune is — it reports the SITE it executed (this script's index and this
 * instruction's pc, both indices into data it already owns, exactly as
 * `messagesShown` reports display records) and `src/browser/table-music.ts`
 * resolves it through the music manifest's own decode. Nothing flows back.
 */
const OP_MUSIC = 19;
const OP_NATIVE = 20;
const OP_SET_COUNT = 21;
const OP_JMP_IF_UNLIT = 23;
const OP_PUSH_LINKED = 24;
/**
 * Opcode 25: GO TO THE WIDE VIEW, if option record 6 allows it.
 *
 * MEASURED, and it used to be called OP_IF_TWO_PLAYER on nothing more than the
 * shape of its handler. +0x005A26 is `cmpi.w #2,$e90(a5) / bne -> rts /
 * jsr $3c52`, where $3C52 is the wide-screen setup (BPLCON0 $8214: HIRES, LACE,
 * eight planes; BPLxMOD $2D0 = 2*384-48, so each displayed line steps two
 * playfield rows) and $E90 is option record 6, the view mode. Its table entry is
 * at 0x5912 + 4*25 with a length word of 2, so it takes no operands; the
 * numbering is anchored by opcode 27 at 0x5BCC, which this file already knows as
 * OP_BALLS_UP_TO.
 *
 * It is the multiball camera switch this project has been carrying as [src], and
 * it is script-driven rather than a ball-count rule. Still routed to
 * `unimplemented`: this port reframes to the whole table on ball count (see
 * `camera.ts`), which is documented behaviour, and swapping that for a scripted
 * mode change needs the wide view's 462-row interlaced geometry first.
 */
const OP_VIEW_WIDE = 25;
const OP_BALL_REMOVE = 26;
const OP_BALLS_UP_TO = 27;
const OP_WAIT = 28;
const OP_DBNZ = 29;
const OP_SET_RESUME = 30;
const OP_SET_LOOP = 31;

/** Award effects with decoded handlers. Everything else is left alone. */
const EFFECT_HOLD_BONUS = 2;
const EFFECT_SET_MULTIPLIER = 5;
/**
 * THE FOUR EFFECTS THAT STEP A PROGRESS COUNTER, and one that steps it back.
 *
 * The dispatch table at 0x5D0E is TWENTY-EIGHT LONGWORDS — 0x5D0E + 4*28 is
 * 0x5D7E, which is effect 0's own handler, and the words past it are not
 * relocated — and five of the twenty-eight reach `+$06 + 2p` of the record at the
 * element's +$34:
 *
 *      6  0x5E5A  count++, total++, continuation at the cap, then the launcher
 *                 walk at 0x5EAA WITH the launch (0x5E9E queues entry+$04)
 *     16  0x5E4E  `bsr $5FE4` (the record's BCD accumulator += its step),
 *                 `bsr $5E5A` (all of the above), `bsr $61AA` (the accumulator
 *                 is paid to the player's SCORE through $6BCC)
 *     18  0x5E46  the first two of those three, without the score payment
 *     21  0x5FA8  the same body as 0x5E5A and the same launcher walk, but its
 *                 tail is `bsr.w $5EAA / rts` — the matched entry is NOT queued
 *     24  0x6220  `tst.w $6(a0,d6.w*2) / beq` then subq #1 on both words
 *
 * SIXTEEN AND EIGHTEEN ARE WHY THIS EXISTS: Law 'n Justice's six combo shots are
 * effect-16 elements, and until the count moved for them the combo term of the
 * end-of-ball bonus could only ever be zero.
 *
 * THE OTHER HALF OF THE RECORD — ITS OWN BCD SCORING — RUNS NOW TOO:
 *
 *      7  0x61AA  the ACCUMULATOR (+$3A..$3F) is paid to the player's SCORE
 *                 through $6BCC — score only; the two-field payer $6B96 is the
 *                 element award's own
 *     11  0x5FE4  the record's packed-BCD STEP (+$32..$37) is added into the
 *                 accumulator (six backwards `abcd`), falling straight through
 *                 into the clamp at 0x6000: an accumulator past the record's
 *                 +$40..$47 BCD TARGET is written back as exactly it, and a
 *                 negative high long ($FFFFFFFF, `bmi` at 0x600A) means none
 *     16, 18      both call 0x5FE4 BEFORE their shared count body, so a count
 *                 already at its cap still grows the accumulator; 16's third
 *                 call is 0x61AA, the payment
 *     20  0x620E  the WINDOW: counter +$26 := element +$38 seconds x $50(a5)
 *                 ticks — and $50(a5) is ExecBase VBlankFrequency, read at
 *                 +0x00040E, 50 on the PAL machine this reconstruction is.
 *                 The per-frame service 0x56D4 — called at +0x004B76, AFTER
 *                 both interpreters — counts it down and, on the tick it
 *                 reaches zero, clears the accumulator (and restores the
 *                 RUNNING step +$30..$37 from its +$28..$2F master, which
 *                 only the unwired step-mutating effects below can make mean
 *                 anything, so a no-op here).
 *
 * On Law 'n Justice that is the combo chain — 1,000,000, then 2,000,000, then
 * 3,000,000 while the 5- or 10-second window holds, on top of each element's
 * own 1,000,000 — and the jackpot: elements 49..51 pump counter 1's
 * accumulator 1,000,000 an award toward its 25,000,000 target and elements
 * 53..57 pay it. Extreme Sports' pair (elements 10/11) is the same chain with
 * a 2,000,000 step and a 12-second window. The resets are the walks'
 * own: both clear the accumulator and the window UNCONDITIONALLY — at
 * +0x004136 the clear runs before the keep-flag tests — and a bit-0 record
 * then rebuilds accumulator = step x count from the kept count (+0x00417C).
 *
 * AND THE RUNNING-STEP MACHINE RUNS NOW TOO — the record's OTHER value, built
 * on +$30..$37 rather than on the accumulator, and the thing the tables spell
 * "JACKPOT". Five effects and six opcodes, all of them BCD instructions
 * Capstone cannot decode at all and all of them read as raw words
 * (research/BALL_SAVER_JACKPOTS.md):
 *
 *     10  0x61BA  the accumulator paid min(element +$38, count) times, the
 *                 count zeroed only when it held fewer than the ask (0x61CA's
 *                 `bpl` skips the write-back otherwise)
 *     14  0x61E6  one RUNNING step straight to the score, through the same
 *                 $6BCC effect 7 pays the accumulator with — the difference is
 *                 one `lea`, +$38 against +$40
 *     15  0x60DC  step += the element's own +$3A..$3F  (six `abcd`)
 *     25  0x60B2  step -= the same six bytes            (six `sbcd`)
 *     27  0x60FA  step += a RAMP's live value, entering 15's body with the
 *                 source swapped for `ramp + 2`
 *   op 6  0x5C40  step := its +$28 master
 *   op 7  0x5C7E  step := eight bytes inline in the script
 *   op 13 0x59BC  step := master, counts := +$02, accumulator := 0
 *   op 18 0x5C52  accumulator := eight bytes inline in the script
 *   op 15 0x5DDA  a RAMP is seeded from its +$0A and started
 *   op 16 0x5DEE  a RAMP is stopped where it stands
 *
 * BabeWatch's "SHOW YOUR MUSCLES TO SCORE JACKPOTS" is the plainest example
 * and the reason this round happened: its eleven gym targets are effect 15 on
 * counter 1, whose master step is 20,000,000; its jackpot shots are effect 14
 * on the same record; and every one of its five jackpot missions opens with an
 * `op 6` that puts the step back to 20,000,000. Before this round every one of
 * those shots paid ZERO, because `payStep` did not exist.
 */
const EFFECT_COUNT_DISPATCH = 6;
const EFFECT_PAY_ACCUMULATOR = 7;
/** The five that make up the RUNNING-STEP machine. See `ModeState.counterSteps`. */
const EFFECT_PAY_N = 10;
const EFFECT_PAY_STEP = 14;
const EFFECT_STEP_ADD = 15;
const EFFECT_STEP_SUBTRACT = 25;
const EFFECT_STEP_ADD_RAMP = 27;
const EFFECT_ADD_STEP = 11;
const EFFECT_COUNT_AND_PAY = 16;
const EFFECT_COUNT_AND_ADD = 18;
const EFFECT_ARM_WINDOW = 20;
const EFFECT_ADVANCE_LADDER = 21;
const EFFECT_COUNT_DOWN = 24;
const EFFECT_HOLD_MULTIPLIER = 8;
const EFFECT_ADD_TIME = 23;

/**
 * MEASURED: the element flag bits that relight a lamp the moment it is awarded.
 *
 * The AWARD handler at 0x5CA8 clears the armed bit (`bclr.b d6,$1(a2)`), pays,
 * and then — when the element's flags word has a bit of $A set — sets the bit
 * straight back, so the lamp stays lit until a `LAMP_OFF` puts it out. This is
 * what lets one saucer advance the multiball lock ladder capture after capture:
 * BabeWatch's lock lamps carry flags $09 and Law 'n Justice's jail lamp $28,
 * both with a relight bit. No element any mission WAITs on carries one, checked
 * across all three tables, so the relight cannot stall a mission's wait.
 */
const FLAGS_RELIGHT = 0x0a;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The whole mission machine, for ONE player.
 *
 * Typed arrays indexed by element, and integers everywhere else: no map
 * iteration order and no floating point, so two runs of the same input produce
 * the same state. The original's per-player fields are bitmasks indexed by
 * `d6`; here a bit is a byte, and the second player arrived exactly as this
 * sentence always promised: the game layer keeps one `ModeState` per player
 * (`PlayerBank`, game-loop.ts) and rotates the active one, with
 * `resetModesForNewBall` run on each player's own rotation-in — which is
 * observationally the machine's per-player bits, because every runtime reader
 * indexes the current player and every cross-player write is a ball-start
 * walk. research/MULTIPLAYER_DECODE.md §1/§3.
 */
export interface ModeState {
  /** Per-element ARMED byte, the original's `+$01` bit: the shot is lit. */
  readonly armed: Uint8Array;
  /** Per-element DONE byte, `+$02`: the shot is finished for this player. */
  readonly done: Uint8Array;
  /**
   * Per-element AWARD-RELIGHT latch — the original's always-on byte at +$05 of
   * the element's +$08 lamp, kept here per ELEMENT because that is the join
   * the renderer has (the lamp wiring in `table-lamps.ts` maps it back).
   *
   * MEASURED: the AWARD lamp handler ($6440-$6462) does `or.b d7,$5(lamp)` on
   * the element's award-path lamp, which keeps that insert lit STEADY after
   * the award — the collected mugshot ring, the earned bonus multiplier —
   * until the force-off at $6234 puts it out; `LAMP_OFF` is the opcode that
   * calls it. PRESENTATION ONLY: nothing in this machine reads the latch —
   * `litElements`, the waits and the awards all key off `armed` exactly as
   * before — so lamp state cannot feed back into the rules, let alone the
   * physics.
   */
  readonly awardLit: Uint8Array;
  /** Frames left on an element's own countdown; 0 is "no timer". */
  readonly timers: Int32Array;
  /**
   * PER COUNTER RECORD, the original's `+$06 + 2p`: the capped count.
   *
   * KEYED BY RECORD AND NOT BY ELEMENT, which is a correction rather than a
   * refactor. Every effect in `EFFECT_COUNT_*` reaches this word through
   * `movea.l $34(a2),a0`, so Law 'n Justice's eight combo elements share ONE
   * count and its six effect-21 mugshot shots share another; the old per-element
   * array gave each of them its own, and no shared counter could ever reach a cap.
   */
  readonly counterCounts: Int32Array;
  /**
   * PER COUNTER RECORD, the original's `+$16 + 2p`: the uncapped total.
   *
   * The second word every counting effect bumps, and the one the launcher walk
   * at 0x5EAA reads — so THIS is the multiball lock count, not the capped one.
   * The 0xFFFE wrap at 0x5F2A subtracts from it in place, which is why a ladder
   * that has run its length starts over.
   *
   * WHETHER IT SURVIVES A DRAIN IS NOW DECODED and it is per record: the
   * ball-start walk at +0x00412C writes `reset` into both words unless the
   * record's flags carry bit 0 or bit 3 (`ModeCounter.keepAcrossBall`). Law 'n
   * Justice's jail ladder and BabeWatch's lock ladder both carry bit 0 and are
   * therefore per game, which is what this port already did for every ladder;
   * the ones that do not — BabeWatch's counters 0, 2, 3, 12 and most of Extreme
   * Sports' — now reset with the ball, as the machine's own walk does.
   */
  readonly counterTotals: Int32Array;
  /**
   * PER COUNTER RECORD, the packed-BCD ACCUMULATOR at +$3A..$3F, as a number.
   *
   * The record's own scoring, distinct from both counts: effects 11/16/18 add
   * the record's step into it (0x5FE4, clamped to the record's +$40 target
   * when it has one), effects 7 and 16 pay it to the score (0x61AA), and the
   * window expiry and both reset walks clear it. ONE slot, not eight — unlike
   * the counts this field is machine-global, which changes nothing for this
   * one-player reconstruction.
   *
   * Float64 rather than Int32 because twelve BCD digits outgrow an int32 (Law
   * 'n Justice's counter 0 steps 5,000,000 at a time); every value the field
   * can hold is a whole number far below 2^53, so the arithmetic stays exact
   * and deterministic — the no-floating-point rule above is about physics
   * state, and this is a score.
   */
  readonly counterAccumulators: Float64Array;
  /**
   * PER COUNTER RECORD, the +$26 WINDOW countdown in ticks; 0 is "no window".
   *
   * Armed by award effect 20 (seconds x `$50(a5)`, 0x620E — SET, not
   * extended), decremented once a tick by the service this port runs at the
   * tail of `tickModes` (0x56D4's own slot in the frame chain at +0x004B76 is
   * after both interpreters), and cleared by both reset walks.
   */
  readonly counterWindows: Int32Array;
  /**
   * PER COUNTER RECORD, the packed-BCD RUNNING STEP at +$32..$37 — the record's
   * OTHER value, and the one the growing jackpots are made of.
   *
   * The record carries the same eight bytes twice: a MASTER at +$28..$2F that
   * nothing ever writes, and this working copy at +$30..$37 that six sites
   * restore from it (`move.l $28(a1),$30(a1) / move.l $2c(a1),$34(a1)` at
   * +0x0040D4 the new-game walk, +0x00414C the per-ball walk, +0x0056EA the
   * window expiry, +0x0059C0 opcode 13, +0x005C44 opcode 6 and +0x005F48 the
   * ladder wrap). In every shipped record the two are byte-identical, so the
   * master IS `ModeCounter.step` and no second field is exported.
   *
   * Three award effects mutate it — 15 adds the element's own +$3A..$3F, 25
   * subtracts the same six bytes, 27 adds a RAMP's live value — and effect 14
   * pays it straight to the score. Until this round the port treated the step as
   * immutable configuration, which is why BabeWatch's "SHOW YOUR MUSCLES TO
   * SCORE JACKPOTS" paid nothing at all.
   *
   * Float64 for the same reason `counterAccumulators` is: twelve BCD digits.
   */
  readonly counterSteps: Float64Array;
  /**
   * PER RAMP RECORD, the packed-BCD LIVE VALUE at +$04..$09, and its +$00
   * RUNNING byte. See `ModeRamp` for the record and +0x006334 for the service.
   *
   * Both ship at zero and stopped, and NEITHER RESET WALK TOUCHES THIS LIST, so
   * they are created once and only opcodes 15 and 16 and the service itself
   * ever write them.
   */
  readonly rampValues: Float64Array;
  readonly rampRunning: Uint8Array;

  /**
   * PER LAMP-GROUP LAMP (flattened over `TableModes.lampGroups` in group then
   * chain order): the original's per-player STEADY bit at lamp +$00.
   *
   * Written by a type-0 device's hit (`bset.b d0,(a2)` at +0x0055F0 — the
   * device's +$04 "flag byte" IS the lamp) and by a trigger zone's pass
   * (+0x00543A), through `lightGroupLampsForTrigger`; cleared by the force-off
   * $6234 whenever a start-element of the lamp is disarmed, and by both group
   * resets. The steady bit resets EVERY BALL, and since the first-hit round so
   * does the scoring `flags` entry that shares the byte with it: $3F10's
   * whole-byte `clr.b (a0)` at +0x003F56 is one instruction serving both, and
   * this port runs it as two — the lamp half here, the scoring half in
   * `resetScoringForNewBall` off `groupBackedFlagIds`.
   * research/MULTIPLAYER_DECODE.md §7.
   */
  readonly groupLampLit: Uint8Array;
  /**
   * The same lamps' ALWAYS-ON mask, the original's +$05: `or.b d7,$5(lamp)` on
   * an element AWARD's +$08 lamp, and hook 2's multiplier restore. Survives a
   * ball only for groups whose flags carry bit 2 (`GROUP_FLAG_KEEP_ALWAYS_ON`).
   */
  readonly groupLampAlways: Uint8Array;
  /**
   * Per group, the FIRED latch — group record flags bit 0, `bset #0,$4(a4)` at
   * +0x00658A. Cleared by both resets (`andi.b #$6,$4`), so a group can fire
   * once per ball.
   */
  readonly groupFired: Uint8Array;
  /**
   * THE COMPLETION FLASH QUEUE, `$1264/$1268/$126A(a5)`.
   *
   * `flashGroup` is the group flashing right now (-1 for none) and
   * `flashTicks` its countdown; `flashQueue` is the LIFO behind it. See
   * `serviceGroupFlash`, which is where the whole routine is written out.
   */
  flashGroup: number;
  flashTicks: number;
  readonly flashQueue: number[];

  /** The background ring at `$2396(a5)`; -1 is an empty slot. */
  readonly queue: Int32Array;
  queueWrite: number;
  queueRead: number;
  /** Script the background interpreter is part-way through, or -1. */
  background: number;
  backgroundPc: number;

  /** The running mission script (`$daa`), or -1. */
  mission: number;
  missionPc: number;
  /** Index into `TableModes.missions` for the running mode, or -1. Presentation only. */
  missionIndex: number;
  /** `$d9c`: the mission is parked on a WAIT. */
  suspended: boolean;
  /** `$db2`: the element the WAIT is watching, or -1. */
  waitElement: number;
  /** `$dae`: frames left on the WAIT; 0 is untimed. */
  waitTicks: number;
  /** `$db6`: the PC the WAIT branches to when it times out; -1 ends the script. */
  waitTimeoutPc: number;
  /** `$dba`: the DBNZ loop counter. `$db8`: the alternate resume PC. */
  loop: number;
  resumePc: number;
  /**
   * `$dae < 0`: this WAIT has NO clock and can only be broken by the shot it
   * watches or by `abortWait`.
   *
   * DECODED at the WAIT handler, +0x005E2A:
   *
   *     005E2A  move.w  $6(a1),d0     the seconds operand
   *     005E2E  bmi.b   $5e36         NEGATIVE -> store it AS IS, unmultiplied
   *     005E30  beq.b   $5e3a         ZERO     -> do not touch $dae at all
   *     005E32  mulu.w  $50(a5),d0    POSITIVE -> seconds x frames-per-second
   *     005E36  move.w  d0,$dae(a5)
   *
   * and spent at the mission frame, +0x0057BC:
   *
   *     0057BC  move.w  $dae(a5),d1
   *     0057C0  bmi.b   $57d4         NEGATIVE -> never decrement, never time out
   *     0057C2  beq.b   $57fc         ZERO     -> take the timeout branch NOW
   *
   * So a negative operand is an INDEFINITE PARK, not "no clock, fall through".
   * For the twelve `WAIT <element>, -1, <pc>` shot loops that is the same thing
   * this port already did, because the element is what ends those. For the ONE
   * site that has no element either — Extreme Sports script 166 pc 76, which is
   * the entire body of that table's three-ball multiball — it is not: the
   * machine sits there until the balls are gone. See `stepMission`.
   */
  waitIndefinite: boolean;
  /**
   * `$d9d`: TEAR THIS MISSION DOWN — whatever the WAIT was waiting for is over.
   *
   * DECODED, and it is the mechanism that ends every multiball mission in the
   * game. `+0x005794` runs every frame:
   *
   *     005794  tst.b    $d7a(a5)      is a multiball live?
   *     005798  beq.b    $57b0
   *     00579A  move.w   $d86(a5),d0   balls queued for the lane
   *     00579E  add.w    $d7e(a5),d0   + balls on the playfield
   *     0057A2  cmpi.w   #$1,d0
   *     0057A6  bhi.b    $57b0         more than one -> still a multiball
   *     0057A8  clr.b    $d7a(a5)      MULTIBALL OVER
   *     0057AC  st.b     $d9d(a5)      <- and tear the mission down
   *
   * and the mission frame reads it BEFORE the clock and BEFORE the element:
   *
   *     0057B0  tst.b    $d9c(a5)      parked on a WAIT?
   *     0057B4  beq.b    $5810
   *     0057B6  tst.b    $d9d(a5)
   *     0057BA  bne.b    $57e4         -> resume at $db8, or $db6 when unset
   *
   * `+0x004EC0` sets the same latch when the LAST ball drains and then spins
   * the frame loop until the script finishes; this port reaches that case by a
   * different door (`resetModesForNewBall` on the drain that ends the ball) and
   * the divergence is the one already recorded in `game-loop.ts`. The machine
   * clears the latch on `MODE_START` (+0x005DAE) and when the script ends
   * (+0x005864), so it lives exactly as long as one teardown.
   */
  abortWait: boolean;

  /** RECONSTRUCTION. Which selector entry the next arm shot will start. */
  selectorCursor: number;
  /** RECONSTRUCTION. One byte per mission: 1 once it has been played this game. */
  readonly played: Uint8Array;
}

export function createModeState(modes: TableModes): ModeState {
  const count = modes.elements.length;
  const armed = new Uint8Array(count);
  // The game-start lamps, DECODED: the per-GAME reset at main.seg00 +0x004052
  // arms — for every player — every element whose flags bit 1 is set, and
  // writes its countdown to -1. See `TableModes.litAtGameStart`.
  for (const element of modes.litAtGameStart) armed[element] = 1;
  // And the game-start COUNTERS, +0x0040CA, called two instructions before it:
  // every record's eight per-player slots take the record's own +$02, with no
  // flag test of any kind. Most are zero; Law 'n Justice's counter 14 starts at
  // three and Extreme Sports' counter 14 at five.
  const counterCounts = new Int32Array(modes.counters.length);
  for (const counter of modes.counters) counterCounts[counter.index] = counter.reset;
  // The lamp groups start all-dark with the latch clear — the hard reset at
  // +0x003EA8 (new game, +0x0045A6) clears both per-player masks of every
  // chained lamp and `andi.b #$6,$4(record)` drops the fired latch.
  const lampCount = modes.lampGroups.reduce((total, group) => total + group.lamps.length, 0);
  return {
    armed,
    done: new Uint8Array(count),
    awardLit: new Uint8Array(count),
    timers: new Int32Array(count),
    counterCounts,
    counterTotals: Int32Array.from(counterCounts),
    // The game-start walk clears every record's accumulator and window
    // outright — `clr.l $38 / clr.l $3c / clr.w $26` at +0x0040F2, no flag
    // test — so both start at zero however the counts start.
    counterAccumulators: new Float64Array(modes.counters.length),
    counterWindows: new Int32Array(modes.counters.length),
    // The RUNNING STEP starts as the master copy, which is the same walk's
    // `move.l $28(a1),$30(a1)` at +0x0040D4 — and in every shipped record the
    // two are already equal, so this is also just "as the file ships".
    counterSteps: Float64Array.from(modes.counters, (counter) => counter.step),
    // The ramps ship stopped with a zero value and no walk resets them.
    rampValues: new Float64Array(modes.ramps.length),
    rampRunning: Uint8Array.from(modes.ramps, (ramp) => (ramp.running ? 1 : 0)),
    groupLampLit: new Uint8Array(lampCount),
    groupLampAlways: new Uint8Array(lampCount),
    groupFired: new Uint8Array(modes.lampGroups.length),
    flashGroup: -1,
    flashTicks: 0,
    flashQueue: [],
    queue: new Int32Array(MODE_QUEUE_SLOTS).fill(-1),
    queueWrite: 0,
    queueRead: 0,
    background: -1,
    backgroundPc: 0,
    mission: -1,
    missionPc: 0,
    missionIndex: -1,
    suspended: false,
    waitElement: -1,
    waitTicks: 0,
    waitTimeoutPc: -1,
    loop: 0,
    resumePc: -1,
    waitIndefinite: false,
    abortWait: false,
    selectorCursor: 0,
    played: new Uint8Array(modes.missions.length),
  };
}

/**
 * What a new ball clears — DECODED, from the per-BALL reset at
 * `main.seg00 +0x003F80` (one caller, `+0x0050C2`).
 *
 * It is the per-game walk of `+0x004052` with two extra tests, both on the
 * element's flags byte at element +$00:
 *
 *   `+0x003F9A`  flags bit 5 ($20) — the DONE bit is KEPT, not cleared
 *   `+0x003FA4`  flags bit 0 ($01) — the ARMED bit is KEPT, not cleared
 *   `+0x003FB0`  flags bit 1 ($02) — re-armed for every player, countdown -1,
 *                and the START lamp relit
 *
 * So a DONE bit is cleared by default and survives only where the table says
 * so, which is the opposite of what this function used to do (it never touched
 * `done` at all).
 *
 * THE PROGRESS COUNTERS RESET HERE TOO, and that is new: `+0x0050BC` calls the
 * counter walk `+0x00412C` six instructions before it calls this one's
 * `+0x003F80`, and that walk writes each record's `reset` into both per-player
 * words UNLESS the record's flags carry bit 0 or bit 3. See
 * `ModeCounter.keepAcrossBall`. The old note here — "nothing in the engine
 * resets them per ball" — was looking for a writer of the arrays and missing the
 * walk that owns them.
 *
 * THE LAMP GROUPS RESET HERE TOO, and the old divergence note is closed: the
 * soft reset at `+0x003F10` (one caller, the ball-start chain at +0x0050B6)
 * clears every chained lamp's steady mask at +$00 and the group's fired latch
 * (`andi.b #$6,$4`), and clears the always-on mask at +$05 UNLESS the group's
 * flags carry bit 2 (`btst #$2,$4(a1)` at +0x003F2E skips the `clr.b $5(a0)`).
 * `awardLit` — the port's per-element view of the same +$05 — now follows the
 * identical rule through `TableModes.awardLitSurvivesBall` instead of being
 * cleared wholesale.
 */
export function resetModesForNewBall(modes: TableModes, state: ModeState): void {
  const keepArmed = new Set(modes.keepArmedAcrossBall);
  const keepDone = new Set(modes.keepDoneAcrossBall);
  const lit = new Set(modes.litAtGameStart);
  for (let index = 0; index < state.armed.length; index += 1) {
    if (!keepDone.has(index)) state.done[index] = 0;
    if (!keepArmed.has(index)) state.armed[index] = 0;
    if (lit.has(index)) state.armed[index] = 1;
  }
  for (const counter of modes.counters) {
    // The accumulator and the window die with the ball WHATEVER the flags
    // say: the walk's `clr.l $38 / clr.l $3c / clr.w $26` at +0x004136 runs
    // before either keep-flag test, so even a per-game counter loses them.
    state.counterAccumulators[counter.index] = 0;
    state.counterWindows[counter.index] = 0;
    if ((counter.flags & COUNTER_FLAG_REBUILD_ACCUMULATOR) !== 0) {
      // BIT 0 IS THE ONLY FLAG THAT SKIPS THE STEP RESTORE. `btst.b #$0,(a1) /
      // bne $417c` at +0x004146 jumps PAST the `move.l $28(a1),$30(a1)` at
      // +0x00414C as well as past the count reset, so a bit-0 record's GROWN
      // running step carries across the ball — and the rebuild that follows
      // multiplies the grown step, not the master, because +0x004184's `lea
      // $38(a1),a2` walks +$37..$32. That is BabeWatch's counter 1, flags
      // exactly $01: its jackpot grows for the whole game and no drain takes
      // any of it back.
      state.counterAccumulators[counter.index] =
        (state.counterSteps[counter.index] ?? counter.step) *
        Math.max(0, state.counterCounts[counter.index] ?? 0);
      continue;
    }
    // Everything else falls through +0x00414C, bit-3 records included, so its
    // running step goes back to the master whether or not the count follows.
    state.counterSteps[counter.index] = counter.step;
    if (counter.keepAcrossBall) continue;
    state.counterCounts[counter.index] = counter.reset;
    state.counterTotals[counter.index] = counter.reset;
  }
  state.groupLampLit.fill(0);
  state.groupFired.fill(0);
  // The flash queue dies with the ball: `$1264` is cleared by the reset's own
  // `clr.l` and a group that was mid-flash has just had its lamps cleared
  // wholesale by the ball-start walk anyway.
  state.flashGroup = -1;
  state.flashTicks = 0;
  state.flashQueue.length = 0;
  let lampAt = 0;
  for (const group of modes.lampGroups) {
    const keep = (group.flags & GROUP_FLAG_KEEP_ALWAYS_ON) !== 0;
    for (let i = 0; i < group.lamps.length; i += 1, lampAt += 1) {
      if (!keep) state.groupLampAlways[lampAt] = 0;
    }
  }
  const keepAwardLit = new Set(modes.awardLitSurvivesBall);
  for (let index = 0; index < state.awardLit.length; index += 1) {
    if (!keepAwardLit.has(index)) state.awardLit[index] = 0;
  }
  // The original writes $FFFF — "no countdown" — into +$2E for everything the
  // reset arms; this state machine spells "not counting" as 0, and it clears
  // every element's timer rather than only the armed ones, which is the same
  // thing here because a timer only ever runs on an armed element.
  state.timers.fill(0);
  state.queue.fill(-1);
  state.queueWrite = 0;
  state.queueRead = 0;
  state.background = -1;
  state.backgroundPc = 0;
  endMission(state);
}

// ---------------------------------------------------------------------------
// The lamp groups
// ---------------------------------------------------------------------------

/**
 * Derived joins over `TableModes.lampGroups`, built once per document: flat
 * lamp index by device surface id, by zone, and by element (start and award
 * paths), plus each flat lamp's group. Pure derivation, cached by identity.
 */
interface GroupJoinIndex {
  readonly total: number;
  /** Flat index of each group's first lamp. */
  readonly groupBase: Int32Array;
  readonly byDevice: ReadonlyMap<string, readonly number[]>;
  readonly byZone: ReadonlyMap<string, readonly number[]>;
  readonly startByElement: ReadonlyMap<number, readonly number[]>;
  readonly awardByElement: ReadonlyMap<number, readonly number[]>;
  /** Elements whose armed state blinks each flat lamp: the inverse of start. */
  readonly startElementsOfLamp: readonly (readonly number[])[];
  /**
   * The scoring layer's flag ids whose flag byte is one of these chained lamps
   * — i.e. every id the ball-start `clr.b` re-arms. See `groupBackedFlagIds`.
   */
  readonly flagIds: ReadonlySet<string>;
  /**
   * The same ids PER FLAT LAMP: the scoring flag ids whose flag byte is this
   * exact lamp. The force-off's `bclr.b d6,(a1)` clears the player's bit in one
   * lamp byte, so it re-arms these ids and no others — where the ball-start
   * `clr.b` walks the whole chain and re-arms `flagIds` entire.
   */
  readonly flagIdsOfLamp: readonly (readonly string[])[];
}

const JOIN_INDEX = new WeakMap<TableModes, GroupJoinIndex>();

function groupJoins(modes: TableModes): GroupJoinIndex {
  const cached = JOIN_INDEX.get(modes);
  if (cached !== undefined) return cached;
  const groupBase = new Int32Array(modes.lampGroups.length);
  const byDevice = new Map<string, number[]>();
  const byZone = new Map<string, number[]>();
  const startByElement = new Map<number, number[]>();
  const awardByElement = new Map<number, number[]>();
  const startElementsOfLamp: (readonly number[])[] = [];
  const push = <K,>(map: Map<K, number[]>, k: K, value: number): void => {
    const list = map.get(k);
    if (list === undefined) map.set(k, [value]);
    else list.push(value);
  };
  const flagIds = new Set<string>();
  const flagIdsOfLamp: (readonly string[])[] = [];
  let at = 0;
  for (const group of modes.lampGroups) {
    groupBase[group.index] = at;
    for (const lamp of group.lamps) {
      const mine: string[] = [];
      for (const device of lamp.devices) {
        push(byDevice, `${device.level}:${device.surfaceId}`, at);
        flagIds.add(deviceFlagId(device.surfaceId));
        mine.push(deviceFlagId(device.surfaceId));
      }
      for (const zone of lamp.zones) {
        push(byZone, `${zone.level}:${zone.index}`, at);
        flagIds.add(zoneFlagId(zone.level, zone.index));
        mine.push(zoneFlagId(zone.level, zone.index));
      }
      for (const element of lamp.startElements) push(startByElement, element, at);
      for (const element of lamp.awardElements) push(awardByElement, element, at);
      startElementsOfLamp.push(lamp.startElements);
      flagIdsOfLamp.push(mine);
      at += 1;
    }
  }
  const built: GroupJoinIndex = {
    total: at,
    groupBase,
    byDevice,
    byZone,
    startByElement,
    awardByElement,
    startElementsOfLamp,
    flagIds,
    flagIdsOfLamp,
  };
  JOIN_INDEX.set(modes, built);
  return built;
}

/**
 * The scoring-layer flag ids whose flag byte is a group-chained lamp: the ids
 * the ball-start soft reset $3F10 re-arms, for `resetScoringForNewBall`.
 *
 * It is the same join `lightGroupLampsForTrigger` lights through, read the
 * other way round, and that is the point — the pointer at a device's +$04 or a
 * zone object's +$0A is ONE byte that the lamp scan reads and the first-hit
 * `bset` writes, so "which ids does the clr.b reach" and "which ids light a
 * group lamp" are the same question. Ids outside every group keep their flag
 * for the whole game, because the walk at +0x003F14 only ever follows the
 * group table's chains.
 *
 * Null modes yields the empty set: a table with no mission document has no
 * groups, hence no group-backed flag byte, hence nothing to re-arm.
 */
export function groupBackedFlagIds(modes: TableModes | null): ReadonlySet<string> {
  return modes === null ? NO_FLAG_IDS : groupJoins(modes).flagIds;
}

const NO_FLAG_IDS: ReadonlySet<string> = new Set<string>();

/**
 * A device hit or a zone pass lights its flag lamp — `bset.b d0,(a2)` at
 * +0x0055F0 (device +$04) and +0x00543A (zone object +$0A).
 *
 * Called for EVERY hit, not only the first: the machine's bset is idempotent
 * and it is the bset itself that distinguishes first from repeat. The lamp
 * relights on the first hit of a NEW ball, and since the first-hit round the
 * scoring layer agrees with it — the same ids re-arm through
 * `groupBackedFlagIds` above, which is the divergence this comment used to
 * record closing (research/MULTIPLAYER_DECODE.md §7). A device award's trigger
 * carries no level (`level` -1); a device surface id is filed on exactly one
 * level, so matching both is the same join the engine makes through the level's
 * own array.
 */
export function lightGroupLampsForTrigger(
  modes: TableModes,
  state: ModeState,
  kind: "device" | "zone",
  level: number,
  id: number,
): void {
  const joins = groupJoins(modes);
  const lamps =
    kind === "device"
      ? level < 0
        ? [...(joins.byDevice.get(`0:${id}`) ?? []), ...(joins.byDevice.get(`1:${id}`) ?? [])]
        : (joins.byDevice.get(`${level}:${id}`) ?? [])
      : (joins.byZone.get(`${level}:${id}`) ?? []);
  for (const lamp of lamps) state.groupLampLit[lamp] = 1;
}

/**
 * The force-off $6234, run on every disarm the active-element service observes
 * (+0x006296 after the armed test at +0x006284, and on the award, timeout,
 * COMPLETE and LAMP_OFF paths that clear the bit): `bclr.b d6,(a1)` takes the
 * player's STEADY bit off the element's +$04 start lamp and stops its blink.
 * The always-on mask at +$05 is NOT touched — only LAMP_OFF's own handler
 * reaches that.
 *
 * ---------------------------------------------------------------------------
 * AND THAT `bclr` RE-ARMS THE FIRST-HIT AWARD, BECAUSE IT IS THE SAME BIT
 * ---------------------------------------------------------------------------
 * The bit this clears is the bit the first-hit test SETS. Re-read for the
 * scoring round straight out of `research/seg_clean/main.bin.seg00.bin` (file
 * offset = address + 4):
 *
 *   +0x006238  20 2A 00 04    move.l  $04(a2),d0    ; a2 = the ELEMENT
 *   +0x00623E  22 40          movea.l d0,a1         ; a1 = its +$04 START LAMP
 *   +0x006240  0D 91          bclr.b  d6,(a1)       ; d6 = the player index
 *
 *   +0x0055E4  20 28 00 04    move.l  $04(a0),d0    ; a0 = the DEVICE
 *   +0x0055EA  24 40          movea.l d0,a2         ; a2 = its +$04 FLAG BYTE
 *   +0x0055EC  30 2D 0D BE    move.w  $dbe(a5),d0   ; the player index
 *   +0x0055F0  01 D2          bset.b  d0,(a2)       ; first/repeat, on that byte
 *
 *   +0x005430  20 29 00 0A    move.l  $0A(a1),d0    ; the ZONE object's +$0A
 *   +0x005436  24 40          movea.l d0,a2
 *   +0x00543A  30 2D 0D BE / 01 D2                  ; the same two instructions
 *
 * `(a1)` at +0x006240 and `(a2)` at +0x0055F0 are ONE byte whenever a device's
 * +$04 and an element's +$04 resolve to the same lamp object — and the shipped
 * lamp-group documents say WHICH, because `lampGroups` in
 * `scripts/export-table-modes.mjs` builds each lamp's `startElements` and
 * `devices`/`zones` lists by keying both pointers on that object's ADDRESS.
 * A lamp that lists device 35 and elements 45/50/87 is the statement that all
 * four pointers are that one byte.
 *
 * So a disarm re-arms the first-hit award of every device and zone filed on the
 * lamp it puts out, exactly as the ball-start `clr.b` re-arms the whole chain.
 * This port used to model only the lamp half of the instruction, and the film
 * caught it: in the Law 'n Justice full-game capture the ball hits drop target
 * 35 twice on BALL 2, at f2018 and f2176, and the original pays **75,000 both
 * times** — where a flag that survived the ball would have paid the record's
 * repeat award of zero the second time. Script 74, which surface 35's own
 * binding queues, is `AWARD 50 / AWARD 87 / AWARD 45`, and all three of those
 * elements are start-lamps of the very lamp that is surface 35's flag byte;
 * each `AWARD` of an unarmed element falls into this routine. See
 * `research/SCORING_LEDGER.md` for the frame-by-frame ledger and the
 * measurement that identified the target.
 *
 * The ids are REPORTED rather than cleared here: the flag set is the scoring
 * layer's (`ScoringState.flags`), and the mission machine does not reach into
 * it — `runModes` in game-loop.ts applies them through `clearScoringFlags`,
 * the same shape as every other player-record field this VM reports.
 */
function forceStartLampsOff(
  modes: TableModes,
  state: ModeState,
  out: Accumulator,
  element: number,
): void {
  const joins = groupJoins(modes);
  for (const lamp of joins.startByElement.get(element) ?? []) {
    state.groupLampLit[lamp] = 0;
    for (const id of joins.flagIdsOfLamp[lamp] ?? []) out.clearedFlagIds.push(id);
  }
}

/**
 * THE GROUP SCAN, main.seg00 +0x0064D0, run once per tick.
 *
 * For each group: a lamp counts as LIT when the player's bit is in
 * `(+$00 | +$05)` and the lamp is not blinking — and a lamp is blinking
 * exactly while some element whose START lamp it is stays armed, because the
 * active-element service re-applies the blink every frame (+0x006312..22) and
 * the disarm force-off clears it. A blinking lamp sets the not-all-lit
 * accumulator BEFORE the phase test (+0x006506), so it blocks its group even
 * when a device has also set its steady bit. When every lamp is lit and the
 * group is neither suppressed (`btst #1,$4(a4)`, +0x006582) nor already
 * latched (`bset #0,$4(a4)`, +0x00658A), the event script at +$06 is queued
 * through $6C10 (+0x006594).
 *
 * DIVERGENCE, STATED: the original's scan is budgeted — 32 lamps and 8 lamp
 * changes per frame, cursor carried in `$10F4/$10F6(a5)` — so a completion can
 * lag the lighting hit by a frame or two. This scan is complete every tick;
 * the fire still reaches the queue, whose one-opcode-per-tick pace is the
 * dominant delay either way.
 */
function scanLampGroups(modes: TableModes, state: ModeState): void {
  if (modes.lampGroups.length === 0) return;
  const joins = groupJoins(modes);
  let at = 0;
  for (const group of modes.lampGroups) {
    let allLit = group.lamps.length > 0;
    for (let i = 0; i < group.lamps.length; i += 1) {
      const lamp = at + i;
      const blinking = joins.startElementsOfLamp[lamp]?.some((element) => state.armed[element] === 1) ?? false;
      if (blinking || (state.groupLampLit[lamp] !== 1 && state.groupLampAlways[lamp] !== 1)) {
        allLit = false;
        break;
      }
    }
    at += group.lamps.length;
    if (!allLit) continue;
    if ((group.flags & GROUP_FLAG_SUPPRESS_FIRE) !== 0) continue;
    if (state.groupFired[group.index] === 1) continue;
    state.groupFired[group.index] = 1;
    if (group.script >= 0) queueScript(state, group.script);
    // AND THE FLASH, `jsr $64AA` at +0x0065A4 — taken unconditionally, past the
    // `beq` that skips a NULL event script, so a group with no script at all
    // still gets here. See `serviceGroupFlash`.
    state.flashQueue.push(group.index);
  }
}

/**
 * THE COMPLETION FLASH AND THE CLEAR BEHIND IT — the routine at +0x006430,
 * one frame of it, and the reason a drop target scores more than once a ball.
 *
 * Read straight out of `research/seg_clean/main.bin.seg00.bin` for the scoring
 * round (file offset = address + 4). The lamp-group scan's tail:
 *
 *   +0x00658A  08 EC 00 00 00 04  bset.b #0,$0004(a4)   ; the FIRED latch
 *   +0x006594  20 2C 00 06        move.l $0006(a4),d0   ; the event script
 *   +0x006598  67 08              beq    +0x0065A2      ; NULL -> skip the jsr
 *   +0x00659C  4E B9 0000 6C10    jsr    $6C10          ; queue it
 *   +0x0065A4  4E B9 0000 64AA    jsr    $64AA          ; ALWAYS, script or not
 *
 * `$64AA` pushes `{ word $0010, long group }` on the stack at `$126A(a5)` and
 * sets bit 0 of `+$02` on every lamp of the chain. The per-frame service:
 *
 *   +0x006430  20 2D 12 64   move.l $1264(a5),d0   ; the group flashing now
 *   +0x006434  67 32         beq    +0x006468      ; none -> pop the next
 *   +0x006438  30 2D 12 68   move.w $1268(a5),d0   ; its countdown
 *   +0x00643C  67 44         beq    +0x006482      ; ZERO -> THE CLEAR
 *   +0x006440  02 40 00 02   andi.w #$0002,d0      ; bit 1 picks the phase:
 *   +0x006446  42 2A 00 01   clr.b  $0001(a2)      ;   two frames dark
 *   +0x006454  50 EA 00 01   addq.b #8,$0001(a2)   ;   two frames bright
 *   +0x006462  53 6D 12 68   subq.w #1,$1268(a5)   ; tick
 *
 * and the clear it falls into:
 *
 *   +0x006486  08 A9 00 00 00 04  bclr.b #0,$0004(a1) ; RELEASE THE LATCH
 *   +0x00648E  32 2D 0D C0        move.w $dc0(a5),d1  ; the one-hot PLAYER mask
 *   +0x006492  46 41              not.w  d1
 *   +0x006494  C3 12              and.b  d1,(a2)      ; lamp byte 0, THIS PLAYER
 *   +0x006496  C3 2A 00 05        and.b  d1,$0005(a2) ; and the always-on mask
 *   +0x0064A0  20 2A 00 10        move.l $0010(a2),d0 ; next lamp, loop
 *
 * `$dc0(a5)` is one-hot: `move.w #$0001,$dc0(a5)` at +0x005084 and `lsl.w` at
 * +0x00507A on each player advance.
 *
 * SIXTEEN FRAMES, THEN THE GROUP IS PUT BACK THE WAY IT WAS. Three things come
 * off that, and this port had none of them:
 *
 *  1. The lamps go out. The insert is not a permanent record of a hit.
 *  2. The FIRED latch is released, so the group can complete — and fire its
 *     event script — again, as many times as the player relights it.
 *  3. **The first-hit awards on those lamps re-arm.** Lamp byte 0 is the byte
 *     a device's +$04 and a trigger zone's +$0A point at, and the byte the
 *     first-hit `bset.b d0,(a2)` (+0x0055F0 / +0x00543A) tests; `and.b d1,(a2)`
 *     clears this player's bit in it. Law 'n Justice files drop targets 34, 35
 *     and 36 in one-lamp groups of their own with no event script, so each
 *     completes on its own hit, flashes, and re-arms 0.32 s later.
 *
 * THE FILM SAYS SO. In the Law 'n Justice full-game capture the ball contacts
 * surface 35 twice on BALL 2 — at f2017 (ball centre 195.6,341.5, 6.9 px from
 * the target's pixels) and at f2175 (185.6,336.5, 7.1 px) — and the score goes
 * 1,200,000 -> 1,275,000 -> ... -> 1,425,000, i.e. the original pays the FULL
 * 75,000 both times where the record's repeat award is zero. Lamp 27, the
 * group-14 insert over that target, blinks from f2017, is dark by f2164, and
 * blinks again from f2176. Frame numbers, positions and the camera registration
 * behind them are in `research/SCORING_LEDGER.md`.
 *
 * The flash phase itself is lamp byte +$01, a brightness the port's lamp layer
 * does not have; byte 0 is untouched for the whole sixteen frames, so the lamps
 * stay LIT here until the clear and no blink is modelled.
 */
function serviceGroupFlash(modes: TableModes, state: ModeState, out: Accumulator): void {
  if (state.flashGroup < 0) {
    const next = state.flashQueue.pop();
    if (next === undefined) return;
    state.flashGroup = next;
    state.flashTicks = GROUP_FLASH_FRAMES;
    return;
  }
  if (state.flashTicks > 0) {
    state.flashTicks -= 1;
    return;
  }
  const group = modes.lampGroups[state.flashGroup];
  state.groupFired[state.flashGroup] = 0;
  state.flashGroup = -1;
  if (group === undefined) return;
  const joins = groupJoins(modes);
  const base = joins.groupBase[group.index] ?? 0;
  for (let i = 0; i < group.lamps.length; i += 1) {
    const lamp = base + i;
    state.groupLampLit[lamp] = 0;
    state.groupLampAlways[lamp] = 0;
    for (const id of joins.flagIdsOfLamp[lamp] ?? []) out.clearedFlagIds.push(id);
  }
}

/** The word `$64AA` pushes beside the group: sixteen frames of flash. */
export const GROUP_FLASH_FRAMES = 0x10;

/**
 * Descriptor HOOK 2's ball-start restore, `jsr ([$94,a5],$A4)` at +0x005116:
 * for a non-zero incoming multiplier, both per-player words of the ladder's
 * counter record take multiplier/2 and the first multiplier/2 lamps of the
 * X2..X10 chain get their always-on bit set. Call it where the machine does —
 * every ball start, AFTER the hold logic has settled the multiplier — with
 * whatever `+$12` now holds. A table whose hook is `rts` ships `null` and
 * this is a no-op, exactly as Extreme Sports' descriptor says.
 */
export function restoreMultiplierLamps(modes: TableModes, state: ModeState, multiplier: number): void {
  const restore = modes.multiplierRestore;
  if (restore === null || multiplier <= 0) return;
  const rungs = Math.floor(multiplier / 2);
  state.counterCounts[restore.counter] = rungs;
  state.counterTotals[restore.counter] = rungs;
  const joins = groupJoins(modes);
  const base = joins.groupBase[restore.group] ?? 0;
  const lamps = modes.lampGroups[restore.group]?.lamps.length ?? 0;
  for (let i = 0; i < Math.min(rungs, lamps); i += 1) {
    state.groupLampAlways[base + i] = 1;
  }
}

/**
 * RECONSTRUCTION. Starts the mission the selector is pointing at.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS INVENTED, AND WHAT IT IS BUILT ON
 * ---------------------------------------------------------------------------
 * The mission selector tables are real, decoded and checked: 12-byte records
 * with ids ascending from 1, each naming a launcher script that contains exactly
 * `MODE_START`, terminated by 0xFFFE with the entry count in its pad word — Law
 * 'n Justice's own terminator says EIGHT. What is NOT decoded is what reads
 * them. Nothing in any of the three table images points at a selector base;
 * whatever walks them is presumably the per-table 68k code in slot 6, which is
 * not being emulated. Without a reconstruction here, no mission ever starts, and
 * the machine is exactly where it was before the bytecode was decoded: modes
 * award their 500,000 and never run.
 *
 * So the rule below is this project's, and it is built out of the parts that ARE
 * decoded rather than out of nothing:
 *
 *   - THE TRIGGER is the arm shot. Law 'n Justice's type-1 MODE device fires a
 *     script whose entire body is `START <arm element>; COMPLETE <other>` — it
 *     lights the arm element and nothing else. Every mission's prologue then
 *     `COMPLETE`s that element (taking the shot away while the mission runs) and
 *     its epilogue `CLEAR_DONE`s it (giving it back). A structure that is armed
 *     by a shot, consumed by every mission and restored by every mission is a
 *     mission start, whatever the missing code does with it.
 *   - THE ORDER is the selector table's own: ids 1..N, in the order the records
 *     appear, which is the order the engine's count word describes.
 *   - THE CURSOR advances on each start and skips modes already played this
 *     game, wrapping when they have all been played. BabeWatch's display says
 *     "CHOOSE LEFT RIGHT / SELECT WITH RETURN", so on at least that table the
 *     real selector is player-driven; a round robin is the neutral stand-in that
 *     reaches every mission without pretending to know which one a player would
 *     have picked.
 *
 * Everything after the start is decoded: the mission's own bytecode arms its
 * shots, waits on them, times out and ends.
 */
export function startSelectedMission(modes: TableModes, state: ModeState): number {
  if (state.mission >= 0) return -1;
  const selectable = modes.selectable;
  if (selectable.length === 0) return -1;

  let chosen = -1;
  for (let step = 0; step < selectable.length; step += 1) {
    const at = selectable[(state.selectorCursor + step) % selectable.length] ?? -1;
    if (at >= 0 && state.played[at] !== 1) {
      chosen = at;
      state.selectorCursor = (state.selectorCursor + step + 1) % selectable.length;
      break;
    }
  }
  if (chosen < 0) {
    // Every mission played: start the ladder again, as a real machine does.
    state.played.fill(0);
    chosen = selectable[state.selectorCursor] ?? -1;
    state.selectorCursor = (state.selectorCursor + 1) % selectable.length;
  }
  if (chosen < 0) return -1;

  state.played[chosen] = 1;
  // Through the LAUNCHER rather than by setting `mission` directly, so the start
  // goes down the one decoded path: the launcher's `MODE_START` opcode, run by
  // the background interpreter on the next frame like any other script.
  const launcher = modes.missions[chosen]?.launcher ?? -1;
  queueScript(state, launcher >= 0 ? launcher : (modes.missions[chosen]?.script ?? -1));
  return chosen;
}

/** True when this element is one of the mode-arm shots. See `TableModes`. */
export function isArmElement(modes: TableModes, element: number): boolean {
  return modes.armElements.includes(element);
}

/** Clears the mission and everything the wait machinery holds. `$5840`. */
export function endMission(state: ModeState): void {
  state.mission = -1;
  state.missionPc = 0;
  state.missionIndex = -1;
  state.suspended = false;
  state.waitElement = -1;
  state.waitTicks = 0;
  state.waitTimeoutPc = -1;
  state.loop = 0;
  state.resumePc = -1;
  // `+0x005864  clr.b $d9d(a5)`, on the same exit that clears `$d9c`, `$db2`,
  // `$db6` and `$d9b`: the teardown latch dies with the script it tore down.
  state.waitIndefinite = false;
  state.abortWait = false;
}

/**
 * MULTIBALL IS OVER — set the teardown latch, `+0x0057AC  st.b $d9d(a5)`.
 *
 * Called from the game layer on the tick the live-plus-queued count falls back
 * to one, which is the same test `+0x00579A..+0x0057A6` makes. The running
 * mission takes its wind-up branch on its next frame: ONE TICK LATER than the
 * machine, whose reaper (`+0x00528C`, called at `+0x004DB8`) runs before the
 * mission service (`+0x005794`) inside a single frame, where this port's drain
 * section runs after `runModes`. Every multiball mission's wind-up is a straight
 * run of `LAMP_OFF`s, a `MUSIC` restore and an `AWARD`, so a tick of latency
 * costs nothing observable; it is recorded because it is a divergence.
 *
 * Idempotent: the machine's latch is a byte and setting it twice is setting it.
 */
export function signalMultiballEnded(state: ModeState): void {
  if (state.mission < 0) return;
  state.abortWait = true;
}

/** True while a mission is running. `MODE_START` refuses to start a second. */
export function missionRunning(state: ModeState): boolean {
  return state.mission >= 0;
}

/** Seconds left on the running mission, or 0. The original publishes `$23E6`. */
export function missionSecondsLeft(state: ModeState): number {
  return Math.floor(state.waitTicks / TICKS_PER_SECOND);
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * Appends a script to the background ring — `jsr $6C10`, written out.
 *
 * The ring is 64 slots and the write index wraps with `andi.w #$3f`, so a flood
 * of events overwrites the oldest rather than growing without bound. That is the
 * original's behaviour and it is also this reconstruction's bound on how much
 * work one tick can be asked to do.
 */
export function queueScript(state: ModeState, script: number): void {
  if (script < 0) return;
  state.queue[state.queueWrite] = script;
  state.queueWrite = (state.queueWrite + 1) % MODE_QUEUE_SLOTS;
}

function dequeueScript(state: ModeState): number {
  if (state.queueRead === state.queueWrite) return -1;
  const script = state.queue[state.queueRead] ?? -1;
  state.queue[state.queueRead] = -1;
  state.queueRead = (state.queueRead + 1) % MODE_QUEUE_SLOTS;
  return script;
}

// ---------------------------------------------------------------------------
// The tick report
// ---------------------------------------------------------------------------

/** One thing a mission paid. Kept separate from the surface awards, and named. */
export interface ModeAward {
  readonly element: number;
  readonly score: number;
  readonly bonus: number;
  /** The award-effect index, so a caller can see which effects a game exercised. */
  readonly effect: number;
}

/** Everything one tick of the mission machine did. */
export interface ModeTickReport {
  readonly awards: readonly ModeAward[];
  /** Display lines the mission asked for, in the order it asked. */
  readonly messages: readonly string[];
  /**
   * Element indices a `START`/`START_TIMED` armed this tick, in execution
   * order. The panel layer needs the INDEX and not just the arming: the
   * element's +$14 display record names the slot-5 animations a START queues
   * on the score panel, and the wiring from index to objects lives in the
   * panel document (`table-panel.ts`), not here.
   */
  readonly elementStarts: readonly number[];
  /**
   * Message-record indices shown this tick, in execution order — the same
   * records whose text lands in `messages`, kept as indices because the panel
   * document wires each message record to the slot-5 objects it displays.
   */
  readonly messagesShown: readonly number[];
  /** `TableModes.missions` index started this tick, or -1. */
  readonly missionStarted: number;
  /** True on the tick the running mission reached its END. */
  readonly missionEnded: boolean;
  /** `BALLS_UP_TO`'s highest request this tick, or 0. Capped at three. */
  readonly ballsUpTo: number;
  /** How many balls `BALL_REMOVE` asked the machine to take off the table. */
  readonly ballsRemoved: number;
  /**
   * Lock devices whose held ball a `PUSH`/`PUSH_LINKED` ejected this tick.
   *
   * MEASURED mechanism: PUSH's handler 0x5BFC stacks the lock DEVICE record at
   * `$23DC(a5)` and the per-frame popper 0x7078 runs a $4C-frame timer, then
   * physically ejects the held ball using the device's own position and
   * impulse words (+$06..+$0D) — which is how every non-final lock of a
   * multiball ladder gives the ball back. The caller decides what "eject"
   * means in this port; see `runModes` in game-loop.ts for the labelled
   * divergence (trough and serve queue, not an in-place kick).
   */
  readonly lockEjects: readonly LockDevice[];
  /** Lock devices whose held ball `BALL_REMOVE` took off the table. */
  readonly lockRemoves: readonly LockDevice[];
  /**
   * Every opcode-19 (MUSIC) instruction executed this tick, in execution
   * order, as the SITE that executed it: the script's index and the
   * instruction's pc, both indices into data the modes document already ships.
   * The music manifest maps the same pair to the decoded {command, position,
   * bank}. See `OP_MUSIC`.
   */
  readonly musicCues: readonly ModeMusicCue[];
  /**
   * The BONUS MULTIPLIER an award effect 5 set this tick, or -1 for none.
   *
   * Reported, not applied: it belongs to the player record's `+$12`, which the
   * scoring state owns. -1 rather than 0 because 0 is a value the field can
   * legally hold — it is what every ball starts with.
   */
  readonly bonusMultiplier: number;
  /** An award effect 2 fired: this ball's bonus survives into the next one. */
  readonly holdBonus: boolean;
  /** An award effect 8 fired: this ball's multiplier survives into the next one. */
  readonly holdMultiplier: boolean;
  /**
   * What award effects 16 and 7 paid of their counters' accumulators this
   * tick, through $6BCC: SCORE only, no bonus half, on top of the element's
   * own score and bonus riding in `awards`. Reported rather than applied for
   * the same reason the multiplier is — the score is the scoring state's.
   */
  readonly comboPaid: number;
  /**
   * Scoring-layer flag ids the force-off `bclr`ed this tick, in the order it
   * cleared them: the first-hit awards a disarm re-armed. Reported rather than
   * applied because `ScoringState.flags` is the scoring layer's, exactly as the
   * multiplier and the two holds above are. See `forceStartLampsOff`.
   */
  readonly clearedFlagIds: readonly string[];
  /**
   * Ticks mode-script opcode 11 (+0x005992) set the BALL SAVE to, or -1 for a
   * tick in which no script ran one. Reported, not applied: `$D8A(a5)` is one
   * machine-global word and the loop owns it. See `Game.ballSaveTicks`.
   */
  readonly ballSaveTicks: number;
  /** Opcodes executed whose behaviour is not decoded. See the header. */
  readonly unimplemented: number;
}

/** One executed music opcode, named the way the manifests key it. */
export interface ModeMusicCue {
  readonly script: number;
  readonly pc: number;
}

/** A tick in which the mission machine did nothing at all. */
export const EMPTY_MODE_TICK: ModeTickReport = Object.freeze({
  awards: Object.freeze([]),
  messages: Object.freeze([]),
  elementStarts: Object.freeze([]),
  messagesShown: Object.freeze([]),
  missionStarted: -1,
  missionEnded: false,
  ballsUpTo: 0,
  ballsRemoved: 0,
  lockEjects: Object.freeze([]),
  lockRemoves: Object.freeze([]),
  musicCues: Object.freeze([]),
  bonusMultiplier: -1,
  holdBonus: false,
  holdMultiplier: false,
  comboPaid: 0,
  clearedFlagIds: Object.freeze([]),
  ballSaveTicks: -1,
  unimplemented: 0,
});

interface Accumulator {
  awards: ModeAward[];
  messages: string[];
  elementStarts: number[];
  messagesShown: number[];
  missionStarted: number;
  missionEnded: boolean;
  ballsUpTo: number;
  ballsRemoved: number;
  lockEjects: LockDevice[];
  lockRemoves: LockDevice[];
  musicCues: ModeMusicCue[];
  bonusMultiplier: number;
  holdBonus: boolean;
  holdMultiplier: boolean;
  comboPaid: number;
  /**
   * Ticks mode-script opcode 11 wrote into `$D8A(a5)` this tick, or -1 for "it
   * did not run". REPORTED rather than applied, and that is the correction:
   * `$d8a` is ONE machine-global word (+0x00599A `move.w d0,$d8a(a5)`), not a
   * per-player field, so a copy sitting in this bank would be the wrong shape
   * the moment a second player existed. The loop owns the word.
   */
  ballSaveTicks: number;
  /**
   * Scoring-layer flag ids the force-off's `bclr` re-armed this tick, in the
   * order it cleared them. Reported rather than applied: the flag set belongs
   * to `ScoringState`. See `forceStartLampsOff`.
   */
  clearedFlagIds: string[];
  unimplemented: number;
}

// ---------------------------------------------------------------------------
// The opcodes
// ---------------------------------------------------------------------------

function elementAt(modes: TableModes, index: number): ModeElement | null {
  return index < 0 ? null : (modes.elements[index] ?? null);
}

function pushMessage(modes: TableModes, out: Accumulator, message: number): void {
  const record = message < 0 ? undefined : modes.messages[message];
  if (record === undefined) return;
  out.messagesShown.push(record.index);
  for (const line of record.lines) out.messages.push(line);
}

/** `START` / `START_TIMED`: arm an element for this player and light its lamp. */
function startElement(
  modes: TableModes,
  state: ModeState,
  out: Accumulator,
  index: number,
  seconds: number,
): void {
  const element = elementAt(modes, index);
  if (element === null) return;
  // DECODED, main.seg00 +0x005A36: the handler is `bset.b d6,$1(a2)` followed
  // by a branch that leaves on the OLD bit — a START on an element that is
  // already armed for this player is a COMPLETE no-op, with no timer rewrite
  // and no re-blink. The DONE test at +0x005A2C is the same shape.
  if (state.done[index] === 1) return;
  const alreadyArmed = state.armed[index] === 1;
  if (!alreadyArmed) {
    state.armed[index] = 1;
    state.timers[index] = seconds > 0 ? seconds * TICKS_PER_SECOND : 0;
    out.elementStarts.push(index);
    pushMessage(modes, out, element.displayStart);
  }

  // RECONSTRUCTION. TAKING a mode-arm shot while nothing is running starts the
  // selector's next mission. See `startSelectedMission` for the whole argument;
  // the short version is that Law 'n Justice's type-1 MODE device fires a script
  // whose only job is to arm one of these, and every mission consumes and
  // restores exactly them.
  //
  // THE SHOT, NOT THE STATE CHANGE — and that distinction is a defect fix, not
  // a refinement.
  //
  // MEASURED (research\MULTIBALL_REACH.md): hung off the state change, this
  // fired AT MOST ONCE A GAME on all three tables. The 90-game census starts
  // mission #4 in 75 of 90 Law 'n Justice games, #7 in 44 of 90 BabeWatch games
  // and #2 in 35 of 90 Extreme Sports games — always the selector's FIRST
  // entry, never a second in the same game. Driven deliberately, an Extreme
  // Sports game would start one mission and then refuse for ever, with arm
  // elements 82/83/74 sitting at armed=1, done=0: the mission prologue's
  // COMPLETE only clears the armed bit for an element some script armed with a
  // live timer (the `bclr` at +0x005B9C is skipped otherwise — see OP_COMPLETE),
  // and the epilogue's CLEAR_DONE only clears DONE. So the element stayed lit
  // and every later START was a no-op.
  //
  // WHY THAT MATTERED: Law 'n Justice's ladder 8 needs EIGHT missions in a game
  // and Extreme Sports' ladders 6 and 8 need FIVE and SIX, and Extreme Sports
  // has no lock route to a multiball at all — so its multiball, the headline
  // feature of this game, was structurally unreachable. Driven now, it starts on
  // the fifth mission (script 166, `BALLS_UP_TO 3`) and again on the eleventh
  // ("ARE YOU MAN ENOUGH FOR IRON MAN"), and the DECODED mission counter walks
  // with it — counter 1 climbs 1,2,3,4,5 and wraps, which is what a ladder
  // whose entries are the mission launchers is for.
  //
  // The machine's own START stays a no-op: the arm, the timer, the lamp and the
  // display record above are all still skipped for an already-armed element.
  // What moved is only the RECONSTRUCTION's trigger, from "the lamp lit" to
  // "the lit shot was taken" — which is what a mode target does when a player
  // hits it again. The census is unmoved by this (medians 3,247,500 /
  // 4,531,170 / 935,000 and every write-off site identical), because a blind
  // bot re-takes that shot with no mission running about once a game anyway.
  if (state.mission < 0 && modes.armElements.includes(index)) {
    startSelectedMission(modes, state);
  }
}

/**
 * `AWARD`: the scoring opcode, and the one that makes a mission advance.
 *
 * Both refusals are the handler's own, in its order. A shot already DONE for
 * this player pays nothing. Then `bclr` of the armed bit: if the bit was already
 * clear the award is skipped entirely — which is what stops a lit-shot script
 * from paying twice when a ball rattles across the same target, and what makes
 * the mission's `WAIT` a level-triggered test rather than an edge one.
 */
function awardElement(
  modes: TableModes,
  state: ModeState,
  out: Accumulator,
  index: number,
): void {
  const element = elementAt(modes, index);
  if (element === null) return;
  if (state.done[index] === 1) return;
  if (state.armed[index] === 0) return;
  state.armed[index] = 0;
  state.timers[index] = 0;
  // MEASURED: the award lamp handler or.b's the always-on byte of the
  // element's +$08 lamp, so the awarded shot's insert stays lit steady. The
  // latch is presentation state; see its declaration. The GROUP view of the
  // same +$05 byte is rules state — a group whose lamps are award lamps
  // completes on it — so both are written here.
  state.awardLit[index] = 1;
  for (const lamp of groupJoins(modes).awardByElement.get(index) ?? []) {
    state.groupLampAlways[lamp] = 1;
  }
  // MEASURED: the relight. 0x5CA8 sets the armed bit straight back when the
  // element's flags carry a bit of $A, so a lock-lit lamp survives its own
  // award and the next capture counts too. See `FLAGS_RELIGHT`.
  if ((element.flags & FLAGS_RELIGHT) !== 0) state.armed[index] = 1;
  // A disarm the active-element service observes runs the force-off $6234 on
  // the element's START lamp; a relit element never goes out, so never does.
  if (state.armed[index] === 0) forceStartLampsOff(modes, state, out, index);

  out.awards.push({
    element: index,
    score: element.score,
    bonus: element.bonus,
    effect: element.effect,
  });
  pushMessage(modes, out, element.displayAward);
  applyAwardEffect(modes, state, out, index, element);
}

/**
 * THE LAUNCHER WALK, main.seg00 0x5EAA, on the record's UNCAPPED total.
 *
 * The walk compares `+$16 + 2p` against each ascending id; running off the
 * 0xFFFE terminator subtracts the wrap word from the total in place (0x5F2A) and
 * re-walks, which is why a finished ladder starts over. `launch` is the
 * difference between the two callers: effect 6's tail at 0x5E9E queues the
 * matched entry's launcher, effect 21's at 0x5FDE discards the result and only
 * the ladder's own lamp bookkeeping (which this port does not model) happens.
 */
function walkLadder(modes: TableModes, state: ModeState, counterIndex: number, launch: boolean): void {
  const counter = modes.counters[counterIndex];
  const ladder = counter === undefined || counter.ladder < 0 ? undefined : modes.ladders[counter.ladder];
  if (ladder === undefined || ladder.entries.length === 0) return;
  let total = state.counterTotals[counterIndex] ?? 0;
  // Bounded so a wrap word that cannot catch the total (or a wrap of zero, the
  // 0xFFFF-terminated tables) ends the walk instead of spinning.
  //
  // THE MACHINE'S WRAP DOES MORE THAN SUBTRACT: at +0x005F2A, when no ladder
  // entry has fired for this player yet, it queues the record's +$4C and then
  // resets the record outright — running step back to master, counts back to
  // +$02, accumulator cleared (+0x005F48..+0x005F64). None of that is modelled
  // and none of it is reachable by the running-step machine: EVERY counter any
  // of effects 10/14/15/25/27 names has `ladder` -1 (BabeWatch 1 and 3, Extreme
  // Sports 6, 7, 10 and 14, Law 'n Justice 4 and 14), so this walk returns
  // above before it could ever touch a jackpot.
  const lastId = ladder.entries[ladder.entries.length - 1]?.id ?? 0;
  while (ladder.wrap > 0 && total > lastId) total -= ladder.wrap;
  state.counterTotals[counterIndex] = total;
  if (!launch) return;
  const entry = ladder.entries.find((one) => one.id === total);
  if (entry !== undefined) queueScript(state, entry.script);
}

/**
 * The body 0x5E5A and 0x5FA8 share, byte for byte down to their last branch.
 *
 *     movea.l $34(a2),a0
 *     move.w  $6(a0,d6.w*2),d0
 *     move.w  $4(a0),d2          ; the cap
 *     beq     +                  ; uncapped: never finished, never continues
 *     cmp.w   d2,d0 / beq  rts   ; ALREADY AT THE CAP: nothing at all happens
 *   + addq.w  #1,d0
 *     move.w  d0,$6(a0,d6.w*2)
 *     addq.w  #1,$16(a0,d6.w*2)
 *     tst.w   d2 / beq  ladder    ; uncapped -> no continuation, ever
 *     cmp.w   d2,d0 / bcs ladder  ; not there yet
 *     move.l  $48(a0),d0 / beq / jsr $6C10
 *
 * so the continuation fires EXACTLY ONCE, on the award that reaches the cap, and
 * the count then sticks. The old per-element reading fired it every
 * `max(1, cap)` awards and reset the count to zero afterwards, which for the
 * corpus's uncapped counters meant firing on every single award.
 */
function bumpCounter(modes: TableModes, state: ModeState, counterIndex: number, launch: boolean): void {
  const counter = modes.counters[counterIndex];
  if (counter === undefined) return;
  const count = state.counterCounts[counterIndex] ?? 0;
  if (counter.cap !== 0 && count === counter.cap) return;
  state.counterCounts[counterIndex] = count + 1;
  state.counterTotals[counterIndex] = (state.counterTotals[counterIndex] ?? 0) + 1;
  if (counter.cap !== 0 && count + 1 >= counter.cap && counter.continuation >= 0) {
    queueScript(state, counter.continuation);
  }
  walkLadder(modes, state, counterIndex, launch);
}

/**
 * 0x5FE4, the six backwards `abcd`: accumulator += step — and the CLAMP at
 * 0x6000 the add falls straight through into. When the record carries a BCD
 * target (+$40 not $FFFFFFFF) an accumulator past it is written back as
 * exactly it; effects 11, 16 and 18 all enter here, so the clamp guards every
 * add. The ball-start rebuild is the one step-multiplier that does NOT come
 * through this routine, and it is the one place the clamp does not run.
 *
 * THE STEP IT ADDS IS THE RUNNING ONE. `lea $38(a0),a1` predecrements into
 * +$37..$32, not into the +$2F..$2A master, so a step that effect 15/25/27 or
 * opcode 6/7/13 has moved is the step this adds. No shipped counter is on both
 * sides of that — the six records effects 11/16/18 reach are named by no
 * step-writing opcode but `RESET_GROUP`, which writes the master back — so the
 * corpus cannot tell the two readings apart today; the running one is what the
 * instruction says.
 */
function addStepToAccumulator(modes: TableModes, state: ModeState, counterIndex: number): void {
  const counter = modes.counters[counterIndex];
  if (counter === undefined) return;
  let value = (state.counterAccumulators[counterIndex] ?? 0) + (state.counterSteps[counterIndex] ?? counter.step);
  if (counter.target >= 0 && value > counter.target) value = counter.target;
  state.counterAccumulators[counterIndex] = value;
}

/**
 * 0x61AA: the accumulator is paid to the player's SCORE through $6BCC — and
 * ONLY the score: the element award's own $6B96 pays score and bonus as a
 * pair, this routine pays one field. The accumulator itself is NOT consumed;
 * only the window expiry and the resets clear it, which is exactly what makes
 * a chain pay 1,000,000 then 2,000,000 then 3,000,000.
 */
function payAccumulator(state: ModeState, out: Accumulator, counterIndex: number): void {
  out.comboPaid += state.counterAccumulators[counterIndex] ?? 0;
}

/**
 * THE RUNNING STEP, mutated. 0x60DC (effect 15) and 0x60B2 (effect 25) are the
 * same six backwards BCD bytes with `abcd` and `sbcd`; 0x60FA (effect 27) is
 * 15's body with the source swapped for a ramp's live value.
 *
 * The floor at zero is the `sbcd` chain's own: six bytes of packed BCD cannot
 * go negative, they borrow out of the top and wrap to 10^12 minus the
 * difference. NOTHING in the corpus reaches it — there is not one effect-25
 * element on any of the three tables (see `BALL_SAVER_JACKPOTS.md` §5) — so the
 * wrap is unreachable and a clamp is the honest reconstruction of an
 * unreachable case rather than a guess at one.
 */
/**
 * The eight inline bytes opcodes 7 and 18 store, as the six-byte packed-BCD
 * number the record's own field is.
 *
 * The two operands are the record's +$30..$33 and +$34..$37 (or +$38..$3B and
 * +$3C..$3F); the BCD is the LOW SIX of those eight, so the first long
 * contributes only its bottom half-word. Every shipped operand has the first
 * long zero, so the high half is never anything but a check — but it is read,
 * because a document that quietly dropped it would be lying about its source.
 */
function bcdPairToNumber(high: number, low: number): number {
  const bytes = [
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 24) & 0xff,
    (low >>> 16) & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ];
  let value = 0;
  for (const byte of bytes) {
    const hi = byte >> 4;
    const lo = byte & 0x0f;
    if (hi > 9 || lo > 9) return 0;
    value = value * 100 + hi * 10 + lo;
  }
  return value;
}

function addToStep(state: ModeState, counterIndex: number, delta: number): void {
  const value = (state.counterSteps[counterIndex] ?? 0) + delta;
  state.counterSteps[counterIndex] = Math.max(0, value);
}

/**
 * 0x61E6, award effect 14: `movea.l $34(a2),a0 / lea $38(a0),a3 / jsr $6BCC`.
 *
 * `$6BCC` predecrements a3 six times, so the six bytes it pays are +$37..$32 —
 * the RUNNING STEP, not the accumulator that effect 7's `lea $40(a0),a3` pays.
 * Score only, and the step is NOT consumed: a table that wants the jackpot to
 * drop after a collect says so with opcode 6 or 7, which BabeWatch's script 145
 * and Extreme Sports' 81 and 112 all do.
 */
function payStep(state: ModeState, out: Accumulator, counterIndex: number): void {
  out.comboPaid += state.counterSteps[counterIndex] ?? 0;
}

/**
 * The award-effect table at 0x5D0E. Six of its entries are decoded well
 * enough to run and all six matter — three for progression, three for the
 * end-of-ball bonus; the rest are left alone.
 *
 *    2, handler 0x6086 — HOLD BONUS. Its tail is `st.b $11(a0)` on the current
 *       player record (+0x00609E), and +$11 is the byte `$427C` tests before
 *       clearing the accumulator for the next ball. BabeWatch's element 72 is
 *       the corpus's only user, and BabeWatch's package carries the string
 *       "BONUS HELD" (h4+0x6332) to say so.
 *    5, handler 0x60D0 — SET THE BONUS MULTIPLIER, `move.w $34(a2),$12(a0)`
 *       (+0x0060D4): the element's own +$34, as an immediate. This is the
 *       x2..x10 insert row, and it SETS rather than advances — the ladder is
 *       five separate elements, one per rung, and whichever the player lights
 *       last is the one that stands.
 *    8, handler 0x60A8 — HOLD MULTIPLIER, `st.b $14(a0)` (+0x0060AC), the same
 *       shape as effect 2 for the other field. Law 'n Justice's element 64.
 *
 *    6, handler 0x5E5A — the COUNT DISPATCH, and the decoded multiball lock
 *       rule. Steps the counter record shared by every element pointing at it,
 *       then walks the launcher table inline at the record's +$50 (0x5EAA): the
 *       entry whose ascending id equals the record's TOTAL has its script queued
 *       through $6C10, and walking past the 0xFFFE terminator subtracts the wrap
 *       word from the total and re-walks (0x5F26). The Nth qualifying lock
 *       therefore runs the Nth launcher — "BALL 1 LOCKED" through the multiball
 *       MODE_STARTs and the "n MORE TO START MODE" alternates are all just
 *       positions on one linear counter. See `ModeLadder` in table-modes.ts.
 *   16, handler 0x5E4E and 18, handler 0x5E46 — the COMBO effects. Both add the
 *       record's step into its BCD accumulator (0x5FE4, clamped at 0x6000) and
 *       then step the record exactly as effect 6 does; 16 additionally pays the
 *       accumulator to the score (0x61AA). 7, handler 0x61AA alone, pays it
 *       without stepping anything; 11, handler 0x5FE4 alone, grows it without
 *       paying; 20, handler 0x620E, arms the record's expiry window with the
 *       element's +$38 seconds. See the `EFFECT_COUNT_*` note for the whole
 *       machine and for the unwired remainder (10, 14 and the running-step
 *       mutators 15/25/27).
 *   21, handler 0x5FA8 — the LADDER. Steps the record and, when the count
 *       reaches the record's cap, queues its +$48 continuation ONCE. This is how
 *       a mission's later shots get armed at all.
 *   24, handler 0x6220 — steps the same record BACK, and Law 'n Justice's
 *       element 82 is the corpus's one user: its counter 14 runs 3 up to 6.
 *   23, handler 0x6024 — ADD TIME to the running mode timer. Law 'n Justice's
 *       Bumper Mania says so on the display: "BUMPERS ADD" / "TIME".
 */
function applyAwardEffect(
  modes: TableModes,
  state: ModeState,
  out: Accumulator,
  index: number,
  element: ModeElement,
): void {
  // The three player-record effects. They are REPORTED rather than applied: the
  // fields they write live in the scoring state (see `scoring.ts` for the record
  // map), which this module deliberately cannot reach. Last one this tick wins,
  // which is what three consecutive `move.w`s into one word would also do.
  if (element.effect === EFFECT_SET_MULTIPLIER) {
    out.bonusMultiplier = element.multiplier;
    return;
  }
  if (element.effect === EFFECT_HOLD_BONUS) {
    out.holdBonus = true;
    return;
  }
  if (element.effect === EFFECT_HOLD_MULTIPLIER) {
    out.holdMultiplier = true;
    return;
  }
  // The counting and accumulator effects, all on the record the element's
  // +$34 names.
  if (element.counter >= 0) {
    if (element.effect === EFFECT_COUNT_DISPATCH) {
      bumpCounter(modes, state, element.counter, true);
      return;
    }
    if (element.effect === EFFECT_COUNT_AND_PAY || element.effect === EFFECT_COUNT_AND_ADD) {
      // 0x5E4E and 0x5E46 share their first two calls IN THIS ORDER — the
      // add (0x5FE4) runs before the count body (0x5E5A), so a count already
      // sitting at its cap still grows the accumulator — and 16's third call
      // (0x61AA) pays the freshly grown value, which is why the first combo
      // of a chain is worth one whole step.
      addStepToAccumulator(modes, state, element.counter);
      bumpCounter(modes, state, element.counter, true);
      if (element.effect === EFFECT_COUNT_AND_PAY) {
        payAccumulator(state, out, element.counter);
      }
      return;
    }
    if (element.effect === EFFECT_ADD_STEP) {
      addStepToAccumulator(modes, state, element.counter);
      return;
    }
    if (element.effect === EFFECT_PAY_ACCUMULATOR) {
      payAccumulator(state, out, element.counter);
      return;
    }
    // THE RUNNING-STEP MACHINE. See `ModeState.counterSteps`.
    if (element.effect === EFFECT_PAY_STEP) {
      payStep(state, out, element.counter);
      return;
    }
    if (element.effect === EFFECT_STEP_ADD || element.effect === EFFECT_STEP_SUBTRACT) {
      addToStep(
        state,
        element.counter,
        element.effect === EFFECT_STEP_ADD ? element.stepAddend : -element.stepAddend,
      );
      return;
    }
    if (element.effect === EFFECT_STEP_ADD_RAMP) {
      // 0x60FA harvests whatever the ramp has reached — running or stopped, and
      // zero before its mission ever started it, which is exactly what the
      // machine's own uninitialised +$04..$09 gives.
      if (element.stepRamp >= 0) {
        addToStep(state, element.counter, state.rampValues[element.stepRamp] ?? 0);
      }
      return;
    }
    if (element.effect === EFFECT_PAY_N) {
      // 0x61BA: pay the ACCUMULATOR `min(ask, count)` times, and zero the count
      // ONLY when it held fewer than the ask — `sub.w d0,d1 / bpl $61d2` skips
      // the `clr.w $6(a0,d6.w*2)` when the count could cover it, so a count
      // that can pay in full is not spent at all. Law 'n Justice's element 89
      // asks for 25.
      const count = Math.max(0, state.counterCounts[element.counter] ?? 0);
      let times = element.payCount;
      if (count < times) {
        times = count;
        state.counterCounts[element.counter] = 0;
      }
      for (let i = 0; i < times; i += 1) payAccumulator(state, out, element.counter);
      return;
    }
    if (element.effect === EFFECT_ARM_WINDOW) {
      // 0x620E: the window is SET, not extended — `move.w d0,$26(a0)` — so
      // re-arming with a shorter window shortens it, and the two Law 'n
      // Justice arms (5 s and 10 s) really are different windows.
      state.counterWindows[element.counter] = element.windowSeconds * TICKS_PER_SECOND;
      return;
    }
    if (element.effect === EFFECT_ADVANCE_LADDER) {
      bumpCounter(modes, state, element.counter, false);
      return;
    }
    if (element.effect === EFFECT_COUNT_DOWN) {
      // 0x6220: `tst.w $6(a0,d6.w*2) / beq` guards both decrements, so a count
      // already at zero stays there and the total does not go negative either.
      const count = state.counterCounts[element.counter] ?? 0;
      if (count !== 0) {
        state.counterCounts[element.counter] = count - 1;
        state.counterTotals[element.counter] = (state.counterTotals[element.counter] ?? 0) - 1;
      }
      return;
    }
  }
  if (element.effect === EFFECT_ADD_TIME && state.mission >= 0 && state.waitTicks > 0) {
    state.waitTicks += TICKS_PER_SECOND;
    return;
  }
  void index;
}

/**
 * THE COMBO COUNT the end-of-ball bonus pays for, for the current player.
 *
 * The bonus routine reads exactly this word — `move.w $dbe(a5),d0` then
 * `move.w (bd,PC,d0.w*2),d0` resolving to the counter record's `+$06 + 2p` (Law
 * 'n Justice h4+0x2A62 -> h4+0x4550, Extreme Sports h4+0x2A52 -> h4+0x37FE) —
 * and multiplies it by the six packed-BCD bytes at h4+0x2BA2 / +0x2B92, which are
 * `00 00 01 00 00 00` on both. Zero when the table has no live combo counter,
 * which on BabeWatch is the machine's own answer and not a gap: see
 * `TableModes.comboCounter`.
 *
 * READ IT BEFORE THE BALL-START RESET. `jsr $5136` at +0x00504C runs the whole
 * bonus, panels and all, and only then does `+0x0050BC` call the counter walk;
 * on Extreme Sports, whose combo counter carries neither carry-across bit, the
 * two orders give different answers.
 */
export function comboCount(modes: TableModes, state: ModeState): number {
  if (modes.comboCounter < 0) return 0;
  return Math.max(0, state.counterCounts[modes.comboCounter] ?? 0);
}

/**
 * Runs ONE instruction of `script` at `pc`.
 *
 * Returns the next PC, or -1 to end this script. `isMission` picks the two
 * behaviours that differ between the interpreters: only the mission may suspend
 * on a `WAIT`, and only the background queue may start one.
 */
function step(
  modes: TableModes,
  state: ModeState,
  out: Accumulator,
  script: ModeScript,
  pc: number,
  isMission: boolean,
): number {
  const at = script.indexOfPc(pc);
  const instruction = at < 0 ? undefined : script.ops[at];
  if (instruction === undefined) return -1;
  const args = instruction.args;
  const next = script.ops[at + 1]?.pc ?? -1;

  switch (instruction.op) {
    case OP_END:
      return -1;

    case OP_START:
      startElement(modes, state, out, args[0] ?? -1, 0);
      return next;

    case OP_START_TIMED:
      startElement(modes, state, out, args[0] ?? -1, args[1] ?? 0);
      return next;

    case OP_COMPLETE: {
      const index = args[0] ?? -1;
      if (index >= 0) {
        state.done[index] = 1;
        // DECODED, main.seg00 +0x005B88: the handler sets DONE and puts the
        // lamp out, but its `bclr` of the armed bit at +0x005B9C is SKIPPED for
        // a bit-1 element — a permanently lit shot stays armed — and is also
        // skipped when the element's countdown at +$2E is negative, which the
        // resets write for everything they arm. So in practice COMPLETE only
        // disarms an element that some script armed with a live timer.
        const element = elementAt(modes, index);
        const permanent = element !== null && (element.flags & ELEMENT_FLAG_LIT_AT_GAME_START) !== 0;
        if (!permanent && state.timers[index] !== 0) {
          state.armed[index] = 0;
          state.timers[index] = 0;
          forceStartLampsOff(modes, state, out, index);
        }
      }
      return next;
    }

    case OP_AWARD:
      awardElement(modes, state, out, args[0] ?? -1);
      return next;

    case OP_CLEAR_DONE: {
      const index = args[0] ?? -1;
      if (index >= 0) state.done[index] = 0;
      return next;
    }

    case OP_LAMP_OFF: {
      const index = args[0] ?? -1;
      // DECODED, main.seg00 +0x005A10: the handler REFUSES a bit-1 element and
      // returns without touching it. Now that bit-1 elements are armed from the
      // first frame this is load-bearing: one LAMP_OFF would otherwise kill an
      // always-lit shot for the rest of the game.
      const element = elementAt(modes, index);
      if (element !== null && (element.flags & ELEMENT_FLAG_LIT_AT_GAME_START) !== 0) return next;
      if (index >= 0) {
        state.armed[index] = 0;
        state.timers[index] = 0;
        // The force-off at $6234 takes the whole lamp out, so the award
        // relight latch goes with it — on both its per-element view and the
        // group's own always-on mask for the element's +$08 lamp.
        state.awardLit[index] = 0;
        forceStartLampsOff(modes, state, out, index);
        for (const lamp of groupJoins(modes).awardByElement.get(index) ?? []) {
          state.groupLampAlways[lamp] = 0;
        }
      }
      return next;
    }

    case OP_PUSH:
    case OP_PUSH_LINKED: {
      // DECODED, and it closed the last open question about locks: the operand
      // is not an element at all but a lock DEVICE record. The handlers 0x5BFC
      // and 0x5C14 push it onto the stack at `$23DC(a5)`, and the per-frame
      // popper at 0x7078 pops one, runs a $4C-frame timer and physically
      // ejects the ball that device is holding — the intermediate steps of a
      // multiball lock ladder spit the ball back out, and only the
      // tier-completing step (which never pushes) leaves it held for
      // `BALL_REMOVE`. The eject itself is reported to the caller; where the
      // ball reappears in this port is game-loop.ts's labelled call.
      const device = modes.lockDeviceForElement(args[0] ?? -1);
      if (device !== null) {
        out.lockEjects.push(device);
        return next;
      }
      // A push of anything that is not a lock device is the dynamic-link use,
      // whose consumer is still undecoded. The old reading — treat the operand
      // as an element and put its lamp out — is kept for PUSH, since that is
      // what the exporter's element pool made of the operand and nothing that
      // has been traced contradicts it for the non-lock records.
      if (instruction.op === OP_PUSH) {
        const index = args[0] ?? -1;
        if (index >= 0) {
          state.armed[index] = 0;
          state.timers[index] = 0;
          forceStartLampsOff(modes, state, out, index);
        }
        return next;
      }
      out.unimplemented += 1;
      return next;
    }

    case OP_MODE_START: {
      const target = args[0] ?? -1;
      // One mission at a time: `tst.b $d9b(a5) / bne` at the top of 0x5D80.
      if (target < 0 || state.mission >= 0) return next;
      state.mission = target;
      state.missionPc = 0;
      state.missionIndex = modes.missions.findIndex((mission) => mission.script === target);
      state.suspended = false;
      state.waitElement = -1;
      state.waitTicks = 0;
      state.waitTimeoutPc = -1;
      state.loop = 0;
      state.resumePc = -1;
      // `+0x005D86  clr.w $db8(a5)` and `+0x005DAE  clr.b $d9d(a5)`: a new
      // mission starts with no wind-up vector and no teardown latch.
      state.waitIndefinite = false;
      state.abortWait = false;
      out.missionStarted = state.missionIndex;
      return next;
    }

    case OP_JMP:
      return args[0] ?? -1;

    case OP_SET_BALL_SAVE:
      // Opcode 11 is SET BALL SAVE SECONDS, not "set intro". Law 'n Justice's
      // scripts re-arm it with 2, 10 and 30-second operands.
      // +0x005992 is `move.w $2(a1),d0 / mulu.w $50(a5),d0 / move.w d0,$d8a(a5)`
      // — a plain store, so a script SETS the saver rather than extending it,
      // and a script that arms 10 seconds over a running 30 shortens it.
      out.ballSaveTicks = Math.max(0, args[0] ?? 0) * TICKS_PER_SECOND;
      return next;

    // THE FOUR OPCODES OF THE RUNNING-STEP MACHINE. An opcode is in this set
    // exactly when its handler writes the counter record's step (+$30..$37) or
    // its accumulator (+$38..$3F); opcode 22 (SET_COUNT_SELF, 0x5C2E) writes
    // neither and stays a no-op, as it was.
    case OP_LINK_RESTORE: {
      // 0x5C40: `move.l $28(a2),$30(a2) / move.l $2c(a2),$34(a2)` — the step
      // alone, back to its master. BabeWatch's script 145 opens with one.
      const counter = args[0] ?? -1;
      const record = counter < 0 ? undefined : modes.counters[counter];
      if (record !== undefined) state.counterSteps[counter] = record.step;
      return next;
    }

    case OP_SET_VALUE: {
      // 0x5C7E: `move.l $6(a1),$30(a2) / move.l $a(a1),$34(a2)` — the step SET
      // from eight bytes of packed BCD inline in the script. The step's own six
      // are +$32..$37, so the low half-word of the first long and all of the
      // second; every shipped operand has the first long zero.
      const counter = args[0] ?? -1;
      if (counter >= 0 && modes.counters[counter] !== undefined) {
        state.counterSteps[counter] = bcdPairToNumber(args[1] ?? 0, args[2] ?? 0);
      }
      return next;
    }

    case OP_RESET_GROUP: {
      // 0x59BC: the step back to its master, both per-player words back to the
      // record's +$02, and the accumulator cleared — the per-ball walk's body
      // without the flag tests, on one named record.
      const counter = args[0] ?? -1;
      const record = counter < 0 ? undefined : modes.counters[counter];
      if (record !== undefined) {
        state.counterSteps[counter] = record.step;
        state.counterCounts[counter] = record.reset;
        state.counterTotals[counter] = record.reset;
        state.counterAccumulators[counter] = 0;
      }
      return next;
    }

    case OP_SET_MAX: {
      // 0x5C52: `move.l $6(a1),$38(a2) / move.l $a(a1),$3c(a2)` — the same
      // shape as SET_VALUE for the ACCUMULATOR instead of the step.
      const counter = args[0] ?? -1;
      if (counter >= 0 && modes.counters[counter] !== undefined) {
        state.counterAccumulators[counter] = bcdPairToNumber(args[1] ?? 0, args[2] ?? 0);
      }
      return next;
    }

    case OP_RAMP_START: {
      // 0x5DDA: `move.l $a(a2),$2(a2) / move.l $e(a2),$6(a2) / st.b (a2)` —
      // reload the start value and run. SET, so re-issuing it restarts the ramp
      // from the top however far it had climbed.
      const ramp = args[0] ?? -1;
      const record = ramp < 0 ? undefined : modes.ramps[ramp];
      if (record !== undefined) {
        state.rampValues[ramp] = record.start;
        state.rampRunning[ramp] = 1;
      }
      return next;
    }

    case OP_RAMP_STOP: {
      // 0x5DEE: `clr.b (a2)`. The VALUE is left exactly where it stopped, which
      // is what lets Extreme Sports' Iron Man stop a hurry-up and still pay it.
      const ramp = args[0] ?? -1;
      if (ramp >= 0 && modes.ramps[ramp] !== undefined) state.rampRunning[ramp] = 0;
      return next;
    }

    case OP_MESSAGE:
      pushMessage(modes, out, args[0] ?? -1);
      return next;

    case OP_JMP_IF_UNLIT: {
      const index = args[0] ?? -1;
      // DECODED, main.seg00 +0x005C90: the branch is taken when the element is
      // DONE **or** not armed — not when both are false. The old reading
      // (`armed === 0 && done === 0`) fell through on a finished shot, which is
      // exactly the case the missions use it to skip.
      const unlit = index < 0 || state.done[index] === 1 || state.armed[index] === 0;
      return unlit ? (args[1] ?? -1) : next;
    }

    case OP_BALL_REMOVE: {
      // The operand names the lock DEVICE whose held ball leaves the table for
      // the trough — Law 'n Justice's multiball modes do `BALL_REMOVE <jail>`
      // and then `BALLS_UP_TO`, so the removed ball comes back as part of the
      // top-up rather than as its own serve.
      const device = modes.lockDeviceForElement(args[0] ?? -1);
      if (device !== null) out.lockRemoves.push(device);
      out.ballsRemoved += 1;
      return next;
    }

    case OP_SET_COUNT: {
      // DECODED: 0x5C64 writes the operand word into BOTH per-player words of
      // the named counter record, and this is how BabeWatch's jackpot missions
      // arm the multiball tiers — SET_COUNT 0/1/3/6 puts the lock counter at the
      // base of tiers 1..4. The operand now names the record itself rather than
      // the ladder it happens to host; a pointer that is not on the descriptor's
      // counter list arrives as -1 and stays counted as unimplemented.
      const counter = args[0] ?? -1;
      if (counter >= 0 && counter < state.counterCounts.length) {
        state.counterCounts[counter] = args[1] ?? 0;
        state.counterTotals[counter] = args[1] ?? 0;
        return next;
      }
      out.unimplemented += 1;
      return next;
    }

    case OP_BALLS_UP_TO: {
      const wanted = args[0] ?? 0;
      // `cmpi.w #$3,d1 / bhi` refuses four or more outright rather than clamping.
      if (wanted >= 1 && wanted <= MODE_MAX_BALLS) out.ballsUpTo = Math.max(out.ballsUpTo, wanted);
      return next;
    }

    case OP_WAIT: {
      if (!isMission) return next;
      const index = args[0] ?? -1;
      const seconds = args[1] ?? 0;
      // `$db2` is only set when the element is still armed for this player: a
      // shot that went out before the wait was reached is not waited on.
      state.waitElement = index >= 0 && state.armed[index] === 1 ? index : -1;
      // +0x005E2A. POSITIVE is seconds x frames-per-second; NEGATIVE is stored
      // as-is and +0x0057C0's `bmi` then refuses to decrement it, which is an
      // INDEFINITE park; ZERO does not touch `$dae` at all. This port keeps
      // `waitTicks` unsigned and carries the negative case as its own flag, so
      // that the twelve `WAIT <element>, -1, <pc>` shot loops behave exactly as
      // they always did and only the one site with no element moves. The
      // zero-inherits case is NOT modelled and never has been; it is a
      // pre-existing divergence at 9 sites across the three tables, none of
      // them a multiball script, and moving it would move the census.
      state.waitIndefinite = seconds < 0;
      // A negative operand OVERWRITES `$dae` with the negative value, so any
      // time left on a stage that ended early is gone: `bmi.b $5e36` jumps
      // straight to the `move.w d0,$dae(a5)`. Carrying a leftover countdown
      // into an indefinite wait would time it out, which the machine cannot do.
      state.waitTicks = seconds > 0 ? seconds * TICKS_PER_SECOND : 0;
      state.waitTimeoutPc = args[2] ?? -1;
      state.suspended = true;
      return next;
    }

    case OP_DBNZ: {
      if (state.loop === 0) return next;
      state.loop -= 1;
      return args[0] ?? -1;
    }

    case OP_SET_LOOP:
      state.loop = Math.max(0, args[0] ?? 0);
      return next;

    case OP_SET_RESUME:
      state.resumePc = args[0] ?? -1;
      return next;

    case OP_MUSIC:
      // The site, not the sound: the presentation resolves `script:pc` through
      // the music manifest. See OP_MUSIC's note for the handler cite.
      out.musicCues.push({ script: script.index, pc: instruction.pc });
      return next;

    case OP_VIEW_WIDE:
    case OP_NATIVE:
      // VIEW_WIDE asks for a screen mode this port does not have; NATIVE
      // reaches per-table 68k code that is not being emulated.
      out.unimplemented += 1;
      return next;

    default:
      out.unimplemented += 1;
      return next;
  }
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * The mission interpreter's frame, 0x57B0.
 *
 * The order is the handler's and it is the behaviour: the timeout is tested
 * BEFORE the watched element, so a shot made on the same frame the clock expires
 * loses. Then the armed bit; the moment `AWARD` clears it the script falls
 * through to the instruction after the `WAIT`.
 */
function stepMission(modes: TableModes, state: ModeState, out: Accumulator): void {
  if (state.mission < 0) return;
  const script = modes.scripts[state.mission];
  if (script === undefined) {
    endMission(state);
    return;
  }

  if (state.suspended) {
    // THE TEARDOWN IS TESTED FIRST, before the clock and before the element:
    // `0057B6 tst.b $d9d(a5) / 0057BA bne.b $57e4`. The multiball that this
    // mission started is over, so whatever shot it was asking for no longer
    // matters and the script jumps to its wind-up.
    //
    //     0057E4  move.w  $db8(a5),d1     the SET_RESUME operand
    //     0057E8  beq.b   $57fc           unset -> fall to the timeout branch
    //     0057F2  move.w  d1,$2(a0)       set   -> resume there
    //     0057F6  clr.w   $db8(a5)
    //     0057FC  move.w  $db6(a5),$2(a0) the WAIT's own timeout PC
    //
    // The latch is NOT cleared here — the machine clears it only at
    // `MODE_START` and at the script's end — so every later WAIT in the
    // wind-up aborts too, which is what makes a teardown run to `END`.
    if (state.abortWait) {
      state.suspended = false;
      state.waitElement = -1;
      state.waitIndefinite = false;
      const resume = state.resumePc;
      const target = resume >= 0 ? resume : state.waitTimeoutPc;
      state.resumePc = -1;
      state.waitTimeoutPc = -1;
      if (target < 0) {
        out.missionEnded = true;
        endMission(state);
        return;
      }
      state.missionPc = target;
      return;
    }
    // The clock is decremented FIRST and, only if it has run out, the timeout
    // branch is taken. If it has not, the watched element is tested in the same
    // frame — both tests happen every frame, which is the difference between a
    // timed shot the player can still make and a shot that stops mattering the
    // moment a clock is attached to it.
    if (state.waitTicks > 0) {
      state.waitTicks -= 1;
      if (state.waitTicks === 0) {
        state.suspended = false;
        state.waitElement = -1;
        const target = state.waitTimeoutPc;
        state.waitTimeoutPc = -1;
        if (target < 0) {
          out.missionEnded = true;
          endMission(state);
          return;
        }
        state.missionPc = target;
        return;
      }
      // A WAIT with a clock and NO element is a pure delay — the three-second
      // intro every mission opens with, and the pause between a mission's
      // stages. There is no shot to watch, so nothing can end it early.
      if (state.waitElement < 0) return;
    }
    if (state.waitElement >= 0 && state.armed[state.waitElement] === 1) return;
    // A NEGATIVE seconds operand with no element is an indefinite park and the
    // only thing that can end it is `abortWait`, tested above. DECODED: a
    // negative `$dae` makes `0057C0 bmi.b $57d4` skip both the decrement and
    // the timeout every frame, and `0057D8 beq.b $57e2` then returns because
    // `$db2` is null. Extreme Sports script 166 pc 76 is the one site, and it
    // is the whole body of that table's three-ball multiball.
    if (state.waitIndefinite && state.waitElement < 0) return;
    // Either the shot was made, or the wait has neither an element nor a clock.
    // RECONSTRUCTION: the second case falls through rather than parking forever.
    state.suspended = false;
    state.waitElement = -1;
    state.waitIndefinite = false;
    state.waitTimeoutPc = -1;
  }

  const next = step(modes, state, out, script, state.missionPc, true);
  if (next < 0) {
    out.missionEnded = true;
    endMission(state);
    return;
  }
  state.missionPc = next;
}

/** The background queue's frame, 0x58BC: continue a record, or take the next. */
function stepBackground(modes: TableModes, state: ModeState, out: Accumulator): void {
  if (state.background < 0) {
    const script = dequeueScript(state);
    if (script < 0) return;
    state.background = script;
    state.backgroundPc = 0;
  }
  const script = modes.scripts[state.background];
  if (script === undefined) {
    state.background = -1;
    return;
  }
  const next = step(modes, state, out, script, state.backgroundPc, false);
  if (next < 0) {
    state.background = -1;
    state.backgroundPc = 0;
    return;
  }
  state.backgroundPc = next;
}

/**
 * Advances the whole mission machine by one simulation tick.
 *
 * Element countdowns first, then the mission, then the queue. The queue runs
 * last on purpose: a script fired by a shot this tick must not be able to award
 * an element the mission is about to start waiting on, which would let a single
 * ball satisfy two stages of a ladder in one frame.
 */
export function tickModes(modes: TableModes, state: ModeState): ModeTickReport {
  const out: Accumulator = {
    awards: [],
    messages: [],
    elementStarts: [],
    messagesShown: [],
    missionStarted: -1,
    missionEnded: false,
    ballsUpTo: 0,
    ballsRemoved: 0,
    lockEjects: [],
    lockRemoves: [],
    musicCues: [],
    bonusMultiplier: -1,
    holdBonus: false,
    holdMultiplier: false,
    comboPaid: 0,
    clearedFlagIds: [],
    ballSaveTicks: -1,
    unimplemented: 0,
  };

  for (let index = 0; index < state.timers.length; index += 1) {
    const left = state.timers[index] ?? 0;
    if (left <= 0) continue;
    state.timers[index] = left - 1;
    if (left - 1 === 0) {
      state.armed[index] = 0;
      // The active-element service's own expiry path: `bclr.b d6,$1(a0)` at
      // +0x006292 falls into the force-off at +0x006296.
      forceStartLampsOff(modes, state, out, index);
    }
  }

  stepMission(modes, state, out);
  stepBackground(modes, state, out);
  // The lamp-group scan (+0x0064D0) runs as its own frame service in the
  // original; here it runs after the interpreters so a lamp lit by this tick's
  // physics is seen this tick, and the fired script queues for the next.
  scanLampGroups(modes, state);
  // The completion flash and the clear it ends in, +0x006430. It runs AFTER the
  // scan so a group completed this tick starts its sixteen frames on the next
  // one, which is the order the frame chain has them in.
  serviceGroupFlash(modes, state, out);
  // THE RAMP SERVICE, 0x6334: every running ramp's value moves one increment
  // toward its limit, and reaching the limit clamps to exactly it and STOPS the
  // ramp. Its slot in the frame chain at +0x004B70 is between the mission
  // interpreter (+0x004B6A) and the window service (+0x004B76), which is where
  // it runs here.
  for (const ramp of modes.ramps) {
    if (state.rampRunning[ramp.index] !== 1) continue;
    const value = (state.rampValues[ramp.index] ?? 0) + (ramp.up ? ramp.increment : -ramp.increment);
    // `bcs $63b2` on the borrow out of the `sbcd` chain and the two `cmp.l`
    // pairs either side of it are one test in decimal: has it reached the end?
    if (ramp.up ? value >= ramp.limit : value <= ramp.limit) {
      state.rampValues[ramp.index] = ramp.limit;
      state.rampRunning[ramp.index] = 0;
      continue;
    }
    state.rampValues[ramp.index] = value;
  }

  // THE WINDOW SERVICE, 0x56D4: every record's +$26 counts down and, on the
  // tick it reaches zero, the accumulator is cleared AND the running step goes
  // back to its +$28 master. Its slot in the frame chain at +0x004B46 is AFTER
  // both interpreters (`jsr $58BC .. $5786 .. $56D4`), so an award on the
  // window's last tick pays before the expiry wipes it — kept here by running
  // the service at the tail of the tick.
  for (let index = 0; index < state.counterWindows.length; index += 1) {
    const left = state.counterWindows[index] ?? 0;
    if (left <= 0) continue;
    state.counterWindows[index] = left - 1;
    if (left === 1) {
      state.counterAccumulators[index] = 0;
      const counter = modes.counters[index];
      if (counter !== undefined) state.counterSteps[index] = counter.step;
    }
  }

  if (
    out.awards.length === 0 &&
    out.messages.length === 0 &&
    out.elementStarts.length === 0 &&
    out.messagesShown.length === 0 &&
    out.missionStarted < 0 &&
    !out.missionEnded &&
    out.ballsUpTo === 0 &&
    out.ballsRemoved === 0 &&
    out.lockEjects.length === 0 &&
    out.lockRemoves.length === 0 &&
    out.musicCues.length === 0 &&
    out.bonusMultiplier < 0 &&
    !out.holdBonus &&
    !out.holdMultiplier &&
    out.comboPaid === 0 &&
    out.clearedFlagIds.length === 0 &&
    out.ballSaveTicks < 0 &&
    out.unimplemented === 0
  ) {
    return EMPTY_MODE_TICK;
  }
  return {
    awards: out.awards,
    messages: out.messages,
    elementStarts: out.elementStarts,
    messagesShown: out.messagesShown,
    missionStarted: out.missionStarted,
    missionEnded: out.missionEnded,
    ballsUpTo: out.ballsUpTo,
    ballsRemoved: out.ballsRemoved,
    lockEjects: out.lockEjects,
    lockRemoves: out.lockRemoves,
    musicCues: out.musicCues,
    bonusMultiplier: out.bonusMultiplier,
    holdBonus: out.holdBonus,
    holdMultiplier: out.holdMultiplier,
    comboPaid: out.comboPaid,
    clearedFlagIds: out.clearedFlagIds,
    ballSaveTicks: out.ballSaveTicks,
    unimplemented: out.unimplemented,
  };
}

/** Elements lit for this player right now, for the presentation and for tests. */
export function litElements(state: ModeState): number[] {
  const lit: number[] = [];
  for (let index = 0; index < state.armed.length; index += 1) {
    if (state.armed[index] === 1) lit.push(index);
  }
  return lit;
}
