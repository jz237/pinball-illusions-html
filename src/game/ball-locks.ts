/**
 * BALL LOCKS AND MULTIBALL.
 *
 * Pinball Illusions is the first game in the series with multiball and the
 * reason this engine is N-ball from the core outward. Everything else was
 * already here — the simulation carries an arbitrary population, ball-to-ball
 * works, each ball drains on its own, and the camera reframes to the whole table
 * when more than one is live. What did not exist was any way to take a ball OFF
 * the table and put it back, so nothing ever entered multiball. This module is
 * that: capture, hold, release, and the top-up that makes several balls live at
 * once.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED AND WHAT IS RECONSTRUCTED
 * ---------------------------------------------------------------------------
 * Read this before trusting any number below. The split is exact:
 *
 *   MEASURED, from the shipped table modules and the shared engine
 *     - the lock RECTANGLES, per table and per playfield level (§ "the devices")
 *     - that a lock is a "zone type 4" and what its handler does: hold one ball,
 *       flag it, award score and bonus, run the device's own script
 *     - that a held ball is frozen and invisible to the physics
 *     - that the two scripted releases are DIFFERENT DOORS. `BALL_REMOVE`
 *       (opcode $68, +0x005B4E) puts the ball back in the SERVE QUEUE;
 *       `PUSH` (+0x005BFC) queues the saucer's own record for the popper at
 *       +0x006F72, which spits the ball back onto the playfield at the record's
 *       authored position and impulse after 50 or 76 frames. Both are decoded
 *       end to end and the eject words now ship — see `ZoneEject`.
 *     - that the multiball opcode is a TOP-UP to a requested ball count, and
 *       that it refuses any count above THREE
 *     - HOW LOCKS START MULTIBALL — decoded end to end, and it is script data
 *       driven by one shared-engine primitive, not an engine rule. The capture
 *       handler runs the lock's own script (device+$14, `jsr $6c10` at 0x557A);
 *       on the tables with a lock multiball that script AWARDs a lock-lit lamp
 *       element whose award effect 6 (handler 0x5E5A) bumps a per-game counter
 *       and runs the launcher whose ascending id in the table inline at the
 *       counter record's +$50 equals the count (0x5EAA; 0xFFFE wraps, 0x5F26).
 *       The Nth qualifying capture of a game therefore runs the Nth launcher:
 *       BabeWatch's ladder is tiers of 1/2/3/4 locks whose tier-completing
 *       ids MODE_START the four multiball modes (BALLS_UP_TO 2/3/2/3 — the
 *       FIRST lock of a fresh game starts a two-ball multiball) and whose
 *       intermediate ids print "n MORE TO START MODE"; Law 'n Justice's is
 *       tiers of 2/3/4/5 jail locks with multiball at ids 2/5/9/14 and every
 *       later multiball costing 5 locks. Only the scripted saucers feed it —
 *       BabeWatch's three level-0 grid saucers and Law 'n Justice's jail; the
 *       other rectangles award and eject without counting. The whole mechanism
 *       lives in `mode-vm.ts` (effect 6, SET_COUNT, the AWARD relight) on the
 *       tables exported by `scripts/export-table-modes.mjs`; this module keeps
 *       the devices. The engine's own lock counters at device+$03 and
 *       `$23E4(a5)` are ornaments — written, never read — exactly as the
 *       earlier decode concluded; the live counter is in the table package.
 *
 *   DECODED IN ROUND 7, and it retires a reconstruction
 *     - WHICH LAMPS ARE LIT AT GAME START. The gate was already measured (AWARD
 *       refuses an unlit lamp); the lighting site is now found and it is not a
 *       script at all. The per-game reset at `main.seg00 +0x004052` walks the
 *       descriptor's element table at +$3C and arms every element whose flags
 *       bit 1 is set. BabeWatch's lock lamps are NOT among them — their flags
 *       are $09, bit 1 clear — so a fresh game's first grid capture counts
 *       nothing, exactly as Law 'n Justice's first jail capture does not. See
 *       `litAtGameStart` in table-modes.ts.
 *
 *   RETIRED IN ROUND 6, and this is the headstone
 *     - "capturing the last ball in play serves a replacement" and "an ejected
 *       lock ball returns through the trough". Both were round-4/5 stand-ins
 *       for the eject words at lock_object+$06..$0D and +$30, which are now
 *       exported and applied. The capture handler at +0x00552A never decrements
 *       the live-ball count `$D7E(a5)`, so the machine owes nothing for a held
 *       ball; and the popper never touches the trough. Together the two
 *       stand-ins made a saucer a state reset — the ball came back on the rod
 *       at a fixed position with a fixed kick — which on Extreme Sports closed
 *       an exact 742-tick limit cycle through the bowl saucer, 26 locks and
 *       9,325,000 points inside 20,000 ticks with ball 1 never ending.
 *
 * ---------------------------------------------------------------------------
 * THE ENGINE'S CAPTURE PATH, WHICH THIS IMPLEMENTS
 * ---------------------------------------------------------------------------
 * Zones are 14-byte records `{u16 x0,y0,x1,y1; u16 type; u32 object}` in a
 * NULL-terminated per-level list hanging off the ball record at `$64(a4)`,
 * walked once per live ball per frame from main.seg00 data 0x52E6. The ball's
 * CENTRE is tested against the rectangle — the engine stores the top-left of the
 * 17 px ball and adds 8 first, and `BallState.x/y` here is already the centre,
 * so the test is the same test. Type 4 dispatches to data 0x552A:
 *
 *     00552A  btst.b #$7,$1(a4)      ; already held -> ignore
 *     005532  movea.l $a(a0),a1      ; the device record
 *     005536  move.b $1(a1),d0       ; device->heldBallId
 *     00553A  bne  ...               ; occupied -> ignore
 *     005558  move.b $a(a4),$1(a1)   ; device->heldBallId = this ball
 *     00555E  ori.b  #$80,$1(a4)     ; ball flagged HELD
 *     005568  jsr  $6b96             ; award score + bonus
 *     005582  jsr  $6c10             ; enqueue the device's own script
 *
 * Note what is NOT there: the position is never touched. A captured ball freezes
 * exactly where it entered the rectangle, so this module does not move it
 * either. And release, opcode $68 at data 0x5B4E, does not kick it out of the
 * saucer — it clears the flag, decrements the live count, re-initialises the
 * ball object and increments the serve queue at `$D86(a5)`. Locked balls come
 * back out of the PLUNGER LANE, one at a time, which is why every release in
 * this module queues serves instead of teleporting anything.
 *
 * ---------------------------------------------------------------------------
 * THE AWARDS ARE DECODED BUT NOT WIRED, ON PURPOSE
 * ---------------------------------------------------------------------------
 * Each lock's score is an inline packed-BCD field at `+$1E..$23` of its device
 * record — that is why the long hunt for a per-table award TABLE found nothing;
 * there is no table, the values live in the devices. Recovered:
 *
 *     Law 'n Justice   250000 / 500000 / 100000   (locks A, B, C below)
 *     BabeWatch        500000 each
 *     Extreme Sports   250000 each
 *
 * They are recorded here in prose rather than as a field because this
 * reconstruction has no scoring layer to spend them in yet, and a field nothing
 * reads is a knob that quietly rots. When the scoring layer lands, these numbers
 * come with it.
 */

