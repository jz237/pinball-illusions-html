/**
 * SCORING: what a ball touching something is worth.
 *
 * ---------------------------------------------------------------------------
 * THE SCORE IS PACKED BCD, BECAUSE THE ORIGINAL'S IS
 * ---------------------------------------------------------------------------
 * The player record at `$dc6(a5)` is 22 bytes and keeps two six-byte packed-BCD
 * fields: SCORE at `+$02..$07` and BONUS at `+$0A..$0F`, twelve decimal digits
 * each. Every award in the game goes through one of three primitives, and all
 * three are the same instruction sequence — `ANDI #$EF,CCR` to clear X, then six
 * `ABCD`s walking both operands backwards:
 *
 *     $6B96(a3)   bonus += [a3-6..a3-1] ; score += [a3-14..a3-9]   score AND bonus
 *     $6BCC(a3)   score += [a3-6..a3-1]                            score only
 *     $6BEE(a3)   bonus += [a3-6..a3-1]                            bonus only
 *
 * Which field is which was settled at +0x00463E, where the high-score comparison
 * does `movem.l (player),d0-d1` and compares against the ladder at `$d48(a5)`:
 * the score is therefore the EARLIER of the two fields, not the later one that
 * the primitives' argument order suggests at first reading.
 *
 * This module keeps the same representation for the same reason the high-score
 * table does: the digits displayed are the digits stored, a score can never
 * render as something the machine could not have shown, and the twelve-digit
 * wrap is the original's wrap rather than a JavaScript float's. `high-scores.ts`
 * already owns `encodeBcd`/`decodeBcd` and they are used here rather than
 * reimplemented — the only thing added is the ABCD chain itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT AWARDS EXIST, AND THE THREE DEBOUNCES THAT GATE THEM
 * ---------------------------------------------------------------------------
 * Four award families, all decoded, all shipped in `<table>.devices.json`:
 *
 *   DEVICES      surface ids >= 32. The ball's contact ring reads an id, the id
 *                indexes the level's device array, and the record's award record
 *                carries first-hit score, first-hit bonus and repeat-hit score.
 *   BUMPERS      ids 16..21, index `id - 15` into the bumper list at `$231E`.
 *   SLINGSHOTS   ids 22..31, index `((id - 22) >> 1) + 1` into `$2322`.
 *   ZONES        rectangles tested against the ball centre, from the per-level
 *                lists at `$2302`/`$231A`. This is where most of a table's
 *                scoring actually lives — outlanes, inlanes, ramp runs, loops —
 *                and its lock zones are the multiball locks.
 *
 * Three separate debounces, and they are not interchangeable:
 *
 *   1. THE SIX-FRAME TIMER. A type-0 device record keeps a countdown at `+$02`,
 *      set to 6 on a hit and decremented once a frame at data 0x572C; a hit
 *      while it is running is dropped. Bumper and slingshot records keep the
 *      same timer at their own `+$01`. It is what stops a ball resting against a
 *      drop target from scoring fifty times a second.
 *      Devices with an INDEX of 32 or more skip it outright — `cmpi.w #$20,d0`
 *      at +0x0055CE — i.e. surface ids from 64 up.
 *   2. THE PER-PLAYER FLAG BYTE. `bset` of the player's bit: if the bit was
 *      already set this is a REPEAT hit and takes the repeat award through
 *      $6BCC; otherwise it is the first hit and takes score AND bonus through
 *      $6B96. A record with a NULL flag pointer always takes the first-hit path,
 *      which is why its repeat field is unreachable — see `repeatable`.
 *   3. THE ZONE OCCUPANT. A zone object's `+$00` holds the id of the ball
 *      currently inside it, so a ball that sits in a rectangle scores it once,
 *      not once a tick, and a SECOND ball entering while the first is still
 *      there does not score either.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE BONUS COMES FROM — AN EARLIER NEGATIVE, NOW CLOSED
 * ---------------------------------------------------------------------------
 * This header used to say that every bonus field in the shipped data was zero
 * and that the bonus counter therefore had nothing feeding it. The first half is
 * still true of THESE records: no award record, mode record, zone object or lock
 * object on any of the three tables carries a non-zero bonus, so every award this
 * module produces has `bonus === 0`.
 *
 * The second half was wrong, and the thing that was missing is now here. The
 * bonus is fed by the MISSION LAYER: the PLAYFIELD ELEMENT records the mission
 * bytecode awards carry a six-byte packed-BCD bonus at +$26 beside their score at
 * +$1E, and several are non-zero — Extreme Sports' element 12 pays 7,000, Law 'n
 * Justice carries 23 such elements and five of the corpus pay 5,000,000. See
 * `mode-vm.ts`, which pays them through the same `addToBcdField` chain below.
 *
 * ---------------------------------------------------------------------------
 * AND WHERE IT GOES: THE END-OF-BALL BONUS, AND THE MULTIPLIER BESIDE IT
 * ---------------------------------------------------------------------------
 * The accumulator is cashed at ball end by `$5136`, and the four player-record
 * fields the routine reads live here rather than in the loop because they are
 * the player's, exactly as the score and the bonus are. The record is 22 bytes
 * at `$dc6(a5)` (the array; `$dc2(a5)` is the pointer to the current one and
 * `$dbe(a5)` the index, `mulu.w #$16,d0 / lea $dc6(a5,d0.w),a0` at +0x00509C):
 *
 *     +$02..$07  SCORE            packed BCD
 *     +$0A..$0F  BONUS            packed BCD, the accumulator
 *     +$10       EXTRA BALLS      byte, `tst.b $10(a0)` at +0x00505E
 *     +$11       HOLD BONUS       byte, `st.b $11(a0)` at +0x00609E (effect 2)
 *     +$12..$13  BONUS MULTIPLIER word, `move.w $34(a2),$12(a0)` at +0x0060D4
 *     +$14       HOLD MULTIPLIER  byte, `st.b $14(a0)` at +0x0060AC (effect 8)
 *
 * `multiplyBcdField` is the routine's arithmetic and `clearBonusForNewBall` is
 * its `$427C` counterpart; `bonus.ts` owns the phase those two bracket, and its
 * header is where the whole routine is written out. EXTRA BALLS at +$10 is
 * decoded, is fed by award effect 1 (+0x00606C `addq.b #1,$10(a0)`, and three
 * Law 'n Justice elements use it), and is NOT reconstructed here: it changes how
 * many balls a game has, which is a rule of its own and not this one's.
 */

