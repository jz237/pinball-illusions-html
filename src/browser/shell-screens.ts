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
 * The drawing language is the original's too. `main.bin` interprets a
 * big-endian opcode stream: 0x0001 LINE(x1,y1,x2,y2), 0x0002 TEXT(x, y, asciiz)
 * and 0x0003 end of page, with an alignment word choosing left, right or centred
 * on x. `line`, `box` and `text` below are those three primitives; everything
 * else in the file is a page written in them.
 *
 * WHAT IS THE DISK'S AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * When the host has loaded the exported shell artwork (`ShellSkin` non-null),
 * the presentation is `menudata.bin`'s own:
 *
 *   - both proportional FONTS — the 19-px two-plane menu font and the small
 *     single-plane font — drawn glyph by glyph on the disk's own advance,
 *     height and y-offset metrics, outline pass under fill pass exactly as the
 *     blitter ORs them;
 *   - the three BACKDROP strips: eight 32-row bands, each showing a 320-px
 *     window into the 1472 x 32 strip of that screen's tumbling object
 *     (rings for attract, cubes for the menu, crosses for table select),
 *     wobbled by the disk's own ±64 sine table on the copper's indexing —
 *     10 per band, 1 per tick;
 *   - the shared 16-colour palette, whose colour 0 is the 0x36A blue;
 *   - the original's own 16 x 16 dissolve order for the info screen's picture.
 *
 * Not the disk's, even skinned: the text COLOUR registers (menudata carries
 * only the backdrop palette; white fill over black outline follows the glyph
 * plane semantics and the fade table's white text entries, amber accents are
 * this reconstruction's), the attract PAGE TEXT (the original's nineteen pages
 * are the developers' own credit and greeting prose, which does not ship; the
 * pages here are written fresh and set in the decoded font at the decoded
 * pitch), and the hint lines naming keys, which the original never needed.
 *
 * Without the skin — assets still fetching, or fetch failed — every screen
 * falls back to the browser-font placeholder rendering, so the shell is never
 * blank.
 */

import {
  SHELL_BACKDROP,
  SHELL_BAND,
  SHELL_DIM,
  SHELL_FRAME,
  SHELL_HIGHLIGHT,
  SHELL_HIGHLIGHT_FILL,
  SHELL_PANEL,
  SHELL_TEXT,
  SURROUND,
} from "./palette.js";
import {
  ATTRACT_PAGES,
  MENU_ITEMS,
  SHELL_TABLES,
  highlightedTable,
  shellTableFor,
} from "./shell.js";
import type { ShellState } from "./shell.js";
import type { ShellSkin, SkinFontKey } from "./shell-skin.js";
import { FONT_ATLAS_WIDTH, alignShellText } from "../game/shell-art.js";
import type { ShellFont } from "../game/shell-art.js";
import type { HighScoreEntry } from "../game/high-scores.js";
import type { TableId } from "../game/contracts.js";

// ---------------------------------------------------------------------------
// The 320 x 256 box
// ---------------------------------------------------------------------------

export const SHELL_WIDTH = 320;
export const SHELL_HEIGHT = 256;
/** The reconstruction's window is 336 wide; the shell is centred in it. */
export const SHELL_ORIGIN_X = 8;

/** The three fallback fonts, as logical pixel heights on the original's pitches. */
const FONT_BIG = 14;
const FONT_SMALL = 9;
const FONT_TINY = 7;

const FONT_STACK = "ui-monospace, 'DejaVu Sans Mono', 'Courier New', monospace";

/**
 * Skin text colours. White is the measured choice — the fade table's text
 * entries are all 0xFFF — and the outline is always black. Amber is kept for
 * the one job the placeholder already used it for: marking the freshly-earned
 * ladder row. The register values the original loads for its text planes are
 * the decode's one open question, so these are stated as choices, not facts.
 */
const SKIN_WHITE = "#ffffff";
const SKIN_DIM = "#9ab6d4";
const SKIN_AMBER = "#f7c948";

