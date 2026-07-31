import { describe, expect, it } from "vitest";
import {
  Q10_ONE,
  isSigned32,
  pixelsToQ10,
  q10Clamp,
  q10Divide,
  q10IntegrateSigned16Velocity,
  q10Multiply,
  q10ToPixel,
} from "../src/core/fixed-point.js";

describe("Q10 conversion", () => {
  it("maps one pixel to 1024 units", () => {
    expect(Q10_ONE).toBe(1024);
    expect(pixelsToQ10(1)).toBe(1024);
    expect(pixelsToQ10(-3)).toBe(-3072);
  });

  it("truncates toward negative infinity, so pixel bands stay uniform", () => {
    expect(q10ToPixel(1024)).toBe(1);
    expect(q10ToPixel(2047)).toBe(1);
    // -1 unit is inside pixel -1, not pixel 0; an arithmetic shift is what keeps
    // collision lookups from snapping to the wrong cell just left of the origin.
    expect(q10ToPixel(-1)).toBe(-1);
    expect(q10ToPixel(-1024)).toBe(-1);
  });
});

describe("velocity integration", () => {
  it("advances a position by a signed velocity", () => {
    expect(q10IntegrateSigned16Velocity(pixelsToQ10(10), 512)).toBe(10752);
    expect(q10IntegrateSigned16Velocity(pixelsToQ10(10), -512)).toBe(9728);
  });

  it("rejects velocities outside signed 16-bit range", () => {
    expect(() => q10IntegrateSigned16Velocity(0, 0x8000)).toThrow(RangeError);
    expect(() => q10IntegrateSigned16Velocity(0, -0x8001)).toThrow(RangeError);
  });

  it("wraps at 32 bits rather than saturating", () => {
    expect(isSigned32(q10IntegrateSigned16Velocity(0x7fffffff, 1))).toBe(true);
    expect(q10IntegrateSigned16Velocity(0x7fffffff, 1)).toBe(-0x80000000);
  });

  it("is exactly reversible, which replay determinism depends on", () => {
    let position = pixelsToQ10(160);
    for (const v of [37, -12, 400, -400, 12, -37]) {
      position = q10IntegrateSigned16Velocity(position, v);
    }
    expect(position).toBe(pixelsToQ10(160));
  });
});

describe("multiply and divide", () => {
  it("scales by a Q10 factor", () => {
    expect(q10Multiply(pixelsToQ10(4), pixelsToQ10(2))).toBe(pixelsToQ10(8));
    // 0.75 elasticity applied to an 8-pixel rebound.
    expect(q10Multiply(pixelsToQ10(8), 768)).toBe(pixelsToQ10(6));
  });

  it("rounds exact halves away from zero, in both signs", () => {
    // 512 * 1 / 1024 is exactly 0.5, the smallest tie there is.
    expect(q10Multiply(512, 1)).toBe(1);
    expect(q10Multiply(-512, 1)).toBe(-1);
    expect(q10Multiply(512, -1)).toBe(-1);
    expect(q10Multiply(-512, -1)).toBe(1);
    // 3 * 512 / 1024 is exactly 1.5.
    expect(q10Multiply(3, 512)).toBe(2);
    expect(q10Multiply(-3, 512)).toBe(-2);
    // 5 * 512 / 1024 is exactly 2.5 — away from zero, not to even.
    expect(q10Multiply(5, 512)).toBe(3);
    expect(q10Multiply(-5, 512)).toBe(-3);
  });

  it("rounds non-ties to nearest, and never returns negative zero", () => {
    expect(q10Multiply(511, 1)).toBe(0);
    expect(q10Multiply(-511, 1)).toBe(0);
    expect(Object.is(q10Multiply(-511, 1), 0)).toBe(true);
    expect(q10Multiply(513, 1)).toBe(1);
    expect(q10Multiply(-513, 1)).toBe(-1);
  });

  it("is odd, so mirrored trajectories stay mirror images", () => {
    // The wall grip factor from ball-physics; the old asymmetric rounding
    // broke this identity for 8 of these 4001 velocities.
    // `0 - x` rather than `-x`: negating a zero result gives -0, which toBe
    // compares with Object.is and would fail on v = 0 for no real reason.
    for (let v = -2000; v <= 2000; v += 1) {
      expect(q10Multiply(v, 870)).toBe(0 - q10Multiply(-v, 870));
      expect(q10Multiply(870, v)).toBe(0 - q10Multiply(870, -v));
    }
  });

  it("rejects a product outside the safe integer range instead of losing bits", () => {
    expect(() => q10Multiply(0x7fffffff, 0x7fffffff)).toThrow(RangeError);
  });

  it("divides and truncates toward zero", () => {
    expect(q10Divide(pixelsToQ10(8), pixelsToQ10(2))).toBe(pixelsToQ10(4));
    expect(q10Divide(pixelsToQ10(1), pixelsToQ10(3))).toBe(341);
  });

  it("throws rather than returning infinity", () => {
    expect(() => q10Divide(1024, 0)).toThrow(RangeError);
  });
});

describe("clamp", () => {
  it("bounds a value inclusively", () => {
    expect(q10Clamp(5000, 0, 1024)).toBe(1024);
    expect(q10Clamp(-5000, 0, 1024)).toBe(0);
    expect(q10Clamp(512, 0, 1024)).toBe(512);
  });

  it("rejects an inverted range instead of silently returning the wrong bound", () => {
    expect(() => q10Clamp(0, 1024, 0)).toThrow(RangeError);
  });
});
