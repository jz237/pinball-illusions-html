/**
 * The shell's SKIN: the decoded `menudata.bin` artwork, baked into drawables,
 * plus the backdrop service that decides which of it is on screen.
 *
 * `src/game/shell-art.ts` loads and validates the exported data — glyph
 * atlases, backdrop strips, the sixteen page palettes — as plain byte arrays,
 * which is the form tests can assert on. A canvas cannot blit byte arrays, so
 * this module turns them into `CanvasImageSource`s:
 *
 *   - a backdrop strip becomes one 1472 x 32 offscreen canvas holding the strip
 *     through WHICHEVER page palette is in force, repainted when that changes;
 *   - each font becomes one offscreen canvas per ink colour, built on demand
 *     and cached.
 *
 * ---------------------------------------------------------------------------
 * THE PALETTE IS NOT SHARED, AND IT MOVES
 * ---------------------------------------------------------------------------
 * `menudata` h4+0x480 is sixteen 16-colour palettes read row-major, not one
 * palette and not a fade table. Nine of them are live and the shell runs a
 * free-running service over them (`main.bin` h0+0x10AA, called once per PAL
 * field from the shell's main loop at h0+0x1060, in EVERY shell state):
 *
 *     fade to palette 0, hold 250 frames, fade to palette 1, hold 250 ...
 *     fade to palette 7, hold 250, fade to palette 8 — which is black — and at
 *     black swap to the next backdrop strip and restart at palette 0.
 *
 * The fade itself is h0+0x0A44: colours 1..15 only, each R/G/B nibble moved ONE
 * step per frame toward the target, so a fade lasts as many frames as the
 * largest nibble it has to cross. Colour 0 is never written — COLOR16 is set to
 * $0000 once at init and stays there — which is why the object field is black on
 * every page of the original.
 *
 * One backdrop is 2049 frames (40.98 s at 50 Hz) and the whole three-strip loop
 * 6147 (122.9 s). Because the service runs in every state, WHICH STRIP IS ON
 * SCREEN IS NOT DECIDED BY WHICH SCREEN YOU ARE ON: the film caught the same
 * credits page on the cube strip once and the torus twice across three cold
 * boots, and caught the main menu on the cube. `shellBackdropFrame` is that
 * service, as a pure function of a free-running tick.
 *
 * The canvas factory is injected so this file never touches `document` itself
 * and a test can hand it a recording double. `shell-screens.ts` is the only
 * consumer; it draws these surfaces with `drawImage` at integer scales with
 * smoothing off, which is what keeps the 1995 pixels square.
 */

import type { ShellArt, ShellBackdropRole, ShellPalette } from "../game/shell-art.js";
import {
  FONT_ATLAS_WIDTH,
  SHELL_PALETTE_COLOURS,
  SHELL_PALETTE_LIVE,
  STRIP_HEIGHT,
  STRIP_WIDTH,
} from "../game/shell-art.js";

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

// ---------------------------------------------------------------------------
// The backdrop service
// ---------------------------------------------------------------------------

/**
 * The three strips in the order the backdrop selector's word table walks them
 * (`main.bin` h0+0x2A3C indexing h0+0x2A52 by `$E4(a5)`).
 */
export const SHELL_BACKDROP_PAGES: readonly ShellBackdropRole[] = Object.freeze([
  "attract",
  "menu",
  "select",
]);

/**
 * Frames a settled page palette is held.
 *
 * DECODED: `moveq #$FA,dn` at h0+0x10AA loads 250 into the hold counter.
 * MEASURED: a 399 s continuous capture read the settled palette off the screen
 * for 252 frames on 48 of its 77 holds and 253 on the other 29 — never 250.
 * The two frames the decode does not count are the fade's own landing frame
 * (the last step writes the target palette and is already the settled colour)
 * and the frame the counter reloads on, so this constant is the FILMED
 * on-screen duration minus the landing frame the segment already carries.
 *
 * RESIDUAL, STATED: the film's whole palette cycle is 2058 frames — eight holds
 * plus 39 frames of fade, one of the eight transitions going down to black,
 * sitting there two frames and coming back up. This reconstruction's own fade
 * lengths total 49 rather than 39, because `shellFadeLength` counts STEPS and
 * the film counted the intermediate colours it could see; five of the eight
 * transitions agree exactly and three differ by one. With 251 the cycle here is
 * 2057 frames against the filmed 2058. What would close it is the fader itself
 * at `main.seg00 +0x0A44`, which has not been disassembled — the brief lists it
 * as an open residue. It does not affect anything the page cycle does: the two
 * clocks provably never read each other, and 2057 and 2058 are both
 * incommensurate with the 2112-frame page lap.
 */
export const SHELL_TINT_HOLD_FRAMES = 251;

/** The all-black palette the service crossfades through to swap the strip. */
const SHELL_BLACK_PALETTE = SHELL_PALETTE_LIVE - 1;

