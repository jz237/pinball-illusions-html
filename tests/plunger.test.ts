import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SimulationForces, TableMap, TableMapDocument } from "../src/game/contracts.js";
import { materialTableFor } from "../src/game/materials.js";
import { accelFor, devicesFor } from "./table-fixtures.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { q10ToPixel } from "../src/core/fixed-point.js";
import {
  SUBSTEP_GRAVITY,
  VIRTUAL_TOP_WALL_ROWS,
  createBallSet,
  playfieldViewFor,
  stepBalls,
} from "../src/game/ball-physics.js";
import { channelRunAt, freeCentre, levelViewsOf } from "../src/game/level-scan.js";
import {
  CLEARED_TROUGH_RECORD,
  DEFAULT_PLUNGER_CONFIG,
  LAUNCH_KICK,
  LAW_N_JUSTICE_SHOOTER_LANE,
  ORIGINAL_LAUNCH_KICK_UNITS,
  PLUNGER_IDLE,
  ROD_SWITCH,
  SERVE_INSET_PIXELS,
  SHOOTER_LANE_BY_TABLE,
  TROUGH_CENTRE_X,
  TROUGH_CENTRE_Y,
  TROUGH_LEVEL,
  TROUGH_ORIGIN_X,
  TROUGH_ORIGIN_Y,
  TROUGH_POSITION_MASK,
  TROUGH_VELOCITY_MASK,
  TROUGH_VELOCITY_UNITS,
  autoLaunchOutcome,
  ballIsOnTheRod,
  launchBall,
  plungerConfigFor,
  plungerConfigForLane,
  serveBall,
  servePosition,
  shooterLaneFor,
  tickLauncher,
  troughPlacement,
  troughRecordOf,
  validatePlungerConfig,
} from "../src/game/plunger.js";
import {
  SIMULATION_GRAVITY,
  VELOCITY_CLAMP_Q10,
  originalVelocityToQ10,
} from "../src/game/timebase.js";
import type { PlungerInput } from "../src/game/plunger.js";
import { BUMPER_KICK } from "../src/game/surface-physics.js";

const CONFIG = DEFAULT_PLUNGER_CONFIG;

const GRAVITY: SimulationForces = {
  gravityY: SIMULATION_GRAVITY,
  nudgeX: 0,
  nudgeY: 0,
};

const PRESS: PlungerInput = { pressed: true, released: false, held: true };
const HOLD: PlungerInput = { pressed: false, released: false, held: true };
const RELEASE: PlungerInput = { pressed: false, released: true, held: false };
const TAP: PlungerInput = { pressed: true, released: true, held: false };

