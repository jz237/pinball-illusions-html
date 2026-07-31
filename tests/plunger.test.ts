import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SimulationForces, TableMap, TableMapDocument } from "../src/game/contracts.js";
import { materialTableFor } from "../src/game/materials.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { Q10_ONE, pixelsToQ10, q10ToPixel } from "../src/core/fixed-point.js";
import { createBallSet, stepBalls } from "../src/game/ball-physics.js";
import {
  DEFAULT_PLUNGER_CONFIG,
  INITIAL_PLUNGER,
  LAW_N_JUSTICE_SHOOTER_LANE,
  MAX_LAUNCH_SPEED,
  MIN_LAUNCH_SPEED,
  PLUNGER_CHARGE_RATE,
  PLUNGER_CHARGE_TICKS,
  PLUNGER_FULL_CHARGE,
  PLUNGER_IDLE,
  PLUNGER_REFERENCE_GRAVITY,
  SERVE_INSET_PIXELS,
  SHOOTER_LANE_BY_TABLE,
  chargeLevel,
  chargeTicksToFull,
  launchBall,
  launchSpeedFor,
  plungerConfigFor,
  plungerConfigForLane,
  resetPlunger,
  serveBall,
  servePosition,
  shooterLaneFor,
  tickPlunger,
  validatePlungerConfig,
} from "../src/game/plunger.js";
import type { PlungerConfig, PlungerInput, PlungerOutcome } from "../src/game/plunger.js";

const CONFIG = DEFAULT_PLUNGER_CONFIG;

const PRESS: PlungerInput = { pressed: true, released: false, held: true };
const HOLD: PlungerInput = { pressed: false, released: false, held: true };
const RELEASE: PlungerInput = { pressed: false, released: true, held: false };

/**
 * Holds the plunger for `heldTicks` ticks and then lets go on the next one.
 *
 * The release tick charges too — the key was down for part of it — so the
 * banked charge is one rate step more than the hold alone would suggest. That
 * is deliberate and is what makes a sub-tick tap fire at all, so the tests
 * assert against the real total rather than papering over it.
 */
function pullAndRelease(heldTicks: number, config: PlungerConfig = CONFIG): PlungerOutcome {
  let state = INITIAL_PLUNGER;
  for (let tick = 0; tick < heldTicks; tick += 1) {
    state = tickPlunger(state, tick === 0 ? PRESS : HOLD, config).state;
  }
  return tickPlunger(state, RELEASE, config);
}

describe("the shooter lane", () => {
  it("serves inside the measured free span of Law 'n Justice's lane", () => {
    const lane = LAW_N_JUSTICE_SHOOTER_LANE;
    const x = q10ToPixel(CONFIG.serveX);
    const y = q10ToPixel(CONFIG.serveY);
    expect(x).toBeGreaterThanOrEqual(lane.minCentreX);
    expect(x).toBeLessThanOrEqual(lane.maxCentreX);
    expect(y).toBeGreaterThan(lane.topY);
    expect(y).toBeLessThan(lane.bottomY);
  });

  it("serves near the bottom of the lane, not the middle of it", () => {
    const lane = LAW_N_JUSTICE_SHOOTER_LANE;
    expect(q10ToPixel(CONFIG.serveY)).toBe(lane.bottomY - SERVE_INSET_PIXELS);
    // Well below the halfway point: a ball served mid-lane would have half the
    // runway and a full plunge would not reach the top.
    expect(q10ToPixel(CONFIG.serveY)).toBeGreaterThan((lane.topY + lane.bottomY) / 2);
  });

  it("centres the serve between the lane walls", () => {
    const lane = LAW_N_JUSTICE_SHOOTER_LANE;
    const x = q10ToPixel(CONFIG.serveX);
    expect(x - lane.minCentreX).toBeGreaterThanOrEqual(lane.maxCentreX - x - 1);
    expect(lane.maxCentreX - x).toBeGreaterThanOrEqual(x - lane.minCentreX - 1);
  });

  it("marks the two unmeasured tables as assumptions rather than measurements", () => {
    expect(shooterLaneFor("law-n-justice").confidence).toBe("measured");
    expect(shooterLaneFor("babewatch").confidence).toBe("assumed");
    expect(shooterLaneFor("extreme-sports").confidence).toBe("assumed");
    expect(plungerConfigFor("law-n-justice").laneConfidence).toBe("measured");
    expect(plungerConfigFor("extreme-sports").laneConfidence).toBe("assumed");
  });

  it("has a lane for every table", () => {
    expect(Object.keys(SHOOTER_LANE_BY_TABLE).sort()).toEqual([
      "babewatch",
      "extreme-sports",
      "law-n-justice",
    ]);
  });

  it("refuses a lane too short to serve into, or one with inverted bounds", () => {
    expect(() =>
      plungerConfigForLane({ ...LAW_N_JUSTICE_SHOOTER_LANE, topY: 600, bottomY: 4 }),
    ).toThrow(/inverted/);
    expect(() =>
      plungerConfigForLane({ ...LAW_N_JUSTICE_SHOOTER_LANE, topY: 550, bottomY: 552 }),
    ).toThrow(/too short/);
  });

  it("exposes the serve point as Q10, matching the config", () => {
    expect(servePosition(CONFIG)).toEqual({ x: CONFIG.serveX, y: CONFIG.serveY });
    expect(servePosition()).toEqual({ x: CONFIG.serveX, y: CONFIG.serveY });
  });
});

