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
import { panelFace, panelGlyphPixel, panelTextPen, panelTextRun } from "../game/panel-font.js";
import type { PanelFont, PanelFontFace } from "../game/panel-font.js";

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
 * What the END-OF-BALL BONUS wants on the strip. See `bonus.ts` for the routine
 * and `game-loop.ts` for the `BonusView` this is fed from.
 */
export interface PanelBonusView {
  readonly caption: string;
  readonly value: number | null;
  readonly multiplier: string;
  readonly multiplierLit: boolean;
}

/**
 * THE BONUS PANEL'S TWO LINES, AND THE ONE PLACE THIS LAYOUT DIVERGES.
 *
 * The routine puts the caption on Y=2 and the figure on the row the field
 * drawer's `d4 = 10` selects (Law 'n Justice hunk 4 +0x29F6/+0x29FA,
 * +0x2B2E/+0x2B32, +0x2B68/+0x2B6C), and FILM SAYS BOTH OF THOSE ARE ROWS OF THE
 * SAME SIXTEEN-ROW STRIP THIS PORT HAS. What used to be written here — that the
 * machine draws the bonus "on a TALLER surface than this strip", its text plane
 * being 1920 bytes at a 40-byte stride, 48 rows — was an inference, and it is
 * wrong about what is on screen. Read off a native-resolution capture of a real
 * 1,000,000 x2 bonus (`research\view\reference\session5`), the machine's DMD is a
 * 160 x 16 dot matrix on this same 320-px strip, its caption sits on dot rows
 * 2..6 and its figure on 10..14, and nothing is drawn outside those sixteen rows.
 * Its panel font is FIVE rows tall.
 *
 * So what cannot be matched is only the height. The shipped panel font is eight
 * rows, so a caption at row 2 would run to row 9 and a figure at row 10 to row
 * 17 — two rows off the end. The PITCH is reproduced exactly: the machine puts
 * its two lines eight rows apart (2 -> 10) and so does this (0 -> 8); the pair
 * sits two rows high because eight-row glyphs will not fit at row 2.
 *
 * So the ROWS are this port's — caption on the top eight, figure on the bottom
 * eight — and everything else about the layout is the machine's: which caption,
 * which figure, which columns, and for how long. Computed from the font rather
 * than written down, the same argument as `scorePenY`, so a font with different
 * metrics still lands on the two halves.
 */
function bonusPenY(font: ShellFont, line: 0 | 1): number {
  const zero = font.glyphs["0".charCodeAt(0)];
  return line * Math.floor(PANEL_HEIGHT / 2) - (zero?.yOffset ?? 0);
}

/**
 * The three columns. Every bonus record carries `align = 2`, which `$73D0`
 * decodes as CENTRE (+0x007416), so all three are centred on their X: captions
 * and figures on X=160, the strip's own middle, and the multiplier label on
 * X=40 and again on X=280 — `move.w #$28,(a0)` at +0x2A2E and `move.w #$118,(a0)`
 * at +0x2A3A, the same record drawn twice, mirror-symmetric about 320 pixels.
 */
const BONUS_CENTRE_X = 160;
const BONUS_MULTIPLIER_LEFT_X = 40;
const BONUS_MULTIPLIER_RIGHT_X = 280;

/**
 * THE MACHINE'S OWN CAPTIONS — one display record's text, ready to place.
 *
 * ---------------------------------------------------------------------------
 * WHERE EVERY NUMBER IN HERE COMES FROM
 * ---------------------------------------------------------------------------
 * A display record is a PROGRAM for the interpreter at main.seg00 +0x006642,
 * and its TEXT instruction (opcode 3, handler 0x694C) hands a print record to
 * `$73D0`, which reads the geometry out of the record itself:
 *
 *     0073DA  movem.w (a0),d3-d5   ; +$0 X, +$2 ROW, +$4 FONT
 *     0073DE  mulu.w  #$28,d4      ; ROW x 40 bytes = ROW x one 320-px scanline
 *     007404  move.w  $6(a0),d0    ; +$6 ALIGN
 *     00740A  cmpi.b  #$0,d0       ; 0 -> pen at X          (LEFT)
 *     007410  cmpi.b  #$1,d0       ; 1 -> pen at X - width  (RIGHT)
 *     007416  ...lsr.w #1...       ; else X - width/2       (CENTRE)
 *
 * so `x` and `align` here are the machine's and are used exactly. `row` is the
 * machine's too and is NOT used exactly, for the one reason `bonusPenY` above
 * already documents: the machine's panel font is five rows and this port's is
 * eight, so a caption at row 2 and a second line at row 9 would overlap and the
 * second would run two rows off a sixteen-row strip. `messagePenY` maps the
 * machine's row onto the same two halves the bonus and the card use, which
 * reproduces its PITCH and its line ORDER and nothing else about its height.
 * Every row in the shipped corpus is 0, 2, 4, 5, 6 or 9, so the split at eight
 * is a split between the machine's top line and its bottom one and never falls
 * inside one.
 *
 * `font` is carried and deliberately not used. The machine has six panel fonts
 * — the table at h0+0x7136, each `{bitmap in main h5, metrics in h0}`, with
 * 0/1 sharing metrics at 0xCD54, 2/3 at 0xCDE6 and 4/5 at 0xCE72 — and this
 * port ships one. Which shipped font corresponds to which is not decoded, so
 * the field travels, is ignored, and says so rather than being guessed at.
 */