import type { BallState, PlayfieldLevel, TableId } from "./contracts.js";
import { TABLE_IDS } from "./contracts.js";
import { q10ToPixel } from "../core/fixed-point.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Balls the machine can have on the playfield at once: THREE.
 *
 * Not folklore and not an option — two independent proofs in the original.
 *
 *   1. The ball array is built at main.seg00 data 0x3536 as exactly three
 *      objects of 110 bytes: `lea $faa(a5),a4 / move.w #$2,d7` and a `dbra`,
 *      with `adda.w #$6e,a4` per iteration. `$FAA + 3*0x6E = $10F4` and the next
 *      live global is at `$10F6`, so there is no room for a fourth. The two
 *      pointer lists beside it, `$F92(a5)` (serve order) and `$F9E(a5)` (id
 *      order), are three longs each.
 *   2. The multiball opcode itself refuses more. Opcode `$6C`, handler data
 *      0x5BCC, starts `move.w $2(a1),d1 / cmpi.w #$3,d1 / bhi` — a request for
 *      four or more falls straight through to the exit.
 *
 * The published "six balls" is wrong, and so is the reading of `table00N.opt`
 * record 7 (max 2, default 2) as a multiball cap: that word is read in exactly
 * two places in the whole engine, data 0x3514 and data 0x5A26, and both are
 * equality tests against a small constant that pick between the setup routines
 * at data 0x3BDC and 0x3C1E. Nothing anywhere compares the live-ball count
 * `$D7E(a5)`, the queue `$D86(a5)` or `$D80(a5)` against it. The cap is the
 * literal 3 at data 0x5BD0.
 *
 * So an "Iron Man four-ball mode" on Extreme Sports, whatever it was, cannot
 * have been four balls on the playfield in this engine.
 *
 * AND NOTHING EVER ASKED. The content side is settled too, by census of the
 * shipped scripts: across all 970 exported mode scripts (LnJ 304, BW 342,
 * ES 324) every BALLS_UP_TO operand is 2 or 3 — LnJ {2:1, 3:3}, BW {2:3, 3:3},
 * ES {3:3}, Iron Man included — and a raw byte scan of the seg_clean script
 * segments (pattern 00 1B 00 xx) matches the export exactly, with zero
 * occurrences of operand 4. Four live balls were never possible AND never
 * requested. See docs/GAMEPLAY_PARITY.md, "Defining feature: multiball".
 */
