/**
 * THE SHELL RUNS AT 50 Hz, NOT AT THE DISPLAY'S REFRESH RATE.
 *
 * The simulation has been on a fixed step since the beginning and the shell was
 * not: `src/main.ts` advanced it a literal one tick per animation frame, so the
 * whole front end ran at whatever the screen refreshed at — 1.2x fast on a
 * 60 Hz panel, 2.4x on 120, 2.88x on 144.
 *
 * Every number checked here is the film's own, measured off
 * `research\view\reference\session3` — a 399.58 s continuous capture of the
 * credits with nothing pressed, plus an independent cold boot:
 *
 *   - the page cycle is a hard 176 frames = 3.52 s. Every one of the 112
 *     start-to-start intervals in the main take and all 55 in the boot take
 *     measured 176, with no variation and no dependence on how much text the
 *     page carries;
 *   - a lap of the twelve pages is 2112 frames = 42.24 s;
 *   - the backdrop's palette lap is 2058 frames against that 2112, which is
 *     what makes the same page come back under a different tint every lap. The
 *     two clocks are incommensurate, and running both fast keeps the RATIO
 *     while destroying the beat.
 *
 * So the assertions are in WALL CLOCK as well as in ticks: a frame rate that
 * changes how long a page is on screen is the defect, and a test that only
 * counted ticks per frame would not have caught it.
 */

import { describe, expect, it } from "vitest";
import { ShellClock } from "../src/browser/shell-clock.js";
import {
  ATTRACT_LAP_TICKS,
  ATTRACT_PAGE_TICKS,
  ATTRACT_ROLL_PAGES,
  createShell,
} from "../src/browser/shell.js";
import type { ScoreStore, ShellState } from "../src/browser/shell.js";
import { FACTORY_HIGH_SCORES } from "../src/game/high-scores.js";

const store: ScoreStore = {
  load: () => FACTORY_HIGH_SCORES.map((entry) => ({ ...entry })),
  save: () => undefined,
};

/** The refresh rates a browser actually hands out, plus a throttled tab. */
const REFRESH_RATES = [24, 30, 50, 60, 75, 90, 100, 120, 144, 165, 240] as const;

/** PAL. Not a choice: `timebase.ts` reads it off the OS's VBlankFrequency. */
const HZ = 50;

/**
 * Drives `clock` from `fromMs` for `seconds` of wall clock at `hz`, exactly as
 * the animation frame loop does — timestamps only, no tick count handed in.
 */
function driveFor(
  clock: ShellClock,
  state: ShellState,
  hz: number,
  seconds: number,
  fromMs = 0,
): void {
  const frames = Math.round(hz * seconds);
  for (let frame = 0; frame <= frames; frame += 1) {
    clock.frame(fromMs + (frame * 1000) / hz, state, store);
  }
}