/** What the backdrop service has on screen at one tick. */
export interface ShellBackdropFrame {
  /** Which strip: the free-running page, NOT the shell screen's own role. */
  readonly role: ShellBackdropRole;
  /** The palette being faded toward, 0..8. */
  readonly tint: number;
  /** The palette being faded from. */
  readonly from: number;
  /** Fade steps applied so far; equal to the fade's length once settled. */
  readonly step: number;
  /** True once the registers have reached `tint` and the 250-frame hold runs. */
  readonly settled: boolean;
  /** The sixteen colours currently in the registers, 48 bytes r,g,b. */
  readonly palette: Uint8Array;
}

function nibble(word: number, shift: number): number {
  return (word >> shift) & 0xf;
}

/**
 * How many frames a fade from one palette to another takes.
 *
 * The fader moves every nibble of colours 1..15 one step per frame, so the fade
 * is over when the widest single nibble gap has been crossed. Colour 0 is not in
 * the sum because the fader never touches it.
 */
export function shellFadeLength(from: ShellPalette, to: ShellPalette): number {
  let longest = 0;
  for (let i = 1; i < SHELL_PALETTE_COLOURS; i += 1) {
    const a = from.aga[i] ?? 0;
    const b = to.aga[i] ?? 0;
    for (let shift = 0; shift <= 8; shift += 4) {
      const gap = Math.abs(nibble(b, shift) - nibble(a, shift));
      if (gap > longest) longest = gap;
    }
  }
  return longest;
}

/**
 * The registers `step` frames into a fade: each nibble has moved `step` toward
 * its target, or all the way if that was nearer. Colour 0 is forced black
 * because the hardware register behind it is written once, at init, to $0000.
 */
export function shellFadeBlend(from: ShellPalette, to: ShellPalette, step: number): Uint8Array {
  const rgb = new Uint8Array(SHELL_PALETTE_COLOURS * 3);
  for (let i = 1; i < SHELL_PALETTE_COLOURS; i += 1) {
    const a = from.aga[i] ?? 0;
    const b = to.aga[i] ?? 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const shift = 8 - channel * 4;
      const start = nibble(a, shift);
      const end = nibble(b, shift);
      const gap = end - start;
      const moved = start + Math.sign(gap) * Math.min(step, Math.abs(gap));
      rgb[i * 3 + channel] = moved * 17;
    }
  }
  return rgb;
}

interface CycleSegment {
  readonly from: number;
  readonly to: number;
  readonly fade: number;
  readonly hold: number;
  /** First frame of this segment within one backdrop's 2049. */
  readonly start: number;
}

interface BackdropCycle {
  readonly segments: readonly CycleSegment[];
  /** Frames one backdrop lasts before the strip changes. */
  readonly frames: number;
}

const CYCLES = new WeakMap<ShellArt, BackdropCycle>();

/**
 * The nine segments of one backdrop's cycle.
 *
 * Palette 0 is faded to FROM BLACK: at a cold start the registers are cleared to
 * $000 (h0+0x0E20) and on every later pass the previous segment was the black
 * palette 8, so the entry condition is the same both times.
 */
function shellBackdropCycle(art: ShellArt): BackdropCycle {
  const cached = CYCLES.get(art);
  if (cached !== undefined) return cached;
  const segments: CycleSegment[] = [];
  let start = 0;
  for (let to = 0; to < SHELL_PALETTE_LIVE; to += 1) {
    const from = to === 0 ? SHELL_BLACK_PALETTE : to - 1;
    const a = art.palettes[from];
    const b = art.palettes[to];
    if (a === undefined || b === undefined) throw new Error(`shell art is missing palette ${to}`);
    const fade = shellFadeLength(a, b);
    // The black palette is the crossfade OUT: the strip changes the instant it
    // lands, with no hold, which is what hides the swap.
    const hold = to === SHELL_BLACK_PALETTE ? 0 : SHELL_TINT_HOLD_FRAMES;
    segments.push({ from, to, fade, hold, start });
    start += fade + hold;
  }
  const cycle = { segments, frames: start };
  CYCLES.set(art, cycle);
  return cycle;
}

/**
 * The backdrop service at a free-running tick: which strip, which palette, and
 * the registers themselves. Pure — two runs at the same tick draw the same
 * frame, which is the property the whole renderer is built on.
 */
export function shellBackdropFrame(art: ShellArt, tick: number): ShellBackdropFrame {
  const cycle = shellBackdropCycle(art);
  const pages = SHELL_BACKDROP_PAGES.length;
  const loop = cycle.frames * pages;
  const whole = Math.max(0, Math.floor(tick));
  const at = whole % loop;
  const page = Math.floor(at / cycle.frames);
  const within = at % cycle.frames;
  let segment = cycle.segments[cycle.segments.length - 1];
  for (const candidate of cycle.segments) {
    if (within >= candidate.start && within < candidate.start + candidate.fade + candidate.hold) {
      segment = candidate;
      break;
    }
  }
  if (segment === undefined) throw new Error("shell backdrop cycle is empty");
  const step = Math.min(within - segment.start, segment.fade);
  const from = art.palettes[segment.from];
  const to = art.palettes[segment.to];
  if (from === undefined || to === undefined) throw new Error("shell art is missing a palette");
  return {
    role: SHELL_BACKDROP_PAGES[page] ?? "attract",
    tint: segment.to,
    from: segment.from,
    step,
    settled: step >= segment.fade,
    palette: shellFadeBlend(from, to, step),
  };
}

