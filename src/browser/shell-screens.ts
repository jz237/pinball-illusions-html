/**
 * Drawing the shell.
 *
 * Every coordinate below is the original's, read off the display lists in
 * `main.bin` hunk 0 and used unchanged. The original's shell screens are
 * 320 x 256; this reconstruction's window is 336 x 256, because that is the
 * playfield's width, so the shell is drawn into a 320-wide box centred in it —
 * eight pixels of surround each side, and not one coordinate moved. Everything
 * is drawn at the same whole-number magnification the playfield uses, with
 * smoothing off, so one 1995 pixel is always an exact square block of device
 * pixels.
 *
 * The drawing language is the original's too, and the opcode table this header
 * used to give was wrong. The page interpreter is `main.seg00 +0x1CB8`: it
 * reads a big-endian word, `cmpi.w #3` ends the page, and anything else indexes
 * the jump table at `+0x1CB2`, word-aligning `a0` after each record
 * (`+0x1CCA..+0x1CD4`). THERE IS NO LINE OPCODE. All four entries are:
 *
 *     0x0000  `+0x1CDA`  TEXT left-aligned    u16 x, u16 y, asciiz
 *     0x0001  `+0x1CEA`  TEXT right-aligned   (`+0x1CF8 sub.w d4,d0`)
 *     0x0002  `+0x1D04`  TEXT centred         (`+0x1D12 lsr.w #1,d4`, sub)
 *     0x0003  `+0x1CD8`  end of page
 *
 * The "LINE" idea came from the MENU's rectangles, which are a separate
 * polyline list at h0+0xCF58 drawn by h0+0x1274 (called at +0x130E), not by the
 * page interpreter at all. Width measurement is `+0x1D20` over the byte-per-
 * character advance table at h0+0x1E16, which is what `measureShellText` and
 * `alignShellText` in `shell-art.ts` implement. `fill`, `box` and `glyphs`
 * below are the primitives — the menu's lines are only ever axis-aligned, so
 * they are filled spans rather than stroked paths, which is what keeps a 1-px
 * rule exactly one pixel rather than two half-lit ones.
 *
 * WHAT IS THE DISK'S AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * When the host has loaded the exported shell artwork (`ShellSkin` non-null),
 * the presentation is `menudata.bin`'s own:
 *
 *   - both proportional FONTS — the 19-px two-plane menu font and the small
 *     single-plane font — drawn glyph by glyph on the disk's own advance,
 *     height and y-offset metrics. The two planes are an anti-alias ramp, not
 *     fill and outline: there is no black outline and no knockout anywhere in
 *     the original's text, the backdrop shows right up against the glyph edge;
 *   - the BACKDROP strips: eight 32-row bands, each showing a 288-px window
 *     into a 1472 x 32 strip of a tumbling object, wobbled by the disk's own
 *     ±64 sine table on the copper's indexing — 10 per band, 1 per tick — over
 *     a base scroll quantised to whole 32-px objects;
 *   - the SIXTEEN PAGE PALETTES, cycled by the disk's own free-running
 *     backdrop service (see `shell-skin.ts`). Colour 0 is black in every live
 *     one, so the objects always tumble on a black field;
 *   - the original's own 16 x 16 dissolve order for the info screen's picture.
 *
 * MEASURED OFF THE FILM rather than decoded, because they live in `main.bin`'s
 * copper list and not in `menudata.bin` (see `palette.ts`): the $003 navy
 * surround ring, the 1-px white frame rectangle, and the $fff / $aaa / $777
 * text ramp. Every coordinate below that carries a "measured" note was read off
 * the filmed original at native resolution.
 *
 * ALSO THE DISK'S, as of this round: the ATTRACT PAGE TEXT and its geometry.
 * The twelve pages of the credit roll are decoded from the page display lists
 * in `menudata.bin` hunk 4 and every line carries the record's own x, y and
 * alignment word — see `ATTRACT_PAGES` in `shell.ts`, which also records what
 * from that array deliberately does NOT ship. This replaces a set of pages the
 * reconstruction wrote for itself under an earlier rights rule.
 *
 * NOT THE DISK'S AT ALL: the hint lines naming keys (the original prints
 * nothing on row 224), and every screen the film never caught — table select,
 * the info screen, the ladder and the cards over the playfield. Those are
 * marked screen by screen below.
 *
 * Without the skin — assets still fetching, or fetch failed — every screen
 * falls back to the browser-font placeholder rendering, so the shell is never
 * blank.
 */

import {
  SHELL_BACKDROP,
  SHELL_BAND,
  SHELL_DIM,
  SHELL_FIELD,
  SHELL_FRAME,
  SHELL_HIGHLIGHT,
  SHELL_HIGHLIGHT_FILL,
  SHELL_PANEL,
  SHELL_SURROUND,
  SHELL_TEXT,
} from "./palette.js";
import {
  ATTRACT_ERASE_START_TICK,
  ATTRACT_PAGES,
  MENU_ITEMS,
  SHELL_TABLES,
  highlightedTable,
  shellTableFor,
} from "./shell.js";
import type { ShellState } from "./shell.js";
import { shellBackdropFrame } from "./shell-skin.js";
import type { ShellSkin, SkinFontKey } from "./shell-skin.js";
import {
  FONT_ATLAS_WIDTH,
  STRIP_PITCH,
  STRIP_WIDTH,
  alignShellText,
  shellCharCode,
} from "../game/shell-art.js";
import type { ShellFont } from "../game/shell-art.js";
import { LOADING_LOGO_HEIGHT, LOADING_LOGO_WIDTH } from "../game/loading-logo.js";
import type { HighScoreEntry } from "../game/high-scores.js";
import type { TableId } from "../game/contracts.js";

// ---------------------------------------------------------------------------
// The 320 x 256 box
// ---------------------------------------------------------------------------

export const SHELL_WIDTH = 320;
export const SHELL_HEIGHT = 256;
/** The reconstruction's window is 336 wide; the shell is centred in it. */
export const SHELL_ORIGIN_X = 8;

/**
 * The frame rectangle and the field inside it — measured off the filmed screen.
 *
 * The 1-px white rectangle runs (15,15) to (304,240) INCLUSIVE; the navy ring
 * is everything outside it; the objects are clipped to the 288 x 224 interior.
 * Those coordinates were already in this file's `frame()` before the film was
 * measured, and the film agreed with them to the pixel.
 */
export const FRAME_LEFT = 15;
export const FRAME_TOP = 15;
export const FRAME_RIGHT = 304;
export const FRAME_BOTTOM = 240;
export const FIELD_X = FRAME_LEFT + 1;
export const FIELD_Y = FRAME_TOP + 1;
export const FIELD_WIDTH = FRAME_RIGHT - FRAME_LEFT - 1;
export const FIELD_HEIGHT = FRAME_BOTTOM - FRAME_TOP - 1;

/** The three fallback fonts, as logical pixel heights on the original's pitches. */
const FONT_BIG = 14;
const FONT_SMALL = 9;
const FONT_TINY = 7;

const FONT_STACK = "ui-monospace, 'DejaVu Sans Mono', 'Courier New', monospace";

/**
 * Skin text colours.
 *
 * White is measured, not chosen: plane value 1 is $fff on every filmed page,
 * and `shell-skin.ts` derives the ramp's other two steps from it. Amber is kept
 * for the one job the placeholder already used it for — marking the freshly-
 * earned ladder row — and is stated as a choice: nothing on the film is amber.
 *
 * `SKIN_DIM` is the ramp's darkest step. It is for ink that sits on a BLACK
 * card, never on the object field: measured against the field it scores 1.02:1
 * on the orange page and 1.05:1 on green, i.e. invisible wherever it crosses an
 * object. `SKIN_HINT` is therefore white, and it is what the hint rows use —
 * those rows are the reconstruction's own (the original names its keys in a
 * manual, not on screen), so nothing about them is a fidelity claim and there is
 * no reason to print them in the one tone that cannot be read. White's worst
 * case over any live palette is 3.57:1, on gold.
 */
