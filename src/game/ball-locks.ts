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
 *     - that release puts the ball back in the SERVE QUEUE rather than kicking
 *       it out of the saucer
 *     - that the multiball opcode is a TOP-UP to a requested ball count, and
 *       that it refuses any count above THREE
 *
 *   RECONSTRUCTED, and labelled as such wherever it appears
 *     - HOW MANY LOCKS LIGHT MULTIBALL. See `LOCKS_TO_LIGHT_MULTIBALL`.
 *     - that capturing the last ball in play serves a replacement.
 *       See `BALL_LOCK_RULES_NOTE`.
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
 * back out of the PLUNGER LANE, one at a time, which is why `startMultiball`
 * below queues serves instead of teleporting anything.
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
 * How many balls a multiball puts into play: the ceiling.
 *
 * Opcode `$6C` takes the target as a word parameter and merely refuses anything
 * over three, so two-ball and three-ball multiballs are both expressible and the
 * choice is per-table script data this project does not have. Three is used
 * because every published description of all three tables' multiball describes
 * more than two balls, and because it is what "lock two, the third starts it"
 * gives — see `LOCKS_TO_LIGHT_MULTIBALL`.
 */
export const MULTIBALL_BALL_COUNT = 3;

/**
 * RECONSTRUCTION. Balls that must be locked before multiball starts: two.
 *
 * This is the one rule in the file that is not decoded, and the reason is a
 * result rather than a gap. The shared engine holds every primitive — capture at
 * data 0x552A, release at data 0x5B4E, top-up at data 0x5BCC, end-detection at
 * data 0x5794 — and it maintains TWO lock counters, one per device at `+$03` and
 * a global at `$23E4(a5)`. It reads NEITHER. `$23E4` is written at exactly one
 * site, data 0x5554, and read at zero sites across main.seg00 and main.seg01.
 * Worse, `+$02` of the device record, the byte that gates those increments, is
 * ZERO on every type-4 device on all three tables as shipped, so the counting
 * path is dead at load time. The rule therefore lives in per-table script data,
 * and the script streams have not been located in the table modules.
 *
 * Two is chosen, not guessed at random:
 *
 *   - BabeWatch says so itself. Its module carries the strings "LOCK 1 BALL 4
 *     M-BALL" and "LOCK 2 BALLS 4 M-BALL" at data 18570..18838, beside "BALL 1
 *     LOCKED".."BALL 4 LOCKED". Two balls locked plus the one in play is three,
 *     which is the engine's ceiling exactly.
 *   - It is the only value that reaches the ceiling without exceeding it. One
 *     lock gives a two-ball multiball and wastes the third; three locks is
 *     impossible, because the third ball would have to be locked while no ball
 *     was in play.
 *
 * For Law 'n Justice and Extreme Sports there is no such string — Extreme Sports
 * has no lock or multiball string at all — so two is a reconstruction on those
 * tables and is labelled one.
 *
 * THE SCRIPTS ARE NOW LOCATED, AND THEY SAY THE REAL RULE IS LOOSER — this
 * paragraph is the trail for whoever wires it. The mode-VM export reads every
 * lock device's own capture script (device+$14, `jsr $6c10` at 0x557A): they
 * award and light lamps and never start a multiball themselves. The multiball
 * scripts are separate, and on BabeWatch they form a per-game LADDER: launcher
 * scripts 110/114/117/119 print "BALL 1..4 LOCKED" and MODE_START the modes at
 * scripts 179 (BALLS_UP_TO 2), 182 (3), 188 (2), 192 (3) — the FIRST lock of a
 * game already starts a two-ball multiball. LnJ's scripts 93/94 do BALL_REMOVE
 * then BALLS_UP_TO 2/3. What is still missing is the dispatch that runs the Nth
 * launcher on the Nth capture (nothing in the export references scripts
 * 110..119; their mission records carry selector -1), so this constant stays
 * the shipped reconstruction — now known to be TIGHTER than the original's
 * BabeWatch rule, which matters at the measured flipper energies because the
 * upper saucers are rarely reachable there. See docs/GAMEPLAY_PARITY.md.
 */
export const LOCKS_TO_LIGHT_MULTIBALL = 2;

/** Says out loud which parts of the lock behaviour are invented. For the UI and for tests. */
export const BALL_LOCK_RULES_NOTE =
  "Lock rectangles, capture, freeze, release-to-serve-queue and the three-ball " +
  "ceiling are decoded from the original. How many locks light multiball " +
  "(two) and that capturing the last ball in play serves a replacement are " +
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
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function lock(
  id: string,
  level: PlayfieldLevel,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): BallLock {
  return Object.freeze({ id, level, minX, minY, maxX, maxY });
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
    lock("jail-top", 0, 85, 60, 145, 100),
    lock("right-crater", 0, 235, 165, 260, 190),
    lock("jail-throat", 0, 55, 170, 85, 200),
  ]),
  babewatch: Object.freeze([
    lock("grid-top", 0, 66, 48, 86, 68),
    lock("grid-mid", 0, 152, 110, 172, 130),
    lock("top-lane", 0, 145, 14, 165, 34),
    lock("lower-bowl", 0, 200, 250, 230, 295),
    lock("upper-deck", 1, 70, 40, 110, 80),
  ]),
  "extreme-sports": Object.freeze([
    lock("bowl", 0, 249, 159, 269, 179),
    lock("upper-orbit", 1, 65, 10, 105, 50),
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
