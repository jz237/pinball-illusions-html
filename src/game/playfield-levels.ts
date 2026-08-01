/**
 * The two playfield levels, and how a ball moves between them.
 *
 * ---------------------------------------------------------------------------
 * EVERY COLUMN IN THIS FILE MOVED 32 PX, AND ONE GATE WAS DELETED
 * ---------------------------------------------------------------------------
 * The shipped collision maps were exported a word out of phase — slot 2's
 * payload starts at byte 4, not byte 8 — so every row of the old export was
 * framed 32 px left of where it belonged. The maps have been re-exported and
 * every measurement below re-run. Two things came of it, and they are opposite
 * in kind:
 *
 *   1. The BANDS DID NOT MOVE. Every gate row in this file is the row it always
 *      was, and every gate column is exactly 32 larger. That is what a purely
 *      horizontal reframe must do to a row-indexed measurement, and it is the
 *      cleanest single check that the correction is a correction: the derivation
 *      in `level-scan.ts`, re-run on the corrected maps, produces the same bands
 *      at the same rows with their runs shifted by 32 and their directions
 *      unchanged.
 *
 *      RE-MEASURED AGAIN, GATE BY GATE, AFTER THE REFRAME LANDED, because "+32"
 *      is a claim and not a proof. Every row, every column span and every
 *      direction below was re-derived from the shipped maps with the engine's
 *      own radius-8 ring, and exactly ONE of them was wrong: Extreme Sports'
 *      `crown-mouth` needed its left column moved from 290 to 289. That gate is
 *      not a band gate — it is a ramp mouth on a diagonal, and its columns had
 *      been read off free CENTRES while the ball that matters is in CONTACT with
 *      the arc and therefore one column further left. It is written up in full
 *      under EXTREME SPORTS below. Everything else re-measured to what was
 *      already here.
 *   2. LAW 'N JUSTICE'S `arch-exit` IS GONE. It was the one fabricated number in
 *      this file, a release point at y=46 invented because the arch ramp
 *      appeared to run off the left edge of the bitmap around y=91. It never
 *      did. The old frame was cutting the ramp's outboard rail off at column 0;
 *      on the corrected map the channel runs 122 rows further, down the left of
 *      the table, and ENDS the way BabeWatch's wireform ends. `ramp-end` is that
 *      end, read off the map. There is no invented coordinate left here.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Law 'n Justice's lower collision line (map bit 0) simply stops. Its shooter
 * lane has walls at x=310-312 and x=333-335 whose TOPMOST row is y=127, and
 * above that there is no bit-0 pixel anywhere in columns 313..332 — the first
 * one is y=561, down by the drain. Rows 0..34 of that table carry no bit-0
 * pixel at all. So a ball launched up the lane on the lower level meets nothing,
 * rises until gravity stops it, falls back down the lane and stays there: the
 * game cannot reach ball two.
 *
 * The arch is not missing. It is on the OTHER collision line. Read straight off
 * `public/generated/tables/law-n-justice.map.json`:
 *
 *   y=118   bit0 (none in 308..335)      bit1 [308-310] [332-334]
 *   y=126   bit0 (none in 308..335)      bit1 [310-312] [333-335]
 *   y=128   bit0 [310-312] [333-335]     bit1 [310-312] [333-335]
 *   y=175   bit0 [310-312] [333-335]     bit1 [310-312] [333-335]
 *   y=176   bit0 [310-312] [333-335]     bit1 (none in 308..335)
 *
 * The lane's two walls are bit-1 only up to y=126, carry BOTH bits through
 * y=127..175, and are bit-0 only from y=176 down. That 49-row overlap is a
 * hand-off: over those rows the two levels have byte-identical geometry, so a
 * ball may change level there and notice nothing at all. Above it the walls
 * curve left and become two concentric bit-1 arcs that cap the whole table —
 * outer cap y=0..2 at x=164..188, inner cap y=24..26 at x=164..187 — with a
 * channel between them about 21 px wide, which is a 16 px ball and no more. A
 * radius-8 disc blocked by bit 1 alone travels that channel unbroken from the
 * lane to the apex, down the left side and on to y=210.
 *
 * That is a habitrail, which is why its collision line is the upper one. The
 * engine was already right to let a LOWER-level ball pass through bit 1 (making
 * it solid for everyone fences off large parts of all three tables). It was
 * wrong to have no other level for the ball to be on.
 *
 * So: nothing here is synthesised. The arch is authored data, and this module
 * is the two things the physics was missing — a way to collide against the
 * upper line, and a rule for when a ball is on it.
 *
 * ---------------------------------------------------------------------------
 * HOW THE UPPER LEVEL IS EXPRESSED
 * ---------------------------------------------------------------------------
 * Not with a second material table. `upperLevelIndex` rewrites each index into
 * the index that means the same thing on the upper level under the EXISTING
 * table: set bit 0 when bit 1 is set, clear it otherwise. Every result is an
 * index the material table already defines, and it lands on a behaviour with
 * the right coefficients — 2/3/6/7/10/11/14/15 all map onto `solid` wall
 * entries, 0/1/4/5/8/9/12/13 all onto `free` ones. The structure bits survive
 * the rewrite, so a later renderer or device layer can still read them.
 *
 * The one thing the rewrite cannot express is off-map: `materialAt` answers 5
 * outside the bitmap, and 5 has no bit 1, so a naive rewrite would make the
 * edge of the world passable to an upper-level ball and lose it forever. The
 * view therefore does its own bounds check and answers 15 — solid on both
 * levels — which is what the outer wall of a table is anyway.
 */