import type { PlayfieldLevel } from "./contracts.js";
import { decodeBcd, encodeBcd } from "./high-scores.js";
import type { DeviceRecord, HitRecord, TableDevices, ZoneRecord } from "./table-devices.js";
import {
  DEVICE_ID_BASE,
  bumperIndexOf,
  isBumperId,
  isSlingshotId,
  slingshotIndexOf,
} from "./surface-physics.js";

// ---------------------------------------------------------------------------
// Packed BCD
// ---------------------------------------------------------------------------

/** Bytes in the player record's score and bonus fields: six, so twelve digits. */
export const PLAYER_BCD_BYTES = 6;

/** Largest value the field can hold before it wraps, as the original's does. */
export const MAX_PLAYER_SCORE = 999_999_999_999;

/** A fresh zeroed score or bonus field. */
export function newBcdField(bytes: number = PLAYER_BCD_BYTES): Uint8Array {
  return new Uint8Array(bytes);
}

/**
 * The ABCD chain: adds one packed-BCD field into another, least significant
 * byte first, and answers whether it carried out of the top.
 *
 * Written as digit arithmetic rather than as a binary add with a correction so
 * that it is obviously the same thing the 68000 does, and so that a nibble that
 * is not a decimal digit cannot silently produce one. The carry-out is RETURNED
 * rather than thrown: the original has nowhere to put it either — the sixth
 * ABCD's X flag simply falls on the floor — so a twelve-digit score wraps, and
 * a caller that cares can see that it did.
 */
