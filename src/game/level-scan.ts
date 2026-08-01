/**
 * Reading hand-offs off a map instead of asserting them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `playfield-levels.ts` holds a table of gates: rows where a ball moves between
 * the lower collision line and the upper one. Those rows started life as Law 'n
 * Justice's shooter lane written out longhand, and when the same three numbers
 * were pointed at BabeWatch and Extreme Sports they did nothing — a hand-tuned
 * threshold is not a model, it is one table's answer.
 *
 * This module is the model. It computes, from a decoded map and nothing else,
 * the two things a hand-off needs:
 *
 *   - the BAND: rows over which the two collision lines are indistinguishable to
 *     the ball, so that switching between them cannot change the trajectory;
 *   - the DIRECTION: which line still carries the channel beyond the band, so
 *     the ball goes onto the one that continues.
 *
 * Nothing here runs during play. The per-table gate table is a frozen constant
 * so the tick costs nothing, and `tests/level-scan.test.ts` re-derives it from
 * the three shipped maps on every run. That keeps the constants checkably
 * derived: if a map is re-exported and a band moves, a test fails rather than a
 * ball vanishing into a wall.
 *
 * ---------------------------------------------------------------------------
 * WHAT "INDISTINGUISHABLE" MEANS HERE
 * ---------------------------------------------------------------------------
 * The strongest possible test would compare the whole probe ring on both views
 * at every candidate centre. The test this module actually uses — the free
 * ball-centre RUN through the lane column is the same on both lines — is
 * weaker, and deliberately so: it is what a channel is, it is stable under the
 * one-pixel differences between how the two lines draw the same rail, and it is
 * checkable by eye against the row dumps in `playfield-levels.ts`. The stronger
 * ring test is available as `sameRingReading` and the tests use it to confirm
 * that the bands this module finds really are neutral at the gate rows.
 */

import type { MaterialTable, TableId, TableMap } from "./contracts.js";
import {
  BALL_RADIUS_PIXELS,
  DEFAULT_PROBE_RADIUS,
  numberAt,
  passabilityOf,
  ringOffsetsFor,
} from "./collision-probe.js";
import { upperLevelViewFor } from "./playfield-levels.js";
import type { PlayfieldLevel } from "./contracts.js";

/**
 * Widest free-centre run still counted as a channel rather than open playfield.
 *
 * Twelve centres is a 28 px lane for a 16 px ball: wide enough to cover every
 * shooter lane on the three tables (Law 'n Justice's is four centres across,
 * BabeWatch's three, Extreme Sports' three) and every ramp channel measured on
 * them (the widest, Extreme Sports' left orbit, is eight), and narrow enough
 * that the open bowl at the top of a table — hundreds of centres wide — is never
 * mistaken for one. It is a classifier threshold, not a physical constant;
 * `channelRunAt` takes it as a parameter so a caller can say what it means.
 */
export const CHANNEL_WIDTH_LIMIT = 12;

/** A closed interval of columns. */
export interface Run {
  readonly from: number;
  readonly to: number;
}

export function runWidth(run: Run): number {
  return run.to - run.from + 1;
}

export function sameRun(a: Run | null, b: Run | null): boolean {
  return a !== null && b !== null && a.from === b.from && a.to === b.to;
}

/**
 * Both level views of one map, with the passability table hoisted out.
 *
 * The lower view is the RAW map, not `playfieldViewFor`'s virtual-top-wall
 * version. That is on purpose and it is the one place this module could be
 * misused: the scan answers questions about authored geometry, and a virtual
 * wall is a correction bolted on top of it. Every band this module is asked
 * about is hundreds of rows below any table's wall, so the two agree there
 * anyway; asking about rows 0..26 of Law 'n Justice would not be meaningful.
 */
export interface LevelViews {
  readonly map: TableMap;
  readonly lower: TableMap;
  readonly upper: TableMap;
  readonly passable: readonly boolean[];
}