import type { MaterialIndex, PlayfieldLevel, TableId, TableMap } from "./contracts.js";
import { LEVEL1_SOLID_BIT } from "./materials.js";

/**
 * Re-exported so callers reasoning about levels need one import.
 *
 * The type itself lives in `contracts.ts` because `BallState` carries it and
 * contracts may not depend on anything with behaviour.
 */
export type { PlayfieldLevel };

/** The index that means, on the upper level, what `index` means on the lower. */
export function upperLevelIndex(index: MaterialIndex): MaterialIndex {
  return ((index & LEVEL1_SOLID_BIT) !== 0 ? index | 1 : index & ~1) as MaterialIndex;
}

/** Solid on both levels: what an upper-level probe reads outside the bitmap. */
const UPPER_OUT_OF_BOUNDS: MaterialIndex = 15;

const UPPER_VIEW_CACHE = new WeakMap<TableMap, TableMap>();

/**
 * The map as an upper-level ball sees it.
 *
 * `pixels` is passed through untouched — this is a physics view, not a second
 * bitmap, and nothing may draw from it. Cached per map so the per-tick cost is
 * a lookup rather than a fresh closure.
 *
 * No virtual top wall is applied and none is wanted: the virtual wall exists
 * because the LOWER line has no top border on Law 'n Justice, and the upper
 * line's whole point here is that it does — the outer arch caps the table at
 * y=0.
 */
export function upperLevelViewFor(map: TableMap): TableMap {
  const cached = UPPER_VIEW_CACHE.get(map);
  if (cached !== undefined) return cached;

  const view: TableMap = Object.freeze({
    tableId: map.tableId,
    displayName: map.displayName,
    width: map.width,
    height: map.height,
    pixels: map.pixels,
    materialAt(x: number, y: number): MaterialIndex {
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return UPPER_OUT_OF_BOUNDS;
      if (px < 0 || px >= map.width || py < 0 || py >= map.height) return UPPER_OUT_OF_BOUNDS;
      return upperLevelIndex(map.materialAt(px, py));
    },
  });

  UPPER_VIEW_CACHE.set(map, view);
  return view;
}

// ---------------------------------------------------------------------------
// What a shove can reach
// ---------------------------------------------------------------------------

/**
 * Whether a nudge's impulse reaches a ball on this level. It does not reach
 * level 1.
 *
 * Level 1 is the ramp and habitrail network, and a habitrail is a TUBE: the ball
 * is captive between two rails a couple of pixels wider than itself and the only
 * freedom it has is along the rail. Everything else this module models is 2-D
 * because the map is, but a lateral impulse is the one place where the flattening
 * shows, since in the projection the ball has sideways room the real one does not.
 * Shoving the cabinet cannot throw a ball off a wireform, and nothing about the
 * shipped data says it can.
 *
 * The measurement that made this a correctness matter rather than a nicety. A
 * ball on Law 'n Justice's top arch rolls at about 48 Q10 per tick — a pixel
 * every twenty ticks. `nudgeConfigFor` gives a shove 2048 Q10, FORTY TIMES that,
 * so a single nudge did not perturb the shot, it replaced it. Measured on the
 * real map with a nudge every 400 ticks:
 *
 *   t=399  (74,30) level 1, v(-60,15)     <- the shot, coasting round the arch
 *   t=400  (72,30) level 1, v(-2108,39)   <- one shove
 *   t=419  (42,46) crosses the arch exit at v(-1406,1364)
 *
 * The undisturbed shot crosses that same exit at (46,46) with v(-61,35), drops
 * into the one chute in the top-left that reaches the drain, and comes back to
 * the flippers. The shoved one sails clear over the chute and wedges in a sealed
 * pocket at (53,153) — an OLD-FRAME column, like every other one in this
 * paragraph: the measurement predates the map re-export and predates the deletion
 * of `arch-exit`, so it is kept as the history of why `nudgeReachesLevel` exists
 * rather than as a claim about the shipped map. Shoving
 * the other way (`nudgeRight`) instead drove the ball back up the arch, so it
 * could never finish the shot at all: over thirty scripted games at that cadence
 * not one reached ball two.
 *
 * Gravity is NOT excluded — a ball rolls down a ramp — and neither is anything
 * else. This is only about the shove.
 */
export function nudgeReachesLevel(level: PlayfieldLevel): boolean {
  return level === 0;
}

// ---------------------------------------------------------------------------
// Level changes
// ---------------------------------------------------------------------------

/**
 * A horizontal line the ball changes level by crossing.
 *
 * A LINE rather than a region, because the thing being modelled is a hand-off
 * point on a ramp and a ball is either before it or past it. `whenRising` and
 * `whenFalling` are separate so a gate can be one-way: the arch's exit is, and
 * making it two-way would let a ball shot up the left orbit teleport onto a
 * habitrail it never entered.
 *
 * These are the only invented numbers in the two-level model, and they are
 * triggers, not geometry — every rail the ball touches is authored map data.
 * Each row below is justified against the map in `LEVEL_GATES_BY_TABLE`.
 */
export interface LevelGate {
  /** Stable name, so a failing test says which hand-off broke. */
  readonly id: string;
  /** Ball-centre columns the gate spans, inclusive. */
  readonly minX: number;
  readonly maxX: number;
  /** Ball-centre row the gate sits on. */
  readonly y: number;
  /** Level after crossing upward past `y`, or null to leave the level alone. */
  readonly whenRising: PlayfieldLevel | null;
  /** Level after crossing downward past `y`, or null to leave the level alone. */
  readonly whenFalling: PlayfieldLevel | null;
}

