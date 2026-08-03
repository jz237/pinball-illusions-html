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
  DEFAULT_SIMULATION_OPTIONS,
  createBall,
  createBallSet,
  reflectVelocity,
  spawnBall,
  stepBalls,
} from "../src/game/ball-physics.js";
import { BUMPER_KICK, SLINGSHOT_KICK, surfaceResponseFor } from "../src/game/surface-physics.js";
import { BALL_RADIUS_PIXELS, cosineUnits, sineUnits } from "../src/game/collision-probe.js";
import type { FlipperConfig, FlipperState, BallStart } from "../src/game/flippers.js";
import {
  FLIPPER_AT_REST,
  flipperAngle,
  flipperConfigsFor,
  resolveFlipperContacts,
  tickFlipper,
  batRadiusAt,
} from "../src/game/flippers.js";
import { materialTableFor } from "../src/game/materials.js";
import { tableDevicesFor } from "../src/game/table-devices.js";
import { SIMULATION_GRAVITY, VELOCITY_CLAMP_Q10 } from "../src/game/timebase.js";
import {
  BALL_SEARCH_PULSES,
  BALL_SEARCH_TICKS,
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { Game, InputSource } from "../src/browser/game-loop.js";
import { CONTROLS, IDLE_SNAPSHOT } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { devicesFor, flipperBatsFixture, mapFor } from "./table-fixtures.js";
import { ballLocksFor } from "../src/game/ball-locks.js";
import type { BallLock } from "../src/game/ball-locks.js";

// The bats collide on the pixels their poses draw, so the pose bank has to be
// registered before any of these harnesses runs — B1's drop matrix calls
// `resolveFlipperContacts` straight, with no game to have loaded it for them.
flipperBatsFixture();

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
// The upper-bat pocket stall: rest-bat contact must not blind the search
// ---------------------------------------------------------------------------

describe("the ball search reaches a ball wedged against the RESTING upper bat", () => {
  // Census finding, exact-contacts round: two Law 'n Justice games stalled
  // forever with a ball at rest in the map pockets flanking the upper bat
  // (pivot (37,302), level 0). The ball sat at velocity exactly (0,0) for
  // 3,000+ ticks with `stillTicks` pinned at 0, because the bat's REST pose
  // is in mask contact with both pockets on every tick and any bat contact
  // used to make a ball cradle-exempt — `live.length === 0` in
  // `runBallSearch` reset the clock 3,000 times out of 3,000. The exemption
  // is now scoped to bats the player is DRIVING (button down or stroke off
  // rest), and while every free ball is in a driven bat's grip the clock
  // FREEZES rather than resets, so a blind flip cadence through the wedged
  // ball cannot hold the clock under its own beat forever either.
  const SITES = [
    [24, 304],
    [41, 339],
  ] as const;

  /** A started game with its one ball placed at rest in the named pocket. */
  function wedgedGame(x: number, y: number): Game {
    const game = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(game);
    runTicks(game, idle, 60);
    game.laneBallId = null;
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball !== undefined) {
      ball.x = pixelsToQ10(x);
      ball.y = pixelsToQ10(y);
      ball.velocityX = 0;
      ball.velocityY = 0;
      ball.level = 0;
    }
    return game;
  }

  for (const [x, y] of SITES) {
    it(`(${x},${y}): the stillness clock runs and the first window pulses`, () => {
      const game = wedgedGame(x, y);
      // The defect's signature was stillTicks pinned at 0 by the resting
      // bat's contact. It must accumulate now.
      runTicks(game, idle, 100);
      expect(debugSnapshot(game).stillTicks).toBeGreaterThan(90);
      // ... and the first expiry must spend a coil pulse on the wedged ball.
      runTicks(game, idle, BALL_SEARCH_TICKS - 100 + 20);
      expect(debugSnapshot(game).searchPulses).toBeLessThan(BALL_SEARCH_PULSES);
    });

    it(`(${x},${y}): the wedged ball is rescued and the game moves on`, () => {
      const game = wedgedGame(x, y);
      // Four windows and settling slack — enough for the full pulse budget
      // and a write-off if the pocket defeats every pulse. Measured: the
      // pulses free the ball at both sites and it drains as an ordinary
      // ball-end (idle: 3 pulses at (24,304), 1 at (41,339); census game 14
      // rescued with a single pulse at t1696 and ran to game-over).
      runTicks(game, idle, 6 * BALL_SEARCH_TICKS);
      const end = debugSnapshot(game);
      expect(end.ballsServed, "the stalled ball never ended").toBeGreaterThanOrEqual(2);
    });
  }
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


// ---------------------------------------------------------------------------
// ROUND 5
// ---------------------------------------------------------------------------

describe("R5a: the contact response is the original's, arithmetic for arithmetic", () => {
  // The round-5 root cause and its proof. The responder at main.seg00 body
  // +0x00B54C runs its tests in a FIXED ORDER - graze `$34`, minimum impact
  // `$38`, coil, restitution `$36` - and then one tangential rule at +0x00B626.
  // This port used to charge Coulomb friction on the whole tangential speed at
  // every contact and to gate the graze on the contact having bounced, which
  // cost 15-48% of the ball's speed at obliquities the original charges nothing
  // for. The sites below are the two the round-5 audit named on BabeWatch's
  // top-right channel, and the expected numbers are computed BY HAND from the
  // decoded constants: they assert that the port and the machine agree at a
  // contact, not merely that the port is self-consistent.

  /** One reflection off a given surface id, in a nine-line harness. */
  function reflectAt(
    surfaceId: number,
    velocity: { x: number; y: number },
    normal: { x: number; y: number },
    powered = false,
  ): { x: number; y: number } {
    const one = createBall(0, 0, 0, velocity.x, velocity.y);
    reflectVelocity(
      one,
      // A wall's material behaviour: on a map WITH a surface layer the
      // behaviour contributes nothing but its friction, and the surface row is
      // what the response is taken from.
      materialTableFor("babewatch").behaviourFor(1),
      normal.x,
      normal.y,
      DEFAULT_SIMULATION_OPTIONS.restThreshold,
      surfaceResponseFor(surfaceId, powered),
    );
    return { x: one.velocityX, y: one.velocityY };
  }

  it("takes the bounce at the wall foot, to the digit the disk predicts", () => {
    // BabeWatch (292,232): a ball rising at 10.48 px/tick meets the wall foot's
    // 45 degree chamfer, surface id 9 (restitution 102/256, graze limit 60,
    // slip divisor 23040). By hand, in the original's own velocity units:
    //   |vn| = |vt| = 10.48 * 0.707 = 7.41 px/t = 1897 units
    //   graze ratio 16 < 60, so the bounce IS taken
    //   normal out  = 1897 * 102/256 = 755 units
    //   tangential  = 1897 - 1897*160/23040 - 1 = 1883 units
    //   speed out   = sqrt(755^2 + 1883^2) = 2029 units = 7.93 px/tick
    const unit = Math.round(Q10_ONE * Math.SQRT1_2);
    const out = reflectAt(9, { x: 0, y: -10_734 }, { x: unit, y: unit });
    const speed = Math.hypot(out.x, out.y) / Q10_ONE;
    expect(speed).toBeGreaterThan(7.8);
    expect(speed).toBeLessThan(8.05);
    // And it turns the ball INTO the channel rather than back down it.
    expect(out.x).toBeGreaterThan(0);
    expect(out.y).toBeLessThan(0);
  });

  it("cancels a graze outright, keeping every unit of the along-surface speed", () => {
    // The same channel, ninety pixels higher: a ball running up the wall at
    // 7.5 px/tick with a normal component of about 1 has a ratio past the plain
    // wall's limit of 34. The original zeroes the normal component (`moveq
    // #0,d0` at +0x00B568) and branches past the restitution entirely.
    // Outward normal pointing LEFT: the ball is running up the right-hand wall
    // of the channel and pressing into it at 1000 Q10.
    const along = { x: 1000, y: -7600 };
    const before = Math.hypot(along.x, along.y);
    const out = reflectAt(13, along, { x: -1024, y: 0 });
    // The inward component is gone...
    expect(out.x).toBe(0);
    // ...and the along-surface speed is intact bar the decoded per-contact
    // decay, `(|vt| >> 12) + 1` in original units, which is four Q10.
    expect(Math.abs(out.y)).toBeGreaterThan(Math.abs(along.y) - 70);
    expect(Math.abs(out.y)).toBeLessThan(Math.abs(along.y));
    // For scale: the whole contact costs 1.5% of the ball's speed where the
    // Coulomb model this replaces charged 15% and up.
    expect(Math.hypot(out.x, out.y)).toBeGreaterThan(before * 0.97);
  });

  it("refuses to fire a coil on a graze, because the branch jumps past it", () => {
    // `bra.w $b626` skips the bumper and slingshot handlers outright, so a ball
    // sliding along a bumper's rim is not kicked by it.
    const out = reflectAt(16, { x: 200, y: -9000 }, { x: -1024, y: 0 }, true);
    expect(out.x).toBe(0);
    expect(Math.hypot(out.x, out.y)).toBeLessThan(9100);
    // Struck square, the same bumper fires: 5500 responder units — 2750 in the
    // ball's own, so 11,000 Q10 — added to the approach before the 89/256
    // restitution. 0.348 * (9000 + 11000) = 6,953 Q10 back out.
    const square = reflectAt(16, { x: 9000, y: 0 }, { x: -1024, y: 0 }, true);
    expect(square.x).toBe(-6953);
  });

  it("refuses a SLINGSHOT's along-face throw on a graze too, on every id", () => {
    // R6, and the pin the round-5 tree did not have. The test above uses bumper
    // id 16, whose `tangentKick` is zero by construction — `surface-physics.ts`
    // gives a tangential throw to slingshot ids only — so it cannot see the
    // defect it is named for. `add.w $6(a4),d2` at +0x00B5E6 is reachable ONLY
    // by falling through the slingshot's own threshold test at +0x00B5E0: the
    // graze (`bra.w $b626` at +0x00B56A), the `$38` gate (+0x00B576), a bumper
    // that fired (+0x00B5D2) and a slingshot contact under its threshold all
    // jump past it. Round 5 applied it on every contact with a slingshot id,
    // and a GRAZE therefore GAINED speed on the one path the original
    // guarantees is lossy.
    //
    // The exact regression: sling id 22, the left upper face, grazed along its
    // own surface.
    const grazing = { x: 1000, y: -7600 };
    const grazed = reflectAt(22, grazing, { x: -1024, y: 0 }, true);
    expect(grazed).toEqual({ x: 0, y: -7355 });
    expect(Math.hypot(grazed.x, grazed.y)).toBeLessThan(Math.hypot(grazing.x, grazing.y));

    // And the invariant behind it, over every id, because everything at
    // +0x00B626 — the `$3A` slip and the `(|vt|>>12)+1` decay — is
    // non-increasing: A GRAZE CAN ONLY COST. Checked on both powered and
    // unpowered tables so the tilted rows are covered as well.
    const velocities = [
      { x: 1000, y: -7600 },
      { x: -1000, y: -7600 },
      { x: 200, y: 9000 },
      { x: -3000, y: 3000 },
      { x: 6000, y: 200 },
      { x: 7000, y: -900 },
      { x: -8000, y: 300 },
    ];
    const normals = [
      { x: -1024, y: 0 },
      { x: 1024, y: 0 },
      { x: 0, y: -1024 },
      { x: 724, y: -724 },
      { x: -724, y: -724 },
    ];
    let grazes = 0;
    for (let id = 0; id < 256; id += 1) {
      const row = surfaceResponseFor(id).constants;
      for (const velocity of velocities) {
        for (const normal of normals) {
          const inward =
            Math.trunc((velocity.x * normal.x) / Q10_ONE) +
            Math.trunc((velocity.y * normal.y) / Q10_ONE);
          if (inward >= 0) continue;
          const tangentX = velocity.x - Math.trunc((inward * normal.x) / Q10_ONE);
          const tangentY = velocity.y - Math.trunc((inward * normal.y) / Q10_ONE);
          const tangent = Math.round(Math.hypot(tangentX, tangentY));
          if (Math.trunc((tangent * 16) / -inward) < row.grazeLimit) continue;
          grazes += 1;
          for (const powered of [true, false]) {
            const after = reflectAt(id, velocity, normal, powered);
            expect(
              Math.hypot(after.x, after.y),
              `id ${id} ${powered ? "live" : "tilted"} grazed at ` +
                `(${velocity.x},${velocity.y}) on (${normal.x},${normal.y})`,
            ).toBeLessThanOrEqual(Math.hypot(velocity.x, velocity.y));
          }
        }
      }
    }
    // The sweep has to actually have found grazes, or it proves nothing.
    expect(grazes).toBeGreaterThan(1000);
  });
});

describe("R5b: BabeWatch's top-right channel is climbable again", () => {
  it("carries a ball from the channel mouth to the corridor and pays both 50,000s", () => {
    // FILMED, session2/telemetry/trackbw1.csv f376-394: the ball crosses the top
    // of the table LEFTWARD from game x about 307 to about 205 at y 33-41.
    // DECODED: zone 0-20 (295,50)-(335,90) and zone 0-19 (250,20)-(280,60) pay
    // 50,000 each on the way across.
    //
    // ENTERED AT THE CHANNEL MOUTH RATHER THAN OFF THE LAUNCH, and that is a
    // MEASURED gap rather than a convenience — a TELEPORT, said plainly, and it
    // is still one after round 6. The untouched launch leaves the upper-ramp
    // lane at x=292, where the lane's own walls confine it to 290..292, and the
    // wall foot at (275-288, 223-231) needs x >= 295 to clear.
    //
    // ROUND 6 LOCATED THE SITE EXACTLY AND STILL COULD NOT CLOSE IT. The ball is
    // taken off the upper line by the shipped hand-off rectangle L1#3
    // (280,265)-(310,295) on the first frame its centre reaches y=295 — the
    // rectangle's BOTTOM edge, 19 rows above the ramp's own end at y=276, where
    // the tube has carried it only as far as x=292. Traced on this tree: L1 at
    // t46 (322,435), t54 (295,329), handed to L0 at t57 (292,294), clips the
    // wall foot at t66 and stalls at (322,167) with 30,000 on the board against
    // a filmed 790,000. Deferring that one rectangle to the ramp's end makes the
    // FILM appear — hand-off at (296,273) rising, zone 0-20 +50,000 at y=89,
    // the top crossed leftward to x=177, zone 0-19 +50,000 — but no decoded
    // mechanism has been found that keeps the ORIGINAL's ball out of the same
    // rectangle, and a shipped rectangle deferring to a reconstructed gate would
    // be an engine rule this project has no evidence for. It stays open, and
    // this test stays a channel test with a teleport in it.
    //
    // What is pinned here is the CHANNEL, which the graze rule made climbable
    // again: before it the ball stalled at (322,163), 120 rows below.
    const game = createGame(mapFor("babewatch"), { ballsPerGame: 3 });
    startGame(game);
    const input = new ScriptedInput((t) => (t === 40 ? ["plunger"] : []));
    let crossedLeftwardAt = -1;
    let reachedTop = false;
    for (let tick = 0; tick < 140; tick += 1) {
      if (tick === 62) {
        const one = game.balls.balls.find((each) => each.active);
        if (one !== undefined) {
          one.x = pixelsToQ10(298);
          one.y = pixelsToQ10(240);
        }
      }
      runTicks(game, input, 1);
      const state = debugSnapshot(game);
      const one = state.balls.find((each) => each.active);
      if (one === undefined) continue;
      if (one.pixelY <= 45) reachedTop = true;
      if (reachedTop && one.pixelX < 250 && crossedLeftwardAt < 0) crossedLeftwardAt = tick;
    }
    expect(reachedTop, "the ball never reached the top corridor").toBe(true);
    expect(crossedLeftwardAt, "the ball never ran leftward along the top").toBeGreaterThan(0);
    expect(debugSnapshot(game).score).toBeGreaterThanOrEqual(100_000);
  });
});

describe("R5c: every table's third bat is wired, level-gated and throws upfield", () => {
  it("gives all three tables three configs, and the upper one its own level", () => {
    for (const id of ["law-n-justice", "babewatch", "extreme-sports"] as const) {
      const configs = flipperConfigsFor(id);
      expect(configs).toHaveLength(3);
      const upper = configs[2] as FlipperConfig;
      expect(upper.id).toBe("upper");
      expect(upper.confidence).toBe("measured");
    }
    // Law 'n Justice's upper bat is on the MAIN level and the other two are on
    // the raised one: the records' +0x1C bank pointers, hunk2+0 against
    // hunk2+0x65B8. See UPPER_FLIPPER_RECORDS for how strong that reading is.
    expect((flipperConfigsFor("law-n-justice")[2] as FlipperConfig).level).toBe(0);
    expect((flipperConfigsFor("babewatch")[2] as FlipperConfig).level).toBe(1);
    expect((flipperConfigsFor("extreme-sports")[2] as FlipperConfig).level).toBe(1);
  });

  it("launches a ball off every upper bat, from every point of the face", () => {
    // The drop matrix for the third bats: a ball laid on the striking face is
    // LAUNCHED rather than dribbled, at five points along each bat.
    for (const id of ["law-n-justice", "babewatch", "extreme-sports"] as const) {
      const config = flipperConfigsFor(id)[2] as FlipperConfig;
      for (const alongPixels of [12, 18, 24, 30, 36]) {
        const seat = restingPoint(config, FLIPPER_AT_REST, alongPixels);
        const balls = [
          createBall(0, seat.x, seat.y, 0, 0, config.level),
        ];
        let state: FlipperState = FLIPPER_AT_REST;
        for (let tick = 0; tick < 6; tick += 1) {
          const sweep = tickFlipper(config, state, true);
          state = sweep.to;
          const one = balls[0] as BallState;
          one.velocityY += SIMULATION_GRAVITY;
          one.x = (one.x + one.velocityX) | 0;
          one.y = (one.y + one.velocityY) | 0;
          resolveFlipperContacts(balls, [sweep], BALL_RADIUS);
        }
        const one = balls[0] as BallState;
        const speed = Math.hypot(one.velocityX, one.velocityY);
        expect(speed, `${id} at ${alongPixels} px out`).toBeGreaterThan(Q10_ONE);
        expect(one.velocityY, `${id} at ${alongPixels} px out`).toBeLessThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// R6a: the responder's constants against the film
// ---------------------------------------------------------------------------

describe("R6a: the slingshot law reproduces the filmed exits", () => {
  /**
   * The face normal of a slingshot id, from the shipped surface-id raster.
   *
   * PCA over the id's own pixels — the minor axis of their covariance is the
   * face normal — so this is the MAP's answer and not a fitted one. It agrees
   * with what the probe ring converges on for a square contact, to inside the
   * 15-degree quantisation of the original's own 24-direction contact half-ring
   * at +0x00ACF2.
   */
  function faceNormal(id: number): { x: Q10; y: Q10 } {
    const devices = tableDevicesFor("law-n-justice");
    expect(devices).not.toBeNull();
    if (devices === null) return { x: 0, y: 0 };
    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = 0; y < 600; y += 1) {
      for (let x = 0; x < 336; x += 1) {
        if (devices.surfaceIdAt(0, x, y) === id) {
          xs.push(x);
          ys.push(y);
        }
      }
    }
    expect(xs.length, `surface id ${id} is on the map`).toBeGreaterThan(20);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = (xs[i] as number) - mx;
      const dy = (ys[i] as number) - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    const small = (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
    let nx = sxy;
    let ny = small - sxx;
    const length = Math.hypot(nx, ny) || 1;
    nx /= length;
    ny /= length;
    // Outward is toward the middle of the table: both slingshots face inward.
    if (mx < 336 / 2 !== nx > 0) {
      nx = -nx;
      ny = -ny;
    }
    return { x: Math.round(nx * Q10_ONE), y: Math.round(ny * Q10_ONE) };
  }

  function reflectOn(
    id: number,
    velocity: { x: number; y: number },
    normal: { x: Q10; y: Q10 },
  ): { x: number; y: number } {
    const one = createBall(0, 0, 0, velocity.x, velocity.y);
    reflectVelocity(
      one,
      materialTableFor("law-n-justice").behaviourFor(1),
      normal.x,
      normal.y,
      DEFAULT_SIMULATION_OPTIONS.restThreshold,
      surfaceResponseFor(id, true),
    );
    return { x: one.velocityX, y: one.velocityY };
  }

  it("lands inside one game px a frame of all four filmed slingshot junctions", () => {
    // FILMED, research/view/reference/analysis/fullgame_ball.csv through
    // passF_contacts.py: the four track junctions Law 'n Justice credits
    // +25,000 for, entry and exit velocities fitted at the window ends, in game
    // px per frame. The +25,000 is what identifies them — devices.json gives
    // slingshot indices 1 and 2 a score of 25,000 each, and the nearest other
    // awards on that table are 50,000 (ids 32/33) and 75,000 (34/35/36).
    //
    //   f453 -> f458   (-4.53, 0.40) 4.55  ->  ( 6.26,-2.38) 6.70   left,  id 23
    //   f473 -> f486   ( 6.25,-0.28) 6.26  ->  (-6.64,-3.05) 7.31   right, id 25
    //   f2090-> f2103  (-1.21, 0.02) 1.21  ->  ( 4.60,-1.54) 4.85   left,  id 23
    //   f2154-> f2155  (-7.14, 1.04) 7.22  ->  ( 5.79,-6.10) 8.41   left,  id 22
    //
    // THIS IS THE TEST THAT CHOOSES BETWEEN THE TWO READINGS OF `subi.w #$dac`.
    // At the constant as written — 3500 — the four exits come out 9.05, 11.12,
    // 11.63 and 12.38: an RMS of 4.23 px/f against the film and a FLAT +4.1 on
    // every one of them, which is exactly `0.598 * (3500-1750)/256`. At 1750,
    // the value the responder's own doubled contact frame makes it, they come
    // out 4.90, 6.99, 7.70 and 8.33 for an RMS of 0.25. The tolerance below is
    // 1.0 px/f: it clears the corrected law by 0.6 px/f and fails the round-5
    // one by nearly four times over on every single contact. Do not widen it —
    // the whole discriminating gap is 4 px/f.
    const junctions = [
      { label: "f2090->f2103", id: 23, entry: [-1.21, 0.02], filmed: 4.85 },
      { label: "f453->f458", id: 23, entry: [-4.53, 0.4], filmed: 6.7 },
      { label: "f473->f486", id: 25, entry: [6.25, -0.28], filmed: 7.31 },
      { label: "f2154->f2155", id: 22, entry: [-7.14, 1.04], filmed: 8.41 },
    ] as const;

    let sumSquared = 0;
    for (const junction of junctions) {
      const normal = faceNormal(junction.id);
      const out = reflectOn(
        junction.id,
        { x: Math.round(junction.entry[0] * Q10_ONE), y: Math.round(junction.entry[1] * Q10_ONE) },
        normal,
      );
      const speed = Math.hypot(out.x, out.y) / Q10_ONE;
      sumSquared += (speed - junction.filmed) ** 2;
      expect(
        Math.abs(speed - junction.filmed),
        `${junction.label} on sling id ${junction.id}: ${speed.toFixed(2)} against a filmed ` +
          `${junction.filmed}`,
      ).toBeLessThan(1.0);
      // And it comes off the face UPWARD, which is the whole point of a sling.
      expect(out.y, `${junction.label} exit direction`).toBeLessThan(0);
    }
    expect(Math.sqrt(sumSquared / junctions.length)).toBeLessThan(0.5);
  });

  it("puts the sling's exit floor under every filmed exit and the bumper's under the rattle", () => {
    // The two floors are where the law actually lives: as the approach goes to
    // zero the exit tends to `restitution * kick`, the SLOWEST a coil can throw
    // a ball. The film bounds both from above.
    expect(q10Multiply(SLINGSHOT_KICK, 612)).toBe(4184);
    expect(q10Multiply(BUMPER_KICK, 356)).toBe(3824);
    const slingFloor = q10Multiply(SLINGSHOT_KICK, 612) / Q10_ONE;
    const bumperFloor = q10Multiply(BUMPER_KICK, 356) / Q10_ONE;
    expect(slingFloor).toBeCloseTo(4.086, 3);
    expect(bumperFloor).toBeCloseTo(3.734, 3);
    for (const filmed of [4.85, 6.7, 7.31, 8.41]) expect(filmed).toBeGreaterThan(slingFloor);
    // And analysis/README.txt records the three-bumper cluster as a "slow
    // rattle, exits <= 6 px/f". A floor of 7.47 — which is what the doubled
    // constant gives — cannot produce an exit under 6 px/f at all.
    expect(bumperFloor).toBeLessThan(6);
  });
});

// ---------------------------------------------------------------------------
// R6b: the saucer gives the ball back where the machine says, not down the lane
// ---------------------------------------------------------------------------

describe("R6b: a lock ejects in place and cannot farm itself", () => {
  it("puts the ball at the record's own position, level and impulse", () => {
    // DECODED: +0x0070F6 writes the record's +$06/+$08 over the ball's position
    // words and its Q10 accumulators, +0x00710E adds the +$0A/+$0C impulse, and
    // +0x007128 jumps through +$0E into the zone list's own level handlers.
    // Nothing on that path goes near the trough at `$D86(a5)`.
    const devices = devicesFor("extreme-sports");
    const bowl = ballLocksFor("extreme-sports").find((one: BallLock) => one.id === "bowl");
    expect(bowl).toBeDefined();
    if (bowl === undefined) return;
    const eject = devices.lockEjectFor(bowl.level, bowl.zoneIndex);
    expect(eject).toEqual({ x: 289, y: 179, velocityX: 0, velocityY: 0, level: 0, holdTicks: 50 });

    const game = createGame(mapFor("extreme-sports"), { ballsPerGame: 3 });
    startGame(game);
    runTicks(game, { sample: () => IDLE_SNAPSHOT }, 60);
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    if (ball === undefined) return;
    game.laneBallId = null;
    ball.x = pixelsToQ10(Math.floor((bowl.minX + bowl.maxX) / 2));
    ball.y = pixelsToQ10(Math.floor((bowl.minY + bowl.maxY) / 2));
    ball.velocityX = 0;
    ball.velocityY = 0;
    ball.level = bowl.level;

    let ejectedAt = -1;
    let capturedAt = -1;
    let servedAfterCapture = 0;
    for (let tick = 0; tick < 400 && ejectedAt < 0; tick += 1) {
      const report = runTicks(game, { sample: () => IDLE_SNAPSHOT }, 1)[0];
      if (report === undefined) break;
      if (report.locked.length > 0) capturedAt = tick;
      if (capturedAt >= 0 && report.served) servedAfterCapture += 1;
      if (report.ejected.length > 0) ejectedAt = tick;
    }
    expect(capturedAt, "the bowl never swallowed the ball").toBeGreaterThanOrEqual(0);
    expect(ejectedAt, "the bowl never gave it back").toBeGreaterThan(capturedAt);
    // NOT down the lane: no serve happens between the capture and the eject.
    expect(servedAfterCapture, "the machine served a ball it did not owe").toBe(0);
    expect(q10ToPixel(ball.x)).toBe(289);
    expect(q10ToPixel(ball.y)).toBe(179);
    expect(ball.level).toBe(0);
    expect(ball.heldBy).toBeNull();
    expect(ball.active).toBe(true);
  });

  it("cannot lock the same saucer over and over: the profiles that farmed it finish", () => {
    // ROUND 5's REGRESSION, pinned. With `PUSH` returning the ball through the
    // trough, an ejected ball reappeared on the plunger rod at a fixed position
    // with a fixed kick — a total state reset — and Extreme Sports closed an
    // exact 742-tick limit cycle through the bowl saucer: 26 locks and 9,325,000
    // points inside 20,000 ticks, with ball 1 never ending. The authored eject
    // cannot do that, because it puts the ball back somewhere the previous lap
    // did not start from.
    for (const plan of [
      (tick: number): readonly Control[] => {
        const controls: Control[] = [];
        if (tick % 250 < 8) controls.push("plunger");
        if (tick % 14 < 2) controls.push("leftFlipper");
        if ((tick + 12) % 14 < 2) controls.push("rightFlipper");
        return controls;
      },
      (tick: number): readonly Control[] => {
        const controls: Control[] = [];
        if (tick % 250 < 8) controls.push("plunger");
        if (tick % 2 < 1) controls.push("leftFlipper", "rightFlipper");
        return controls;
      },
    ]) {
      const game = createGame(mapFor("extreme-sports"), { ballsPerGame: 3 });
      startGame(game);
      const input = new ScriptedInput(plan);
      let locks = 0;
      let over = -1;
      for (let tick = 0; tick < 20_000; tick += 1) {
        const report = runTicks(game, input, 1)[0];
        locks += report?.locked.length ?? 0;
        if (debugSnapshot(game).phase === "game-over") {
          over = tick;
          break;
        }
      }
      expect(over, "the game never ended").toBeGreaterThan(0);
      // Two saucers, one ball each at a time: a three-ball game cannot honestly
      // fill them more than a handful of times, and 26 is a farm.
      expect(locks, "locks in one three-ball game").toBeLessThanOrEqual(6);
    }
  });
});
