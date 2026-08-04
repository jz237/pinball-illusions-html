/**
 * Loader for the shipped mode and mission layer
 * (`public/generated/tables/*.modes.json`).
 *
 * ---------------------------------------------------------------------------
 * WHAT ARRIVES IN THIS DOCUMENT
 * ---------------------------------------------------------------------------
 * The missions are a BYTECODE PROGRAM, not a table of rules, and everything
 * needed to run one arrives together because none of it means anything alone:
 *
 *   SCRIPTS     the event records. Each is a list of instructions, each
 *               instruction a small opcode index and its operands, terminated by
 *               opcode 0. `jsr $6C10` in the original is a QUEUE APPEND, not an
 *               interpreter — the interpreters are at 0x58BC (the background
 *               queue) and 0x57AC (the running mission).
 *   ELEMENTS    the things a script arms, awards and waits on: the physical
 *               shots of a mission, each with a packed-BCD score, a bonus and an
 *               award-effect index.
 *   MESSAGES    the display records, expanded to their text so a mission can
 *               announce itself.
 *   MISSIONS    which script each selector entry starts, and its title.
 *   TRIGGERS    which script a device surface id, a trigger zone or a ball lock
 *               fires. This is the join between the physics and the rules, and
 *               it is the piece that took longest to find: a device's award
 *               record carries the script at +$1A, a mode record at +$16, a
 *               trigger zone's object at +$06 and a lock's object at +$14.
 *
 * `scripts/export-table-modes.mjs` has the disassembly behind every one of those
 * offsets, the checks the decode passes, and — at least as important — the list
 * of things it could not settle, chiefly that nine of the pointer-taking opcodes
 * address a record type nobody has identified and that the last hop of a mission
 * ladder is written at run time by an opcode whose stack has no decoded reader.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARSER IS AS SUSPICIOUS AS THE OTHERS
 * ---------------------------------------------------------------------------
 * Same reason as `table-devices.ts`: a rules layer that is quietly one index out
 * awards the wrong shot, arms the wrong lamp and ends the wrong mission, and
 * none of that is visible from the outside. So every cross-reference in the
 * document is re-checked here — every element index, script index, message index
 * and branch target — and the first inconsistency throws. A game that refuses to
 * start is a better outcome than a game that runs the wrong mission.
 */

import { TABLE_IDS } from "./contracts.js";
import type { PlayfieldLevel, TableId, TableModesDocument } from "./contracts.js";

/** The only document schema this loader understands. */
export const TABLE_MODES_SCHEMA = "pinball-illusions/table-modes/v1";

/** Where the exported documents live under the site root (Vite serves `public/`). */
export const TABLE_MODES_BASE_PATH = "generated/tables/";

/**
 * The opcodes, by index. Names and lengths are the dispatch table at
 * main.seg00 0x5912; the operand kinds are settled per opcode in the exporter.
 *
 *   e  element index, -1 when the operand was NULL
 *   s  script index                    m  message index
 *   o  a record this decode has not identified; always -1 here
 *   n  a progress-counter index (SET_COUNT), -1 when the record is not one
 *   w  a signed word                   c  a branch target, -1 when it dangles
 *   i  a 32-bit immediate
 */
export type ModeOperandKind = "e" | "s" | "m" | "o" | "n" | "w" | "c" | "i";

export interface ModeOpcodeInfo {
  readonly index: number;
  readonly name: string;
  readonly length: number;
  readonly args: readonly ModeOperandKind[];
}

/** One decoded instruction. `args` is positional and matches the opcode's kinds. */
export interface ModeInstruction {
  /** Byte offset of this instruction inside its script, which is what branches name. */
  readonly pc: number;
  readonly op: number;
  readonly args: readonly number[];
}

export interface ModeScript {
  readonly index: number;
  readonly ops: readonly ModeInstruction[];
  /** Instruction index for a pc, so a branch is a lookup rather than a search. */
  indexOfPc(pc: number): number;
}

/**
 * The three bits of an element's flags byte (element +$00) that the two reset
 * routines read. Decoded at `main.seg00 +0x004052` (per game) and `+0x003F80`
 * (per ball); see `litAtGameStart` and its two companions below.
 */
export const ELEMENT_FLAG_ARMED_SURVIVES_BALL = 0x01;
export const ELEMENT_FLAG_LIT_AT_GAME_START = 0x02;
export const ELEMENT_FLAG_DONE_SURVIVES_BALL = 0x20;

/**
 * Counter flags bit 0: the ball-start walk REBUILDS the record's BCD
 * accumulator from the kept count. `+0x00417C` multiplies the step back in
 * with the same six-`abcd` add the effects use, once per count, after the
 * unconditional clear at +0x004136 — so a bit-0 counter starts every ball
 * with accumulator = step x count, unclamped. Bit 3, the other
 * `keepAcrossBall` bit, keeps the count but leaves the accumulator cleared
 * (+0x004158 branches straight to the next record).
 */
export const COUNTER_FLAG_REBUILD_ACCUMULATOR = 0x01;

/**
 * One playfield element: a shot a mission can arm, award and wait on.
 *
 * `score` and `bonus` are the packed-BCD fields at +$1E and +$26 read as decimal
 * numbers. `effect` is the index into the award-effect table at 0x5D0E, of which
 * six entries are decoded; see `mode-vm.ts` for which and for what the rest do
 * (nothing, deliberately).
 */
