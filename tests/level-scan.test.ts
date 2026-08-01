/**
 * Are the hand-offs actually derived, or just asserted?
 *
 * `LEVEL_GATES_BY_TABLE` is a frozen constant so the tick costs nothing, but
 * every row in it is supposed to be READ OFF the shipped map by the rule in
 * `level-scan.ts`. This file is what makes that claim checkable: it re-runs the
 * derivation against all three maps and asserts the shipped gates are what it
 * produces. If a map is ever re-exported and a band moves, this fails — which is
 * the point, because the alternative is a ball quietly vanishing into a wall.
 *
 * It also pins the measurements behind the three gates the band rule CANNOT
 * produce (two ramp mouths and Law 'n Justice's inferred arch exit), so those
 * stay honest numbers with a stated source rather than tuning.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TableId, TableMap, TableMapDocument } from "../src/game/contracts.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { materialTableFor } from "../src/game/materials.js";
import {
  CROWN_MOUTH_BOTTOM_Y,
  CROWN_MOUTH_TOP_Y,
  crownMouthLeftColumn,
  levelGatesFor,
} from "../src/game/playfield-levels.js";
import type { LevelGate } from "../src/game/playfield-levels.js";
import { shooterLaneFor } from "../src/game/plunger.js";
import {
  bandCentreY,
  channelReachBeyond,
  channelRunAt,
  freeCentre,
  handoffBandsAlong,
  handoffDirection,
  levelViewsOf,
  runWidth,
  sameRingReading,
} from "../src/game/level-scan.js";
import type { HandoffBand, LevelViews } from "../src/game/level-scan.js";

function mapFor(tableId: TableId): TableMap {
  return parseTableMapDocument(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../public/generated/tables/${tableId}.map.json`, import.meta.url)),
        "utf8",
      ),
    ) as TableMapDocument,
  );
}

const VIEWS: Record<TableId, LevelViews> = {
  "law-n-justice": levelViewsOf(mapFor("law-n-justice"), materialTableFor("law-n-justice")),
  babewatch: levelViewsOf(mapFor("babewatch"), materialTableFor("babewatch")),
  "extreme-sports": levelViewsOf(mapFor("extreme-sports"), materialTableFor("extreme-sports")),
};

/** The lane's centre column, the same one the plunger serves into. */
function laneColumnOf(tableId: TableId): number {
  const lane = shooterLaneFor(tableId);
  return (lane.minCentreX + lane.maxCentreX) >> 1;
}

function gateOf(tableId: TableId, id: string): LevelGate {
  const found = levelGatesFor(tableId).find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`${tableId} has no gate ${id}`);
  return found;
}

/**
 * The maximal free ball-centre run on one line inside a column window, or null.
 *
 * A window rather than the whole row, because every measurement below is about
 * ONE channel and a row of a pinball table has several. Deliberately not
 * `channelRunAt`: that one takes a point and refuses runs wider than a channel,
 * and these assertions want the run whatever its width so a re-export that
 * widens one shows up as a failure rather than as a null.
 */
function runOf(
  views: LevelViews,
  level: 0 | 1,
  y: number,
  fromX: number,
  toX: number,
): { readonly from: number; readonly to: number } | null {
  let from: number | null = null;
  let to = -1;
  for (let x = fromX; x <= toX; x += 1) {
    if (!freeCentre(views, level, x, y)) {
      if (from !== null) break;
      continue;
    }
    if (from === null) from = x;
    to = x;
  }
  return from === null ? null : { from, to };
}

function bandContaining(bands: readonly HandoffBand[], y: number): HandoffBand {
  const found = bands.find((band) => y >= band.topY && y <= band.bottomY);
  if (found === undefined) {
    throw new Error(`no band contains row ${y}; found ${JSON.stringify(bands)}`);
  }
  return found;
}

