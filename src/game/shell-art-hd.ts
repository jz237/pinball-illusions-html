/**
 * Loaders for the HD (4x) SHELL presentation set — phase 3 of the HD pass.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE, AND WHY THEY ARE INDEX MAPS RATHER THAN PICTURES
 * ---------------------------------------------------------------------------
 * Written by `scripts/export-shell-art-hd.mjs` from files this project already
 * ships; the disks are never re-read.
 *
 *   shell-backdrop-<role>-hd.png  5888 x 128 index map of a tumbling-object
 *                                 strip, 16 entries
 *   shell-font<n>-hd.png          the two menu fonts' PLANE-VALUE maps at 4x,
 *                                 4 entries: 0 no ink, 1/2/3 the ink ramp
 *   loading-logo-hd.png           1280 x 64 RGBA — the loader's own strip
 *
 * The backdrops and the fonts cannot ship as finished pictures, because both
 * are re-coloured at runtime and must go on being re-coloured: `shell-skin.ts`
 * repaints a strip every frame of a page-palette fade, one nibble per gun per
 * frame, and paints a font atlas in whatever ink a screen asks for. So what
 * ships is the same SHAPE of data `shell-art.ts` already loads — indices — only
 * four times as many of them, and every scrap of the runtime's colour
 * arithmetic is untouched. The loading logo is the exception: its 32 colours
 * come out of the loader's own copper list and are written once and never
 * faded, so it ships as finished RGBA and loses nothing to quantisation.
 *
 * ---------------------------------------------------------------------------
 * PRESENTATION ONLY, AND OPTIONAL
 * ---------------------------------------------------------------------------
 * Exactly the contract of `table-art-hd.ts`, for exactly the same reasons. No
 * simulation module imports this. A build without these files draws the shell
 * through the native path unchanged, loudly; the native artwork stays REQUIRED
 * and HD is a magnifier on the real picture, never a substitute. Dimensions are
 * checked against the manifest and the manifest's sha256 is verified over the
 * fetched bytes wherever `crypto.subtle` exists.
 */

import { decodeIndexedPng } from "./table-art.js";
import type { TableArtFetch, TableArtResponse } from "./table-art.js";
import { decodeTruecolorPng, HD_ASSET_SCALE } from "./table-art-hd.js";
import type { HdImage } from "./table-art-hd.js";
import { FONT_ATLAS_WIDTH, SHELL_ART_BASE_PATH, STRIP_HEIGHT, STRIP_WIDTH } from "./shell-art.js";
import type { ShellBackdropRole } from "./shell-art.js";
import { LOADING_LOGO_HEIGHT, LOADING_LOGO_WIDTH } from "./loading-logo.js";

export const SHELL_ART_HD_SCHEMA = "pinball-illusions/shell-art-hd/v1";
export const SHELL_ART_HD_MANIFEST = "shell.art-hd.json";
export const LOADING_LOGO_HD_SCHEMA = "pinball-illusions/loading-logo-hd/v1";
export const LOADING_LOGO_HD_MANIFEST = "loading.art-hd.json";

/** One upscaled index map: `width * height` entries, row-major. */
export interface HdIndexMap {
  readonly width: number;
  readonly height: number;
  readonly indices: Uint8Array;
}

/** The whole HD shell set, as `shell-skin.ts` wants it. */
export interface ShellArtHd {
  /** The scale every map in here is at. 4. */
  readonly scale: number;
  readonly backdrops: Readonly<Record<ShellBackdropRole, HdIndexMap>>;
  readonly font1: HdIndexMap;
  readonly font2: HdIndexMap;
}

/** The HD loading logo: finished RGBA, plus the row it sits on (unchanged). */
export interface LoadingLogoHd extends HdImage {
  readonly scale: number;
  readonly top: number;
}

const ROLES: readonly ShellBackdropRole[] = ["attract", "menu", "select"];

interface ManifestImage {
  readonly file: string;
  readonly role: string;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what} is not a number`);
  }
  return value;
}

async function fetchBytes(fetcher: TableArtFetch, url: string): Promise<Uint8Array> {
  const response: TableArtResponse = await fetcher(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The manifest's digest over the bytes actually fetched.
 *
 * Skipped, not faked, where the runtime has no `crypto.subtle` — an insecure
 * browsing context has one, node has one, and a runtime with neither gets the
 * dimension checks and nothing pretending to be a digest check.
 */
async function verifyDigest(bytes: Uint8Array, expected: string, what: string): Promise<void> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return;
  const digest = await subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hex !== expected) {
    throw new Error(`${what}: sha256 ${hex.slice(0, 16)} does not match the manifest's ${expected.slice(0, 16)}`);
  }
}