export function addPackedBcd(field: Uint8Array, addend: Uint8Array): boolean {
  let carry = 0;
  for (let i = field.length - 1; i >= 0; i -= 1) {
    const a = field[i] ?? 0;
    const b = addend[i] ?? 0;
    let low = (a & 0x0f) + (b & 0x0f) + carry;
    carry = 0;
    if (low > 9) {
      low -= 10;
      carry = 1;
    }
    let high = (a >> 4) + (b >> 4) + carry;
    carry = 0;
    if (high > 9) {
      high -= 10;
      carry = 1;
    }
    field[i] = ((high << 4) | low) & 0xff;
  }
  return carry === 1;
}

/** Adds a decimal amount to a BCD field, through the same chain. */
export function addToBcdField(field: Uint8Array, amount: number): boolean {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`an award must be a non-negative whole number: ${amount}`);
  }
  if (amount === 0) return false;
  return addPackedBcd(field, encodeBcd(amount, field.length));
}

/** Reads a BCD field back as a decimal number. */
export function readBcdField(field: Uint8Array): number {
  return decodeBcd(field, 0, field.length);
}

/**
 * A BCD field times a whole number, by REPEATED ADDITION, because that is the
 * only multiply the original has.
 *
 * `$5136`'s product loop, verbatim (+0x00514A onward):
 *
 *     00514A  move.w  $12(a0), d0      ; the player's bonus multiplier
 *     00514E  beq     $5152            ; 0 falls through with d0 STILL ZERO
 *     005150  subq.w  #1, d0
 *     005152  clr.l   $2440(a5)        ; the product, zeroed
 *     005156  clr.l   $2444(a5)
 *     00515A  lea     $2448(a5), a1    ; loop top: both pointers re-loaded
 *     00515E  lea     $10(a0), a2      ; the player's BONUS, end pointer
 *     005162  andi.b  #$EF, ccr
 *     005166  abcd    -(a2), -(a1)     ; x6 — product += bonus
 *     005172  dbra    d0, $515a
 *
 * A `dbra` runs its body d0+1 times, so the product is `bonus x max(mult, 1)`:
 * a multiplier of ZERO pays the bonus ONCE, not nothing, and that is not a
 * reading of intent — it is what the missing `moveq #0,d0` on the `beq` path
 * makes the loop do. The shipped multiplier ladders never set 1 (they are
 * 2/4/6/8/10, see `mode-vm.ts` award effect 5), so 0 is the only value below 2
 * a player ever has, and it is the value every ball starts with.
 *
 * The carry out of the top is dropped exactly as `addPackedBcd` drops it: six
 * `ABCD`s and no seventh, so a product past twelve digits wraps.
 */
export function multiplyBcdField(field: Uint8Array, times: number): Uint8Array {
  if (!Number.isInteger(times) || times < 0) {
    throw new RangeError(`a bonus multiplier must be a non-negative whole number: ${times}`);
  }
  const product = newBcdField(field.length);
  for (let i = 0; i <= Math.max(times, 1) - 1; i += 1) addPackedBcd(product, field);
  return product;
}

/** The field as digits with thousands separators, for the head-up display. */
export function formatBcdField(field: Uint8Array): string {
  return readBcdField(field).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

/** Which family an award came from. Enough for a display and for a test. */
export type AwardSource = "device" | "bumper" | "slingshot" | "zone" | "lock" | "mode";

/** One thing that scored. */
export interface Award {
  readonly source: AwardSource;
  /** Stable name of what was hit, e.g. `device-32`, `bumper-1`, `zone-0-8`. */
  readonly id: string;
  /** Added to the score field. */
  readonly score: number;
  /** Added to the bonus field. Zero everywhere in the shipped data; see header. */
  readonly bonus: number;
  /** True when this was the repeat-hit award rather than the first-hit one. */
  readonly repeat: boolean;
}

/**
 * What physically produced an award, as numbers rather than as a display id.
 *
 * The mission layer binds its scripts to device surface ids and to zone list
 * indices (see `table-modes.ts`), so something has to turn "this award happened"
 * back into "this device fired". Parsing the id string is done HERE, in the same
 * module that builds it, because that is the only place where the two can never
 * drift apart.
 *
 * `level` is -1 for a device: the surface id alone identifies the record, the
 * engine indexes the level's own array with it, and the caller can ask both.
 */
export interface AwardTrigger {
  readonly kind: "device" | "zone" | "lock";
  readonly level: number;
  readonly id: number;
}

/** The trigger behind an award, or null for the families nothing binds to. */
export function awardTrigger(award: Award): AwardTrigger | null {
  if (award.source === "device") {
    const id = Number.parseInt(award.id.slice("device-".length), 10);
    return Number.isInteger(id) ? { kind: "device", level: -1, id } : null;
  }
  if (award.source !== "zone" && award.source !== "lock") return null;
  const parts = award.id.split("-");
  const level = Number.parseInt(parts[1] ?? "", 10);
  const index = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isInteger(level) || !Number.isInteger(index)) return null;
  return { kind: award.source, level, id: index };
}

