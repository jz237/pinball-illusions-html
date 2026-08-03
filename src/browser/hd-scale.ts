/**
 * The HD scale, and the one new piece of coordinate arithmetic it brings.
 *
 * ---------------------------------------------------------------------------
 * WHERE S ENTERS, AND WHERE IT MUST NEVER GO
 * ---------------------------------------------------------------------------
 * The HD pass multiplies PRESENTATION by four: 1344x2400 playfield masters,
 * 4x sprites, a 1344x1024 window canvas. The simulation stays 336x600 Q10 and
 * never hears about any of it — `tests/sim-hash-pin.test.ts` holds the per-tick
 * state hashes recorded before this file existed, and they must never move.
 * Enforced in structure as well as by test: this module lives in
 * `src/browser/` and NOTHING under `src/game/` or `src/core/` may import it.
 * (The HD asset loaders in `src/game/table-art-hd.ts` are loaders, not
 * simulation — no sim module imports them either.)
 *
 * Both sibling remakes (Pinball Fantasies HD, Pinball Dreams HD) shipped this
 * exact skeleton: original-resolution fixed-point simulation, 4x art master,
 * render-side scale. See research/HD_BRIEF.md for the file-cited study.
 *
 * ---------------------------------------------------------------------------
 * THE SUB-PIXEL DIVIDEND
 * ---------------------------------------------------------------------------
 * Q10 carries ten fractional bits per playfield pixel, and until now every
 * placement floored them away (`q10ToPixel` is `>> 10`). At HD the floor
 * happens in HD units instead: `(v * 4) >> 10` keeps two of those ten bits,
 * so a slow-rolling ball advances in quarter-native-pixel steps instead of
 * whole-pixel stair-steps. Neither sibling does this — both place movers at
 * integer logical pixels — so this is the one place the reconstruction shows
 * MORE of the original's own state than the original's display could.
 *
 * Placement stays integer in HD units (no fractional-coordinate smear), and at
 * scale 1 the formula degenerates to exactly `q10ToPixel`'s floor, which is
 * what pins the two mappings together.
 */

import type { Q10 } from "../core/fixed-point.js";

/**
 * How many HD pixels a native playfield pixel is. 4, the shipped convention of
 * both sibling remakes (1280-wide at 4x; Illusions is 336 native, so 1344).
 */
export const HD_SCALE = 4;

/**
 * A Q10 playfield coordinate as an integer HD pixel, flooring — the HD
 * counterpart of `q10ToPixel`.
 *
 * `(v * 4) >> 10`: for non-negative coordinates this is `v >> 8`, and for the
 * transient negatives the physics can produce it floors exactly as `>> 10`
 * does, so a sprite's HD position is never above-left of `q10ToPixel(v) * 4`
 * by more than the sub-pixel remainder. Q10 playfield values are bounded by
 * the 600-row table (about 6.1e5), so the multiply is nowhere near 2^31.
 */
export function q10ToHdPixel(value: Q10): number {
  return (value * HD_SCALE) >> 10;
}
