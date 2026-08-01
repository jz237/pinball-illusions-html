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
 * EVERY BONUS FIELD IN THE SHIPPED DATA IS ZERO, AND THAT IS A RESULT
 * ---------------------------------------------------------------------------
 * $6B96 is called all over the engine, but no award record, mode record, zone
 * object or lock object on any of the three tables carries a non-zero bonus.
 * The bonus counter is fed exclusively by the mission-script VM at 0x60xx-0x62xx
 * — which takes its BCD operands out of the script instruction stream rather
 * than from any static table, and which is not decoded. So `bonus` is carried
 * through this module in full and is, as shipped, always zero. It is kept
 * because it is a real field of a real record, not because anything spends it.
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

/** The field as digits with thousands separators, for the head-up display. */
export function formatBcdField(field: Uint8Array): string {
  return readBcdField(field).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

/** Which family an award came from. Enough for a display and for a test. */
export type AwardSource = "device" | "bumper" | "slingshot" | "zone" | "lock";

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
 * One player, because this reconstruction has one. The original's flag bytes are
 * per player and its `bset` picks the bit out of `$dbe(a5)`; here a set is a set
 * of ids and the player bit is implied. When a second player exists, every
 * `Set` below becomes one set per player and nothing else changes.
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
}

export function createScoringState(): ScoringState {
  return {
    score: newBcdField(),
    bonus: newBcdField(),
    timers: new Map<string, number>(),
    flags: new Set<string>(),
    occupants: new Map<string, number>(),
  };
}

/**
 * Clears everything a new ball clears — which is the debounces and nothing else.
 *
 * The flag bytes are NOT cleared: they are per player and per game, which is
 * what makes a repeat award a repeat across the whole game rather than across
 * one ball. The score and bonus are not cleared either; `startGame` builds a
 * fresh state for that.
 */
export function resetScoringForNewBall(state: ScoringState): void {
  state.timers.clear();
  state.occupants.clear();
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
    const key = `device-${id}`;
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
  return `zone-${zone.level}-${zone.index}`;
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
 * Scores the trigger zones one ball is inside, and maintains the occupancy
 * debounce for every zone the ball has left.
 *
 * `ballIds` is every ball still in play, so a ball that drained releases the
 * zone it was sitting in. The rule is the original's `+$00 = occupying ball id`
 * with its "0 means empty": one ball at a time, scored on entry, released on
 * exit.
 */
export function scoreZones(
  state: ScoringState,
  devices: TableDevices,
  balls: readonly { readonly id: number; readonly level: PlayfieldLevel; readonly x: number; readonly y: number }[],
): Award[] {
  const awards: Award[] = [];

  for (const zone of devices.zones) {
    if (!isScoringZone(zone)) continue;
    const key = zoneKey(zone);
    const occupant = state.occupants.get(key);

    // The sitting ball first, and by ID rather than by position in the list: a
    // second ball entering a rectangle the first has not left must not take it
    // over, and it would if the test were merely "is some ball inside", because
    // which ball the scan finds first is an accident of the set's order. A ball
    // that drained is simply not in `balls`, so the rectangle frees itself.
    if (occupant !== undefined) {
      const held = balls.some(
        (ball) => ball.id === occupant && zoneCovers(zone, ball.level, ball.x, ball.y),
      );
      if (held) continue;
      state.occupants.delete(key);
    }

    const entrant = balls.find((ball) => zoneCovers(zone, ball.level, ball.x, ball.y));
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
