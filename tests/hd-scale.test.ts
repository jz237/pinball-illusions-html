/**
 * The Q10 -> HD pixel mapping: `(q10 * 4) >> 10`.
 *
 * Small on purpose — the mapping is one expression — but the properties
 * pinned here are what the whole HD placement model hangs on: it floors
 * exactly as the native mapping floors (never disagrees with `q10ToPixel`
 * about which native pixel a coordinate is in), and it resolves the four
 * quarter-native-pixel positions inside that pixel, which is the sub-pixel
 * motion the HD pass exists to show.
 */

import { describe, expect, it } from "vitest";

import { HD_SCALE, q10ToHdPixel } from "../src/browser/hd-scale.js";
import { HD_ASSET_SCALE } from "../src/game/table-art-hd.js";
import { pixelsToQ10, q10ToPixel } from "../src/core/fixed-point.js";

describe("q10ToHdPixel", () => {
  it("is (q10 * 4) >> 10, exactly", () => {
    for (const value of [0, 1, 255, 256, 257, 1023, 1024, 4096, 351_231, 614_400, -1, -255, -256, -1024, -1025]) {
      expect(q10ToHdPixel(value)).toBe((value * 4) >> 10);
    }
  });

  it("maps whole playfield pixels to exactly 4x", () => {
    for (const pixel of [0, 1, 17, 168, 335, 599]) {
      expect(q10ToHdPixel(pixelsToQ10(pixel))).toBe(pixel * HD_SCALE);
    }
  });

  it("never disagrees with the native floor about the containing pixel", () => {
    // Sweep the playfield's coordinate range, including the transient
    // negatives the physics can produce, on a step that is prime to 1024 so
    // every sub-pixel phase is visited.
    for (let value = -8_192; value <= 620_000; value += 37) {
      expect(Math.floor(q10ToHdPixel(value) / HD_SCALE)).toBe(q10ToPixel(value));
    }
  });

  it("resolves quarter-native-pixel steps", () => {
    // 256 Q10 units is a quarter of a native pixel. Four consecutive quarter
    // positions land on four consecutive HD pixels — the motion the native
    // path floors away entirely.
    const base = pixelsToQ10(100);
    expect([0, 256, 512, 768].map((q) => q10ToHdPixel(base + q))).toEqual([400, 401, 402, 403]);
    // And every one of them is still native pixel 100.
    for (const q of [0, 256, 512, 768]) {
      expect(q10ToPixel(base + q)).toBe(100);
    }
  });

  it("agrees with the exporter and the loader about what HD is", () => {
    expect(HD_SCALE).toBe(4);
    expect(HD_ASSET_SCALE).toBe(HD_SCALE);
  });
});