const SKIN_WHITE = SHELL_TEXT;
const SKIN_DIM = SHELL_DIM;
const SKIN_HINT = SHELL_TEXT;
const SKIN_AMBER = SHELL_HIGHLIGHT;

/** Eight 32-row bands: the original's own division of the 256-row screen. */
const BAND_HEIGHT = 32;
const BAND_COUNT = SHELL_HEIGHT / BAND_HEIGHT;

/**
 * The base scroll under the sine wobble — C, and how fast it moves.
 *
 * Measured on stills: every band offset read off seven filmed pages fits
 * `C + sine[(p + 10*band) & 255]` with C a MULTIPLE OF 32, so the base is
 * quantised to whole objects and the sine supplies the sub-object wobble.
 *
 * MEASURED ON FILM, and this is the part single frames could not give: C IS NOT
 * STATIC AND IT DOES NOT STEP EVERY TWO FRAMES. It advances one whole 32-px
 * object every 128 frames — 0.25 px/frame — and the picture drifts LEFT. The
 * measurement compares object silhouettes at lags where the sine contributes
 * identically: over 256 frames (one sine period) the pattern is displaced
 * exactly 64 px = 2 objects, in 212 of the 225 usable windows across a 400 s
 * recording, and over 512 frames exactly 128 px. C never deviated from that
 * rate and never jumped at a strip swap.
 *
 * THE REASON EVERY EARLIER ROUND MISSED IT is that the step is exactly the
 * object pitch, so it is completely invisible to any measurement made modulo
 * the pitch — which is what a still gives you. It only shows in WHICH CELLS of
 * the pre-rendered tumble animation are on screen. This file used to step the
 * base one object every TWO frames, i.e. 64 times too fast.
 *
 * The window into the strip moves RIGHT as the picture moves LEFT, so `base`
 * increases. `STRIP_MARGIN` is the constant it sits on, and the absolute value
 * of C is only known modulo 32 px — the film says so explicitly — so any whole
 * object is a legal start. 64 is the smallest multiple of 32 that keeps the
 * whole travel (base 0..992, wobble ±64, window 288 wide) inside the 1472-px
 * strip at both ends, so the strip never has to wrap.
 */
const STRIP_BASE_STEP = STRIP_PITCH;
/** Frames C spends on one object before stepping to the next. */
export const STRIP_BASE_FRAMES_PER_OBJECT = 128;
/** Objects C walks before it returns to where it started: 0..992 in 32s. */
const STRIP_BASE_OBJECTS = 32;
const STRIP_MARGIN = 64;

/** The copper's sine indexing: 10 per band, 1 per tick. */
const SINE_STEP_PER_BAND = 10;

/**
 * The dithered front, and it is an ERASE.
 *
 * Two filmed stills first caught an attract page mid-transition and both obey
 *
 *     row y is visible  iff  y >= front - 7 * (y mod 8)
 *
 * with `front` a multiple of 8 — eight interleaved fronts, one per (y mod 8)
 * phase, staggered 7 rows apart. Measured front = 160 on one still and 128 on
 * the other. That rule is EXACTLY RIGHT and is kept verbatim.
 *
 * What a single frame could not say was the direction and the rate. A 399 s
 * continuous capture (`researchiew
eference\session3`) says both: the
 * front runs DOWNWARD at 4 rows a frame, and it erases the page that is going
 * away rather than revealing the one arriving. The clock is
 * `attractEraseFront`; the same staircase run the other way is what fills the
 * backdrop in once per boot, which is the only place a REVEAL happens at all.
 *
 * The rule is algebraically the original's own band sweep at `+0x30B6`: base
 * row 16, 30 bands, rows cleared on step k are y = 16 + 7b + k for
 * max(0,k-7) <= b <= min(29,k), and 16 == 0 (mod 8) is what makes the two
 * forms identical.
 */
const WIPE_PHASE_STAGGER = 7;
const WIPE_PHASES = 8;

type Align = "left" | "center" | "right";

/**
 * The bit of a 2d context these screens use.
 *
 * Structural rather than the DOM type, for the same reason `playfield-renderer`
 * does it: a page can then be drawn against a recording double in a test with no
 * browser anywhere.
 */
export interface ShellContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  imageSmoothingEnabled: boolean;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  beginPath(): void;
  save(): void;
  restore(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/** Somewhere the host keeps one drawable thumbnail per table. */
export interface ShellArtworkSource {
  /** The table's picture, or null while it is still being fetched. */
  imageFor(tableId: TableId): CanvasImageSource | null;
}

function px(value: number, scale: number): number {
  return (SHELL_ORIGIN_X + value) * scale;
}

function py(value: number, scale: number): number {
  return value * scale;
}

/**
 * A block of shell pixels, filled exactly.
 *
 * Every rule and rectangle on these screens is one game pixel thick and axis
 * aligned, which a stroked path cannot draw: `strokeRect` centres the stroke on
 * the path and turns a 1-px rule into two half-lit rows. Filling spans instead
 * puts each shell pixel on an exact `scale` x `scale` block of device pixels,
 * which is the whole point of drawing a 1995 screen at an integer magnification.
 */
function fill(
  ctx: ShellContext,
  scale: number,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: string,
): void {
  if (width <= 0 || height <= 0) return;
  ctx.fillStyle = colour;
  ctx.fillRect(px(x, scale), py(y, scale), width * scale, height * scale);
}

/**
 * One of the shell's boxes. `x2`/`y2` are INCLUSIVE, as the display list's
 * vector coordinates are: (120,83)-(200,115) is the 81 x 33 menu highlight the
 * film measures.
 *
 * The raster detail is the original's own, measured on the filmed menu page: the
 * top edge and the left edge run their full length, the bottom and the right
 * stop one pixel short, and the BOTTOM-RIGHT CORNER IS NOT DRAWN AT ALL. That is
 * what a four-segment polyline whose last segment ends where the first began
 * leaves behind, and reproducing it is what takes the menu page to a zero
 * mismatch against the film.
 */
function box(
  ctx: ShellContext,
  scale: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  colour: string,
  background: string | null,
): void {
  const width = x2 - x1 + 1;
  const height = y2 - y1 + 1;
  if (background !== null) fill(ctx, scale, x1, y1, width, height, background);
  fill(ctx, scale, x1, y1, width, 1, colour);
  fill(ctx, scale, x1, y2, width - 1, 1, colour);
  fill(ctx, scale, x1, y1, 1, height, colour);
  fill(ctx, scale, x2, y1, 1, height - 1, colour);
}

/** The browser-font fallback TEXT primitive. Skinned screens use `glyphs`. */
function text(
  ctx: ShellContext,
  scale: number,
  x: number,
  y: number,
  value: string,
  colour: string,
  size: number,
  align: Align = "left",
): void {
  ctx.font = `${Math.max(8, Math.round(size * scale))}px ${FONT_STACK}`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillStyle = colour;
  ctx.fillText(value, px(x, scale), py(y, scale));
}

// ---------------------------------------------------------------------------
// The skinned primitives: the disk's fonts and backdrops
// ---------------------------------------------------------------------------

function skinFontData(skin: ShellSkin, font: SkinFontKey): ShellFont {
  return font === "font1" ? skin.art.font1 : skin.art.font2;
}

/**
 * One run of text in a decoded font.
 *
 * `y` is the glyph-box top, which is the coordinate the original's TEXT opcode
 * carries; each glyph adds its own signed y-offset (that is how a comma sits
 * low). Centring is the original's own arithmetic: `alignShellText` computes
 * `x - floor(width/2)`, which on x = 160 is identically the
 * `(320 - width + 1) >> 1` the filmed strings measure to, including the two
 * whose odd advance sums round the other way under a plain `>> 1`.
 *
 * One pass, because the glyph planes are an anti-alias ramp rather than a fill
 * over an outline: every non-zero plane value is ink of some brightness and
 * value 0 leaves the backdrop showing, which is what the film has.
 */
function glyphs(
  ctx: ShellContext,
  skin: ShellSkin,
  font: SkinFontKey,
  scale: number,
  x: number,
  y: number,
  value: string,
  colour: string,
  align: Align = "left",
): void {
  const data = skinFontData(skin, font);
  const atlas = skin.fontAtlas(font, colour);
  let pen = alignShellText(data, value, x, align);
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < value.length; i += 1) {
    const glyph = data.glyphs[shellCharCode(value, i)];
    if (glyph === undefined) continue;
    if (glyph.height > 0) {
      ctx.drawImage(
        atlas,
        0,
        glyph.top,
        FONT_ATLAS_WIDTH,
        glyph.height,
        px(pen, scale),
        py(y + glyph.yOffset, scale),
        FONT_ATLAS_WIDTH * scale,
        glyph.height * scale,
      );
    }
    pen += glyph.advance;
  }
}

