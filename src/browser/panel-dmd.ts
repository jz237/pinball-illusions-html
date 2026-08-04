/**
 * The score panel AS A DOT MATRIX — phase 2 of the HD pass.
 *
 * ---------------------------------------------------------------------------
 * THE PANEL IS A DMD.  THIS IS MEASURED, NOT A STYLE CHOICE.
 * ---------------------------------------------------------------------------
 * `panel-renderer.ts` rasterises the strip 1:1 at 320 x 16 and `panel-display`
 * used to blit that nearest-magnified, so at HD every panel pixel became a flat
 * `scale x scale` block. That is not what the machine puts on screen.
 *
 * Session 5 filmed the original at native resolution
 * (`research/view/reference/session5`) and this round counted the pixels of its
 * five stills rather than trusting the prose (`research/hd/phase23/INDEX.txt`
 * section 1). The panel band occupies screen columns 94..733 and rows 26..89 of
 * the 752 x 574 native frame — 640 x 64 screen pixels for a 320 x 16 panel — and
 * inside it:
 *
 *   - EVERY cell that contains any lit pixel has the same shape, on all five
 *     stills, and there is never a second shape:
 *
 *         ## . .
 *         ## . .
 *         . . . .
 *         . . . .
 *
 *     A dot is a 2 x 2 square in a 4 x 4 cell, anchored top-left: half the pitch
 *     on each axis, a quarter of the cell's area.
 *   - The band holds exactly THREE colours and the black count NEVER MOVES:
 *     30,720 px = 2,560 cells x 12 px, in every state, whatever is displayed.
 *     The gaps between dots are pure black.
 *   - unlit(68,34,0) + lit(255,170,0) = 4 x 2,560 in every still, so ALL 2,560
 *     dots are drawn and the dark ones are a dimmed amber, not black. The
 *     lattice is visible even where nothing is written.
 *   - The X2 AWARD still is a slot-5 ANIMATION frame, not text, and it has the
 *     identical cell shape and no other. The whole panel is the matrix.
 *
 * Both siblings the operator named reached the same conclusion independently
 * for their own readouts, and NEITHER upscales it: Pinball Fantasies HD draws an
 * authored procedural dot matrix with `fillRect`, square dots, no glow, and the
 * unlit grid always drawn at 0.9 opacity (`src/browser/dot-matrix-display.ts`);
 * Pinball Dreams HD draws a vector 16-segment display in the DOM with its unlit
 * segments always visible. Running xBRZ over a dot matrix would melt the dots
 * into blobs, which is the one thing every shipped example of this surface
 * refuses to do.
 *
 * So the panel is not upscaled. It is RE-RENDERED at the device's own
 * resolution, from the same 320 x 16 raster `panel-renderer.ts` already
 * produces, with each raster pixel drawn as a dot. That costs no assets, needs
 * no rights gate, and gets sharper as the canvas does.
 *
 * ---------------------------------------------------------------------------
 * THE LATTICE ONLY APPEARS WHERE THERE IS ROOM FOR IT
 * ---------------------------------------------------------------------------
 * A gap needs at least one device pixel and a dot needs at least two, or the
 * panel loses half its resolution to make a pattern nobody can see. So the
 * lattice switches on at `DMD_MIN_SCALE` and not below, which has three
 * consequences worth stating plainly:
 *
 *   - a native (non-HD) build at scale 1 or 2 draws EXACTLY what it drew
 *     before — the legacy path is byte-identical, which is what the film gate
 *     checks;
 *   - a phone draws the same, because `canvas-fit.ts` caps a coarse pointer at
 *     `MOBILE_MAX_RENDER_SCALE` = 2. The HD panel is a desktop-class
 *     enhancement by construction, not a phone regression;
 *   - the dot geometry is a function of `scale` alone, so it is pure, cheap to
 *     test, and impossible to get out of step with the canvas.
 *
 * ---------------------------------------------------------------------------
 * WHOSE COLOURS THESE ARE
 * ---------------------------------------------------------------------------
 * The DOTS carry this port's own inks — `PANEL_AMBER`, `PANEL_WHITE`,
 * `PANEL_UNLIT` — read straight out of the raster, so the HD panel shows
 * exactly the colours the native panel shows and nothing here overrules
 * `palette.ts`. Only the GAP is new, because until now there were no gaps, and
 * the film measures it: pure black in every state.
 *
 * The film also hands over the machine's true registers — lit (255,170,0),
 * unlit dot (68,34,0) — for the three constants `palette.ts` openly labels a
 * reconstruction. Adopting those would move the legacy path and the film gate,
 * so it is a fidelity change and not an HD change; it is recorded in
 * `research/hd/phase23/INDEX.txt` section 5 as a ready finding and deliberately
 * not taken here.
 */

import { BYTES_PER_PIXEL } from "./playfield-renderer.js";
import type { PixelTarget } from "./playfield-renderer.js";
import { PANEL_UNLIT } from "./palette.js";
import type { Rgb } from "./palette.js";