describe("the scan itself", () => {
  it("finds the band Law 'n Justice's model was built on by hand", () => {
    // The 49-row overlap written out in `playfield-levels.ts` from the raw row
    // dumps. The scan sees the same thing without being told about it.
    // 322, not 290: the shipped maps were re-exported on the correct 32 px
    // frame. The BAND is unchanged — 127..177, exactly as before — which is the
    // check, because a horizontal reframe cannot move a row.
    const bands = handoffBandsAlong(VIEWS["law-n-justice"], 322);
    expect(bands).toHaveLength(1);
    expect(bands[0]?.topY).toBe(127);
    expect(bands[0]?.bottomY).toBe(177);
    expect(bands[0]?.run).toEqual({ from: 321, to: 324 });
  });

  it("calls open playfield open, not a channel", () => {
    // The classifier that stops the bowl at the top of a table being read as a
    // lane. Extreme Sports' row 8 is free from x=8 to x=327 on the lower line.
    const views = VIEWS["extreme-sports"];
    expect(freeCentre(views, 0, 160, 8)).toBe(true);
    expect(channelRunAt(views, 0, 160, 8)).toBeNull();
    // While the seat of the lane on the same table is three centres across.
    const lane = channelRunAt(views, 0, 323, 548);
    expect(lane).toEqual({ from: 322, to: 324 });
    expect(lane === null ? 99 : runWidth(lane)).toBe(3);
  });

  it("reports a band only where the two lines carry the SAME run", () => {
    // Not merely "both free": below Law 'n Justice's band both lines are free at
    // the lane column, but the upper one has no lane walls there at all, so its
    // run is the width of the table and the rows are not a hand-off.
    const views = VIEWS["law-n-justice"];
    expect(freeCentre(views, 0, 322, 300)).toBe(true);
    expect(freeCentre(views, 1, 322, 300)).toBe(true);
    expect(handoffBandsAlong(views, 322).some((band) => band.topY <= 300 && band.bottomY >= 300))
      .toBe(false);
  });
});

describe("every lane gate is the scan's own answer", () => {
  const cases: readonly (readonly [TableId, string])[] = [
    ["law-n-justice", "lane-mouth"],
    ["babewatch", "lane-mouth"],
    ["babewatch", "lane-upper"],
    ["extreme-sports", "lane-mouth"],
    ["extreme-sports", "lane-upper"],
  ];

  for (const [tableId, id] of cases) {
    it(`${tableId} / ${id} sits at the centre of a derived band, pointing where the scan says`, () => {
      const views = VIEWS[tableId];
      const laneX = laneColumnOf(tableId);
      const gate = gateOf(tableId, id);
      const band = bandContaining(handoffBandsAlong(views, laneX), gate.y);

      // The row is not chosen: it is the middle of the band the scan found.
      expect(bandCentreY(band)).toBe(gate.y);

      // The columns are the band's own free-centre run, so the gate covers
      // exactly where a ball in the lane can be and nowhere else.
      expect(gate.minX).toBe(band.run.from);
      expect(gate.maxX).toBe(band.run.to);

      // And the directions are the scan's, not a preference.
      expect(gate.whenRising).toBe(handoffDirection(views, band, laneX, -1));
      if (id === "lane-mouth" && gate.whenFalling === 0) {
        // The one arm the band rule cannot settle on its own is the lowest
        // band's falling direction, because below it the upper line has no lane
        // at all — its "reach" is short for the same reason a wall is short.
        // The ball is SERVED on the lower line at the bottom of this lane, so
        // coming back down it must arrive on the lower line or it would fall
        // through the lane walls. That is the serve, not a guess.
        expect(channelReachBeyond(views, 0, laneX, band.bottomY, 1)).toBeGreaterThan(
          channelReachBeyond(views, 1, laneX, band.bottomY, 1),
        );
      } else {
        expect(gate.whenFalling).toBe(handoffDirection(views, band, laneX, 1));
      }
    });

    it(`${tableId} / ${id} sits where the ball cannot tell the two levels apart`, () => {
      // The strict form: every point of the probe ring reads the same on both
      // views, across the whole width of the gate. This is what makes the choice
      // of row inside the band free — and it is why moving Extreme Sports'
      // upper gate anywhere in 139..238 leaves the trajectory byte-identical.
      const views = VIEWS[tableId];
      const gate = gateOf(tableId, id);
      for (let x = gate.minX; x <= gate.maxX; x += 1) {
        for (const y of [gate.y - 1, gate.y, gate.y + 1]) {
          expect(sameRingReading(views, x, y), `${tableId}/${id} at (${x},${y})`).toBe(true);
        }
      }
    });
  }
});

