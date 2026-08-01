/**
 * The shell's SKIN: the decoded `menudata.bin` artwork, baked into drawables.
 *
 * `src/game/shell-art.ts` loads and validates the exported data — glyph
 * atlases, backdrop strips, palette — as plain byte arrays, which is the form
 * tests can assert on. A canvas cannot blit byte arrays, so this module turns
 * them into `CanvasImageSource`s once, up front:
 *
 *   - each backdrop strip becomes one 1472 x 32 offscreen canvas holding the
 *     strip through the shared 16-colour palette;
 *   - each font becomes one offscreen canvas per text colour, tinted on
 *     demand and cached: plane-0 pixels take the fill colour, plane-1 pixels
 *     are the black outline, everything else stays transparent. That is the
 *     glyph plane semantics from the decode; the exact colour registers the
 *     original loads for its text planes are the one thing `menudata.bin`
 *     does not carry, so WHICH white the fill is, is this reconstruction's
 *     choice — the fade table's text entries are all 0xFFF white, and that is
 *     what `shell-screens.ts` asks for.
 *
 * The canvas factory is injected so this file never touches `document` itself
 * and a test can hand it a recording double. `shell-screens.ts` is the only
 * consumer; it draws these surfaces with `drawImage` at integer scales with
 * smoothing off, which is what keeps the 1995 pixels square.
 */

import type { ShellArt, ShellBackdropRole } from "../game/shell-art.js";
import { FONT_ATLAS_WIDTH, STRIP_HEIGHT, STRIP_WIDTH } from "../game/shell-art.js";

/** The slice of a canvas this module needs from its factory. */
export interface SkinCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): SkinCanvasContext | null;
}

export interface SkinCanvasContext {
  putImageData(data: ImageData, x: number, y: number): void;
}

export type SkinCanvasFactory = (width: number, height: number) => SkinCanvas;

/** Which of the two decoded fonts a run of text is set in. */
export type SkinFontKey = "font1" | "font2";

/**
 * The two blit passes a run of text is drawn in.
 *
 * The original ORs each glyph into the two text planes, so where one glyph's
 * 16-px box overlaps the next — constant, with advances as narrow as 4 — a
 * later outline never eats an earlier fill. `drawImage` is paint, not OR;
 * drawing every outline first and every fill second reproduces the OR result
 * exactly, because fill beats outline wherever both land.
 */
export type SkinFontLayer = "outline" | "fill";

export interface ShellSkin {
  /** The decoded data itself: metrics, sine, dissolve orders, palette. */
  readonly art: ShellArt;
  /** Colour 0 — the 0x36A blue every shell screen sits on — as "#rrggbb". */
  readonly background: string;
  backdrop(role: ShellBackdropRole): CanvasImageSource;
  /**
   * One layer of a font's atlas: the black outline (plane 1), or the fill
   * (plane 0) tinted to `colour` ("#rrggbb"), built once per colour.
   */
  fontAtlas(font: SkinFontKey, layer: SkinFontLayer, colour: string): CanvasImageSource;
}

/** The glyph outline is always black — plane 1 is the drop-shadow plane. */
const OUTLINE: readonly [number, number, number] = [0, 0, 0];

function parseHexColour(colour: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(colour);
  if (match === null) throw new Error(`skin colours are "#rrggbb", got ${colour}`);
  const value = parseInt(match[1] ?? "0", 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function surface(createCanvas: SkinCanvasFactory, width: number, height: number, rgba: Uint8ClampedArray<ArrayBuffer>): SkinCanvas {
  const canvas = createCanvas(width, height);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("skin canvas gave no 2d context");
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

export function createShellSkin(art: ShellArt, createCanvas: SkinCanvasFactory): ShellSkin {
  const backdrops = new Map<ShellBackdropRole, SkinCanvas>();
  for (const role of ["attract", "menu", "select"] as const) {
    const strip = art.backdrops[role];
    const rgba = new Uint8ClampedArray(STRIP_WIDTH * STRIP_HEIGHT * 4);
    for (let i = 0; i < strip.pixels.length; i += 1) {
      const entry = (strip.pixels[i] ?? 0) * 3;
      const at = i * 4;
      rgba[at] = art.palette[entry] ?? 0;
      rgba[at + 1] = art.palette[entry + 1] ?? 0;
      rgba[at + 2] = art.palette[entry + 2] ?? 0;
      rgba[at + 3] = 255;
    }
    backdrops.set(role, surface(createCanvas, STRIP_WIDTH, STRIP_HEIGHT, rgba));
  }

  const atlases = new Map<string, SkinCanvas>();
  const fontAtlas = (
    font: SkinFontKey,
    layer: SkinFontLayer,
    colour: string,
  ): CanvasImageSource => {
    // Every outline is the same black, so the layer's cache key ignores colour.
    const key = layer === "outline" ? `${font}:outline` : `${font}:fill:${colour}`;
    const cached = atlases.get(key);
    if (cached !== undefined) return cached as unknown as CanvasImageSource;
    const data = font === "font1" ? art.font1 : art.font2;
    const fill = parseHexColour(colour);
    const rgba = new Uint8ClampedArray(FONT_ATLAS_WIDTH * data.rows * 4);
    for (let i = 0; i < data.pixels.length; i += 1) {
      const value = data.pixels[i] ?? 0;
      // The outline layer carries every plane-1 pixel; the fill layer carries
      // every plane-0 pixel. A pixel with both planes set is painted by both
      // passes and ends up fill-coloured, which is the OR result.
      const wanted = layer === "outline" ? (value & 2) !== 0 : (value & 1) !== 0;
      if (!wanted) continue;
      const tone = layer === "outline" ? OUTLINE : fill;
      const at = i * 4;
      rgba[at] = tone[0];
      rgba[at + 1] = tone[1];
      rgba[at + 2] = tone[2];
      rgba[at + 3] = 255;
    }
    const built = surface(createCanvas, FONT_ATLAS_WIDTH, data.rows, rgba);
    atlases.set(key, built);
    return built as unknown as CanvasImageSource;
  };

  const background = `#${[0, 1, 2]
    .map((channel) => (art.palette[channel] ?? 0).toString(16).padStart(2, "0"))
    .join("")}`;

  return {
    art,
    background,
    backdrop: (role) => backdrops.get(role) as unknown as CanvasImageSource,
    fontAtlas,
  };
}
