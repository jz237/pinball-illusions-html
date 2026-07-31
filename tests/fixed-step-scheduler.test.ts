import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CATCH_UP_TICKS,
  FixedStepScheduler,
  NANOS_PER_MILLISECOND,
  NANOS_PER_SECOND,
  PAL_TICK_RATE,
  millisecondsToNanos,
} from "../src/core/fixed-step-scheduler.js";

const MS = NANOS_PER_MILLISECOND;
/** One PAL field, the authoritative simulation step. */
const TICK_NANOS = NANOS_PER_SECOND / PAL_TICK_RATE.ticks;

/** Deterministic jitter, so a failure is reproducible rather than flaky. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

describe("tick rate", () => {
  it("is PAL 50 Hz expressed as an exact ratio", () => {
    expect(PAL_TICK_RATE).toEqual({ ticks: 50, perNanos: 1_000_000_000 });
    expect(TICK_NANOS).toBe(20_000_000);
  });

  it("converts millisecond clocks to nanoseconds", () => {
    expect(millisecondsToNanos(1)).toBe(1_000_000);
    expect(millisecondsToNanos(16.666)).toBe(16_666_000);
    expect(() => millisecondsToNanos(Number.NaN)).toThrow(RangeError);
  });

  it("rejects a rate or clamp that cannot be honoured", () => {
    expect(() => new FixedStepScheduler({ rate: { ticks: 0, perNanos: 1 } })).toThrow(RangeError);
    expect(() => new FixedStepScheduler({ rate: { ticks: 50, perNanos: -1 } })).toThrow(RangeError);
    expect(() => new FixedStepScheduler({ rate: { ticks: 1.5, perNanos: 1 } })).toThrow(RangeError);
    expect(() => new FixedStepScheduler({ maxCatchUpTicks: 0 })).toThrow(RangeError);
  });

  it("rejects timestamps that are not real numbers", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    expect(() => scheduler.advance(Number.NaN)).toThrow(RangeError);
    expect(() => scheduler.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("seeding", () => {
  it("charges nothing for the first timestamp", () => {
    const scheduler = new FixedStepScheduler();
    // A raf timestamp is an arbitrary page-load offset; billing it would emit a
    // burst of ticks before the game has even started.
    expect(scheduler.advance(9_876_543_210)).toEqual({ ticks: 0, droppedTicks: 0 });
    expect(scheduler.advance(9_876_543_210 + TICK_NANOS)).toEqual({ ticks: 1, droppedTicks: 0 });
  });
});

describe("tick production", () => {
  it("runs exactly 50 ticks over one simulated second at 50 Hz", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    for (let frame = 1; frame <= 50; frame += 1) {
      expect(scheduler.advance(frame * TICK_NANOS)).toEqual({ ticks: 1, droppedTicks: 0 });
    }
    expect(scheduler.totalTicks).toBe(50);
    expect(scheduler.remainderNanos).toBe(0);
  });

  it("runs the same 50 ticks when the display refreshes at 60 Hz", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    for (let frame = 1; frame <= 60; frame += 1) {
      // Integer nanosecond timeline; 60 Hz has no exact whole-nanosecond period.
      scheduler.advance(Math.floor((frame * NANOS_PER_SECOND) / 60));
    }
    expect(scheduler.totalTicks).toBe(50);
    expect(scheduler.totalDroppedTicks).toBe(0);
  });

  it("runs the same 50 ticks when the display refreshes at 144 Hz", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    for (let frame = 1; frame <= 144; frame += 1) {
      scheduler.advance(Math.floor((frame * NANOS_PER_SECOND) / 144));
    }
    expect(scheduler.totalTicks).toBe(50);
  });
});

describe("drift", () => {
  it("does not drift over 100k simulated frames", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    const frames = 100_000;
    // 16.666666 ms: close to 60 Hz and deliberately not a whole number of ticks,
    // so a float accumulator would shed ticks over this many frames.
    const framePeriod = 16_666_666;

    for (let frame = 1; frame <= frames; frame += 1) {
      scheduler.advance(frame * framePeriod);
    }

    const elapsed = frames * framePeriod;
    expect(scheduler.totalTicks).toBe(Math.floor(elapsed / TICK_NANOS));
    expect(scheduler.totalTicks).toBe(83_333);
    expect(scheduler.totalDroppedTicks).toBe(0);
  });

  it("does not drift under jittery frame pacing", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    const random = lcg(0xd15c0);
    let now = 0;

    for (let frame = 0; frame < 100_000; frame += 1) {
      // 1..33 ms: irregular, but always under the catch-up clamp.
      now += (1 + (random() % 33)) * MS;
      scheduler.advance(now);
    }

    expect(scheduler.totalDroppedTicks).toBe(0);
    expect(scheduler.totalTicks).toBe(Math.floor(now / TICK_NANOS));
  });

  it("stays exact for a rate with no whole-nanosecond period", () => {
    // 60 Hz is 16 666 666.66... ns per tick. Only the exact ratio survives 10s.
    const scheduler = new FixedStepScheduler({
      rate: { ticks: 60, perNanos: NANOS_PER_SECOND },
    });
    scheduler.advance(0);
    for (let frame = 1; frame <= 10_000; frame += 1) {
      scheduler.advance(frame * MS);
    }
    expect(scheduler.totalTicks).toBe(600);
    expect(scheduler.remainderNanos).toBe(0);
  });
});

describe("burst clamping", () => {
  it("caps a backgrounded-tab catch-up and reports the drops", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    const batch = scheduler.advance(5 * NANOS_PER_SECOND);

    expect(batch.ticks).toBe(DEFAULT_MAX_CATCH_UP_TICKS);
    expect(batch.droppedTicks).toBe(250 - DEFAULT_MAX_CATCH_UP_TICKS);
    expect(scheduler.totalDroppedTicks).toBe(242);
  });

  it("does not bank the dropped time, so the next frame is normal again", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    scheduler.advance(5 * NANOS_PER_SECOND);
    // Were the surplus carried, this frame would clamp again and never recover.
    expect(scheduler.advance(5 * NANOS_PER_SECOND + TICK_NANOS)).toEqual({
      ticks: 1,
      droppedTicks: 0,
    });
  });

  it("keeps the sub-tick remainder through a clamped burst", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    // 250 ticks plus half a tick.
    scheduler.advance(5 * NANOS_PER_SECOND + 10 * MS);
    expect(scheduler.remainderNanos).toBe(10 * MS);
    // The kept half plus another half completes exactly one further tick.
    expect(scheduler.advance(5 * NANOS_PER_SECOND + 20 * MS)).toEqual({
      ticks: 1,
      droppedTicks: 0,
    });
  });

  it("honours a custom clamp", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0, maxCatchUpTicks: 3 });
    expect(scheduler.advance(NANOS_PER_SECOND)).toEqual({ ticks: 3, droppedTicks: 47 });
  });

  it("reports running slow differently from skipping time", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    // Exactly at the clamp: heavy load, but no time was lost.
    const batch = scheduler.advance(DEFAULT_MAX_CATCH_UP_TICKS * TICK_NANOS);
    expect(batch).toEqual({ ticks: DEFAULT_MAX_CATCH_UP_TICKS, droppedTicks: 0 });
  });
});

describe("pause and resume", () => {
  it("emits nothing while paused", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    scheduler.pause();
    expect(scheduler.paused).toBe(true);
    expect(scheduler.advance(10 * NANOS_PER_SECOND)).toEqual({ ticks: 0, droppedTicks: 0 });
    expect(scheduler.totalTicks).toBe(0);
    expect(scheduler.totalDroppedTicks).toBe(0);
  });

  it("neither leaks nor duplicates ticks across a pause", () => {
    const cadence = 30 * MS; // 1.5 ticks per frame, so a remainder always exists.

    const uninterrupted = new FixedStepScheduler({ startNanos: 0 });
    const paused = new FixedStepScheduler({ startNanos: 0 });

    expect(uninterrupted.advance(cadence)).toEqual({ ticks: 1, droppedTicks: 0 });
    expect(paused.advance(cadence)).toEqual({ ticks: 1, droppedTicks: 0 });
    expect(paused.remainderNanos).toBe(10 * MS);

    paused.pause();
    paused.advance(60 * NANOS_PER_SECOND);
    paused.resume(60 * NANOS_PER_SECOND);
    expect(paused.paused).toBe(false);

    // The half tick banked before the pause must still be there: without it this
    // frame yields 1 tick instead of 2.
    for (let frame = 2; frame <= 20; frame += 1) {
      const expected = uninterrupted.advance(frame * cadence);
      expect(paused.advance(60 * NANOS_PER_SECOND + (frame - 1) * cadence)).toEqual(expected);
    }
    expect(paused.totalTicks).toBe(uninterrupted.totalTicks);
    expect(paused.remainderNanos).toBe(uninterrupted.remainderNanos);
  });

  it("re-seeds on the next frame when resumed without a timestamp", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    scheduler.advance(30 * MS);
    scheduler.pause();
    scheduler.resume();

    // Hours of wall time passed while paused; none of it may become ticks.
    expect(scheduler.advance(6 * 3600 * NANOS_PER_SECOND)).toEqual({ ticks: 0, droppedTicks: 0 });
    expect(scheduler.totalDroppedTicks).toBe(0);
    // The pre-pause remainder survived, so 30 ms now completes two ticks.
    expect(scheduler.advance(6 * 3600 * NANOS_PER_SECOND + 30 * MS)).toEqual({
      ticks: 2,
      droppedTicks: 0,
    });
  });

  it("clears carried time and counters on reset", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    scheduler.advance(30 * MS);
    scheduler.reset(0);
    expect(scheduler.totalTicks).toBe(0);
    expect(scheduler.remainderNanos).toBe(0);
    expect(scheduler.paused).toBe(false);
    expect(scheduler.advance(30 * MS)).toEqual({ ticks: 1, droppedTicks: 0 });
  });
});

describe("hostile clocks", () => {
  it("returns no ticks for a repeated timestamp", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    expect(scheduler.advance(TICK_NANOS)).toEqual({ ticks: 1, droppedTicks: 0 });
    expect(scheduler.advance(TICK_NANOS)).toEqual({ ticks: 0, droppedTicks: 0 });
    expect(scheduler.advance(TICK_NANOS)).toEqual({ ticks: 0, droppedTicks: 0 });
  });

  it("ignores a backwards timestamp instead of rewinding", () => {
    const scheduler = new FixedStepScheduler({ startNanos: NANOS_PER_SECOND });
    expect(scheduler.advance(NANOS_PER_SECOND / 2)).toEqual({ ticks: 0, droppedTicks: 0 });
    // Had the clock been rewound to 0.5 s, this frame would look like 520 ms of
    // work and clamp; the timeline must stay where it was.
    expect(scheduler.advance(NANOS_PER_SECOND + TICK_NANOS)).toEqual({
      ticks: 1,
      droppedTicks: 0,
    });
  });

  it("never yields a negative or over-cap count for any timestamp sequence", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    const random = lcg(1995);

    for (let frame = 0; frame < 5_000; frame += 1) {
      // Timestamps scattered across a 100 s window with no ordering guarantee.
      const batch = scheduler.advance((random() % 100_000) * MS);
      expect(batch.ticks).toBeGreaterThanOrEqual(0);
      expect(batch.ticks).toBeLessThanOrEqual(DEFAULT_MAX_CATCH_UP_TICKS);
      expect(batch.droppedTicks).toBeGreaterThanOrEqual(0);
      expect(scheduler.remainderNanos).toBeGreaterThanOrEqual(0);
      expect(scheduler.remainderNanos).toBeLessThan(TICK_NANOS);
    }
  });
});

describe("render interpolation", () => {
  it("reports the sub-tick phase in [0, 1)", () => {
    const scheduler = new FixedStepScheduler({ startNanos: 0 });
    expect(scheduler.interpolation).toBe(0);
    scheduler.advance(5 * MS);
    expect(scheduler.interpolation).toBe(0.25);
    // Landing exactly on a tick boundary leaves nothing to interpolate.
    scheduler.advance(20 * MS);
    expect(scheduler.interpolation).toBe(0);
    scheduler.advance(25 * MS);
    expect(scheduler.interpolation).toBe(0.25);
  });
});