describe("the shooter lane", () => {
  it("serves inside the measured free span of Law 'n Justice's lane", () => {
    const lane = LAW_N_JUSTICE_SHOOTER_LANE;
    const x = q10ToPixel(CONFIG.serveX);
    const y = q10ToPixel(CONFIG.serveY);
    expect(x).toBeGreaterThanOrEqual(lane.minCentreX);
    expect(x).toBeLessThanOrEqual(lane.maxCentreX);
    expect(y).toBeGreaterThan(lane.topY);
    expect(y).toBe(lane.bottomY);
  });

  it("rests the served ball on the floor row the film rests it on", () => {
    const lane = LAW_N_JUSTICE_SHOOTER_LANE;
    // No inset. session2 babewatch-take1 f331: the silver's bbox is y
    // 546.0..557.5, centroid 551.3, and the f332 frame-difference centre is
    // 550.8 — the measured rest row is bottomY (552), not 544.
    expect(SERVE_INSET_PIXELS).toBe(0);
    expect(q10ToPixel(CONFIG.serveY)).toBe(lane.bottomY);
    expect(q10ToPixel(CONFIG.serveY)).toBe(552);
    // Well below the halfway point: a ball served mid-lane would have half the
    // runway and the launch shot would not reach the top.
    expect(q10ToPixel(CONFIG.serveY)).toBeGreaterThan((lane.topY + lane.bottomY) / 2);
  });

  it("centres the serve between the lane walls", () => {
    const lane = LAW_N_JUSTICE_SHOOTER_LANE;
    const x = q10ToPixel(CONFIG.serveX);
    expect(x - lane.minCentreX).toBeGreaterThanOrEqual(lane.maxCentreX - x - 1);
    expect(lane.maxCentreX - x).toBeGreaterThanOrEqual(x - lane.minCentreX - 1);
  });

  it("has all three lanes measured off their own map, not copied", () => {
    // Two of these used to be Law 'n Justice's lane marked `assumed`, and the
    // assumption cost Extreme Sports a pixel: its own free centres are 322..324,
    // so the copied span served the ball a column left of its lane's middle.
    // (321/322 rather than 289/290 since the maps were re-exported on the
    // correct 32 px frame — the columns moved, the one-pixel difference between
    // the two lanes did not, which is what makes it a real measurement.)
    for (const tableId of ["law-n-justice", "babewatch", "extreme-sports"] as const) {
      expect(shooterLaneFor(tableId).confidence).toBe("measured");
      expect(plungerConfigFor(tableId).laneConfidence).toBe("measured");
    }
    // Measured, and therefore no longer all identical.
    expect(shooterLaneFor("babewatch").minCentreX).toBe(321);
    expect(shooterLaneFor("extreme-sports").minCentreX).toBe(322);
  });

  it("has a lane for every table", () => {
    expect(Object.keys(SHOOTER_LANE_BY_TABLE).sort()).toEqual([
      "babewatch",
      "extreme-sports",
      "law-n-justice",
    ]);
  });

  it("re-derives every shooter-lane bound from the shipped map", () => {
    // WHY THIS TEST EXISTS. The maps were once re-exported 32 px out of phase and
    // every column-indexed constant in the engine silently became wrong; the
    // suite stayed green because the expectations moved with the constants. A
    // comment saying "measured with the engine's own radius-8 ring" is not
    // protection against that happening again. Executing the measurement is.
    //
    // So this re-runs the exact four-part rule written at the top of
    // `plunger.ts` against `public/generated/tables/*.map.json`, using
    // `level-scan.ts` — which is the same probe ring `collision-probe.ts`
    // collides with — and asserts the shipped constants are what falls out:
    //
    //   bottomY                  bottommost free ball-centre row on the lane
    //   minCentreX / maxCentreX  the free-centre run on that row
    //   topY                     top of the unbroken run through the lane column
    //                            that ends at bottomY
    //
    // Measured on THE VIEW THE PHYSICS RUNS, not the raw bitmap: Law 'n Justice's
    // level-0 view carries a 26-row virtual ceiling, which is the whole reason
    // its topY is 34 rather than the bitmap's 8.
    for (const tableId of ["law-n-justice", "babewatch", "extreme-sports"] as const) {
      const map = parseTableMapDocument(
        JSON.parse(
          readFileSync(
            fileURLToPath(
              new URL(`../public/generated/tables/${tableId}.map.json`, import.meta.url),
            ),
            "utf8",
          ),
        ) as TableMapDocument,
      );
      const views = levelViewsOf(
        playfieldViewFor(map, VIRTUAL_TOP_WALL_ROWS[tableId]),
        materialTableFor(tableId),
      );
      const lane = shooterLaneFor(tableId);
      const laneX = (lane.minCentreX + lane.maxCentreX) >> 1;

      // bottomY: the bottom of the LANE, which is not the bottom of the column.
      // Below the lane's floor — a solid bit-0 run on row 561 on all three
      // tables — the map carries nothing at all, so rows 563 and down are "free"
      // again; they are off the end of the world, not part of the channel. The
      // anchor is therefore the lowest row at which the lane column reads as a
      // narrow CHANNEL rather than as open space, and the bound is the bottom of
      // the unbroken free run through it.
      let anchor = -1;
      for (let y = map.height - 1; y >= 0 && anchor < 0; y -= 1) {
        if (channelRunAt(views, 0, laneX, y) !== null) anchor = y;
      }
      expect(anchor, `${tableId} has no lane channel at all`).toBeGreaterThan(0);
      let bottomY = anchor;
      for (let y = anchor; y < map.height; y += 1) {
        if (!freeCentre(views, 0, laneX, y)) break;
        bottomY = y;
      }
      expect(bottomY, `${tableId} bottomY`).toBe(lane.bottomY);

      // minCentreX / maxCentreX: the seat is the channel run on the serve row,
      // which is the row the ball is actually put on.
      const serveRow = bottomY - SERVE_INSET_PIXELS;
      expect(channelRunAt(views, 0, laneX, serveRow), `${tableId} seat`).toEqual({
        from: lane.minCentreX,
        to: lane.maxCentreX,
      });

      // topY: the top of the unbroken run through the lane column ending at
      // bottomY. This is what says how much runway the launch has.
      let topY = bottomY;
      for (let y = bottomY; y >= 0; y -= 1) {
        if (!freeCentre(views, 0, laneX, y)) break;
        topY = y;
      }
      expect(topY, `${tableId} topY`).toBe(lane.topY);

      // And the serve point the config derives from all four is inside the lane
      // and free, so a served ball is never spawned in a wall.
      const config = plungerConfigFor(tableId);
      expect(q10ToPixel(config.serveY)).toBe(serveRow);
      expect(freeCentre(views, 0, q10ToPixel(config.serveX), serveRow)).toBe(true);
    }
  });

  it("refuses a lane too short to serve into, or one with inverted bounds", () => {
    expect(() =>
      plungerConfigForLane({ ...LAW_N_JUSTICE_SHOOTER_LANE, topY: 600, bottomY: 4 }),
    ).toThrow(/inverted/);
    // "Too short" now means "no runway at all". With the inset removed the
    // serve row is `bottomY`, so a 550..552 lane really is servable — the ball
    // rests on 552 with two rows above it — and the degenerate case that is
    // still refused is the lane whose floor and ceiling are the same row.
    expect(() =>
      plungerConfigForLane({ ...LAW_N_JUSTICE_SHOOTER_LANE, topY: 552, bottomY: 552 }),
    ).toThrow(/too short/);
  });

  it("exposes the serve point as Q10, matching the config", () => {
    expect(servePosition(CONFIG)).toEqual({ x: CONFIG.serveX, y: CONFIG.serveY });
    expect(servePosition()).toEqual({ x: CONFIG.serveX, y: CONFIG.serveY });
  });
});