describe("Extreme Sports' left orbit", () => {
  const views = VIEWS["extreme-sports"];

  it("exits through a band the scan finds on the orbit's own column", () => {
    const gate = gateOf("extreme-sports", "left-orbit-exit");
    const band = bandContaining(handoffBandsAlong(views, 52), gate.y);
    expect(bandCentreY(band)).toBe(gate.y);
    expect(gate.minX).toBe(band.run.from);
    expect(gate.maxX).toBe(band.run.to);
    expect(gate.whenFalling).toBe(handoffDirection(views, band, 52, 1));
    expect(gate.whenFalling).toBe(0);
  });

  it("enters where the upper-line channel begins inside open lower-line space", () => {
    // The band rule cannot produce this one: the two channels are side by side
    // rather than on top of each other, so no row has the same run on both. What
    // fixes it instead is a RAMP MOUTH — the row where the upper channel starts,
    // at a column the lower line is open at.
    const gate = gateOf("extreme-sports", "left-orbit");

    // The upper channel begins at y=132 and runs down; there is nothing above.
    expect(channelRunAt(views, 1, 49, 130)).toBeNull();
    expect(channelRunAt(views, 1, 49, 132)).not.toBeNull();
    expect(channelRunAt(views, 1, 49, 150)).not.toBeNull();

    // The mouth is inside the lower line's funnel, so a ball rolling down it is
    // physically at the ramp's entrance rather than being teleported to one.
    expect(freeCentre(views, 0, 49, gate.y)).toBe(true);
    expect(gate.minX).toBeLessThanOrEqual(49);
    expect(gate.maxX).toBeGreaterThanOrEqual(50);
    expect(gate.y).toBeGreaterThanOrEqual(132);
    expect(gate.y).toBeLessThanOrEqual(138);

    // And the lower line really does run out below it, which is why the ramp is
    // the only way on: the funnel's free centres are [37-41] at y=150, [35-35] at
    // y=161 and NOTHING at y=162. (x=56..64 at that row is the proper orbit lane
    // on the OTHER side of the rail, which is the whole problem: a ball on this
    // side of it can no longer get there.)
    //
    // Re-measured on the corrected 32 px frame. The old numbers said the funnel
    // died at y=153; it dies at y=162. Those nine rows were hidden because the
    // misframed bitmap cut the funnel's left tail off at column 0.
    expect(freeCentre(views, 0, 40, 150)).toBe(true);
    expect(freeCentre(views, 0, 35, 161)).toBe(true);
    for (let x = 30; x <= 55; x += 1) expect(freeCentre(views, 0, x, 162)).toBe(false);
  });
});