/** Eight 32-row bands: the original's own division of the 256-row screen. */
const BAND_HEIGHT = 32;
const BAND_COUNT = SHELL_HEIGHT / BAND_HEIGHT;

/**
 * Where the 320-px window sits in the 1472-px strip before the sine wobble.
 * Centred: (1472 - 320) / 2. The wobble is ±64, so the window stays inside the
 * strip and never needs to wrap.
 */
const STRIP_BASE_X = 576;

/** The copper's sine indexing: 10 per band, 1 per tick. */
const SINE_STEP_PER_BAND = 10;

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
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  imageSmoothingEnabled: boolean;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
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

function line(
  ctx: ShellContext,
  scale: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  colour: string,
): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1, Math.round(scale));
  ctx.beginPath();
  ctx.moveTo(px(x1, scale), py(y1, scale));
  ctx.lineTo(px(x2, scale), py(y2, scale));
  ctx.stroke();
}

/**
 * One of the shell's boxes.
 *
 * The original emits every box twice with a different separator word between
 * the two polylines — a bevel pass — which is why a menu button has an edge
 * rather than a hairline. Here the second pass is a fill, which is what carries
 * the highlight.
 */
function box(
  ctx: ShellContext,
  scale: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  colour: string,
  fill: string | null,
): void {
  const left = px(x1, scale);
  const top = py(y1, scale);
  const width = (x2 - x1) * scale;
  const height = (y2 - y1) * scale;
  if (fill !== null) {
    ctx.fillStyle = fill;
    ctx.fillRect(left, top, width, height);
  }
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1, Math.round(scale));
  ctx.strokeRect(left, top, width, height);
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
 * low). Centring and right-alignment are the original's integer arithmetic in
 * `alignShellText`. Two passes — outlines, then fills — reproduce the
 * blitter's OR compositing; see `SkinFontLayer` in shell-skin.ts.
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
  const startPen = alignShellText(data, value, x, align);
  ctx.imageSmoothingEnabled = false;
  for (const layer of ["outline", "fill"] as const) {
    const atlas = skin.fontAtlas(font, layer, colour);
    let pen = startPen;
    for (let i = 0; i < value.length; i += 1) {
      const glyph = data.glyphs[value.charCodeAt(i)];
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
}

/**
 * The decoded backdrop: eight 32-row bands, each a 320-px window into that
 * screen's 1472 x 32 tumbling-object strip, offset by the disk's own sine
 * table with the copper's indexing — the band number times 10, plus the tick.
 * A pure function of the tick, so two runs at the same tick draw the same
 * frame.
 */
function skinBands(
  ctx: ShellContext,
  skin: ShellSkin,
  role: "attract" | "menu" | "select",
  scale: number,
  tick: number,
): void {
  const strip = skin.backdrop(role);
  const sine = skin.art.sine;
  ctx.imageSmoothingEnabled = false;
  for (let band = 0; band < BAND_COUNT; band += 1) {
    const wobble = sine[(tick + band * SINE_STEP_PER_BAND) & 0xff] ?? 0;
    ctx.drawImage(
      strip,
      STRIP_BASE_X + wobble,
      0,
      SHELL_WIDTH,
      BAND_HEIGHT,
      px(0, scale),
      py(band * BAND_HEIGHT, scale),
      SHELL_WIDTH * scale,
      BAND_HEIGHT * scale,
    );
  }
}

/** The screen frame: four lines, (15,15)-(304,240) — table select's border. */
function frame(ctx: ShellContext, scale: number, colour: string = SHELL_FRAME): void {
  line(ctx, scale, 15, 15, 304, 15, colour);
  line(ctx, scale, 15, 240, 304, 240, colour);
  line(ctx, scale, 15, 15, 15, 240, colour);
  line(ctx, scale, 304, 15, 304, 240, colour);
}

/** Clears the whole canvas, including the eight pixels either side of the box. */
function clear(ctx: ShellContext, scale: number, skin: ShellSkin | null): void {
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.fillStyle = SURROUND;
  ctx.fillRect(0, 0, (SHELL_WIDTH + 2 * SHELL_ORIGIN_X) * scale, SHELL_HEIGHT * scale);
  ctx.fillStyle = skin === null ? SHELL_BACKDROP : skin.background;
  ctx.fillRect(px(0, scale), py(0, scale), SHELL_WIDTH * scale, SHELL_HEIGHT * scale);
}

/**
 * The fallback bands: eight scrolling stripes standing in for the strips when
 * the artwork has not arrived. Deterministic in the tick, like the real thing.
 */
function bands(ctx: ShellContext, scale: number, tick: number): void {
  const cell = 16;
  ctx.save();
  ctx.beginPath();
  ctx.rect(px(0, scale), py(0, scale), SHELL_WIDTH * scale, SHELL_HEIGHT * scale);
  ctx.clip();
  ctx.fillStyle = SHELL_BAND;
  for (let band = 0; band < BAND_COUNT; band += 1) {
    const speed = band % 2 === 0 ? 1 : -1;
    const drift = (tick * (band + 2) * speed) / 8;
    const phase = ((drift % (cell * 2)) + cell * 2) % (cell * 2);
    const top = band * BAND_HEIGHT;
    for (let x = -cell * 2; x < SHELL_WIDTH + cell * 2; x += cell * 2) {
      const left = x + phase;
      ctx.fillRect(px(left, scale), py(top + 8, scale), cell * scale, (BAND_HEIGHT - 16) * scale);
    }
  }
  ctx.restore();
}

/** Backdrop for one of the three menu screens: the real strip, or the stand-in. */
function backdrop(
  ctx: ShellContext,
  scale: number,
  skin: ShellSkin | null,
  role: "attract" | "menu" | "select",
  tick: number,
): void {
  clear(ctx, scale, skin);
  if (skin === null) bands(ctx, scale, tick);
  else skinBands(ctx, skin, role, scale, tick);
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
  box(ctx, scale, x, y, x + width, y + height, skin === null ? SHELL_FRAME : SKIN_WHITE, SHELL_PANEL);
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
 * Skinned: the page's lines in the big font, centred on x = 160 on the
 * original's own y ladder — 30-pixel pitch centred between 104 and 134, which
 * is where its six-line pages put y = 44..194 and its two-line pages 104/134 —
 * over the tumbling-rings strip. No border: the original's attract pages have
 * none. The text itself is written fresh (see the header); the hint lines at
 * the bottom are the reconstruction's, in the small font.
 */
function drawAttract(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  const tick = state.attractTicks + state.attractPage * 64;
  backdrop(ctx, scale, skin, "attract", tick);

  const page = ATTRACT_PAGES[state.attractPage] ?? [];
  const lines = page.length;
  if (skin === null) {
    frame(ctx, scale);
    const middle = 119;
    const top = middle - ((lines - 1) * 30) / 2 - 15;
    for (let i = 0; i < lines; i += 1) {
      const value = page[i];
      if (value === undefined) continue;
      text(ctx, scale, 160, top + i * 30, value, i === 0 ? SHELL_HIGHLIGHT : SHELL_TEXT, FONT_BIG, "center");
    }
    text(ctx, scale, 160, 214, "PRESS SPACE", SHELL_HIGHLIGHT, FONT_SMALL, "center");
    text(ctx, scale, 160, 226, "F1-F3 GOES STRAIGHT TO A TABLE", SHELL_DIM, FONT_TINY, "center");
    return;
  }

  // The decoded ladder: 44, 74, 104, ... — i.e. 119 - 15*(lines-1) at pitch 30.
  const top = 119 - 15 * (lines - 1);
  for (let i = 0; i < lines; i += 1) {
    const value = page[i];
    if (value === undefined) continue;
    glyphs(ctx, skin, "font1", scale, 160, top + i * 30, value, SKIN_WHITE, "center");
  }
  glyphs(ctx, skin, "font2", scale, 160, 226, "PRESS SPACE", SKIN_WHITE, "center");
  glyphs(ctx, skin, "font2", scale, 160, 240, "F1-F3 GOES STRAIGHT TO A TABLE", SKIN_DIM, "center");
}

/**
 * The main menu. Two items and only two: display list 0xCF3C — centred
 * "Tables" at (160,90) and centred "Exit" at (160,133), with the highlight
 * rectangles at 0xCF58 — (120,83)-(200,115) and (120,126)-(200,158) — around
 * whichever the cursor is on. Skinned it is exactly that over the cubes strip;
 * the fallback adds a title and boxes both items because a placeholder needs
 * more signposting than the real artwork does.
 */
function drawMenu(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  backdrop(ctx, scale, skin, "menu", state.frameTicks);

  // Highlight rectangles from 0xCF58, text at the display list's own y.
  const rects = [
    { x1: 120, y1: 83, x2: 200, y2: 115, textY: 90 },
    { x1: 120, y1: 126, x2: 200, y2: 158, textY: 133 },
  ];

  if (skin === null) {
    frame(ctx, scale);
    text(ctx, scale, 160, 40, "PINBALL ILLUSIONS", SHELL_HIGHLIGHT, FONT_BIG, "center");
    for (let i = 0; i < rects.length; i += 1) {
      const rect = rects[i];
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
    text(ctx, scale, 160, 200, "UP/DOWN CHOOSE   SPACE SELECTS   ESC BACK", SHELL_DIM, FONT_TINY, "center");
    return;
  }

  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    const label = MENU_ITEMS[i];
    if (rect === undefined || label === undefined) continue;
    if (state.menuCursor === i) {
      box(ctx, scale, rect.x1, rect.y1, rect.x2, rect.y2, SKIN_WHITE, null);
    }
    glyphs(ctx, skin, "font1", scale, 160, rect.textY, label, SKIN_WHITE, "center");
  }
  glyphs(ctx, skin, "font2", scale, 160, 226, "UP/DOWN CHOOSE   SPACE SELECTS   ESC BACK", SKIN_DIM, "center");
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
 */
function drawSelect(
  ctx: ShellContext,
  scale: number,
  state: ShellState,
  artwork: ShellArtworkSource,
  skin: ShellSkin | null,
): void {
  backdrop(ctx, scale, skin, "select", state.frameTicks);

  const skinned = skin !== null;
  const focusColour = skinned ? SKIN_WHITE : SHELL_HIGHLIGHT;
  const idleColour = skinned ? SKIN_DIM : SHELL_FRAME;

  frame(ctx, scale, skinned ? SKIN_WHITE : SHELL_FRAME);
  if (skin === null) {
    text(ctx, scale, 160, 30, "SELECT A TABLE", SHELL_HIGHLIGHT, FONT_SMALL, "center");
  }

  box(
    ctx,
    scale,
    20,
    111,
    218,
    143,
    state.column === 0 ? focusColour : idleColour,
    !skinned && state.column === 0 ? SHELL_HIGHLIGHT_FILL : null,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(px(18, scale), py(22, scale), 202 * scale, (214 - 22) * scale);
  ctx.clip();
  for (let i = 0; i < SHELL_TABLES.length; i += 1) {
    const table = SHELL_TABLES[i];
    if (table === undefined) continue;
    const y = 118 - 32 * state.cursor + 32 * i;
    if (y < 22 || y > 214) continue;
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
    228,
    111,
    300,
    143,
    state.column === 1 ? focusColour : idleColour,
    !skinned && state.column === 1 ? SHELL_HIGHLIGHT_FILL : null,
  );
  if (skin === null) {
    text(ctx, scale, 264, 118, "Info", state.column === 1 ? SHELL_HIGHLIGHT : SHELL_TEXT, FONT_BIG, "center");
  } else {
    glyphs(ctx, skin, "font1", scale, 264, 118, "Info", SKIN_WHITE, "center");
  }

  thumbnail(ctx, scale, skin, artwork, highlightedTable(state).id, 238, 20, 52, 84, null);

  // Below y = 214, which is where the original clips the scrolling list: the
  // third name sits at y = 182 when the cursor is on the first, so anything
  // higher than this would be printed over it.
  const action = state.column === 0 ? "SPACE PLAYS THIS TABLE" : "SPACE SHOWS THE INFO SCREEN";
  if (skin === null) {
    text(ctx, scale, 160, 216, action, SHELL_TEXT, FONT_SMALL, "center");
    text(ctx, scale, 160, 229, "UP/DOWN   LEFT/RIGHT   SPACE   ESC", SHELL_DIM, FONT_TINY, "center");
  } else {
    glyphs(ctx, skin, "font2", scale, 160, 218, action, SKIN_WHITE, "center");
    glyphs(ctx, skin, "font2", scale, 160, 229, "UP/DOWN   LEFT/RIGHT   SPACE   ESC", SKIN_DIM, "center");
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
 */
function drawInfo(
  ctx: ShellContext,
  scale: number,
  state: ShellState,
  artwork: ShellArtworkSource,
  skin: ShellSkin | null,
): void {
  clear(ctx, scale, skin);

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
      text(ctx, scale, 16, 232, "Press ESC to exit.", SHELL_DIM, FONT_SMALL);
    } else {
      glyphs(ctx, skin, "font2", scale, 16, 160, "HIGH SCORES", SKIN_WHITE);
      glyphs(ctx, skin, "font2", scale, 16, 232, "Press ESC to exit.", SKIN_DIM);
    }
  }
}

function drawLoading(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  clear(ctx, scale, skin);
  const name = state.tableId === null ? "" : shellTableFor(state.tableId).name;
  if (skin === null) {
    frame(ctx, scale);
    text(ctx, scale, 160, 110, "LOADING", SHELL_DIM, FONT_SMALL, "center");
    text(ctx, scale, 160, 128, name, SHELL_HIGHLIGHT, FONT_BIG, "center");
    return;
  }
  frame(ctx, scale, SKIN_WHITE);
  glyphs(ctx, skin, "font2", scale, 160, 104, "LOADING", SKIN_DIM, "center");
  glyphs(ctx, skin, "font1", scale, 160, 118, name, SKIN_WHITE, "center");
}

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
  glyphs(ctx, skin, "font1", scale, 160, 90, "THE TABLE", SKIN_WHITE, "center");
  glyphs(ctx, skin, "font1", scale, 160, 114, "WOULD NOT LOAD", SKIN_WHITE, "center");
  glyphs(ctx, skin, "font2", scale, 160, 144, state.error ?? "", SKIN_DIM, "center");
  glyphs(ctx, skin, "font2", scale, 160, 170, "PRESS ESC", SKIN_WHITE, "center");
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
  box(ctx, scale, 20, top, 300, top + height, skin === null ? SHELL_FRAME : SKIN_WHITE, null);

  const pitch = 20;
  const block = (lines.length - 1) * pitch;
  let y = top + (height - block) / 2 - 7;
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
  card(ctx, scale, skin, 80, 96, [
    { value: "PLAYER 1 GOT A", colour: SHELL_TEXT, size: FONT_SMALL, font: "font2" },
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
    { value: "PLAYER 1", colour: SHELL_TEXT, size: FONT_SMALL, font: "font2" },
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
 */
function drawLadder(ctx: ShellContext, scale: number, state: ShellState, skin: ShellSkin | null): void {
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = SHELL_PANEL;
  ctx.fillRect(px(16, scale), py(24, scale), 288 * scale, 208 * scale);
  ctx.globalAlpha = 1;
  box(ctx, scale, 16, 24, 304, 232, skin === null ? SHELL_FRAME : SKIN_WHITE, null);

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