describe("the fixed kick", () => {
  // A1. The original has no plunger: the launch is `subi.w #$1770` — a fixed
  // 6000-unit kick — behind an edge-consumed RETURN byte (main.seg00 0x65EE /
  // 0x663A), and the film shows a 120 ms tap and a 2000 ms hold producing
  // frame-identical launches on all three tables. These tests pin that model;
  // the charge/pull tests they replace tested a mechanism the machine does not
  // have.

  it("carries the disassembled constant through the measured bridge", () => {
    expect(ORIGINAL_LAUNCH_KICK_UNITS).toBe(6000);
    expect(LAUNCH_KICK).toBe(originalVelocityToQ10(6000));
    // The kick is written PRE-clamp, past the engine's own ±4095-unit limit —
    // deliberately: the effective speed is the clamp's, not this number's.
    expect(LAUNCH_KICK).toBeGreaterThan(VELOCITY_CLAMP_Q10);
    // And it is a harder hit than even the pop bumper's 5500-unit coil, which
    // is the ordering the disassembly gives the machine's three kicks.
    expect(LAUNCH_KICK).toBeGreaterThan(BUMPER_KICK);
  });

  it("fires on the press edge and only on the press edge", () => {
    expect(tickLauncher(PRESS, CONFIG).fired).toBe(true);
    expect(tickLauncher(TAP, CONFIG).fired).toBe(true);
    // A held key is not a stream of launches: the byte was consumed.
    expect(tickLauncher(HOLD, CONFIG).fired).toBe(false);
    // A release fires nothing — the original consumes the byte on key-DOWN.
    expect(tickLauncher(RELEASE, CONFIG).fired).toBe(false);
    expect(tickLauncher(PLUNGER_IDLE, CONFIG).fired).toBe(false);
  });

  it("launches identically for a tap and for any length of hold", () => {
    // The acceptance line from the reference capture: tap and 2 s hold
    // frame-identical. Hold length cannot enter: the outcome is a pure
    // function of the press edge.
    const tap = tickLauncher(TAP, CONFIG);
    const press = tickLauncher(PRESS, CONFIG);
    expect(tap).toEqual(press);
    // And ticks of holding after the press contribute nothing.
    for (let tick = 0; tick < 100; tick += 1) {
      expect(tickLauncher(HOLD, CONFIG).fired).toBe(false);
    }
  });

  it("kicks every table with the same engine constant", () => {
    // One launch routine, engine-shared: measured on film for all three
    // tables and read in the disassembly as a single code path.
    for (const tableId of ["law-n-justice", "babewatch", "extreme-sports"] as const) {
      const config = validatePlungerConfig(plungerConfigFor(tableId));
      expect(config.launchKick).toBe(LAUNCH_KICK);
      expect(tickLauncher(PRESS, config).launchVelocityY).toBe(-LAUNCH_KICK);
    }
  });

  it("gives the machine's own serves the identical kick", () => {
    // $D89's auto path lands on the same `subi.w` the player's edge does.
    expect(autoLaunchOutcome(CONFIG).launchVelocityY).toBe(
      tickLauncher(PRESS, CONFIG).launchVelocityY,
    );
  });

  it("clamps the applied velocity to the engine's own limit", () => {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    expect(launchBall(ball, tickLauncher(PRESS, CONFIG))).toBe(true);
    // 6000 units in, 4095 units out: the ball leaves at exactly the clamp,
    // 16,380 Q10 = 16 px/tick = 800 px/s, which is what the film's flat
    // 770–775 px/s ascent is after gravity and the lane drive trim it.
    expect(ball.velocityY).toBe(-VELOCITY_CLAMP_Q10);
  });

  it("rejects a config whose kick could not launch", () => {
    expect(() => validatePlungerConfig({ ...CONFIG, launchKick: 0 })).toThrow(/launchKick/);
    expect(() => validatePlungerConfig({ ...CONFIG, launchKick: -5 })).toThrow(/launchKick/);
    expect(() => validatePlungerConfig({ ...CONFIG, launchKick: 1.5 })).toThrow(/launchKick/);
  });
});

