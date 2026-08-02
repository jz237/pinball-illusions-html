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

// ---------------------------------------------------------------------------
// The score panel
// ---------------------------------------------------------------------------

/**
 * The 320 x 16 score panel's three tones.
 *
 * The panel bitmap itself ships straight off the disk — three bitplanes at a
 * 40-byte row stride — but the COLOUR REGISTERS the copper loads over that
 * strip are not in the decoded data, the same gap as the shell fonts' text
 * colours. What the copper produces on screen is the amber-on-dark dot-matrix
 * look of a mid-90s pinball display with white picked out on top, so that is
 * what these three constants reconstruct: a dark warm glass for cleared
 * pixels, amber for the plane-0 fill (and the plane-2 score digits, which sit
 * on the same glass), and a warm white for the plane-1 outline highlights.
 * `Rgb` triples because `panel-renderer.ts` writes them into a byte buffer,
 * exactly like `CABINET_BLACK`.
 */
export const PANEL_UNLIT: Rgb = [26, 12, 4];
export const PANEL_AMBER: Rgb = [255, 148, 16];
export const PANEL_WHITE: Rgb = [255, 241, 214];

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/**
 * The shell's CHROME, measured off the filmed original.
 *
 * The tumbling-object strips and the sixteen page palettes they are drawn
 * through come off the disk (`scripts/export-shell-art.mjs` ->
 * `public/generated/shell/`) and `shell-screens.ts` takes those from the skin,
 * not from here. What is here is the part of the picture that is NOT in
 * `menudata.bin`: the original keeps its border, surround and text colours in a
 * fixed copper list in `main.bin` hunk 3, a different file, and pulling sixteen
 * words out of it would widen the `disk-derived-shell-artwork` gate class to a
 * second source. So they are stated here instead, as what they are —
 * measurements off the filmed screen, at native resolution, exact to the AGA
 * nibble:
 *
 *   surround ring   $003  #000033   x < 15, x > 304, y < 15, y > 240
 *   frame rect      $fff  #ffffff   1 px, (15,15)-(304,240)
 *   object field    $000  #000000   x 16..303, y 16..239 — and it is also
 *                                   colour 0 of every live page palette, so the
 *                                   two can only ever agree
 *   text            $fff / $aaa / $777, the two glyph planes' anti-alias ramp;
 *                   the skin derives the lower two from the ink colour.
 *
 * `SHELL_HIGHLIGHT` and `SHELL_HIGHLIGHT_FILL` are NOT measured — nothing on
 * the film is amber. They mark the freshly-earned ladder row and the fallback's
 * selected item, both of which are this reconstruction's own signposting.
 */
export const SHELL_SURROUND = "#000033";
export const SHELL_FIELD = "#000000";
export const SHELL_FRAME = "#ffffff";
export const SHELL_TEXT = "#ffffff";
/** The ramp's darkest step, used whole for lines the original never printed. */
export const SHELL_DIM = "#777777";
export const SHELL_HIGHLIGHT = "#f7c948";
export const SHELL_HIGHLIGHT_FILL = "#243a5e";
export const SHELL_PANEL = "#050a14";

/**
 * The placeholder backdrop, drawn only while the artwork is still fetching.
 *
 * A dark teal band on the black field: the same shape as the real thing —
 * eight 32-row bands of objects on black — in the tint the filmed menu page
 * happens to wear, so the swap to the real strip is a change of detail rather
 * than a change of scene.
 */
export const SHELL_BACKDROP = SHELL_FIELD;
export const SHELL_BAND = "#225555";
