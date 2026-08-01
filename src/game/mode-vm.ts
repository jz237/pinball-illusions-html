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
 *   - `BALLS_UP_TO`'s ceiling of three, and `BALL_REMOVE` taking a ball off the
 *     table into the trough
 *   - award effects 21 (advance the ladder) and 23 (add time to the mode timer)
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
 * NINE OPCODES DO NOTHING, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `KICK_IF`, `LINK_RESTORE`, `SET_VALUE`, `RESET_GROUP`, `RESTORE_POS`,
 * `CLEAR_BYTE`, `SET_MAX`, `SET_COUNT` and `SET_COUNT_SELF` take a pointer to a
 * record type nobody has identified — their operands fail the packed-BCD test
 * that every real element passes, which is how they were caught. Guessing at
 * them would put invented behaviour into the middle of a decoded mission. They
 * are counted in `ModeTickReport.unimplemented` so the cost of not knowing is
 * visible rather than silent.
 */

import type { ModeElement, ModeScript, TableModes } from "./table-modes.js";

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
const OP_SET_INTRO = 11;
const OP_CLEAR_DONE = 12;
const OP_LAMP_OFF = 14;
const OP_MESSAGE = 17;
const OP_ANIMATE = 19;
const OP_NATIVE = 20;
const OP_JMP_IF_UNLIT = 23;
const OP_PUSH_LINKED = 24;
const OP_IF_TWO_PLAYER = 25;
const OP_BALL_REMOVE = 26;
const OP_BALLS_UP_TO = 27;
const OP_WAIT = 28;
const OP_DBNZ = 29;
const OP_SET_RESUME = 30;
const OP_SET_LOOP = 31;

/** Award effects with decoded handlers. Everything else is left alone. */
const EFFECT_ADVANCE_LADDER = 21;
const EFFECT_ADD_TIME = 23;

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
  /** Frames left on an element's own countdown; 0 is "no timer". */
  readonly timers: Int32Array;
  /** Award effect 21's progress count, per element. */
  readonly counts: Int32Array;

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
  /** `$d8a`: the intro delay SET_INTRO writes. Carried, not yet spent. */
  introTicks: number;

  /** RECONSTRUCTION. Which selector entry the next arm shot will start. */
  selectorCursor: number;
  /** RECONSTRUCTION. One byte per mission: 1 once it has been played this game. */
  readonly played: Uint8Array;
}

export function createModeState(modes: TableModes): ModeState {
  const count = modes.elements.length;
  return {
    armed: new Uint8Array(count),
    done: new Uint8Array(count),
    timers: new Int32Array(count),
    counts: new Int32Array(count),
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
    introTicks: 0,
    selectorCursor: 0,
    played: new Uint8Array(modes.missions.length),
  };
}

/**
 * What a new ball clears.
 *
 * The mission and the queue, because neither survives a drain in this
 * reconstruction (see the divergence note in the header). The DONE bits are per
 * player and per game and are NOT cleared, exactly as the scoring layer's flag
 * bytes are not: a shot a player has finished stays finished across a ball.
 */
export function resetModesForNewBall(state: ModeState): void {
  state.armed.fill(0);
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
  /** `TableModes.missions` index started this tick, or -1. */
  readonly missionStarted: number;
  /** True on the tick the running mission reached its END. */
  readonly missionEnded: boolean;
  /** `BALLS_UP_TO`'s highest request this tick, or 0. Capped at three. */
  readonly ballsUpTo: number;
  /** How many balls `BALL_REMOVE` asked the machine to take off the table. */
  readonly ballsRemoved: number;
  /** Opcodes executed whose behaviour is not decoded. See the header. */
  readonly unimplemented: number;
}

/** A tick in which the mission machine did nothing at all. */
export const EMPTY_MODE_TICK: ModeTickReport = Object.freeze({
  awards: Object.freeze([]),
  messages: Object.freeze([]),
  missionStarted: -1,
  missionEnded: false,
  ballsUpTo: 0,
  ballsRemoved: 0,
  unimplemented: 0,
});