describe("serving and launching a ball", () => {
  it("puts the ball in the trough, on the upper line, pushed off down the chute", () => {
    // $3E36 on a cleared record: x = 284, y = 510, v = 512 in both axes, and
    // $53F4's pointer set, i.e. level 1. In this port's centre frame that is
    // 292/518, because the original's $12/$14 are the sprite's top-left.
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    expect(ball.x).toBe((TROUGH_ORIGIN_X + 8) * 1024);
    expect(ball.y).toBe((TROUGH_ORIGIN_Y + 8) * 1024);
    expect(ball.velocityX).toBe(originalVelocityToQ10(TROUGH_VELOCITY_UNITS));
    expect(ball.velocityY).toBe(ball.velocityX);
    expect(ball.level).toBe(TROUGH_LEVEL);
    expect(ball.active).toBe(true);
    expect(set.balls).toHaveLength(1);
  });

  it("carries three bits of the last ball's position and a byte of its velocity", () => {
    // The routine masks the record IN PLACE, so what it keeps is the low bits of
    // wherever the machine took the last ball away from and how fast it was
    // going. Two drains one pixel apart therefore serve one pixel apart.
    const drained = {
      x: 185 * 1024 + 900,
      y: 601 * 1024,
      velocityX: originalVelocityToQ10(-1000),
      velocityY: originalVelocityToQ10(2313),
    };
    const record = troughRecordOf(drained);
    // 185 & 7 = 1, 601 & 7 = 1; -1000 is $FC18 and $FC18 & $FF = $18 = 24;
    // 2313 is $0909 and $0909 & $FF = 9.
    // `spin` is carried WHOLE rather than masked: $3E36 re-seeds the record it
    // is handed and never writes $26, so the drained ball's spin survives the
    // serve. See `TroughRecord.spin`.
    expect(record).toEqual({ x: 1, y: 1, velocityX: 24, velocityY: 9, spin: 0 });

    const place = troughPlacement(record);
    expect(place.x).toBe((TROUGH_CENTRE_X + 1) * 1024);
    expect(place.y).toBe((TROUGH_CENTRE_Y + 1) * 1024);
    expect(place.velocityX).toBe(originalVelocityToQ10(TROUGH_VELOCITY_UNITS + 24));
    expect(place.velocityY).toBe(originalVelocityToQ10(TROUGH_VELOCITY_UNITS + 9));

    // And the masks are the disassembly's, not a rounding of them.
    expect(TROUGH_POSITION_MASK).toBe(7);
    expect(TROUGH_VELOCITY_MASK).toBe(0xff);
    expect(TROUGH_VELOCITY_UNITS).toBe(512);
  });

  it("masks the CENTRE and the top-left to the same three bits", () => {
    // The port stores centres, the original stored top-lefts, and the radius is
    // 8 - a whole multiple of the mask - so no correction is needed anywhere.
    for (let centre = 0; centre < 64; centre += 1) {
      expect(centre & TROUGH_POSITION_MASK).toBe((centre - 8) & TROUGH_POSITION_MASK);
    }
  });

  it("serves a cold machine from the cleared record", () => {
    // `spin` is the fifth field and it is carried WHOLE rather than masked:
    // `$3E36` re-seeds the record it is handed and never writes `$26`.
    expect(CLEARED_TROUGH_RECORD).toEqual({ x: 0, y: 0, velocityX: 0, velocityY: 0, spin: 0 });
    expect(troughPlacement()).toEqual(troughPlacement(CLEARED_TROUGH_RECORD));
  });

  it("gives each served ball its own id, for multiball", () => {
    const set = createBallSet();
    const first = serveBall(set, CONFIG);
    const second = serveBall(set, CONFIG);
    expect(second.id).not.toBe(first.id);
  });

  it("sets the ball's vertical velocity outright rather than adding to it", () => {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    ball.velocityY = 300; // already dribbling downward
    ball.velocityX = -50;
    expect(launchBall(ball, tickLauncher(PRESS, CONFIG))).toBe(true);
    expect(ball.velocityY).toBe(-VELOCITY_CLAMP_Q10);
    // Sideways rattle is the lane's business, not the launcher's.
    expect(ball.velocityX).toBe(-50);
  });

  it("does nothing when the launcher did not fire", () => {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    const idle = tickLauncher(HOLD, CONFIG);
    expect(launchBall(ball, idle)).toBe(false);
    // Untouched, which is now the trough's push-off rather than zero.
    expect(ball.velocityY).toBe(troughPlacement().velocityY);
  });

  it("does nothing to a drained ball", () => {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    ball.active = false;
    expect(launchBall(ball, tickLauncher(PRESS, CONFIG))).toBe(false);
    expect(ball.velocityY).toBe(troughPlacement().velocityY);
  });
});

