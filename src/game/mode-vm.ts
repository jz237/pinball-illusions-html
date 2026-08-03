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

import { ELEMENT_FLAG_LIT_AT_GAME_START } from "./table-modes.js";
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
 * WHAT IS DELIBERATELY LEFT OUT, and it is the other half of effects 11/16/18:
 * the record's own packed-BCD ACCUMULATOR at +$3A..$3F, the STEP at +$32..$37
 * that 0x5FE4 adds into it, the payment of the accumulator to the score at
 * 0x61AA, the WINDOW TIMER effect 20 (0x620E) writes into +$26 and the per-frame
 * service at 0x56D4 that clears the accumulator when it expires. That machinery
 * is the combo's own SCORING — on Law 'n Justice a chain pays 1,000,000, then
 * 2,000,000, then 3,000,000 while the 5- or 10-second window holds — and it is a
 * separate feature from the COUNT, which is what the bonus needs and what this
 * change delivers. `ModeCounter.step` carries the decoded per-tick value so the
 * day it lands there is nothing left to decode.
 */
const EFFECT_COUNT_DISPATCH = 6;
const EFFECT_COUNT_AND_PAY = 16;
const EFFECT_COUNT_AND_ADD = 18;
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
 * The whole mission machine, for one player.
 *
 * Typed arrays indexed by element, and integers everywhere else: no map
 * iteration order and no floating point, so two runs of the same input produce
 * the same state. The original's per-player fields are bitmasks indexed by
 * `d6`; this reconstruction has one player, so a bit is a byte here and nothing
 * else changes when a second one arrives.
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
   * `$d8a(a5)`: the BALL-SAVE countdown, in ticks.
   *
   * DECODED, and it is not an "intro delay": opcode 11 (`main.seg00
   * +0x005992`) writes the ball-save seconds, the same word SERVE arms at
   * `+0x0049AE` from `$e8e(a5)` (`.opt` record 5, default 5 / 5 / 10 s). The
   * renderer at `+0x004DEC..+0x004E20` blinks the descriptor's engine[1] lamp
   * from it — > 100 frames 4-on/4-off, 51..100 1-on/1-off, <= 50 off — and
   * `+0x0052CE` gives the ball back on a drain while it is non-zero.
   * Carried here, not yet spent: nothing reads it until the ball saver lands.
   */
  ballSaveTicks: number;

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
  return {
    armed,
    done: new Uint8Array(count),
    awardLit: new Uint8Array(count),
    timers: new Int32Array(count),
    counterCounts,
    counterTotals: Int32Array.from(counterCounts),
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
    ballSaveTicks: 0,
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
 * DIVERGENCE, STATED: `awardLit` (the lamp's +$05 always-on mask) is cleared
 * wholesale here. `+0x003F10` preserves it for lamps in a GROUP whose flags
 * byte has bit 2 set — Law 'n Justice group 8; BabeWatch 7, 11, 15, 17, 25;
 * Extreme Sports 17, 20 — and the exporter does not ship the group table yet,
 * so there is nothing here to test the bit against. When
 * `*.lamps.json` grows its `groups[]` this becomes a filter like the two above.
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
    if (counter.keepAcrossBall) continue;
    state.counterCounts[counter.index] = counter.reset;
    state.counterTotals[counter.index] = counter.reset;
  }
  state.awardLit.fill(0);
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
  if (state.armed[index] === 1 || state.done[index] === 1) return;
  state.armed[index] = 1;
  state.timers[index] = seconds > 0 ? seconds * TICKS_PER_SECOND : 0;
  out.elementStarts.push(index);
  pushMessage(modes, out, element.displayStart);

  // RECONSTRUCTION. Lighting a mode-arm shot while nothing is running starts the
  // selector's next mission. See `startSelectedMission` for the whole argument;
  // the short version is that Law 'n Justice's type-1 MODE device fires a script
  // whose only job is to arm one of these, and every mission consumes and
  // restores exactly them.
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
  // latch is presentation state; see its declaration.
  state.awardLit[index] = 1;
  // MEASURED: the relight. 0x5CA8 sets the armed bit straight back when the
  // element's flags carry a bit of $A, so a lock-lit lamp survives its own
  // award and the next capture counts too. See `FLAGS_RELIGHT`.
  if ((element.flags & FLAGS_RELIGHT) !== 0) state.armed[index] = 1;

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
 *   16, handler 0x5E4E and 18, handler 0x5E46 — the COMBO effects. Both step the
 *       same record the same way; 16 additionally pays the record's own BCD
 *       accumulator to the score, which this port does not yet do. See the
 *       `EFFECT_COUNT_*` note for exactly what is and is not reproduced.
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
  // The five counting effects, all on the record the element's +$34 names.
  if (element.counter >= 0) {
    if (
      element.effect === EFFECT_COUNT_DISPATCH ||
      element.effect === EFFECT_COUNT_AND_PAY ||
      element.effect === EFFECT_COUNT_AND_ADD
    ) {
      bumpCounter(modes, state, element.counter, true);
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
        // relight latch goes with it.
        state.awardLit[index] = 0;
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
      out.missionStarted = state.missionIndex;
      return next;
    }

    case OP_JMP:
      return args[0] ?? -1;

    case OP_SET_BALL_SAVE:
      // Opcode 11 is SET BALL SAVE SECONDS, not "set intro". Law 'n Justice's
      // scripts re-arm it with 2, 10 and 30-second operands.
      state.ballSaveTicks = Math.max(0, args[0] ?? 0) * TICKS_PER_SECOND;
      return next;

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
      if (seconds > 0) state.waitTicks = seconds * TICKS_PER_SECOND;
      else if (seconds === 0) state.waitTicks = 0;
      // seconds < 0 leaves `$dae` alone: the stage inherits the running timer.
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
    // Either the shot was made, or the wait has neither an element nor a clock.
    // RECONSTRUCTION: the second case falls through rather than parking forever.
    state.suspended = false;
    state.waitElement = -1;
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
    unimplemented: 0,
  };

  for (let index = 0; index < state.timers.length; index += 1) {
    const left = state.timers[index] ?? 0;
    if (left <= 0) continue;
    state.timers[index] = left - 1;
    if (left - 1 === 0) state.armed[index] = 0;
  }

  stepMission(modes, state, out);
  stepBackground(modes, state, out);

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