describe("Extreme Sports' crown ramp", () => {
  const views = VIEWS["extreme-sports"];

  it("has a lower line that genuinely dead-ends at the corner balls used to die in", () => {
    // The single pixel this table's whole false 30-in-30 was built on. Every
    // ball ended at (302,163) and none of them ever drained; the ball search
    // retired them and the game called that a completion. On the corrected 32 px
    // frame the cup is still there, still exactly one pixel, 32 columns right of
    // where the misframed export put it — so it was never a framing artefact.
    expect(freeCentre(views, 0, 302, 162)).toBe(true);
    for (let y = 163; y <= 178; y += 1) {
      expect(freeCentre(views, 0, 302, y), `lower line free at (302,${y})`).toBe(false);
      expect(freeCentre(views, 1, 302, y), `upper line free at (302,${y})`).toBe(false);
    }
    // The wedge really does close from the left as it descends, which is what
    // makes it a cup rather than a corner a ball can roll back out of.
    const leftEdgeAt = (y: number): number => {
      for (let x = 257; x <= 307; x += 1) if (freeCentre(views, 0, x, y)) return x;
      return -1;
    };
    expect(leftEdgeAt(150)).toBe(266);
    expect(leftEdgeAt(155)).toBe(281);
    expect(leftEdgeAt(158)).toBe(290);
    expect(leftEdgeAt(162)).toBe(302);
    expect(leftEdgeAt(163)).toBe(-1);
  });

  it("enters the wireform anywhere between its rails, because that is where the ball is", () => {
    // THIS TEST USED TO REQUIRE EVERY COLUMN OF `crown-mouth` TO BE FREE ON BOTH
    // LINES, then to be the free-centre run plus the one contact column beside
    // it. Both premises were falsified by trajectory data, and the second is the
    // one this work replaced.
    //
    // WHY THE FREE-CENTRE RUN IS THE WRONG SET. A free CENTRE is a place a ball
    // sits clear of everything. A ball ROLLING ON the arc's convex face is not
    // clear of it - it is resting on it - so its centre lies outside that set by
    // however far it sinks into the surface, which here is two to three columns,
    // not one. Traced tick by tick down the face from (280,150) with the game's
    // own integrator, the ball crosses row 155 at x=281.9, row 157 at x=285.0
    // and row 158 at x=287.8. A gate cut to [289-291] on row 158 catches none of
    // those, and the ball rolls on into the (302,163) cup.
    //
    // The set that IS right is the ramp's interior: the ball is on the wireform
    // when it is between the wireform's two rails. That is checked row by row in
    // the companion test below; here is the row the old gate was on.
    const gate = gateOf("extreme-sports", "crown-mouth-158");
    expect(gate.y).toBe(158);

    // 1. The gate still contains everything the old one did - the columns free
    //    on both lines at its row, and the contact column beside them.
    const bothAt = (y: number): number[] => {
      const columns: number[] = [];
      for (let x = 270; x <= 310; x += 1) {
        if (freeCentre(views, 0, x, y) && freeCentre(views, 1, x, y)) columns.push(x);
      }
      return columns;
    };
    expect(bothAt(gate.y)).toEqual([290, 291]);
    for (const x of [289, ...bothAt(gate.y)]) {
      expect(x).toBeGreaterThanOrEqual(gate.minX);
      expect(x).toBeLessThanOrEqual(gate.maxX);
    }

    // 2. And it reaches back to where a ball rolling on the wedge's floor
    //    actually is. The floor's own free-centre edge on this row is 290; the
    //    traced ball crosses the row at 287.
    const lowerLeftEdge = (y: number): number => {
      for (let x = 257; x <= 307; x += 1) if (freeCentre(views, 0, x, y)) return x;
      return -1;
    };
    expect(lowerLeftEdge(gate.y)).toBe(290);
    expect(gate.minX).toBeLessThanOrEqual(287);

    // 3. Every column of the gate is inside the wireform on the DESTINATION
    //    line - not necessarily a free centre, but never in a rail, so the
    //    hand-off puts the ball in the tube and the contact model slides it into
    //    the channel. This is the check that makes the widening safe.
    for (let x = gate.minX; x <= gate.maxX; x += 1) {
      expect(
        views.passable[views.upper.materialAt(x, gate.y)],
        `inside the wireform at (${x},${gate.y})`,
      ).toBe(true);
    }
    expect(gate.whenFalling).toBe(1);

    // 4. The upper line really is a channel there, not open space,
    expect(channelRunAt(views, 1, 289, gate.y)).not.toBeNull();
    // which carries on down while the lower line has already stopped.
    expect(channelReachBeyond(views, 1, 289, gate.y, 1)).toBeGreaterThan(100);
    expect(channelReachBeyond(views, 0, 289, gate.y, 1)).toBeLessThan(8);
  });

  it("opens onto the wireform for its whole run through the wedge, not just its last row", () => {
    // THE SECOND OF THE TWO DETERMINISTIC TRAPS. One gate at y=158 can only
    // catch a ball that crosses row 158, and the wedge is open at the top: a
    // ball that DROPS into it anywhere right of the mouth lands below that row
    // and never crosses it at all. The wedge is a closed cup - its free
    // lower-line centres shrink to the single centre (302,162) and vanish at
    // y=163 - so every one of those balls is lost for the rest of the game.
    //
    // The mouth is the whole run of the wireform through the wedge, and the
    // wireform is a tube of constant width: on every row of the band the upper
    // line's rails are exactly 21 ball-centre columns apart.
    const gates = levelGatesFor("extreme-sports").filter((one) => one.id.startsWith("crown-mouth"));
    expect(gates).toHaveLength(CROWN_MOUTH_BOTTOM_Y - CROWN_MOUTH_TOP_Y + 1);

    // The wireform is the RIGHTMOST upper-line channel in the wedge: a second
    // one, the crown's own inner rail, runs down the left of the same window
    // (x=279..280 at y=131), so the run is taken from the right rather than
    // over the whole window.
    const upperRunAt = (y: number): number[] => {
      const columns: number[] = [];
      for (let x = 312; x >= 270; x -= 1) {
        if (freeCentre(views, 1, x, y)) columns.unshift(x);
        else if (columns.length > 0) break;
      }
      return columns;
    };
    /** The maximal run of columns whose centre pixel is inside the wireform. */
    const tubeAt = (y: number): readonly [number, number] => {
      const seed = upperRunAt(y)[0] ?? -1;
      let left = seed;
      let right = seed;
      while (left > 0 && views.passable[views.upper.materialAt(left - 1, y)]) left -= 1;
      while (right < views.map.width - 1 && views.passable[views.upper.materialAt(right + 1, y)]) {
        right += 1;
      }
      return [left, right];
    };

    const lane = shooterLaneFor("extreme-sports");
    for (const gate of gates) {
      const y = gate.y;
      expect(y).toBeGreaterThanOrEqual(CROWN_MOUTH_TOP_Y);
      expect(y).toBeLessThanOrEqual(CROWN_MOUTH_BOTTOM_Y);

      // 1. The wireform's own free-centre run on this row, read off the shipped
      //    map, is three columns wide and the module's straight-line formula
      //    reproduces its left column exactly. No fit, no residual.
      const run = upperRunAt(y);
      expect(run, `wireform run at y=${y}`).toHaveLength(3);
      expect(crownMouthLeftColumn(y), `formula left column at y=${y}`).toBe(run[0]);

      // 2. The gate is the tube the run sits in - the 21 columns between the
      //    ramp's two rails - so a ball anywhere across the ramp's width is
      //    handed to it, and no column of the gate is inside a rail.
      expect([gate.minX, gate.maxX], `gate columns at y=${y}`).toEqual(tubeAt(y));
      expect(gate.maxX - gate.minX + 1, `tube width at y=${y}`).toBe(21);

      // 3. The gate overlaps lower-line space a ball can actually occupy, so
      //    every row of the mouth is reachable rather than decorative. The test
      //    is the centre PIXEL rather than a free centre, because the ball this
      //    band exists for is rolling on the wedge's floor and is therefore in
      //    contact with it: on the bottom four rows the floor has closed past
      //    the ramp and only contact positions are left.
      let reachable = 0;
      for (let x = gate.minX; x <= gate.maxX; x += 1) {
        if (views.passable[views.lower.materialAt(x, y)]) reachable += 1;
      }
      expect(reachable, `no reachable lower-line column in the mouth at y=${y}`).toBeGreaterThan(0);

      // 4. And it never reaches the shooter lane, which is the one other thing a
      //    lower-level ball can be doing at these rows.
      expect(gate.maxX, `mouth at y=${y} reaches the lane`).toBeLessThan(lane.minCentreX - 8);

      expect(gate.whenFalling).toBe(1);
      expect(gate.whenRising).toBeNull();
    }

    // 5. The band ends where the map says. Above the top row the wireform is no
    //    longer over playfield a ball can occupy - its leftmost free centre is
    //    303 and the wedge's rightmost is 302 - and below the bottom row the
    //    wedge has no free lower-line centre at all.
    expect(upperRunAt(CROWN_MOUTH_TOP_Y)[0]).toBe(302);
    expect(upperRunAt(CROWN_MOUTH_TOP_Y - 1)[0]).toBe(303);
    for (let x = 303; x <= 320; x += 1) {
      expect(freeCentre(views, 0, x, CROWN_MOUTH_TOP_Y), `wedge past 302 at y=131`).toBe(false);
    }
    expect(freeCentre(views, 0, 302, CROWN_MOUTH_TOP_Y)).toBe(true);
    // (From x=260 rightward: the crown's OTHER channel, the one between two of
    // its arcs, is still open at x=236..243 on that row and is a different
    // route with its own hand-off at `crown-end`.)
    for (let x = 260; x <= 320; x += 1) {
      expect(freeCentre(views, 0, x, CROWN_MOUTH_BOTTOM_Y + 1)).toBe(false);
    }
    expect(freeCentre(views, 0, 302, CROWN_MOUTH_BOTTOM_Y)).toBe(true);
  });

  it("leaves the wireform through a band the scan finds on its own column", () => {
    // The far end, and this one IS the band rule: at y=349..350 the two lines
    // carry byte-identical runs down the wireform's column, and below it only
    // the lower line continues — out to the playfield at y=414.
    const gate = gateOf("extreme-sports", "crown-end");
    const band = bandContaining(handoffBandsAlong(views, 275), gate.y);
    expect(bandCentreY(band)).toBe(gate.y);
    expect(gate.minX).toBe(band.run.from);
    expect(gate.maxX).toBe(band.run.to);
    expect(gate.whenRising).toBe(handoffDirection(views, band, 275, -1));
    expect(gate.whenFalling).toBe(handoffDirection(views, band, 275, 1));
    expect(gate.whenFalling).toBe(0);

    // The ball cannot tell the levels apart anywhere in the band. This one is
    // two rows deep rather than the fifty of a shooter lane, so the strict ring
    // test is asked of exactly those two and not of a row outside them.
    for (let x = gate.minX; x <= gate.maxX; x += 1) {
      for (let y = band.topY; y <= band.bottomY; y += 1) {
        expect(sameRingReading(views, x, y), `crown-end at (${x},${y})`).toBe(true);
      }
    }

    // And the upper line really does run out below, while the lower one opens
    // onto the playfield: without the second gate the write-offs simply move to
    // the closed bottom end of the wireform at (276,380).
    expect(freeCentre(views, 1, 275, 380)).toBe(true);
    for (let x = 272; x <= 278; x += 1) expect(freeCentre(views, 1, x, 381)).toBe(false);
    expect(freeCentre(views, 0, 275, 400)).toBe(true);
    expect(channelRunAt(views, 0, 232, 414)).toBeNull();
  });
});