/** Frames a hit timer runs for, from `move.b #$6,$2(a1)` at +0x0055E8. */
export const HIT_TIMER_FRAMES = 6;

/**
 * Device index at or above which the six-frame debounce is skipped entirely
 * (`cmpi.w #$20,d0` at +0x0055CE). Index is `surfaceId - 32`, so this is surface
 * id 64 and up.
 */
export const UNDEBOUNCED_DEVICE_INDEX = 32;

/**
 * The mutable half of the scoring layer: the score, the bonus, and the three
 * debounces.
 *
 * ONE PLAYER'S VIEW, and since the multiplayer round that is exactly what it
 * is: the original's flag bytes are per player and its `bset` picks the bit
 * out of `$dbe(a5)`; here a set is a set of ids and the player bit is implied
 * — because the game layer keeps one of these per player (`PlayerBank`,
 * game-loop.ts) and swaps the active one at the rotation, which is the same
 * machine with the indexing turned inside out. See
 * research/MULTIPLAYER_DECODE.md §1.
 */
export interface ScoringState {
  readonly score: Uint8Array;
  readonly bonus: Uint8Array;
  /** Hit-timer countdowns, keyed as `<family>:<id>`. Absent means "not running". */
  readonly timers: Map<string, number>;
  /** The per-player flag bytes, as the set of ids whose bit is set. */
  readonly flags: Set<string>;
  /** Zone key to the id of the ball currently inside it. */
  readonly occupants: Map<string, number>;
  /** The player record's `+$12` word: what the end-of-ball bonus is multiplied by. */
  multiplier: number;
  /** `+$11`: this ball's bonus survives into the next one. Award effect 2. */
  holdBonus: boolean;
  /** `+$14`: this ball's multiplier survives into the next one. Award effect 8. */
  holdMultiplier: boolean;
}

export function createScoringState(): ScoringState {
  return {
    score: newBcdField(),
    bonus: newBcdField(),
    timers: new Map<string, number>(),
    flags: new Set<string>(),
    occupants: new Map<string, number>(),
    multiplier: 0,
    holdBonus: false,
    holdMultiplier: false,
  };
}

/**
 * THE FLAG NAMESPACE. One id per flag byte, and the same string is the key of
 * the record's own six-frame debounce, because on the machine they are two
 * fields of one record.
 *
 * A device is keyed by SURFACE ID alone: the shipped data files each surface id
 * under exactly one level, so the level adds nothing to the key. A zone is
 * keyed by level and list index, because the two levels have independent zone
 * lists and both start at 0.
 */
export function deviceFlagId(surfaceId: number): string {
  return `device-${surfaceId}`;
}

/** Stable key for one zone, unique across both levels. */
export function zoneFlagId(level: PlayfieldLevel | number, index: number): string {
  return `zone-${level}-${index}`;
}

