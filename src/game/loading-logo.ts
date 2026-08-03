/**
 * Loader for the shipped LOADING LOGO (`public/generated/shell/`).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHY IT IS NOT PART OF `shell-art.ts`
 * ---------------------------------------------------------------------------
 * The word the original puts on screen while it reads a table off floppy is not
 * shell art. `menudata.bin` does not contain it and `main.bin` does not draw it:
 * it belongs to the LOADER, `Pinball`, the 25 KB AmigaDOS executable the
 * Startup-Sequence runs, and it is a copper screen of its own — sixteen raster
 * lines of five-bitplane picture on a screen that is otherwise border colour,
 * with its own 32-entry palette in its own copper list. That is why every
 * earlier round left it undecoded and drew the word in the menu font instead,
 * and it is why it ships as its own manifest with its own provenance rather
 * than as a sixth image on the shell artwork's.
 *
 * `scripts/export-loading-logo.mjs` does the decode and carries the whole
 * derivation, including the loader's own symbol table (`LoadingCop`,
 * `LoadingGfx`) that locates it. This module only fetches and re-checks.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT SITS, WHICH IS NOT WHERE THE FILM APPEARS TO PUT IT
 * ---------------------------------------------------------------------------
 * `placement.top` is 84, not the 120 five filmed captures measure, and the
 * difference is an artefact of the capture rig rather than a disagreement about
 * the machine. The loader's copper puts the strip at raster lines 128..143;
 * `main.bin`'s shell display is DIWSTRT $2c81, raster 44..299. 128 - 44 = 84.
 * The captures were taken through WinUAE with `gfx_center_vertical=smart`,
 * which re-centres the output window whenever the emulated display changes
 * height — and both filmed displays land on their exact centre: the 256-line
 * shell screen at window line 16 of 287 and the 16-line loading screen at
 * window line 136 of 287. The boot take catches the window physically moving
 * over three frames between them. The HORIZONTAL is unaffected, because both
 * displays are 320 px at hpos $81, and the film confirms x 90..236 exactly.
 *
 * Pure decode + validation, no DOM: a test loads the shipped files off disk in
 * node and asserts on them, the same argument as `shell-art.ts`. Only
 * `loadLoadingLogo` touches the network.
 */

import { decodeIndexedPng } from "./table-art.js";
import type { TableArtFetch, TableArtResponse } from "./table-art.js";
import { SHELL_ART_BASE_PATH } from "./shell-art.js";

export const LOADING_LOGO_SCHEMA = "pinball-illusions/loading-logo/v1";
export const LOADING_LOGO_MANIFEST = "loading.art.json";

/** The loader's display: 320 px of lores, sixteen raster lines, five planes. */
export const LOADING_LOGO_WIDTH = 320;
export const LOADING_LOGO_HEIGHT = 16;
export const LOADING_LOGO_PLANES = 5;
export const LOADING_LOGO_COLOURS = 1 << LOADING_LOGO_PLANES;

/**
 * The strip's first row on the shell's own 320 x 256 screen.
 *
 * Raster 128 (the loader's DIWSTRT) minus raster 44 (`main.bin`'s). See the
 * header for why the film's 120 is not this number.
 */
export const LOADING_LOGO_TOP = 84;

/** Columns the word's ink occupies, out of the 320. Confirmed on film. */
export const LOADING_INK_LEFT = 90;
export const LOADING_INK_RIGHT = 236;

export interface LoadingLogo {
  readonly width: number;
  readonly height: number;
  /** One 5-bit palette index per pixel, row-major. 0 is the bare screen. */
  readonly indices: Uint8Array;
  /** 32 colours as 96 bytes, r,g,b per entry, out of the loader's copper list. */
  readonly rgb: Uint8Array;
  /** The same 32 colours as AGA `$0RGB` words, for anything checking the disk. */
  readonly aga: readonly number[];
  /** First row of the strip on the shell's 320 x 256 screen. */
  readonly top: number;
  /** The ink box within the strip: `{left, right, top, bottom}`, inclusive. */
  readonly ink: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
}

interface LoadingLogoManifest {
  readonly schema: string;
  readonly image: { readonly file: string; readonly width: number; readonly height: number };
  readonly planes: number;
  readonly placement: { readonly top: number };
  readonly ink: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly palette: { readonly aga: readonly number[]; readonly rgb: readonly number[] };
}

