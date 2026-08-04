/**
 * HOT-SEAT MULTIPLAYER: the decoded rotation, driven on the real machine.
 *
 * Everything asserted here is the machine's own sequence, decoded from
 * main.seg00's ball-end state at 0x5044 and documented in
 * research/MULTIPLAYER_DECODE.md:
 *
 *   - drain -> bonus (outgoing player) -> ["PL n" hold, players > 1 only]
 *     -> rotate -> next player, SAME ball number until the wrap, then ball+1
 *     -> game over at the wrap that finds every serve spent;
 *   - per-player state is per player: score, first-hit flags, held
 *     multiplier, mode counters — the port banks what the machine bit-indexes
 *     (`PlayerBank`), and these tests are the observational-equivalence
 *     check;
 *   - the first-serve window: F1..F8 may change the count while ball 1 waits
 *     on the rod (`$d7c`), and the first launch closes it;
 *   - the PLAYER/BALL panel cards of the serve state and the end hold.
 *
 * A ONE-PLAYER GAME IS DELIBERATELY NOT RE-TESTED HERE beyond its snapshot
 * shape: `tests/sim-hash-pin.test.ts` pins the whole one-player simulation
 * byte-for-byte, which is the strongest statement of "multiplayer changed
 * nothing" there is.
 *
 * The drains in the unit tests are teleported — the ball is placed over the
 * drain mouth and the step takes it — because what is under test is the
 * ROTATION, not four minutes of ball physics per case. The integration test
 * at the bottom plays a whole two-player game the natural way.
 */

import { describe, expect, it } from "vitest";

import { InputRouter } from "../src/browser/input.js";
import type { Control } from "../src/browser/input.js";
import {
  END_OF_BALL_HOLD_GRACE_TICKS,
  END_OF_BALL_HOLD_TICKS,
  MAX_PLAYERS,
  ballNumber,
  createGame,
  debugSnapshot,
  panelCardOf,
  playerCountAdjustable,
  playerScoresOf,
  setPlayerCount,
  startGame,
  tickGame,
} from "../src/browser/game-loop.js";
import type { Game, GameTickReport } from "../src/browser/game-loop.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import { addToBcdField, readBcdField } from "../src/game/scoring.js";
import { mapFor } from "./table-fixtures.js";

// ---------------------------------------------------------------------------
// A deterministic driver: the router sampled once per tick, taps by hand.
// ---------------------------------------------------------------------------

class Driver {
  readonly router = new InputRouter();

  constructor(readonly game: Game) {}

  tick(count = 1): GameTickReport {
    let report: GameTickReport | null = null;
    for (let i = 0; i < count; i += 1) {
      report = tickGame(this.game, this.router.sample());
    }
    if (report === null) throw new Error("tick(0)");
    return report;
  }

  tap(control: Control): void {
    this.router.tap(control);
  }
}

function twoPlayerGame(tableId: "law-n-justice" | "babewatch" = "law-n-justice"): Driver {
  // BALL SAVE OFF, DELIBERATELY AND BY THE MACHINE'S OWN KNOB. `tableNNN.opt`
  // record 5 is a 0..10 slider and 0 is a setting the options screen offers;
  // every ball in this block is driven straight into the drain to reach the
  // thing under test, and with the shipped five seconds armed each of those
  // drains comes back instead. The saver has its own file — see
  // `tests/ball-saver.test.ts`, which drives it at the shipped lengths on all
  // three tables — and nothing here is testing it.
  const game = createGame(mapFor(tableId), { ballSaveSeconds: 0 });
  startGame(game, 2);
  return new Driver(game);
}

/** Ticks until the served ball is launched, tapping the plunger patiently. */
function launchServedBall(drv: Driver): void {
  for (let i = 0; i < 800; i += 1) {
    if (i % 10 === 4) drv.tap("plunger");
    if (drv.tick().launched) return;
  }
  throw new Error("the served ball never launched");
}

