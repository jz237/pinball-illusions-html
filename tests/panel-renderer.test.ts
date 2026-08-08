/**
 * The score panel: playback sequencing and pixels.
 *
 * What matters here, in order of load-bearing-ness:
 *
 *   1. PLACEMENT IS THE ORIGINAL'S ARITHMETIC. The score must land with its
 *      right edge on `$7198`'s own x = 320 — `move.w #$140,d3` — grouped in
 *      threes with commas, asserted against a synthetic font whose glyphs fill
 *      their advance exactly, so "right-aligned" is a pixel coordinate, not a
 *      vibe. The x = 300 four rounds asserted here belonged to the HIGH-SCORE
 *      LADDER's template at hunk-0 0x1836 and never to this strip; the last
 *      block in this file re-measures the whole view against native film.
 *   2. SEQUENCING IS THE DISPLAY RING'S. Queued animations play in order at
 *      their own speed dividers, ending (or holding) per frame count, and the
 *      score view returns when the queue drains. All tick-driven, all pure —
 *      the same state and ticks must give the same state back.
 *   3. NOTHING ESCAPES 320 x 16. The raster is written into a buffer with
 *      guard bytes on both sides, with frames deliberately hanging off every
 *      edge, and the guards must survive — a horizontal overrun that wraps to
 *      the next row is the classic blitter bug this catches.
 *   4. DETERMINISM LAST, because determinism alone proved nothing for the
 *      playfield renderer (see that test file's header): the pinned hashes
 *      here sit on top of the positional assertions, not instead of them.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  PANEL_HEIGHT,
  PANEL_QUEUE_CAPACITY,
  PANEL_SCORE_NARROW_FROM,
  PANEL_SCORE_RIGHT_X,
  PANEL_WIDTH,
  createPanelState,
  currentPanelFrame,
  enqueuePanelAnimation,
  formatPanelScore,
  panelIsIdle,
  renderPanel,
  renderPanelInto,
  stepPanel,
} from "../src/browser/panel-renderer.js";
import type {
  PanelAnimation,
  PanelBonusView, PanelCardView,
  PanelFrame,
  PanelState,
} from "../src/browser/panel-renderer.js";
import { BYTES_PER_PIXEL, createPixelTarget } from "../src/browser/playfield-renderer.js";
import type { PixelTarget } from "../src/browser/playfield-renderer.js";
import { PANEL_AMBER, PANEL_UNLIT, PANEL_WHITE } from "../src/browser/palette.js";
import {
  panelFace,
  panelTextPen,
  panelTextRun,
  parsePanelFontDocument,
} from "../src/game/panel-font.js";
import type { PanelFont, PanelFontDocument } from "../src/game/panel-font.js";
import {
  FONT_ATLAS_WIDTH,
  SHELL_ART_BASE_PATH,
  SHELL_ART_MANIFEST,
  loadShellArt,
  measureShellText,
  shellFontFrom,
} from "../src/game/shell-art.js";
import type { ShellFont } from "../src/game/shell-art.js";
import type { IndexedImage, TableArtFetch } from "../src/game/table-art.js";

// ---------------------------------------------------------------------------
// A synthetic font with exactly knowable pixels
// ---------------------------------------------------------------------------

const DIGIT_ADVANCE = 6;
const DIGIT_HEIGHT = 8;
const COMMA_ADVANCE = 3;

/**
 * Digits '0'..'9' are 6 px advances whose glyphs fill columns 0..5 of all 8
 * rows with the FILL bit; the comma is a 3 px advance lit in columns 0..1 of
 * its bottom three rows. Filling the advance exactly is the property the
 * alignment tests lean on: the rightmost lit pixel of a right-aligned run is
 * then `rightX - 1`, no slack. Built through `shellFontFrom` so the atlas
 * accumulation is the shipped loader's own.
 */
function syntheticFont(): ShellFont {
  const metrics: number[][] = Array.from({ length: 256 }, () => [0, 0, 0]);
  metrics[",".charCodeAt(0)] = [COMMA_ADVANCE, DIGIT_HEIGHT, 0];
  for (const c of "0123456789") {
    metrics[c.charCodeAt(0)] = [DIGIT_ADVANCE, DIGIT_HEIGHT, 0];
  }
  // The bonus captions are words, so the letters have to exist. They are added
  // AFTER the digits in code order — 'A' is 65 and '9' is 57 — and the space is
  // given no glyph rows at all, so no digit's row in the accumulated atlas
  // moves and the score view's pinned hash below still describes the same
  // pixels it always did.
  metrics[" ".charCodeAt(0)] = [COMMA_ADVANCE, 0, 0];
  for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
    metrics[code] = [DIGIT_ADVANCE, DIGIT_HEIGHT, 0];
  }
  const rows = metrics.reduce((sum, [, height = 0]) => sum + height, 0);
  const indices = new Uint8Array(FONT_ATLAS_WIDTH * rows);
  let top = 0;
  for (let code = 0; code < metrics.length; code += 1) {
    const [, height = 0] = metrics[code] ?? [];
    if (height === 0) continue;
    const comma = code === ",".charCodeAt(0);
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < (comma ? 2 : DIGIT_ADVANCE); col += 1) {
        if (comma && row < 5) continue;
        indices[(top + row) * FONT_ATLAS_WIDTH + col] = 1;
      }
    }
    top += height;
  }
  const atlas: IndexedImage = {
    width: FONT_ATLAS_WIDTH,
    height: rows,
    indices,
    palette: new Uint8Array(0),
    paletteEntries: 0,
  };
  return shellFontFrom(metrics, atlas, "synthetic");
}