interface Accumulator {
  awards: ModeAward[];
  messages: string[];
  missionStarted: number;
  missionEnded: boolean;
  ballsUpTo: number;
  ballsRemoved: number;
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
  state.armed[index] = 1;
  state.timers[index] = seconds > 0 ? seconds * TICKS_PER_SECOND : 0;
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

  out.awards.push({
    element: index,
    score: element.score,
    bonus: element.bonus,
    effect: element.effect,
  });
  pushMessage(modes, out, element.displayAward);
  applyAwardEffect(modes, state, index, element);
}

/**
 * The award-effect table at 0x5D0E. Two of its entries are decoded well enough
 * to run and both matter for progression; the rest are left alone.
 *
 *   21, handler 0x5FA8 — the LADDER. Increments the element's progress count and,
 *       when the target in the counter record is reached, queues the next step.
 *       This is how a mission's later shots get armed at all.
 *   23, handler 0x6024 — ADD TIME to the running mode timer. Law 'n Justice's
 *       Bumper Mania says so on the display: "BUMPERS ADD" / "TIME".
 */
function applyAwardEffect(
  modes: TableModes,
  state: ModeState,
  index: number,
  element: ModeElement,
): void {
  if (element.effect === EFFECT_ADVANCE_LADDER) {
    state.counts[index] = (state.counts[index] ?? 0) + 1;
    if (element.counterScript >= 0 && (state.counts[index] ?? 0) >= Math.max(1, element.counterTarget)) {
      state.counts[index] = 0;
      queueScript(state, element.counterScript);
    }
    return;
  }
  if (element.effect === EFFECT_ADD_TIME && state.mission >= 0 && state.waitTicks > 0) {
    state.waitTicks += TICKS_PER_SECOND;
    return;
  }
  void modes;
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
        state.armed[index] = 0;
        state.timers[index] = 0;
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

    case OP_LAMP_OFF:
    case OP_PUSH: {
      // LAMP_OFF puts a lit shot out. PUSH also clears the element's flag bit
      // and pushes it on the `$23DC` stack, and nothing that POPS that stack has
      // been decoded — so the stack half is not reproduced, and this is the half
      // that is. See the dynamic-link note in the exporter.
      const index = args[0] ?? -1;
      if (index >= 0) {
        state.armed[index] = 0;
        state.timers[index] = 0;
      }
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

    case OP_SET_INTRO:
      state.introTicks = Math.max(0, args[0] ?? 0) * TICKS_PER_SECOND;
      return next;

    case OP_MESSAGE:
      pushMessage(modes, out, args[0] ?? -1);
      return next;

    case OP_JMP_IF_UNLIT: {
      const index = args[0] ?? -1;
      const unlit = index < 0 || (state.armed[index] === 0 && state.done[index] === 0);
      return unlit ? (args[1] ?? -1) : next;
    }

    case OP_BALL_REMOVE: {
      const index = args[0] ?? -1;
      if (index >= 0) {
        state.armed[index] = 0;
        state.timers[index] = 0;
      }
      out.ballsRemoved += 1;
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

    case OP_PUSH_LINKED:
    case OP_IF_TWO_PLAYER:
    case OP_ANIMATE:
    case OP_NATIVE:
      // PUSH_LINKED needs the undecoded stack; IF_TWO_PLAYER is a second-player
      // branch and this reconstruction has one player; ANIMATE and NATIVE reach
      // graphics and per-table 68k code that is not being emulated.
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
    missionStarted: -1,
    missionEnded: false,
    ballsUpTo: 0,
    ballsRemoved: 0,
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
    out.missionStarted < 0 &&
    !out.missionEnded &&
    out.ballsUpTo === 0 &&
    out.ballsRemoved === 0 &&
    out.unimplemented === 0
  ) {
    return EMPTY_MODE_TICK;
  }
  return {
    awards: out.awards,
    messages: out.messages,
    missionStarted: out.missionStarted,
    missionEnded: out.missionEnded,
    ballsUpTo: out.ballsUpTo,
    ballsRemoved: out.ballsRemoved,
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