/**
 * The smallest magnification that gets a lattice.
 *
 * Three, because a cell needs a dot of at least two device pixels and a gap of
 * at least one. Below it the panel blits exactly as it always did.
 */
export const DMD_MIN_SCALE = 3;

/**
 * What lies between the dots.
 *
 * MEASURED: the panel band of every session-5 still holds exactly 30,720 pure
 * black pixels — 2,560 cells x 12 px — whatever is on screen. The gap is black
 * and it is black in every state, so this is a decode and not a choice.
 */
export const DMD_GAP: Rgb = [0, 0, 0];

/** One cell's layout, in device pixels. */
export interface DmdGeometry {
  /** Cell pitch: one panel pixel's worth of device pixels. Equals `scale`. */
  readonly cell: number;
  /** The lit square's side, anchored at the cell's top-left corner. */
  readonly dot: number;
  /** `cell - dot`, on the right and bottom edges. Always at least 1. */
  readonly gap: number;
}

/**
 * The dot layout at a magnification, or null when no lattice fits.
 *
 * ONE device pixel of gap, not the machine's half-a-cell. The machine's ratio
 * is 50% of pitch on both axes, but its cell is TWO panel pixels wide (its
 * small font sets only every other panel column) where this port's raster fills
 * every column — session 5's own finding, that "the port's 320-px 1:1 strip has
 * twice the horizontal dot resolution of the original's". Halving a cell that
 * is already half the machine's would throw away a pixel of real content per
 * dot. A single-pixel gap keeps every pixel the renderer produced and still
 * shows the lattice; at scale 4 that is a 75% fill, which is also where both
 * Pinball Fantasies HD panels sit (1.45 of 1.9, and 1.2 of 1.6).
 */
export function dmdGeometryFor(scale: number): DmdGeometry | null {
  if (!Number.isInteger(scale) || scale < DMD_MIN_SCALE) return null;
  return { cell: scale, dot: scale - 1, gap: 1 };
}

/**
 * The band's width in cells for a `viewWidth`-wide view: the whole band, not
 * just the 320-px strip.
 *
 * The original's screen is 320 px and the panel fills it; this port's view is
 * 336, so there are eight pixels of margin each side. Those margins get unlit
 * cells rather than flat glass, so the band reads as ONE physical display
 * instead of a dotted strip inset in a solid one.
 */
export function dmdBandOffset(viewWidth: number, panelWidth: number): number {
  return Math.floor((viewWidth - panelWidth) / 2);
}

/**
 * Draws the panel raster as a dot matrix into `target`.
 *
 * `target` is the whole band at device resolution: `bandWidth * cell` by
 * `panel.height * cell`. Every cell in it gets a dot — the ones under the
 * panel raster in that pixel's own colour, the margins in `PANEL_UNLIT` — and
 * every gap gets `DMD_GAP`. Nothing is written outside the target, and the
 * whole target is written, so there is no need to clear it first.
 *
 * Pure and canvas-free, exactly like `renderPanelInto`, so a node test can
 * assert the dots byte for byte.
 */
export function renderDmdInto(
  panel: PixelTarget,
  target: PixelTarget,
  geometry: DmdGeometry,
  bandWidth: number,
  offset: number,
): PixelTarget {
  const { cell, dot } = geometry;
  const width = bandWidth * cell;
  const height = panel.height * cell;
  if (target.width !== width || target.height !== height) {
    throw new RangeError(
      `dot-matrix target is ${target.width}x${target.height}, expected ${width}x${height} ` +
        `for a ${bandWidth}-cell band at cell ${cell}`,
    );
  }
  const out = target.data;
  const [gr, gg, gb] = DMD_GAP;
  const [ur, ug, ub] = PANEL_UNLIT;

  for (let row = 0; row < panel.height; row += 1) {
    // The dot rows of this cell row, then the gap rows under them.
    for (let column = 0; column < bandWidth; column += 1) {
      const source = column - offset;
      let r = ur;
      let g = ug;
      let b = ub;
      if (source >= 0 && source < panel.width) {
        const at = (row * panel.width + source) * BYTES_PER_PIXEL;
        r = panel.data[at] ?? 0;
        g = panel.data[at + 1] ?? 0;
        b = panel.data[at + 2] ?? 0;
      }
      const left = column * cell;
      const top = row * cell;
      for (let y = 0; y < cell; y += 1) {
        const lit = y < dot;
        let to = ((top + y) * width + left) * BYTES_PER_PIXEL;
        for (let x = 0; x < cell; x += 1) {
          const on = lit && x < dot;
          out[to] = on ? r : gr;
          out[to + 1] = on ? g : gg;
          out[to + 2] = on ? b : gb;
          out[to + 3] = 255;
          to += BYTES_PER_PIXEL;
        }
      }
    }
  }
  return target;
}
