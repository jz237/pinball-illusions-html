/**
 * Score panel renderer: the 320 x 16 strip under the playfield.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ORIGINAL DOES (docs/DISK_ANALYSIS.md, the panel decode)
 * ---------------------------------------------------------------------------
 * The panel is a 320 x 16 bitmap of THREE planes at a 40-byte row stride
 * (originals at main.s05+$500/$780/$A00): plane 0 is fill, plane 1 outline,
 * plane 2 the score-digits layer. Slot 5 of each table package is the
 * animation heap — 49/63/87 objects — each a 28-byte header {+0x0C speed
 * divider 1..5, +0x16 width field (bytes/row/plane, 0xA0 = full 320 px),
 * +0x18 height 16, +0x1A frame count 1..79} followed by frame 0 raw and RLE
 * delta frames. $6C2C appends display records to a 64-slot pointer ring
 * consumed one at a time: queued animations play IN ORDER, and between them
 * the panel shows the score.
 *
 * This module reconstructs exactly that sequencing and compositing:
 *
 *   - a pure state machine (`stepPanel`) that plays a queue of decoded
 *     animations, advancing a frame every `speedDivider` ticks — the header's
 *     +0x0C field — and falling back to the score view when the queue drains;
 *   - a rasteriser (`renderPanelInto`) in the `PixelTarget` pattern of
 *     `playfield-renderer.ts`: plane 0 + plane 1 of the current frame
 *     composed as amber fill under white outline, or — when nothing is
 *     playing — the plane-2 equivalent: the score, right-aligned and
 *     comma-grouped, set in the shipped shell font.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not decode slot-5 RLE — it consumes frames some decoder already
 * expanded into per-pixel plane bits (the same byte convention as
 * `ShellFont.pixels`: bit 0 fill, bit 1 outline). It does not touch the
 * simulation: the score arrives as a number (`currentScore` reads it out of
 * the packed-BCD field) and the tick count arrives as an argument. No wall
 * clock, no canvas, no DOM — everything here is assertable in node, and the
 * integrator wires it into `game-loop.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE SCORE COLUMN AND GROUPING ARE THE ORIGINAL'S OWN ARITHMETIC
 * ---------------------------------------------------------------------------
 * The high-score template at main hunk-0 0x1836 computes its score column as
 * `300 - (3*commas + 7*digits)` — right-aligned at x = 300, digits grouped in
 * threes with commas, 3 and 7 being the small font's comma and digit
 * advances. `PANEL_SCORE_RIGHT_X` and `formatPanelScore` reproduce that sum
 * (via `alignShellText`, which sums the same advance table), so the score
 * sits where the original's own layout arithmetic puts it.
 */

import { PANEL_AMBER, PANEL_UNLIT, PANEL_WHITE } from "./palette.js";
import type { Rgb } from "./palette.js";
import { BYTES_PER_PIXEL, createPixelTarget } from "./playfield-renderer.js";
import type { PixelTarget } from "./playfield-renderer.js";
import { FONT_ATLAS_WIDTH, alignShellText } from "../game/shell-art.js";
import type { ShellFont } from "../game/shell-art.js";

// ---------------------------------------------------------------------------
// Geometry — measured constants, not choices
// ---------------------------------------------------------------------------

/** The panel bitmap is 320 px wide: 40 bytes per row per plane, 0xA0/4. */
export const PANEL_WIDTH = 320;

/** Every slot-5 object header carries height 16 at +0x18. */
export const PANEL_HEIGHT = 16;

/**
 * The display ring at $23A2/$239E/$23A0 holds 64 pointer slots; a 65th
 * append in the original would clobber the oldest, which a reconstruction has
 * no reason to reproduce — `enqueuePanelAnimation` drops the newcomer
 * instead, loudly returning the same state.
 */
export const PANEL_QUEUE_CAPACITY = 64;

/**
 * Where the score's right edge sits: the hunk-0 0x1836 template's own
 * column, `300 - width` on a 320-px line.
 */
export const PANEL_SCORE_RIGHT_X = 300;

// ---------------------------------------------------------------------------
// The data a decoder hands us
// ---------------------------------------------------------------------------