// ---------------------------------------------------------------------------
// A mouth that is a band, not a row
// ---------------------------------------------------------------------------

/**
 * Top and bottom rows of Extreme Sports' crown-ramp mouth.
 *
 * Both are read off the map rather than chosen. The TOP is the first row on
 * which the wireform's own free upper-line centres are still inside the wedge a
 * lower-level ball can occupy: its leftmost centre is 303 at y=130 and the
 * wedge's rightmost free centre is 302 on every row, so y=131 is where the ramp
 * first passes over reachable playfield. The BOTTOM is the last row on which the
 * wedge has a free lower-line centre at all — [302-302] at y=162, nothing at
 * y=163 — which is the floor of the cup.
 */
export const CROWN_MOUTH_TOP_Y = 131;
export const CROWN_MOUTH_BOTTOM_Y = 162;

/** Half-width of the wireform's interior, in ball centres either side of `left`. */
const CROWN_TUBE_LEFT_REACH = 9;
const CROWN_TUBE_RIGHT_REACH = 11;

/**
 * The leftmost free upper-level ball centre of the crown wireform on row `y`.
 *
 * Read off the shipped map, and it is a straight rail drawn as a 1-px staircase:
 * the wireform's free-centre run is [`left`, `left + 2`] with
 *
 *     left(y) = 302 - ((y - 131) >> 1)
 *
 * on every row of the band with no residual — 302 at y=131..132, 301 at
 * 133..134, 300 at 135..136, ..., 289 at 157..158, 287 at 161..162. One column
 * left every two rows, thirty-two rows running. `tests/level-scan.test.ts`
 * re-measures every row against the shipped map rather than trusting the
 * formula.
 */
export function crownMouthLeftColumn(y: number): number {
  return 302 - ((y - CROWN_MOUTH_TOP_Y) >> 1);
}

/**
 * Extreme Sports' crown-ramp mouth, as the thirty-two-row band it is.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT ONE GATE AT y=158 ANY MORE
 * ---------------------------------------------------------------------------
 * `crown-mouth` used to be a single row — y=158, x 289..291 — chosen because
 * that is where the LOWER line's route down the outside of the crown arc runs
 * out AND the wireform is underneath it. Both halves of that are true. What is
 * not true is that a ball arrives there.
 *
 * Measured on the shipped map with the engine's own radius-8 ring, the lower
 * line's free centres in the wedge between the crown arc and the shooter lane's
 * outer wall go
 *
 *   y=150 [266-302]  y=155 [281-302]  y=158 [290-302]
 *   y=159 [293-302]  y=160 [296-302]  y=161 [299-302]
 *   y=162 [302-302]  y=163 (none)
 *
 * — a funnel whose floor is the arc's convex face, sloping DOWN TO THE RIGHT,
 * and whose right wall is the lane. Its lowest point is the single centre
 * (302,162), and (302,163) is solid on both lines. It is a closed cup: a ball
 * put anywhere in it under gravity alone ends at (303.0, 163.1) with velocity
 * (0,0) and stays there for the rest of the game. That is the second of the two
 * deterministic traps this work was about, and it is the site the aggressive
 * census recorded as (302,162)/(302,163).
 *
 * Two kinds of ball died there and the old gate could not have caught either:
 *
 *   - THE ROLLING BALL. A free CENTRE is a place a ball sits clear of
 *     everything; a ball resting ON the face is below that set, and traced tick
 *     by tick down the face from (280,150) it crosses row 155 at x=281.9, row
 *     157 at x=285.0 and row 158 at x=287.8 — two to three columns LEFT of the
 *     free-centre edge, never inside [289-291]. The old gate's premise, that the
 *     face delivers the ball to x=289 on row 158, is off by the amount the ball
 *     sinks into the surface it is rolling on.
 *   - THE FALLING BALL. The wedge is open at the top: it is the bottom of the
 *     whole top-right of the table. A ball that drops into it anywhere right of
 *     the mouth lands below row 158 and never crosses that row at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MOUTH ACTUALLY IS
 * ---------------------------------------------------------------------------
 * The wireform is a TUBE, and the map says so with unusual clarity. On every one
 * of the thirty-two rows of this band the upper line's solid pixels either side
 * of the ramp are exactly 21 ball-centre columns apart, so the interior is
 *
 *     [left - 9, left + 11]
 *
 * with no residual anywhere from y=131 ([293-313]) to y=162 ([278-298]) — a
 * constant-width channel drawn as a straight diagonal, which is what a wireform
 * is. Over those rows that tube lies inside open lower-line space, and below
 * them it passes under the arc and the two lines part company.
 *
 * So the mouth is the tube, and a ball is on the ramp when it crosses a row of
 * the band anywhere between the ramp's two rails — not merely when it is
 * centred perfectly between them. That is the same standard `left-orbit`
 * already uses on the other side of the table ("a ball anywhere in the funnel is
 * entering the ramp, because the lower line has nowhere else to take it"), and
 * it lands the ball inside the rails, where the contact model slides it into the
 * channel exactly as it would on a real wireform. The bottom row of the old
 * gate, [289-291] at y=158, is a subset of this row's [280-300].
 *
 * Nothing else on the lower line is inside this box: over y=131..162 the only
 * free lower-line centres between x=278 and x=313 are the wedge itself, and the
 * shooter lane is at x=322..324 with the tube's right edge never past 313 — nine
 * columns clear at its widest, so a ball in the lane can never be caught by it.
 * Falling only, like the row it replaces: a ball crossing these rows upward in
 * that corner is coming off the playfield, not entering a ramp backwards.
 */