export interface ModeElement {
  readonly index: number;
  readonly flags: number;
  readonly score: number;
  readonly bonus: number;
  readonly effect: number;
  /**
   * Award effect 5's BONUS MULTIPLIER: the element's +$34 read as a WORD, which
   * is what `move.w $34(a2),$12(a0)` at +0x0060D4 stores into the player record.
   * Zero for every other effect, because the same field is a POINTER there.
   *
   * The shipped ladders are 2/4/6/8/10 on Law 'n Justice and BabeWatch — the
   * x2..x10 insert row on the playfield art — and 2/3/4/5 on Extreme Sports.
   */
  readonly multiplier: number;
  /**
   * Award effect 20's WINDOW in seconds: the element's +$38 as a word, which
   * `move.w $38(a2),d0 / mulu.w $50(a5),d0 / move.w d0,$26(a0)` at +0x006212
   * turns into ticks on the counter record's +$26 countdown. Zero for every
   * other effect — the field is per-effect, exactly as `multiplier`'s +$34 is.
   * The shipped windows: Law 'n Justice 5 s and 10 s on its combo record,
   * Extreme Sports 12 s on its.
   */
  readonly windowSeconds: number;
  /** The record's own countdown field; -1 is "no timer". */
  readonly countdown: number;
  readonly lampStart: boolean;
  readonly lampAward: boolean;
  readonly soundStart: boolean;
  readonly soundAward: boolean;
  readonly displayStart: number;
  readonly displayAward: number;
  /**
   * The PROGRESS COUNTER this element's award effect drives: an index into
   * `TableModes.counters`, or -1 when the element's +$34 is not one.
   *
   * The count lives in the RECORD, not in the element — award effects 6, 16, 18
   * and 21 all reach `+$06 + 2p` through `movea.l $34(a2),a0` and effect 24
   * decrements the same word — so every element pointing at one record shares
   * one count. Law 'n Justice's eight combo elements (28..35) all name counter
   * 12, and that is the whole of the combo rule's bookkeeping.
   *
   * -1 is not merely "no counter": award effect 17's handler (+0x00613A) queues
   * the SAME +$34 as an event record and effect 5's reads it as an immediate
   * multiplier, so the field is only a counter where the descriptor's own
   * counter list says it is. Law 'n Justice's element 11 is the corpus's live
   * example — its +$34 is a script, and the old per-element reading filed it as
   * a counter with a cap of 9.
   */
  readonly counter: number;
  /**
   * Award effect 6's count ladder: index into `TableModes.ladders`, or -1.
   *
   * The same ladder as `counters[counter].ladder` where this element's effect is
   * 6, and -1 otherwise. Kept as its own field because it means "the ladder THIS
   * element's award walks", which is what the multiball-ladder derivation below
   * and the lock tests ask about; the record's own ladder is on the counter.
   */
  readonly ladder: number;
}

/**
 * ONE PROGRESS-COUNTER RECORD, off the descriptor's own list at +$40.
 *
 * These are the machine's counters: the multiball lock tallies, the mission
 * ladders, and — on Law 'n Justice and Extreme Sports — the COMBO count the
 * end-of-ball bonus pays for. The exporter's header has the whole record map and
 * the three routines that walk the list; the fields here are the ones the
 * simulation needs.
 */
export interface ModeCounter {
  readonly index: number;
  /** The record's flags byte at +$00. See `keepAcrossBall`. */
  readonly flags: number;
  /** +$02, what both reset walks write into the count. */
  readonly reset: number;
  /**
   * +$04, the ceiling. ZERO MEANS UNCAPPED, and that is load-bearing in both
   * directions: `tst.w d2 / beq` at +0x005E66 and +0x005FB4 skips the "already
   * finished" test, and +0x005E76 / +0x005FC4 then skip the continuation, so an
   * uncapped counter counts for ever and NEVER fires its `continuation`.
   */
  readonly cap: number;
  /**
   * The record's packed-BCD step at +$32..$37, as a decimal number.
   *
   * What one tick of this counter is worth to the award effects that pay it
   * (11, 16, 18 — `$5FE4` adds it into the record's own accumulator). Carried
   * for the same reason the combo value is: Law 'n Justice's combo record's step
   * is 1,000,000, the same figure its bonus routine multiplies the combo count
   * by, from a different place in the package.
   */
  readonly step: number;
  /**
   * The BCD TARGET at +$40..$47: the ceiling the clamp at 0x6000 — the tail
   * every step-add falls through — holds the accumulator to, or -1 for the
   * $FFFFFFFF "no target" sentinel (`bmi` at +0x00600A). One shipped counter
   * carries one: Law 'n Justice's counter 1, whose 1,000,000-a-shot jackpot
   * accumulator caps at 25,000,000.
   */
  readonly target: number;
  /** +$48, the script queued when the count reaches `cap`, or -1. */
  readonly continuation: number;
  /** The launcher table inline at +$50: index into `ladders`, or -1. */
  readonly ladder: number;
  /**
   * DECODED: the count survives a drain.
   *
   * True when the flags byte carries bit 0 or bit 3. The per-BALL walk at
   * `main.seg00 +0x00412C` (one caller, `+0x0050BC`) tests bit 0 at +0x004146
   * and branches away to rebuild the record's BCD accumulator, never reaching
   * the reset; and tests bit 3 at +0x004158 and branches straight to the next
   * record. Everything else has both of its per-player counts written back to
   * `reset` for the player whose ball just ended.
   *
   * The per-GAME walk at `+0x0040CA` (one caller, `+0x0045AC`, inside NEW GAME)
   * has no such test and resets all eight player slots of every record, so this
   * flag is exactly the difference between a per-game counter and a per-ball one.
   */
  readonly keepAcrossBall: boolean;
}

/**
 * One entry of an effect-6 launcher table: when the ladder's counter reaches
 * `id`, `script` is queued. The 12-byte records inline at counter+$50.
 */
export interface ModeLadderEntry {
  readonly id: number;
  readonly script: number;
}

/**
 * One decoded count ladder — THE MULTIBALL LOCK DISPATCH, and a generic
 * count-to-launcher primitive the tables also use for smaller features.
 *
 * Award effect 6 (handler main.seg00 0x5E5A) increments the per-player counter
 * in the element's counter record and walks this table (0x5EAA) comparing the
 * count against each ascending `id`; on equality the entry's launcher script is
 * queued. Walking past the 0xFFFE terminator subtracts `wrap` from the counter
 * and re-walks (0x5F26), so a finished ladder starts over. `wrap` of 0 means
 * the table ended on 0xFFFF and never wraps.
 *
 * BabeWatch's lock ladder is the decoded shape of its multiball rule: ids 1..10
 * in capture tiers of 1/2/3/4, the tier-completing ids launching the four
 * multiball modes and the intermediate ids the "n MORE TO START MODE"
 * alternates — selection is purely positional, one linear per-game counter.
 * Law 'n Justice's is ids 1..14 in tiers of 2/3/4/5 jail locks with multiball
 * at ids 2/5/9/14 and wrap 5.
 */