/**
 * Clears everything a new ball clears: the debounces, and the flag bytes that
 * live inside a LAMP GROUP.
 *
 * THE MACHINE DOES BOTH IN ONE INSTRUCTION. The first/repeat split is the lamp
 * byte itself — a type-0 device's `bset.b d0,(a2)` at +0x0055F0 takes A2 from
 * the device's +$04 and a trigger zone's at +0x00543A takes it from the zone
 * object's +$0A, with d0 = the player index out of `$dbe(a5)`, so the bit's
 * value BEFORE the set is what picks repeat (award+$1A / zone +$26, through
 * $6BCC) from first (award+$12 / zone +$1E, through $6B96). And the ball-start
 * soft reset $3F10 walks the lamp-group table at `$2326` and does a whole-byte
 * `clr.b (a0)` at +0x003F56 on every chained lamp — all eight players at once,
 * the very byte the bset tests. $3F10 has exactly one caller, +0x0050B6, and
 * the extra-ball arm of the ball-start chain (+0x005068 sets state 7 and
 * branches to +0x0050B0) lands two instructions above it, so an extra ball
 * re-arms as surely as a fresh one.
 *
 * So a flag byte that is a group-chained lamp is per BALL, and this port's
 * `flags` set now says so: `rearm` is the ids whose flag byte is such a lamp
 * (`groupBackedFlagIds`, mode-vm.ts, off the same join `lightGroupLampsForTrigger`
 * lights). On the three shipped tables that set is exactly Law 'n Justice's
 * standups 32/33 (50,000) and 34..36 (75,000), BabeWatch's targets 32..40
 * (25,000) and top lanes `zone-0-7/8/9` (50,000 first, 5,000 repeat), and
 * Extreme Sports' 33..35 and upper lanes `zone-1-7/8/9` (50,000 first, 0
 * repeat) — and, measured over all three documents, it is exactly the set of
 * records that HAVE a flag byte at all. No shipped record with a non-NULL flag
 * pointer sits outside a group, and no group-bound record has a flag-bit-1
 * start element that could pre-set a bit at ball start, so on this data the
 * rule needs no exceptions. A flag byte outside every group would still be per
 * game — $3F10 never reaches it — which is why this takes a SET rather than
 * clearing the lot.
 *
 * The machine clears every player's bit at every ball start; this port keeps a
 * `ScoringState` per player and clears the incoming player's at their own ball
 * start. Same observable machine: a player's flags are read only during that
 * player's ball, and they are clear at the top of every one of them.
 *
 * The one thing the port splits that the machine fuses is WHEN. `clr.b (a0)`
 * serves the lamp layer and the scoring layer at once; here the lamp half is
 * `resetModesForNewBall` (run on the drain and on the rotation) and this is the
 * scoring half (run on the serve). Nothing can score in between — the table is
 * empty — so the two sites bracket the same dead interval.
 *
 * The score and bonus are not cleared; `startGame` builds a fresh state for
 * that. Full decode: research/MULTIPLAYER_DECODE.md §7.
 */
export function resetScoringForNewBall(state: ScoringState, rearm: ReadonlySet<string>): void {
  state.timers.clear();
  state.occupants.clear();
  for (const id of rearm) state.flags.delete(id);
}

/**
 * Empties the bonus accumulator and the multiplier for the next ball — unless
 * this ball earned the right to keep them.
 *
 * `$427C`, whole, called from the ball-end chain at +0x0050D4 AFTER the bonus
 * has been paid and after the player rotation, so it clears the record of
 * whoever is about to shoot:
 *
 *     00427C  movea.l $dc2(a5), a0
 *     004280  tst.b   $11(a0)          ; HOLD BONUS?
 *     004284  bne     $428e
 *     004286  clr.l   $8(a0)           ; +$08..$0B
 *     00428A  clr.l   $c(a0)           ; +$0C..$0F  — together the whole BONUS
 *     00428E  clr.b   $11(a0)          ; the hold is spent either way
 *     004292  tst.b   $14(a0)          ; HOLD MULTIPLIER?
 *     004296  bne     $429c
 *     004298  clr.w   $12(a0)
 *     00429C  clr.b   $14(a0)
 *
 * Both holds are ONE-BALL grants: the `clr.b` past each test runs on both arms,
 * so a held bonus is held across exactly one ball end and then cleared like any
 * other. The two `clr.l`s straddle +$08 and +$09, which are the two pad bytes
 * ahead of the six-byte field — the field itself is +$0A..+$0F.
 */