/**
 * One expanded animation frame.
 *
 * `pixels` is one byte per pixel, row-major, `width * height` long — bit 0 is
 * the plane-0 fill bit, bit 1 the plane-1 outline bit, exactly the convention
 * `ShellFont.pixels` established for the two-plane shell font. A frame may be
 * narrower than the panel (the width field at +0x16 is per-object; Law 'n
 * Justice's two headerless blobs stamp 48 x 15 indicator glyphs), so `x`/`y`
 * place it on the strip; they default to 0 and anything off the strip is
 * clipped, never wrapped.
 */
export interface PanelFrame {
  readonly width: number;
  readonly height: number;
  /** Per-pixel plane bits: bit 0 fill, bit 1 outline. */
  readonly pixels: Uint8Array;
  /** Left edge on the panel, in pixels. Default 0. */
  readonly x?: number;
  /** Top edge on the panel, in rows. Default 0. */
  readonly y?: number;
}

/**
 * One decoded slot-5 object, ready to play.
 *
 * `speedDivider` is the header's +0x0C field, 1..5 on every object measured:
 * the frame index advances once every that many ticks. `holdLastFrame`
 * models the one-frame prize-art objects that sit on screen rather than
 * ending — a holding animation stays on its last frame until something else
 * is queued behind it, then yields within one divider period.
 */
export interface PanelAnimation {
  readonly frames: readonly PanelFrame[];
  readonly speedDivider: number;
  readonly holdLastFrame?: boolean;
}

// ---------------------------------------------------------------------------
// The playback state machine — pure, tick-driven, no wall clock
// ---------------------------------------------------------------------------

/**
 * The whole playback state. Immutable; `stepPanel` returns a new one (or the
 * same object when nothing changed, so callers can compare by identity).
 * `queue[0]` is the animation on screen; an empty queue is the score view.
 */
export interface PanelState {
  readonly queue: readonly PanelAnimation[];
  /** Index into `queue[0].frames`. Meaningless when the queue is empty. */
  readonly frameIndex: number;
  /** Ticks accumulated toward the next frame advance, 0..divider-1. */
  readonly ticksIntoFrame: number;
}

/** The idle state: nothing queued, the panel shows the score. */
export function createPanelState(): PanelState {
  return { queue: [], frameIndex: 0, ticksIntoFrame: 0 };
}

function validateAnimation(animation: PanelAnimation): void {
  if (!Number.isInteger(animation.speedDivider) || animation.speedDivider < 1) {
    throw new RangeError(
      `panel animation speed divider must be a positive integer, got ${animation.speedDivider}`,
    );
  }
  if (animation.frames.length === 0) {
    throw new RangeError("panel animation must carry at least one frame");
  }
  for (const frame of animation.frames) {
    if (
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 1 ||
      frame.height < 1 ||
      frame.width > PANEL_WIDTH ||
      frame.height > PANEL_HEIGHT
    ) {
      throw new RangeError(
        `panel frame is ${frame.width}x${frame.height}; the panel is ${PANEL_WIDTH}x${PANEL_HEIGHT}`,
      );
    }
    if (frame.pixels.length !== frame.width * frame.height) {
      throw new RangeError(
        `panel frame carries ${frame.pixels.length} bytes, expected ${frame.width * frame.height}`,
      );
    }
    if (!Number.isInteger(frame.x ?? 0) || !Number.isInteger(frame.y ?? 0)) {
      throw new RangeError("panel frame placement must be integer pixels");
    }
  }
}

/**
 * Appends an animation to the display queue — the reconstruction of a $6C2C
 * append to the 64-slot ring. Validates eagerly so a malformed decode fails
 * at the enqueue that introduced it, not frames later in a render. A full
 * queue drops the newcomer and returns the state unchanged.
 */
export function enqueuePanelAnimation(state: PanelState, animation: PanelAnimation): PanelState {
  validateAnimation(animation);
  if (state.queue.length >= PANEL_QUEUE_CAPACITY) {
    return state;
  }
  return { ...state, queue: [...state.queue, animation] };
}

/**
 * Advances playback by `ticks` ticks. Pure: same inputs, same output, and
 * the identical state object comes back when nothing moved (idle queue,
 * zero ticks, or a lone held frame).
 *
 * Per tick: the current animation accumulates one tick; every
 * `speedDivider`-th tick the frame index advances; past the last frame the
 * animation either ends — dequeued, next animation (or the score view) takes
 * over — or, with `holdLastFrame` and nothing waiting, clamps to its last
 * frame. A holding animation with something queued behind it yields on its
 * next divider boundary, which is what lets prize art sit indefinitely yet
 * never block the queue.
 */