export interface ModeLadder {
  readonly index: number;
  readonly wrap: number;
  readonly entries: readonly ModeLadderEntry[];
}

/**
 * One lamp of a LAMP GROUP, as the set of things that can light it.
 *
 * The machine's lamp object carries two per-player masks — +$00, written by
 * `bset` on a type-0 device's first hit (+0x0055F0) and on a trigger zone's
 * first pass (+0x00543A), and +$05, the always-on mask an element AWARD or.bs
 * (`or.b d7,$5(lamp)` on the element's +$08 lamp) — and a BLINK bit the
 * active-element service re-applies every frame to the +$04 START lamp of an
 * armed element (+0x006312..22). The group scan at +0x0064D0 counts the lamp
 * lit when the player's bit is in `(+$00 | +$05)` AND the blink bit is off, so
 * the joins here are exactly the writers of those three states:
 *
 *   `devices` / `zones`   light the lamp STEADILY (they are the first-hit flag
 *                         bytes themselves; the id is the surface id / the
 *                         zone's index in its level's list)
 *   `awardElements`       set the always-on mask when AWARDed
 *   `startElements`       BLINK the lamp while armed — which BLOCKS the group —
 *                         and their disarm force-off ($6234) also `bclr`s the
 *                         steady bit a device may have set
 */
export interface ModeGroupLamp {
  readonly startElements: readonly number[];
  readonly awardElements: readonly number[];
  readonly devices: readonly { readonly level: PlayfieldLevel; readonly surfaceId: number }[];
  readonly zones: readonly { readonly level: PlayfieldLevel; readonly index: number }[];
}

/**
 * One LAMP GROUP off the descriptor's +$38 table: a chain of lamps and the
 * script the machine queues (through $6C10, at main.seg00 +0x006594) the first
 * time every lamp in the chain is lit for the current player.
 *
 * THIS IS THE STRUCTURE THAT MAKES THE BONUS MULTIPLIER REACHABLE. The three
 * multiplier-arming scripts nothing else refers to are these groups' events:
 * Law 'n Justice group 12 (both RICOCHET standups, ids 32+33) fires script 237
 * = `START 14`; BabeWatch group 19 (the three top rollover lanes, lower zones
 * 7/8/9) fires 255 = `AWARD 0`; Extreme Sports group 19 (the upper-deck lanes,
 * upper zones 7/8/9) fires 183 = `AWARD 91` — and elements 14 / 0 / 91 are the
 * award-effect-6 drivers of the X2..X10 ladders.
 *
 * `flags` is the byte at group record +$04: bit 0 is the runtime FIRED latch
 * (`bset #0,$4(a4)` at +0x00658A — the event fires once), bit 1 SUPPRESSES the
 * fire (`btst #1` at +0x006582), bit 2 keeps the lamps' always-on masks across
 * a ball (the soft reset at +0x003F10 skips its `clr.b $5(a0)` for bit-2
 * groups; the hard reset at +0x003EA8 — new game — never does).
 */
export interface ModeLampGroup {
  readonly index: number;
  readonly flags: number;
  /** The event script, or -1: most groups are lamp-bookkeeping only. */
  readonly script: number;
  readonly lamps: readonly ModeGroupLamp[];
}

/** Group flags bit 1: the completion never fires. */
export const GROUP_FLAG_SUPPRESS_FIRE = 0x02;
/** Group flags bit 2: the lamps' always-on masks survive a ball. */
export const GROUP_FLAG_KEEP_ALWAYS_ON = 0x04;

/**
 * Descriptor HOOK 2's ball-start multiplier restore, decoded from the
 * descriptor's own embedded code (the exporter's `multiplierRestoreOf` has the
 * whole listing). At EVERY ball start (+0x005116, after `$427C` has cleared or
 * held the multiplier) the hook reads the incoming player's multiplier word
 * and, when non-zero, writes multiplier/2 into both per-player words of
 * `counter` and sets the always-on bit on the first multiplier/2 lamps of
 * `group`'s chain — which is what lets a HELD multiplier (award effect 8)
 * resume its ladder mid-run instead of starting over. Extreme Sports' hook is
 * a plain `rts` and ships as null.
 */
export interface ModeMultiplierRestore {
  readonly counter: number;
  readonly group: number;
}

export interface ModeMessage {
  readonly index: number;
  readonly lines: readonly string[];
}

export interface ModeMission {
  /** 1-based id inside its selector table, or 0 for a mode nothing selects. */
  readonly id: number;
  readonly selector: number;
  /** True when a selector table offers this mode to the player. */
  readonly selected: boolean;
  readonly script: number;
  readonly launcher: number;
  readonly lamp: boolean;
  readonly title: string;
}

export interface ModeTrigger {
  readonly level: PlayfieldLevel;
  /** Surface id for a device binding, zone list index for a zone or lock. */
  readonly id: number;
  readonly script: number;
}

/** A lock device, named by the zone that feeds it. */
export interface LockDevice {
  readonly level: PlayfieldLevel;
  /** The lock's index in its level's zone list. */
  readonly index: number;
}

