/**
 * Loader for the shipped shell ARTWORK (`public/generated/shell/`).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * Sibling of `table-art.ts`. That one loads a table's playfield picture; this
 * one loads the SHELL's presentation, decoded from `menudata.bin` by
 * `scripts/export-shell-art.mjs`:
 *
 *   - FONT1, the large 19-px menu font: a 16-px-wide two-plane glyph atlas plus
 *     128 metric entries of (advance, height, signed y-offset). The two planes
 *     are an ANTI-ALIAS RAMP, not fill + outline — the hardware ORs them and the
 *     values 1, 2, 3 light three different colour registers;
 *   - FONT2, the small ~8-px font: single-plane, 256 entries, ASCII plus a
 *     Latin-1 accent set;
 *   - three 1472 x 32 backdrop strips — tumbling rings, cubes and crosses — of
 *     46 objects at a 32-px pitch, carrying one 4-bit PALETTE INDEX per pixel;
 *   - the SIXTEEN PAGE PALETTES those indices are read through, the copper's
 *     ±64 sine table, and the four 16 x 16 dissolve orders the original reveals
 *     pictures with.
 *
 * There is no single shell palette. `menudata` h4+0x480 is sixteen 16-colour
 * palettes stored row-major, nine of which the shell's own cycler fades between
 * while it runs; the same cube strip is teal on one page and gold on the next.
 * A v1 manifest read that block transposed and shipped one wrong palette, which
 * is why the schema string moved to v2 rather than being widened in place.
 *
 * Glyph atlas row layout is the disk's own: a character's rows sit at the
 * cumulative height of every character before it, exactly as `main.bin` walks
 * the metric tables at h0+0xD80. `glyphsOf` re-runs that accumulation here and
 * refuses an atlas whose height disagrees, so a manifest and a PNG that drifted
 * apart fail loudly instead of drawing garbage.
 *
 * Pure decode + validation, no DOM: tests load the shipped files off disk in
 * node and assert on them, the same argument as `table-art.ts`. Only
 * `loadShellArt` touches the network.
 */

import { decodeIndexedPng } from "./table-art.js";
import type { IndexedImage, TableArtFetch, TableArtResponse } from "./table-art.js";

/** Where the exported shell artwork lives under the site root. */
export const SHELL_ART_BASE_PATH = "generated/shell/";

/** The manifest schema written by `scripts/export-shell-art.mjs`. */
export const SHELL_ART_SCHEMA = "pinball-illusions/shell-art/v2";

export const SHELL_ART_MANIFEST = "shell.art.json";

/** Both fonts' glyphs are stored 16 px wide, one word per plane. */
export const FONT_ATLAS_WIDTH = 16;

/** The three strips are 1472 x 32: 46 objects at a 32-px pitch. */
export const STRIP_WIDTH = 1472;
export const STRIP_HEIGHT = 32;
export const STRIP_PITCH = 32;
export const STRIP_OBJECTS = STRIP_WIDTH / STRIP_PITCH;

/** Palettes on the disk, and how many of them the shell's cycler reaches. */
export const SHELL_PALETTE_COUNT = 16;
export const SHELL_PALETTE_LIVE = 9;
export const SHELL_PALETTE_COLOURS = 16;

/** One glyph, resolved out of the metrics table. */
export interface ShellGlyph {
  /** Pen advance in pixels. Nonzero for characters that exist, space included. */
  readonly advance: number;
  /** Rows of atlas this glyph occupies. 0 for characters with no image. */
  readonly height: number;
  /** Signed rows below the pen y at which the glyph's first row is drawn. */
  readonly yOffset: number;
  /** First atlas row of the glyph. */
  readonly top: number;
}

export interface ShellFont {
  /**
   * One entry per character code the metrics table covers.
   */
  readonly glyphs: readonly ShellGlyph[];
  /**
   * One byte per pixel, `FONT_ATLAS_WIDTH` wide.
   *
   * 0 is bare backdrop — there is no knockout, the picture behind the text shows
   * right up against the glyph edge. 1, 2 and 3 are the anti-alias ramp, from
   * the full ink colour down to its darkest step; font2 is single-plane and only
   * ever reaches 1.
   */
  readonly pixels: Uint8Array;
  readonly rows: number;
}