// ---------------------------------------------------------------------------
// The skin
// ---------------------------------------------------------------------------

export interface ShellSkin {
  /** The decoded data itself: metrics, sine, dissolve orders, palettes. */
  readonly art: ShellArt;
  /**
   * One strip painted through `palette` (48 bytes, as `ShellBackdropFrame`
   * carries it). Repainted only when the palette actually changed, so the 250
   * frames a page is held cost nothing.
   */
  backdrop(role: ShellBackdropRole, palette: Uint8Array): CanvasImageSource;
  /**
   * A font's atlas in one ink colour, built once per colour.
   *
   * The two glyph planes are an anti-alias ramp: plane value 1 is `colour`, 2 is
   * two thirds of it and 3 is the darkest step. White ink therefore lands on the
   * $fff / $aaa / $777 measured off the filmed screen, exactly.
   */
  fontAtlas(font: SkinFontKey, colour: string): CanvasImageSource;
}

/**
 * The anti-alias ramp, as 8-bit scales of the ink colour.
 *
 * Index is the glyph plane value. 170/255 and 119/255 are $aaa and $777 against
 * $fff — the three text colours measured off every filmed page — so white ink
 * reproduces the original's registers exactly and any other ink keeps the same
 * relative shading rather than inventing a second ramp.
 */
const INK_RAMP: readonly number[] = Object.freeze([0, 255, 170, 119]);

function parseHexColour(colour: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(colour);
  if (match === null) throw new Error(`skin colours are "#rrggbb", got ${colour}`);
  const value = parseInt(match[1] ?? "0", 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function surface(
  createCanvas: SkinCanvasFactory,
  width: number,
  height: number,
  rgba: Uint8ClampedArray<ArrayBuffer>,
): SkinCanvas {
  const canvas = createCanvas(width, height);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("skin canvas gave no 2d context");
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

interface StripSurface {
  canvas: SkinCanvas;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  painted: Uint8Array;
}

export function createShellSkin(art: ShellArt, createCanvas: SkinCanvasFactory): ShellSkin {
  const strips = new Map<ShellBackdropRole, StripSurface>();

  const backdrop = (role: ShellBackdropRole, palette: Uint8Array): CanvasImageSource => {
    let held = strips.get(role);
    if (held === undefined) {
      held = {
        canvas: createCanvas(STRIP_WIDTH, STRIP_HEIGHT),
        rgba: new Uint8ClampedArray(STRIP_WIDTH * STRIP_HEIGHT * 4),
        // Impossible as a real palette (a live one starts black), so the first
        // call always paints.
        painted: new Uint8Array(SHELL_PALETTE_COLOURS * 3).fill(0xff),
      };
      held.canvas.width = STRIP_WIDTH;
      held.canvas.height = STRIP_HEIGHT;
      strips.set(role, held);
    }
    let same = true;
    for (let i = 0; i < held.painted.length; i += 1) {
      if (held.painted[i] !== palette[i]) {
        same = false;
        break;
      }
    }
    if (!same) {
      held.painted.set(palette);
      const pixels = art.backdrops[role].pixels;
      for (let i = 0; i < pixels.length; i += 1) {
        const entry = (pixels[i] ?? 0) * 3;
        const at = i * 4;
        held.rgba[at] = palette[entry] ?? 0;
        held.rgba[at + 1] = palette[entry + 1] ?? 0;
        held.rgba[at + 2] = palette[entry + 2] ?? 0;
        held.rgba[at + 3] = 255;
      }
      const context = held.canvas.getContext("2d");
      if (context === null) throw new Error("skin canvas gave no 2d context");
      context.putImageData(new ImageData(held.rgba, STRIP_WIDTH, STRIP_HEIGHT), 0, 0);
    }
    return held.canvas as unknown as CanvasImageSource;
  };

  const atlases = new Map<string, SkinCanvas>();
  const fontAtlas = (font: SkinFontKey, colour: string): CanvasImageSource => {
    const key = `${font}:${colour}`;
    const cached = atlases.get(key);
    if (cached !== undefined) return cached as unknown as CanvasImageSource;
    const data = font === "font1" ? art.font1 : art.font2;
    const ink = parseHexColour(colour);
    const rgba = new Uint8ClampedArray(FONT_ATLAS_WIDTH * data.rows * 4);
    for (let i = 0; i < data.pixels.length; i += 1) {
      const value = data.pixels[i] ?? 0;
      if (value === 0) continue; // bare backdrop: there is no knockout
      const scale = (INK_RAMP[value] ?? 255) / 255;
      const at = i * 4;
      rgba[at] = Math.round(ink[0] * scale);
      rgba[at + 1] = Math.round(ink[1] * scale);
      rgba[at + 2] = Math.round(ink[2] * scale);
      rgba[at + 3] = 255;
    }
    const built = surface(createCanvas, FONT_ATLAS_WIDTH, data.rows, rgba);
    atlases.set(key, built);
    return built as unknown as CanvasImageSource;
  };

  return { art, backdrop, fontAtlas };
}
