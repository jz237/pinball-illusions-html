/**
 * The score panel: playback sequencing and pixels.
 *
 * What matters here, in order of load-bearing-ness:
 *
 *   1. PLACEMENT IS THE ORIGINAL'S ARITHMETIC. The score must land with its
 *      right edge at the hunk-0 0x1836 template's x = 300 column, grouped in
 *      threes with commas — asserted against a synthetic font whose glyphs
 *      fill their advance exactly, so "right-aligned" is a pixel coordinate,
 *      not a vibe.
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
  PanelBonusView,
  PanelFrame,
  PanelState,
} from "../src/browser/panel-renderer.js";
import { BYTES_PER_PIXEL, createPixelTarget } from "../src/browser/playfield-renderer.js";
import type { PixelTarget } from "../src/browser/playfield-renderer.js";
import { PANEL_AMBER, PANEL_UNLIT, PANEL_WHITE } from "../src/browser/palette.js";
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
  it("groups digits in threes with commas, the ladder template's shape", () => {
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

  it("right-aligns the score with its last pixel at the template's x=300 column", () => {
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

  it("centres the digit block vertically in the 16 rows", () => {
    const target = renderPanel(createPanelState(), 88, FONT);
    const bounds = litBounds(target);
    const top = Math.floor((PANEL_HEIGHT - DIGIT_HEIGHT) / 2);
    expect(bounds?.minY).toBe(top);
    expect(bounds?.maxY).toBe(top + DIGIT_HEIGHT - 1);
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
    expect(hashOf(first)).toBe("d53ccd8e3621427a0081a2d9e562af987d6d66948b640d2254d5a99aad363ece");
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
  it("sets 12,345,670 in the template's own column, inside the strip", async () => {
    const art = await loadShellArt(diskFetch, SHELL_ART_BASE_PATH);
    const target = renderPanel(createPanelState(), 12345670, art.font2);
    const bounds = litBounds(target);
    expect(bounds).not.toBeNull();
    // The template's width sum: 3*commas + 7*digits = 62, right edge at 300.
    // Real glyphs may not ink their full advance, so the bounds are bounded
    // rather than pinned: nothing right of the column, nothing left of the
    // first pen position, everything inside the 16 rows.
    const penX = PANEL_SCORE_RIGHT_X - measureShellText(art.font2, "12,345,670");
    expect(penX).toBe(300 - 62);
    expect(bounds!.maxX).toBeLessThan(PANEL_SCORE_RIGHT_X);
    expect(bounds!.maxX).toBeGreaterThanOrEqual(PANEL_SCORE_RIGHT_X - 7);
    expect(bounds!.minX).toBeGreaterThanOrEqual(penX);
    expect(bounds!.minY).toBeGreaterThanOrEqual(0);
    expect(bounds!.maxY).toBeLessThan(PANEL_HEIGHT);
  });

  it("renders the shipped-font score to the pinned hash", async () => {
    const art = await loadShellArt(diskFetch, SHELL_ART_BASE_PATH);
    const target = renderPanel(createPanelState(), 12345670, art.font2);
    expect(hashOf(target)).toBe("e99c6be14b74f0af55a7c667c5e3dc6748af9c1bbd09babd342a8d630ea622d4");
  });
});