function fail(reason: string): never {
  throw new Error(`loading logo manifest: ${reason}`);
}

/** Validates the parsed manifest JSON far enough to trust its shape. */
export function loadingLogoManifestFrom(parsed: unknown): LoadingLogoManifest {
  const doc = parsed as Partial<LoadingLogoManifest> | null;
  if (doc === null || typeof doc !== "object") fail("not an object");
  if (doc.schema !== LOADING_LOGO_SCHEMA) fail(`schema is ${String(doc.schema)}`);
  const image = doc.image;
  if (image === undefined || typeof image.file !== "string") fail("no image");
  if (image.width !== LOADING_LOGO_WIDTH || image.height !== LOADING_LOGO_HEIGHT) {
    fail(`image is ${image.width}x${image.height}, expected ${LOADING_LOGO_WIDTH}x${LOADING_LOGO_HEIGHT}`);
  }
  if (doc.planes !== LOADING_LOGO_PLANES) fail(`planes is ${String(doc.planes)}`);
  if (doc.placement?.top !== LOADING_LOGO_TOP) fail(`placement.top is ${String(doc.placement?.top)}`);
  const ink = doc.ink;
  if (ink === undefined) fail("no ink box");
  if (ink.left !== LOADING_INK_LEFT || ink.right !== LOADING_INK_RIGHT) {
    fail(`ink spans columns ${ink.left}..${ink.right}`);
  }
  if (ink.top !== 0 || ink.bottom !== LOADING_LOGO_HEIGHT - 1) {
    fail(`ink spans rows ${ink.top}..${ink.bottom}`);
  }
  const palette = doc.palette;
  if (palette === undefined || !Array.isArray(palette.aga) || !Array.isArray(palette.rgb)) {
    fail("palette is not {aga, rgb}");
  }
  if (palette.aga.length !== LOADING_LOGO_COLOURS || palette.rgb.length !== LOADING_LOGO_COLOURS * 3) {
    fail(`palette is ${palette.aga.length} colours / ${palette.rgb.length} bytes`);
  }
  // Index 0 is the bare screen and the loader clears it to black; a palette that
  // did not would draw a coloured box over the whole 320 x 16 strip.
  if (palette.aga[0] !== 0) fail("colour 0 is not black");
  for (const word of palette.aga) {
    if (!Number.isInteger(word) || word < 0 || word > 0x0fff) fail(`${word} is not a 12-bit word`);
  }
  return doc as LoadingLogoManifest;
}

// Wrapped rather than passing `fetch` itself, same as shell-art.ts: an unbound
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
 * Fetches and decodes the logo: one manifest, one PNG.
 *
 * The PNG's own PLTE is checked against the manifest's copper words rather than
 * trusted — the two are written by the same exporter from the same copper list,
 * so a mismatch means one of the pair was replaced.
 */
export async function loadLoadingLogo(
  fetchImpl: TableArtFetch = defaultFetch,
  basePath: string = SHELL_ART_BASE_PATH,
): Promise<LoadingLogo> {
  const manifestBytes = await fetchBytes(`${basePath}${LOADING_LOGO_MANIFEST}`, fetchImpl);
  const manifest = loadingLogoManifestFrom(
    JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown,
  );
  const image = await decodeIndexedPng(
    await fetchBytes(`${basePath}${manifest.image.file}`, fetchImpl),
  );
  if (image.width !== LOADING_LOGO_WIDTH || image.height !== LOADING_LOGO_HEIGHT) {
    throw new Error(
      `${manifest.image.file} is ${image.width}x${image.height}, ` +
        `manifest says ${LOADING_LOGO_WIDTH}x${LOADING_LOGO_HEIGHT}`,
    );
  }
  if (image.paletteEntries < LOADING_LOGO_COLOURS) {
    throw new Error(`${manifest.image.file} carries ${image.paletteEntries} palette entries`);
  }
  const rgb = Uint8Array.from(manifest.palette.rgb);
  for (let i = 0; i < rgb.length; i += 1) {
    if (image.palette[i] !== rgb[i]) {
      throw new Error(`${manifest.image.file} PLTE byte ${i} disagrees with the manifest palette`);
    }
  }
  return {
    width: image.width,
    height: image.height,
    indices: image.indices,
    rgb,
    aga: manifest.palette.aga,
    top: manifest.placement.top,
    ink: manifest.ink,
  };
}