describe("BabeWatch's ramp end", () => {
  const views = VIEWS["babewatch"];

  it("sits at the last row of the upper-line channel, over open lower-line space", () => {
    const gate = gateOf("babewatch", "ramp-end");

    // The wireform's last free ball centre is (296, 273): at y=270 the two rails
    // have closed to a 15 px gap, two pixels short of the ball.
    expect(freeCentre(views, 1, 296, 273)).toBe(true);
    expect(freeCentre(views, 1, 296, 270)).toBe(false);
    for (let x = 282; x <= 307; x += 1) expect(freeCentre(views, 1, x, 268)).toBe(false);

    // The lower line is open right there, so the ramp delivers onto the table.
    expect(freeCentre(views, 0, 294, 272)).toBe(true);

    // The gate is a few rows above the closed end and spans the channel.
    expect(gate.y).toBeGreaterThanOrEqual(273);
    expect(gate.y).toBeLessThanOrEqual(280);
    expect(gate.minX).toBeLessThanOrEqual(295);
    expect(gate.maxX).toBeGreaterThanOrEqual(297);
    expect(gate.whenRising).toBe(0);
    expect(gate.whenFalling).toBeNull();
  });
});

describe("Law 'n Justice's arch ramp ends where the wireform does", () => {
  // THIS REPLACES "the arch exit is still the one inferred number". There is no
  // inferred number left on this table. The old `arch-exit` gate sat at y=46
  // because the misframed export cut the ramp's outboard rail off at column 0
  // and the ramp appeared to stop there; on the corrected frame the channel runs
  // 160 rows further, down the left of the table, and ENDS the way BabeWatch's
  // wireform does — its inboard rail stops and the ball is on the playfield.
  const views = VIEWS["law-n-justice"];

  it("carries the ball 160 rows past the row the old gate was invented for", () => {
    // The channel the old gate released the ball from is still there at y=46,
    // and so is every row from there down to the ramp's real end.
    expect(freeCentre(views, 1, 71, 46)).toBe(true);
    expect(freeCentre(views, 1, 41, 80)).toBe(true);
    expect(freeCentre(views, 1, 36, 90)).toBe(true);
    expect(freeCentre(views, 1, 27, 120)).toBe(true);
    expect(freeCentre(views, 1, 26, 150)).toBe(true);
    expect(freeCentre(views, 1, 38, 200)).toBe(true);
    expect(freeCentre(views, 1, 35, 207)).toBe(true);
  });

  it("puts the gate on the last row the ramp can hand the ball over", () => {
    const gate = gateOf("law-n-justice", "ramp-end");
    expect(gate.whenRising).toBeNull();
    expect(gate.whenFalling).toBe(0);

    // Every column of the gate is free on BOTH lines, so the hand-off is
    // unobservable — the strict ring test, the same one the lane bands pass.
    for (let x = gate.minX; x <= gate.maxX; x += 1) {
      expect(freeCentre(views, 1, x, gate.y), `upper at (${x},${gate.y})`).toBe(true);
      expect(freeCentre(views, 0, x, gate.y), `lower at (${x},${gate.y})`).toBe(true);
      expect(sameRingReading(views, x, gate.y), `ring at (${x},${gate.y})`).toBe(true);
    }

    // One row lower the upper channel steps left off the lower line's free
    // space, so this is the last row it can be done on, not a preference.
    expect(freeCentre(views, 1, 33, gate.y + 1)).toBe(true);
    expect(freeCentre(views, 0, 33, gate.y + 1)).toBe(false);

    // And the ramp really does run out just below: three more rows of channel
    // and then it opens into the strip along the left edge.
    expect(channelReachBeyond(views, 1, gate.minX, gate.y, 1)).toBeLessThan(8);
    // while the lower line carries straight on toward the drain.
    expect(channelReachBeyond(views, 0, gate.minX, gate.y, 1)).toBeGreaterThan(
      channelReachBeyond(views, 1, gate.minX, gate.y, 1),
    );
  });
});