export function stepPanel(state: PanelState, ticks: number): PanelState {
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new RangeError(`ticks must be a non-negative integer, got ${ticks}`);
  }
  let queue = state.queue;
  let frameIndex = state.frameIndex;
  let ticksIntoFrame = state.ticksIntoFrame;
  let changed = false;

  for (let tick = 0; tick < ticks; tick += 1) {
    const playing = queue[0];
    if (playing === undefined) {
      break; // Idle: the score view, and nothing to count.
    }
    ticksIntoFrame += 1;
    changed = true;
    if (ticksIntoFrame < playing.speedDivider) {
      continue;
    }
    ticksIntoFrame = 0;
    frameIndex += 1;
    if (frameIndex < playing.frames.length) {
      continue;
    }
    if (playing.holdLastFrame === true && queue.length === 1) {
      frameIndex = playing.frames.length - 1;
      continue;
    }
    queue = queue.slice(1);
    frameIndex = 0;
  }

  return changed ? { queue, frameIndex, ticksIntoFrame } : state;
}

/** The frame on screen, or null when the panel is showing the score. */
export function currentPanelFrame(state: PanelState): PanelFrame | null {
  const playing = state.queue[0];
  if (playing === undefined) {
    return null;
  }
  // The index is clamped rather than trusted: a state object built by hand
  // (or an older serialised one) must degrade to the last frame, not read
  // undefined.
  const index = Math.min(state.frameIndex, playing.frames.length - 1);
  return playing.frames[index] ?? null;
}

/** True when nothing is queued and the panel is on the score view. */
export function panelIsIdle(state: PanelState): boolean {
  return state.queue.length === 0;
}

// ---------------------------------------------------------------------------
// Score formatting — the ladder template's grouping
// ---------------------------------------------------------------------------

/**
 * The score as the panel prints it: decimal digits grouped in threes with
 * commas, the exact string shape the 0x1836 template's
 * `3*commas + 7*digits` width sum implies. The score is stored packed-BCD in
 * the original and in `scoring.ts`; it arrives here already read out as a
 * number (`currentScore`), so grouping decimal digits IS grouping the BCD
 * digits. Negative and fractional inputs are a caller bug, refused rather
 * than rounded into a plausible-looking lie.
 */
