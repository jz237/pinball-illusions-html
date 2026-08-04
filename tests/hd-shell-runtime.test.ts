/**
 * The HD SHELL at RUNTIME — the seam between the shipped 4x maps and the
 * surfaces a player actually sees.
 *
 * `hd-shell-assets.test.ts` proves the FILES: that the exporter is
 * deterministic, that the maps are index maps, that they register with their
 * native sources and that the vote beats what it replaces. None of that touches
 * the code which CONSUMES them, and that code is where an HD bug would reach a
 * player: `shell-skin.ts` sizes every surface by `sourceScale`, and
 * `shell-screens.ts` multiplies its SOURCE rectangles by the same number while
 * leaving every DESTINATION coordinate alone. Get that multiplication wrong and
 * the shell draws the wrong slice of the right atlas — silently.
 *
 * So what is proved here is:
 *
 *  1. THE SET DRIVES EVERY SURFACE. With the HD set the skin hands out strips
 *     and atlases at exactly 4x, and without it at exactly 1x. One number.
 *  2. THE COLOUR ARITHMETIC IS UNTOUCHED. The page-palette fade still repaints
 *     an HD strip, and the three-step ink ramp still applies to an HD atlas —
 *     the two properties that forced index maps instead of pictures.
 *  3. A SET THAT DOES NOT REGISTER IS REFUSED. An atlas whose row count is not
 *     `native rows x scale` would be sliced with the native font's metrics and
 *     mis-draw every glyph. `shell-skin.ts` drops such a set and draws native
 *     rather than shipping the mis-slice; this is the proof of that, and the
 *     control below proves the check does not simply reject everything.
 *  4. THE LOADERS VERIFY WHAT THEY LOAD. Schema, scale, geometry and the
 *     manifest's own sha256 over the bytes actually fetched.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createShellSkin } from "../src/browser/shell-skin.js";
import type { ShellSkinHd } from "../src/browser/shell-skin.js";
import { createRasterCanvas, createRasterSkinCanvases } from "./shell-raster.js";
import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  FIELD_X,
  FIELD_Y,
  SHELL_HEIGHT,
  SHELL_ORIGIN_X,
  SHELL_WIDTH,
  renderShell,
} from "../src/browser/shell-screens.js";
import type { ShellArtworkSource } from "../src/browser/shell-screens.js";
import { createShell } from "../src/browser/shell.js";
import type { ScoreStore, ShellState } from "../src/browser/shell.js";
import { FACTORY_HIGH_SCORES } from "../src/game/high-scores.js";
import { loadShellArt } from "../src/game/shell-art.js";
import type { ShellArt } from "../src/game/shell-art.js";
import {
  FONT_ATLAS_WIDTH,
  SHELL_PALETTE_COLOURS,
  STRIP_HEIGHT,
  STRIP_WIDTH,
} from "../src/game/shell-art.js";
import {
  LOADING_LOGO_HD_MANIFEST,
  SHELL_ART_HD_MANIFEST,
  loadLoadingLogoHd,
  loadShellArtHd,
} from "../src/game/shell-art-hd.js";
import type { ShellArtHd } from "../src/game/shell-art-hd.js";
import { LOADING_LOGO_HEIGHT, LOADING_LOGO_WIDTH } from "../src/game/loading-logo.js";
import type { TableArtFetch } from "../src/game/table-art.js";

const SHELL_DIR = fileURLToPath(new URL("../public/generated/shell/", import.meta.url));
const HD_SCALE = 4;

/** A fetcher over the shipped files, with named files optionally replaced. */
function fetchWith(overrides: Record<string, Uint8Array> = {}): TableArtFetch {
  return (url) => {
    const name = url.slice(url.lastIndexOf("/") + 1);
    const bytes = overrides[name] ?? readFileSync(`${SHELL_DIR}${name}`);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: () =>
        Promise.resolve(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        ),
    });
  };
}