/** Teleports the live ball over the drain mouth; ticks until it drains. */
function drainLiveBall(drv: Driver): GameTickReport {
  const ball = drv.game.balls.balls.find(
    (one) => one.active && one.heldBy === null && one.id !== drv.game.laneBallId,
  );
  if (ball === undefined) throw new Error("no live ball to drain");
  ball.level = 0;
  ball.x = pixelsToQ10(155);
  ball.y = pixelsToQ10(592);
  ball.velocityX = 0;
  ball.velocityY = 8000;
  for (let i = 0; i < 80; i += 1) {
    const report = drv.tick();
    if (report.drained.length > 0) return report;
  }
  throw new Error("the teleported ball never drained");
}

/**
 * Runs out the ball end — bonus panels, the multi-player hold, the serve
 * countdown — tapping a flipper so the skippable stretches skip. Returns on
 * the serve of the next ball or on game over.
 */
function runOutBallEnd(drv: Driver): GameTickReport {
  for (let i = 0; i < 1500; i += 1) {
    if (i % 8 === 3) drv.tap("leftFlipper");
    const report = drv.tick();
    if (report.gameOver || report.served) return report;
  }
  throw new Error("the ball end never resolved");
}

/** One whole charged ball: launch it, drain it, run out the end. */
function playOutBall(drv: Driver): GameTickReport {
  launchServedBall(drv);
  drainLiveBall(drv);
  return runOutBallEnd(drv);
}

// ---------------------------------------------------------------------------
// The rotation
// ---------------------------------------------------------------------------

