/**
 * Drawing the shell.
 *
 * Every coordinate below is the original's, read off the display lists in
 * `main.bin` hunk 0 and used unchanged. The original's shell screens are
 * 320 x 256; this reconstruction's window is 336 x 256, because that is the
 * playfield's width, so the shell is drawn into a 320-wide box centred in it —
 * eight pixels of surround each side, and not one coordinate moved.
 *
 * The drawing language is the original's too. `main.bin` interprets a
 * big-endian opcode stream: 0x0001 LINE(x1,y1,x2,y2), 0x0002 TEXT(x, y, asciiz)
 * and 0x0003 end of page, with an alignment word choosing left, right or centred
 * on x. `line`, `box` and `text` below are those three primitives; everything
 * else in the file is a page written in them.
 *
 * WHAT IS NOT THE DISK'S
 * ---------------------------------------------------------------------------
 * The COLOURS (see `palette.ts`) and the FONTS. The original has two proportional
 * bitmap fonts in `menudata.bin` — 16 px wide, two bitplanes, line-interleaved,
 * with a 128-entry metrics table each. Neither is exported, so this draws with
 * the browser's own monospace at the original's line pitches. The one place a
 * metric leaks through is the ladder block on the info screen: the original
 * computes its right-aligned score column as `300 - (3*commas + 7*digits)`,
 * which is where the small font's 7 px digit and 3 px comma advances come from,
 * and here the same block is simply right-aligned on 300 — the same result by a
 * method the canvas already has.
 *
 * The attract backdrop is a stand-in and says so. The original runs a 320 x 256
 * dual playfield whose lower layer is eight 32-row bands, each pointing at a
 * different horizontal offset into a 1472 x 32 strip of 46 pre-rendered frames
 * of a tumbling solid, wobbled by a sine table and cross-faded through nine
 * palette windows. None of that data is exported; eight scrolling bands are what
 * is left of the idea once the artwork is gone.
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
import type { HighScoreEntry } from "../game/high-scores.js";
import type { TableId } from "../game/contracts.js";

// ---------------------------------------------------------------------------
// The 320 x 256 box
// ---------------------------------------------------------------------------

export const SHELL_WIDTH = 320;
export const SHELL_HEIGHT = 256;
/** The reconstruction's window is 336 wide; the shell is centred in it. */
export const SHELL_ORIGIN_X = 8;

/** The three fonts, as logical pixel heights on the original's line pitches. */
const FONT_BIG = 14;
const FONT_SMALL = 9;
const FONT_TINY = 7;

const FONT_STACK = "ui-monospace, 'DejaVu Sans Mono', 'Courier New', monospace";

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

/** The screen frame: four lines, (15,15)-(304,240). */
function frame(ctx: ShellContext, scale: number): void {
  line(ctx, scale, 15, 15, 304, 15, SHELL_FRAME);
  line(ctx, scale, 15, 240, 304, 240, SHELL_FRAME);
  line(ctx, scale, 15, 15, 15, 240, SHELL_FRAME);
  line(ctx, scale, 304, 15, 304, 240, SHELL_FRAME);
}

/** Clears the whole canvas, including the eight pixels either side of the box. */
function clear(ctx: ShellContext, scale: number): void {
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.fillStyle = SURROUND;
  ctx.fillRect(0, 0, (SHELL_WIDTH + 2 * SHELL_ORIGIN_X) * scale, SHELL_HEIGHT * scale);
  ctx.fillStyle = SHELL_BACKDROP;
  ctx.fillRect(px(0, scale), py(0, scale), SHELL_WIDTH * scale, SHELL_HEIGHT * scale);
}

/**
 * The eight scrolling bands. A stand-in for the tumbling-object strips; see the
 * file header.
 *
 * Eight bands of 32 rows is the original's own division of the 256-row screen,
 * and each band scrolls at its own rate because in the original each one points
 * at a different offset into the strip and the offsets are driven by a sine
 * table. Every band's phase is a function of the tick, so two runs at the same
 * tick draw the same frame.
 */