async function loadIndexMap(
  fetcher: TableArtFetch,
  image: ManifestImage,
  expectedWidth: number,
  expectedHeight: number,
): Promise<HdIndexMap> {
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    throw new Error(
      `${image.file}: manifest says ${image.width}x${image.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  const bytes = await fetchBytes(fetcher, `${SHELL_ART_BASE_PATH}${image.file}`);
  await verifyDigest(bytes, image.sha256, image.file);
  const decoded = await decodeIndexedPng(bytes);
  if (decoded.width !== expectedWidth || decoded.height !== expectedHeight) {
    throw new Error(
      `${image.file} is ${decoded.width}x${decoded.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  return { width: decoded.width, height: decoded.height, indices: decoded.indices };
}

/**
 * The HD shell artwork, or a rejection. Callers catch and fall back — a shell
 * without this set draws exactly what it drew before HD existed.
 */
export async function loadShellArtHd(
  fetcher: TableArtFetch = (url) => fetch(url),
): Promise<ShellArtHd> {
  const manifestBytes = await fetchBytes(fetcher, `${SHELL_ART_BASE_PATH}${SHELL_ART_HD_MANIFEST}`);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
  const doc = parsed as { schema?: unknown; scale?: unknown; images?: unknown };
  if (doc.schema !== SHELL_ART_HD_SCHEMA) {
    throw new Error(`${SHELL_ART_HD_MANIFEST}: schema is ${String(doc.schema)}`);
  }
  const scale = requireNumber(doc.scale, `${SHELL_ART_HD_MANIFEST} scale`);
  if (scale !== HD_ASSET_SCALE) {
    throw new Error(`${SHELL_ART_HD_MANIFEST}: scale is ${scale}, expected ${HD_ASSET_SCALE}`);
  }
  if (!Array.isArray(doc.images)) throw new Error(`${SHELL_ART_HD_MANIFEST}: no images array`);
  const images = doc.images as readonly ManifestImage[];
  const byRole = new Map<string, ManifestImage>();
  for (const image of images) byRole.set(image.role, image);

  const backdrops: Partial<Record<ShellBackdropRole, HdIndexMap>> = {};
  for (const role of ROLES) {
    const image = byRole.get(role);
    if (image === undefined) throw new Error(`${SHELL_ART_HD_MANIFEST}: no ${role} backdrop`);
    backdrops[role] = await loadIndexMap(
      fetcher,
      image,
      STRIP_WIDTH * scale,
      STRIP_HEIGHT * scale,
    );
  }

  const fonts: HdIndexMap[] = [];
  for (const role of ["font1", "font2"] as const) {
    const image = byRole.get(role);
    if (image === undefined) throw new Error(`${SHELL_ART_HD_MANIFEST}: no ${role}`);
    // The atlas's row count is the font's own; only its width is pinned here,
    // because a font's height is data and this loader is not the place that
    // decides it. The height is checked against the native atlas by the caller
    // (`shell-skin.ts` indexes it with the native font's own glyph metrics).
    fonts.push(await loadIndexMap(fetcher, image, FONT_ATLAS_WIDTH * scale, image.height));
  }

  const [font1, font2] = fonts;
  if (font1 === undefined || font2 === undefined) {
    throw new Error(`${SHELL_ART_HD_MANIFEST}: both fonts are required`);
  }
  return {
    scale,
    backdrops: backdrops as Record<ShellBackdropRole, HdIndexMap>,
    font1,
    font2,
  };
}

/** The HD loading strip, or a rejection. Nullable at the call site, as native is. */
export async function loadLoadingLogoHd(
  fetcher: TableArtFetch = (url) => fetch(url),
): Promise<LoadingLogoHd> {
  const manifestBytes = await fetchBytes(
    fetcher,
    `${SHELL_ART_BASE_PATH}${LOADING_LOGO_HD_MANIFEST}`,
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
  const doc = parsed as {
    schema?: unknown;
    scale?: unknown;
    placement?: { top?: unknown };
    image?: ManifestImage;
  };
  if (doc.schema !== LOADING_LOGO_HD_SCHEMA) {
    throw new Error(`${LOADING_LOGO_HD_MANIFEST}: schema is ${String(doc.schema)}`);
  }
  const scale = requireNumber(doc.scale, `${LOADING_LOGO_HD_MANIFEST} scale`);
  const image = doc.image;
  if (image === undefined) throw new Error(`${LOADING_LOGO_HD_MANIFEST}: no image`);
  const width = LOADING_LOGO_WIDTH * scale;
  const height = LOADING_LOGO_HEIGHT * scale;
  if (image.width !== width || image.height !== height) {
    throw new Error(
      `${image.file}: manifest says ${image.width}x${image.height}, expected ${width}x${height}`,
    );
  }
  const bytes = await fetchBytes(fetcher, `${SHELL_ART_BASE_PATH}${image.file}`);
  await verifyDigest(bytes, image.sha256, image.file);
  const decoded = await decodeTruecolorPng(bytes);
  if (decoded.width !== width || decoded.height !== height) {
    throw new Error(`${image.file} is ${decoded.width}x${decoded.height}, expected ${width}x${height}`);
  }
  return {
    scale,
    top: requireNumber(doc.placement?.top, `${LOADING_LOGO_HD_MANIFEST} placement.top`),
    width: decoded.width,
    height: decoded.height,
    data: decoded.data,
  };
}