export function formatPanelScore(score: number): string {
  if (!Number.isSafeInteger(score) || score < 0) {
    throw new RangeError(`panel score must be a non-negative integer, got ${score}`);
  }
  const digits = String(score);
  let grouped = "";
  for (let i = 0; i < digits.length; i += 1) {
    const fromRight = digits.length - i;
    if (i > 0 && fromRight % 3 === 0) {
      grouped += ",";
    }
    grouped += digits[i] ?? "";
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// Rasterising — the PixelTarget pattern of playfield-renderer.ts
// ---------------------------------------------------------------------------

/**
 * The panel's four visible tones by plane bits: index 0 (no plane) is the
 * unlit glass, plane 0 alone the amber fill, plane 1 the white outline —
 * which also wins where both planes are set, outline over fill being what an
 * outline is for. See the palette constants for why these colours are a
 * reconstruction rather than a decode.
 */
const PLANE_COLOURS: readonly [Rgb, Rgb, Rgb, Rgb] = [
  PANEL_UNLIT,
  PANEL_AMBER,
  PANEL_WHITE,
  PANEL_WHITE,
];

function writePixel(target: PixelTarget, x: number, y: number, colour: Rgb): void {
  const at = (y * PANEL_WIDTH + x) * BYTES_PER_PIXEL;
  target.data[at] = colour[0];
  target.data[at + 1] = colour[1];
  target.data[at + 2] = colour[2];
  target.data[at + 3] = 255;
}

function clearPanel(target: PixelTarget): void {
  for (let y = 0; y < PANEL_HEIGHT; y += 1) {
    for (let x = 0; x < PANEL_WIDTH; x += 1) {
      writePixel(target, x, y, PANEL_UNLIT);
    }
  }
}

/** Composes a frame's two planes onto the strip, clipping at every edge. */
function drawFrame(target: PixelTarget, frame: PanelFrame): void {
  const left = frame.x ?? 0;
  const top = frame.y ?? 0;
  for (let row = 0; row < frame.height; row += 1) {
    const y = top + row;
    if (y < 0 || y >= PANEL_HEIGHT) continue;
    for (let col = 0; col < frame.width; col += 1) {
      const x = left + col;
      if (x < 0 || x >= PANEL_WIDTH) continue;
      const bits = (frame.pixels[row * frame.width + col] ?? 0) & 3;
      if (bits === 0) continue; // Register 0: the glass shows through.
      writePixel(target, x, y, PLANE_COLOURS[bits] ?? PANEL_UNLIT);
    }
  }
}

/**
 * Draws a run of text the way the original's blitter does — each glyph's
 * full 16-px box ORed in on the disk's own advance and y-offset metrics —
 * except that here the OR is painted as two passes, outline bits under fill
 * bits, the same argument as `SkinFontLayer` in shell-skin.ts. `penY` is the
 * glyph-box top the TEXT opcode carries; each glyph adds its own signed
 * y-offset. Everything off the strip is clipped.
 */
function drawText(
  target: PixelTarget,
  font: ShellFont,
  text: string,
  penX: number,
  penY: number,
  fill: Rgb,
  outline: Rgb,
): void {
  for (const layer of ["outline", "fill"] as const) {
    const wantedBit = layer === "outline" ? 2 : 1;
    const colour = layer === "outline" ? outline : fill;
    let pen = penX;
    for (let i = 0; i < text.length; i += 1) {
      const glyph = font.glyphs[text.charCodeAt(i)];
      if (glyph === undefined) continue;
      for (let row = 0; row < glyph.height; row += 1) {
        const y = penY + glyph.yOffset + row;
        if (y < 0 || y >= PANEL_HEIGHT) continue;
        const atlasRow = (glyph.top + row) * FONT_ATLAS_WIDTH;
        for (let col = 0; col < FONT_ATLAS_WIDTH; col += 1) {
          const x = pen + col;
          if (x < 0 || x >= PANEL_WIDTH) continue;
          if (((font.pixels[atlasRow + col] ?? 0) & wantedBit) === 0) continue;
          writePixel(target, x, y, colour);
        }
      }
      pen += glyph.advance;
    }
  }
}

/**
 * The glyph-box top that centres the font's digit block in the 16 panel
 * rows. Computed from the '0' glyph — the score view is digits and commas,
 * and every digit shares one metric row — rather than hard-coded, so the
 * same arithmetic holds for the shipped font and for any test double.
 */
function scorePenY(font: ShellFont): number {
  const zero = font.glyphs["0".charCodeAt(0)];
  if (zero === undefined || zero.height === 0) {
    return 0;
  }
  return Math.floor((PANEL_HEIGHT - zero.height) / 2) - zero.yOffset;
}

/**
 * Renders the panel for a playback state into a 320 x 16 target.
 *
 * An animation on screen draws its current frame's two planes; an idle queue
 * draws the score view — the plane-2 equivalent: `formatPanelScore(score)`
 * right-aligned at the template's x = 300 column in the given shell font,
 * amber fill over white outline on the unlit glass. The target must be
 * exactly panel-sized, the same 1:1 contract as `renderPlayfieldInto`, and
 * nothing is ever written outside it. Returns the target for convenience.
 */
export function renderPanelInto(
  state: PanelState,
  score: number,
  font: ShellFont,
  target: PixelTarget,
): PixelTarget {
  if (target.width !== PANEL_WIDTH || target.height !== PANEL_HEIGHT) {
    throw new RangeError(
      `panel target is ${target.width}x${target.height} but the panel is ${PANEL_WIDTH}x${PANEL_HEIGHT}; it rasterises 1:1`,
    );
  }
  const expected = PANEL_WIDTH * PANEL_HEIGHT * BYTES_PER_PIXEL;
  if (target.data.length !== expected) {
    throw new RangeError(
      `panel target has ${target.data.length} bytes, expected ${expected} for ${PANEL_WIDTH}x${PANEL_HEIGHT} RGBA`,
    );
  }

  clearPanel(target);
  const frame = currentPanelFrame(state);
  if (frame !== null) {
    drawFrame(target, frame);
    return target;
  }

  const text = formatPanelScore(score);
  const penX = alignShellText(font, text, PANEL_SCORE_RIGHT_X, "right");
  drawText(target, font, text, penX, scorePenY(font), PANEL_AMBER, PANEL_WHITE);
  return target;
}

/** Renders into a freshly allocated panel-sized target. */
export function renderPanel(state: PanelState, score: number, font: ShellFont): PixelTarget {
  return renderPanelInto(state, score, font, createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT));
}