/**
 * Where band `band` reads the strip at `tick`.
 *
 * `C(tick) + sine[(tick + 10*band) & 255]`, exactly the shape every filmed page
 * fits, with C stepping one whole 32-px object every 128 frames (see
 * `STRIP_BASE_FRAMES_PER_OBJECT`) and the sine advancing one table entry a
 * frame — a 256-frame wobble, fitted at 0.99998 steps/frame over 1900 frames.
 */
export function shellBandOffset(sine: readonly number[], tick: number, band: number): number {
  const period = STRIP_BASE_OBJECTS * STRIP_BASE_FRAMES_PER_OBJECT;
  const counter = ((tick % period) + period) % period;
  const base = STRIP_MARGIN + Math.floor(counter / STRIP_BASE_FRAMES_PER_OBJECT) * STRIP_BASE_STEP;
  return base + (sine[(tick + band * SINE_STEP_PER_BAND) & 0xff] ?? 0);
}

/**
 * The decoded backdrop: eight 32-row bands over the whole 256-row screen, each
 * a 288-px window into the current strip at that band's own offset, clipped to
 * the frame's interior so bands 0 and 7 show only their inner 16 rows — which is
 * how the original's field meets its border.
 *
 * Pure in the tick and the palette, so two runs at the same tick draw the same
 * frame.
 */
function skinBands(
  ctx: ShellContext,
  skin: ShellSkin,
  role: "attract" | "menu" | "select",
  palette: Uint8Array,
  scale: number,
  tick: number,
): void {
  const strip = skin.backdrop(role, palette);
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  ctx.beginPath();
  ctx.rect(px(FIELD_X, scale), py(FIELD_Y, scale), FIELD_WIDTH * scale, FIELD_HEIGHT * scale);
  ctx.clip();
  for (let band = 0; band < BAND_COUNT; band += 1) {
    const left = shellBandOffset(skin.art.sine, tick, band);
    ctx.drawImage(
      strip,
      Math.max(0, Math.min(STRIP_WIDTH - FIELD_WIDTH, left)),
      0,
      FIELD_WIDTH,
      BAND_HEIGHT,
      px(FIELD_X, scale),
      py(band * BAND_HEIGHT, scale),
      FIELD_WIDTH * scale,
      BAND_HEIGHT * scale,
    );
  }
  ctx.restore();
}

/**
 * The screen frame: the 1-px rectangle (15,15)-(304,240), measured white.
 *
 * Its own polyline runs the other way round from a menu box's, so the corner it
 * leaves out is the BOTTOM-LEFT one — (15,240) is navy on every filmed page, and
 * that single pixel is the whole difference between this and `box`. Measured on
 * the film run by run: top x 15..304, right y 15..240, bottom x 16..304, left
 * y 15..239.
 */
function frame(ctx: ShellContext, scale: number, colour: string = SHELL_FRAME): void {
  const width = FRAME_RIGHT - FRAME_LEFT + 1;
  const height = FRAME_BOTTOM - FRAME_TOP + 1;
  fill(ctx, scale, FRAME_LEFT, FRAME_TOP, width, 1, colour);
  fill(ctx, scale, FRAME_RIGHT, FRAME_TOP, 1, height, colour);
  fill(ctx, scale, FRAME_LEFT + 1, FRAME_BOTTOM, width - 1, 1, colour);
  fill(ctx, scale, FRAME_LEFT, FRAME_TOP, 1, height - 1, colour);
}

/**
 * The empty screen: navy everywhere, black inside the frame.
 *
 * Both colours are measured. The navy ring is 15 px of $003 on all four sides
 * of the 320 x 256 screen; this reconstruction's window is 336 wide, so the
 * eight extra pixels each side take the same navy and the ring simply reads as
 * 23 px rather than 15. The field is $000, which is also colour 0 of every live
 * page palette — the strip's own background index — so the two cannot drift.
 */
function clear(ctx: ShellContext, scale: number, skin: ShellSkin | null): void {
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.fillStyle = SHELL_SURROUND;
  ctx.fillRect(0, 0, (SHELL_WIDTH + 2 * SHELL_ORIGIN_X) * scale, SHELL_HEIGHT * scale);
  fill(
    ctx,
    scale,
    FIELD_X,
    FIELD_Y,
    FIELD_WIDTH,
    FIELD_HEIGHT,
    skin === null ? SHELL_BACKDROP : SHELL_FIELD,
  );
}

/**
 * The fallback bands: eight rows of blocks standing in for the strips when the
 * artwork has not arrived, on the same eight-band grid, wobbled by the same
 * cosine so the stand-in moves the way the real field does. Deterministic in the
 * tick, like the real thing.
 */
function bands(ctx: ShellContext, scale: number, tick: number): void {
  const cell = STRIP_PITCH;
  ctx.save();
  ctx.beginPath();
  ctx.rect(px(FIELD_X, scale), py(FIELD_Y, scale), FIELD_WIDTH * scale, FIELD_HEIGHT * scale);
  ctx.clip();
  for (let band = 0; band < BAND_COUNT; band += 1) {
    const phase =
      (((64 * Math.cos((2 * Math.PI * (tick + band * SINE_STEP_PER_BAND)) / 256)) % cell) + cell) %
      cell;
    const top = band * BAND_HEIGHT;
    for (let x = FIELD_X - cell; x < FIELD_X + FIELD_WIDTH + cell; x += cell) {
      fill(ctx, scale, Math.round(x + phase) + 6, top + 8, cell - 12, BAND_HEIGHT - 16, SHELL_BAND);
    }
  }
  ctx.restore();
}

/**
 * Backdrop for a menu screen: the real strip, or the stand-in.
 *
 * WHICH strip and WHICH palette is not the screen's to choose, and that is why
 * this takes no role. The original runs ONE free-running backdrop service under
 * every shell state, cycling the eight page tints and swapping the strip at the
 * black one — which is why the film caught the same credits page on the cube
 * strip once and on the torus twice, across three cold boots, and caught the
 * main menu on the cube. The clock is the shell's own free-running tick, so the
 * field goes on turning across every screen change exactly as it does on the
 * disk.
 */