describe("babewatch's roulette-lane cup, and the wireform under it", () => {
  const views = VIEWS.babewatch;

  it("re-measures the cup the lower line closes on the ball", () => {
    // The site the census recorded as (91,167..174). It is not a shallow slope
    // and no drive would clear it: the WALLS converge, from a 9-column channel
    // at y=137 to a single free centre at y=158..162 and nothing at all at 163.
    expect(runOf(views, 0, 137, 80, 100)).toEqual({ from: 82, to: 90 });
    expect(runOf(views, 0, 151, 80, 100)).toEqual({ from: 89, to: 90 });
    expect(runOf(views, 0, 158, 80, 100)).toEqual({ from: 90, to: 90 });
    expect(runOf(views, 0, 162, 80, 100)).toEqual({ from: 90, to: 90 });
    expect(runOf(views, 0, 163, 80, 100)).toBeNull();
    // And the gap really is narrower than a ball where the ball ends up.
    for (let x = 84; x <= 98; x += 1) expect(freeCentre(views, 0, x, 171)).toBe(false);
  });

  it("opens the upper line's channel exactly where the lower one closes", () => {
    // Nothing on level 1 above y=152 in these columns, then it appears and
    // widens away downward without a break.
    expect(runOf(views, 1, 151, 80, 110)).toBeNull();
    expect(runOf(views, 1, 152, 80, 110)).toEqual({ from: 89, to: 89 });
    expect(runOf(views, 1, 158, 80, 110)?.from).toBe(90);
    expect(runOf(views, 1, 163, 80, 110)?.from).toBe(91);
    // Wider every row, which is what a ramp mouth looks like from inside.
    const at158 = runOf(views, 1, 158, 80, 130)!;
    const at170 = runOf(views, 1, 170, 80, 130)!;
    expect(at170.to - at170.from).toBeGreaterThan(at158.to - at158.from);
  });

  it("hands over on a row where the ball cannot tell the two lines apart", () => {
    const gate = gateOf("babewatch", "spinner-lane");
    expect(gate.whenFalling).toBe(1);
    expect(gate.whenRising).toBe(0);
    // The shared columns at the gate row, which the gate must contain.
    for (const x of [89, 90]) {
      expect(freeCentre(views, 0, x, gate.y), `lower at (${x},${gate.y})`).toBe(true);
      expect(freeCentre(views, 1, x, gate.y), `upper at (${x},${gate.y})`).toBe(true);
      expect(x).toBeGreaterThanOrEqual(gate.minX);
      expect(x).toBeLessThanOrEqual(gate.maxX);
    }
    // The gate is wider than the shared run on purpose, and every extra column
    // is safe in the falling direction because level 1 is the MORE open line
    // there: a hand-off can release a ball from a wall but never place it in one.
    for (let x = gate.minX; x <= gate.maxX; x += 1) {
      if (freeCentre(views, 0, x, gate.y)) {
        expect(freeCentre(views, 1, x, gate.y), `upper must be open at (${x},${gate.y})`).toBe(
          true,
        );
      }
    }
  });

  it("returns the habitrail to the inlane on a byte-identical band", () => {
    // The plain band rule. The upper line holds [36-38] for nine rows straight
    // and the lower line covers it on every one of them, so the hand-off is
    // unobservable anywhere in the band; the gate row itself is byte-identical.
    const gate = gateOf("babewatch", "habitrail-inlane");
    expect(gate.whenFalling).toBe(0);
    expect(gate.whenRising).toBeNull();
    for (let y = 448; y <= 456; y += 1) {
      expect(runOf(views, 1, y, 30, 45), `upper row ${y}`).toEqual({ from: 36, to: 38 });
      const lower = runOf(views, 0, y, 30, 45);
      expect(lower?.from, `lower row ${y}`).toBeLessThanOrEqual(36);
      expect(lower?.to, `lower row ${y}`).toBeGreaterThanOrEqual(38);
    }
    expect(runOf(views, 0, gate.y, 30, 45), "the gate row itself").toEqual({ from: 36, to: 38 });
    expect(gate.y).toBeGreaterThanOrEqual(448);
    expect(gate.y).toBeLessThanOrEqual(456);
    expect(gate.minX).toBe(36);
    expect(gate.maxX).toBe(38);
    // The upper line stops just below; the lower one carries on into the inlane.
    expect(runOf(views, 1, 463, 30, 45)).not.toBeNull();
    expect(runOf(views, 1, 464, 30, 45)).toBeNull();
    expect(runOf(views, 0, 470, 30, 45)).not.toBeNull();
  });
});