export const MAX_SIMULTANEOUS_BALLS = 3;

/**
 * THE TWO-SAUCERS RULE IS GONE, AND THIS COMMENT IS ITS HEADSTONE.
 *
 * This file used to export `LOCKS_TO_LIGHT_MULTIBALL = 2` ("two saucers held
 * lights a three-ball multiball") and `MULTIBALL_BALL_COUNT = 3`, both
 * labelled reconstructions, because the shared engine keeps two lock counters
 * and reads neither and the per-table script streams had not been located. The
 * dispatch is now DECODED — award effect 6's per-game counter walking the
 * launcher table at counter+$50, see the header — and it replaces both
 * constants outright: how many locks, which locks, how many balls, and what
 * the display says at every step are all shipped script data run by
 * `mode-vm.ts`. The old rule was TIGHTER than BabeWatch's real one (whose
 * first lock already starts a two-ball multiball) and LOOSER than Law 'n
 * Justice's (which needs two counted JAIL locks, with the jail lamp lit by the
 * SHOOT JAIL targets first, and never counts the other two saucers at all).
 *
 * A game built without a mission layer — every synthetic-map physics test —
 * therefore has NO multiball at all now, which is honest: the engine alone
 * never had one.
 */

/** Says out loud which parts of the lock behaviour are invented. For the UI and for tests. */
export const BALL_LOCK_RULES_NOTE =
  "Lock rectangles, capture, freeze, BALL_REMOVE's return to the serve queue, " +
  "PUSH's in-place eject at the record's own authored position, impulse and " +
  "50-or-76-frame hold, the three-ball ceiling and the multiball lock ladder " +
  "(award effect 6: the Nth counted lock runs the Nth launcher script) are all " +
  "decoded from the original. Which lock lamps are lit at game start is " +
  "reconstruction, not decoded fact.";

// ---------------------------------------------------------------------------
// The devices
// ---------------------------------------------------------------------------

/**
 * One ball lock: a rectangle on one playfield level that swallows a ball.
 *
 * The bounds are ball-centre pixels in the same 336x600 space as the collision
 * map and the ramp drive, inclusive at both ends, straight out of the zone
 * records in `Table00N.seg04`.
 */