/** One of the sixteen page palettes. */
export interface ShellPalette {
  /** 16 AGA 12-bit `$0RGB` words, index 0 first. Index 0 is the black field. */
  readonly aga: readonly number[];
  /** The same 16 colours as 48 bytes, r,g,b per entry — what a canvas wants. */
  readonly rgb: Uint8Array;
}

export type ShellBackdropRole = "attract" | "menu" | "select";

export interface ShellBackdrop {
  readonly role: ShellBackdropRole;
  /** One 4-bit palette index per pixel, `STRIP_WIDTH` x `STRIP_HEIGHT`. */
  readonly pixels: Uint8Array;
}

export interface ShellArt {
  readonly font1: ShellFont;
  readonly font2: ShellFont;
  readonly backdrops: Readonly<Record<ShellBackdropRole, ShellBackdrop>>;
  /**
   * The sixteen page palettes in disk order.
   *
   * `palettes[0..7]` are the eight page tints the shell fades through — blue,
   * teal, green, gold, orange, red, crimson, purple — `palettes[8]` is the black
   * one it crossfades through when it swaps the strip, and 9..15 are on the disk
   * but unreachable (`SHELL_PALETTE_LIVE` is where the live block ends).
   */
  readonly palettes: readonly ShellPalette[];
  /** 256 signed entries, ±64: the copper's per-band scroll wobble. */
  readonly sine: readonly number[];
  /**
   * The four 16 x 16 reveal orders: linear, spiral, shuffled, anti-diagonal.
   * Each is a permutation of 0..255.
   */
  readonly dissolve: readonly (readonly number[])[];
}

// ---------------------------------------------------------------------------
// Text measurement — the original's own arithmetic
// ---------------------------------------------------------------------------

/**
 * THE SIX SWEDISH LETTERS, and where the shell font really keeps them.
 *
 * font1 has 128 metric entries and no room for Latin-1, so the original stores
 * Å Ä Ö å ä ö in the ASCII bracket/brace slots — confirmed glyph by glyph
 * against `public/generated/shell/shell-font1.png`:
 *
 *     [ 0x5B = Å    \ 0x5C = Ä    ] 0x5D = Ö
 *     { 0x7B = å    | 0x7C = ä    } 0x7D = ö
 *
 * Source strings in this repo are written in readable Unicode ("Markus
 * Nyström") and translated here, so nothing in the codebase has to be read
 * through a substitution table. A literal U+00F6 would index past font1's 128
 * entries, advance 0 and draw nothing — which is exactly how a mis-set page
 * would silently lose a letter and shift the whole centred line.
 */
const SHELL_CHAR_SUBSTITUTIONS: ReadonlyMap<number, number> = new Map([
  [0x00c5, 0x5b],
  [0x00c4, 0x5c],
  [0x00d6, 0x5d],
  [0x00e5, 0x7b],
  [0x00e4, 0x7c],
  [0x00f6, 0x7d],
]);

/** The font code point for the character at `at`, after the substitutions. */
export function shellCharCode(text: string, at: number): number {
  const code = text.charCodeAt(at);
  return SHELL_CHAR_SUBSTITUTIONS.get(code) ?? code;
}

/**
 * Pixel width of a string: the sum of the advances, which is exactly what the
 * width tables `main.bin` builds at +0x1E16/+0x1E96 sum to. Characters the
 * font has no entry for advance 0 and draw nothing, matching a blitter fed a
 * zero-height glyph.
 */
export function measureShellText(font: ShellFont, text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i += 1) {
    width += font.glyphs[shellCharCode(text, i)]?.advance ?? 0;
  }
  return width;
}

/**
 * The pen x for a run of text: the original centres via `x - width/2` (integer
 * truncated — it is 68k word arithmetic) and right-aligns via `x - width`.
 */