describe("law-n-justice's left apron, which only multiball reaches", () => {
  const views = VIEWS["law-n-justice"];

  it("re-measures the upper-line teardrop that funnels down-left into nothing", () => {
    expect(runOf(views, 1, 214, 0, 32)).toEqual({ from: 8, to: 29 });
    expect(runOf(views, 1, 225, 0, 32)).toEqual({ from: 8, to: 18 });
    expect(runOf(views, 1, 230, 0, 32)).toEqual({ from: 8, to: 13 });
    expect(runOf(views, 1, 235, 0, 32)).toEqual({ from: 8, to: 8 });
    expect(runOf(views, 1, 236, 0, 32)).toBeNull();
    // Its right edge closes on its left one, so the floor leads into the corner.
  });

  it("hands the ball down onto the lower line, which is open underneath", () => {
    const gate = gateOf("law-n-justice", "left-apron");
    expect(gate.whenFalling).toBe(0);
    expect(gate.whenRising).toBeNull();
    // Everything the upper line still has at the gate row is open on the lower
    // one, so the hand-off cannot put a ball in a wall.
    const upper = runOf(views, 1, gate.y, 0, 32)!;
    const lower = runOf(views, 0, gate.y, 0, 32)!;
    expect(lower.from).toBeLessThanOrEqual(upper.from);
    expect(lower.to).toBeGreaterThanOrEqual(upper.to);
    expect(gate.minX).toBeLessThanOrEqual(upper.from);
    expect(gate.maxX).toBeGreaterThanOrEqual(upper.to);
    // And it does not reach the ramp's own channel, which is well to the right
    // and must keep using `ramp-end`.
    expect(gate.maxX).toBeLessThan(runOf(views, 1, gate.y, 33, 60)!.from);
  });
});
