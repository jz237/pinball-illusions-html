/**
 * The fix-round regression suite: one pin per dossier defect, at the dossier's
 * own acceptance criteria.
 *
 * Every test here is the direct descendant of a measured failure — the sweep
 * finding or reference capture is cited at each — and none of them may ever be
 * weakened: they are the record that the defect stayed fixed.
 *
 *   B1   flipper pass-through (161 bat-crossings-while-raised in 80 games)
 *   B1a  below-pivot gap squeeze
 *   B1b  visible bat embedding (218 events of centre <6 px from a raised axis)
 *   B1c  rest-bat stickiness
 *   B2   cradle confiscation (all 9 write-offs in 240 games were cradles)
 *   B3   facing-bumper trap (234M of a 235M score, 15,000+ tick stall)
 *   B5   tilt gating (coils dead, zones alive — the capture's split)
 */

import { describe, expect, it } from "vitest";

import type { BallState } from "../src/game/contracts.js";
import { Q10_ONE, pixelsToQ10, q10Multiply, q10ToPixel } from "../src/core/fixed-point.js";
import type { Q10 } from "../src/core/fixed-point.js";
import {
  createBall,
  createBallSet,
  spawnBall,
  stepBalls,
} from "../src/game/ball-physics.js";
import { BALL_RADIUS_PIXELS } from "../src/game/collision-probe.js";
import type { FlipperConfig, FlipperState, BallStart } from "../src/game/flippers.js";
import {
  FLIPPER_AT_REST,
  cosineUnits,
  flipperAngle,
  flipperConfigsFor,
  resolveFlipperContacts,
  sineUnits,
  tickFlipper,
  batRadiusAt,
} from "../src/game/flippers.js";
import { materialTableFor } from "../src/game/materials.js";
import { tableDevicesFor } from "../src/game/table-devices.js";
import { SIMULATION_GRAVITY, VELOCITY_CLAMP_Q10 } from "../src/game/timebase.js";
import {
  BALL_SEARCH_PULSES,
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { Game, InputSource } from "../src/browser/game-loop.js";
import { CONTROLS, IDLE_SNAPSHOT } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { mapFor } from "./table-fixtures.js";

const BALL_RADIUS: Q10 = pixelsToQ10(BALL_RADIUS_PIXELS);
const LEFT = flipperConfigsFor("law-n-justice")[0] as FlipperConfig;

// ---------------------------------------------------------------------------
// Harness: the game loop's own physics order, in miniature
// ---------------------------------------------------------------------------

/**
 * One tick exactly as `tickGame` orders it for a ball near a bat: capture the
 * start, integrate (gravity + straight motion here — the drop sites are open
 * space), then the SWEPT flipper resolve with the starts map. This is the
 * seam B1 lived in, so the harness must reproduce it rather than shortcut it.
 */
function sweptTick(
  balls: BallState[],
  config: FlipperConfig,
  state: FlipperState,
  held: boolean,
): { state: FlipperState; contacts: number } {
  const starts = new Map<number, BallStart>();
  for (const ball of balls) starts.set(ball.id, { x: ball.x, y: ball.y });
  const sweep = tickFlipper(config, state, held);
  for (const ball of balls) {
    if (!ball.active) continue;
    ball.velocityY = Math.min(VELOCITY_CLAMP_Q10, ball.velocityY + SIMULATION_GRAVITY);
    ball.x = (ball.x + ball.velocityX) | 0;
    ball.y = (ball.y + ball.velocityY) | 0;
  }
  const contacts = resolveFlipperContacts(balls, [sweep], BALL_RADIUS, null, undefined, starts);
  return { state: sweep.to, contacts: contacts.length };
}

/** Signed distance of a ball centre from the bat's axis, along the striking face. */
function faceOffset(config: FlipperConfig, state: FlipperState, ball: BallState): number {
  const angle = flipperAngle(config, state);
  const faceX = (-config.direction * sineUnits(angle)) | 0;
  const faceY = (config.direction * cosineUnits(angle)) | 0;
  return q10Multiply(ball.x - config.pivotX, faceX) + q10Multiply(ball.y - config.pivotY, faceY);
}

/** How far along the bat's axis a ball centre projects, from the pivot. Q10. */
function axisOffset(config: FlipperConfig, state: FlipperState, ball: BallState): number {
  const angle = flipperAngle(config, state);
  return (
    q10Multiply(ball.x - config.pivotX, cosineUnits(angle)) +
    q10Multiply(ball.y - config.pivotY, sineUnits(angle))
  );
}

/** The point on the striking face `alongPixels` out, one ball radius clear. */
function restingPoint(
  config: FlipperConfig,
  state: FlipperState,
  alongPixels: number,
): { x: Q10; y: Q10 } {
  const angle = flipperAngle(config, state);
  const axisX = cosineUnits(angle);
  const axisY = sineUnits(angle);
  const faceX = (-config.direction * axisY) | 0;
  const faceY = (config.direction * axisX) | 0;
  const along = pixelsToQ10(alongPixels);
  const standoff = batRadiusAt(config, along) + BALL_RADIUS;
  return {
    x: (config.pivotX + q10Multiply(along, axisX) + q10Multiply(standoff, faceX)) | 0,
    y: (config.pivotY + q10Multiply(along, axisY) + q10Multiply(standoff, faceY)) | 0,
  };
}

/** A raised bat, parked at the top of its stroke with no angular rate. */
function raised(config: FlipperConfig): FlipperState {
  return { stroke: config.sweep, rate: 0 };
}

/** The along-axis pixel of a bat column, for placing matrix drops. */
function alongAtColumn(config: FlipperConfig, state: FlipperState, column: number): number {
  const angle = flipperAngle(config, state);
  const axisX = cosineUnits(angle) / Q10_ONE;
  return Math.round((column - q10ToPixel(config.pivotX)) / axisX);
}

/** Drives controls from a script so a run is exactly reproducible. */
class ScriptedInput implements InputSource {
  private sequence = 0;
  private held = new Set<Control>();
  constructor(private readonly plan: (tick: number) => readonly Control[]) {}
  sample(): ControlSnapshot {
    const wanted = new Set(this.plan(this.sequence));
    const previous = this.held;
    this.held = wanted;
    this.sequence += 1;
    const controls = {} as Record<Control, ControlEdges>;
    for (const control of CONTROLS) {
      const down = wanted.has(control);
      const was = previous.has(control);
      controls[control] = {
        down,
        pressed: down && !was,
        released: !down && was,
        pressCount: down && !was ? 1 : 0,
        releaseCount: !down && was ? 1 : 0,
      };
    }
    return { sequence: this.sequence, controls };
  }
}

const idle: InputSource = { sample: () => IDLE_SNAPSHOT };

// ---------------------------------------------------------------------------
// B1: the drop matrix
// ---------------------------------------------------------------------------

describe("B1: the static-bat drop matrix", () => {
  // The dossier's acceptance run, verbatim: impact columns {95, 115, 125},
  // speeds 8..16 px/tick, raised and resting — the exact cells the sweep
  // proved TRANSPARENT (raised at 13/15 @ x95, 12 @ x115, 9/13/15/16 @ x125;
  // resting at 13..16). Zero pass-throughs, zero embeddings.

  function dropMatrix(state: FlipperState, held: boolean, columns: readonly number[]): void {
    for (const column of columns) {
      for (let speed = 8; speed <= 16; speed += 1) {
        const along = alongAtColumn(LEFT, state, column);
        const rest = restingPoint(LEFT, state, along);
        // Two ticks of approach above the touch point, arriving at ~`speed`.
        const ball = createBall(
          0,
          rest.x,
          (rest.y - pixelsToQ10(2 * speed) - 512) | 0,
          0,
          pixelsToQ10(speed) - SIMULATION_GRAVITY,
        );
        let bat = state;
        let contacts = 0;
        for (let tick = 0; tick < 40; tick += 1) {
          const out = sweptTick([ball], LEFT, bat, held);
          bat = out.state;
          contacts += out.contacts;

          const alongNow = axisOffset(LEFT, bat, ball);
          const inSpan = alongNow > -BALL_RADIUS && alongNow < LEFT.length + BALL_RADIUS;
          if (inSpan) {
            // NEVER on the wrong side of the bat while over it: the crossing
            // that the endpoint-only test waved through. One pixel of grace
            // for the resting bat's rounded underside near the tip.
            expect(
              faceOffset(LEFT, bat, ball),
              `x=${column} speed=${speed} ${held ? "raised" : "resting"} crossed the bat on tick ${tick}`,
            ).toBeGreaterThan(-Q10_ONE);
            // NEVER embedded: B1b's detector was "centre <6 px from the
            // axis"; the post-tick state must always be a resolved one.
            expect(
              faceOffset(LEFT, bat, ball),
              `x=${column} speed=${speed} ${held ? "raised" : "resting"} embedded on tick ${tick}`,
            ).toBeGreaterThan(pixelsToQ10(6));
          }
        }
        expect(
          contacts,
          `x=${column} speed=${speed} ${held ? "raised" : "resting"}: the bat never touched the ball at all`,
        ).toBeGreaterThan(0);
      }
    }
  }

  it("a fully-raised bat stops every drop from 8 to 16 px/tick", () => {
    dropMatrix(raised(LEFT), true, [95, 115, 125]);
  });

  it("a resting bat stops or carries every drop from 8 to 16 px/tick", () => {
    // 125 sits past the resting bat's tip column (124), so the matrix runs the
    // two columns that are ON the bat; the tip cell is the raised matrix's.
    dropMatrix(FLIPPER_AT_REST, false, [95, 110]);
  });

  it("stops the census evidence ball: 12.5 px/tick into a raised bat", () => {
    // The B1 trace, verbatim: census/40 ball 0, t237 (103.6, 535.4)
    // v = (2305, 12427) with the left bat at stroke 1.00 — it crossed 22.5 px
    // in one tick and drained. Now it must meet the bat and bounce.
    const ball = createBall(0, Math.round(103.6 * 1024), Math.round(535.4 * 1024), 2305, 12427);
    let bat = raised(LEFT);
    let contacts = 0;
    for (let tick = 0; tick < 6; tick += 1) {
      const out = sweptTick([ball], LEFT, bat, true);
      bat = out.state;
      contacts += out.contacts;
      expect(ball.y, `sank under the raised bat on tick ${tick}`).toBeLessThan(pixelsToQ10(566));
    }
    expect(contacts).toBeGreaterThan(0);
    // Bounced: moving up, off a bat whose restitution is the measured 460.
    expect(ball.velocityY).toBeLessThan(0);
  });

  it("B1a: the below-pivot gap squeeze is impossible", () => {
    // Sweep finding #7: a ball crossed the raised bat diagonally at the
    // velocity clamp and was recorded at (107.6, 556.4) -> (91.8, 575.5),
    // BELOW the pivot, then surfed the drain row. The recorded tick began
    // after the crossing, so the regression replays the APPROACH: the same
    // clamp-speed diagonal, started above the bat, must resolve on the top
    // face on every tick — the squeeze under the boss can never happen.
    const ball = createBall(
      0,
      pixelsToQ10(114),
      pixelsToQ10(532),
      -VELOCITY_CLAMP_Q10,
      VELOCITY_CLAMP_Q10,
    );
    let bat = raised(LEFT);
    let sawSpan = 0;
    for (let tick = 0; tick < 8; tick += 1) {
      bat = sweptTick([ball], LEFT, bat, true).state;
      const alongNow = axisOffset(LEFT, bat, ball);
      if (alongNow > -BALL_RADIUS && alongNow < LEFT.length + BALL_RADIUS) {
        sawSpan += 1;
        expect(
          faceOffset(LEFT, bat, ball),
          `under the raised bat on tick ${tick}`,
        ).toBeGreaterThan(0);
      }
    }
    expect(sawSpan, "the diagonal never crossed the bat's span at all").toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// B1c + B2: the cradle
// ---------------------------------------------------------------------------

describe("B2: cradling on a raised bat, in the real game", () => {
  /** A started Law 'n Justice game with the ball placed above the raised left bat. */
  function cradleGame(): Game {
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(game);
    runTicks(game, idle, 60);
    // Free the served ball from the rod and hand it to the bats.
    game.laneBallId = null;
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball !== undefined) {
      ball.x = pixelsToQ10(100);
      ball.y = pixelsToQ10(530);
      ball.velocityX = 0;
      ball.velocityY = 0;
      ball.level = 0;
    }
    return game;
  }

  it("holds a cradled ball stable, unpulsed and unconfiscated, indefinitely", () => {
    // The reference: a raised left bat cradles the returning ball rock-stable
    // for ~80 frames, zero jitter, no ball-search (BabeWatch take2
    // f1494-1574). The sweep's counter-evidence: 1098 jitter events, coil
    // pulses at ±14,000 Q10, and ALL NINE write-offs in 240 games were cradle
    // confiscations. The hold below is five search windows long — the old
    // machine would have pulsed at one and confiscated after three.
    const game = cradleGame();
    const holding = new ScriptedInput(() => ["leftFlipper"]);

    // Let it land and settle on the raised bat.
    runTicks(game, holding, 200);
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball === undefined) return;
    expect(ball.active).toBe(true);

    const anchorX = q10ToPixel(ball.x);
    const anchorY = q10ToPixel(ball.y);
    let excursion = 0;
    const reports = runTicks(game, holding, 2600);
    excursion = Math.max(
      Math.abs(q10ToPixel(ball.x) - anchorX),
      Math.abs(q10ToPixel(ball.y) - anchorY),
    );

    // Still ours: never drained, never written off, never swallowed.
    expect(reports.flatMap((r) => r.drained)).toEqual([]);
    expect(reports.flatMap((r) => r.writtenOff)).toEqual([]);
    expect(reports.flatMap((r) => r.swallowed)).toEqual([]);
    expect(ball.active).toBe(true);
    // Never coil-pulsed: the search spent nothing on it.
    expect(debugSnapshot(game).searchPulses).toBe(BALL_SEARCH_PULSES);
    // And STABLE — the B1b/B1c acceptance. The sweep's jitter spikes were
    // ±5 px flings; a real cradle breathes under a pixel.
    expect(excursion, `cradled ball wandered ${excursion}px`).toBeLessThanOrEqual(2);
    // Resting on the bat, not inside it: at least the bat's own surface
    // clearance from the axis.
    expect(faceOffset(LEFT, raised(LEFT), ball)).toBeGreaterThan(pixelsToQ10(10));
  });

  it("releases the cradle when the button comes up", () => {
    const game = cradleGame();
    const holding = new ScriptedInput(() => ["leftFlipper"]);
    runTicks(game, holding, 400);
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball === undefined) return;
    const heldY = q10ToPixel(ball.y);

    // Drop the bat: the ball must leave the cradle — it is the player's to
    // lose again, not the machine's to keep.
    const reports = runTicks(game, idle, 400);
    const movedOff =
      !ball.active ||
      Math.abs(q10ToPixel(ball.y) - heldY) > 12 ||
      reports.some((r) => r.drained.length > 0);
    expect(movedOff, "the ball never left the dropped bat").toBe(true);
    // And whatever happened, it was never a search write-off.
    expect(reports.flatMap((r) => r.writtenOff)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B3: the facing-bumper trap
// ---------------------------------------------------------------------------

describe("B3: the Extreme Sports facing-bumper pinch", () => {
  it("escapes the pinch within a few hundred ticks, with awards bounded", () => {
    // Sweep finding: ball pinned between bumpers 16/17 at (264-276, 243-248),
    // velocity flipping ±(10868, 4370) for >15,000 ticks, 2342+2339 awards =
    // 234M of the game's 235M score. Reproduced on this exact state, the old
    // Coulomb tangential rule held the ball in the box beyond 3000 ticks;
    // the original's own per-contact decay (1/16+1, 0xB644-0xB660) lets the
    // convex rims amplify the drift gravity feeds in, and the ball walks out.
    const map = mapFor("extreme-sports");
    const materials = materialTableFor("extreme-sports");
    const devices = tableDevicesFor("extreme-sports");
    const forces = { gravityY: SIMULATION_GRAVITY, nudgeX: 0, nudgeY: 0 };

    for (const [vx, vy] of [
      [10868, 4370],
      [-10868, -4370],
    ] as const) {
      const set = createBallSet();
      const ball = spawnBall(set, pixelsToQ10(270), pixelsToQ10(245), vx, vy, 0);
      let lastInBox = 0;
      for (let tick = 0; tick < 1200 && ball.active; tick += 1) {
        stepBalls(set, map, materials, forces, { surfaces: devices });
        const px = q10ToPixel(ball.x);
        const py = q10ToPixel(ball.y);
        if (px >= 258 && px <= 284 && py >= 235 && py <= 258) lastInBox = tick;
      }
      // "Resolves within a few hundred ticks" — the dossier's acceptance.
      expect(lastInBox, `v0=(${vx},${vy}) still in the pinch`).toBeLessThan(500);
    }
  });

  it("still pops: a bumper returns a slow ball far faster than it arrived", () => {
    // The decay must not have neutered the kick itself: the measured law is
    // exit = (89/256) x (v_in + 5500 units) along the contact normal.
    const map = mapFor("extreme-sports");
    const materials = materialTableFor("extreme-sports");
    const devices = tableDevicesFor("extreme-sports");
    const weightless = { gravityY: 0, nudgeX: 0, nudgeY: 0 };
    const set = createBallSet();
    // Dropped straight down onto the crown of bumper 16 (223-257, 215-249).
    const ball = spawnBall(set, pixelsToQ10(240), pixelsToQ10(200), 0, 1200, 0);
    let best = 0;
    for (let tick = 0; tick < 30; tick += 1) {
      stepBalls(set, map, materials, weightless, { surfaces: devices });
      if (-ball.velocityY > best) best = -ball.velocityY;
    }
    expect(best).toBeGreaterThan(1200);
  });
});

// ---------------------------------------------------------------------------
// B5: what tilt kills, and what it must not
// ---------------------------------------------------------------------------

describe("B5: tilt gates the coils and only the coils", () => {
  const TILTED = Object.freeze({ warning: 400, tilted: true, cooldown: 0 });

  it("a tilted bumper keeps its restitution but loses its kick", () => {
    // The original gates the bumper latch at +0x00B216 on the tilt flag: no
    // kick, no award — but the surface-row load runs before the gate, so the
    // face still bounces at 89/256. Physics-level check on the real table.
    const map = mapFor("extreme-sports");
    const materials = materialTableFor("extreme-sports");
    const devices = tableDevicesFor("extreme-sports");
    const weightless = { gravityY: 0, nudgeX: 0, nudgeY: 0 };

    // Fast enough that the passive bounce clears the rest threshold: at the
    // bumper row's 89/256 restitution a 4000 Q10 arrival returns ~1390.
    const drop = (poweredKicksLive: boolean): number => {
      const set = createBallSet();
      const ball = spawnBall(set, pixelsToQ10(240), pixelsToQ10(190), 0, 4000, 0);
      let best = 0;
      for (let tick = 0; tick < 30; tick += 1) {
        stepBalls(set, map, materials, weightless, { surfaces: devices, poweredKicksLive });
        if (-ball.velocityY > best) best = -ball.velocityY;
      }
      return best;
    };

    const live = drop(true);
    const tilted = drop(false);
    // Powered: the coil throws it back harder than it arrived.
    expect(live).toBeGreaterThan(4000);
    // Tilted: an ordinary bounce — some return, never more than it brought.
    expect(tilted).toBeGreaterThan(0);
    expect(tilted).toBeLessThan(4000);
  });

  it("no bumper or slingshot awards while tilted; zone awards keep landing", () => {
    // The capture's split, twice over: ES ball 2 accrued +50,000 flipper-dead
    // behind the TILT banner (zone/device awards live), while the disassembly
    // shows the bumper/sling award latches skipped. A tilted game is driven
    // over a real trigger zone and a real bumper and the award lists must
    // split exactly that way.
    const game = createGame(mapFor("extreme-sports"), { ballsPerGame: 3 });
    startGame(game);
    runTicks(game, idle, 60);
    game.laneBallId = null;
    game.tilt = TILTED;

    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball === undefined) return;

    // A long tilted descent through the bumper cluster.
    ball.x = pixelsToQ10(270);
    ball.y = pixelsToQ10(200);
    ball.velocityX = 0;
    ball.velocityY = 2000;
    ball.level = 0;

    const reports = runTicks(game, idle, 800);
    const awards = reports.flatMap((r) => r.awards);
    const powered = awards.filter((a) => a.source === "bumper" || a.source === "slingshot");
    expect(powered, `powered awards while tilted: ${powered.map((a) => a.id).join(" ")}`).toEqual(
      [],
    );
    // The rest of the table still scores on the way down: the run crosses
    // zone rectangles and the machine must keep paying them.
    const zoned = awards.filter((a) => a.source === "zone" || a.source === "device");
    expect(zoned.length, "nothing but the coils may go dead under tilt").toBeGreaterThan(0);
  });

  it("wipes the machine's serve queue every tilted tick", () => {
    // State 8 runs `clr.w $D86(a5)` each frame: machine-owed balls die with
    // the tilt. Player-owed balls are a different counter and survive.
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(game);
    runTicks(game, idle, 60);
    game.pendingServes = 2;
    game.tilt = TILTED;
    runTicks(game, idle, 1);
    expect(game.pendingServes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B4: the BabeWatch return path
// ---------------------------------------------------------------------------

describe("B4: BabeWatch's untouched launch returns within the flippers' reach", () => {
  it("crosses the flipper band between the pivots and drains the middle", () => {
    // The sweep's finding: 175 of 235 BW drains crossed the flipper row at
    // x=72-73 — forty pixels LEFT of the left pivot at 112, with both strokes
    // at 0. One deterministic, unsavable path, every launch, every seed.
    //
    // The reference (session 2): the untouched return comes down the RIGHT
    // channel, crosses to the left, dribbles down through the flipper region
    // and CENTRE-drains — and a raised left bat can cradle it on the way.
    //
    // The invented charge plunger was the cause: at the measured fixed kick
    // the return path now runs right side -> cross to the left -> flipper
    // band at x~161, between the two pivots, centre drain — the capture's
    // structure. What is pinned is the savability property: the untouched
    // ball must cross the bats' row INSIDE the pivots' span, never down the
    // far-left channel, and it must reach the drain itself rather than being
    // written off.
    const game = createGame(mapFor("babewatch"), { ballsPerGame: 3 });
    startGame(game);
    const input = new ScriptedInput((t) => (t === 60 ? ["plunger"] : []));

    let crossedAt = -1;
    let drained = false;
    let retired = false;
    for (let tick = 0; tick < 4000 && !drained; tick += 1) {
      const report = runTicks(game, input, 1)[0];
      if ((report?.drained.length ?? 0) > 0) {
        drained = true;
        retired = (report?.writtenOff.length ?? 0) > 0;
        break;
      }
      const state = debugSnapshot(game);
      const ball = state.balls.find((b) => b.active && b.id !== state.laneBallId);
      if (ball === undefined) continue;
      if (crossedAt < 0 && ball.pixelY >= 545 && ball.pixelY <= 560) crossedAt = ball.pixelX;
    }

    expect(drained, "the untouched ball never drained at all").toBe(true);
    expect(retired, "the ball was written off, not drained").toBe(false);
    expect(crossedAt, "the ball never crossed the flipper band").toBeGreaterThan(112);
    expect(crossedAt).toBeLessThan(227);
  });
});