export function alignShellText(
  font: ShellFont,
  text: string,
  x: number,
  align: "left" | "center" | "right",
): number {
  if (align === "left") return x;
  const width = measureShellText(font, text);
  return align === "center" ? x - Math.floor(width / 2) : x - width;
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

/** The slice of the manifest this loader reads. Everything is re-checked. */
interface ShellArtManifest {
  readonly schema: string;
  readonly images: readonly {
    readonly file: string;
    readonly role: string;
    readonly width: number;
    readonly height: number;
  }[];
  readonly font1: { readonly rows: number; readonly metrics: readonly (readonly number[])[] };
  readonly font2: { readonly rows: number; readonly metrics: readonly (readonly number[])[] };
  readonly palettes: {
    readonly live: number;
    readonly rows: readonly { readonly aga: readonly number[]; readonly rgb: readonly number[] }[];
  };
  readonly sine: readonly number[];
  readonly dissolve: readonly (readonly number[])[];
}

function fail(reason: string): never {
  throw new Error(`shell art manifest: ${reason}`);
}

/** Validates the parsed manifest JSON far enough to trust its shape. */
export function shellArtManifestFrom(parsed: unknown): ShellArtManifest {
  const doc = parsed as Partial<ShellArtManifest> | null;
  if (doc === null || typeof doc !== "object") fail("not an object");
  if (doc.schema !== SHELL_ART_SCHEMA) fail(`schema is ${String(doc.schema)}`);
  if (!Array.isArray(doc.images) || doc.images.length !== 5) fail("expected 5 images");
  for (const font of [doc.font1, doc.font2]) {
    if (font === undefined || !Array.isArray(font.metrics)) fail("font metrics missing");
    for (const entry of font.metrics) {
      if (!Array.isArray(entry) || entry.length !== 3) fail("metric entry is not a triple");
    }
  }
  if (doc.font1?.metrics.length !== 128) fail("font1 must carry 128 metric entries");
  if (doc.font2?.metrics.length !== 256) fail("font2 must carry 256 metric entries");
  // The palette block is where the v1 manifest was wrong, so it is checked
  // hardest: sixteen rows, sixteen colours each, and every live row a ramp that
  // starts at black. A manifest whose page palettes do not start black would put
  // a coloured field back under the text.
  const palettes = doc.palettes;
  if (palettes === undefined || !Array.isArray(palettes.rows)) fail("palettes missing");
  if (palettes.rows.length !== SHELL_PALETTE_COUNT) {
    fail(`expected ${SHELL_PALETTE_COUNT} palettes, got ${palettes.rows.length}`);
  }
  if (palettes.live !== SHELL_PALETTE_LIVE) fail(`palettes.live is ${String(palettes.live)}`);
  for (let p = 0; p < palettes.rows.length; p += 1) {
    const row = palettes.rows[p];
    if (row === undefined || !Array.isArray(row.aga) || !Array.isArray(row.rgb)) {
      fail(`palette ${p} is not {aga, rgb}`);
    }
    if (row.aga.length !== SHELL_PALETTE_COLOURS || row.rgb.length !== SHELL_PALETTE_COLOURS * 3) {
      fail(`palette ${p} is ${row.aga.length} colours / ${row.rgb.length} bytes`);
    }
    if (p < SHELL_PALETTE_LIVE && row.aga[0] !== 0) {
      fail(`live palette ${p} does not start at black`);
    }
  }
  if (!Array.isArray(doc.sine) || doc.sine.length !== 256) fail("sine table must have 256 entries");
  if (!Array.isArray(doc.dissolve) || doc.dissolve.length !== 4) fail("expected 4 dissolve tables");
  for (const order of doc.dissolve) {
    if (!Array.isArray(order) || new Set(order).size !== 256) {
      fail("dissolve table is not a permutation of 0..255");
    }
  }
  return doc as ShellArtManifest;
}

// ---------------------------------------------------------------------------
// Assembling fonts and backdrops
// ---------------------------------------------------------------------------

/**
 * Resolves a metrics table against its decoded atlas.
 *
 * The accumulation is `main.bin`'s: glyph row offset = sum of preceding
 * heights. The total must equal the atlas PNG's height exactly — that equality
 * is what proves the two files describe the same font.
 */
export function shellFontFrom(
  metrics: readonly (readonly number[])[],
  atlas: IndexedImage,
  name: string,
): ShellFont {
  if (atlas.width !== FONT_ATLAS_WIDTH) {
    throw new Error(`${name} atlas is ${atlas.width} px wide, expected ${FONT_ATLAS_WIDTH}`);
  }
  const glyphs: ShellGlyph[] = [];
  let top = 0;
  for (const [advance = 0, height = 0, yOffset = 0] of metrics) {
    glyphs.push({ advance, height, yOffset, top });
    top += height;
  }
  if (top !== atlas.height) {
    throw new Error(
      `${name} metrics sum to ${top} atlas rows but the atlas is ${atlas.height} tall`,
    );
  }
  return { glyphs, pixels: atlas.indices, rows: atlas.height };
}

function shellBackdropFrom(role: ShellBackdropRole, image: IndexedImage): ShellBackdrop {
  if (image.width !== STRIP_WIDTH || image.height !== STRIP_HEIGHT) {
    throw new Error(
      `backdrop ${role} is ${image.width}x${image.height}, expected ${STRIP_WIDTH}x${STRIP_HEIGHT}`,
    );
  }
  return { role, pixels: image.indices };
}

/** Assembles the whole `ShellArt` from a parsed manifest and its five images. */
export function shellArtFrom(
  manifest: ShellArtManifest,
  imagesByRole: ReadonlyMap<string, IndexedImage>,
): ShellArt {
  const image = (role: string): IndexedImage => {
    const found = imagesByRole.get(role);
    if (found === undefined) throw new Error(`shell art image missing for role ${role}`);
    return found;
  };
  return {
    font1: shellFontFrom(manifest.font1.metrics, image("font1"), "font1"),
    font2: shellFontFrom(manifest.font2.metrics, image("font2"), "font2"),
    backdrops: {
      attract: shellBackdropFrom("attract", image("backdrop-attract")),
      menu: shellBackdropFrom("menu", image("backdrop-menu")),
      select: shellBackdropFrom("select", image("backdrop-select")),
    },
    palettes: manifest.palettes.rows.map((row) => ({
      aga: row.aga,
      rgb: Uint8Array.from(row.rgb),
    })),
    sine: manifest.sine,
    dissolve: manifest.dissolve,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// Wrapped rather than passing `fetch` itself, same as table-art.ts: an unbound
// reference to the global throws "Illegal invocation" in browsers.
const defaultFetch: TableArtFetch = (url) => fetch(url);

async function fetchBytes(url: string, fetchImpl: TableArtFetch): Promise<Uint8Array> {
  const response: TableArtResponse = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetches and decodes the shell's whole presentation: one manifest, five PNGs.
 *
 * All five images are fetched in parallel and everything is validated before
 * anything is returned — a shell skin with one font missing is not a skin.
 */
export async function loadShellArt(
  fetchImpl: TableArtFetch = defaultFetch,
  basePath: string = SHELL_ART_BASE_PATH,
): Promise<ShellArt> {
  const manifestBytes = await fetchBytes(`${basePath}${SHELL_ART_MANIFEST}`, fetchImpl);
  const manifest = shellArtManifestFrom(
    JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown,
  );
  const images = new Map<string, IndexedImage>();
  await Promise.all(
    manifest.images.map(async (entry) => {
      const decoded = await decodeIndexedPng(await fetchBytes(`${basePath}${entry.file}`, fetchImpl));
      if (decoded.width !== entry.width || decoded.height !== entry.height) {
        throw new Error(
          `${entry.file} is ${decoded.width}x${decoded.height}, ` +
            `manifest says ${entry.width}x${entry.height}`,
        );
      }
      images.set(entry.role, decoded);
    }),
  );
  return shellArtFrom(manifest, images);
}