const FONT = syntheticFont();

// ---------------------------------------------------------------------------
// Pixel probes
// ---------------------------------------------------------------------------

function pixelAt(target: PixelTarget, x: number, y: number): readonly [number, number, number] {
  const at = (y * target.width + x) * BYTES_PER_PIXEL;
  return [target.data[at] ?? -1, target.data[at + 1] ?? -1, target.data[at + 2] ?? -1];
}

function isUnlit(target: PixelTarget, x: number, y: number): boolean {
  const [r, g, b] = pixelAt(target, x, y);
  return r === PANEL_UNLIT[0] && g === PANEL_UNLIT[1] && b === PANEL_UNLIT[2];
}

/** Bounding box of every non-background pixel, or null for a dark panel. */
function litBounds(
  target: PixelTarget,
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < target.height; y += 1) {
    for (let x = 0; x < target.width; x += 1) {
      if (isUnlit(target, x, y)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : { minX, maxX, minY, maxY };
}

function hashOf(target: PixelTarget): string {
  return createHash("sha256").update(target.data).digest("hex");
}

function solidFrame(
  width: number,
  height: number,
  value: number,
  x = 0,
  y = 0,
): PanelFrame {
  return { width, height, pixels: new Uint8Array(width * height).fill(value), x, y };
}

function animationOf(divider: number, ...frames: PanelFrame[]): PanelAnimation {
  return { frames, speedDivider: divider };
}

/** Enqueues them all, so a test reads as the display ring it models. */
function queued(...animations: PanelAnimation[]): PanelState {
  return animations.reduce(enqueuePanelAnimation, createPanelState());
}

// ---------------------------------------------------------------------------
// The score view
// ---------------------------------------------------------------------------

describe("the score view", () => {
  it("groups digits in threes with commas, the 0x24924924 mask's shape", () => {
    expect(formatPanelScore(0)).toBe("0");
    expect(formatPanelScore(999)).toBe("999");
    expect(formatPanelScore(1000)).toBe("1,000");
    expect(formatPanelScore(1234567)).toBe("1,234,567");
    expect(formatPanelScore(12345670)).toBe("12,345,670");
  });

  it("refuses scores no BCD field could hold: negatives and fractions", () => {
    expect(() => formatPanelScore(-1)).toThrow(RangeError);
    expect(() => formatPanelScore(1.5)).toThrow(RangeError);
    expect(() => formatPanelScore(Number.NaN)).toThrow(RangeError);
  });

  it("right-aligns the score with its last pixel on the strip's own edge", () => {
    // `$7198`: `move.w #$140,d3 / move.w #$1,d6` — x = 320, ALIGN = RIGHT. The
    // 300 this used to assert is the HIGH-SCORE LADDER's column (hunk-0
    // 0x1836), a shell screen that never touches this strip.
    expect(PANEL_SCORE_RIGHT_X).toBe(320);
    const target = renderPanel(createPanelState(), 1234567, FONT);
    const bounds = litBounds(target);
    expect(bounds).not.toBeNull();
    // Synthetic digits fill their 6-px advance, so right-aligned means the
    // last lit column is exactly rightX - 1...
    expect(bounds?.maxX).toBe(PANEL_SCORE_RIGHT_X - 1);
    // ...and the first is rightX - measured width: 7 digits and 2 commas.
    const width = measureShellText(FONT, "1,234,567");
    expect(width).toBe(7 * DIGIT_ADVANCE + 2 * COMMA_ADVANCE);
    expect(bounds?.minX).toBe(PANEL_SCORE_RIGHT_X - width);
  });

  it("puts the digit block on the machine's own row 2 — the shell-font fallback", () => {
    // `move.w #$2,d4`. An eight-row font at row 2 ends at row 9 and fits the
    // sixteen-row strip, so the fallback uses the machine's row literally
    // rather than mapping it onto a half the way a caption has to be.
    const target = renderPanel(createPanelState(), 88, FONT);
    const bounds = litBounds(target);
    expect(bounds?.minY).toBe(2);
    expect(bounds?.maxY).toBe(2 + DIGIT_HEIGHT - 1);
  });

  it("draws digits in amber on the unlit glass, nothing else lit", () => {
    const target = renderPanel(createPanelState(), 7, FONT);
    // The single digit's six columns are amber...
    for (let col = 0; col < DIGIT_ADVANCE; col += 1) {
      expect(pixelAt(target, PANEL_SCORE_RIGHT_X - DIGIT_ADVANCE + col, 4)).toEqual(PANEL_AMBER);
    }
    // ...and a probe left of the run, plus the corners, are glass.
    expect(isUnlit(target, PANEL_SCORE_RIGHT_X - DIGIT_ADVANCE - 1, 4)).toBe(true);
    expect(isUnlit(target, 0, 0)).toBe(true);
    expect(isUnlit(target, PANEL_WIDTH - 1, PANEL_HEIGHT - 1)).toBe(true);
  });

  it("renders the same bytes every time: the pinned hash", () => {
    const first = renderPanel(createPanelState(), 1234567, FONT);
    const second = renderPanel(createPanelState(), 1234567, FONT);
    expect(hashOf(first)).toBe(hashOf(second));
    // Re-recorded when the score view moved from the ladder template's x=300
    // and a centred digit block to `$7198`'s own x=320 and row 2. Was
    // d53ccd8e3621427a…
    expect(hashOf(first)).toBe("3769236e2e1cde58652654f605bc37dd5999716dfa48a947583c89341583b8d2");
  });
});

// ---------------------------------------------------------------------------
// The end-of-ball bonus panel
// ---------------------------------------------------------------------------

describe("the bonus view", () => {
  const NO_BONUS: PanelBonusView = {
    caption: "NO BONUS",
    value: null,
    multiplier: "",
    multiplierLit: false,
  };

  /** Where the lit run on one row starts and ends, or null for an empty row. */
  function rowBounds(target: PixelTarget, y: number): { min: number; max: number } | null {
    let min = -1;
    let max = -1;
    for (let x = 0; x < PANEL_WIDTH; x += 1) {
      if (isUnlit(target, x, y)) continue;
      if (min < 0) min = x;
      max = x;
    }
    return min < 0 ? null : { min, max };
  }

  function renderBonus(bonus: PanelBonusView, state = createPanelState()): PixelTarget {
    return renderPanelInto(
      state,
      999_999,
      FONT,
      createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT),
      bonus,
    );
  }

  /** Left edge of a centred run, the way `$73D0`'s align 2 computes it. */
  function centredAt(text: string, x: number): number {
    return x - Math.floor(measureShellText(FONT, text) / 2);
  }

  it("centres the caption on the strip's middle, which is the record's own X", () => {
    // Every bonus text record carries X=160 with align=2 (centre); `$73D0`
    // decodes align 2 at +0x007416.
    const bounds = rowBounds(renderBonus(NO_BONUS), 3);
    expect(bounds).not.toBeNull();
    const width = measureShellText(FONT, "NO BONUS");
    expect(bounds?.min).toBe(centredAt("NO BONUS", 160));
    expect(bounds?.max).toBe(centredAt("NO BONUS", 160) + width - 1);
  });

  it("outranks the score view: the score does not show through it", () => {
    // `$6B06` clears the whole plane before every panel the routine puts up.
    expect(isUnlit(renderBonus(NO_BONUS), PANEL_SCORE_RIGHT_X - 1, 3)).toBe(true);
  });

  it("outranks a queued animation too", () => {
    const state = queued(animationOf(1, solidFrame(PANEL_WIDTH, PANEL_HEIGHT, 1)));
    const target = renderBonus(NO_BONUS, state);
    // A frame that fills the strip would light the corners; a caption does not.
    expect(isUnlit(target, 0, 0)).toBe(true);
    expect(isUnlit(target, PANEL_WIDTH - 1, PANEL_HEIGHT - 1)).toBe(true);
  });

  it("puts the figure on its own line under the caption", () => {
    const target = renderBonus({
      caption: "TOTAL BONUS",
      value: 6_000_000,
      multiplier: "",
      multiplierLit: false,
    });
    expect(rowBounds(target, 3)).not.toBeNull();
    const figure = rowBounds(target, 11);
    expect(figure).not.toBeNull();
    // Grouped exactly as the score is, because the machine draws it with the
    // same `$71BA` it draws the score with.
    expect(figure?.min).toBe(centredAt(formatPanelScore(6_000_000), 160));
  });

  it("draws the multiplier caption at x=40 and x=280, but only while it is lit", () => {
    const of = (multiplierLit: boolean): PixelTarget =>
      renderBonus({ caption: "BONUS", value: 1_500_000, multiplier: "X4", multiplierLit });
    for (const x of [40, 280]) {
      expect(isUnlit(of(true), centredAt("X4", x), 3)).toBe(false);
      expect(isUnlit(of(false), centredAt("X4", x), 3)).toBe(true);
    }
  });

  it("stays inside 320 x 16 with the longest caption and a twelve-digit figure", () => {
    const target = renderBonus({
      caption: "TOTAL BONUS",
      value: 999_999_999_999,
      multiplier: "X10",
      multiplierLit: true,
    });
    expect(target.data).toHaveLength(PANEL_WIDTH * PANEL_HEIGHT * BYTES_PER_PIXEL);
    expect(isUnlit(target, 0, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Playback: the display ring's sequencing
// ---------------------------------------------------------------------------

describe("animation playback", () => {
  it("shows an enqueued animation's first frame immediately", () => {
    const frame = solidFrame(PANEL_WIDTH, PANEL_HEIGHT, 1);
    const state = queued(animationOf(3, frame, solidFrame(PANEL_WIDTH, PANEL_HEIGHT, 2)));
    expect(panelIsIdle(state)).toBe(false);
    expect(currentPanelFrame(state)).toBe(frame);
  });

  it("advances a frame exactly every speedDivider ticks, not before", () => {
    const a = solidFrame(PANEL_WIDTH, PANEL_HEIGHT, 1);
    const b = solidFrame(PANEL_WIDTH, PANEL_HEIGHT, 2);
    let state = queued(animationOf(3, a, b));
    state = stepPanel(state, 2);
    expect(currentPanelFrame(state)).toBe(a);
    state = stepPanel(state, 1);
    expect(currentPanelFrame(state)).toBe(b);
  });

  it("ends after frameCount * divider ticks and returns to the score view", () => {
    const state = queued(animationOf(3, solidFrame(8, 8, 1), solidFrame(8, 8, 2)));
    const done = stepPanel(state, 2 * 3);
    expect(panelIsIdle(done)).toBe(true);
    expect(currentPanelFrame(done)).toBeNull();
    // And the render really is the score again, not a stale frame.
    const target = renderPanel(done, 42, FONT);
    expect(litBounds(target)?.maxX).toBe(PANEL_SCORE_RIGHT_X - 1);
  });

  it("plays queued animations in order, one at a time", () => {
    const first = solidFrame(8, 8, 1);
    const second = solidFrame(8, 8, 2);
    let state = queued(animationOf(1, first), animationOf(1, second));
    expect(currentPanelFrame(state)).toBe(first);
    state = stepPanel(state, 1);
    expect(currentPanelFrame(state)).toBe(second);
    state = stepPanel(state, 1);
    expect(panelIsIdle(state)).toBe(true);
  });

  it("holds a holdLastFrame animation on its last frame indefinitely", () => {
    const art = solidFrame(8, 8, 1);
    const state = queued({ frames: [art], speedDivider: 2, holdLastFrame: true });
    expect(currentPanelFrame(stepPanel(state, 500))).toBe(art);
  });

  it("lets a held frame yield to the next queued animation within one divider", () => {
    const art = solidFrame(8, 8, 1);
    const next = solidFrame(8, 8, 2);
    let state = queued({ frames: [art], speedDivider: 2, holdLastFrame: true });
    state = stepPanel(state, 500);
    state = enqueuePanelAnimation(state, animationOf(1, next));
    expect(currentPanelFrame(stepPanel(state, 2))).toBe(next);
  });

  it("is pure and identity-preserving when nothing moves", () => {
    const idle = createPanelState();
    expect(stepPanel(idle, 100)).toBe(idle);
    const playing = queued(animationOf(5, solidFrame(8, 8, 1)));
    expect(stepPanel(playing, 0)).toBe(playing);
    // Same inputs, same output, tick by tick or all at once.
    const bulk = stepPanel(playing, 4);
    let stepped = playing;
    for (let i = 0; i < 4; i += 1) stepped = stepPanel(stepped, 1);
    expect(stepped).toEqual(bulk);
  });

  it("caps the queue at the ring's 64 slots, dropping the newcomer", () => {
    let state = createPanelState();
    for (let i = 0; i < PANEL_QUEUE_CAPACITY; i += 1) {
      state = enqueuePanelAnimation(state, animationOf(1, solidFrame(1, 1, 1)));
    }
    expect(state.queue).toHaveLength(PANEL_QUEUE_CAPACITY);
    expect(enqueuePanelAnimation(state, animationOf(1, solidFrame(1, 1, 1)))).toBe(state);
  });

  it("refuses malformed animations at the enqueue, not frames later", () => {
    const state = createPanelState();
    expect(() => enqueuePanelAnimation(state, animationOf(0, solidFrame(1, 1, 1)))).toThrow(
      RangeError,
    );
    expect(() => enqueuePanelAnimation(state, animationOf(1.5, solidFrame(1, 1, 1)))).toThrow(
      RangeError,
    );
    expect(() => enqueuePanelAnimation(state, animationOf(1))).toThrow(RangeError);
    expect(() =>
      enqueuePanelAnimation(state, animationOf(1, solidFrame(PANEL_WIDTH + 1, 1, 1))),
    ).toThrow(RangeError);
    expect(() =>
      enqueuePanelAnimation(state, animationOf(1, solidFrame(1, PANEL_HEIGHT + 1, 1))),
    ).toThrow(RangeError);
    expect(() =>
      enqueuePanelAnimation(state, {
        frames: [{ width: 4, height: 4, pixels: new Uint8Array(15) }],
        speedDivider: 1,
      }),
    ).toThrow(RangeError);
  });

  it("refuses non-integer or negative ticks", () => {
    const state = createPanelState();
    expect(() => stepPanel(state, -1)).toThrow(RangeError);
    expect(() => stepPanel(state, 0.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Frame compositing: the two planes' colours
// ---------------------------------------------------------------------------

describe("frame compositing", () => {
  it("paints plane 0 amber, plane 1 white, and white where both are set", () => {
    // One frame carrying all four plane combinations in its four columns.
    const pixels = Uint8Array.from([0, 1, 2, 3]);
    const state = queued(animationOf(1, { width: 4, height: 1, pixels }));
    const target = renderPanel(state, 0, FONT);
    expect(isUnlit(target, 0, 0)).toBe(true);
    expect(pixelAt(target, 1, 0)).toEqual(PANEL_AMBER);
    expect(pixelAt(target, 2, 0)).toEqual(PANEL_WHITE);
    expect(pixelAt(target, 3, 0)).toEqual(PANEL_WHITE);
  });

  it("does not draw the score while an animation is on screen", () => {
    const state = queued(animationOf(1, solidFrame(4, 4, 1, 0, 0)));
    const target = renderPanel(state, 987654, FONT);
    // The score column region is glass: the digits layer belongs to the
    // score view, and an animation owns the whole strip while it plays.
    for (let x = PANEL_SCORE_RIGHT_X - 60; x < PANEL_SCORE_RIGHT_X; x += 1) {
      for (let y = 0; y < PANEL_HEIGHT; y += 1) {
        expect(isUnlit(target, x, y)).toBe(true);
      }
    }
  });

  it("places a frame by its x/y and clips it at every edge without wrapping", () => {
    // A guarded buffer: 64 bytes of 0xAB on each side of the panel's RGBA.
    const bytes = PANEL_WIDTH * PANEL_HEIGHT * BYTES_PER_PIXEL;
    const backing = new ArrayBuffer(bytes + 128);
    new Uint8Array(backing).fill(0xab);
    const target: PixelTarget = {
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      data: new Uint8ClampedArray(backing, 64, bytes),
    };

    // Hangs off the right and bottom edges by 4 px each.
    const state = queued(animationOf(1, solidFrame(8, 8, 1, PANEL_WIDTH - 4, PANEL_HEIGHT - 4)));
    renderPanelInto(state, 0, FONT, target);

    // The on-strip corner is painted; a horizontal wrap would have lit the
    // left edge of the following rows, and it is glass.
    expect(pixelAt(target, PANEL_WIDTH - 1, PANEL_HEIGHT - 1)).toEqual(PANEL_AMBER);
    for (let y = 0; y < PANEL_HEIGHT; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        expect(isUnlit(target, x, y)).toBe(true);
      }
    }
    // And the guard bytes on both sides of the buffer are untouched.
    const head = new Uint8Array(backing, 0, 64);
    const tail = new Uint8Array(backing, 64 + bytes, 64);
    for (const byte of head) expect(byte).toBe(0xab);
    for (const byte of tail) expect(byte).toBe(0xab);
  });

  it("clips a frame hanging off the top-left the same way", () => {
    const state = queued(animationOf(1, solidFrame(8, 8, 1, -4, -4)));
    const target = renderPanel(state, 0, FONT);
    expect(pixelAt(target, 0, 0)).toEqual(PANEL_AMBER);
    expect(pixelAt(target, 3, 3)).toEqual(PANEL_AMBER);
    expect(isUnlit(target, 4, 0)).toBe(true);
    expect(isUnlit(target, 0, 4)).toBe(true);
  });

  it("refuses a target that is not exactly 320x16", () => {
    const state = createPanelState();
    expect(() => renderPanelInto(state, 0, FONT, createPixelTarget(320, 17))).toThrow(RangeError);
    expect(() => renderPanelInto(state, 0, FONT, createPixelTarget(336, 16))).toThrow(RangeError);
    const short: PixelTarget = {
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      data: new Uint8ClampedArray(16),
    };
    expect(() => renderPanelInto(state, 0, FONT, short)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// With the shipped shell font, when it is exported
// ---------------------------------------------------------------------------

const SHELL_DIR = fileURLToPath(new URL("../public/generated/shell/", import.meta.url));
const exported = existsSync(`${SHELL_DIR}${SHELL_ART_MANIFEST}`);

/** The same off-disk fetch shell-art.test.ts uses. */
const diskFetch: TableArtFetch = (url) => {
  const name = url.slice(url.lastIndexOf("/") + 1);
  const path = `${SHELL_DIR}${name}`;
  if (!existsSync(path)) {
    return Promise.resolve({
      ok: false,
      status: 404,
      statusText: "not on disk",
      arrayBuffer: () => Promise.reject(new Error("missing")),
    });
  }
  const bytes = readFileSync(path);
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  });
};

describe.skipIf(!exported)("the score view in the shipped small font", () => {
  it("sets 12,345,670 on the strip's own edge, inside the strip", async () => {
    const art = await loadShellArt(diskFetch, SHELL_ART_BASE_PATH);
    const target = renderPanel(createPanelState(), 12345670, art.font2);
    const bounds = litBounds(target);
    expect(bounds).not.toBeNull();
    // The shell font's own width sum: 3*commas + 7*digits = 62, right edge at
    // `$7198`'s x=320. Real glyphs may not ink their full advance, so the
    // bounds are bounded rather than pinned: nothing right of the column,
    // nothing left of the first pen position, everything inside the 16 rows.
    const penX = PANEL_SCORE_RIGHT_X - measureShellText(art.font2, "12,345,670");
    expect(penX).toBe(320 - 62);
    expect(bounds!.maxX).toBeLessThan(PANEL_SCORE_RIGHT_X);
    expect(bounds!.maxX).toBeGreaterThanOrEqual(PANEL_SCORE_RIGHT_X - 7);
    expect(bounds!.minX).toBeGreaterThanOrEqual(penX);
    expect(bounds!.minY).toBeGreaterThanOrEqual(0);
    expect(bounds!.maxY).toBeLessThan(PANEL_HEIGHT);
  });

  it("renders the shipped-font score to the pinned hash", async () => {
    const art = await loadShellArt(diskFetch, SHELL_ART_BASE_PATH);
    const target = renderPanel(createPanelState(), 12345670, art.font2);
    // Re-recorded with the score view's x=320 and row 2. Was e99c6be14b74f0af…
    expect(hashOf(target)).toBe("9db06aa4a285c9b4b5e914214e6976aa974f4d2cf143f6eabfe9d82bc1f19473");
  });
});

describe("the PLAYER/BALL card", () => {
  // The serve announcement, the multi-player end card and the ball-save
  // callout — the display lists at main.seg00 0x4AA2/0x4AB4/0x4AC6/0x453C/
  // 0x4FAC and the score draw's `move.w #$140,d3`
  // (research/MULTIPLAYER_DECODE.md §5): captions on the records' own rows,
  // the score right-aligned at x=320.

  function renderCard(card: PanelCardView, state = createPanelState()): PixelTarget {
    return renderPanelInto(
      state,
      777_777,
      FONT,
      createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT),
      null,
      card,
    );
  }

  const SERVE: PanelCardView = {
    lines: [
      { x: 0, row: 2, font: 4, align: 0, text: "PLAYER 2" },
      { x: 0, row: 8, font: 4, align: 0, text: "BALL 1" },
    ],
    score: 150_000,
  };

  it("draws the captions from the left edge — the lists' own x=0", () => {
    const target = renderCard(SERVE);
    // Both halves carry text starting at column 0.
    let topLit = false;
    let bottomLit = false;
    for (let y = 0; y < PANEL_HEIGHT; y += 1) {
      if (isUnlit(target, 0, y)) continue;
      if (y < PANEL_HEIGHT / 2) topLit = true;
      else bottomLit = true;
    }
    expect(topLit).toBe(true);
    expect(bottomLit).toBe(true);
  });

  it("right-aligns the score on the strip's own edge, the same x the idle view uses", () => {
    const target = renderCard(SERVE);
    // The rightmost lit column of the top half is the score's last pixel: 319.
    // `$7198` and the copy inlined at +0x005206 both say `move.w #$140,d3`, and
    // so does the idle view, because it IS `$7198`.
    let max = -1;
    for (let y = 0; y < PANEL_HEIGHT / 2; y += 1) {
      for (let x = 0; x < PANEL_WIDTH; x += 1) {
        if (!isUnlit(target, x, y) && x > max) max = x;
      }
    }
    expect(max).toBe(PANEL_WIDTH - 1);
    expect(PANEL_SCORE_RIGHT_X).toBe(PANEL_WIDTH);
  });

  it("a single-line card draws no second caption", () => {
    const target = renderCard({
      lines: [{ x: 0, row: 2, font: 1, align: 0, text: "PL 1" }],
      score: 0,
    });
    // The bottom text row's left half — where "BALL m" would start, at the
    // records' own x=0 — is glass all the way down. Only the right of the strip
    // carries ink, and that is the right-aligned score.
    for (let y = Math.floor(PANEL_HEIGHT / 2); y < PANEL_HEIGHT; y += 1) {
      for (let x = 0; x < PANEL_WIDTH / 2; x += 1) {
        expect(isUnlit(target, x, y)).toBe(true);
      }
    }
  });

  it("draws no score at all on a card whose record has none", () => {
    // +0x004F50 prints "DON'T MOVE" and returns; it never reaches `$71BA`.
    const target = renderCard({
      lines: [{ x: 160, row: 2, font: 1, align: 2, text: "DON'T MOVE" }],
      score: null,
    });
    // The right-hand column the score would occupy is glass on every row.
    for (let y = 0; y < PANEL_HEIGHT; y += 1) {
      expect(isUnlit(target, PANEL_WIDTH - 1, y)).toBe(true);
    }
  });

  it("outranks a queued animation, exactly as the serve state's per-frame clear does", () => {
    const state = queued(animationOf(1, solidFrame(PANEL_WIDTH, PANEL_HEIGHT, 1)));
    const target = renderCard(SERVE, state);
    expect(isUnlit(target, PANEL_WIDTH - 1, PANEL_HEIGHT - 1)).toBe(true);
  });

  it("is outranked by the bonus, which cannot coexist with a serve", () => {
    const target = renderPanelInto(
      createPanelState(),
      0,
      FONT,
      createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT),
      { caption: "NO BONUS", value: null, multiplier: "", multiplierLit: false },
      SERVE,
    );
    // The card's left-edge caption is absent; the centred bonus is up.
    expect(isUnlit(target, 0, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE SCORE VIEW IN THE MACHINE'S OWN FACE, AGAINST THE FILM
// ---------------------------------------------------------------------------

/**
 * `$7198` decoded, and every number below read back off a native-resolution
 * capture rather than argued for.
 *
 * The panel band of a 752x574 WinUAE frame is screen columns 94..733, rows
 * 26..89; panel column c is screen column 94+2c and panel row r is screen rows
 * 26+4r and 27+4r. Read back that way, this port's face table and these
 * coordinates reproduce five independent frames with ZERO differing pixels of
 * 5,120 (research/view/reference — the session-5 PLAYER/BALL still and the
 * full-game capture's frames 70, 300, 700 and 3240). The pen columns asserted
 * here are the ones those frames put the glyphs on.
 */
const PANEL_FONT_DIR = fileURLToPath(new URL("../public/generated/", import.meta.url));
const panelFontExported = existsSync(`${PANEL_FONT_DIR}panel-font.json`);
const MACHINE_FONT: PanelFont | null = panelFontExported
  ? parsePanelFontDocument(
      JSON.parse(readFileSync(`${PANEL_FONT_DIR}panel-font.json`, "utf8")) as PanelFontDocument,
      new Uint8Array(readFileSync(`${PANEL_FONT_DIR}panel-font.bin`)),
    )
  : null;

describe.skipIf(MACHINE_FONT === null)("the score view in the machine's own face", () => {
  const render = (score: number, card?: PanelCardView | null): PixelTarget =>
    renderPanelInto(
      createPanelState(),
      score,
      FONT,
      createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT),
      null,
      card ?? null,
      null,
      MACHINE_FONT,
    );

  /** Which glyph columns of `row` are lit — the film's own readout. */
  const litColumns = (target: PixelTarget, row: number): number[] => {
    const out: number[] = [];
    for (let x = 0; x < PANEL_WIDTH; x += 1) if (!isUnlit(target, x, row)) out.push(x);
    return out;
  };

  it("sets the score in face 1 on rows 2..13, the twelve-row face at ROW=2", () => {
    // `move.w #$1,d5 / move.w #$2,d4`. Face 1 is twelve rows, so 2..13, which
    // is where the film's 2,375,000 sits on the session-5 still.
    const bounds = litBounds(render(2_375_000));
    expect(bounds?.minY).toBe(2);
    expect(bounds?.maxY).toBe(13);
  });

  it("right-aligns on x=320: the last set column is 318, the face's own dither", () => {
    // `move.w #$140,d3 / move.w #$1,d6`. The faces are dithered `#.` — the
    // DMD's two pixels to a dot — so a run ending at 320 inks 318 and not 319.
    for (const score of [0, 675_000, 1_425_000, 2_375_000]) {
      expect(litBounds(render(score))?.maxX, `score ${score}`).toBe(318);
    }
  });

  it("puts every glyph of 2,375,000 on the column the film puts it on", () => {
    const face = panelFace(MACHINE_FONT!, 1);
    const text = formatPanelScore(2_375_000);
    expect(text).toBe("2,375,000");
    const pen = panelTextPen(face, text, PANEL_SCORE_RIGHT_X, 1);
    expect(pen).toBe(184);
    expect(panelTextRun(face, text, pen!).map((glyph) => glyph.pen)).toEqual([
      184, 202, 208, 226, 244, 262, 268, 286, 304,
    ]);
  });

  it("prints a zero score as one digit at x 304..318, which is what the film shows", () => {
    // 0x7226-0x723A prints the low nibble and stops the moment the shifted
    // value is zero, so a fresh game shows `0` and not an empty strip. Both
    // serve frames measured (f70, f300) carry exactly that single glyph.
    const target = render(0);
    // Film f70 and f300 both read back ink at columns 304..318 on rows 2..13,
    // and this is that, column for column.
    expect(litBounds(target)).toEqual({ minX: 304, maxX: 318, minY: 2, maxY: 13 });
    // The glyph's own shoulder: its top row starts two columns in, so the
    // score's first inked column on row 2 is 306 and on row 3 is 304.
    expect(litColumns(target, 2)[0]).toBe(306);
    expect(litColumns(target, 3)[0]).toBe(304);
  });

  it("narrows to face 3 once the top BCD word carries a digit", () => {
    // 0x71B0 `tst.w -$6(a0)` / 0x71B6 `addq.w #$2,d5`: font 1 + 2. Face 3 is
    // twelve rows on a twelve-pixel cell, so nine digits still fit the strip
    // where face 1's sixteen-pixel digits would not.
    const wide = litBounds(render(PANEL_SCORE_NARROW_FROM - 1)); // 8 digits, face 1
    const narrow = litBounds(render(PANEL_SCORE_NARROW_FROM)); // 9 digits, face 3
    expect(wide?.maxY).toBe(13);
    expect(narrow?.maxY).toBe(13);
    // Nine digits and two commas in face 1 would be 176 px wide and start at
    // 144; in face 3 they are 136 and start at 184.
    expect(narrow!.minX).toBeGreaterThan(wide!.minX);
    expect(
      panelTextPen(panelFace(MACHINE_FONT!, 3), "100,000,000", PANEL_SCORE_RIGHT_X, 1),
    ).toBe(narrow!.minX);
  });

  it("sets the serve card's captions in the FIVE-row face on rows 2 and 8", () => {
    // 0x4AA2 and 0x4AC6: `X=0 ROW=2 FONT=4` and `X=0 ROW=8 FONT=4`. Film
    // frames 70 and 300 put the caption on dot rows 2..6 and 8..12 with the
    // score's twelve rows beside them.
    const target = render(0, {
      lines: [
        { x: 0, row: 2, font: 4, align: 0, text: "PLAYER 1" },
        { x: 0, row: 8, font: 4, align: 0, text: "BALL 3" },
      ],
      score: 2_375_000,
    });
    const face = panelFace(MACHINE_FONT!, 4);
    expect(face.height).toBe(5);
    // The film's own pen columns: one blank advance (8 px) before each digit,
    // not two, because `$6DD0` writes right-to-left over the record's tail.
    expect(panelTextRun(face, "PLAYER 1", 0).map((glyph) => glyph.pen)).toEqual([
      0, 14, 26, 40, 54, 68, 90,
    ]);
    expect(panelTextRun(face, "BALL 3", 0).map((glyph) => glyph.pen)).toEqual([0, 14, 28, 40, 60]);
    // Row 7 is the gap the machine leaves between the two five-row captions —
    // on the left of the strip. The score's twelve rows cross it on the right.
    expect(litColumns(target, 7).every((x) => x >= 184)).toBe(true);
    expect(litBounds(target)?.maxX).toBe(318);
  });

  it("centres DON'T MOVE on x=160 in face 1, the ball-save record's own words", () => {
    // 0x4FAC `00A0 0002 0001 0002`. The film's callout starts at panel x=74,
    // which is 160 - (((width>>1)+1) & ~1) for that face's own measure.
    const face = panelFace(MACHINE_FONT!, 1);
    expect(panelTextPen(face, "DON'T MOVE", 160, 2)).toBe(74);
  });
});