const diskFetch = fetchWith();
const encode = (doc: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(doc));
const manifest = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${SHELL_DIR}${name}`, "utf8")) as Record<string, unknown>;

let cachedArt: ShellArt | null = null;
let cachedHd: ShellArtHd | null = null;
async function art(): Promise<ShellArt> {
  cachedArt ??= await loadShellArt(diskFetch, "");
  return cachedArt;
}
async function hdArt(): Promise<ShellArtHd> {
  cachedHd ??= await loadShellArtHd(diskFetch);
  return cachedHd;
}
async function skinWith(hd: ShellSkinHd | null) {
  return createShellSkin(await art(), createRasterSkinCanvases(), null, hd);
}

interface Surface {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}
const asSurface = (value: unknown): Surface => value as unknown as Surface;

/** A live 16-entry page palette, distinct per `seed`. */
function paletteOf(seed: number): Uint8Array {
  const palette = new Uint8Array(SHELL_PALETTE_COLOURS * 3);
  for (let i = 0; i < palette.length; i += 1) palette[i] = (i * 7 + seed * 29) % 256;
  return palette;
}

const exported = existsSync(`${SHELL_DIR}${SHELL_ART_HD_MANIFEST}`);
const when = exported ? describe : describe.skip;

when("the HD set drives every surface the skin hands out", () => {
  it("reports sourceScale 1 without the set and 4 with it", async () => {
    expect((await skinWith(null)).sourceScale).toBe(1);
    expect((await skinWith({ art: await hdArt(), logo: null })).sourceScale).toBe(HD_SCALE);
  });

  it("hands out font atlases at 4x the native atlas, in both fonts", async () => {
    const native = await art();
    const hd = await skinWith({ art: await hdArt(), logo: null });
    const plain = await skinWith(null);
    for (const font of ["font1", "font2"] as const) {
      const rows = font === "font1" ? native.font1.rows : native.font2.rows;
      const big = asSurface(hd.fontAtlas(font, "#ffffff"));
      expect([big.width, big.height]).toEqual([FONT_ATLAS_WIDTH * HD_SCALE, rows * HD_SCALE]);
      const small = asSurface(plain.fontAtlas(font, "#ffffff"));
      expect([small.width, small.height]).toEqual([FONT_ATLAS_WIDTH, rows]);
    }
  });

  it("hands out backdrop strips at 4x, in every role", async () => {
    const hd = await skinWith({ art: await hdArt(), logo: null });
    const plain = await skinWith(null);
    for (const role of ["attract", "menu", "select"] as const) {
      const big = asSurface(hd.backdrop(role, paletteOf(1)));
      expect([big.width, big.height]).toEqual([STRIP_WIDTH * HD_SCALE, STRIP_HEIGHT * HD_SCALE]);
      const small = asSurface(plain.backdrop(role, paletteOf(1)));
      expect([small.width, small.height]).toEqual([STRIP_WIDTH, STRIP_HEIGHT]);
    }
  });

  it("hands out the HD loading strip at 4x when it has one", async () => {
    const logo = await loadLoadingLogoHd(diskFetch);
    const skin = await skinWith({ art: await hdArt(), logo });
    const surface = asSurface(skin.loadingLogo());
    expect([surface.width, surface.height]).toEqual([
      LOADING_LOGO_WIDTH * HD_SCALE,
      LOADING_LOGO_HEIGHT * HD_SCALE,
    ]);
    expect(skin.loadingLogoTop()).toBe(logo.top);
  });
});

when("the colour arithmetic the index maps exist to preserve", () => {
  it("still repaints an HD strip when the page palette fades", async () => {
    // The whole reason the strips ship as INDICES: `shell-skin.ts` repaints
    // them every frame of a fade. If HD froze one palette this would not move.
    const skin = await skinWith({ art: await hdArt(), logo: null });
    const first = Array.from(asSurface(skin.backdrop("menu", paletteOf(1))).pixels);
    const second = Array.from(asSurface(skin.backdrop("menu", paletteOf(2))).pixels);
    expect(second).not.toEqual(first);
    // and painting the SAME palette again is stable
    const again = Array.from(asSurface(skin.backdrop("menu", paletteOf(2))).pixels);
    expect(again).toEqual(second);
  });

  it("still applies the three-step ink ramp to an HD atlas, in any ink", async () => {
    const skin = await skinWith({ art: await hdArt(), logo: null });
    const white = asSurface(skin.fontAtlas("font1", "#ffffff"));
    const tones = new Set<string>();
    for (let i = 0; i < white.pixels.length; i += 4) {
      if (white.pixels[i + 3] === 0) continue;
      tones.add(`${white.pixels[i]},${white.pixels[i + 1]},${white.pixels[i + 2]}`);
    }
    // Plane values 1/2/3 against white ink are the original's $fff/$aaa/$777.
    expect([...tones].sort()).toEqual(["119,119,119", "170,170,170", "255,255,255"]);
    // A different ink scales the same ramp rather than replacing it.
    const red = asSurface(skin.fontAtlas("font1", "#ff0000"));
    const redTones = new Set<string>();
    for (let i = 0; i < red.pixels.length; i += 4) {
      if (red.pixels[i + 3] === 0) continue;
      redTones.add(`${red.pixels[i]},${red.pixels[i + 1]},${red.pixels[i + 2]}`);
    }
    expect([...redTones].sort()).toEqual(["119,0,0", "170,0,0", "255,0,0"]);
  });

  it("leaves transparent where the atlas has no ink, so there is no knockout", async () => {
    const skin = await skinWith({ art: await hdArt(), logo: null });
    const atlas = asSurface(skin.fontAtlas("font2", "#ffffff"));
    let clear = 0;
    for (let i = 3; i < atlas.pixels.length; i += 4) if (atlas.pixels[i] === 0) clear += 1;
    expect(clear).toBeGreaterThan(0);
  });
});

when("an HD set that does not register with the native art is refused", () => {
  it("CONTROL: the real shipped set IS accepted", async () => {
    // Without this the four rejections below would also pass if the check
    // simply refused everything.
    expect((await skinWith({ art: await hdArt(), logo: null })).sourceScale).toBe(HD_SCALE);
  });

  it("refuses a font atlas whose rows are not the native rows times the scale", async () => {
    const real = await hdArt();
    const height = real.font1.height + HD_SCALE;
    const skin = await skinWith({
      art: {
        ...real,
        font1: { width: real.font1.width, height, indices: new Uint8Array(real.font1.width * height) },
      },
      logo: null,
    });
    expect(skin.sourceScale).toBe(1);
    // and it draws the NATIVE atlas rather than the mis-registered one
    const native = await art();
    const atlas = asSurface(skin.fontAtlas("font1", "#ffffff"));
    expect([atlas.width, atlas.height]).toEqual([FONT_ATLAS_WIDTH, native.font1.rows]);
  });

  it("refuses a backdrop strip of the wrong geometry", async () => {
    const real = await hdArt();
    const width = STRIP_WIDTH * HD_SCALE - HD_SCALE;
    const skin = await skinWith({
      art: {
        ...real,
        backdrops: {
          ...real.backdrops,
          menu: {
            width,
            height: STRIP_HEIGHT * HD_SCALE,
            indices: new Uint8Array(width * STRIP_HEIGHT * HD_SCALE),
          },
        },
      },
      logo: null,
    });
    expect(skin.sourceScale).toBe(1);
  });

  it("refuses a set whose index buffer is the wrong length for its dimensions", async () => {
    const real = await hdArt();
    const skin = await skinWith({
      art: {
        ...real,
        font2: { width: real.font2.width, height: real.font2.height, indices: new Uint8Array(8) },
      },
      logo: null,
    });
    expect(skin.sourceScale).toBe(1);
  });

  it("refuses a scale that is not a whole number of pixels", async () => {
    const real = await hdArt();
    const skin = await skinWith({ art: { ...real, scale: 2.5 }, logo: null });
    expect(skin.sourceScale).toBe(1);
  });
});

when("a screen DRAWN through the HD skin is the same screen", () => {
  // This is the multiplication itself: `shell-screens.ts` scales its SOURCE
  // rectangles by `sourceScale` and leaves every DESTINATION coordinate alone.
  // Get it wrong and the shell draws the wrong slice of the right atlas, which
  // no dimension check anywhere would notice.
  const artwork: ShellArtworkSource = { imageFor: () => null };
  const store: ScoreStore = {
    load: () => FACTORY_HIGH_SCORES.map((entry) => ({ ...entry })),
    save: () => undefined,
  };

  async function shot(hd: ShellSkinHd | null, scale: number, prepare: (s: ShellState) => void) {
    const skin = await skinWith(hd);
    const state = createShell(store);
    prepare(state);
    const canvas = createRasterCanvas(
      (SHELL_WIDTH + 2 * SHELL_ORIGIN_X) * scale,
      SHELL_HEIGHT * scale,
    );
    renderShell(canvas.ctx, state, scale, artwork, skin);
    return canvas;
  }

  /** Mean per-channel |difference| between a 4x shot boxed down and a 1x shot. */
  function meanDelta(big: { width: number; data: Uint8ClampedArray }, small: {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }): number {
    let total = 0;
    let n = 0;
    for (let y = 0; y < small.height; y += 1) {
      for (let x = 0; x < small.width; x += 1) {
        for (let c = 0; c < 3; c += 1) {
          let sum = 0;
          for (let dy = 0; dy < HD_SCALE; dy += 1) {
            for (let dx = 0; dx < HD_SCALE; dx += 1) {
              sum += big.data[((y * HD_SCALE + dy) * big.width + x * HD_SCALE + dx) * 4 + c] ?? 0;
            }
          }
          total += Math.abs(sum / (HD_SCALE * HD_SCALE) - (small.data[(y * small.width + x) * 4 + c] ?? 0));
          n += 1;
        }
      }
    }
    return total / n;
  }

  /**
   * The LETTERFORM mask inside the field, in logical pixels.
   *
   * Restricted to the field on purpose: the shell's frame is white too, and a
   * mask that includes it is dominated by a rectangle no glyph bug can move —
   * which is exactly how an earlier version of this test managed to pass
   * against a source rectangle that was not scaled at all.
   */
  function inkMask(
    canvas: { width: number; data: Uint8ClampedArray },
    scale: number,
  ): Uint8Array {
    const mask = new Uint8Array(FIELD_WIDTH * FIELD_HEIGHT);
    for (let y = 0; y < FIELD_HEIGHT; y += 1) {
      for (let x = 0; x < FIELD_WIDTH; x += 1) {
        // "Bright" over the whole logical pixel, so a 4x shot boxes down the
        // same way a 1x shot reads directly.
        let bright = 0;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = (SHELL_ORIGIN_X + FIELD_X + x) * scale + dx;
            const py = (FIELD_Y + y) * scale + dy;
            const at = (py * canvas.width + px) * 4;
            if (
              (canvas.data[at] ?? 0) > 200 &&
              (canvas.data[at + 1] ?? 0) > 200 &&
              (canvas.data[at + 2] ?? 0) > 200
            ) {
              bright += 1;
            }
          }
        }
        mask[y * FIELD_WIDTH + x] = bright * 2 > scale * scale ? 1 : 0;
      }
    }
    return mask;
  }

  it("draws the SAME LETTERFORMS at HD as it does natively", async () => {
    // The proof that the SOURCE rectangles are scaled and the DESTINATION ones
    // are not. A source rectangle taken at native offsets out of a 4x atlas
    // slices a different part of the atlas entirely, so the letterforms change
    // shape while landing in exactly the same place — which is why this is
    // measured as a mask overlap and not as a bounding box.
    const prepare = (s: ShellState): void => {
      s.phase = "menu";
      s.ticks = 300;
    };
    const big = await shot({ art: await hdArt(), logo: null }, HD_SCALE, prepare);
    const small = await shot(null, 1, prepare);
    const a = inkMask(big, HD_SCALE);
    const b = inkMask(small, 1);
    let both = 0;
    let either = 0;
    let native = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === 1 || b[i] === 1) either += 1;
      if (a[i] === 1 && b[i] === 1) both += 1;
      if (b[i] === 1) native += 1;
    }
    // There IS text on this screen: without this the overlap below is 0/0.
    expect(native).toBeGreaterThan(200);
    // An xBRZ supersample boxed back down is not bit-identical, but the glyphs
    // are the same glyphs in the same places.
    expect(both / either).toBeGreaterThan(0.9);
  });

  for (const [name, prepare] of [
    ["the menu", (s: ShellState) => { s.phase = "menu"; s.ticks = 300; }],
    ["the attract screen", (s: ShellState) => { s.ticks = 30; }],
  ] as const) {
    it(`${name}: the HD screen boxed down to 1x is the native screen`, async () => {
      const hd = { art: await hdArt(), logo: null };
      const big = await shot(hd, HD_SCALE, prepare);
      const small = await shot(null, 1, prepare);
      // Catches the BAND source rectangles, which cover most of the screen.
      expect(meanDelta(big, small)).toBeLessThan(12);
    });
  }
});

when("the loaders verify what they load", () => {
  it("rejects a shell manifest with the wrong schema", async () => {
    const doc = { ...manifest(SHELL_ART_HD_MANIFEST), schema: "something/else/v1" };
    await expect(
      loadShellArtHd(fetchWith({ [SHELL_ART_HD_MANIFEST]: encode(doc) })),
    ).rejects.toThrow(/schema/);
  });

  it("rejects a shell manifest whose scale is not the asset scale", async () => {
    const doc = { ...manifest(SHELL_ART_HD_MANIFEST), scale: 3 };
    await expect(
      loadShellArtHd(fetchWith({ [SHELL_ART_HD_MANIFEST]: encode(doc) })),
    ).rejects.toThrow(/scale/);
  });

  it("rejects a shell manifest that is missing a backdrop role", async () => {
    const doc = manifest(SHELL_ART_HD_MANIFEST);
    const images = (doc.images as { role: string }[]).filter((i) => i.role !== "select");
    await expect(
      loadShellArtHd(fetchWith({ [SHELL_ART_HD_MANIFEST]: encode({ ...doc, images }) })),
    ).rejects.toThrow(/select/);
  });

  it("rejects a raster whose bytes do not hash to the manifest's sha256", async () => {
    // The digest check is skipped, not faked, where there is no crypto.subtle;
    // node has one, so this must actually fire.
    expect(globalThis.crypto?.subtle).toBeDefined();
    const bytes = new Uint8Array(readFileSync(`${SHELL_DIR}loading-logo-hd.png`));
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    await expect(
      loadLoadingLogoHd(fetchWith({ "loading-logo-hd.png": bytes })),
    ).rejects.toThrow(/sha256/);
  });

  it("rejects a loading manifest whose declared geometry is not 4x", async () => {
    const doc = manifest(LOADING_LOGO_HD_MANIFEST);
    const image = { ...(doc.image as Record<string, unknown>), width: 999 };
    await expect(
      loadLoadingLogoHd(fetchWith({ [LOADING_LOGO_HD_MANIFEST]: encode({ ...doc, image }) })),
    ).rejects.toThrow(/expected/);
  });
});