function crownMouthGates(): readonly LevelGate[] {
  const gates: LevelGate[] = [];
  for (let y = CROWN_MOUTH_TOP_Y; y <= CROWN_MOUTH_BOTTOM_Y; y += 1) {
    const left = crownMouthLeftColumn(y);
    gates.push(
      Object.freeze({
        id: `crown-mouth-${y}`,
        minX: left - CROWN_TUBE_LEFT_REACH,
        maxX: left + CROWN_TUBE_RIGHT_REACH,
        y,
        whenRising: null,
        whenFalling: 1 as const,
      }),
    );
  }
  return Object.freeze(gates);
}

/**
 * Law 'n Justice's two hand-offs.
 *
 * `lane-mouth` (y=152, x 321..324, both ways)
 *   Dead centre of the 51-row band y=127..177 where the shooter lane's two
 *   walls carry BOTH collision lines. Over that band the levels are
 *   byte-identical — bit0 and bit1 both read [310-312] and [333-335] on every
 *   row of it — so switching there changes nothing the ball can feel, which is
 *   exactly what a hand-off has to be. Two-way: a launch too weak to clear the
 *   arch comes back down the same lane and must arrive back on the playfield.
 *
 * `ramp-end` (y=207, x 34..36, falling only)
 *   Where the arch ramp puts the ball back on the playfield. THIS REPLACES
 *   `arch-exit`, which sat at y=46 and was the one fabricated number in this
 *   file. Its whole justification was "the ramp cannot carry the ball all the
 *   way down — its outboard rail runs off the left edge of the bitmap", and that
 *   was an artefact of the 32 px export phase error: the rail was 32 px in from
 *   column 0 all along, and the old frame was throwing it away. Everything the
 *   old gate was hedging against — a free-fall across a bowl, a three-way
 *   watershed, two cups either side of a narrow funnel — was a consequence of
 *   releasing the ball 160 rows too early. None of it survives the correction.
 *
 *   What the corrected map says, measured with the engine's own radius-8 ring on
 *   the upper-level view, following the channel from the crown:
 *
 *     y=46   free centres [67-76]      y=150  [24-29]
 *     y=80   [38-45]                   y=180  [30-37]
 *     y=90   [33-40]                   y=200  [34-43]
 *     y=120  [25-30]                   y=207  [34-36]
 *
 *   Never wider than fifteen centres and never empty: one continuous channel
 *   barely wider than the ball, from the apex down the left of the table. Below
 *   y=207 it runs out — the inboard rail stops at y=205 and by y=214 what is
 *   left has merged into the strip along the table's left edge.
 *
 *   The row is the LAST one on which the whole channel is also free on the lower
 *   line, so the hand-off cannot put the ball inside a wall. At y=207 the
 *   channel is [34-36] and the lower line reads [34-45] there; at y=208 the
 *   channel steps left to [33-35] and 33 is solid below. `sameRingReading` — the
 *   strict test, every point of the probe ring identical on both views — holds
 *   across the whole gate at that row, so this is a real hand-off by the same
 *   standard the lane bands meet, not a release point.
 *
 *   It is the same shape as BabeWatch's `ramp-end` and Extreme Sports'
 *   `crown-end`: a wireform that simply stops, over open lower-line space, with
 *   the gate a few rows before the stop so it fires before the ball noses into
 *   the closed end. Falling only: a lower-level ball crossing y=207 upward in
 *   the top-left is coming off the playfield, not entering a ramp backwards.
 *
 *   What this bought, measured on the write-off census in `plays.test.ts`
 *   (thirty games, every plunge strength): Law 'n Justice went from a budgeted
 *   35% ball-search rate to ZERO — 63 balls, 63 drains, no write-offs, and not
 *   one ball in the top-left bowl the old gate used to drop them into.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THE OTHER TWO TABLES ARE DERIVED BY
 * ---------------------------------------------------------------------------
 * `lane-mouth` used to be the whole model, and it was Law 'n Justice's lane
 * written out longhand: a row, a column span and a direction, none of which said
 * anything about how to find the same thing on another table. Copied to
 * BabeWatch and Extreme Sports it did nothing at all — neither table drained a
 * single ball in twenty thousand ticks at any plunge strength.
 *
 * The rule underneath it is this, and it is entirely readable off the maps:
 *
 *   1. WHERE. Walk the shooter lane's centre column from the serve row upward.
 *      At each row take the free-ball-centre run containing that column on each
 *      collision line. A HAND-OFF BAND is a maximal set of rows where both runs
 *      exist, both are narrow enough to be a channel rather than open playfield,
 *      and they are the same run. Over such a band the ball cannot tell which
 *      line it is on, so a level change there is unobservable — which is exactly
 *      what a hand-off has to be, and it is why the row chosen inside the band
 *      does not matter. (Measured: moving Extreme Sports' upper gate anywhere in
 *      139..238 leaves the whole trajectory byte-identical.)
 *
 *   2. WHICH WAY. Above the band, exactly one of the two lines usually still
 *      carries the lane; the other's channel has ended or opened out into the
 *      playfield. A ball crossing the band upward takes the line that CONTINUES.
 *      Falling, it takes the line that continues below. A band where both lines
 *      continue, or neither does, gets no gate — it is not a hand-off, it is
 *      just two lines drawing the same wall.
 *
 * `level-scan.ts` implements both steps, and `tests/level-scan.test.ts` re-runs
 * them against the three shipped maps and asserts that every gate below sits in
 * a band that scan finds, pointing the way that scan says. So the numbers in
 * this table are checkably derived rather than merely asserted; if a map is
 * re-exported and a band moves, the test fails instead of the game.
 *
 * BABEWATCH — two gates.
 *
 * `lane-mouth` (y=432, x 321..323, both ways) and `lane-upper` (y=311)
 *   Bands at the lane column are y=279..343 and y=407..458; `lane-mouth` is the
 *   middle of the lower one. Below it only bit 0 carries the lane (walls
 *   x=310..312 and x=332..335 run to the floor at y=561); above it only bit 1
 *   does, because the bit-0 lane is pinched shut at y=372..379 where its own
 *   right wall crosses it. `lane-upper` is the middle of the upper band, and it
 *   is falling-only: above that band both lines dead-end together at y≈240,
 *   which is the "neither continues" case and gets no rising arm.
 *
 *   That pinch is why this table was unplayable. On bit 0 alone the served ball
 *   sits in a 577-cell sealed box spanning x=317..327, y=379..552 — measured by
 *   flooding free radius-8 centres from the serve point, and still exactly 577
 *   cells on the corrected map — with no path to the drain at all. Twenty
 *   thousand ticks, every plunge strength, zero drains.
 *
 * `ramp-end` (y=276, x 290..300, rising only)
 *   Above the lane band the bit-1 channel does not run straight up: both its
 *   walls sweep left together, from x=310/332 at y=456 to x=287/312 at y=348 and
 *   on to x=279/301 at y=300. It is a wireform, and it ENDS. Its last free ball
 *   centre is (296, 273); at y=268 the two rails close to a 15 px gap, two short
 *   of the ball, and by y=260 bit 1 is solid right across. There is nowhere
 *   further to go on the upper line.
 *
 *   Bit 0 is open exactly there — free centres x=285..297 at y=266..274, part of
 *   the main playfield component — so the ramp delivers its ball onto the table
 *   the way a wireform does: it stops, and the ball is on the playfield. The row
 *   is the ramp's own end plus three, so the gate fires before the ball noses
 *   into the closed end. Rising only: a level-0 ball crossing y=276 downward in
 *   the top-left is coming off the playfield, not entering a ramp backwards.
 *
 * EXTREME SPORTS — four gates. Its lane changes line TWICE.
 *
 * `lane-mouth` (y=443, x 322..324, both ways) and `lane-upper` (y=188, rising to
 * level 0, falling to level 1)
 *   Bands at the lane column are y=408..479 and y=139..238. Bit 0 carries the
 *   lane from the floor up to y≈408, where it opens into a wide funnel; bit 1
 *   carries it from y≈480 all the way up to y≈135, where a wall peeling off the
 *   left rail at y=145 curves right and closes it against the right rail by
 *   y≈100. Above the upper band it is bit 0 again — walls x=311..313 and
 *   x=333..335 up to y≈100, and then the arch.
 *
 *   So the shot is: lower line, upper line, lower line. Without the first gate
 *   the ball leaves the lane sideways at y=408 and dies in the funnel beside it;
 *   without the second it noses into the closed top of the upper lane at y=136
 *   and falls straight back down. Both were measured before the gates existed,
 *   and both are what this table did at every plunge strength.
 *
 * `left-orbit` (y=136, x 42..53, falling only) and `left-orbit-exit` (y=181,
 * x 49..56, falling only)
 *   The left orbit — where the arch delivers a ball that gets that far — is the
 *   same device again, on the other side of the table. On bit 0 the funnel
 *   narrows to nothing: free centres go [44-56] at y=132, [42-52] at y=136,
 *   [39-45] at y=144, [37-41] at y=150, [35-35] at y=161 and NONE at y=162. On
 *   bit 1 a channel between rails at x=38..40 and x=64..66 BEGINS at y=132 (free
 *   centres [49-49]) and runs down to y≈186. The bit-0 funnel and the bit-1
 *   channel overlap at x=49..50 over y=132..139: that is the ramp's mouth, and
 *   it is where the gate sits.
 *
 *   THE GATE IS THE FUNNEL, NOT THE OVERLAP, and that is a correction the
 *   reframe forced into the open. Its columns used to be the funnel's run at
 *   y=132 while the gate itself sat at y=136, four rows lower, by which point
 *   the funnel has slid two columns left. Balls rolling down the funnel's LEFT
 *   rail crossed y=136 at x=42 or 43, outside the gate, missed the ramp entirely
 *   and died at the funnel's dead end around (34,168) — two of the four
 *   write-offs in the whole census. So the columns are now the funnel's own
 *   free-centre run ON THE GATE'S ROW, [42-52], plus column 53, which is where a
 *   ball riding the RIGHT rail crosses. That last column is not padding: over
 *   thirty scripted games every crossing of y=136 inside the funnel is in
 *   x=42..53, with hard walls at both ends of the distribution. A ball anywhere
 *   in the funnel is entering the ramp, because the lower line has nowhere else
 *   to take it.
 *
 *   At the bottom the two swap back. Both lines carry the channel over
 *   y=181..182 — the free-centre runs are byte-identical, [49-56] on both — and
 *   below it bit 1 opens out ([49-61] by y=186) while bit 0 keeps the lane
 *   ([47-54] down to y=200 and beyond). Falling only, both of them: this is a
 *   descent, and a ball coming up the orbit lane is on the playfield.
 *
 * `crown-mouth` (y=158, x 289..291, falling only) and `crown-end` (y=349,
 * x 274..276, both ways)
 *   The other end of the same shot, and the reason this table used to score a
 *   FALSE 30-in-30: every one of its balls ended as a ball-search write-off at
 *   exactly (302,163), and none of them ever drained. (That pixel read (270,163)
 *   before the maps were re-exported on the correct 32 px frame. It is still one
 *   pixel and still a cup, so the cup was never a framing artefact — which was
 *   the first thing re-checked after the reframe, because if the cup had been an
 *   artefact both crown gates would have had to go.)
 *
 *   Unlike the other two tables, Extreme Sports' top arch is on bit 0 — its
 *   per-column topmost bit-0 row is 95 at x=32, 57 at x=96, 33 at x=192..256, 44
 *   at x=288 — so after the two lane gates the launched ball correctly rides the
 *   crown on the LOWER line. The crown is four concentric bit-0 arcs, and a ball
 *   that comes over it lands on the outside of the outermost one and rolls down
 *   its convex face to the right. That face runs out. Free bit-0 ball centres in
 *   the wedge between the arc and the shooter lane's outer wall (x=311..313) go
 *   [266-302] at y=150, [281-302] at y=155, [290-302] at y=158, [296-302] at
 *   y=160, [302-302] at y=162 and NONE at y=163: the arc's hairpin apex is at
 *   x=305 and the lane wall starts at x=311, a 5 px gap a 16 px ball cannot
 *   pass. (302,163)..(302,178) is solid on both lines. So the lower line's route
 *   genuinely stops, and a ball that gets there creeps into the corner and stays
 *   until the search retires it. It is a cup, not a sealed pocket — the flood in
 *   `plays.test.ts` reaches it — which is exactly why the ball search was able
 *   to hide it.
 *
 *   The continuation is authored, on the other line, and it is the same
 *   ramp-mouth / ramp-end pair as `left-orbit` above. A band running diagonally
 *   down-left from (302,131) to (290,158) is free on BOTH lines — [293-295] at
 *   y=150, [291-293] at y=153, [290-292] at y=155, [289-291] at y=157,
 *   [290-291] at y=158, nothing at y=159. Over that band the bit-0 wedge is
 *   closing and a bit-1 channel runs straight through it: [302-304] at y=131,
 *   [298-300] at y=140, [288-290] at y=160, [283-285] at y=170, [278-280] at
 *   y=180 and then [274-276] unbroken from y=197 to y=380. That is the wireform
 *   bundle the artwork draws emerging from under the biplane's wing and running
 *   down the right of the table.
 *
 *   `crown-mouth` sits on the BOTTOM row of the band, y=158, and that is not a
 *   preference. The bit-0 wedge closes from the left as it descends — its
 *   leftmost free centre is x=266 at y=150, 281 at y=155, 290 at y=158, 302 at
 *   y=162 and none at all at y=163 — so the wedge's own floor and the band meet
 *   exactly at y=158, where the leftmost free centre (290) IS the band. A ball
 *   rolling down the arc's face in contact with it is therefore physically at
 *   the wireform's entrance on that row, and one row lower the lower line has
 *   nowhere left to take it at any column. Falling only: a ball crossing y=158
 *   upward here is coming off the playfield, not entering a ramp backwards.
 *
 *   ITS COLUMNS ARE 289..291 AND THEY USED TO BE 290..291. THAT ONE COLUMN WAS
 *   THE WHOLE OF THIS TABLE'S REMAINING BLOCKER. 290..291 is a correct reading
 *   of the both-lines-free columns ON ROW 158 and a wrong trigger, because the
 *   mouth is a DIAGONAL band sliding two columns left every three rows and the
 *   ball's path down the arc's convex face is very nearly parallel to it:
 *
 *     y=155  L0 [281-302]  L1 [260-292]  both {290,291,292}
 *     y=157  L0 [287-302]  L1 [289-291]  both {289,290,291}
 *     y=158  L0 [290-302]  L1 [289-291]  both {290,291}
 *     y=159  L0 [293-302]  L1 [288-290]  both {}
 *
 *   A free CENTRE run is where a ball can sit clear of everything. A ball rolling
 *   in CONTACT with the arc sits one pixel inside the surface, so its centre is
 *   one column outside that run — and the gate columns were taken from the run.
 *   Measured over the thirty-game census: of ninety crossings of y=158 inside
 *   x=270..310, EIGHTY-ONE are at x=289 and only five at x=290 or 291. The gate
 *   caught five of ninety, and the other eighty-five balls rolled on into the
 *   cup below and stayed there.
 *
 *   289 is not padding and not a fudge. It is the both-free run one row higher
 *   (y=157 reads exactly {289,290,291}), it is the lower line's own leftmost free
 *   centre at the gate row minus one — the contact column — and it is free on
 *   LEVEL 1, which is the line the ball is being handed to, so the hand-off puts
 *   it in the wireform rather than in a wall. Measured effect with nothing else
 *   changed: 23 of 30 census games completed becomes 26 of 30, drains 68 becomes
 *   77, and all three (302,163) stalls disappear. Widening further (288..291,
 *   289..295, 289..302) changes nothing at all, which is the check that column
 *   289 is the whole of it.
 *
 *   `tests/level-scan.test.ts` asserts all four of those facts rather than the
 *   gate's literal columns, so the rule survives a re-export.
 *
 *   `crown-end` is the wireform's far end, and unlike the mouth it IS the plain
 *   band rule — `level-scan` finds it unaided on the wireform's own column. At
 *   y=349..350 both lines carry the byte-identical run [274-276]; below it only
 *   bit 0 continues, on down to y=414 where it opens onto the playfield at
 *   [180-287], while bit 1's channel stops dead at y=380 ([274-276] at y=380 and
 *   nothing there at y=381). `handoffDirection` answers 0 falling and 1 rising
 *   and the gate is those two answers, with y=349 the band's own centre.
 *
 *   Measured with both gates and without: without them Extreme Sports drains
 *   nothing at all and 120 of 132 write-offs over sixty games are on the single
 *   pixel the cup sits on. With `crown-mouth` alone the write-offs simply move
 *   to (276,380), the closed bottom end of the wireform. Both are needed, and
 *   both are read off the map.
 *
 * ---------------------------------------------------------------------------
 * BABEWATCH `spinner-lane` AND `habitrail-inlane`: THE SAME PAIR AGAIN
 * ---------------------------------------------------------------------------
 * The pattern Extreme Sports taught — the lower line's route runs out, the upper
 * line's carries on, and the two agree over a band in between — turns out to be
 * BabeWatch's remaining ball trap as well, and the census site this project had
 * recorded as (91,167..174) is exactly it.
 *
 * THE CUP. Three parallel level-0 channels run down the left of BabeWatch's
 * roulette grid. The MIDDLE one is a wedge that closes:
 *
 *     y=137  L0 [82-90]   y=143  [88-90]   y=151  [89-90]
 *     y=158  L0 [90-90]   y=162  [90-90]   y=163  NONE
 *
 * Its right edge holds at column 90 while its left edge climbs from 82 to 90, so
 * the WALLS converge rather than the floor flattening: at y=171 they stand at
 * x=81..83 and x=99..101, a 15 px gap a 16 px ball cannot occupy. The ball rides
 * down from the wide mouth at y=137 and jams a few rows below the last free
 * centre, which is the (90..91, 167..174) cluster. No acceleration helps here and
 * the original carries no drive block in those blocks; a stronger push would only
 * wedge it harder.
 *
 * THE CONTINUATION, on the other line, overlapping the cup:
 *
 *     y=152  L0 [89-90]  L1 [89-89]
 *     y=155  L0 [89-90]  L1 [89-93]
 *     y=158  L0 [90-90]  L1 [90-98]
 *     y=162  L0 [90-90]  L1 [90-105]
 *     y=163  L0 NONE     L1 [91-107]
 *
 * The upper line's channel OPENS at (89,152), exactly where the lower line's is
 * closing, and widens away down and to the right without a break. Over rows
 * 152..162 the two share columns 89..90, so a ball there cannot tell which line
 * it is on. `spinner-lane` sits at y=155, the middle of that band, and is
 * two-way for the same reason `lane-mouth` is: it is a ramp mouth, and a ball
 * coming back up it belongs on the lower line's lane again.
 *
 * Columns 88..92 rather than the 89..90 free run, for the reason `crown-mouth`
 * needed 289: a ball rolling in CONTACT with a wall sits a column outside the
 * free-centre run. Every column in 88..92 is safe in the falling direction
 * because level 1 is the MORE open line there — 89..93 free against the lower
 * line's 89..90 — so this hand-off can only ever release a ball from a wall,
 * never place one in it.
 *
 * `habitrail-inlane` is the far end of the same route, and it is the plain band
 * rule with no interpretation at all: rows 448..456 carry the BYTE-IDENTICAL run
 * [36-38] on both lines. The upper line's channel there runs y=443..463 and stops
 * dead at 464, while the lower line's [36-38] carries on down into the left
 * inlane. It is the habitrail delivery the surface map names — upper surface id
 * 11, "level change to lower", drawn as short bars across the inlane mouths on
 * every table. Falling only: a ball climbing the inlane is not entering a
 * habitrail backwards.
 *
 * Measured over the ninety-game aggressive census with nothing else changed:
 * BabeWatch write-offs 12 -> 7 with `spinner-lane` alone and the whole
 * (90..91, 167..174) cluster gone, then 7 -> 6 with `habitrail-inlane`, which
 * removes the one level-1 write-off the first gate created at (36,463).
 *
 * ---------------------------------------------------------------------------
 * LAW 'N JUSTICE `left-apron`: A LEVEL-1 CUP, FOUND BY MULTIBALL
 * ---------------------------------------------------------------------------
 * A hand-off OUT of a cup rather than into a ramp, and it exists because
 * multiball found it. The upper line carries a teardrop left of the left ramp —
 * the metal apron plate the artwork draws at about (4..27, 197..235) — which
 * merges with the ramp channel at y=214 and then closes:
 *
 *     y=214  L1 [8-29]   y=225  [8-18]   y=230  [8-13]   y=235  [8-8]
 *     y=236  L1 nothing at all left of the ramp channel
 *
 * Its floor slopes down-LEFT, so a ball that spills off the ramp into it is
 * funnelled into the bottom-left corner and stops. Nothing reached it until balls
 * could be up there in pairs: with one ball in play the census recorded no
 * level-1 write-off anywhere on this table, and with multiball it recorded
 * fourteen, at (7,237), (19,225) and (8,236). Ball-to-ball on the upper level is
 * what puts a ball into the sliver.
 *
 * Below it the LOWER line is open and continuous — [8-19] at y=230 against the
 * upper line's [8-13] — which is what an apron discharging onto the playfield
 * looks like, so the gate is one-way downward at y=230. Its columns are 0..24
 * rather than the free run 8..13 because the whole point is to catch a ball in
 * contact with the converging walls rather than clear of them, and there is
 * nothing else on that row to catch: the ramp's own channel is at x >= 39 and is
 * untouched. Measured: level-1 write-offs on Law 'n Justice go from fourteen to
 * ZERO and completions stay at 90 of 90.
 *
 * It does not reduce the TOTAL, and that is stated here rather than buried.
 * Those balls now roll on down the far-left strip and end at (8,388) instead.
 * That strip is a genuine sealed pocket on the shipped lower line and closing it
 * needs something this pass did not find; see `BALL_SEARCH_TICKS` in
 * `game-loop.ts` for what is known about it.
 */