describe("the two-player rotation", () => {
  it("alternates players, advances the ball number on the wrap, ends at the last wrap", () => {
    const drv = twoPlayerGame();
    // Ball 1 serves to player 1.
    let report = runOutBallEnd(drv);
    expect(report.served).toBe(true);
    const seen: [number, number][] = [[drv.game.activePlayer, ballNumber(drv.game)]];
    // Five more charged serves: P2B1, P1B2, P2B2, P1B3, P2B3 — then game over.
    for (let i = 0; i < 5; i += 1) {
      report = playOutBall(drv);
      expect(report.served).toBe(true);
      seen.push([drv.game.activePlayer, ballNumber(drv.game)]);
    }
    expect(seen).toEqual([
      [0, 1],
      [1, 1],
      [0, 2],
      [1, 2],
      [0, 3],
      [1, 3],
    ]);
    // The sixth ball's end is the wrap with every serve spent: game over,
    // and no seventh serve.
    report = playOutBall(drv);
    expect(report.gameOver).toBe(true);
    expect(drv.game.phase).toBe("game-over");
    expect(drv.game.ballsServed).toBe(6);
  });

  it("keeps every player's score in their own bank", () => {
    const drv = twoPlayerGame();
    runOutBallEnd(drv); // P1 ball 1 served
    addToBcdField(drv.game.scoring.score, 150_000);
    playOutBall(drv); // -> P2 ball 1
    expect(drv.game.activePlayer).toBe(1);
    // The rotated-in player starts from zero; the rotated-out score stands.
    expect(readBcdField(drv.game.scoring.score)).toBe(0);
    addToBcdField(drv.game.scoring.score, 25_000);
    expect(playerScoresOf(drv.game)).toEqual([150_000, 25_000]);
    // The hashed snapshot carries the same, only because this is a 2P game.
    const snapshot = debugSnapshot(drv.game);
    expect(snapshot.playerCount).toBe(2);
    expect(snapshot.playerScores).toEqual([150_000, 25_000]);
  });

  it("banks the first-hit flag bytes per player and re-arms the group-backed ones per ball", () => {
    // The machine's flag byte is one byte with a bit per player, and the
    // ball-start `clr.b` at +0x003F56 clears the WHOLE byte — every player's
    // bit — on every group-chained lamp. This port banks a set per player and
    // re-arms the incoming player's at their own serve, which is the same
    // machine observed: a player's bits are only ever read on their own ball.
    const drv = twoPlayerGame();
    runOutBallEnd(drv); // P1 ball 1
    // `device-33` is a Law 'n Justice standup: its flag byte IS a group lamp,
    // so it is per BALL. `device-99` is nothing on this table, and stands in
    // for the per-GAME class — a flag byte the group walk at +0x003F14 never
    // reaches — which the shipped documents happen to have none of.
    drv.game.scoring.flags.add("device-33");
    drv.game.scoring.flags.add("device-99");

    playOutBall(drv); // -> P2 ball 1
    expect(drv.game.activePlayer).toBe(1);
    // Player 2's bits are their own: both clear.
    expect(drv.game.scoring.flags.has("device-33")).toBe(false);
    expect(drv.game.scoring.flags.has("device-99")).toBe(false);

    playOutBall(drv); // -> P1 ball 2
    expect(drv.game.activePlayer).toBe(0);
    // Player 1's group-backed bit re-armed with their new ball...
    expect(drv.game.scoring.flags.has("device-33")).toBe(false);
    // ...and the bit outside every lamp group survived both their dormancy
    // and their own ball boundary.
    expect(drv.game.scoring.flags.has("device-99")).toBe(true);
  });

  it("holds a held multiplier across the OTHER player's ball and re-seeds the ladder on rotation-in", () => {
    const drv = twoPlayerGame("law-n-justice");
    runOutBallEnd(drv); // P1 ball 1
    // Player 1 earns X4 with the hold (award effects 5 + 8, applied as the
    // loop applies them).
    drv.game.scoring.multiplier = 4;
    drv.game.scoring.holdMultiplier = true;
    playOutBall(drv); // -> P2 ball 1
    expect(drv.game.activePlayer).toBe(1);
    expect(drv.game.scoring.multiplier).toBe(0);
    playOutBall(drv); // -> P1 ball 2
    expect(drv.game.activePlayer).toBe(0);
    // $427C on the rotated-in record: the hold spends itself, the multiplier
    // survives exactly one ball end.
    expect(drv.game.scoring.multiplier).toBe(4);
    expect(drv.game.scoring.holdMultiplier).toBe(false);
    // Hook 2 read the ROTATED-IN player's word: the X ladder's counter holds
    // multiplier/2 for player 1.
    const restore = drv.game.modes?.multiplierRestore ?? null;
    expect(restore).not.toBeNull();
    if (restore !== null && drv.game.modeState !== null) {
      expect(drv.game.modeState.counterCounts[restore.counter]).toBe(2);
      expect(drv.game.modeState.counterTotals[restore.counter]).toBe(2);
    }
  });

  it("rotates on a tilted ball end too — the tilt branch still reaches the hold and the walks", () => {
    const drv = twoPlayerGame();
    runOutBallEnd(drv); // P1 ball 1
    launchServedBall(drv);
    drv.game.tilt = { ...drv.game.tilt, tilted: true };
    drainLiveBall(drv);
    const report = runOutBallEnd(drv);
    expect(report.served).toBe(true);
    expect(drv.game.activePlayer).toBe(1);
    expect(ballNumber(drv.game)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The end-of-ball hold — $5230, players > 1 only
// ---------------------------------------------------------------------------

describe("the end-of-ball PL card hold", () => {
  /** Plays P1's ball 1 out and ticks quietly until the hold starts. */
  function reachHold(drv: Driver): void {
    runOutBallEnd(drv);
    launchServedBall(drv);
    drainLiveBall(drv);
    for (let i = 0; i < 400; i += 1) {
      drv.tick();
      if (drv.game.endHoldTicks > 0) return;
    }
    throw new Error("the hold never started");
  }

  it("holds exactly 75 ticks when nothing is pressed", () => {
    const drv = twoPlayerGame();
    reachHold(drv);
    // The tick that finished the bonus also ran the hold's first decrement.
    expect(drv.game.endHoldTicks).toBe(END_OF_BALL_HOLD_TICKS - 1);
    let ticks = 0;
    while (drv.game.endHoldTicks > 0) {
      drv.tick();
      ticks += 1;
      if (ticks > END_OF_BALL_HOLD_TICKS) break;
    }
    expect(ticks).toBe(END_OF_BALL_HOLD_TICKS - 1);
    // The hold's end rotated the next player in.
    expect(drv.game.activePlayer).toBe(1);
  });

  it("cannot be skipped inside the 25-tick grace, and skips on a key after it", () => {
    const drv = twoPlayerGame();
    reachHold(drv);
    // Inside the grace: a tap decrements normally rather than ending it.
    drv.tap("rightFlipper");
    drv.tick();
    expect(drv.game.endHoldTicks).toBe(END_OF_BALL_HOLD_TICKS - 2);
    // Past the grace: one tap ends it.
    while (END_OF_BALL_HOLD_TICKS - drv.game.endHoldTicks < END_OF_BALL_HOLD_GRACE_TICKS) {
      drv.tick();
    }
    drv.tap("rightFlipper");
    drv.tick();
    expect(drv.game.endHoldTicks).toBe(0);
    expect(drv.game.activePlayer).toBe(1);
  });

  it("shows the outgoing player's PL card while it holds", () => {
    const drv = twoPlayerGame();
    reachHold(drv);
    const card = panelCardOf(drv.game);
    expect(card).not.toBeNull();
    expect(card?.top).toBe("PL 1");
    expect(card?.bottom).toBeNull();
  });

  it("does not exist in a one-player game", () => {
    const game = createGame(mapFor("law-n-justice"));
    startGame(game);
    const drv = new Driver(game);
    runOutBallEnd(drv);
    launchServedBall(drv);
    drainLiveBall(drv);
    const report = runOutBallEnd(drv);
    expect(report.served).toBe(true);
    expect(game.endHoldTicks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The first-serve player window — $d7c
// ---------------------------------------------------------------------------

describe("the first-serve player-count window", () => {
  it("is open while ball 1 waits on the rod, and the first launch closes it", () => {
    const drv = twoPlayerGame();
    runOutBallEnd(drv); // ball 1 served
    expect(playerCountAdjustable(drv.game)).toBe(true);
    expect(setPlayerCount(drv.game, 4)).toBe(true);
    expect(drv.game.playerCount).toBe(4);
    expect(drv.game.banks).toHaveLength(4);
    // Shrinking keeps the head of the bank list — player 1's live bank.
    const first = drv.game.banks[0];
    expect(setPlayerCount(drv.game, 3)).toBe(true);
    expect(drv.game.banks[0]).toBe(first);
    launchServedBall(drv);
    expect(playerCountAdjustable(drv.game)).toBe(false);
    expect(setPlayerCount(drv.game, 5)).toBe(false);
    expect(drv.game.playerCount).toBe(3);
  });

  it("refuses counts outside the machine's 1..8", () => {
    const drv = twoPlayerGame();
    runOutBallEnd(drv);
    expect(setPlayerCount(drv.game, 0)).toBe(false);
    expect(setPlayerCount(drv.game, MAX_PLAYERS + 1)).toBe(false);
    expect(setPlayerCount(drv.game, 2.5)).toBe(false);
    expect(drv.game.playerCount).toBe(2);
  });

  it("startGame refuses a count the machine cannot hold", () => {
    const game = createGame(mapFor("law-n-justice"));
    expect(() => startGame(game, 0)).toThrow(RangeError);
    expect(() => startGame(game, 9)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// The serve announcement cards
// ---------------------------------------------------------------------------

describe("the PLAYER/BALL serve card", () => {
  it("says PLAYERS n while the count window is open, then PLAYER n / BALL m", () => {
    const drv = twoPlayerGame();
    runOutBallEnd(drv); // ball 1 served — window open
    const first = panelCardOf(drv.game);
    expect(first?.top).toBe("PLAYERS  2");
    expect(first?.bottom).toBe("BALL  1");
    playOutBall(drv); // -> P2 ball 1
    const second = panelCardOf(drv.game);
    expect(second?.top).toBe("PLAYER  2");
    expect(second?.bottom).toBe("BALL  1");
    playOutBall(drv); // -> P1 ball 2
    const third = panelCardOf(drv.game);
    expect(third?.top).toBe("PLAYER  1");
    expect(third?.bottom).toBe("BALL  2");
  });

  it("goes away with the launch", () => {
    const drv = twoPlayerGame();
    runOutBallEnd(drv);
    expect(panelCardOf(drv.game)).not.toBeNull();
    launchServedBall(drv);
    expect(panelCardOf(drv.game)).toBeNull();
  });

  it("carries the rotated-in player's score", () => {
    const drv = twoPlayerGame();
    runOutBallEnd(drv);
    addToBcdField(drv.game.scoring.score, 75_000);
    playOutBall(drv); // -> P2, score 0
    expect(panelCardOf(drv.game)?.score).toBe(0);
    playOutBall(drv); // -> P1 ball 2, their 75,000
    expect(panelCardOf(drv.game)?.score).toBe(75_000);
  });
});

// ---------------------------------------------------------------------------
// The one-player snapshot shape — the pin's own guarantee, spelled out
// ---------------------------------------------------------------------------

describe("the one-player game after multiplayer", () => {
  it("serialises the exact snapshot shape it always had — no player fields", () => {
    const game = createGame(mapFor("law-n-justice"));
    startGame(game);
    const drv = new Driver(game);
    drv.tick(60);
    const snapshot = debugSnapshot(game);
    expect("playerCount" in snapshot).toBe(false);
    expect("activePlayer" in snapshot).toBe(false);
    expect("playerScores" in snapshot).toBe(false);
    expect("endHoldTicks" in snapshot).toBe(false);
  });

  it("aliases the single bank through scoring and modeState", () => {
    const game = createGame(mapFor("law-n-justice"));
    startGame(game);
    expect(game.banks).toHaveLength(1);
    expect(game.banks[0]?.scoring).toBe(game.scoring);
    expect(game.banks[0]?.modeState).toBe(game.modeState);
  });
});

// ---------------------------------------------------------------------------
// A whole two-player game, played the natural way
// ---------------------------------------------------------------------------

describe("a two-player game end to end", () => {
  it("plays six balls to game over with both players scoring on BabeWatch", () => {
    const game = createGame(mapFor("babewatch"));
    startGame(game, 2);
    const router = new InputRouter();
    let over = false;
    let serves = 0;
    for (let tick = 0; tick < 60_000 && !over; tick += 1) {
      // The pin script's shape: launch whatever waits, flip on two coprime
      // periods so the balls die natural deaths at the bats.
      if (tick % 400 === 100) router.press("plunger");
      if (tick % 400 === 130) router.release("plunger");
      if (tick % 97 === 55) router.press("leftFlipper");
      if (tick % 97 === 75) router.release("leftFlipper");
      if (tick % 131 === 40) router.press("rightFlipper");
      if (tick % 131 === 64) router.release("rightFlipper");
      const report = tickGame(game, router.sample());
      if (report.served) serves += 1;
      if (report.gameOver) over = true;
    }
    expect(over).toBe(true);
    // `served` counts machine-owed deliveries too (BabeWatch's saucers buy
    // replacements); the CHARGED count is the six the rotation deals.
    expect(serves).toBeGreaterThanOrEqual(6);
    expect(game.ballsServed).toBe(6);
    const scores = playerScoresOf(game);
    expect(scores).toHaveLength(2);
    // BabeWatch's untouched launch alone scores six figures; a flipping
    // player cannot finish a ball at zero here.
    expect(scores[0]).toBeGreaterThan(0);
    expect(scores[1]).toBeGreaterThan(0);
    expect(debugSnapshot(game).playerScores).toEqual(scores);
  });
});