export interface BallLock {
  /** Stable name, so a failing test says which saucer broke. */
  readonly id: string;
  readonly level: PlayfieldLevel;
  /**
   * The lock's index in its level's shipped zone list — the same index the
   * devices export files it under and the mission layer binds its capture
   * script to (`triggers.locks` in the modes document), and the name a
   * `PUSH`/`BALL_REMOVE` eject comes back under. Decoded, not assigned.
   */
  readonly zoneIndex: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function lock(
  id: string,
  level: PlayfieldLevel,
  zoneIndex: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): BallLock {
  return Object.freeze({ id, level, zoneIndex, minX, minY, maxX, maxY });
}

/**
 * Every type-4 (capture) zone on the three tables, at data offsets
 * `Table001 0x25E6/0x26B2`, `Table002 0x25DE/0x2728`, `Table003 0x25EC/0x26D4`
 * — the level-0 list is the one containing the type-2 "go up" records and the
 * level-1 list the one containing type-3.
 *
 * Ten devices in all. Which of them a ball can actually get to is a separate
 * question and it was measured rather than assumed: driving the aggressive
 * census player through thirty games a table and counting distinct entries into
 * each rectangle gives
 *
 *     law-n-justice  jail-top 31   jail-throat 7   right-crater 0
 *     babewatch      grid-top 38   grid-mid  29    top-lane  1   lower-bowl 0
 *                    upper-deck 0
 *     extreme-sports bowl 19       upper-orbit 0
 *
 * so every table has at least one lock a rolling ball reaches on its own, and
 * two of the three have two. The zero-entry rectangles are kept: they are in the
 * shipped data, a better player reaches them, and deleting authored devices
 * because one scripted player missed them would be exactly the wrong trade.
 */
export const BALL_LOCKS_BY_TABLE: Readonly<Record<TableId, readonly BallLock[]>> = Object.freeze({
  // Law 'n Justice. The jail: "SHOOT JAIL", "PUT BACK IN JAIL", "JAILBREAK".
  // `jail-throat` sits over surface id 11 at (65,172), the only id on this table
  // whose engine handler zeroes the ball's velocity outright, in the mouth of
  // the left green crater under the CITY JAIL sign — an independent corroboration
  // from the surface map that something catches a ball there.
  "law-n-justice": Object.freeze([
    lock("jail-top", 0, 5, 85, 60, 145, 100),
    lock("right-crater", 0, 6, 235, 165, 260, 190),
    lock("jail-throat", 0, 7, 55, 170, 85, 200),
  ]),
  babewatch: Object.freeze([
    lock("grid-top", 0, 15, 66, 48, 86, 68),
    lock("grid-mid", 0, 16, 152, 110, 172, 130),
    lock("top-lane", 0, 17, 145, 14, 165, 34),
    lock("lower-bowl", 0, 18, 200, 250, 230, 295),
    lock("upper-deck", 1, 8, 70, 40, 110, 80),
  ]),
  "extreme-sports": Object.freeze([
    lock("bowl", 0, 12, 249, 159, 269, 179),
    lock("upper-orbit", 1, 10, 65, 10, 105, 50),
  ]),
});

export function ballLocksFor(tableId: TableId): readonly BallLock[] {
  const locks = BALL_LOCKS_BY_TABLE[tableId];
  if (locks === undefined) {
    throw new Error(
      `no ball locks registered for table ${JSON.stringify(tableId)}; known: ${TABLE_IDS.join(", ")}`,
    );
  }
  return locks;
}

/** True when a ball centre is inside this lock's rectangle on its level. */
export function lockCovers(device: BallLock, ball: BallState): boolean {
  if (ball.level !== device.level) return false;
  const x = q10ToPixel(ball.x);
  const y = q10ToPixel(ball.y);
  return x >= device.minX && x <= device.maxX && y >= device.minY && y <= device.maxY;
}

// ---------------------------------------------------------------------------
// The bank
// ---------------------------------------------------------------------------

/**
 * Which saucer is holding which ball.
 *
 * A `Map` keyed by device id, mirroring the original's `device+$01 = held ball
 * id` and its "0 means empty". Iteration is over `locks`, never over the map, so
 * nothing in a tick depends on insertion order and two runs of the same input
 * capture in the same sequence.
 */
export interface LockBank {
  readonly tableId: TableId;
  readonly locks: readonly BallLock[];
  /** Device id to ball id, occupied devices only. */
  readonly held: Map<string, number>;
}

export function createLockBank(tableId: TableId): LockBank {
  return { tableId, locks: ballLocksFor(tableId), held: new Map<string, number>() };
}

export function heldBallCount(bank: LockBank): number {
  return bank.held.size;
}

/** The ball a given saucer is holding, or null. */
export function heldBallIn(bank: LockBank, deviceId: string): number | null {
  return bank.held.get(deviceId) ?? null;
}

/** The lock filed under a zone-list index on one level, or null. */
export function lockForZone(
  bank: LockBank,
  level: PlayfieldLevel,
  zoneIndex: number,
): BallLock | null {
  return bank.locks.find((one) => one.level === level && one.zoneIndex === zoneIndex) ?? null;
}

/**
 * Empties ONE saucer, sending its ball to the trough, and returns the ball id.
 *
 * The single-device counterpart of `releaseHeldBalls`, for the decoded script
 * opcodes that name a specific lock: `PUSH`'s eject and `BALL_REMOVE`. Same
 * semantics — the ball is deactivated, not dropped onto the playfield — and the
 * caller decides whether the trough owes a serve for it.
 */
export function releaseLock(
  bank: LockBank,
  deviceId: string,
  balls: readonly BallState[],
): number | null {
  const ballId = bank.held.get(deviceId);
  if (ballId === undefined) return null;
  bank.held.delete(deviceId);
  const ball = balls.find((one) => one.id === ballId);
  if (ball !== undefined) {
    ball.heldBy = null;
    ball.active = false;
    ball.velocityX = 0;
    ball.velocityY = 0;
  }
  return ballId;
}

/** One capture, for the tick report. */
export interface LockCapture {
  readonly deviceId: string;
  readonly ballId: number;
}

/**
 * Captures every ball sitting in an empty saucer, and freezes it.
 *
 * Follows the engine's own three refusals in order: a ball already held is
 * ignored, a saucer already holding a ball is ignored, and the rectangle test is
 * against the ball centre. Devices are visited in table order and balls in set
 * order, so when two balls are in the same saucer on the same tick the lower ball
 * id wins, every time.
 *
 * The velocity is zeroed but the POSITION is not touched, because the original
 * does not touch it: the ball stops where it rolled in. That also means a lock
 * can never place a ball inside geometry, which a saucer-centre snap could.
 */
export function captureBalls(bank: LockBank, balls: readonly BallState[]): readonly LockCapture[] {
  const captures: LockCapture[] = [];
  for (const device of bank.locks) {
    if (bank.held.has(device.id)) continue;
    for (const ball of balls) {
      if (!ball.active || ball.heldBy !== null) continue;
      if (!lockCovers(device, ball)) continue;
      ball.heldBy = device.id;
      ball.velocityX = 0;
      ball.velocityY = 0;
      bank.held.set(device.id, ball.id);
      captures.push({ deviceId: device.id, ballId: ball.id });
      break;
    }
  }
  return captures;
}

/**
 * Empties every saucer and returns the balls it was holding.
 *
 * The released balls are DEACTIVATED, not dropped back onto the playfield, and
 * that is the original's behaviour rather than a shortcut. Opcode `$68` at data
 * 0x5B4E clears the held flag, unhooks the sprite (`jsr $c060`), decrements the
 * live count `$D7E(a5)`, re-initialises the ball object through data 0x3E36 and
 * increments the serve queue `$D86(a5)`. A released ball is a ball waiting in
 * the trough, and it comes back into play out of the plunger lane like any
 * other. The caller decides how many serves that is worth.
 *
 * Ids come back in device order so a caller's log is reproducible.
 */
export function releaseHeldBalls(bank: LockBank, balls: readonly BallState[]): readonly number[] {
  const freed: number[] = [];
  for (const device of bank.locks) {
    const ballId = bank.held.get(device.id);
    if (ballId === undefined) continue;
    bank.held.delete(device.id);
    const ball = balls.find((one) => one.id === ballId);
    if (ball === undefined) continue;
    ball.heldBy = null;
    ball.active = false;
    ball.velocityX = 0;
    ball.velocityY = 0;
    freed.push(ballId);
  }
  return freed;
}

/**
 * How many more balls the machine owes the lane to reach `target` in play.
 *
 * This is opcode `$6C` (data 0x5BCC) written out: it is a TOP-UP, not a fixed
 * count. The original loops `while (live + queued < N) queued++`, refusing
 * outright when `N > 3`, so asking for three balls when one is already rolling
 * queues two, not three. Anything at or over the target asks for nothing.
 */
export function ballsToTopUp(target: number, live: number, queued: number): number {
  if (target > MAX_SIMULTANEOUS_BALLS) return 0;
  const short = target - live - queued;
  return short > 0 ? short : 0;
}