export interface TableModes {
  readonly tableId: TableId;
  readonly displayName: string;
  readonly opcodes: readonly ModeOpcodeInfo[];
  readonly elements: readonly ModeElement[];
  readonly messages: readonly ModeMessage[];
  readonly scripts: readonly ModeScript[];
  readonly missions: readonly ModeMission[];
  /** Indices into `missions` of the modes a selector table offers, in table order. */
  readonly selectable: readonly number[];
  /**
   * THE MODE-ARM ELEMENTS, derived rather than declared.
   *
   * Every mission's prologue runs `COMPLETE` on the same three-to-five elements
   * and its epilogue runs `CLEAR_DONE` on exactly those same ones: a mission
   * takes the arm shot away while it runs and gives it back when it finishes. So
   * an arm element is one that some mission both COMPLETEs and CLEAR_DONEs, and
   * that is computable from the shipped scripts without anybody declaring it.
   *
   * They matter because they are the physical join to mission SELECTION. Law 'n
   * Justice's type-1 mode device fires a script that does nothing but
   * `START <arm element>` — the shot that lights "a mission may now begin". What
   * the engine does with that is not decoded; see the selector reconstruction in
   * `mode-vm.ts`.
   */
  readonly armElements: readonly number[];
  /** The decoded effect-6 count ladders. See `ModeLadder`. */
  readonly ladders: readonly ModeLadder[];
  /** The progress-counter records, in the descriptor's own list order. */
  readonly counters: readonly ModeCounter[];
  /** The lamp groups off descriptor +$38, in table order. See `ModeLampGroup`. */
  readonly lampGroups: readonly ModeLampGroup[];
  /** Hook 2's ball-start multiplier restore, or null. See `ModeMultiplierRestore`. */
  readonly multiplierRestore: ModeMultiplierRestore | null;
  /**
   * DECODED: elements whose AWARD-relight latch survives a ball — the elements
   * whose +$08 award lamp sits in a group whose flags carry bit 2, which is the
   * set the soft reset at +0x003F10 skips its `clr.b $5(a0)` for. This closes
   * the divergence `resetModesForNewBall` used to label: `awardLit` was cleared
   * wholesale because the group table had not been exported yet.
   */
  readonly awardLitSurvivesBall: readonly number[];
  /**
   * DECODED: the counter the end-of-ball bonus pays a combo term for, or -1.
   *
   * Law 'n Justice's is counter 12 and Extreme Sports' counter 13; BABEWATCH HAS
   * NONE, and that is the machine's own doing rather than a hole in the decode —
   * its bonus routine loads the player index at h4+0x2AC4 and immediately throws
   * it away with `moveq #$0,d0`, so its combo block is 208 bytes of unreachable
   * code. The exporter's `comboCounterOf` reads the routine's own
   * `move.w (bd,PC,d0.w*2),d0` to find the record and refuses anything that is
   * not on the counter list.
   */
  readonly comboCounter: number;
  /**
   * DECODED: the elements armed — and their START lamps lit — at game start.
   *
   * THE GAME-START LAMP STATE IS TABLE DATA, NOT THE MODE VM. It is bit 1
   * (mask $02) of the element's flags byte at element +$00, read by the
   * per-GAME reset at `main.seg00 +0x004052` (its one caller is `+0x0045B2`,
   * inside NEW GAME at `+0x004558`). That routine walks the descriptor's
   * element table at descriptor +$3C — `$232A(a5)` after the 76-word copy at
   * `+0x0032EE` — clearing DONE (`clr.b $2(a1)`) and ARMED (`clr.b $1(a1)`)
   * for every player, then `btst.b #$1,(a1)`: clear leaves the element dark,
   * set does `st.b $1(a1)` (armed for every player), writes countdown +$2E =
   * -1, and, when the element carries a START lamp at +$04, lights that lamp
   * for the player with BLINKING set (`ori.b #$2,$2(a2)`), phase on and blink
   * reload 8.
   *
   * That bit means "permanently lit shot" everywhere else too: `LAMP_OFF`
   * (opcode 14, `+0x005A10`) refuses to act on a bit-1 element, `AWARD`
   * (`+0x005CA8`) re-arms on `flags & $0A`, and `COMPLETE` (`+0x005B88`) skips
   * its `bclr` at `+0x005B9C`. Every element's on-disk +$01/+$02/+$03 and
   * every lamp's +$00/+$05 are zero on all three tables, so the reset is the
   * only source of light.
   *
   * This REPLACES a reconstruction that guessed the set from the lock scripts.
   * That guess lit BabeWatch's 23/25/29/30/31, whose real flags are $01 and
   * $09 — bit 1 clear in all five — and handed the player five pre-lit lock
   * lamps whose AWARD paid the element's own score on the first capture; it is
   * the whole of that table's 42,245,000 census outlier. It also left the 43 /
   * 32 / 25 elements that really are armed from the first frame dark, so every
   * AWARD on them (including Law 'n Justice's 5,000,000..50,000,000 mission
   * jackpots) refused and paid nothing.
   *
   * The exporter's element pool is a superset of the descriptor's own table
   * (+4 / +9 / +2 entries) and every pool-only element has flags $00, so
   * filtering the pool gives the identical set.
   */
  readonly litAtGameStart: readonly number[];
  /**
   * DECODED: elements whose ARMED bit survives a ball, flags bit 0 (mask $01).
   *
   * The per-BALL reset at `main.seg00 +0x003F80` (one caller, `+0x0050C2`)
   * runs the same walk as the per-game one with two extra tests: `+0x003FA4`
   * keeps the ARMED bit for a bit-0 element instead of clearing it.
   */
  readonly keepArmedAcrossBall: readonly number[];
  /**
   * DECODED: elements whose DONE bit survives a ball, flags bit 5 (mask $20).
   *
   * The other half of the per-ball reset: `+0x003F9A` keeps the DONE bit for a
   * bit-5 element. A shot completed on ball 1 stays completed on ball 2.
   */
  readonly keepDoneAcrossBall: readonly number[];
  /** The script a device surface id fires on one level, or -1. */
  scriptForDevice(level: PlayfieldLevel, surfaceId: number): number;
  /** The script a trigger zone fires, or -1. */
  scriptForZone(level: PlayfieldLevel, index: number): number;
  /** The script a ball lock fires when it swallows a ball, or -1. */
  scriptForLock(level: PlayfieldLevel, index: number): number;
  /**
   * The lock device behind an element index, or null.
   *
   * The exporter's element pool files the lock DEVICE records as elements — a
   * misclassification the scripts force on it, because `PUSH`, `PUSH_LINKED`
   * and `BALL_REMOVE` name the device record where the other element opcodes
   * name real elements. This is the join back: an element index that is really
   * a lock device answers which lock, so the runtime can eject or remove the
   * ball that device is holding.
   */
  lockDeviceForElement(element: number): LockDevice | null;
  opcodeName(op: number): string;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  return `${typeof value} ${String(value)}`;
}

