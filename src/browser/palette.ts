/**
 * Overlay palette: every colour on screen that did NOT come off the disk.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS LEFT IN HERE, AND WHY IT IS SO SHORT
 * ---------------------------------------------------------------------------
 * This file used to define the whole table: deck tones, structure bevels, ramp
 * violets, collision-line chrome — a complete invented palette for a procedural
 * drawing of the collision map. None of that survives. The playfield is now the
 * decoded slot-3 artwork, so the table's colours are the 1995 artist's own,
 * shipped in the PNG's PLTE and applied by `src/game/table-art.ts`. Choosing a
 * playfield colour here would mean overruling the original, which is the exact
 * mistake this project is unwinding.
 *
 * What remains is the handful of things the disk does not supply and the
 * renderer therefore has to invent:
 *
 *   - the ball and the flippers, which are sprites in the original and are not
 *     in the playfield bitmap at all (the flippers are not even in the collision
 *     map — see the shooter-lane note in `game-loop.ts`);
 *   - the HUD, which is instrumentation, not artwork;
 *   - the cabinet surround, i.e. the canvas outside the scaled playfield.
 *
 * Sprite and HUD colours are hex strings because that is what a canvas
 * `fillStyle` and `strokeStyle` take; `CABINET_BLACK` is an `Rgb` triple because
 * the rasteriser writes it into a byte buffer. `SURROUND` is derived from it so
 * the two can never drift apart.
 */

/** A straight 24-bit colour. Tuples, so `noUncheckedIndexedAccess` stays quiet. */
export type Rgb = readonly [number, number, number];

/** Debug helper, and the source of `SURROUND`: "#rrggbb". */
export function toHex(colour: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${part(colour[0])}${part(colour[1])}${part(colour[2])}`;
}

// ---------------------------------------------------------------------------
// Cabinet
// ---------------------------------------------------------------------------

/**
 * Everything that is not playfield: the canvas around the scaled picture, and
 * any part of the raster the artwork does not cover.
 *
 * Nearly black rather than black. A true 0,0,0 surround against a dark AGA
 * playfield makes the edge of the table vanish on a cheap panel, and a hair of
 * blue keeps the boundary readable without competing with the artwork.
 */
export const CABINET_BLACK: Rgb = [5, 7, 12];

/** The same colour as a canvas fill style. */
export const SURROUND = toHex(CABINET_BLACK);

// ---------------------------------------------------------------------------
// The ball
// ---------------------------------------------------------------------------

/**
 * A steel ball is a mirror: it reads as a bright body, a shaded lower rim and a
 * single hard specular dot. Three flat tones, drawn as three offset circles —
 * which is how the original's ball sprite is shaded too, at this size there is
 * no room for anything subtler.
 */
export const BALL_FILL = "#e8eef6";
export const BALL_SHADE = "#7d8797";
export const BALL_HIGHLIGHT = "#ffffff";

// ---------------------------------------------------------------------------
// The flippers
// ---------------------------------------------------------------------------

/**
 * Red bats with a yellow edge, the way the AGA release draws them. Warm enough
 * to stay legible over any of the three playfields, which are variously blue
 * (Law 'n Justice), sandy (BabeWatch) and grey-green (Extreme Sports).
 */
export const FLIPPER_FILL = "#d8452f";
export const FLIPPER_EDGE = "#f7c948";

// ---------------------------------------------------------------------------
// The HUD
// ---------------------------------------------------------------------------

/** Status text, and the colour it turns when the machine has tilted. */
export const HUD_TEXT = "#9fb4cc";
export const HUD_ALERT = "#ff6b5a";