describe("the shell's clock", () => {
  it("runs exactly 50 ticks a second at every refresh rate a browser offers", () => {
    for (const hz of REFRESH_RATES) {
      const clock = new ShellClock();
      const state = createShell(store);
      driveFor(clock, state, hz, 10);
      expect(clock.totalTicks, `${hz} Hz, ten seconds`).toBe(HZ * 10);
      expect(clock.droppedTicks, `${hz} Hz drops nothing`).toBe(0);
    }
  });

  it("does not drift over an hour, at a refresh rate with no exact period", () => {
    // 1/60 s is unrepresentable in binary, so an implementation that accumulated
    // a float period would be short by a tick every few hours. The scheduler
    // carries an exact integer ratio; an hour must be exactly 180,000 ticks.
    const clock = new ShellClock();
    const state = createShell(store);
    driveFor(clock, state, 60, 3600);
    expect(clock.totalTicks).toBe(HZ * 3600);
  });

  it("turns a credits page every 3.52 s of wall clock, whatever the screen runs at", () => {
    // The filmed cadence. 176 frames at 50 Hz.
    expect(ATTRACT_PAGE_TICKS / HZ).toBeCloseTo(3.52, 10);
    for (const hz of REFRESH_RATES) {
      const clock = new ShellClock();
      const state = createShell(store);
      const turnedAtMs: number[] = [];
      let page = state.attractPage;
      // Three laps, and long enough that a 1.2x error is unmissable. Two frames
      // of slack so the 36th turn — which lands on the very last tick — is
      // inside the window at 24 Hz too; the 37th is 3.52 s away and cannot be.
      const frames = Math.round((hz * ATTRACT_LAP_TICKS * 3) / HZ) + 2;
      for (let frame = 0; frame <= frames; frame += 1) {
        const timeMs = (frame * 1000) / hz;
        clock.frame(timeMs, state, store);
        if (state.attractPage !== page) {
          page = state.attractPage;
          turnedAtMs.push(timeMs);
        }
      }
      expect(turnedAtMs.length, `${hz} Hz: pages turned in three laps`).toBe(
        ATTRACT_ROLL_PAGES * 3,
      );
      for (let i = 1; i < turnedAtMs.length; i += 1) {
        const gap = (turnedAtMs[i] ?? 0) - (turnedAtMs[i - 1] ?? 0);
        // Within one frame of 3520 ms: the page turns on the FRAME that carries
        // the 176th tick, which lands up to one refresh period late.
        expect(gap, `${hz} Hz: interval ${i}`).toBeGreaterThan(3520 - 1000 / hz - 0.5);
        expect(gap, `${hz} Hz: interval ${i}`).toBeLessThan(3520 + 1000 / hz + 0.5);
      }
      // And the whole three laps land where the film says, to inside a frame.
      const span = (turnedAtMs[turnedAtMs.length - 1] ?? 0) - (turnedAtMs[0] ?? 0);
      const filmed = ((ATTRACT_ROLL_PAGES * 3 - 1) * ATTRACT_PAGE_TICKS * 1000) / HZ;
      expect(Math.abs(span - filmed), `${hz} Hz: 35 pages of wall clock`).toBeLessThan(1000 / hz);
    }
  });

  it("laps the twelve pages in 42.24 s, and the page order never varies", () => {
    expect(ATTRACT_LAP_TICKS / HZ).toBeCloseTo(42.24, 10);
    for (const hz of [60, 120, 144]) {
      const clock = new ShellClock();
      const state = createShell(store);
      const seen: number[] = [state.attractPage];
      const frames = Math.round((hz * ATTRACT_LAP_TICKS * 2) / HZ);
      let lapMs = -1;
      for (let frame = 0; frame <= frames; frame += 1) {
        const timeMs = (frame * 1000) / hz;
        clock.frame(timeMs, state, store);
        if (state.attractPage !== seen[seen.length - 1]) {
          seen.push(state.attractPage);
          if (seen.length === ATTRACT_ROLL_PAGES + 1) lapMs = timeMs;
        }
      }
      expect(seen.slice(0, ATTRACT_ROLL_PAGES + 1)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0,
      ]);
      expect(lapMs, `${hz} Hz: one lap`).toBeGreaterThan(42_240 - 1000 / hz - 0.5);
      expect(lapMs, `${hz} Hz: one lap`).toBeLessThan(42_240 + 1000 / hz + 0.5);
    }
  });

  it("holds each page's text for the film's own count of frames, at any refresh rate", () => {
    // `attractTicks` is what the renderer's erase front is a function of, so the
    // wall-clock moment the erase starts is decided here. The film: the text is
    // bit-identical for 101 + 2*(K_min + 1) frames and the front leaves zero on
    // frame 101 — 2.02 s into the page, on every one of the 113 instances.
    for (const hz of [60, 120, 144]) {
      const clock = new ShellClock();
      const state = createShell(store);
      let eraseStartedMs = -1;
      const frames = Math.round((hz * ATTRACT_PAGE_TICKS) / HZ);
      for (let frame = 0; frame <= frames; frame += 1) {
        const timeMs = (frame * 1000) / hz;
        clock.frame(timeMs, state, store);
        if (eraseStartedMs < 0 && state.attractTicks >= 101) eraseStartedMs = timeMs;
      }
      expect(eraseStartedMs, `${hz} Hz: the erase front leaves zero`).toBeGreaterThan(
        2020 - 1000 / hz - 0.5,
      );
      expect(eraseStartedMs, `${hz} Hz`).toBeLessThan(2020 + 1000 / hz + 0.5);
    }
  });

  it("runs the backdrop service on the same 50 Hz clock, so its lap stays 2058 frames", () => {
    // The palette lap and the page lap are different numbers on purpose — 2058
    // against 2112 — and both are counted in the same ticks. Whatever the
    // display does, ten seconds of wall clock is 500 of both.
    for (const hz of [60, 144]) {
      const clock = new ShellClock();
      const state = createShell(store);
      driveFor(clock, state, hz, 10);
      expect(state.ticks, `${hz} Hz`).toBe(500);
    }
  });

  it("banks nothing for the time it was paused", () => {
    const clock = new ShellClock();
    const state = createShell(store);
    driveFor(clock, state, 60, 1);
    expect(clock.totalTicks).toBe(50);
    clock.pause();
    // Ten minutes of a hidden tab, handed back as one enormous timestamp.
    clock.frame(1000 + 600_000, state, store);
    expect(clock.totalTicks, "a paused clock runs nothing").toBe(50);
    clock.resume();
    // The first frame after a resume re-seeds and is worth nothing, so a second
    // of frames from there is worth exactly a second — not ten minutes.
    driveFor(clock, state, 60, 1, 601_000);
    expect(clock.totalTicks, "one second, not ten minutes").toBe(100);
    expect(clock.droppedTicks, "and nothing was clamped away either").toBe(0);
  });

  it("clamps the burst a frozen tab hands back rather than running it all", () => {
    // Same rule as the simulation's, and for the same reason: the credits must
    // not spin through eighty pages in one frame when a laptop wakes up.
    const clock = new ShellClock();
    const state = createShell(store);
    clock.frame(0, state, store);
    clock.frame(600_000, state, store);
    expect(clock.totalTicks).toBe(8);
    expect(clock.droppedTicks).toBe(50 * 600 - 8);
  });

  it("resumes itself, because the host pauses it for every frame the table drives", () => {
    const clock = new ShellClock();
    const state = createShell(store);
    clock.frame(0, state, store);
    clock.pause();
    expect(clock.paused).toBe(true);
    clock.frame(1000, state, store);
    expect(clock.paused, "the first frame back re-seeds instead of charging").toBe(false);
    expect(clock.totalTicks).toBe(0);
    driveFor(clock, state, 60, 1, 1000);
    expect(clock.totalTicks).toBe(50);
  });

  it("gives the renderer a clock that is zero on the first frame of a new screen", () => {
    // A frame may now be worth ZERO ticks, which it never was when the shell was
    // advanced once per animation frame. `frameTicks` is what the info screen's
    // typewriter and its picture dissolve are drawn from, so a screen entered by
    // a keystroke has to read zero on the very next frame DRAWN — not on the
    // next frame that happens to owe a tick, which at 144 Hz is two frames later
    // and would open the screen with its typewriter already finished.
    const clock = new ShellClock();
    const state = createShell(store);
    driveFor(clock, state, 144, 4);
    expect(state.frameTicks).toBeGreaterThan(100);
    state.phase = "info";
    // The very next frame, chosen to be one that owes no tick: 144 Hz is 6.94 ms
    // a frame against a 20 ms tick.
    const before = clock.totalTicks;
    clock.frame(4000 + 1000 / 144, state, store);
    expect(clock.totalTicks, "this frame really did owe nothing").toBe(before);
    expect(state.frameTicks).toBe(0);
  });
});
