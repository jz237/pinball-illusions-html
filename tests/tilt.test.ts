import { describe, expect, it } from "vitest";
import {
  INITIAL_TILT,
  NUDGE_COOLDOWN_TICKS,
  ORIGINAL_TILT_SENSITIVITY_DEFAULT,
  ORIGINAL_TILT_SENSITIVITY_MAX,
  ORIGINAL_TILT_SENSITIVITY_MIN,
  ORIGINAL_TILT_THRESHOLD,
  TILT_DECAY_PER_TICK,
  TILT_SENSITIVITY_BY_TABLE,
  flippersLive,
  nudge,
  nudgeConfigFor,
  resetTiltForNewBall,
  scoringLive,
  tickTilt,
} from "../src/game/tilt.js";
import type { NudgeConfig, TiltState } from "../src/game/tilt.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { TICKS_PER_SECOND } from "../src/game/timebase.js";

const CONFIG: NudgeConfig = nudgeConfigFor("law-n-justice");

/** Shoves `times`, `gap` ticks apart, and reports where the counter ended up. */
function shove(times: number, gap: number, config: NudgeConfig = CONFIG): TiltState {
  let state = INITIAL_TILT;
  for (let i = 0; i < times; i += 1) {
    state = nudge(state, "left", config).state;
    for (let t = 0; t < gap; t += 1) state = tickTilt(state, config);
  }
  return state;
}