/**
 * THE TROUGH AND THE ROD SWITCH, re-derived from the shipped documents rather
 * than trusted.
 *
 * Both are engine geometry - one set of constants in main.seg00 for all three
 * tables - and the claim that they ARE shared is exactly the kind of thing that
 * is true until a map is re-exported. So it is executed here.
 */
describe("the trough and the rod switch are the same cabinet part on every table", () => {
  const TABLES = ["law-n-justice", "babewatch", "extreme-sports"] as const;

  function mapDoc(tableId: string): TableMap {
    const path = fileURLToPath(
      new URL(`../public/generated/tables/${tableId}.map.json`, import.meta.url),
    );
    return parseTableMapDocument(JSON.parse(readFileSync(path, "utf8")) as TableMapDocument);
  }

  it("drops the trough into a funnel that is pixel-identical on all three maps", () => {
    // The chute is engine furniture, like the lane floor at y=561: the free
    // ball-centre run on every row of the trough's 8x8 mouth is the same on all
    // three shipped maps, to the pixel. That is what makes ONE pair of
    // immediates in main.seg00 a legal serve for three different tables.
    const runs = TABLES.map((tableId) => {
      const views = levelViewsOf(mapDoc(tableId), materialTableFor(tableId));
      const rows: string[] = [];
      for (let dy = 0; dy <= TROUGH_POSITION_MASK; dy += 1) {
        let lo = -1;
        let hi = -1;
        for (let x = 270; x < 336; x += 1) {
          if (!freeCentre(views, TROUGH_LEVEL, x, TROUGH_CENTRE_Y + dy)) continue;
          if (lo < 0) lo = x;
          hi = x;
        }
        rows.push(`${lo}..${hi}`);
      }
      return rows;
    });
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    // And it really is a funnel closing to the left as it rises: the run's left
    // edge walks 295, 294, 293, 292, 291 down rows 518..522.
    expect(runs[0]?.slice(0, 5)).toEqual([
      "295..327",
      "294..327",
      "293..327",
      "292..327",
      "291..327",
    ]);
  });

  it("delivers every one of the 64 trough placements onto the rod", () => {
    // The property that matters, and the one the pin used to make unnecessary.
    // 45 of the 64 mouth pixels are free ball centres and the other 19 start
    // inside the funnel's upper-left wall — the machine drops the ball into a
    // funnel, it does not thread it — so the test is that the ball ARRIVES, not
    // that it starts clear. Both ends of the velocity carry are run, because the
    // carry is what turns the drop into a slide.
    for (const tableId of TABLES) {
      const map = mapDoc(tableId);
      const materials = materialTableFor(tableId);
      const drive = accelFor(tableId);
      const surfaces = devicesFor(tableId);
      for (let dx = 0; dx <= TROUGH_POSITION_MASK; dx += 1) {
        for (let dy = 0; dy <= TROUGH_POSITION_MASK; dy += 1) {
          for (const carry of [0, TROUGH_VELOCITY_MASK]) {
            const set = createBallSet();
            const ball = serveBall(set, plungerConfigFor(tableId), {
              x: dx,
              y: dy,
              velocityX: carry,
              velocityY: carry,
              spin: 0,
            });
            // ARRIVED, not FROZEN. The seat bobs — that is the ejector at
            // +0x00B6BE and it is the machine's own behaviour, whose lane ball
            // never comes to a dead stop either — so the bar is one collision
            // pass's worth of gravity rather than exactly zero. See
            // `SUBSTEP_GRAVITY`; a ball still rolling down the chute is orders
            // of magnitude above it.
            const seated = 2 * SUBSTEP_GRAVITY;
            let arrived = -1;
            for (let tick = 0; tick < 200 && arrived < 0; tick += 1) {
              stepBalls(set, map, materials, GRAVITY, { rampDrive: drive, surfaces });
              if (
                ballIsOnTheRod(ball) &&
                Math.abs(ball.velocityX) <= seated &&
                Math.abs(ball.velocityY) <= seated
              ) {
                arrived = tick;
              }
            }
            expect(arrived, `${tableId} trough (${dx},${dy}) carry ${carry}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("reads the rod switch out of the shipped scoring layer", () => {
    // The original's launcher kicks whatever ball index stands in the byte
    // $234E(a5) names; that byte belongs to a zone, and the zone is here: one
    // level-0 trigger over the lane seat, scoring nothing, identical on all
    // three tables.
    for (const tableId of TABLES) {
      const path = fileURLToPath(
        new URL(`../public/generated/tables/${tableId}.devices.json`, import.meta.url),
      );
      const doc = JSON.parse(readFileSync(path, "utf8")) as {
        zones: readonly {
          level: number;
          minX: number;
          minY: number;
          maxX: number;
          maxY: number;
          score: number;
        }[];
      };
      const seatX = q10ToPixel(plungerConfigFor(tableId).serveX);
      const seatY = q10ToPixel(plungerConfigFor(tableId).serveY);
      const over = doc.zones.filter(
        (zone) =>
          zone.level === 0 &&
          seatX >= zone.minX &&
          seatX <= zone.maxX &&
          seatY >= zone.minY &&
          seatY <= zone.maxY,
      );
      expect(over, `${tableId} rod switch`).toHaveLength(1);
      const zone = over[0]!;
      expect(zone.score).toBe(0);
      expect({
        minX: zone.minX,
        minY: zone.minY,
        maxX: zone.maxX,
        maxY: zone.maxY,
      }).toEqual({
        minX: ROD_SWITCH.minX,
        minY: ROD_SWITCH.minY,
        maxX: ROD_SWITCH.maxX,
        maxY: ROD_SWITCH.maxY,
      });
    }
  });

  it("says a ball is on the rod only when it is standing on that switch", () => {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    // Fresh out of the trough it is on the upper line, at the head of the chute.
    expect(ballIsOnTheRod(ball)).toBe(false);
    ball.level = 0;
    expect(ballIsOnTheRod(ball)).toBe(false);
    ball.x = CONFIG.serveX;
    ball.y = CONFIG.serveY;
    expect(ballIsOnTheRod(ball)).toBe(true);
    ball.active = false;
    expect(ballIsOnTheRod(ball)).toBe(false);
  });
});

/**
 * The kick only means anything against real geometry, so this runs the real
 * integrator up the real Law 'n Justice lane and asserts the property the
 * whole launch exists for: every launch is the SAME launch, and it clears the
 * lane. There is no weak plunge to test any more — that is the point.
 */
describe("launching up the real Law 'n Justice lane", () => {
  const MAP_PATH = fileURLToPath(
    new URL("../public/generated/tables/law-n-justice.map.json", import.meta.url),
  );
  const MAP: TableMap = parseTableMapDocument(
    JSON.parse(readFileSync(MAP_PATH, "utf8")) as TableMapDocument,
  );
  const MATERIALS = materialTableFor("law-n-justice");
  const DRIVE = accelFor("law-n-justice");
  const SURFACES = devicesFor("law-n-justice");

  /**
   * Serves, ROLLS THE BALL DOWN THE RETURN CHUTE, waits for it to settle on the
   * lane floor, launches, and follows it.
   *
   * The 30 bare ticks this used to run are gone with the pin: a serve now starts
   * at the trough on the upper line, and getting from there to the rod needs the
   * ramp drive and the scoring layer's hand-off zone, which the launch tests
   * below never had to care about while the loop teleported the ball onto the
   * seat.
   */
  function launchAndTrack(ticks: number): {
    minY: number;
    restY: number;
    trace: readonly number[];
  } {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    for (let tick = 0; tick < 200; tick += 1) {
      stepBalls(set, MAP, MATERIALS, GRAVITY, { rampDrive: DRIVE, surfaces: SURFACES });
      if (ballIsOnTheRod(ball) && ball.velocityX === 0 && ball.velocityY === 0) break;
    }
    const restY = q10ToPixel(ball.y);
    launchBall(ball, tickLauncher(PRESS, CONFIG));

    let minY = q10ToPixel(ball.y);
    const trace: number[] = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      stepBalls(set, MAP, MATERIALS, GRAVITY);
      trace.push(ball.y);
      const y = q10ToPixel(ball.y);
      if (y < minY) minY = y;
    }
    return { minY, restY, trace };
  }

  it("settles the served ball inside the lane instead of drifting out of it", () => {
    const { restY } = launchAndTrack(1);
    expect(restY).toBeGreaterThan(q10ToPixel(CONFIG.serveY) - 4);
    // `bottomY` is "the bottommost FREE CENTRE row of the unbroken channel" —
    // the lowest row whose WHOLE probe ring clears the floor at 561 — and the
    // ball now rests ONE ROW BELOW IT, because the decoded contact rule reads
    // the ring where the substep grid puts the ball instead of backing it up to
    // first touch, so a resting ball legitimately sits inside the touch band.
    // That is the original's own seat: cy 553.53..553.91 on all four session-4
    // cold launches (research/view/reference/session4/INDEX.txt) against this
    // port's row 553, where HEAD sat at 552.999. Still deep inside the channel,
    // whose walls run to 561, which is what this test is about.
    expect(restY).toBeLessThanOrEqual(LAW_N_JUSTICE_SHOOTER_LANE.bottomY + 1);
    expect(restY).toBe(553);
  });

  it("sends every launch all the way to the top of the channel", () => {
    const { minY } = launchAndTrack(200);
    // 26 rows of virtual top wall plus a ball radius is the highest a centre
    // can physically get on this table.
    expect(minY).toBeLessThan(60);
  });

  it("is deterministic: two launches trace the identical path", () => {
    // The film's three-launches-identical-to-±0.5px, as the exact statement the
    // integer engine can make: bit-identical.
    expect(launchAndTrack(200).trace).toEqual(launchAndTrack(200).trace);
  });

  it("climbs the lane at the film's speed", () => {
    // Reference: 15.5 game px/frame over the lane window, "no measurable
    // decay" (launch-key-sweep MKV, track8/track10.csv), against a launch at
    // the 16 px/tick clamp trimmed by gravity and the decoded (0,2) lane
    // drive. The first ticks of the climb must sit in that band; a charge
    // model, a wrong clamp or a wrong bridge all land far outside it.
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    for (let tick = 0; tick < 200; tick += 1) {
      stepBalls(set, MAP, MATERIALS, GRAVITY, { rampDrive: DRIVE, surfaces: SURFACES });
      if (ballIsOnTheRod(ball) && ball.velocityX === 0 && ball.velocityY === 0) break;
    }
    launchBall(ball, tickLauncher(PRESS, CONFIG));
    let previous = ball.y;
    const speeds: number[] = [];
    for (let tick = 0; tick < 8; tick += 1) {
      stepBalls(set, MAP, MATERIALS, GRAVITY, { rampDrive: DRIVE, surfaces: SURFACES });
      speeds.push((previous - ball.y) / 1024);
      previous = ball.y;
    }
    for (const speed of speeds) {
      expect(speed).toBeGreaterThanOrEqual(14.4);
      expect(speed).toBeLessThanOrEqual(16.0);
    }
  });

  it("never drives a launched ball through a lane wall", () => {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    for (let tick = 0; tick < 200; tick += 1) {
      stepBalls(set, MAP, MATERIALS, GRAVITY, { rampDrive: DRIVE, surfaces: SURFACES });
      if (ballIsOnTheRod(ball) && ball.velocityX === 0 && ball.velocityY === 0) break;
    }
    launchBall(ball, tickLauncher(PRESS, CONFIG));
    for (let tick = 0; tick < 300; tick += 1) {
      stepBalls(set, MAP, MATERIALS, GRAVITY, { rampDrive: DRIVE, surfaces: SURFACES });
      if (!ball.active) break;
      expect(Number.isInteger(ball.x)).toBe(true);
      expect(Number.isInteger(ball.y)).toBe(true);
      const x = q10ToPixel(ball.x);
      const y = q10ToPixel(ball.y);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(MAP.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(MAP.height);
    }
  });
});
