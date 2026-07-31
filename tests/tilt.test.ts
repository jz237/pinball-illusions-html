import { describe, expect, it } from "vitest";
import {
  INITIAL_TILT,
  NUDGE_ALLOWANCE_BY_TABLE,
  flippersLive,
  nudge,
  nudgeConfigFor,
  resetTiltForNewBall,
  scoringLive,
  tickTilt,
} from "../src/game/tilt.js";
import type { NudgeConfig, TiltState } from "../src/game/tilt.js";

const CONFIG: NudgeConfig = nudgeConfigFor("law-n-justice");

/** Nudges n times, skipping past the cooldown between each. */
function nudgeTimes(times: number, config: NudgeConfig = CONFIG): TiltState {
  let state = INITIAL_TILT;
  for (let i = 0; i < times; i += 1) {
    state = nudge(state, "left", config).state;
    for (let t = 0; t < config.cooldownTicks; t += 1) state = tickTilt(state, config);
  }
  return state;
}

describe("per-table allowance", () => {
  it("matches the values decoded from the original option files", () => {
    expect(NUDGE_ALLOWANCE_BY_TABLE["law-n-justice"]).toBe(5);
    expect(NUDGE_ALLOWANCE_BY_TABLE.babewatch).toBe(5);
    // The one genuine per-table difference found on the disks.
    expect(NUDGE_ALLOWANCE_BY_TABLE["extreme-sports"]).toBe(10);
  });

  it("gives Extreme Sports twice the tolerance of the others", () => {
    expect(nudgeTimes(6, nudgeConfigFor("law-n-justice")).tilted).toBe(true);
    expect(nudgeTimes(6, nudgeConfigFor("extreme-sports")).tilted).toBe(false);
  });
});

describe("nudging", () => {
  it("pushes balls the opposite way for left and right", () => {
    const left = nudge(INITIAL_TILT, "left", CONFIG);
    const right = nudge(INITIAL_TILT, "right", CONFIG);
    expect(left.impulseX).toBeLessThan(0);
    expect(right.impulseX).toBeGreaterThan(0);
    expect(left.impulseX).toBe(-right.impulseX);
  });

  it("pushes up the table when nudged forward", () => {
    const forward = nudge(INITIAL_TILT, "forward", CONFIG);
    expect(forward.impulseY).toBeLessThan(0);
    expect(forward.impulseX).toBe(0);
  });

  it("counts a warning each time", () => {
    expect(nudge(INITIAL_TILT, "left", CONFIG).state.warnings).toBe(1);
    expect(nudgeTimes(3).warnings).toBe(3);
  });

  it("refuses a second nudge during cooldown, and does not count it", () => {
    const first = nudge(INITIAL_TILT, "left", CONFIG);
    const second = nudge(first.state, "left", CONFIG);
    expect(second.accepted).toBe(false);
    expect(second.impulseX).toBe(0);
    expect(second.state.warnings).toBe(1);
  });

  it("accepts again once the cooldown expires", () => {
    let state = nudge(INITIAL_TILT, "left", CONFIG).state;
    for (let t = 0; t < CONFIG.cooldownTicks; t += 1) state = tickTilt(state, CONFIG);
    expect(nudge(state, "left", CONFIG).accepted).toBe(true);
  });
});

describe("tilting", () => {
  it("tilts on reaching the allowance, not before", () => {
    expect(nudgeTimes(CONFIG.allowance - 1).tilted).toBe(false);
    expect(nudgeTimes(CONFIG.allowance).tilted).toBe(true);
  });

  it("reports the moment of tilt exactly once", () => {
    let state = nudgeTimes(CONFIG.allowance - 1);
    const tipping = nudge(state, "left", CONFIG);
    expect(tipping.justTilted).toBe(true);
    state = tipping.state;
    expect(nudge(state, "left", CONFIG).justTilted).toBe(false);
  });

  it("still shoves the table on the tilting nudge", () => {
    const tipping = nudge(nudgeTimes(CONFIG.allowance - 1), "left", CONFIG);
    expect(tipping.impulseX).not.toBe(0);
  });

  it("kills flippers and scoring once tilted", () => {
    const tilted = nudgeTimes(CONFIG.allowance);
    expect(flippersLive(tilted)).toBe(false);
    expect(scoringLive(tilted)).toBe(false);
    expect(flippersLive(INITIAL_TILT)).toBe(true);
    expect(scoringLive(INITIAL_TILT)).toBe(true);
  });

  it("refuses all further nudges once tilted", () => {
    const tilted = nudgeTimes(CONFIG.allowance);
    const after = nudge(tilted, "right", CONFIG);
    expect(after.accepted).toBe(false);
    expect(after.impulseX).toBe(0);
  });

  it("does not decay out of a tilt — it lasts the rest of the ball", () => {
    let state = nudgeTimes(CONFIG.allowance);
    for (let t = 0; t < CONFIG.decayTicks * 5; t += 1) state = tickTilt(state, CONFIG);
    expect(state.tilted).toBe(true);
  });

  it("clears for the next ball", () => {
    expect(resetTiltForNewBall()).toEqual(INITIAL_TILT);
  });
});

describe("warning decay", () => {
  it("forgives one warning after the decay period", () => {
    let state = nudgeTimes(2);
    expect(state.warnings).toBe(2);
    for (let t = 0; t < CONFIG.decayTicks; t += 1) state = tickTilt(state, CONFIG);
    expect(state.warnings).toBe(1);
  });

  it("means spaced-out nudging never tilts", () => {
    let state = INITIAL_TILT;
    for (let i = 0; i < CONFIG.allowance * 3; i += 1) {
      state = nudge(state, "left", CONFIG).state;
      for (let t = 0; t < CONFIG.decayTicks; t += 1) state = tickTilt(state, CONFIG);
    }
    expect(state.tilted).toBe(false);
  });

  it("never drops below zero warnings", () => {
    let state = INITIAL_TILT;
    for (let t = 0; t < CONFIG.decayTicks * 3; t += 1) state = tickTilt(state, CONFIG);
    expect(state.warnings).toBe(0);
  });
});