function backdrop(ctx: ShellContext, scale: number, skin: ShellSkin | null, tick: number): void {
  clear(ctx, scale, skin);
  if (skin === null) {
    bands(ctx, scale, tick);
    return;
  }
  const service = shellBackdropFrame(skin.art, tick);
  skinBands(ctx, skin, service.role, service.palette, scale, tick);
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/** Comma-grouped, which is what the original's ladder template prints. */
export function formatScore(value: number): string {
  return Math.max(0, Math.floor(value)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The five-line ladder block.
 *
 * The original's template at hunk-0 0x1836 is five 25-byte records, each
 * `0x08 0xB4 "N.III" 0x08 <x> <15-char score field> 0x0A`: rank and initials
 * left-aligned at x = 180, score right-aligned at x = 300. Skinned, the block
 * is set in the small font and the right alignment IS the original's sum —
 * `300 - (3*commas + 7*digits)` — because 3 and 7 are that font's comma and
 * digit advances and `alignShellText` sums the same table. `leftX` and `rightX`
 * are parameters only because the same block is drawn on the table's own
 * attract screen too, where it has the whole width rather than the info
 * screen's right half.
 */
function ladderBlock(
  ctx: ShellContext,
  scale: number,
  skin: ShellSkin | null,
  entries: readonly HighScoreEntry[],
  leftX: number,
  rightX: number,
  topY: number,
  pitch: number,
  size: number,
  highlight: number,
): void {
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const y = topY + i * pitch;
    const rank = `${i + 1}.${entry.initials.padEnd(3, " ")}`;
    const score = formatScore(entry.score);
    if (skin === null) {
      const colour = i === highlight ? SHELL_HIGHLIGHT : SHELL_TEXT;
      text(ctx, scale, leftX, y, rank, colour, size);
      text(ctx, scale, rightX, y, score, colour, size, "right");
    } else {
      const colour = i === highlight ? SKIN_AMBER : SKIN_WHITE;
      glyphs(ctx, skin, "font2", scale, leftX, y, rank, colour);
      glyphs(ctx, skin, "font2", scale, rightX, y, score, colour, "right");
    }
  }
}

// ---------------------------------------------------------------------------
// The thumbnail
// ---------------------------------------------------------------------------

/**
 * The table's own picture, fitted into a panel.
 *
 * The original puts a 128 x 128 painted logo panel here, decompressed out of
 * that table's `.mnu` package and blitted in 8 x 8 units in a scrambled order —
 * four units a frame, about sixty-four frames, a random dissolve. Those panels
 * are not exported; what is exported and already ships is the table's own
 * PLAYFIELD artwork, which is a better answer to "which table is this?" anyway.
 * It is 336 x 600, so it is letterboxed into the panel rather than stretched.
 *
 * The dissolve is the original's: `DISSOLVE_UNITS_PER_FRAME` blocks of the
 * 16 x 16 grid revealed per frame. Skinned, the order is the disk's own
 * scrambled table (the third of the four at menudata h4+0x780); the fallback
 * uses a fixed coprime-stride permutation with the same shape. No random
 * source anywhere: two runs at the same frame count reveal the same blocks.
 */
const DISSOLVE_UNITS_PER_FRAME = 4;
const DISSOLVE_GRID = 16;

const DISSOLVE_CELLS = DISSOLVE_GRID * DISSOLVE_GRID;

/**
 * The fallback's step between successive cells, in cells.
 *
 * Coprime to 256, so walking it visits every cell exactly once and the whole
 * picture is revealed with nothing drawn twice. 97 is 6 x 16 + 1, so each step
 * lands six rows down and one column across — a scatter rather than a raster,
 * which is the point of a dissolve.
 */
const DISSOLVE_STRIDE = 97;

const DISSOLVE_ORDER: readonly number[] = Object.freeze(
  Array.from({ length: DISSOLVE_CELLS }, (_, i) => ((i + 1) * DISSOLVE_STRIDE) % DISSOLVE_CELLS),
);

/** Which of the disk's four reveal orders the info screen uses: the shuffle. */
const SKIN_DISSOLVE_TABLE = 2;

function thumbnail(
  ctx: ShellContext,
  scale: number,
  skin: ShellSkin | null,
  artwork: ShellArtworkSource,
  tableId: TableId,
  x: number,
  y: number,
  width: number,
  height: number,
  dissolveFrames: number | null,
): void {
  box(
    ctx,
    scale,
    x,
    y,
    x + width - 1,
    y + height - 1,
    skin === null ? SHELL_FRAME : SKIN_WHITE,
    SHELL_PANEL,
  );
  const image = artwork.imageFor(tableId);
  if (image === null) {
    if (skin === null) {
      text(ctx, scale, x + width / 2, y + height / 2 - 4, "...", SHELL_DIM, FONT_SMALL, "center");
    } else {
      glyphs(ctx, skin, "font2", scale, x + Math.floor(width / 2), y + Math.floor(height / 2) - 4, "...", SKIN_DIM, "center");
    }
    return;
  }

  // Letterboxed: the playfield is 336 x 600 and the panel is square-ish, so the
  // picture is fitted rather than stretched. A stretched playfield is a lie
  // about the table's proportions.
  const source = imageSize(image);
  const fit = Math.min(width / source.width, height / source.height);
  const drawWidth = source.width * fit;
  const drawHeight = source.height * fit;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(px(x + 1, scale), py(y + 1, scale), (width - 2) * scale, (height - 2) * scale);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;

  if (dissolveFrames === null) {
    ctx.drawImage(
      image,
      0,
      0,
      source.width,
      source.height,
      px(drawX, scale),
      py(drawY, scale),
      drawWidth * scale,
      drawHeight * scale,
    );
    ctx.restore();
    return;
  }

  const order = skin === null ? DISSOLVE_ORDER : (skin.art.dissolve[SKIN_DISSOLVE_TABLE] ?? DISSOLVE_ORDER);
  const revealed = Math.min(order.length, Math.max(0, dissolveFrames) * DISSOLVE_UNITS_PER_FRAME);
  const unitW = drawWidth / DISSOLVE_GRID;
  const unitH = drawHeight / DISSOLVE_GRID;
  const sourceUnitW = source.width / DISSOLVE_GRID;
  const sourceUnitH = source.height / DISSOLVE_GRID;
  for (let i = 0; i < revealed; i += 1) {
    const cell = order[i];
    if (cell === undefined) continue;
    const column = cell % DISSOLVE_GRID;
    const row = Math.floor(cell / DISSOLVE_GRID);
    ctx.drawImage(
      image,
      column * sourceUnitW,
      row * sourceUnitH,
      sourceUnitW,
      sourceUnitH,
      px(drawX + column * unitW, scale),
      py(drawY + row * unitH, scale),
      // A hair over one unit so the seams between blocks never show as a grid.
      unitW * scale + 1,
      unitH * scale + 1,
    );
  }
  ctx.restore();
}

function imageSize(image: CanvasImageSource): { width: number; height: number } {
  const candidate = image as { width?: unknown; height?: unknown };
  const width = typeof candidate.width === "number" ? candidate.width : 336;
  const height = typeof candidate.height === "number" ? candidate.height : 600;
  return { width, height };
}

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

/**
 * The credits roll.
 *
 * DECODED AND MEASURED: the frame and its navy surround; the field of tumbling
 * objects behind the text; THE WORDS, and every line's own x, y and alignment
 * word, which come out of the page display lists in `menudata.bin` hunk 4 —
 * see `ATTRACT_PAGES` in `shell.ts` for the decode, the twelve-page roll, and
 * for what deliberately does not ship; the centring arithmetic; the white ink;
 * and the erase.
 *
 * NOT the original's: the hint line at the bottom. The original prints nothing
 * there — its row 224 is bare — and the keys this reconstruction names were in
 * the manual instead. It is in the small font, in the ramp's darkest step,
 * clear of every page's text and well inside the frame.
 *
 * THE TRANSITION RUNS DOWNWARD AND IT ERASES THE OUTGOING PAGE. That is the
 * thing no single still could show and a continuous capture settles: the text
 * appears COMPLETE IN ONE FRAME, is held bit-identical, and is then dissolved
 * from the top down at four rows a frame. This file used to model it as an
 * upward REVEAL of the incoming page, which is the same dithered pattern run
 * backwards, and the ladder it drew the lines on could not represent a page of
 * more than three lines.
 */
/** The reconstruction's own hint row, below every page's last line. */
const HINT_Y = 224;
const HINT_ATTRACT = "PRESS SPACE - F1-F3 GO STRAIGHT TO A TABLE";

/** Rows a wipe front has reached. See `WIPE_PHASE_STAGGER`. */
export function shellWipeShowsRow(front: number, y: number): boolean {
  return y >= front - WIPE_PHASE_STAGGER * (((y % WIPE_PHASES) + WIPE_PHASES) % WIPE_PHASES);
}

/**
 * The erase front `ticks` into a page, or null while the page is still fully up.
 *
 * MEASURED, `session3	elemetry\wipe-erase-front.csv`: the front is quantised
 * to multiples of 8, it changes on alternate frames, and it starts at 0 exactly
 * 101 frames after the page appeared —
 *
 *     F(t) = 8 * floor((t - 101) / 2)
 *
 * — which is ATTRACT_ERASE_ROWS_PER_TICK = 4 rows a frame, INCREASING. The
 * bracket the visible rows imply for F collapses to one value at every erase
 * frame of every one of the 113 filmed page instances, and it is this value.
 *
 * F would have to reach 272 to clear all 224 rows, i.e. t = 169, seven frames
 * before the next page appears.
 *
 * THIS IS IN PICTURE ROWS, where the field's first row is 0, because that is the
 * space the film was measured in. `shellWipeShowsRow` is fed `y` in SCREEN rows,
 * where the same row is FIELD_Y = 16, so the caller adds FIELD_Y. Keeping the
 * conversion at the call site rather than in here is deliberate: the numbers
 * above are a measurement and should read as one.
 *
 * That conversion was missing and it cost four frames. Because 16 is itself a
 * multiple of 8 the two forms are algebraically identical apart from the
 * constant — same staircase, same stagger, same quantisation — so nothing looked
 * wrong; every page simply held its text four frames too long and the field
 * cleared at t = 173 instead of 169. It was caught by diffing whole frames
 * against session3, not by any invariant: the filmed erase stills are
 * bit-identical to this renderer at t + 4 and differ at every same-t pair, and
 * solving for the front actually run gave F_recon = F_film - 16 exactly, on all
 * 324 erase frames of all twelve pages.
 */
export function attractEraseFront(ticks: number): number | null {
  if (ticks < ATTRACT_ERASE_START_TICK) return null;
  return 8 * Math.floor((ticks - ATTRACT_ERASE_START_TICK) / 2);
}

function drawAttract(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  backdrop(ctx, scale, skin, state.ticks);

  const page = ATTRACT_PAGES[state.attractPage] ?? [];
  if (skin === null) {
    frame(ctx, scale);
    for (const [i, line] of page.entries()) {
      const ink = i === 0 ? SHELL_HIGHLIGHT : SHELL_TEXT;
      text(ctx, scale, line.x, line.y, line.text, ink, FONT_BIG, line.align);
    }
    text(ctx, scale, 160, HINT_Y, HINT_ATTRACT, SHELL_DIM, FONT_TINY, "center");
    return;
  }

  frame(ctx, scale, SKIN_WHITE);

  const front = attractEraseFront(state.attractTicks);
  ctx.save();
  ctx.beginPath();
  if (front === null) {
    // The page text is the only writing on these screens whose length is not
    // fixed, so it is the only one that could ever reach the frame. Clipped to
    // the field so it cannot: a line too wide to fit is cut off inside the
    // border rather than printed over it.
    ctx.rect(px(FIELD_X, scale), py(FIELD_Y, scale), FIELD_WIDTH * scale, FIELD_HEIGHT * scale);
  } else {
    // THE WHOLE FIELD, not the text block's extent. The original's erase is a
    // 30-band sweep over the entire picture, and the roll's pages put lines
    // anywhere from row 44 to row 194; clipping to a block computed from the
    // lines would give each page its own private schedule instead of the one
    // the machine runs. Strictly per-scanline and all-or-nothing across the
    // width, which is what the mid-transition stills show.
    // `front` is in picture rows and `y` is in screen rows; FIELD_Y converts.
    // Omitting it ran the erase four frames late — see `attractEraseFront`.
    const screenFront = front + FIELD_Y;
    for (let y = FIELD_Y; y < FIELD_Y + FIELD_HEIGHT; y += 1) {
      if (shellWipeShowsRow(screenFront, y)) {
        ctx.rect(px(FIELD_X, scale), py(y, scale), FIELD_WIDTH * scale, scale);
      }
    }
  }
  ctx.clip();
  for (const line of page) {
    glyphs(ctx, skin, "font1", scale, line.x, line.y, line.text, SKIN_WHITE, line.align);
  }
  ctx.restore();

  glyphs(ctx, skin, "font2", scale, 160, HINT_Y, HINT_ATTRACT, SKIN_HINT, "center");
}

/**
 * The main menu. Two items and only two: display list 0xCF3C — centred
 * "Tables" at (160,90) and centred "Exit" at (160,133), with the rectangles at
 * 0xCF58, (120,83)-(200,115) and (120,126)-(200,158).
 *
 * MEASURED off the film, which caught this page whole: both rectangles are
 * drawn every frame and both are 81 x 33; the one the cursor is on is WHITE and
 * the other is BLACK. A black rectangle over a black field is invisible except
 * where it crosses a lit object, which is why the unselected item looks chopped
 * up on the original rather than boxed. The film's cursor was on "Exit".
 *
 * The hint line is the reconstruction's. The fallback additionally titles the
 * page, because a placeholder needs more signposting than the real artwork does.
 */
export const MENU_RECTS = Object.freeze([
  Object.freeze({ x1: 120, y1: 83, x2: 200, y2: 115, textY: 90 }),
  Object.freeze({ x1: 120, y1: 126, x2: 200, y2: 158, textY: 133 }),
]);

const HINT_MENU = "UP/DOWN CHOOSE   SPACE SELECTS   ESC BACK";

function drawMenu(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  backdrop(ctx, scale, skin, state.ticks);

  if (skin === null) {
    frame(ctx, scale);
    text(ctx, scale, 160, 40, "PINBALL ILLUSIONS", SHELL_HIGHLIGHT, FONT_BIG, "center");
    for (let i = 0; i < MENU_RECTS.length; i += 1) {
      const rect = MENU_RECTS[i];
      const label = MENU_ITEMS[i];
      if (rect === undefined || label === undefined) continue;
      const chosen = state.menuCursor === i;
      box(
        ctx,
        scale,
        rect.x1,
        rect.y1,
        rect.x2,
        rect.y2,
        chosen ? SHELL_HIGHLIGHT : SHELL_FRAME,
        chosen ? SHELL_HIGHLIGHT_FILL : null,
      );
      text(ctx, scale, 160, rect.textY, label, chosen ? SHELL_HIGHLIGHT : SHELL_TEXT, FONT_BIG, "center");
    }
    text(ctx, scale, 160, HINT_Y, HINT_MENU, SHELL_DIM, FONT_TINY, "center");
    return;
  }

  frame(ctx, scale, SKIN_WHITE);
  for (let i = 0; i < MENU_RECTS.length; i += 1) {
    const rect = MENU_RECTS[i];
    const label = MENU_ITEMS[i];
    if (rect === undefined || label === undefined) continue;
    const chosen = state.menuCursor === i;
    box(ctx, scale, rect.x1, rect.y1, rect.x2, rect.y2, chosen ? SKIN_WHITE : SHELL_FIELD, null);
    glyphs(ctx, skin, "font1", scale, 160, rect.textY, label, SKIN_WHITE, "center");
  }
  glyphs(ctx, skin, "font2", scale, 160, HINT_Y, HINT_MENU, SKIN_HINT, "center");
}

/**
 * Table select.
 *
 * The list is a vertical strip on a 32-pixel pitch whose selected entry always
 * sits at y = 118 — the original rewrites every entry's Y to
 * `118 - 32*cursor + 32*i` every frame and clips it to 22..214. The border is
 * the vector list at 0xCF12, (15,15)-(304,240); the two boxes are
 * (20,111)-(218,143) around the name and (228,111)-(300,143) labelled "Info"
 * centred on (264,118), and LEFT/RIGHT move between them. The names are centred
 * in their box — the box's centre is x = 119 — which is a choice, not a
 * measurement: the list's x is the one coordinate the display list does not
 * pin, and everything else on these screens is centred.
 *
 * The preview panel above the Info box is a reconstruction: the original's table
 * select has no artwork on it at all, the picture lives one screen further in on
 * Info. Choosing between three tables is easier when you can see them.
 *
 * THE FILM NEVER CAUGHT THIS SCREEN — not one frame of the whole census — so
 * nothing below is measured except the border, the surround and the ink, which
 * are shared with the pages that were caught. The box coordinates are the
 * display list's; the rest is stated as this reconstruction's arrangement. The
 * unselected box follows the menu's measured rule and is drawn in the field's
 * own black rather than a dimmed white.
 */
/**
 * Table select's two boxes and the strip the names scroll through, named rather
 * than inlined so the touch hit test can be built on the renderer's own numbers
 * instead of a second copy of them. `SELECT_ROW_Y` is the row the selected entry
 * is pinned to and `SELECT_ROW_PITCH` the spacing either side of it, which
 * together turn a tap anywhere in the strip into a cursor offset.
 */
export const SELECT_NAME_BOX = Object.freeze({ x1: 20, y1: 111, x2: 218, y2: 143 });
export const SELECT_INFO_BOX = Object.freeze({ x1: 228, y1: 111, x2: 300, y2: 143 });
export const SELECT_LIST_CLIP = Object.freeze({ x1: 18, y1: 22, x2: 220, y2: 214 });
export const SELECT_ROW_Y = 118;
export const SELECT_ROW_PITCH = 32;

function drawSelect(
  ctx: ShellContext,
  scale: number,
  state: ShellState,
  artwork: ShellArtworkSource,
  skin: ShellSkin | null,
): void {
  backdrop(ctx, scale, skin, state.ticks);

  const skinned = skin !== null;
  const focusColour = skinned ? SKIN_WHITE : SHELL_HIGHLIGHT;
  const idleColour = skinned ? SHELL_FIELD : SHELL_FRAME;

  frame(ctx, scale, skinned ? SKIN_WHITE : SHELL_FRAME);
  if (skin === null) {
    text(ctx, scale, 160, 30, "SELECT A TABLE", SHELL_HIGHLIGHT, FONT_SMALL, "center");
  }

  box(
    ctx,
    scale,
    SELECT_NAME_BOX.x1,
    SELECT_NAME_BOX.y1,
    SELECT_NAME_BOX.x2,
    SELECT_NAME_BOX.y2,
    state.column === 0 ? focusColour : idleColour,
    !skinned && state.column === 0 ? SHELL_HIGHLIGHT_FILL : null,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    px(SELECT_LIST_CLIP.x1, scale),
    py(SELECT_LIST_CLIP.y1, scale),
    (SELECT_LIST_CLIP.x2 - SELECT_LIST_CLIP.x1) * scale,
    (SELECT_LIST_CLIP.y2 - SELECT_LIST_CLIP.y1) * scale,
  );
  ctx.clip();
  for (let i = 0; i < SHELL_TABLES.length; i += 1) {
    const table = SHELL_TABLES[i];
    if (table === undefined) continue;
    const y = SELECT_ROW_Y + SELECT_ROW_PITCH * (i - state.cursor);
    if (y < SELECT_LIST_CLIP.y1 || y > SELECT_LIST_CLIP.y2) continue;
    if (skin === null) {
      text(ctx, scale, 28, y, table.name, i === state.cursor ? SHELL_HIGHLIGHT : SHELL_DIM, FONT_BIG);
    } else {
      glyphs(ctx, skin, "font1", scale, 119, y, table.name, SKIN_WHITE, "center");
    }
  }
  ctx.restore();

  box(
    ctx,
    scale,
    SELECT_INFO_BOX.x1,
    SELECT_INFO_BOX.y1,
    SELECT_INFO_BOX.x2,
    SELECT_INFO_BOX.y2,
    state.column === 1 ? focusColour : idleColour,
    !skinned && state.column === 1 ? SHELL_HIGHLIGHT_FILL : null,
  );
  if (skin === null) {
    text(ctx, scale, 264, SELECT_ROW_Y, "Info", state.column === 1 ? SHELL_HIGHLIGHT : SHELL_TEXT, FONT_BIG, "center");
  } else {
    glyphs(ctx, skin, "font1", scale, 264, SELECT_ROW_Y, "Info", SKIN_WHITE, "center");
  }

  thumbnail(ctx, scale, skin, artwork, highlightedTable(state).id, 238, 20, 52, 84, null);

  // Below y = 214, which is where the original clips the scrolling list: the
  // third name sits at y = 182 when the cursor is on the first, so anything
  // higher than this would be printed over it.
  const action = state.column === 0 ? "SPACE PLAYS THIS TABLE" : "SPACE SHOWS THE INFO SCREEN";
  if (skin === null) {
    text(ctx, scale, 160, 210, action, SHELL_TEXT, FONT_SMALL, "center");
    text(ctx, scale, 160, HINT_Y, "UP/DOWN   LEFT/RIGHT   SPACE   ESC", SHELL_DIM, FONT_TINY, "center");
  } else {
    glyphs(ctx, skin, "font2", scale, 160, 210, action, SKIN_WHITE, "center");
    glyphs(ctx, skin, "font2", scale, 160, HINT_Y, "UP/DOWN   LEFT/RIGHT   SPACE   ESC", SKIN_HINT, "center");
  }
}

/**
 * The info screen. Menu state 4, at 0x157A.
 *
 * The original's layout, kept: the artwork dissolves into x 176..303, y 16..143;
 * the table's text is typed out at four characters a frame from (16,16) in the
 * small font; and the high-score ladder is typed out below it from y = 160, rank
 * and initials at x = 180 and the score right-aligned on 300. Skinned, the
 * small font IS the font that arithmetic was written for, and the dissolve
 * order is the disk's own.
 *
 * What is typed is NOT the original's text. The `.mnu` package's paragraph is
 * the publisher's marketing copy and does not ship; the name is from
 * `tables.bin` and the two lines under it are written fresh. "Press ESC to exit"
 * is the disk's own last line and is functional — it tells you the only key that
 * leaves — so it stays.
 *
 * THE FILM NEVER CAUGHT THIS SCREEN either. Its own coordinates put the artwork
 * panel at x 176..303 and the typing at x = 16, both flush with the interior the
 * frame encloses, so the frame and the navy surround are drawn here as on every
 * other page; there are no objects behind it, which the layout leaves no room
 * for anyway.
 */
function drawInfo(
  ctx: ShellContext,
  scale: number,
  state: ShellState,
  artwork: ShellArtworkSource,
  skin: ShellSkin | null,
): void {
  clear(ctx, scale, skin);
  frame(ctx, scale, skin === null ? SHELL_FRAME : SKIN_WHITE);

  const table = highlightedTable(state);
  thumbnail(ctx, scale, skin, artwork, table.id, 176, 16, 128, 128, state.frameTicks);

  // Four characters a frame, over the whole block, newlines included.
  const body = [table.name, "", ...table.blurb, "", `TABLE ${String(table.slot).padStart(3, "0")}`];
  const budget = state.frameTicks * 4;
  let typed = 0;
  for (let i = 0; i < body.length; i += 1) {
    const value = body[i] ?? "";
    const room = Math.max(0, budget - typed);
    const shown = value.slice(0, room);
    if (shown.length > 0) {
      if (skin === null) {
        text(ctx, scale, 16, 16 + i * 14, shown, i === 0 ? SHELL_HIGHLIGHT : SHELL_TEXT, FONT_SMALL);
      } else if (i === 0) {
        glyphs(ctx, skin, "font1", scale, 16, 16, shown, SKIN_WHITE);
      } else {
        glyphs(ctx, skin, "font2", scale, 16, 16 + i * 14, shown, SKIN_WHITE);
      }
    }
    // The newline costs a character too, which is what makes the typewriter
    // pause at the end of a line rather than run straight on.
    typed += value.length + 1;
    if (typed > budget) break;
  }

  if (budget >= typed) {
    ladderBlock(ctx, scale, skin, state.ladder, 180, 300, 160, 16, FONT_SMALL, -1);
    if (skin === null) {
      text(ctx, scale, 16, 160, "HIGH SCORES", SHELL_HIGHLIGHT, FONT_SMALL);
      text(ctx, scale, 16, 228, "Press ESC to exit.", SHELL_DIM, FONT_SMALL);
    } else {
      glyphs(ctx, skin, "font2", scale, 16, 160, "HIGH SCORES", SKIN_WHITE);
      glyphs(ctx, skin, "font2", scale, 16, 228, "Press ESC to exit.", SKIN_DIM);
    }
  }
}

/**
 * Loading.
 *
 * MEASURED, and it is the one shell page that is nothing like the others: the
 * whole 320 x 256 is pure black, with NO navy surround, NO frame and no objects.
 * All the original puts on it is a 147 x 16 painted logo whose ink sits at
 * x 90..236 — a separate image belonging to the LOADER, not shell art out of
 * `menudata.bin`. It is decoded and shipped: `src/game/loading-logo.ts` fetches
 * it, `shell-skin.ts` builds the surface, and this page blits it at the row the
 * loader's own copper list puts it on. See `loading-logo.ts` for why that row is
 * 84 and not the 120 the film appears to measure.
 *
 * The font fallback below it is not dead code. `loadingLogo()` is nullable on
 * purpose — a build made without the authorized assets has no logo to draw — and
 * a shell that still says "Loading" is better than one that says nothing.
 */
const LOADING_INK_TOP = 120;

/**
 * Rows between the bottom of the word and the top of the table's name.
 *
 * The font fallback sets its 19-row cap block at 118 and its name at 150, so the
 * gap has always been 13. Keeping the same number under the logo keeps the two
 * paths looking like the same screen.
 */
const LOADING_NAME_GAP = 13;

function drawLoading(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  // Black to all four edges — no ring and no frame, unlike every other page.
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.fillStyle = SHELL_FIELD;
  ctx.fillRect(0, 0, (SHELL_WIDTH + 2 * SHELL_ORIGIN_X) * scale, SHELL_HEIGHT * scale);

  const name = state.tableId === null ? "" : shellTableFor(state.tableId).name;
  if (skin === null) {
    text(ctx, scale, 160, LOADING_INK_TOP, "LOADING", SHELL_TEXT, FONT_BIG, "center");
    text(ctx, scale, 160, 150, name, SHELL_DIM, FONT_SMALL, "center");
    return;
  }

  // The disk's own strip: 320 x 16, full screen width, so it lands at shell x 0
  // and needs no centring of its own — the ink is already where the film puts it.
  const logo = skin.loadingLogo();
  const logoTop = skin.loadingLogoTop();
  if (logo !== null && logoTop !== null) {
    ctx.drawImage(
      logo,
      0,
      0,
      LOADING_LOGO_WIDTH,
      LOADING_LOGO_HEIGHT,
      px(0, scale),
      py(logoTop, scale),
      LOADING_LOGO_WIDTH * scale,
      LOADING_LOGO_HEIGHT * scale,
    );
    const nameTop = logoTop + LOADING_LOGO_HEIGHT + LOADING_NAME_GAP;
    glyphs(ctx, skin, "font2", scale, 160, nameTop, name, SKIN_DIM, "center");
    return;
  }

  // Cap height 19 against the logo's 16 rows of ink: one row up puts the block
  // on the same centre line as the original's.
  glyphs(ctx, skin, "font1", scale, 160, LOADING_INK_TOP - 2, "Loading", SKIN_WHITE, "center");
  glyphs(ctx, skin, "font2", scale, 160, 150, name, SKIN_DIM, "center");
}

/**
 * The table would not load.
 *
 * A screen the original has no equivalent of — an Amiga that could not read a
 * floppy said so through the OS, and a browser that cannot fetch an asset has to
 * say so itself. Chrome only: the frame, the ring and the ink are the measured
 * ones so it belongs to the same shell; everything it says is this file's.
 */
function drawFailed(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  clear(ctx, scale, skin);
  if (skin === null) {
    frame(ctx, scale);
    text(ctx, scale, 160, 100, "THE TABLE WOULD NOT LOAD", SHELL_HIGHLIGHT, FONT_SMALL, "center");
    text(ctx, scale, 160, 120, state.error ?? "", SHELL_TEXT, FONT_TINY, "center");
    text(ctx, scale, 160, 150, "PRESS ESC", SHELL_DIM, FONT_SMALL, "center");
    return;
  }
  frame(ctx, scale, SKIN_WHITE);
  glyphs(ctx, skin, "font1", scale, 160, 104, "The table", SKIN_WHITE, "center");
  glyphs(ctx, skin, "font1", scale, 160, 134, "would not load", SKIN_WHITE, "center");
  glyphs(ctx, skin, "font2", scale, 160, 176, state.error ?? "", SKIN_DIM, "center");
  glyphs(ctx, skin, "font2", scale, 160, HINT_Y, "PRESS ESC", SKIN_DIM, "center");
}

// ---------------------------------------------------------------------------
// The cards that sit over the playfield
// ---------------------------------------------------------------------------

/** One line of a card: text, colour, and which font carries it. */
interface CardLine {
  readonly value: string;
  readonly colour: string;
  readonly size: number;
  /** Skinned rendering: the big menu font or the small one. */
  readonly font: SkinFontKey;
  /** Skinned colour; the fallback uses `colour`. */
  readonly skinColour?: string;
}

/**
 * A card over the frozen table.
 *
 * The in-game screens are not full-screen takeovers in the original either — the
 * playfield is still there underneath, which is what makes "REALLY QUIT TABLE?"
 * read as a question about the table you are looking at.
 *
 * WHAT THE FILM SAYS, AND WHAT IT DOES NOT. The census caught "GAME OVER", the
 * high-score roll, the copyright text and "REALLY QUIT TABLE?" — all four of
 * them as DMD messages on the 320 x 16 score panel over a live playfield, and
 * NONE of them as a shell page. So the structure below is right and the card is
 * not: a five-row ladder does not fit in sixteen rows of dot matrix, and this
 * reconstruction's panel does not carry a message queue deep enough to roll one
 * a line at a time. The card is therefore this file's own answer, drawn in the
 * shell's measured white on a dark panel so it reads over any of the three
 * playfields. Its coordinates are not the original's and are not claimed to be.
 */
function card(
  ctx: ShellContext,
  scale: number,
  skin: ShellSkin | null,
  top: number,
  height: number,
  lines: readonly CardLine[],
): void {
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = SHELL_PANEL;
  ctx.fillRect(px(20, scale), py(top, scale), 280 * scale, height * scale);
  ctx.globalAlpha = 1;
  box(ctx, scale, 20, top, 299, top + height - 1, skin === null ? SHELL_FRAME : SKIN_WHITE, null);

  // 26, not the 20 this used to be: the big font is 19 rows tall and a 20-row
  // pitch left the line under it touching the descenders.
  const pitch = 26;
  const block = (lines.length - 1) * pitch;
  // Floored: a glyph blitted to a half pixel is a blurred glyph.
  let y = Math.floor(top + (height - block) / 2) - 7;
  for (const item of lines) {
    if (skin === null) {
      text(ctx, scale, 160, y, item.value, item.colour, item.size, "center");
    } else {
      glyphs(ctx, skin, item.font, scale, 160, y, item.value, item.skinColour ?? SKIN_WHITE, "center");
    }
    y += pitch;
  }
}

function drawQuitConfirm(ctx: ShellContext, scale: number, skin: ShellSkin | null): void {
  card(ctx, scale, skin, 88, 80, [
    { value: "REALLY QUIT TABLE?", colour: SHELL_HIGHLIGHT, size: FONT_BIG, font: "font1" },
    { value: "Y QUITS - ANY OTHER KEY PLAYS ON", colour: SHELL_TEXT, size: FONT_TINY, font: "font2", skinColour: SKIN_DIM },
  ]);
}

function drawGameOver(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  card(ctx, scale, skin, 88, 80, [
    { value: "GAME OVER", colour: SHELL_HIGHLIGHT, size: FONT_BIG, font: "font1" },
    { value: formatScore(state.finalScore), colour: SHELL_TEXT, size: FONT_SMALL, font: "font1" },
  ]);
}

function drawFanfare(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  // The player digit is the original's own patch: `move.b d0,$48DB` writes
  // the player number into "PLAYER n GOT A" (main.seg00 +0x0046B4), counting
  // 1 up across the game-over walk. One player is the "PLAYER 1" this card
  // always printed.
  card(ctx, scale, skin, 80, 96, [
    { value: `PLAYER ${state.scoringPlayer} GOT A`, colour: SHELL_TEXT, size: FONT_SMALL, font: "font2" },
    { value: "HIGHSCORE", colour: SHELL_HIGHLIGHT, size: FONT_BIG, font: "font1" },
    { value: `${state.place + 1}${["ST", "ND", "RD", "TH", "TH"][state.place] ?? "TH"} PLACE`, colour: SHELL_TEXT, size: FONT_SMALL, font: "font2" },
  ]);
}

/**
 * The name box.
 *
 * The original draws "PLAYER n" / "ENTER YOUR NAME" / "(   )" and types the
 * three characters straight into the buffer sitting between those parentheses,
 * at 0x4920. There is no on-screen keyboard: the strings "1234567890",
 * "QWERTYUIOP", "ASDFGHJKL" and "ZXCVBNM" in the binary are the 128-byte
 * rawkey-to-ASCII table at 0x492E, not a picture of a keyboard.
 */
function drawInitials(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  const typed = state.initials.padEnd(3, " ");
  const caret = state.initials.length < 3 && (state.frameTicks >> 4) % 2 === 0;
  const shown = typed
    .split("")
    .map((c, i) => (caret && i === state.initials.length ? "_" : c))
    .join(" ");
  card(ctx, scale, skin, 76, 104, [
    // The same patched digit over the name box: `move.b d0,$4905` (+0x0046BA).
    { value: `PLAYER ${state.scoringPlayer}`, colour: SHELL_TEXT, size: FONT_SMALL, font: "font2" },
    { value: "ENTER YOUR NAME", colour: SHELL_TEXT, size: FONT_SMALL, font: "font2" },
    { value: `( ${shown} )`, colour: SHELL_HIGHLIGHT, size: FONT_BIG, font: "font1" },
    { value: "BACKSPACE DELETES - RETURN ACCEPTS", colour: SHELL_DIM, size: FONT_TINY, font: "font2", skinColour: SKIN_DIM },
  ]);
}

/**
 * The table's own attract screen: in-game state 0, at 0x42A2.
 *
 * The original cycles GAME OVER, then each player's score, then the five-line
 * ladder a line at a time. This shows the whole ladder at once, which is the
 * same information without three seconds a line, and keeps the two keys the
 * original has here: start a game, or leave the table. GAME OVER and the score
 * are set in the big font, which is the font the original's own cycle shows
 * them in; the ladder is the small font's, whose advances are the template's
 * own column arithmetic.
 *
 * Like the other cards, the original puts every line of this on the DMD panel
 * rather than on a page — see `card` — so the panel is this file's, in the
 * shell's measured white, and its coordinates are not claimed as the disk's.
 */
function drawLadder(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = SHELL_PANEL;
  ctx.fillRect(px(16, scale), py(24, scale), 288 * scale, 208 * scale);
  ctx.globalAlpha = 1;
  box(ctx, scale, 16, 24, 303, 231, skin === null ? SHELL_FRAME : SKIN_WHITE, null);

  const name = state.tableId === null ? "" : shellTableFor(state.tableId).name;
  if (skin === null) {
    text(ctx, scale, 160, 34, name, SHELL_DIM, FONT_SMALL, "center");
    text(ctx, scale, 160, 50, "GAME OVER", SHELL_HIGHLIGHT, FONT_BIG, "center");
    text(ctx, scale, 160, 74, formatScore(state.finalScore), SHELL_TEXT, FONT_SMALL, "center");
    text(ctx, scale, 160, 100, "HIGH SCORES", SHELL_DIM, FONT_SMALL, "center");
  } else {
    glyphs(ctx, skin, "font2", scale, 160, 32, name, SKIN_DIM, "center");
    glyphs(ctx, skin, "font1", scale, 160, 44, "GAME OVER", SKIN_WHITE, "center");
    glyphs(ctx, skin, "font1", scale, 160, 70, formatScore(state.finalScore), SKIN_WHITE, "center");
    glyphs(ctx, skin, "font2", scale, 160, 100, "HIGH SCORES", SKIN_DIM, "center");
  }
  ladderBlock(ctx, scale, skin, state.ladder, 60, 260, 118, 18, FONT_SMALL, state.place);

  if (skin === null) {
    text(ctx, scale, 160, 210, "ENTER STARTS A GAME", SHELL_HIGHLIGHT, FONT_SMALL, "center");
    text(ctx, scale, 160, 222, "ESC LEAVES THE TABLE", SHELL_DIM, FONT_TINY, "center");
  } else {
    glyphs(ctx, skin, "font2", scale, 160, 210, "ENTER STARTS A GAME", SKIN_WHITE, "center");
    glyphs(ctx, skin, "font2", scale, 160, 221, "ESC LEAVES THE TABLE", SKIN_DIM, "center");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * True when this phase draws the playfield underneath itself.
 *
 * The host uses it to decide whether to render the game first: everything that
 * belongs to a loaded table sits over that table, and everything that belongs to
 * the shell replaces it entirely.
 */
export function shellDrawsOverPlayfield(state: ShellState): boolean {
  switch (state.phase) {
    case "play":
    case "quit-confirm":
    case "game-over":
    case "fanfare":
    case "initials":
    case "ladder":
      return true;
    default:
      return false;
  }
}

/**
 * Draws whichever screen the shell is on.
 *
 * `skin` is the decoded `menudata.bin` presentation, or null to fall back to
 * the browser-font placeholder. A no-op for `play`, which is the game's own
 * frame and nothing else — the caller has already drawn it.
 */
export function renderShell(
  ctx: ShellContext,
  state: ShellState,
  scale: number,
  artwork: ShellArtworkSource,
  skin: ShellSkin | null = null,
): void {
  switch (state.phase) {
    case "attract":
      drawAttract(ctx, scale, state, skin);
      return;
    case "menu":
      drawMenu(ctx, scale, state, skin);
      return;
    case "select":
      drawSelect(ctx, scale, state, artwork, skin);
      return;
    case "info":
      drawInfo(ctx, scale, state, artwork, skin);
      return;
    case "loading":
      drawLoading(ctx, scale, state, skin);
      return;
    case "failed":
      drawFailed(ctx, scale, state, skin);
      return;
    case "play":
      return;
    case "quit-confirm":
      drawQuitConfirm(ctx, scale, skin);
      return;
    case "game-over":
      drawGameOver(ctx, scale, state, skin);
      return;
    case "fanfare":
      drawFanfare(ctx, scale, state, skin);
      return;
    case "initials":
      drawInitials(ctx, scale, state, skin);
      return;
    case "ladder":
      drawLadder(ctx, scale, state, skin);
      return;
  }
}