function bands(ctx: ShellContext, scale: number, tick: number): void {
  const bandHeight = 32;
  const cell = 16;
  ctx.save();
  ctx.beginPath();
  ctx.rect(px(0, scale), py(0, scale), SHELL_WIDTH * scale, SHELL_HEIGHT * scale);
  ctx.clip();
  ctx.fillStyle = SHELL_BAND;
  for (let band = 0; band < SHELL_HEIGHT / bandHeight; band += 1) {
    const speed = band % 2 === 0 ? 1 : -1;
    const drift = (tick * (band + 2) * speed) / 8;
    const phase = ((drift % (cell * 2)) + cell * 2) % (cell * 2);
    const top = band * bandHeight;
    for (let x = -cell * 2; x < SHELL_WIDTH + cell * 2; x += cell * 2) {
      const left = x + phase;
      ctx.fillRect(px(left, scale), py(top + 8, scale), cell * scale, (bandHeight - 16) * scale);
    }
  }
  ctx.restore();
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
 * left-aligned at x = 180, score right-aligned at x = 300. `leftX` and `rightX`
 * are parameters only because the same block is drawn on the table's own attract
 * screen too, where it has the whole width rather than the info screen's right
 * half.
 */
function ladderBlock(
  ctx: ShellContext,
  scale: number,
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
    const colour = i === highlight ? SHELL_HIGHLIGHT : SHELL_TEXT;
    text(ctx, scale, leftX, y, `${i + 1}.${entry.initials.padEnd(3, " ")}`, colour, size);
    text(ctx, scale, rightX, y, formatScore(entry.score), colour, size, "right");
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
 * The dissolve is the original's, reproduced: `units` blocks of the 16 x 16 grid
 * are revealed per frame in a fixed scrambled order. The order is a fixed
 * deterministic permutation rather than one of the four 256-byte tables at
 * menudata h4+0x780, which are not exported either.
 */
const DISSOLVE_UNITS_PER_FRAME = 4;
const DISSOLVE_GRID = 16;

const DISSOLVE_CELLS = DISSOLVE_GRID * DISSOLVE_GRID;

/**
 * The step between successive cells, in cells.
 *
 * Coprime to 256, so walking it visits every cell exactly once and the whole
 * picture is revealed with nothing drawn twice. 97 is 6 x 16 + 1, so each step
 * lands six rows down and one column across — a scatter rather than a raster,
 * which is the point of a dissolve. No random source anywhere: two runs at the
 * same frame count reveal exactly the same blocks.
 */
const DISSOLVE_STRIDE = 97;

const DISSOLVE_ORDER: readonly number[] = Object.freeze(
  Array.from({ length: DISSOLVE_CELLS }, (_, i) => ((i + 1) * DISSOLVE_STRIDE) % DISSOLVE_CELLS),
);

function thumbnail(
  ctx: ShellContext,
  scale: number,
  artwork: ShellArtworkSource,
  tableId: TableId,
  x: number,
  y: number,
  width: number,
  height: number,
  dissolveFrames: number | null,
): void {
  box(ctx, scale, x, y, x + width, y + height, SHELL_FRAME, SHELL_PANEL);
  const image = artwork.imageFor(tableId);
  if (image === null) {
    text(ctx, scale, x + width / 2, y + height / 2 - 4, "...", SHELL_DIM, FONT_SMALL, "center");
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

  const revealed = Math.min(
    DISSOLVE_ORDER.length,
    Math.max(0, dissolveFrames) * DISSOLVE_UNITS_PER_FRAME,
  );
  const unitW = drawWidth / DISSOLVE_GRID;
  const unitH = drawHeight / DISSOLVE_GRID;
  const sourceUnitW = source.width / DISSOLVE_GRID;
  const sourceUnitH = source.height / DISSOLVE_GRID;
  for (let i = 0; i < revealed; i += 1) {
    const cell = DISSOLVE_ORDER[i];
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

/** The credits roll. Centred on x = 160 at the original's 30-pixel pitch. */
function drawAttract(ctx: ShellContext, scale: number, state: ShellState): void {
  clear(ctx, scale);
  bands(ctx, scale, state.attractTicks + state.attractPage * 64);
  frame(ctx, scale);

  const page = ATTRACT_PAGES[state.attractPage] ?? [];
  const lines = page.length;
  // The original's y ladder is 44, 74, 104, 134, 164, 194 for a six-line page
  // and 104/134 for a two-line one: the block is centred on the same middle.
  const middle = 119;
  const top = middle - ((lines - 1) * 30) / 2 - 15;
  for (let i = 0; i < lines; i += 1) {
    const value = page[i];
    if (value === undefined) continue;
    text(ctx, scale, 160, top + i * 30, value, i === 0 ? SHELL_HIGHLIGHT : SHELL_TEXT, FONT_BIG, "center");
  }

  text(ctx, scale, 160, 214, "PRESS SPACE", SHELL_HIGHLIGHT, FONT_SMALL, "center");
  text(ctx, scale, 160, 226, "F1-F3 GOES STRAIGHT TO A TABLE", SHELL_DIM, FONT_TINY, "center");
}

/** The main menu. Two items and only two: display list 0xCF3C. */
function drawMenu(ctx: ShellContext, scale: number, state: ShellState): void {
  clear(ctx, scale);
  bands(ctx, scale, state.frameTicks);
  frame(ctx, scale);

  text(ctx, scale, 160, 40, "PINBALL ILLUSIONS", SHELL_HIGHLIGHT, FONT_BIG, "center");

  // Highlight rectangles from 0xCF58: (120,83)-(200,115) and (120,126)-(200,158).
  const rects = [
    { x1: 120, y1: 83, x2: 200, y2: 115, textY: 90 },
    { x1: 120, y1: 126, x2: 200, y2: 158, textY: 133 },
  ];
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
    text(
      ctx,
      scale,
      160,
      rect.textY,
      label,
      chosen ? SHELL_HIGHLIGHT : SHELL_TEXT,
      FONT_BIG,
      "center",
    );
  }

  text(ctx, scale, 160, 200, "UP/DOWN CHOOSE   SPACE SELECTS   ESC BACK", SHELL_DIM, FONT_TINY, "center");
}

/**
 * Table select.
 *
 * The list is a vertical strip on a 32-pixel pitch whose selected entry always
 * sits at y = 118 — the original rewrites every entry's Y to
 * `118 - 32*cursor + 32*i` every frame and clips it to 22..214. The two boxes
 * are (20,111)-(218,143) around the name and (228,111)-(300,143) labelled
 * "Info", and LEFT/RIGHT move between them.
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
): void {
  clear(ctx, scale);
  bands(ctx, scale, state.frameTicks);
  frame(ctx, scale);

  text(ctx, scale, 160, 30, "SELECT A TABLE", SHELL_HIGHLIGHT, FONT_SMALL, "center");

  box(
    ctx,
    scale,
    20,
    111,
    218,
    143,
    state.column === 0 ? SHELL_HIGHLIGHT : SHELL_FRAME,
    state.column === 0 ? SHELL_HIGHLIGHT_FILL : null,
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
    text(
      ctx,
      scale,
      28,
      y,
      table.name,
      i === state.cursor ? SHELL_HIGHLIGHT : SHELL_DIM,
      FONT_BIG,
    );
  }
  ctx.restore();

  box(
    ctx,
    scale,
    228,
    111,
    300,
    143,
    state.column === 1 ? SHELL_HIGHLIGHT : SHELL_FRAME,
    state.column === 1 ? SHELL_HIGHLIGHT_FILL : null,
  );
  text(
    ctx,
    scale,
    264,
    118,
    "Info",
    state.column === 1 ? SHELL_HIGHLIGHT : SHELL_TEXT,
    FONT_BIG,
    "center",
  );

  thumbnail(ctx, scale, artwork, highlightedTable(state).id, 238, 20, 52, 84, null);

  // Below y = 214, which is where the original clips the scrolling list: the
  // third name sits at y = 182 when the cursor is on the first, so anything
  // higher than this would be printed over it.
  text(
    ctx,
    scale,
    160,
    216,
    state.column === 0 ? "SPACE PLAYS THIS TABLE" : "SPACE SHOWS THE INFO SCREEN",
    SHELL_TEXT,
    FONT_SMALL,
    "center",
  );
  text(ctx, scale, 160, 229, "UP/DOWN   LEFT/RIGHT   SPACE   ESC", SHELL_DIM, FONT_TINY, "center");
}

/**
 * The info screen. Menu state 4, at 0x157A.
 *
 * The original's layout, kept: the artwork dissolves into x 176..303, y 16..143;
 * the table's text is typed out at four characters a frame from (16,16) in the
 * small font; and the high-score ladder is typed out below it from y = 160, rank
 * and initials at x = 180 and the score right-aligned on 300.
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
): void {
  clear(ctx, scale);

  const table = highlightedTable(state);
  thumbnail(ctx, scale, artwork, table.id, 176, 16, 128, 128, state.frameTicks);

  // Four characters a frame, over the whole block, newlines included.
  const body = [table.name, "", ...table.blurb, "", `TABLE ${String(table.slot).padStart(3, "0")}`];
  const budget = state.frameTicks * 4;
  let typed = 0;
  for (let i = 0; i < body.length; i += 1) {
    const value = body[i] ?? "";
    const room = Math.max(0, budget - typed);
    const shown = value.slice(0, room);
    if (shown.length > 0) {
      text(ctx, scale, 16, 16 + i * 14, shown, i === 0 ? SHELL_HIGHLIGHT : SHELL_TEXT, FONT_SMALL);
    }
    // The newline costs a character too, which is what makes the typewriter
    // pause at the end of a line rather than run straight on.
    typed += value.length + 1;
    if (typed > budget) break;
  }

  if (budget >= typed) {
    ladderBlock(ctx, scale, state.ladder, 180, 300, 160, 16, FONT_SMALL, -1);
    text(ctx, scale, 16, 160, "HIGH SCORES", SHELL_HIGHLIGHT, FONT_SMALL);
    text(ctx, scale, 16, 232, "Press ESC to exit.", SHELL_DIM, FONT_SMALL);
  }
}

function drawLoading(ctx: ShellContext, scale: number, state: ShellState): void {
  clear(ctx, scale);
  frame(ctx, scale);
  const name = state.tableId === null ? "" : shellTableFor(state.tableId).name;
  text(ctx, scale, 160, 110, "LOADING", SHELL_DIM, FONT_SMALL, "center");
  text(ctx, scale, 160, 128, name, SHELL_HIGHLIGHT, FONT_BIG, "center");
}

function drawFailed(ctx: ShellContext, scale: number, state: ShellState): void {
  clear(ctx, scale);
  frame(ctx, scale);
  text(ctx, scale, 160, 100, "THE TABLE WOULD NOT LOAD", SHELL_HIGHLIGHT, FONT_SMALL, "center");
  text(ctx, scale, 160, 120, state.error ?? "", SHELL_TEXT, FONT_TINY, "center");
  text(ctx, scale, 160, 150, "PRESS ESC", SHELL_DIM, FONT_SMALL, "center");
}

// ---------------------------------------------------------------------------
// The cards that sit over the playfield
// ---------------------------------------------------------------------------

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
  top: number,
  height: number,
  lines: readonly { readonly value: string; readonly colour: string; readonly size: number }[],
): void {
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = SHELL_PANEL;
  ctx.fillRect(px(20, scale), py(top, scale), 280 * scale, height * scale);
  ctx.globalAlpha = 1;
  box(ctx, scale, 20, top, 300, top + height, SHELL_FRAME, null);

  const pitch = 20;
  const block = (lines.length - 1) * pitch;
  let y = top + (height - block) / 2 - 7;
  for (const item of lines) {
    text(ctx, scale, 160, y, item.value, item.colour, item.size, "center");
    y += pitch;
  }
}

function drawQuitConfirm(ctx: ShellContext, scale: number): void {
  card(ctx, scale, 88, 80, [
    { value: "REALLY QUIT TABLE?", colour: SHELL_HIGHLIGHT, size: FONT_BIG },
    { value: "Y QUITS - ANY OTHER KEY PLAYS ON", colour: SHELL_TEXT, size: FONT_TINY },
  ]);
}

function drawGameOver(ctx: ShellContext, scale: number, state: ShellState): void {
  card(ctx, scale, 88, 80, [
    { value: "GAME OVER", colour: SHELL_HIGHLIGHT, size: FONT_BIG },
    { value: formatScore(state.finalScore), colour: SHELL_TEXT, size: FONT_SMALL },
  ]);
}

function drawFanfare(ctx: ShellContext, scale: number, state: ShellState): void {
  card(ctx, scale, 80, 96, [
    { value: "PLAYER 1 GOT A", colour: SHELL_TEXT, size: FONT_SMALL },
    { value: "HIGHSCORE", colour: SHELL_HIGHLIGHT, size: FONT_BIG },
    { value: `${state.place + 1}${["ST", "ND", "RD", "TH", "TH"][state.place] ?? "TH"} PLACE`, colour: SHELL_TEXT, size: FONT_SMALL },
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
function drawInitials(ctx: ShellContext, scale: number, state: ShellState): void {
  const typed = state.initials.padEnd(3, " ");
  const caret = state.initials.length < 3 && (state.frameTicks >> 4) % 2 === 0;
  const shown = typed
    .split("")
    .map((c, i) => (caret && i === state.initials.length ? "_" : c))
    .join(" ");
  card(ctx, scale, 76, 104, [
    { value: "PLAYER 1", colour: SHELL_TEXT, size: FONT_SMALL },
    { value: "ENTER YOUR NAME", colour: SHELL_TEXT, size: FONT_SMALL },
    { value: `( ${shown} )`, colour: SHELL_HIGHLIGHT, size: FONT_BIG },
    { value: "BACKSPACE DELETES - RETURN ACCEPTS", colour: SHELL_DIM, size: FONT_TINY },
  ]);
}

/**
 * The table's own attract screen: in-game state 0, at 0x42A2.
 *
 * The original cycles GAME OVER, then each player's score, then the five-line
 * ladder a line at a time. This shows the whole ladder at once, which is the
 * same information without three seconds a line, and keeps the two keys the
 * original has here: start a game, or leave the table.
 */
function drawLadder(ctx: ShellContext, scale: number, state: ShellState): void {
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = SHELL_PANEL;
  ctx.fillRect(px(16, scale), py(24, scale), 288 * scale, 208 * scale);
  ctx.globalAlpha = 1;
  box(ctx, scale, 16, 24, 304, 232, SHELL_FRAME, null);

  const name = state.tableId === null ? "" : shellTableFor(state.tableId).name;
  text(ctx, scale, 160, 34, name, SHELL_DIM, FONT_SMALL, "center");
  text(ctx, scale, 160, 50, "GAME OVER", SHELL_HIGHLIGHT, FONT_BIG, "center");
  text(ctx, scale, 160, 74, formatScore(state.finalScore), SHELL_TEXT, FONT_SMALL, "center");

  text(ctx, scale, 160, 100, "HIGH SCORES", SHELL_DIM, FONT_SMALL, "center");
  ladderBlock(ctx, scale, state.ladder, 60, 260, 118, 18, FONT_SMALL, state.place);

  text(ctx, scale, 160, 210, "ENTER STARTS A GAME", SHELL_HIGHLIGHT, FONT_SMALL, "center");
  text(ctx, scale, 160, 222, "ESC LEAVES THE TABLE", SHELL_DIM, FONT_TINY, "center");
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
 * A no-op for `play`, which is the game's own frame and nothing else — the
 * caller has already drawn it.
 */
export function renderShell(
  ctx: ShellContext,
  state: ShellState,
  scale: number,
  artwork: ShellArtworkSource,
): void {
  switch (state.phase) {
    case "attract":
      drawAttract(ctx, scale, state);
      return;
    case "menu":
      drawMenu(ctx, scale, state);
      return;
    case "select":
      drawSelect(ctx, scale, state, artwork);
      return;
    case "info":
      drawInfo(ctx, scale, state, artwork);
      return;
    case "loading":
      drawLoading(ctx, scale, state);
      return;
    case "failed":
      drawFailed(ctx, scale, state);
      return;
    case "play":
      return;
    case "quit-confirm":
      drawQuitConfirm(ctx, scale);
      return;
    case "game-over":
      drawGameOver(ctx, scale, state);
      return;
    case "fanfare":
      drawFanfare(ctx, scale, state);
      return;
    case "initials":
      drawInitials(ctx, scale, state);
      return;
    case "ladder":
      drawLadder(ctx, scale, state);
      return;
  }
}