export function levelViewsOf(map: TableMap, materials: MaterialTable): LevelViews {
  return {
    map,
    lower: map,
    upper: upperLevelViewFor(map),
    passable: passabilityOf(materials),
  };
}

function viewFor(views: LevelViews, level: PlayfieldLevel): TableMap {
  return level === 1 ? views.upper : views.lower;
}

/**
 * True when a ball centred here touches nothing on this level.
 *
 * The same ring the simulation collides with, sampled the same way, including
 * the rule that points below the bottom row are open — that row is the drain,
 * not a floor. Off the left, right and top the map answers with its border
 * material, which is solid, so the edge of the world contains the ball.
 */
export function freeCentre(
  views: LevelViews,
  level: PlayfieldLevel,
  x: number,
  y: number,
): boolean {
  const view = viewFor(views, level);
  const ring = ringOffsetsFor(DEFAULT_PROBE_RADIUS);
  for (let i = 0; i < ring.size; i += 1) {
    const py = y + numberAt(ring.dy, i);
    if (py >= view.height) continue;
    if (!views.passable[view.materialAt(x + numberAt(ring.dx, i), py)]) return false;
  }
  return true;
}

/**
 * The maximal run of free ball centres through (x, y) on one level, or null if
 * the ball cannot stand there at all.
 *
 * `limit` caps how wide a run may be and still be reported: past it the run is
 * open playfield rather than a channel, and the scan says so by answering null.
 * Widening the search is bounded by the map, so this cannot walk off the end.
 */
export function channelRunAt(
  views: LevelViews,
  level: PlayfieldLevel,
  x: number,
  y: number,
  limit: number = CHANNEL_WIDTH_LIMIT,
): Run | null {
  if (!freeCentre(views, level, x, y)) return null;
  let from = x;
  while (from > 0 && freeCentre(views, level, from - 1, y)) {
    from -= 1;
    if (x - from > limit) return null;
  }
  let to = x;
  while (to < views.map.width - 1 && freeCentre(views, level, to + 1, y)) {
    to += 1;
    if (to - from > limit) return null;
  }
  return { from, to };
}

/**
 * Whether the probe ring reads the same on both levels at this centre.
 *
 * The strict form of "the ball cannot tell which level it is on": every one of
 * the ring's points is passable on both views or solid on both. A gate row that
 * passes this cannot change a trajectory no matter which side of it the switch
 * lands on, which is what makes the choice of row inside a band free.
 */
export function sameRingReading(views: LevelViews, x: number, y: number): boolean {
  const ring = ringOffsetsFor(DEFAULT_PROBE_RADIUS);
  for (let i = 0; i < ring.size; i += 1) {
    const py = y + numberAt(ring.dy, i);
    if (py >= views.map.height) continue;
    const px = x + numberAt(ring.dx, i);
    const lower = views.passable[views.lower.materialAt(px, py)];
    const upper = views.passable[views.upper.materialAt(px, py)];
    if (lower !== upper) return false;
  }
  return true;
}

/** A run of rows over which the two levels carry the same channel. */
export interface HandoffBand {
  readonly topY: number;
  readonly bottomY: number;
  /** The shared free-centre run, which is identical on both levels by definition. */
  readonly run: Run;
}

export function bandCentreY(band: HandoffBand): number {
  return (band.topY + band.bottomY) >> 1;
}

/**
 * Every hand-off band down one column, ordered from the top of the map.
 *
 * A band is a maximal run of rows where both levels have a channel through `x`
 * and the two channels are the same run. Bands separated by fewer than
 * `bridgeRows` rows are merged: a single row where one line's rail steps a pixel
 * sideways is a drawing artefact of a 1-px outline, not a break in the hand-off.
 * Three is a quarter of a ball diameter — small enough that nothing joins two
 * genuinely different bands (the closest pair on any of the three tables is
 * Extreme Sports' 408..430 and 432..479, one row apart, which are plainly one
 * band, and the next closest gap anywhere is 44 rows).
 */