export interface PanelMessageLine {
  readonly x: number;
  readonly row: number;
  readonly font: number;
  readonly align: number;
  readonly text: string;
}

/**
 * ONE LIVE FIGURE ON THE STRIP, already resolved to a number.
 *
 * The machine's number printer `$71BA` is a different routine from its text
 * printer `$73D0` and differs from it in exactly two ways, both reproduced here.
 *
 * ONE: it emits digits RIGHT TO LEFT off the packed-BCD field's low nibble
 * (0x72D4-0x72EA), inserting glyph $0C — a COMMA, since the character map at
 * 0x743C is indexed by `ASCII - $20` — every third digit off the 0x24924924
 * mask. So a figure is grouped in threes and this port formats it that way.
 *
 * TWO: its alignment test is written BACK TO FRONT, because `d3` is the pen's
 * RIGHT edge rather than its left:
 *
 *     0071EE  cmpi.w #$1,d6 / beq 0x72C4      ; 1: the right edge IS x
 *     0071F6  cmpi.w #$2,d6 / beq 0x7204
 *     0071FC  bsr measure / add.w d2,d3       ; 0: the right edge is x + width
 *     007204  bsr measure / ... / add.w d2,d3 ; 2: x + width/2, rounded even
 *
 * AND IT LANDS IN EXACTLY THE SAME PLACE. 1 puts the string in [x-w, x], which
 * is the text printer's RIGHT; 0 puts it in [x, x+w], which is LEFT; and the two
 * centring roundings — `((w>>1)+1) & ~1` subtracted at 0x7418 against
 * `(((w-1)>>1)+1) & ~1` added at 0x7206 — agree for every EVEN width and differ
 * by one pixel only for odd ones, and no width in this corpus is odd (every
 * glyph width and every blank advance in all six faces is even, and the two
 * pixels of tracking keep it that way). So the three cases mean the same three
 * things on a figure as on a line, and `messageAlign` serves both. That was
 * worth checking rather than assuming: the two routines look like mirrors.
 *
 * The machine's own idle score view is `move.w #$140,d3 / move.w #$1,d6` at
 * 0x719A/0x71A6 — right-aligned at 320, the strip's right edge.
 */
export interface PanelMessageFigure {
  readonly x: number;
  readonly row: number;
  readonly font: number;
  readonly align: number;
  readonly value: number;
}

export interface PanelMessageView {
  readonly lines: readonly PanelMessageLine[];
  /** The record's live-value opcodes, resolved. Empty on a record with none. */
  readonly figures?: readonly PanelMessageFigure[];
}

/**
 * A packed-BCD figure the way `$71BA` lays it out: digits with a comma every
 * three. Twelve digits is the field's whole width and the machine prints no
 * leading zeros — 0x72DE stops the loop the moment the shifted value is zero —
 * so a value of zero prints as the single digit `0`.
 */
