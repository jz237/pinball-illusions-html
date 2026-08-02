import { describe, expect, it } from "vitest";
import {
  INITIAL_TILT,
  MEASURED_TILT_DECAY_PER_TICK,
  MEASURED_TILT_THRESHOLD,
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
  poweredSurfacesLive,
  resetTiltForNewBall,
  tickTilt,
} from "../src/game/tilt.js";
import type { NudgeConfig, TiltState } from "../src/game/tilt.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { TICKS_PER_SECOND } from "../src/game/timebase.js";

const CONFIG: NudgeConfig = nudgeConfigFor("law-n-justice");

/** Shoves `times`, `gap` ticks apart, and reports where the counter ended up. */
function shove(
  times: number,
  gap: number,
  config: NudgeConfig = CONFIG,
  ballInPlay = true,
): TiltState {
  let state = INITIAL_TILT;
  for (let i = 0; i < times; i += 1) {
    state = nudge(state, "left", config, ballInPlay).state;
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

  it("runs the CALIBRATED trip model, and records the decoded one it replaced", () => {
    // The decoded reading — add 100, decay 1/pass x 4 passes, trip at 200 —
    // predicts a tilt on the third press inside half a second. The running
    // original, driven with a millisecond-logged key script, trips on the
    // FIFTH press at both ~121 ms and 250 ms cadence, which no decay of
    // 4/tick can produce (at 250 ms it eats half of every press). The decoded
    // constants stay exported as the record of the code; the config runs the
    // calibrated pair. See tilt.ts for the fit and the residual question.
    expect(TILT_DECAY_PER_TICK).toBe(4);
    expect(MEASURED_TILT_THRESHOLD).toBe(400);
    expect(MEASURED_TILT_DECAY_PER_TICK).toBe(2);
    expect(CONFIG.threshold).toBe(MEASURED_TILT_THRESHOLD);
    expect(CONFIG.decayPerTick).toBe(MEASURED_TILT_DECAY_PER_TICK);
  });

  it("cannot be tilted by two shoves, however fast they are made", () => {
    // Filmed: two presses 452 ms apart did not tilt; nor does any pair here —
    // 100 + 100 is half the calibrated threshold before decay even starts.
    for (let gap = NUDGE_COOLDOWN_TICKS; gap < 30; gap += 1) {
      expect(shove(2, gap).tilted, `two shoves ${gap} ticks apart`).toBe(false);
    }
  });

  it("tilts on the fifth press at both filmed cadences, and not on the fourth", () => {
    // THE CALIBRATION TARGETS, straight from the capture session: 12 presses
    // at ~121 ms (6 ticks) tripped after press 5-6 on both tables probed, and
    // 12 presses at 250 ms (12-13 ticks) after press 5 — near cadence-
    // insensitive, which is the observation that killed the decoded decay.
    for (const gap of [6, 12]) {
      expect(shove(4, gap).tilted, `four presses ${gap} ticks apart`).toBe(false);
      expect(shove(5, gap).tilted, `five presses ${gap} ticks apart`).toBe(true);
    }
    // Spread the presses far enough apart and the table forgives every one.
    expect(shove(20, 60).tilted).toBe(false);
  });

  it("does not warm the counter without a ball in play", () => {
    // Filmed: six presses at 160 ms with the ball waiting ON THE PLUNGER never
    // tilted; the same cadence with a ball rolling does. The shove itself
    // still lands (the cabinet moves), so the impulse is unchanged.
    const parked = shove(12, 6, CONFIG, false);
    expect(parked.tilted).toBe(false);
    expect(parked.warning).toBe(0);
    expect(nudge(INITIAL_TILT, "left", CONFIG, false).impulseX).toBe(
      nudge(INITIAL_TILT, "left", CONFIG, true).impulseX,
    );
  });

  it("never tilts at sensitivity 0, and trips sooner the higher it is set", () => {
    const deaf: NudgeConfig = { ...CONFIG, sensitivity: ORIGINAL_TILT_SENSITIVITY_MIN };
    expect(shove(40, NUDGE_COOLDOWN_TICKS, deaf).tilted).toBe(false);
    expect(shove(40, NUDGE_COOLDOWN_TICKS, deaf).warning).toBe(0);

    // At the option's maximum the operator gets a hair-trigger table: with the
    // calibrated threshold that is the third press, not the first — the film
    // covers only the shipped default, so what is asserted for other settings
    // is the monotonic property and not a number nothing measured.
    const jumpy: NudgeConfig = { ...CONFIG, sensitivity: ORIGINAL_TILT_SENSITIVITY_MAX };
    let presses = 0;
    let state = INITIAL_TILT;
    while (!state.tilted && presses < 10) {
      state = nudge(state, "left", jumpy).state;
      presses += 1;
      for (let t = 0; t < NUDGE_COOLDOWN_TICKS; t += 1) state = tickTilt(state, jumpy);
    }
    expect(state.tilted).toBe(true);
    expect(presses).toBeLessThan(5);
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
      2 * CONFIG.sensitivity - 2 * NUDGE_COOLDOWN_TICKS * CONFIG.decayPerTick,
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
    const state = shove(4, NUDGE_COOLDOWN_TICKS);
    expect(state.tilted).toBe(false);
    const tipping = nudge(state, "left", CONFIG);
    expect(tipping.justTilted).toBe(true);
    expect(nudge(tipping.state, "left", CONFIG).justTilted).toBe(false);
  });

  it("still shoves the table on the tilting nudge", () => {
    const tipping = nudge(shove(4, NUDGE_COOLDOWN_TICKS), "left", CONFIG);
    expect(tipping.justTilted).toBe(true);
    expect(tipping.impulseX).not.toBe(0);
  });

  it("kills flippers and the powered surfaces once tilted — and only those", () => {
    // Tilt kills the flippers and the bumper/slingshot coils. It does NOT kill
    // scoring in general: the original keeps awarding zone triggers and
    // targets on the tilted ball's way down (filmed twice, and the zone/device
    // walks run untouched in the tilted state's service bundle). The gating of
    // WHAT the loop feeds the scorer lives in game-loop.ts; this module only
    // answers the two liveness questions.
    const tilted = shove(5, NUDGE_COOLDOWN_TICKS);
    expect(tilted.tilted).toBe(true);
    expect(flippersLive(tilted)).toBe(false);
    expect(poweredSurfacesLive(tilted)).toBe(false);
    expect(flippersLive(INITIAL_TILT)).toBe(true);
    expect(poweredSurfacesLive(INITIAL_TILT)).toBe(true);
  });

  it("refuses all further nudges once tilted", () => {
    const tilted = shove(5, NUDGE_COOLDOWN_TICKS);
    const after = nudge(tilted, "right", CONFIG);
    expect(after.accepted).toBe(false);
    expect(after.impulseX).toBe(0);
  });

  it("does not decay out of a tilt — it lasts the rest of the ball", () => {
    let state = shove(5, NUDGE_COOLDOWN_TICKS);
    expect(state.tilted).toBe(true);
    for (let t = 0; t < 5 * TICKS_PER_SECOND; t += 1) state = tickTilt(state, CONFIG);
    expect(state.tilted).toBe(true);
  });

  it("clears for the next ball", () => {
    expect(resetTiltForNewBall()).toEqual(INITIAL_TILT);
  });
});

describe("warning decay", () => {
  it("drains a single shove to nothing in one second", () => {
    let state = nudge(INITIAL_TILT, "left", CONFIG).state;
    const ticks = Math.ceil(CONFIG.sensitivity / CONFIG.decayPerTick);
    for (let t = 0; t < ticks - 1; t += 1) state = tickTilt(state, CONFIG);
    expect(state.warning).toBeGreaterThan(0);
    state = tickTilt(state, CONFIG);
    expect(state.warning).toBe(0);
    expect(ticks).toBe(50);
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