describe("the measured rule", () => {
  it("is a sensitivity against a fixed threshold, not a per-table nudge count", () => {
    // THE CORRECTION. This project spent eleven commits believing the tilt
    // allowance was 5 / 5 / 10 and that Extreme Sports tolerated twice as many
    // shoves as the others, tagged [disk]. Those are option record 5's default,
    // a duration in whole SECONDS. Record 3 is the tilt option and it is
    // byte-identical on all three tables.
    for (const id of TABLE_IDS) {
      expect(TILT_SENSITIVITY_BY_TABLE[id]).toBe(ORIGINAL_TILT_SENSITIVITY_DEFAULT);
    }
    expect(ORIGINAL_TILT_SENSITIVITY_MIN).toBe(0);
    expect(ORIGINAL_TILT_SENSITIVITY_MAX).toBe(200);
    expect(ORIGINAL_TILT_SENSITIVITY_DEFAULT).toBe(100);
    expect(ORIGINAL_TILT_THRESHOLD).toBe(200);
  });

  it("decays four counts a tick, one per collision pass", () => {
    // The number that turns "the second nudge tilts" into "the third inside half
    // a second tilts". `$BE90` is the tail of `$BC24` and `$BC24` runs once per
    // collision pass, four times a frame.
    expect(TILT_DECAY_PER_TICK).toBe(4);
    // Which is to say a single shove is forgiven in half a second exactly.
    const oneShove = ORIGINAL_TILT_SENSITIVITY_DEFAULT / TILT_DECAY_PER_TICK;
    expect(oneShove / TICKS_PER_SECOND).toBeCloseTo(0.5);
  });

  it("cannot be tilted by two shoves, however fast they are made", () => {
    // 100 + (100 - 4) is 196 at the very best, one short of 200 twice over.
    for (let gap = NUDGE_COOLDOWN_TICKS; gap < 30; gap += 1) {
      expect(shove(2, gap).tilted, `two shoves ${gap} ticks apart`).toBe(false);
    }
  });

  it("tilts on the third shove inside half a second, and not outside it", () => {
    expect(shove(3, NUDGE_COOLDOWN_TICKS).tilted).toBe(true);
    // Spread the same three shoves over more than the counter's memory and the
    // table forgives every one of them.
    expect(shove(3, 26).tilted).toBe(false);
    expect(shove(20, 26).tilted).toBe(false);
  });

  it("never tilts at sensitivity 0 and tilts on the first shove at 200", () => {
    const deaf: NudgeConfig = { ...CONFIG, sensitivity: ORIGINAL_TILT_SENSITIVITY_MIN };
    expect(shove(40, NUDGE_COOLDOWN_TICKS, deaf).tilted).toBe(false);
    expect(shove(40, NUDGE_COOLDOWN_TICKS, deaf).warning).toBe(0);

    const jumpy: NudgeConfig = { ...CONFIG, sensitivity: ORIGINAL_TILT_SENSITIVITY_MAX };
    expect(nudge(INITIAL_TILT, "left", jumpy).state.tilted).toBe(true);
    expect(nudge(INITIAL_TILT, "left", jumpy).justTilted).toBe(true);
  });

  it("refuses a second shove only while the cabinet is still recentring", () => {
    // Seven passes at +600 to saturation and -200 back, so two ticks. It was ten
    // and chosen; the number is now the accumulator's own.
    expect(NUDGE_COOLDOWN_TICKS).toBe(2);
    const first = nudge(INITIAL_TILT, "left", CONFIG);
    expect(nudge(first.state, "left", CONFIG).accepted).toBe(false);
    let state = first.state;
    for (let t = 0; t < NUDGE_COOLDOWN_TICKS; t += 1) state = tickTilt(state, CONFIG);
    expect(nudge(state, "left", CONFIG).accepted).toBe(true);
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

  it("adds the sensitivity to the counter each time", () => {
    expect(nudge(INITIAL_TILT, "left", CONFIG).state.warning).toBe(CONFIG.sensitivity);
    // Two shoves back to back, with the cooldown's decay between them.
    expect(shove(2, NUDGE_COOLDOWN_TICKS).warning).toBe(
      2 * CONFIG.sensitivity - 2 * NUDGE_COOLDOWN_TICKS * TILT_DECAY_PER_TICK,
    );
  });

  it("does not count a nudge it refused", () => {
    const first = nudge(INITIAL_TILT, "left", CONFIG);
    const second = nudge(first.state, "left", CONFIG);
    expect(second.accepted).toBe(false);
    expect(second.impulseX).toBe(0);
    expect(second.state.warning).toBe(CONFIG.sensitivity);
  });
});

describe("tilting", () => {
  it("reports the moment of tilt exactly once", () => {
    const state = shove(2, NUDGE_COOLDOWN_TICKS);
    expect(state.tilted).toBe(false);
    const tipping = nudge(state, "left", CONFIG);
    expect(tipping.justTilted).toBe(true);
    expect(nudge(tipping.state, "left", CONFIG).justTilted).toBe(false);
  });

  it("still shoves the table on the tilting nudge", () => {
    const tipping = nudge(shove(2, NUDGE_COOLDOWN_TICKS), "left", CONFIG);
    expect(tipping.justTilted).toBe(true);
    expect(tipping.impulseX).not.toBe(0);
  });

  it("kills flippers and scoring once tilted", () => {
    const tilted = shove(3, NUDGE_COOLDOWN_TICKS);
    expect(tilted.tilted).toBe(true);
    expect(flippersLive(tilted)).toBe(false);
    expect(scoringLive(tilted)).toBe(false);
    expect(flippersLive(INITIAL_TILT)).toBe(true);
    expect(scoringLive(INITIAL_TILT)).toBe(true);
  });

  it("refuses all further nudges once tilted", () => {
    const tilted = shove(3, NUDGE_COOLDOWN_TICKS);
    const after = nudge(tilted, "right", CONFIG);
    expect(after.accepted).toBe(false);
    expect(after.impulseX).toBe(0);
  });

  it("does not decay out of a tilt — it lasts the rest of the ball", () => {
    let state = shove(3, NUDGE_COOLDOWN_TICKS);
    for (let t = 0; t < 5 * TICKS_PER_SECOND; t += 1) state = tickTilt(state, CONFIG);
    expect(state.tilted).toBe(true);
  });

  it("clears for the next ball", () => {
    expect(resetTiltForNewBall()).toEqual(INITIAL_TILT);
  });
});

describe("warning decay", () => {
  it("drains a single shove to nothing in half a second", () => {
    let state = nudge(INITIAL_TILT, "left", CONFIG).state;
    const ticks = Math.ceil(CONFIG.sensitivity / CONFIG.decayPerTick);
    for (let t = 0; t < ticks - 1; t += 1) state = tickTilt(state, CONFIG);
    expect(state.warning).toBeGreaterThan(0);
    state = tickTilt(state, CONFIG);
    expect(state.warning).toBe(0);
    expect(ticks).toBe(25);
  });

  it("never drops below zero", () => {
    let state = INITIAL_TILT;
    for (let t = 0; t < 200; t += 1) state = tickTilt(state, CONFIG);
    expect(state.warning).toBe(0);
  });

  it("returns the same state object when nothing changed, so a quiet tick is free", () => {
    expect(tickTilt(INITIAL_TILT, CONFIG)).toBe(INITIAL_TILT);
  });
});