function isTableId(value: string): value is TableId {
  return (TABLE_IDS as readonly string[]).includes(value);
}

function requireWholeNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number in ${min}..${max}, got ${describeValue(value)}`);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array, got ${describeValue(value)}`);
  return value;
}

const OPERAND_KINDS: readonly string[] = ["e", "s", "m", "o", "n", "w", "c", "i"];

/** The two opcodes that bracket a mission's use of an arm element. */
const OPCODE_COMPLETE = 3;
const OPCODE_CLEAR_DONE = 12;
const OPCODE_MODE_START = 9;

/** Expands one document into a `TableModes`, checking every cross-reference. */
export function parseTableModesDocument(doc: TableModesDocument): TableModes {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`table modes document must be an object, got ${describeValue(doc)}`);
  }
  if (raw["schema"] !== TABLE_MODES_SCHEMA) {
    throw new Error(
      `table modes document has schema ${describeValue(raw["schema"])}, expected "${TABLE_MODES_SCHEMA}"`,
    );
  }
  const tableIdValue = raw["tableId"];
  if (typeof tableIdValue !== "string" || !isTableId(tableIdValue)) {
    throw new Error(`table modes document has unknown tableId ${describeValue(tableIdValue)}`);
  }
  const tableId: TableId = tableIdValue;
  const label = `table modes "${tableId}"`;

  const displayName = raw["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${label} has a non-string or empty displayName`);
  }

  // --- opcodes -------------------------------------------------------------
  const opcodes: ModeOpcodeInfo[] = [];
  for (const [at, entry] of requireArray(raw["opcodes"], `${label} opcodes`).entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} opcode ${at}`;
    const index = requireWholeNumber(item["index"], `${where} index`, 0, 255);
    if (index !== at) throw new Error(`${where} is filed at slot ${at}; the table must be dense`);
    const name = item["name"];
    if (typeof name !== "string" || name.length === 0) throw new Error(`${where} has no name`);
    const args = item["args"];
    if (typeof args !== "string" || [...args].some((kind) => !OPERAND_KINDS.includes(kind))) {
      throw new Error(`${where} has operand kinds ${describeValue(args)}`);
    }
    opcodes.push(
      Object.freeze({
        index,
        name,
        length: requireWholeNumber(item["length"], `${where} length`, 2, 64),
        args: Object.freeze([...args] as ModeOperandKind[]),
      }),
    );
  }
  if (opcodes.length === 0) throw new Error(`${label} carries no opcode table`);

  // --- messages ------------------------------------------------------------
  const messages: ModeMessage[] = [];
  for (const [at, entry] of requireArray(raw["messages"], `${label} messages`).entries()) {
    const item = entry as Record<string, unknown>;
    const lines = requireArray(item["lines"], `${label} message ${at} lines`);
    if (lines.some((line) => typeof line !== "string")) {
      throw new Error(`${label} message ${at} has a non-string line`);
    }
    messages.push(Object.freeze({ index: at, lines: Object.freeze(lines as string[]) }));
  }

  // The script pool's size is needed before the scripts themselves are walked:
  // ladder entries and element counter-continuations both name scripts.
  const rawScripts = requireArray(raw["scripts"], `${label} scripts`);
  const scriptCount = rawScripts.length;

  // --- ladders -------------------------------------------------------------
  const ladders: ModeLadder[] = [];
  for (const [at, entry] of requireArray(raw["ladders"] ?? [], `${label} ladders`).entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} ladder ${at}`;
    const index = requireWholeNumber(item["index"], `${where} index`, at, at);
    const wrap = requireWholeNumber(item["wrap"], `${where} wrap`, 0, 0xffff);
    const entries: ModeLadderEntry[] = [];
    let previousId = 0;
    for (const [entryAt, rawEntry] of requireArray(item["entries"], `${where} entries`).entries()) {
      const record = rawEntry as Record<string, unknown>;
      const id = requireWholeNumber(record["id"], `${where} entry ${entryAt} id`, 1, 0xfffd);
      if (id <= previousId) {
        throw new Error(`${where} entry ${entryAt} has id ${id} after ${previousId}; ids must ascend`);
      }
      previousId = id;
      entries.push(
        Object.freeze({
          id,
          script: requireWholeNumber(record["script"], `${where} entry ${entryAt} script`, 0, scriptCount - 1),
        }),
      );
    }
    if (entries.length === 0) throw new Error(`${where} has no entries`);
    ladders.push(Object.freeze({ index, wrap, entries: Object.freeze(entries) }));
  }

  // --- counters ------------------------------------------------------------
  const counters: ModeCounter[] = [];
  for (const [at, entry] of requireArray(raw["counters"] ?? [], `${label} counters`).entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} counter ${at}`;
    counters.push(
      Object.freeze({
        index: requireWholeNumber(item["index"], `${where} index`, at, at),
        flags: requireWholeNumber(item["flags"], `${where} flags`, 0, 255),
        reset: requireWholeNumber(item["reset"], `${where} reset`, 0, 0xffff),
        cap: requireWholeNumber(item["cap"], `${where} cap`, 0, 0xffff),
        step: requireWholeNumber(item["step"], `${where} step`, 0, Number.MAX_SAFE_INTEGER),
        target: requireWholeNumber(item["target"] ?? -1, `${where} target`, -1, Number.MAX_SAFE_INTEGER),
        continuation: requireWholeNumber(item["continuation"], `${where} continuation`, -1, scriptCount - 1),
        ladder: requireWholeNumber(item["ladder"], `${where} ladder`, -1, ladders.length - 1),
        keepAcrossBall: item["keepAcrossBall"] === true,
      }),
    );
  }

  // --- elements ------------------------------------------------------------
  const rawElements = requireArray(raw["elements"], `${label} elements`);
  const elements: ModeElement[] = [];
  for (const [at, entry] of rawElements.entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} element ${at}`;
    const displayStart = requireWholeNumber(item["displayStart"], `${where} displayStart`, -1, messages.length - 1);
    const displayAward = requireWholeNumber(item["displayAward"], `${where} displayAward`, -1, messages.length - 1);
    elements.push(
      Object.freeze({
        index: requireWholeNumber(item["index"], `${where} index`, at, at),
        flags: requireWholeNumber(item["flags"], `${where} flags`, 0, 255),
        score: requireWholeNumber(item["score"], `${where} score`, 0, Number.MAX_SAFE_INTEGER),
        bonus: requireWholeNumber(item["bonus"], `${where} bonus`, 0, Number.MAX_SAFE_INTEGER),
        effect: requireWholeNumber(item["effect"], `${where} effect`, 0, 0xffff),
        multiplier: requireWholeNumber(item["multiplier"] ?? 0, `${where} multiplier`, 0, 99),
        windowSeconds: requireWholeNumber(item["windowSeconds"] ?? 0, `${where} windowSeconds`, 0, 0xffff),
        countdown: requireWholeNumber(item["countdown"], `${where} countdown`, -0x8000, 0x7fff),
        lampStart: item["lampStart"] === true,
        lampAward: item["lampAward"] === true,
        soundStart: item["soundStart"] === true,
        soundAward: item["soundAward"] === true,
        displayStart,
        displayAward,
        counter: requireWholeNumber(item["counter"] ?? -1, `${where} counter`, -1, counters.length - 1),
        ladder: requireWholeNumber(item["ladder"] ?? -1, `${where} ladder`, -1, ladders.length - 1),
      }),
    );
  }

  // --- scripts -------------------------------------------------------------
  // Two passes: the shapes first, so a MODE_START can be checked against the
  // real script count rather than against however many happen to be parsed yet.
  const parsed = rawScripts.map((entry, at) => {
    const item = entry as Record<string, unknown>;
    const ops = requireArray(item["ops"], `${label} script ${at} ops`);
    let previous = -1;
    return ops.map((opEntry, opAt) => {
      const op = opEntry as Record<string, unknown>;
      const where = `${label} script ${at} op ${opAt}`;
      const pc = requireWholeNumber(op["pc"], `${where} pc`, 0, 0x7fff);
      if (pc <= previous) throw new Error(`${where} has pc ${pc} after ${previous}; pcs must ascend`);
      previous = pc;
      const index = requireWholeNumber(op["op"], `${where} op`, 0, opcodes.length - 1);
      const args = requireArray(op["args"], `${where} args`);
      const kinds = opcodes[index]?.args ?? [];
      if (args.length !== kinds.length) {
        throw new Error(
          `${where} is ${opcodes[index]?.name} and carries ${args.length} operand(s), not ${kinds.length}`,
        );
      }
      return { pc, op: index, args: args as number[], kinds };
    });
  });

  const scripts: ModeScript[] = parsed.map((ops, at) => {
    const boundaries = new Set(ops.map((op) => op.pc));
    const instructions: ModeInstruction[] = ops.map((op, opAt) => {
      const where = `${label} script ${at} op ${opAt} (${opcodes[op.op]?.name})`;
      for (const [argAt, kind] of op.kinds.entries()) {
        const value = op.args[argAt];
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new Error(`${where} operand ${argAt} is ${describeValue(value)}`);
        }
        if (kind === "e" && (value < -1 || value >= elements.length)) {
          throw new Error(`${where} names element ${value}, and there are ${elements.length}`);
        }
        if (kind === "s" && (value < -1 || value >= scriptCount)) {
          throw new Error(`${where} names script ${value}, and there are ${scriptCount}`);
        }
        if (kind === "m" && (value < -1 || value >= messages.length)) {
          throw new Error(`${where} names message ${value}, and there are ${messages.length}`);
        }
        if (kind === "n" && (value < -1 || value >= counters.length)) {
          throw new Error(`${where} names counter ${value}, and there are ${counters.length}`);
        }
        // -1 is a branch the record does not contain: several missions share one
        // timeout label that lives outside their own code. The runtime ends the
        // script there rather than jumping into somebody else's.
        if (kind === "c" && value !== -1 && !boundaries.has(value)) {
          throw new Error(`${where} branches to +0x${value.toString(16)}, which is not an instruction`);
        }
      }
      return Object.freeze({
        pc: op.pc,
        op: op.op,
        args: Object.freeze([...(op.args as number[])]),
      });
    });
    const byPc = new Map(instructions.map((op, i) => [op.pc, i]));
    return Object.freeze({
      index: at,
      ops: Object.freeze(instructions),
      indexOfPc(pc: number): number {
        return byPc.get(pc) ?? -1;
      },
    });
  });

  // The combo counter, checked against the pool it indexes. -1 is legitimate —
  // BabeWatch's combo block is dead code — so only an out-of-range index throws.
  const comboCounter = requireWholeNumber(
    raw["comboCounter"] ?? -1,
    `${label} comboCounter`,
    -1,
    counters.length - 1,
  );

  // --- lamp groups ---------------------------------------------------------
  const lampGroups: ModeLampGroup[] = [];
  for (const [at, entry] of requireArray(raw["lampGroups"] ?? [], `${label} lampGroups`).entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} lamp group ${at}`;
    const lamps: ModeGroupLamp[] = [];
    for (const [lampAt, rawLamp] of requireArray(item["lamps"], `${where} lamps`).entries()) {
      const lamp = rawLamp as Record<string, unknown>;
      const lampWhere = `${where} lamp ${lampAt}`;
      const readElements = (which: string): number[] =>
        requireArray(lamp[which] ?? [], `${lampWhere} ${which}`).map((value, i) =>
          requireWholeNumber(value, `${lampWhere} ${which} ${i}`, 0, elements.length - 1),
        );
      const devices = requireArray(lamp["devices"] ?? [], `${lampWhere} devices`).map((value, i) => {
        const join = value as Record<string, unknown>;
        return Object.freeze({
          level: (requireWholeNumber(join["level"], `${lampWhere} device ${i} level`, 0, 1) === 1
            ? 1
            : 0) as PlayfieldLevel,
          surfaceId: requireWholeNumber(join["surfaceId"], `${lampWhere} device ${i} surfaceId`, 0, 255),
        });
      });
      const zones = requireArray(lamp["zones"] ?? [], `${lampWhere} zones`).map((value, i) => {
        const join = value as Record<string, unknown>;
        return Object.freeze({
          level: (requireWholeNumber(join["level"], `${lampWhere} zone ${i} level`, 0, 1) === 1
            ? 1
            : 0) as PlayfieldLevel,
          index: requireWholeNumber(join["index"], `${lampWhere} zone ${i} index`, 0, 255),
        });
      });
      lamps.push(
        Object.freeze({
          startElements: Object.freeze(readElements("startElements")),
          awardElements: Object.freeze(readElements("awardElements")),
          devices: Object.freeze(devices),
          zones: Object.freeze(zones),
        }),
      );
    }
    lampGroups.push(
      Object.freeze({
        index: requireWholeNumber(item["index"], `${where} index`, at, at),
        flags: requireWholeNumber(item["flags"], `${where} flags`, 0, 255),
        script: requireWholeNumber(item["script"], `${where} script`, -1, scriptCount - 1),
        lamps: Object.freeze(lamps),
      }),
    );
  }

  // Hook 2's restore, checked against the pools it indexes.
  const rawRestore = raw["multiplierRestore"] ?? null;
  let multiplierRestore: ModeMultiplierRestore | null = null;
  if (rawRestore !== null) {
    const item = rawRestore as Record<string, unknown>;
    multiplierRestore = Object.freeze({
      counter: requireWholeNumber(item["counter"], `${label} multiplierRestore counter`, 0, counters.length - 1),
      group: requireWholeNumber(item["group"], `${label} multiplierRestore group`, 0, lampGroups.length - 1),
    });
  }

  // --- missions ------------------------------------------------------------
  const missions: ModeMission[] = [];
  for (const [at, entry] of requireArray(raw["missions"], `${label} missions`).entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} mission ${at}`;
    const title = item["title"];
    missions.push(
      Object.freeze({
        id: requireWholeNumber(item["id"], `${where} id`, 0, 255),
        selector: requireWholeNumber(item["selector"], `${where} selector`, -1, 15),
        selected: item["selected"] === true,
        script: requireWholeNumber(item["script"], `${where} script`, 0, scriptCount - 1),
        launcher: requireWholeNumber(item["launcher"], `${where} launcher`, -1, scriptCount - 1),
        lamp: item["lamp"] === true,
        title: typeof title === "string" ? title : "",
      }),
    );
  }

  // --- triggers ------------------------------------------------------------
  const rawTriggers = raw["triggers"];
  if (rawTriggers === null || typeof rawTriggers !== "object") {
    throw new Error(`${label} has no triggers block`);
  }
  const triggers = rawTriggers as Record<string, unknown>;
  // Lock triggers also carry the DEVICE record's slot in the element pool; see
  // `lockDeviceForElement`. -1 when the exporter could not match the record.
  const lockDeviceByElement = new Map<number, LockDevice>();
  const readTriggers = (kind: "devices" | "zones" | "locks", idKey: string): Map<string, number> => {
    const out = new Map<string, number>();
    for (const [at, entry] of requireArray(triggers[kind], `${label} ${kind} triggers`).entries()) {
      const item = entry as Record<string, unknown>;
      const where = `${label} ${kind} trigger ${at}`;
      const level = requireWholeNumber(item["level"], `${where} level`, 0, 1);
      const id = requireWholeNumber(item[idKey], `${where} ${idKey}`, 0, 255);
      const script = requireWholeNumber(item["script"], `${where} script`, 0, scriptCount - 1);
      const bindKey = `${level}:${id}`;
      if (out.has(bindKey)) throw new Error(`${where} binds ${bindKey} twice`);
      out.set(bindKey, script);
      if (kind === "locks") {
        const element = requireWholeNumber(item["element"] ?? -1, `${where} element`, -1, elements.length - 1);
        if (element >= 0) {
          if (lockDeviceByElement.has(element)) {
            throw new Error(`${where} files element ${element} as a second lock device`);
          }
          lockDeviceByElement.set(element, Object.freeze({ level: (level === 1 ? 1 : 0) as PlayfieldLevel, index: id }));
        }
      }
    }
    return out;
  };
  const deviceTriggers = readTriggers("devices", "surfaceId");
  const zoneTriggers = readTriggers("zones", "index");
  const lockTriggers = readTriggers("locks", "index");

  const opcodeNames = opcodes.map((op) => op.name);

  const selectable = missions.flatMap((mission, at) => (mission.selected ? [at] : []));

  // The MULTIBALL ladders: an effect-6 ladder one of whose launcher scripts
  // asks for balls, directly or through the mode it MODE_STARTs. Their feeder
  // elements are the lock-lit lamps of the decoded multiball rule, and two
  // derivations below treat them specially.
  const OPCODE_BALLS_UP_TO = 27;
  const asksForBalls = (index: number): boolean =>
    (scripts[index]?.ops ?? []).some((op) => op.op === OPCODE_BALLS_UP_TO);
  const launchesMultiball = (index: number): boolean =>
    (scripts[index]?.ops ?? []).some(
      (op) =>
        (op.op === OPCODE_BALLS_UP_TO) ||
        (op.op === OPCODE_MODE_START && (op.args[0] ?? -1) >= 0 && asksForBalls(op.args[0] ?? -1)),
    );
  const multiballLadders = new Set<number>();
  for (const ladder of ladders) {
    if (ladder.entries.some((entry) => launchesMultiball(entry.script))) {
      multiballLadders.add(ladder.index);
    }
  }

  // An arm element is one some mission both COMPLETEs and CLEAR_DONEs. Derived
  // here, once, so the runtime never walks the scripts looking for it.
  //
  // MULTIBALL-LADDER FEEDERS ARE EXCLUDED, and the exclusion is a decode
  // catching up with a reconstruction: the selector reconstruction in
  // mode-vm.ts treats "an arm element was STARTed" as "a mission may begin",
  // which was written before award effect 6 was decoded. Law 'n Justice's
  // jail lamp (element 26) is bracketed by its SHOOT JAIL wizard mode exactly
  // like an arm shot, but its role is now DECODED — it is the multiball lock
  // ladder's gate, lit by the SHOOT JAIL targets — and letting the invented
  // selector hijack its lighting put a mission prologue's COMPLETE on the very
  // lamp the jail capture was about to award, so the decoded ladder could
  // never count. An element whose ladder starts a multiball is the multiball
  // rule's, not the selector's.
  const armElements: number[] = [];
  const completed = new Set<number>();
  const restored = new Set<number>();
  for (const mission of missions) {
    for (const op of scripts[mission.script]?.ops ?? []) {
      const operand = op.args[0] ?? -1;
      if (operand < 0) continue;
      if (op.op === OPCODE_COMPLETE) completed.add(operand);
      if (op.op === OPCODE_CLEAR_DONE) restored.add(operand);
    }
  }
  for (const element of completed) {
    if (!restored.has(element)) continue;
    if (multiballLadders.has(elements[element]?.ladder ?? -1)) continue;
    armElements.push(element);
  }
  armElements.sort((a, b) => a - b);

  // --- the reset sets, DECODED from the element flags byte ------------------
  //
  // Not a derivation any more: three bits of the byte at element +$00, read by
  // the two reset walks over the descriptor's element table at descriptor +$3C.
  // See `litAtGameStart` on the interface for the citations.
  const litAtGameStart = elements
    .filter((element) => (element.flags & ELEMENT_FLAG_LIT_AT_GAME_START) !== 0)
    .map((element) => element.index);
  const keepArmedAcrossBall = elements
    .filter((element) => (element.flags & ELEMENT_FLAG_ARMED_SURVIVES_BALL) !== 0)
    .map((element) => element.index);
  const keepDoneAcrossBall = elements
    .filter((element) => (element.flags & ELEMENT_FLAG_DONE_SURVIVES_BALL) !== 0)
    .map((element) => element.index);

  // The elements whose award-relight latch survives a ball: those whose +$08
  // award lamp chains under a bit-2 group. See `awardLitSurvivesBall` above.
  const awardLitSurvivors = new Set<number>();
  for (const group of lampGroups) {
    if ((group.flags & GROUP_FLAG_KEEP_ALWAYS_ON) === 0) continue;
    for (const lamp of group.lamps) {
      for (const element of lamp.awardElements) awardLitSurvivors.add(element);
    }
  }
  const awardLitSurvivesBall = [...awardLitSurvivors].sort((a, b) => a - b);

  return Object.freeze({
    tableId,
    displayName,
    opcodes: Object.freeze(opcodes),
    elements: Object.freeze(elements),
    messages: Object.freeze(messages),
    scripts: Object.freeze(scripts),
    missions: Object.freeze(missions),
    selectable: Object.freeze(selectable),
    armElements: Object.freeze(armElements),
    ladders: Object.freeze(ladders),
    counters: Object.freeze(counters),
    lampGroups: Object.freeze(lampGroups),
    multiplierRestore,
    awardLitSurvivesBall: Object.freeze(awardLitSurvivesBall),
    comboCounter,
    litAtGameStart: Object.freeze(litAtGameStart),
    keepArmedAcrossBall: Object.freeze(keepArmedAcrossBall),
    keepDoneAcrossBall: Object.freeze(keepDoneAcrossBall),
    scriptForDevice(level: PlayfieldLevel, surfaceId: number): number {
      return deviceTriggers.get(`${level === 1 ? 1 : 0}:${surfaceId}`) ?? -1;
    },
    scriptForZone(level: PlayfieldLevel, index: number): number {
      return zoneTriggers.get(`${level === 1 ? 1 : 0}:${index}`) ?? -1;
    },
    scriptForLock(level: PlayfieldLevel, index: number): number {
      return lockTriggers.get(`${level === 1 ? 1 : 0}:${index}`) ?? -1;
    },
    lockDeviceForElement(element: number): LockDevice | null {
      return lockDeviceByElement.get(element) ?? null;
    },
    opcodeName(op: number): string {
      return opcodeNames[op] ?? `op${op}`;
    },
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<TableId, TableModes>();

/** Makes one table's mission layer available to `createGame`. Idempotent. */
export function registerTableModes(modes: TableModes): void {
  REGISTRY.set(modes.tableId, modes);
}

/** Forgets every registration. For tests that need a clean slate. */
export function clearTableModes(): void {
  REGISTRY.clear();
}

/**
 * One table's mission layer, or null.
 *
 * Nullable for the same reason the scoring layer is: a table without missions
 * rolls exactly the same ball, and every physics test in this project builds a
 * game on a synthetic map that has no missions at all and must go on working.
 */
export function tableModesFor(tableId: TableId): TableModes | null {
  return REGISTRY.get(tableId) ?? null;
}

/** URL of one table's exported mission layer, relative to the site root. */
export function tableModesUrl(tableId: TableId, basePath: string = TABLE_MODES_BASE_PATH): string {
  return `${basePath}${tableId}.modes.json`;
}

/** The slice of `Response` this loader needs, so tests can pass a plain object. */
export interface TableModesResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export type TableModesFetch = (url: string) => Promise<TableModesResponse>;

const defaultFetch: TableModesFetch = (url) => fetch(url);

/** Fetches, parses and REGISTERS one table's mission layer. */
export async function loadTableModes(
  tableId: TableId,
  fetchImpl: TableModesFetch = defaultFetch,
  basePath: string = TABLE_MODES_BASE_PATH,
): Promise<TableModes> {
  const url = tableModesUrl(tableId, basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as TableModesDocument;
  const modes = parseTableModesDocument(doc);
  registerTableModes(modes);
  return modes;
}