export function clearBonusForNewBall(state: ScoringState): void {
  if (!state.holdBonus) state.bonus.fill(0);
  state.holdBonus = false;
  if (!state.holdMultiplier) state.multiplier = 0;
  state.holdMultiplier = false;
}

/**
 * Runs the hit timers down one frame.
 *
 * The original's is a walk over the whole device array at data 0x572C, once a
 * frame, stopping at the first NULL entry. Only the running timers are stored
 * here, so the walk is over those.
 */
export function tickScoring(state: ScoringState): void {
  for (const [key, frames] of state.timers) {
    if (frames <= 1) state.timers.delete(key);
    else state.timers.set(key, frames - 1);
  }
}

/** Applies an award to the score and bonus fields. */
export function applyAward(state: ScoringState, award: Award): void {
  addToBcdField(state.score, award.score);
  addToBcdField(state.bonus, award.bonus);
}

/**
 * Takes the first-hit or repeat-hit award for something with a flag byte.
 *
 * `bset` semantics exactly: the bit's value BEFORE the set decides. A record
 * without a flag byte (`repeatable` false) has no bit to test and always takes
 * the first-hit path, which is why the repeat fields of such records are
 * unreachable data — BabeWatch device 41's 2,380 is the only non-round number in
 * the whole corpus and it lives in exactly such a record.
 */
function awardFor(
  state: ScoringState,
  source: AwardSource,
  id: string,
  record: { readonly score: number; readonly bonus: number; readonly repeatScore: number; readonly repeatable: boolean },
): Award {
  if (!record.repeatable) {
    return { source, id, score: record.score, bonus: record.bonus, repeat: false };
  }
  const alreadySet = state.flags.has(id);
  state.flags.add(id);
  return alreadySet
    ? { source, id, score: record.repeatScore, bonus: 0, repeat: true }
    : { source, id, score: record.score, bonus: record.bonus, repeat: false };
}