export const LEVEL_GATES_BY_TABLE: Readonly<Record<TableId, readonly LevelGate[]>> = Object.freeze({
  "law-n-justice": Object.freeze([
    Object.freeze({
      id: "lane-mouth",
      minX: 321,
      maxX: 324,
      y: 152,
      whenRising: 1 as const,
      whenFalling: 0 as const,
    }),
    Object.freeze({
      id: "ramp-end",
      minX: 34,
      maxX: 36,
      y: 207,
      whenRising: null,
      whenFalling: 0 as const,
    }),
    Object.freeze({
      id: "left-apron",
      minX: 0,
      maxX: 24,
      y: 230,
      whenRising: null,
      whenFalling: 0 as const,
    }),
  ]),
  babewatch: Object.freeze([
    Object.freeze({
      id: "lane-mouth",
      minX: 321,
      maxX: 323,
      y: 432,
      whenRising: 1 as const,
      whenFalling: 0 as const,
    }),
    Object.freeze({
      id: "lane-upper",
      minX: 321,
      maxX: 323,
      y: 311,
      whenRising: null,
      whenFalling: 0 as const,
    }),
    Object.freeze({
      id: "ramp-end",
      minX: 290,
      maxX: 300,
      y: 276,
      whenRising: 0 as const,
      whenFalling: null,
    }),
    Object.freeze({
      id: "spinner-lane",
      minX: 88,
      maxX: 92,
      y: 155,
      whenRising: 0 as const,
      whenFalling: 1 as const,
    }),
    Object.freeze({
      id: "habitrail-inlane",
      minX: 36,
      maxX: 38,
      y: 452,
      whenRising: null,
      whenFalling: 0 as const,
    }),
  ]),
  "extreme-sports": Object.freeze([
    Object.freeze({
      id: "lane-mouth",
      minX: 322,
      maxX: 324,
      y: 443,
      whenRising: 1 as const,
      whenFalling: 0 as const,
    }),
    Object.freeze({
      id: "lane-upper",
      minX: 322,
      maxX: 324,
      y: 188,
      whenRising: 0 as const,
      whenFalling: 1 as const,
    }),
    Object.freeze({
      id: "left-orbit",
      minX: 42,
      maxX: 53,
      y: 136,
      whenRising: null,
      whenFalling: 1 as const,
    }),
    Object.freeze({
      id: "left-orbit-exit",
      minX: 49,
      maxX: 56,
      y: 181,
      whenRising: null,
      whenFalling: 0 as const,
    }),
    // The crown mouth is twenty-eight rows, not one. Its bottom row IS the
    // former single `crown-mouth` gate, columns unchanged; see crownMouthGates.
    ...crownMouthGates(),
    Object.freeze({
      id: "crown-end",
      minX: 274,
      maxX: 276,
      y: 349,
      whenRising: 1 as const,
      whenFalling: 0 as const,
    }),
  ]),
});

