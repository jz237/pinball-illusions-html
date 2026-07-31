/**
 * Playfield palette.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A PALETTE FILE AT ALL
 * ---------------------------------------------------------------------------
 * No table artwork is extracted or shipped. The playfield is drawn procedurally
 * from the four-layer material map, so every colour on screen originates here
 * and nowhere else. That makes this file the single tuning point for the look:
 * change a constant, reload, done. Nothing in `playfield-renderer.ts` contains a
 * literal colour.
 *
 * ---------------------------------------------------------------------------
 * THE PERIOD CONSTRAINT
 * ---------------------------------------------------------------------------
 * The 1995 AGA release ran a chunky 336-pixel-wide playfield out of a small
 * fixed palette. Two consequences are baked into these values:
 *
 *  1. FEW COLOURS. Each visual class gets a body tone plus one lighter and one
 *     darker bevel tone — three entries, the way a 1990s pixel artist would
 *     have budgeted a ramp. There are no gradients per class; the only gradient
 *     on the table is the ordered-dithered deck, which is exactly how the era
 *     faked one.
 *  2. DARK DECK, BRIGHT RAILS. A pinball playfield photographs as a dark field
 *     with specular metal on it. Keeping the deck near-black buys the contrast
 *     that makes 1-pixel collision outlines legible at 1:1, which matters
 *     because those outlines are literally one pixel wide in the source data.
 *
 * AGA gives 8 bits per gun, so these are plain 24-bit values with no
 * quantisation needed — the restraint is in the count, not the bit depth.
 *
 * ---------------------------------------------------------------------------
 * HOW THE CLASSES MAP ONTO THE DATA
 * ---------------------------------------------------------------------------
 * The renderer draws by BIT MEANING, never by raw index (see materials.ts):
 *
 *   bit 0 (1) lower collision line  -> LOWER_EDGE_*   the lit edge of furniture
 *   bit 1 (2) upper collision line  -> UPPER_RAIL_*   habitrail / ramp rail
 *   bit 2 (4) lower structure       -> STRUCTURE_*    table-surface furniture
 *   bit 3 (8) upper structure       -> RAMP_*         the raised deck above
 *   no bits                         -> DECK_*         bare playfield
 */

/** A straight 24-bit colour. Tuples, so `noUncheckedIndexedAccess` stays quiet. */
export type Rgb = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Cabinet
// ---------------------------------------------------------------------------

/** Fills the canvas outside the scaled playfield. Flat black reads as cabinet. */
export const CABINET_BLACK: Rgb = [0, 0, 0];

// ---------------------------------------------------------------------------
// Bare playfield (index 0, and everything else the ball simply rolls over)
// ---------------------------------------------------------------------------

/**
 * The deck is two tones ordered-dithered against each other, dark at the top of
 * the table and light at the bottom. One shade of difference only: the point is
 * to give the largest single class on every table (54% of Law 'n Justice) some
 * texture without ever competing with a rail for attention.
 */
export const DECK_DARK: Rgb = [15, 21, 32];
export const DECK_LIGHT: Rgb = [21, 29, 43];

/**
 * Every colour a bare, unshadowed playfield pixel can take.
 * Exported so callers and tests can ask "is this bare deck?" without knowing
 * which side of the dither a given pixel landed on.
 */
export const DECK_TONES: readonly Rgb[] = [DECK_DARK, DECK_LIGHT];

// ---------------------------------------------------------------------------
// bit 2 — lower-playfield structure: the furniture standing on the deck
// ---------------------------------------------------------------------------

/**
 * Slingshot bodies, bumper discs, lane guides, the region beyond the outer
 * wall. 33% of Law 'n Justice. A desaturated slate blue: it must read as
 * *solid object* against the deck while leaving the top of the brightness range
 * free for the rails that sit on it.
 */
export const STRUCTURE_BODY: Rgb = [46, 62, 82];
/** Top face of a structure body — one row where it meets open deck. */
export const STRUCTURE_LIGHT: Rgb = [78, 102, 128];
/** Bottom face, i.e. the side turned away from the light. */
export const STRUCTURE_DARK: Rgb = [26, 36, 50];

// ---------------------------------------------------------------------------
// bit 0 — lower collision line: the lit edge of that furniture
// ---------------------------------------------------------------------------

/**
 * The one bit the original's lower-playfield physics tests, so it is also the
 * one the player must be able to see. Warm chrome, brightest thing on the lower
 * level, with a duller tone for the underside so a 1-pixel outline still reads
 * as having a top and a bottom.
 */
export const LOWER_EDGE_LIT: Rgb = [245, 226, 160];
export const LOWER_EDGE_DIM: Rgb = [166, 140, 84];

// ---------------------------------------------------------------------------
// bit 3 — upper-playfield structure: the raised deck
// ---------------------------------------------------------------------------

/**
 * Ramp decks and overpasses. In the original this layer is an AND-NOT mask in
 * the ball blitter — the ball is drawn *under* it — so here it occludes
 * everything on the lower level too. Violet plastic, deliberately a different
 * hue family from the slate furniture so the two levels never blur together.
 */
export const RAMP_BODY: Rgb = [92, 72, 128];
/** Lit top edge of the raised deck. */
export const RAMP_LIGHT: Rgb = [150, 128, 190];
/** Underside of the raised deck. */
export const RAMP_DARK: Rgb = [54, 40, 80];

// ---------------------------------------------------------------------------
// bit 1 — upper collision line: the rail on the raised deck
// ---------------------------------------------------------------------------

/**
 * Habitrails and ramp guide rails. Cold cyan against the warm chrome of the
 * lower edge: the level a rail belongs to is then readable from hue alone, at
 * one pixel wide, which is the whole reason the two collision layers get
 * different colours instead of different brightnesses.
 */
export const UPPER_RAIL_LIT: Rgb = [186, 240, 255];
export const UPPER_RAIL_DIM: Rgb = [96, 176, 206];

// ---------------------------------------------------------------------------
// Depth cue
// ---------------------------------------------------------------------------

/**
 * The raised deck casts a hard offset shadow onto whatever is below it. Without
 * this the ramp layer looks like a differently-coloured floor tile rather than
 * something suspended over the table.
 *
 * Offsets are in playfield pixels, down and to the right. Kept small: at 1:1
 * these are literal single pixels, and a big offset at this resolution stops
 * looking like height and starts looking like a printing error.
 */
export const RAMP_SHADOW_OFFSET_X = 2;
export const RAMP_SHADOW_OFFSET_Y = 3;

/** Multiplier applied to whatever the shadow falls on. Below 1 darkens. */
export const RAMP_SHADOW_STRENGTH = 0.55;

/**
 * Darkens a colour toward black by `strength`.
 *
 * Rounds rather than truncates so the operation is symmetric, and it is a pure
 * function of its inputs so the whole raster stays byte-for-byte deterministic.
 */
export function shade(colour: Rgb, strength: number): Rgb {
  return [
    Math.round(colour[0] * strength),
    Math.round(colour[1] * strength),
    Math.round(colour[2] * strength),
  ];
}

/** Debug helper: "#rrggbb" for logging and for pasting into a picker. */
export function toHex(colour: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${part(colour[0])}${part(colour[1])}${part(colour[2])}`;
}