/** True when the timer for `key` is running; starts it when it is not. */
function debounced(state: ScoringState, key: string, frames: number = HIT_TIMER_FRAMES): boolean {
  if (state.timers.has(key)) return true;
  if (frames > 0) state.timers.set(key, frames);
  return false;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * Scores every surface id one ball touched this tick.
 *
 * The ids arrive from `stepBalls`, which reports every solid pixel the contact
 * ring saw anywhere in the tick rather than only the one that turned the ball
 * around — a ball that clips a drop target and a wall in the same tick has hit
 * the target either way. Ids are visited in the order they were first touched,
 * so the awards of one tick are ordered and reproducible.
 *
 * Ids below 16 score nothing: 0 is bare geometry, 1..4 are the flipper bats,
 * 10 and 11 are the level changes and the rest are plain materials. Devices are
 * looked up on the LEVEL THE BALL IS RIDING, exactly as the engine indexes
 * `$60(a4)`, so a record filed under the other level never fires — which is what
 * makes BabeWatch's id 41 the dead entry it is in the original too.
 */
export function scoreSurfaces(
  state: ScoringState,
  devices: TableDevices,
  level: PlayfieldLevel,
  surfaceIds: readonly number[],
): Award[] {
  const awards: Award[] = [];
  for (const id of surfaceIds) {
    if (isBumperId(id)) {
      const record = devices.bumperFor(bumperIndexOf(id));
      if (record !== null) pushHit(state, awards, "bumper", record, id);
      continue;
    }
    if (isSlingshotId(id)) {
      const record = devices.slingshotFor(slingshotIndexOf(id));
      if (record !== null) pushHit(state, awards, "slingshot", record, id);
      continue;
    }
    if (id < DEVICE_ID_BASE) continue;

    const device = devices.deviceFor(level, id);
    if (device === null) continue;
    const key = deviceFlagId(id);
    // The engine's own exemption: index 32 and up skips the debounce.
    if (device.index < UNDEBOUNCED_DEVICE_INDEX && debounced(state, key)) continue;
    awards.push(awardFor(state, "device", key, device));
  }
  return awards;
}

/**
 * A bumper or slingshot hit, which has a timer but no first/repeat split: its
 * record carries one BCD field and the handler adds it every time the timer
 * lets a hit through.
 *
 * Keyed by SURFACE ID rather than by list index so the two faces of one
 * slingshot debounce independently, which is what they are: two ids, two
 * records' worth of timer in the original, one score.
 */
function pushHit(
  state: ScoringState,
  awards: Award[],
  source: "bumper" | "slingshot",
  record: HitRecord,
  surfaceId: number,
): void {
  const key = `${source}-${surfaceId}`;
  if (debounced(state, key)) return;
  awards.push({ source, id: key, score: record.score, bonus: 0, repeat: false });
}

/** The device a surface id would fire on one level, for tests and tooling. */
export function deviceAt(
  devices: TableDevices,
  level: PlayfieldLevel,
  surfaceId: number,
): DeviceRecord | null {
  return surfaceId < DEVICE_ID_BASE ? null : devices.deviceFor(level, surfaceId);
}

/** True when this id is a bumper face or a slingshot face: a POWERED surface. */
export function isPoweredSurfaceId(id: number): boolean {
  return isBumperId(id) || isSlingshotId(id);
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** Stable key for one zone, unique across both levels. */
export function zoneKey(zone: ZoneRecord): string {
  return zoneFlagId(zone.level, zone.index);
}

/** True when a ball centre in whole pixels is inside a zone's rectangle. */
export function zoneCovers(zone: ZoneRecord, level: PlayfieldLevel, x: number, y: number): boolean {
  return zone.level === level && x >= zone.minX && x <= zone.maxX && y >= zone.minY && y <= zone.maxY;
}

/**
 * Zones that award score when a ball enters them: the two trigger types.
 *
 * The level-change types are geometry rather than scoring and carry no award in
 * any shipped table; the lock type is scored by `scoreLock` on the tick the
 * saucer actually swallows the ball, because a lock that is already occupied
 * does not score and only the lock bank knows that.
 */
function isScoringZone(zone: ZoneRecord): boolean {
  return zone.kind === "trigger-a" || zone.kind === "trigger-b";
}

/**
 * The FIRST zone in shipped list order whose rectangle holds this ball centre —
 * the only zone the original will DISPATCH for that ball this frame.
 *
 * The walk at main.seg00 body +0x52E6 runs the level's zone list from the top,
 * tests the ball's centre (the word pair at `ball+$12/$14`, plus the 8 that
 * turns the sprite's top-left into its centre) against each rectangle, and on
 * the first hit jumps through the type table at +0x53A8. The rest of the list is
 * still visited but only to RELEASE the occupancy of rectangles the ball has
 * left. Overlapping rectangles are therefore not all triggered: the one earlier
 * in the shipped list wins and shadows the others for as long as the ball is
 * inside it.
 *
 * Every kind is searched, not only the scoring ones, because the original's list
 * is one list — a level-change or lock rectangle earlier in the order shadows a
 * trigger later in it.
 *
 * ROUND 5 CITED A CASE FOR THAT THAT DOES NOT EXIST, and round 6 removed it
 * rather than replacing it with another. The claim was "BabeWatch's 250,000 zone
 * 0-13 sitting directly above the to-upper box 0-4"; on the shipped data BW L0#13
 * is a 10,000 trigger at (269,450)-(279,465) and L0#4 a to-upper at
 * (288,379)-(298,389), which neither overlap nor stack. Scanned exhaustively,
 * the shipped tables contain THREE same-level overlapping rectangle pairs in
 * total, all on Extreme Sports and all of them harmless: L0 #2 (to-upper) over
 * #3 (a trigger scoring 0), L0 #5 (to-upper) over #14 (a trigger scoring 0), and
 * L1 #4 over #5, both to-lower. So the rule is a NO-OP on the data that ships,
 * and it is here because it is what the walk does, not because anything on these
 * three tables needs it.
 */
export function firstZoneUnder(
  devices: TableDevices,
  level: PlayfieldLevel,
  x: number,
  y: number,
): ZoneRecord | undefined {
  for (const zone of devices.zones) {
    if (zoneCovers(zone, level, x, y)) return zone;
  }
  return undefined;
}

/**
 * Scores the trigger zones one ball is inside, and maintains the occupancy
 * debounce for every zone the ball has left.
 *
 * `balls` is every ball still in play, so a ball that drained releases the
 * zone it was sitting in. The rule is the original's `+$00 = occupying ball id`
 * with its "0 means empty": one ball at a time, scored on entry, released on
 * exit — and, since round 5, ONE ZONE PER BALL PER FRAME, the first in shipped
 * list order. See `firstZoneUnder` for the walk that says so.
 */
export function scoreZones(
  state: ScoringState,
  devices: TableDevices,
  balls: readonly { readonly id: number; readonly level: PlayfieldLevel; readonly x: number; readonly y: number }[],
): Award[] {
  const awards: Award[] = [];

  // Which single zone each ball dispatches this frame, resolved before any of
  // them is scored so that the answer cannot depend on the order the zones are
  // walked in below.
  const dispatched = new Map<number, ZoneRecord | undefined>();
  for (const ball of balls) {
    dispatched.set(ball.id, firstZoneUnder(devices, ball.level, ball.x, ball.y));
  }

  for (const zone of devices.zones) {
    if (!isScoringZone(zone)) continue;
    const key = zoneKey(zone);
    const occupant = state.occupants.get(key);

    // The sitting ball first, and by ID rather than by position in the list: a
    // second ball entering a rectangle the first has not left must not take it
    // over, and it would if the test were merely "is some ball inside", because
    // which ball the scan finds first is an accident of the set's order. A ball
    // that drained is simply not in `balls`, so the rectangle frees itself.
    //
    // Occupancy is held and released on GEOMETRY ALONE, so a ball that moves
    // from a shadowed zone into the shadowing one does not re-arm the shadowed
    // zone underneath it.
    //
    // THAT IS NOT QUITE WHAT THE ORIGINAL DOES, and round 5's comment claimed it
    // was. On a MISS (+0x00538E) the original releases conditionally and keeps
    // testing; but after a DISPATCH (+0x005342..+0x005378) it walks the whole
    // remainder of the list releasing occupancy UNCONDITIONALLY, with no
    // rectangle test at all. So a ball inside both A (earlier) and B (later) has
    // B released while it is still inside B, and B re-scores when it leaves A.
    // This port holds B. The difference is unreachable on the shipped data —
    // the only same-level overlaps anywhere are Extreme Sports' three, and every
    // shadowed member of them scores 0 — so it is recorded rather than
    // reproduced, and `firstZoneUnder` above says why the overlaps are so rare.
    if (occupant !== undefined) {
      const held = balls.some(
        (ball) => ball.id === occupant && zoneCovers(zone, ball.level, ball.x, ball.y),
      );
      if (held) continue;
      state.occupants.delete(key);
    }

    const entrant = balls.find((ball) => dispatched.get(ball.id) === zone);
    if (entrant === undefined) continue;

    state.occupants.set(key, entrant.id);
    awards.push(awardFor(state, "zone", key, zone));
  }
  return awards;
}

/**
 * The award for the lock that just swallowed a ball at this position, or null.
 *
 * Matched by rectangle rather than by name because both the lock bank and the
 * zone list come from the same shipped records and their rectangles are
 * identical; matching on geometry means a mismatch is a loud null rather than a
 * quiet wrong number. A lock has no flag byte in any shipped table, so it always
 * takes the first-hit path.
 */
export function scoreLock(
  state: ScoringState,
  devices: TableDevices,
  level: PlayfieldLevel,
  x: number,
  y: number,
): Award | null {
  for (const zone of devices.zones) {
    if (zone.kind !== "lock") continue;
    if (!zoneCovers(zone, level, x, y)) continue;
    return awardFor(state, "lock", zoneKey(zone), zone);
  }
  return null;
}