export function levelGatesFor(tableId: TableId): readonly LevelGate[] {
  return LEVEL_GATES_BY_TABLE[tableId];
}


/**
 * The column the straight path from (`fromX`, `fromY`) to (`toX`, `toY`) is at
 * when it passes row `atY`, in whole pixels.
 *
 * A gate is a LINE the ball crosses, so the column that matters is the one at
 * the crossing, not the one the ball happened to finish the tick in. Sampling
 * the end column made a fast diagonal miss a gate it plainly went through: on
 * Extreme Sports' crown ramp the mouth is two columns wide at its lowest row and
 * a ball rolling down the arc at 7 px a tick steps from (255,155) to (262,161)
 * in one go, crossing y=158 at x=258 — inside the mouth — while finishing at
 * x=262, outside it. Nothing else about the model is sub-tick, but this is a
 * threshold test on a path, and the path is a straight line the integrator
 * already committed to.
 *
 * Integer throughout and exact when the span divides; the truncation is toward
 * zero on the offset, which is the same rounding the sweep uses.
 */
function columnAtRow(fromX: number, fromY: number, toX: number, toY: number, atY: number): number {
  const rows = toY - fromY;
  if (rows === 0) return toX;
  return fromX + Math.trunc(((toX - fromX) * (atY - fromY)) / rows);
}

/**
 * The level a ball is on after moving from (`fromX`, `fromY`) to (`toX`, `toY`),
 * all in whole pixels.
 *
 * The gate row belongs to "below", so `fromY === gate.y` still counts as a
 * rising crossing. Getting that wrong loses the crossing entirely for a ball
 * that happens to end a tick exactly on the line, and it then never fires
 * again — the next tick starts above it.
 *
 * Gates are evaluated in declaration order and the last one that fires wins, so
 * the table above is read top to bottom and nothing depends on object key
 * iteration.
 */
export function levelAfterCrossing(
  gates: readonly LevelGate[],
  level: PlayfieldLevel,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): PlayfieldLevel {
  let result = level;
  for (const gate of gates) {
    const rising = fromY >= gate.y && toY < gate.y;
    const falling = fromY < gate.y && toY >= gate.y;
    if (!rising && !falling) continue;
    const x = columnAtRow(fromX, fromY, toX, toY, gate.y);
    if (x < gate.minX || x > gate.maxX) continue;
    if (rising) {
      if (gate.whenRising !== null) result = gate.whenRising;
    } else if (gate.whenFalling !== null) {
      result = gate.whenFalling;
    }
  }
  return result;
}
