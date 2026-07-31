/**
 * Q10 signed fixed-point arithmetic.
 *
 * Ball positions are signed 32-bit integers with 10 fractional bits, so one
 * playfield pixel is 1024 units. Velocities are signed 16-bit and are added to
 * positions once per simulation tick. Keeping the whole simulation on integers
 * is what makes replays reproduce exactly: a recorded input sequence yields the
 * same trajectory on every machine, which is the basis of the parity tests.
 */

export const Q10_FRACTIONAL_BITS = 10;
export const Q10_ONE = 1 << Q10_FRACTIONAL_BITS;

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;
const INT16_MIN = -0x8000;
const INT16_MAX = 0x7fff;

/** A position or distance in Q10 units. */
export type Q10 = number;

/** Converts whole pixels to Q10. */
export function pixelsToQ10(pixels: number): Q10 {
  return Math.round(pixels * Q10_ONE) | 0;
}

/** Truncates a Q10 value toward negative infinity to a whole pixel. */
export function q10ToPixel(value: Q10): number {
  return value >> Q10_FRACTIONAL_BITS;
}

/** Wraps to signed 32-bit, matching the original hardware's overflow behaviour. */
export function q10WrapSigned32(value: number): Q10 {
  return value | 0;
}

/**
 * Adds a signed 16-bit velocity to a Q10 position.
 *
 * The velocity is sign-extended and the sum wraps at 32 bits rather than
 * saturating, so a ball driven past the coordinate limit behaves the way the
 * original did instead of sticking at the boundary.
 */
export function q10IntegrateSigned16Velocity(position: Q10, velocity: number): Q10 {
  if (!Number.isInteger(velocity) || velocity < INT16_MIN || velocity > INT16_MAX) {
    throw new RangeError(`velocity out of signed 16-bit range: ${velocity}`);
  }
  return q10WrapSigned32(position + velocity);
}

/**
 * Multiplies two Q10 values, rounding the result half away from zero.
 *
 * The rounding rule has to be sign-symmetric or the simulation stops being
 * mirror-symmetric: `Math.round` alone breaks ties toward +Infinity, so a
 * rebound of -0.5 units would keep less magnitude than the same rebound of
 * +0.5, and a trajectory reflected about a vertical wall would not retrace its
 * mirror image. Rounding the magnitude and reapplying the sign gives
 * `q10Multiply(-a, b) === -q10Multiply(a, b)` for every input.
 *
 * Dividing by `Q10_ONE` is exact — it is a power of two, so it only shifts the
 * exponent of an already-safe integer — which is why the tie can be detected at
 * all and why the result does not depend on the host's floating-point mode.
 */
export function q10Multiply(a: Q10, b: Q10): Q10 {
  const product = a * b;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`Q10 product exceeds safe integer range: ${a} * ${b}`);
  }
  const scaled = product / Q10_ONE;
  // `-Math.round(-scaled)` rounds the magnitude, so .5 always moves away from
  // zero. The `| 0` inside q10WrapSigned32 also collapses the -0 this produces
  // for small negative products.
  return q10WrapSigned32(scaled < 0 ? -Math.round(-scaled) : Math.round(scaled));
}

/** Divides two Q10 values, truncating toward zero. Throws on divide by zero. */
export function q10Divide(numerator: Q10, denominator: Q10): Q10 {
  if (denominator === 0) {
    throw new RangeError("Q10 divide by zero");
  }
  return Math.trunc((numerator * Q10_ONE) / denominator) | 0;
}

/** Clamps a Q10 value into an inclusive range. */
export function q10Clamp(value: Q10, minimum: Q10, maximum: Q10): Q10 {
  if (minimum > maximum) {
    throw new RangeError(`inverted clamp range: ${minimum} > ${maximum}`);
  }
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

/** True when a number is representable as a signed 32-bit integer. */
export function isSigned32(value: number): boolean {
  return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}