export function handoffBandsAlong(
  views: LevelViews,
  x: number,
  bridgeRows = 3,
  limit: number = CHANNEL_WIDTH_LIMIT,
): HandoffBand[] {
  const shared: (Run | null)[] = [];
  for (let y = 0; y < views.map.height; y += 1) {
    const lower = channelRunAt(views, 0, x, y, limit);
    const upper = channelRunAt(views, 1, x, y, limit);
    shared.push(sameRun(lower, upper) ? lower : null);
  }

  const bands: HandoffBand[] = [];
  let y = 0;
  while (y < shared.length) {
    const run = shared[y];
    if (run === undefined || run === null) {
      y += 1;
      continue;
    }
    let end = y;
    let gap = 0;
    for (let probe = y + 1; probe < shared.length; probe += 1) {
      if (shared[probe] !== null && shared[probe] !== undefined) {
        end = probe;
        gap = 0;
      } else if (++gap > bridgeRows) {
        break;
      }
    }
    bands.push({ topY: y, bottomY: end, run });
    y = end + 1;
  }
  return bands;
}

/**
 * How far a level's channel reaches away from a band, FOLLOWING it.
 *
 * `step` is -1 to look up the table and +1 to look down. The answer is the
 * number of consecutive rows over which that level still has a channel — so a
 * line whose lane has ended, or has opened out into playfield, answers 0 or near
 * it, and one that carries on answers a lot.
 *
 * The column is followed rather than held, because every lane on these three
 * tables curves: Law 'n Justice's bends left into the top arch, BabeWatch's
 * sweeps forty degrees left above y=400, Extreme Sports' curves left over its
 * crown. Holding the column measures "how far until the lane bends", which on
 * Law 'n Justice is thirteen rows for a ramp that carries the ball two hundred
 * more. The channel is allowed to shift by up to `drift` columns per row, which
 * is what a rail drawn as a 1-px staircase does.
 */
export function channelReachBeyond(
  views: LevelViews,
  level: PlayfieldLevel,
  x: number,
  fromY: number,
  step: -1 | 1,
  limit: number = CHANNEL_WIDTH_LIMIT,
  drift = 2,
): number {
  let centre = x;
  let rows = 0;
  for (let y = fromY + step; y >= 0 && y < views.map.height; y += step) {
    let run: Run | null = null;
    for (let offset = 0; offset <= drift && run === null; offset += 1) {
      run =
        channelRunAt(views, level, centre - offset, y, limit) ??
        channelRunAt(views, level, centre + offset, y, limit);
    }
    if (run === null) break;
    centre = (run.from + run.to) >> 1;
    rows += 1;
  }
  return rows;
}

/**
 * The level a ball crossing this band in this direction should end up on, or
 * null when the band is not a hand-off at all.
 *
 * "Continues" is deliberately a wide margin rather than a hair: one line must
 * reach at least a ball diameter further than the other before the band is
 * called a hand-off. Below that the two are drawing the same wall with
 * different rounding and there is nothing to hand over.
 */
export function handoffDirection(
  views: LevelViews,
  band: HandoffBand,
  x: number,
  step: -1 | 1,
  limit: number = CHANNEL_WIDTH_LIMIT,
): PlayfieldLevel | null {
  const edge = step === -1 ? band.topY : band.bottomY;
  const lower = channelReachBeyond(views, 0, x, edge, step, limit);
  const upper = channelReachBeyond(views, 1, x, edge, step, limit);
  const margin = 2 * BALL_RADIUS_PIXELS;
  if (lower >= upper + margin) return 0;
  if (upper >= lower + margin) return 1;
  return null;
}

/** Everything the scan has to say about one table's shooter lane. */
export interface LaneScan {
  readonly tableId: TableId;
  readonly laneX: number;
  readonly bands: readonly HandoffBand[];
}

export function scanShooterLane(
  map: TableMap,
  materials: MaterialTable,
  laneX: number,
): LaneScan {
  const views = levelViewsOf(map, materials);
  return { tableId: map.tableId, laneX, bands: handoffBandsAlong(views, laneX) };
}