export function formatPanelFigure(value: number): string {
  const digits = String(Math.max(0, Math.floor(value)));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    // 0x72E0's mask has bits 2, 5, 8 ... set and the shift happens AFTER the
    // digit, so a comma falls between groups of three and never leads.
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/**
 * The pen row for a machine scanline, on this port's taller font.
 *
 * The same two halves `bonusPenY` picks and for the same measured reason; see
 * `PanelMessageView`. Eight is the machine's own line pitch — its caption sits
 * on row 2 and its figure on row 10 — so "below eight" is "the top line".
 */
function messagePenY(font: ShellFont, row: number): number {
  return bonusPenY(font, row < Math.floor(PANEL_HEIGHT / 2) ? 0 : 1);
}

/**
 * The machine's three alignments, as `alignShellText` names them. `$73D0`
 * tests `0`, then `1`, then falls through, so anything else centres.
 */
function messageAlign(align: number): "left" | "right" | "center" {
  if (align === 0) return "left";
  if (align === 1) return "right";
  return "center";
}

/**
 * ONE LINE IN THE MACHINE'S OWN FACE, ON THE MACHINE'S OWN SCANLINE.
 *
 * The blit at 0x7474 ORs a single-bitplane glyph into the text plane at
 * $6000A00 + `row * 40`, so a caption is one colour and its top row is the print
 * record's `row` exactly. Nothing is centred vertically and nothing is mapped
 * onto halves: with a five-row face, rows 2 and 9 are rows 2 and 9.
 */
function drawPanelLine(
  target: PixelTarget,
  face: PanelFontFace,
  text: string,
  x: number,
  row: number,
  align: number,
): void {
  const pen = panelTextPen(face, text, x, align);
  // 0x7422 / 0x742A: a negative pen bails and the machine draws nothing.
  if (pen === null) return;
  for (const run of panelTextRun(face, text, pen)) {
    for (let line = 0; line < face.height; line += 1) {
      const y = row + line;
      if (y < 0 || y >= PANEL_HEIGHT) continue;
      for (let column = 0; column < run.width; column += 1) {
        const px = run.pen + column;
        if (px < 0 || px >= PANEL_WIDTH) continue;
        if (!panelGlyphPixel(face, run.glyph, column, line)) continue;
        writePixel(target, px, y, PANEL_AMBER);
      }
    }
  }
}

/**
 * A record's text and figures.
 *
 * `panelFont` is the machine's own six-face table and is used when it has
 * arrived; until then — and in any build that ships no derived assets — the
 * caption falls back to the shell font on the two halves `messagePenY` picks,
 * which is exactly what this port drew before the face table was extracted.
 */
function drawMessage(
  target: PixelTarget,
  font: ShellFont,
  message: PanelMessageView,
  panelFont: PanelFont | null,
): void {
  for (const line of message.lines) {
    if (line.text.length === 0) continue;
    if (panelFont !== null) {
      drawPanelLine(target, panelFace(panelFont, line.font), line.text, line.x, line.row, line.align);
      continue;
    }
    const penX = alignShellText(font, line.text, line.x, messageAlign(line.align));
    drawText(target, font, line.text, penX, messagePenY(font, line.row), PANEL_AMBER, PANEL_WHITE);
  }
  for (const figure of message.figures ?? []) {
    const text = formatPanelFigure(figure.value);
    if (panelFont !== null) {
      drawPanelLine(
        target,
        panelFace(panelFont, figure.font),
        text,
        figure.x,
        figure.row,
        figure.align,
      );
      continue;
    }
    const penX = alignShellText(font, text, figure.x, messageAlign(figure.align));
    drawText(target, font, text, penX, messagePenY(font, figure.row), PANEL_AMBER, PANEL_WHITE);
  }
}

/**
 * The PLAYER/BALL card — the serve announcement (state 5) and the
 * multi-player end-of-ball "PL n" card. Structurally `game-loop.ts`'s
 * `PanelCard`, declared here the way `PanelBonusView` twins `BonusView`, so
 * the renderer never imports the loop.
 */
export interface PanelCardView {
  readonly top: string;
  readonly bottom: string | null;
  readonly score: number;
}

/**
 * The card's columns, the machine's own display lists
 * (research/MULTIPLAYER_DECODE.md §5): both captions LEFT-aligned at x=0
 * ("PLAYER  n" / "PLAYERS  n" on the top text row, "BALL  m" on the bottom
 * one — y=2 and y=8 of the machine's five-row panel font, mapped onto this
 * font's two halves exactly as the bonus rows are), and the score
 * RIGHT-ALIGNED AT X=320: `move.w #$140,d3` in both `$7198` (the serve view)
 * and the ball-end draw at +0x005206 — the edge session 5 measured at panel
 * x319. Deliberately not `PANEL_SCORE_RIGHT_X` (300): that column is the
 * ladder template's, and this card is the one place the machine's own x is
 * decoded for the strip.
 */
const CARD_LEFT_X = 0;
const CARD_SCORE_RIGHT_X = 320;

function drawCard(target: PixelTarget, font: ShellFont, card: PanelCardView): void {
  const top = bonusPenY(font, 0);
  drawText(target, font, card.top, CARD_LEFT_X, top, PANEL_AMBER, PANEL_WHITE);
  if (card.bottom !== null && card.bottom.length > 0) {
    drawText(target, font, card.bottom, CARD_LEFT_X, bonusPenY(font, 1), PANEL_AMBER, PANEL_WHITE);
  }
  const text = formatPanelScore(card.score);
  const penX = alignShellText(font, text, CARD_SCORE_RIGHT_X, "right");
  drawText(target, font, text, penX, top, PANEL_AMBER, PANEL_WHITE);
}

function drawBonus(target: PixelTarget, font: ShellFont, bonus: PanelBonusView): void {
  const caption = bonusPenY(font, 0);
  const figure = bonusPenY(font, 1);
  const centred = (text: string, x: number, penY: number): void => {
    if (text.length === 0) return;
    const penX = alignShellText(font, text, x, "center");
    drawText(target, font, text, penX, penY, PANEL_AMBER, PANEL_WHITE);
  };
  centred(bonus.caption, BONUS_CENTRE_X, caption);
  if (bonus.multiplierLit && bonus.multiplier.length > 0) {
    centred(bonus.multiplier, BONUS_MULTIPLIER_LEFT_X, caption);
    centred(bonus.multiplier, BONUS_MULTIPLIER_RIGHT_X, caption);
  }
  // The figure is grouped exactly as the score is, because the machine draws it
  // with the very same `$71BA` it draws the score with.
  if (bonus.value !== null) {
    centred(formatPanelScore(bonus.value), BONUS_CENTRE_X, figure);
  }
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
 *
 * `bonus` OUTRANKS BOTH OF THEM, because the machine's does: `$5136` calls
 * `$6B06` — which zeroes the whole text plane — immediately before and after the
 * table's routine (+0x0051AC, +0x0051C4), and the routine clears it again ahead
 * of every panel it puts up. Nothing queued survives an end-of-ball bonus on
 * screen, and the score does not show through it either.
 *
 * `card` — the PLAYER/BALL announcement — outranks the queue and the score the
 * same way for the same reason: the serve state's loop calls `$6B06` and
 * redraws the card every frame (+0x0049F8), so nothing queued shows through it
 * either; only the bonus, which cannot coexist with a serve, sits above it.
 */
export function renderPanelInto(
  state: PanelState,
  score: number,
  font: ShellFont,
  target: PixelTarget,
  bonus?: PanelBonusView | null,
  card?: PanelCardView | null,
  message?: PanelMessageView | null,
  panelFont?: PanelFont | null,
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
  if (bonus !== undefined && bonus !== null) {
    drawBonus(target, font, bonus);
    return target;
  }
  if (card !== undefined && card !== null) {
    drawCard(target, font, card);
    return target;
  }
  const frame = currentPanelFrame(state);
  if (frame !== null) {
    drawFrame(target, frame);
    return target;
  }
  // A DISPLAY RECORD'S TEXT OUTRANKS THE SCORE AND WAITS BEHIND AN ANIMATION,
  // both because the machine does. The record owns the strip while it runs —
  // it clears it (`CLEAR_1` at 0x681A, `CLEAR_2`, `CLEAR_ALL`), prints, and
  // 0x66E0 clears it again on END, so the score cannot show through. And the
  // interpreter refuses to age the hold at all while an animation is up:
  //
  //     00664E  tst.l   $23C8(a5)     ; an ANIM_BLOCK is running
  //     006652  bne.b   $665E         ; -> do nothing this frame
  //
  // so within one record the animation plays first and the caption follows,
  // which is exactly this order with the port's own queue standing in for
  // `$23C8`. See `PanelDisplay` for the hold and the priority gate.
  // A record with no words but a live-value opcode owns the strip too: 54 of
  // the 288 print a figure and nothing else — a bare jackpot total, a bare
  // countdown — and the machine's `CLEAR_1` before it takes the score off just
  // the same.
  if (
    message !== undefined &&
    message !== null &&
    (message.lines.length > 0 || (message.figures?.length ?? 0) > 0)
  ) {
    drawMessage(target, font, message, panelFont ?? null);
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