describe("charging", () => {
  it("gains exactly one rate step per tick while held", () => {
    let state = tickPlunger(INITIAL_PLUNGER, PRESS, CONFIG).state;
    expect(state.charge).toBe(PLUNGER_CHARGE_RATE);
    expect(state.pulling).toBe(true);

    state = tickPlunger(state, HOLD, CONFIG).state;
    expect(state.charge).toBe(PLUNGER_CHARGE_RATE * 2);

    state = tickPlunger(state, HOLD, CONFIG).state;
    expect(state.charge).toBe(PLUNGER_CHARGE_RATE * 3);
  });

  it("does not charge while nothing is holding it", () => {
    const outcome = tickPlunger(INITIAL_PLUNGER, PLUNGER_IDLE, CONFIG);
    expect(outcome.state.charge).toBe(0);
    expect(outcome.state.pulling).toBe(false);
    expect(outcome.fired).toBe(false);
  });

  it("clamps at a full pull and stays there however long it is held", () => {
    let state = tickPlunger(INITIAL_PLUNGER, PRESS, CONFIG).state;
    for (let tick = 1; tick < PLUNGER_CHARGE_TICKS; tick += 1) {
      state = tickPlunger(state, HOLD, CONFIG).state;
    }
    expect(state.charge).toBe(PLUNGER_FULL_CHARGE);

    for (let tick = 0; tick < 500; tick += 1) {
      state = tickPlunger(state, HOLD, CONFIG).state;
      expect(state.charge).toBe(PLUNGER_FULL_CHARGE);
    }
  });

  it("reaches a full pull in exactly the advertised number of ticks", () => {
    expect(chargeTicksToFull(CONFIG)).toBe(PLUNGER_CHARGE_TICKS);
    // The rate divides the ceiling exactly, so "full" is an equality, not a
    // near-miss that a clamp quietly rescues.
    expect(PLUNGER_CHARGE_RATE * PLUNGER_CHARGE_TICKS).toBe(PLUNGER_FULL_CHARGE);
  });

  it("adopts a pull that was already in progress when the state was made", () => {
    // held without a press edge: the router was created mid-hold.
    const outcome = tickPlunger(INITIAL_PLUNGER, { pressed: false, released: false, held: true });
    expect(outcome.state.pulling).toBe(true);
    expect(outcome.state.charge).toBe(PLUNGER_CHARGE_RATE);
  });

  it("reports charge as a 0..1 level for the meter", () => {
    expect(chargeLevel(INITIAL_PLUNGER)).toBe(0);
    expect(chargeLevel({ charge: PLUNGER_FULL_CHARGE, pulling: true })).toBe(1);
    expect(chargeLevel({ charge: PLUNGER_FULL_CHARGE / 2, pulling: true })).toBeCloseTo(0.5, 10);
    let state = INITIAL_PLUNGER;
    for (let tick = 0; tick < PLUNGER_CHARGE_TICKS * 2; tick += 1) {
      state = tickPlunger(state, tick === 0 ? PRESS : HOLD, CONFIG).state;
      const level = chargeLevel(state);
      expect(level).toBeGreaterThan(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });

  it("stops winding when the key-up is lost, rather than charging to full alone", () => {
    // An alt-tab or an unplugged pad can swallow the release edge. The spring
    // must not keep winding on its own while the player is not touching it.
    let state = tickPlunger(INITIAL_PLUNGER, PRESS, CONFIG).state;
    state = tickPlunger(state, HOLD, CONFIG).state;
    const banked = state.charge;

    for (let tick = 0; tick < 200; tick += 1) {
      state = tickPlunger(state, PLUNGER_IDLE, CONFIG).state;
    }
    expect(state.charge).toBe(banked);
    // Still armed, so the plunge the player asked for is not thrown away: it
    // fires when a release finally arrives, such as the one a blur synthesises.
    expect(state.pulling).toBe(true);

    const fired = tickPlunger(state, RELEASE, CONFIG);
    expect(fired.fired).toBe(true);
    expect(fired.launchCharge).toBe(banked + PLUNGER_CHARGE_RATE);
  });

  it("throws away the charge on reset", () => {
    expect(resetPlunger()).toEqual(INITIAL_PLUNGER);
  });
});

describe("firing", () => {
  it("launches up the table, never down it", () => {
    const outcome = pullAndRelease(10);
    expect(outcome.fired).toBe(true);
    expect(outcome.launchVelocityY).toBeLessThan(0);
  });

  it("launches at full speed from a full pull", () => {
    const outcome = pullAndRelease(PLUNGER_CHARGE_TICKS);
    expect(outcome.launchCharge).toBe(PLUNGER_FULL_CHARGE);
    expect(outcome.launchVelocityY).toBe(-MAX_LAUNCH_SPEED);
  });

  it("scales the launch linearly with charge", () => {
    expect(launchSpeedFor(0, CONFIG)).toBe(MIN_LAUNCH_SPEED);
    expect(launchSpeedFor(PLUNGER_FULL_CHARGE, CONFIG)).toBe(MAX_LAUNCH_SPEED);
    expect(launchSpeedFor(PLUNGER_FULL_CHARGE / 2, CONFIG)).toBe(
      MIN_LAUNCH_SPEED + (MAX_LAUNCH_SPEED - MIN_LAUNCH_SPEED) / 2,
    );
    expect(launchSpeedFor(PLUNGER_FULL_CHARGE / 4, CONFIG)).toBe(
      MIN_LAUNCH_SPEED + (MAX_LAUNCH_SPEED - MIN_LAUNCH_SPEED) / 4,
    );
  });

  it("is monotonic in charge and never leaves the configured range", () => {
    let previous = -1;
    for (let charge = 0; charge <= PLUNGER_FULL_CHARGE; charge += 1) {
      const speed = launchSpeedFor(charge, CONFIG);
      expect(speed).toBeGreaterThanOrEqual(previous);
      expect(speed).toBeGreaterThanOrEqual(MIN_LAUNCH_SPEED);
      expect(speed).toBeLessThanOrEqual(MAX_LAUNCH_SPEED);
      previous = speed;
    }
  });

  it("clamps a charge outside the legal range instead of extrapolating", () => {
    expect(launchSpeedFor(-5000, CONFIG)).toBe(MIN_LAUNCH_SPEED);
    expect(launchSpeedFor(PLUNGER_FULL_CHARGE * 10, CONFIG)).toBe(MAX_LAUNCH_SPEED);
  });

  it("gives a longer pull a faster launch", () => {
    const gentle = pullAndRelease(2);
    const firm = pullAndRelease(10);
    const full = pullAndRelease(PLUNGER_CHARGE_TICKS);
    expect(gentle.launchVelocityY).toBeGreaterThan(firm.launchVelocityY);
    expect(firm.launchVelocityY).toBeGreaterThan(full.launchVelocityY);
  });

  it("empties the spring when it fires", () => {
    const outcome = pullAndRelease(10);
    expect(outcome.state.charge).toBe(0);
    expect(outcome.state.pulling).toBe(false);
  });

  it("keeps the velocity inside the signed 16-bit range the integrator accepts", () => {
    const outcome = pullAndRelease(PLUNGER_CHARGE_TICKS);
    expect(Number.isInteger(outcome.launchVelocityY)).toBe(true);
    expect(outcome.launchVelocityY).toBeGreaterThanOrEqual(-32767);
  });
});

describe("firing exactly once", () => {
  it("ignores a second release after the plunger has already fired", () => {
    const fired = pullAndRelease(10);
    expect(fired.fired).toBe(true);

    const again = tickPlunger(fired.state, RELEASE, CONFIG);
    expect(again.fired).toBe(false);
    expect(again.launchVelocityY).toBe(0);
    expect(again.launchCharge).toBe(0);
    expect(again.state.charge).toBe(0);
  });

  it("ignores a release that no press ever preceded", () => {
    const outcome = tickPlunger(INITIAL_PLUNGER, RELEASE, CONFIG);
    expect(outcome.fired).toBe(false);
    expect(outcome.state.pulling).toBe(false);
    expect(outcome.state.charge).toBe(0);
  });

  it("fires once per pull however many ticks pass in between", () => {
    let state = INITIAL_PLUNGER;
    let fires = 0;
    for (let tick = 0; tick < 200; tick += 1) {
      // One pull: press at tick 0, release at tick 40, then silence.
      const input: PlungerInput =
        tick === 0 ? PRESS : tick < 40 ? HOLD : tick === 40 ? RELEASE : PLUNGER_IDLE;
      const outcome = tickPlunger(state, input, CONFIG);
      if (outcome.fired) fires += 1;
      state = outcome.state;
    }
    expect(fires).toBe(1);
  });

  it("cannot bank a second full launch by re-grabbing after a release", () => {
    // Full pull, then a release-and-immediate-regrab inside one tick. The new
    // pull must start from nothing, not from the charge just spent.
    let state = INITIAL_PLUNGER;
    for (let tick = 0; tick < PLUNGER_CHARGE_TICKS; tick += 1) {
      state = tickPlunger(state, tick === 0 ? PRESS : HOLD, CONFIG).state;
    }
    const fired = tickPlunger(state, { pressed: true, released: true, held: true }, CONFIG);
    expect(fired.fired).toBe(true);
    expect(fired.launchCharge).toBe(PLUNGER_FULL_CHARGE);
    expect(fired.state.charge).toBe(0);
    // Still pulling, because the key is down again at the sample point.
    expect(fired.state.pulling).toBe(true);

    const next = tickPlunger(fired.state, RELEASE, CONFIG);
    expect(next.launchCharge).toBe(PLUNGER_CHARGE_RATE);
    expect(next.launchVelocityY).toBeGreaterThan(-MAX_LAUNCH_SPEED);
  });
});

describe("taps shorter than a tick", () => {
  it("still fires when the press and the release land in the same tick", () => {
    const outcome = tickPlunger(INITIAL_PLUNGER, { pressed: true, released: true, held: false });
    expect(outcome.fired).toBe(true);
    expect(outcome.launchCharge).toBe(PLUNGER_CHARGE_RATE);
    expect(outcome.launchVelocityY).toBeLessThan(0);
  });

  it("fires a tap feebly, not at full power", () => {
    const tap = tickPlunger(INITIAL_PLUNGER, { pressed: true, released: true, held: false });
    const full = pullAndRelease(PLUNGER_CHARGE_TICKS);
    expect(-tap.launchVelocityY).toBeLessThan(-full.launchVelocityY / 4);
    expect(-tap.launchVelocityY).toBeGreaterThanOrEqual(MIN_LAUNCH_SPEED);
  });

  it("leaves the plunger idle afterwards, ready for a fresh pull", () => {
    const tap = tickPlunger(INITIAL_PLUNGER, { pressed: true, released: true, held: false });
    expect(tap.state).toEqual(INITIAL_PLUNGER);
  });
});

describe("config validation", () => {
  it("accepts the shipped config", () => {
    expect(validatePlungerConfig(CONFIG)).toBe(CONFIG);
  });

  it("rejects a charge rate that would never fill or would fill backwards", () => {
    expect(() => validatePlungerConfig({ ...CONFIG, chargeRate: 0 })).toThrow(/chargeRate/);
    expect(() => validatePlungerConfig({ ...CONFIG, chargeRate: -8 })).toThrow(/chargeRate/);
    expect(() => validatePlungerConfig({ ...CONFIG, chargeRate: 1.5 })).toThrow(/chargeRate/);
  });

  it("rejects a launch range that runs the wrong way", () => {
    expect(() => validatePlungerConfig({ ...CONFIG, minLaunchSpeed: -1 })).toThrow(/minLaunch/);
    expect(() =>
      validatePlungerConfig({ ...CONFIG, minLaunchSpeed: 5000, maxLaunchSpeed: 100 }),
    ).toThrow(/maxLaunchSpeed/);
  });

  it("honours a slower custom charge rate", () => {
    const slow: PlungerConfig = { ...CONFIG, chargeRate: 8 };
    expect(chargeTicksToFull(slow)).toBe(128);
    expect(pullAndRelease(127, slow).launchCharge).toBe(PLUNGER_FULL_CHARGE);
    expect(pullAndRelease(10, slow).launchCharge).toBeLessThan(PLUNGER_FULL_CHARGE);
  });
});

describe("determinism", () => {
  it("produces bit-identical outcomes for the same input sequence", () => {
    const script: PlungerInput[] = [];
    for (let tick = 0; tick < 120; tick += 1) {
      const held = tick % 17 < 9;
      const previousHeld = tick > 0 && (tick - 1) % 17 < 9;
      script.push({ pressed: held && !previousHeld, released: !held && previousHeld, held });
    }

    const run = (): readonly PlungerOutcome[] => {
      let state = INITIAL_PLUNGER;
      const outcomes: PlungerOutcome[] = [];
      for (const input of script) {
        const outcome = tickPlunger(state, input, CONFIG);
        outcomes.push(outcome);
        state = outcome.state;
      }
      return outcomes;
    };

    expect(run()).toEqual(run());
  });

  it("keeps every value an integer", () => {
    let state = INITIAL_PLUNGER;
    for (let tick = 0; tick < 200; tick += 1) {
      const outcome = tickPlunger(state, tick % 30 === 29 ? RELEASE : HOLD, CONFIG);
      expect(Number.isInteger(outcome.state.charge)).toBe(true);
      expect(Number.isInteger(outcome.launchVelocityY)).toBe(true);
      state = outcome.state;
    }
  });
});

describe("serving and launching a ball", () => {
  it("puts a motionless ball at the serve point", () => {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    expect(ball.x).toBe(CONFIG.serveX);
    expect(ball.y).toBe(CONFIG.serveY);
    expect(ball.velocityX).toBe(0);
    expect(ball.velocityY).toBe(0);
    expect(ball.active).toBe(true);
    expect(set.balls).toHaveLength(1);
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
    const outcome = pullAndRelease(10);
    expect(launchBall(ball, outcome)).toBe(true);
    expect(ball.velocityY).toBe(outcome.launchVelocityY);
    // Sideways rattle is the lane's business, not the plunger's.
    expect(ball.velocityX).toBe(-50);
  });

  it("does nothing when the plunger did not fire", () => {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    const idle = tickPlunger(INITIAL_PLUNGER, HOLD, CONFIG);
    expect(launchBall(ball, idle)).toBe(false);
    expect(ball.velocityY).toBe(0);
  });

  it("does nothing to a drained ball", () => {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    ball.active = false;
    expect(launchBall(ball, pullAndRelease(10))).toBe(false);
    expect(ball.velocityY).toBe(0);
  });
});

/**
 * The launch speeds only mean anything against real geometry, so this runs the
 * real integrator up the real Law 'n Justice lane. It asserts the two ends of
 * the range that the constants were chosen to hit — a full plunge reaches the
 * top of the channel, a tap barely moves — because those are the properties a
 * player would notice breaking, and they are what tie MAX_LAUNCH_SPEED to the
 * lane length rather than leaving it an arbitrary number.
 */
describe("launching up the real Law 'n Justice lane", () => {
  const MAP_PATH = fileURLToPath(
    new URL("../public/generated/tables/law-n-justice.map.json", import.meta.url),
  );
  const MAP: TableMap = parseTableMapDocument(
    JSON.parse(readFileSync(MAP_PATH, "utf8")) as TableMapDocument,
  );
  const MATERIALS = materialTableFor("law-n-justice");
  const GRAVITY: SimulationForces = {
    gravityY: PLUNGER_REFERENCE_GRAVITY,
    nudgeX: 0,
    nudgeY: 0,
  };

  /** Serves, lets the ball settle on the lane floor, launches, and follows it. */
  function launchAndTrack(outcome: PlungerOutcome, ticks: number): { minY: number; restY: number } {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    for (let tick = 0; tick < 30; tick += 1) {
      stepBalls(set, MAP, MATERIALS, GRAVITY);
    }
    const restY = q10ToPixel(ball.y);
    launchBall(ball, outcome);

    let minY = q10ToPixel(ball.y);
    for (let tick = 0; tick < ticks; tick += 1) {
      stepBalls(set, MAP, MATERIALS, GRAVITY);
      const y = q10ToPixel(ball.y);
      if (y < minY) minY = y;
    }
    return { minY, restY };
  }

  it("settles the served ball inside the lane instead of drifting out of it", () => {
    const { restY } = launchAndTrack(pullAndRelease(1), 1);
    expect(restY).toBeGreaterThan(q10ToPixel(CONFIG.serveY) - 4);
    expect(restY).toBeLessThan(LAW_N_JUSTICE_SHOOTER_LANE.bottomY);
  });

  it("sends a full plunge all the way to the top of the channel", () => {
    const { minY } = launchAndTrack(pullAndRelease(PLUNGER_CHARGE_TICKS), 200);
    // 26 rows of virtual top wall plus a ball radius is the highest a centre
    // can physically get on this table.
    expect(minY).toBeLessThan(60);
  });

  it("barely moves the ball on a sub-tick tap", () => {
    const tap = tickPlunger(INITIAL_PLUNGER, { pressed: true, released: true, held: false });
    const { minY, restY } = launchAndTrack(tap, 200);
    expect(minY).toBeGreaterThan(restY - 40);
    expect(minY).toBeLessThan(restY);
  });

  it("carries the ball further the longer the pull, monotonically", () => {
    const reach = [4, 10, 20, PLUNGER_CHARGE_TICKS].map(
      (ticks) => launchAndTrack(pullAndRelease(ticks), 200).minY,
    );
    for (let index = 1; index < reach.length; index += 1) {
      expect(reach[index]).toBeLessThan(reach[index - 1] as number);
    }
  });

  it("never drives a launched ball through a lane wall", () => {
    const set = createBallSet();
    const ball = serveBall(set, CONFIG);
    launchBall(ball, pullAndRelease(PLUNGER_CHARGE_TICKS));
    for (let tick = 0; tick < 300; tick += 1) {
      stepBalls(set, MAP, MATERIALS, GRAVITY);
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

describe("the reference constants", () => {
  it("keeps the launch ceiling above the speed the lane length demands", () => {
    // v^2/(2g) - v/2 >= lane travel, with the launch applied before the first
    // gravity step. If gravity is ever re-measured this is the check that
    // catches a full plunge quietly failing to clear the lane.
    const travel = pixelsToQ10(
      q10ToPixel(CONFIG.serveY) - LAW_N_JUSTICE_SHOOTER_LANE.topY,
    );
    const g = PLUNGER_REFERENCE_GRAVITY;
    const rise = (MAX_LAUNCH_SPEED * MAX_LAUNCH_SPEED) / (2 * g) - MAX_LAUNCH_SPEED / 2;
    expect(rise).toBeGreaterThan(travel);
  });

  it("keeps the minimum launch too weak to clear the lane", () => {
    const travel = pixelsToQ10(
      q10ToPixel(CONFIG.serveY) - LAW_N_JUSTICE_SHOOTER_LANE.topY,
    );
    const g = PLUNGER_REFERENCE_GRAVITY;
    const rise = (MIN_LAUNCH_SPEED * MIN_LAUNCH_SPEED) / (2 * g) - MIN_LAUNCH_SPEED / 2;
    expect(rise).toBeLessThan(travel / 10);
  });

  it("expresses a full pull as 1.0 in Q10", () => {
    expect(PLUNGER_FULL_CHARGE).toBe(Q10_ONE);
  });
});
