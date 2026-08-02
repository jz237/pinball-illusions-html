/**
 * A software canvas, just wide enough to draw a shell screen into a byte array.
 *
 * `shell-screens.ts` deliberately takes a structural `ShellContext` rather than
 * the DOM type, for the same reason `playfield-renderer.ts` does: a screen can
 * then be DRAWN in a test and the resulting pixels asserted on, with no browser
 * anywhere. This is that context — plus the `SkinCanvas` factory the skin wants
 * — implemented over a plain RGBA buffer.
 *
 * It is not a canvas implementation. It is exactly the operations these screens
 * use: axis-aligned fills, nearest-neighbour `drawImage` at integer scales, and
 * a rectangle clip. `fillText` draws nothing and is only counted, because it is
 * the browser-font fallback's primitive and there is no browser font here; every
 * skinned screen goes through `drawImage` instead.
 */

import type { ShellContext } from "../src/browser/shell-screens.js";
import type { SkinCanvas, SkinCanvasContext, SkinCanvasFactory } from "../src/browser/shell-skin.js";

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major. */
  readonly data: Uint8ClampedArray;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A clip is an intersection of unions: each entry is one `clip()` call. */
type Clip = readonly (readonly Rect[])[];

interface SavedState {
  clip: Clip;
  globalAlpha: number;
  fillStyle: string;
}

function parseColour(style: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(style.trim());
  if (match === null) throw new Error(`raster canvas takes "#rrggbb", got ${style}`);
  const value = parseInt(match[1] ?? "0", 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function inside(clip: Clip, x: number, y: number): boolean {
  for (const union of clip) {
    let hit = false;
    for (const rect of union) {
      if (x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  return true;
}

export interface RasterCanvas extends Raster {
  readonly ctx: ShellContext;
  /** How many times `fillText` was asked to draw — the fallback path's tell. */
  readonly texts: readonly { value: string; x: number; y: number }[];
  /** "#rrggbb" of one pixel. */
  hex(x: number, y: number): string;
  /** How many pixels of `colour` the whole raster holds. */
  count(colour: string): number;
}

/** A raster and the `ShellContext` that draws into it. */
export function createRasterCanvas(width: number, height: number): RasterCanvas {
  const data = new Uint8ClampedArray(width * height * 4);
  const texts: { value: string; x: number; y: number }[] = [];
  let clip: Clip = [];
  let path: Rect[] = [];
  const stack: SavedState[] = [];

  const put = (x: number, y: number, rgb: readonly [number, number, number], alpha: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (!inside(clip, x, y)) return;
    const at = (y * width + x) * 4;
    if (alpha >= 1) {
      data[at] = rgb[0];
      data[at + 1] = rgb[1];
      data[at + 2] = rgb[2];
      data[at + 3] = 255;
      return;
    }
    for (let channel = 0; channel < 3; channel += 1) {
      data[at + channel] = Math.round(
        (data[at + channel] ?? 0) * (1 - alpha) + (rgb[channel] ?? 0) * alpha,
      );
    }
    data[at + 3] = 255;
  };

  const ctx: ShellContext = {
    fillStyle: "#000000",
    font: "",
    textAlign: "left",
    textBaseline: "top",
    imageSmoothingEnabled: false,
    globalAlpha: 1,
    fillRect(x, y, w, h) {
      const colour = parseColour(String(this.fillStyle));
      const x0 = Math.round(x);
      const y0 = Math.round(y);
      const x1 = Math.round(x + w);
      const y1 = Math.round(y + h);
      for (let py = y0; py < y1; py += 1) {
        for (let px = x0; px < x1; px += 1) put(px, py, colour, this.globalAlpha);
      }
    },
    fillText(value, x, y) {
      texts.push({ value, x, y });
    },
    beginPath() {
      path = [];
    },
    rect(x, y, w, h) {
      path.push({ x0: Math.round(x), y0: Math.round(y), x1: Math.round(x + w), y1: Math.round(y + h) });
    },
    clip() {
      clip = [...clip, path.slice()];
    },
    save() {
      stack.push({ clip, globalAlpha: this.globalAlpha, fillStyle: String(this.fillStyle) });
    },
    restore() {
      const held = stack.pop();
      if (held === undefined) return;
      clip = held.clip;
      this.globalAlpha = held.globalAlpha;
      this.fillStyle = held.fillStyle;
    },
    drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
      const source = image as unknown as { width: number; height: number; pixels?: Uint8ClampedArray };
      const pixels = source.pixels;
      if (pixels === undefined) throw new Error("raster canvas can only draw its own surfaces");
      const scaleX = dw / sw;
      const scaleY = dh / sh;
      const x0 = Math.round(dx);
      const y0 = Math.round(dy);
      for (let oy = 0; oy < Math.round(dh); oy += 1) {
        const ty = sy + Math.floor(oy / scaleY);
        if (ty < 0 || ty >= source.height) continue;
        for (let ox = 0; ox < Math.round(dw); ox += 1) {
          const tx = sx + Math.floor(ox / scaleX);
          if (tx < 0 || tx >= source.width) continue;
          const at = (ty * source.width + tx) * 4;
          if ((pixels[at + 3] ?? 0) === 0) continue;
          put(
            x0 + ox,
            y0 + oy,
            [pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0],
            this.globalAlpha,
          );
        }
      }
    },
  };

  const hex = (x: number, y: number): string => {
    const at = (y * width + x) * 4;
    return `#${[0, 1, 2]
      .map((channel) => (data[at + channel] ?? 0).toString(16).padStart(2, "0"))
      .join("")}`;
  };

  const count = (colour: string): number => {
    const [r, g, b] = parseColour(colour);
    let seen = 0;
    for (let at = 0; at < data.length; at += 4) {
      if (data[at] === r && data[at + 1] === g && data[at + 2] === b) seen += 1;
    }
    return seen;
  };

  return { width, height, data, ctx, texts, hex, count };
}

/**
 * The skin's offscreen surfaces, as plain RGBA buffers.
 *
 * `createShellSkin` hands its canvases an `ImageData`; node has no such global,
 * so this shims the one property the skin sets and reads.
 */
export function createRasterSkinCanvases(): SkinCanvasFactory {
  interface Shim {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }
  const globals = globalThis as unknown as { ImageData?: unknown };
  if (globals.ImageData === undefined) {
    globals.ImageData = class {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
  }
  return (width, height): SkinCanvas => {
    const surface = {
      width,
      height,
      pixels: new Uint8ClampedArray(width * height * 4),
      getContext(kind: "2d"): SkinCanvasContext | null {
        if (kind !== "2d") return null;
        return {
          putImageData(image: ImageData, x: number, y: number): void {
            const shim = image as unknown as Shim;
            for (let row = 0; row < shim.height; row += 1) {
              const from = row * shim.width * 4;
              const to = ((y + row) * surface.width + x) * 4;
              surface.pixels.set(shim.data.subarray(from, from + shim.width * 4), to);
            }
          },
        };
      },
    };
    return surface as unknown as SkinCanvas;
  };
}
