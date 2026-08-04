/**
 * Ambient types for the HD exporter pipeline (`scripts/*.mjs`), which the HD
 * asset tests import to regenerate assets in-process and prove the shipped
 * bytes are the pipeline's own output. The scripts are plain node ESM — vitest
 * executes them as-is — and these declarations exist only so `tsc --noEmit`
 * can check the tests that call them. Keep the shapes in step with the
 * exported functions; a drift here fails the typecheck, not the tests.
 */

declare module "*hd-pipeline.mjs" {
  export const NATIVE_WIDTH: number;
  export const NATIVE_HEIGHT: number;
  export const HD_SCALE: number;
  export const LAMP_PATCH_DILATION_HD: number;
  export const XBRZ_TOOL: string;
  export function sha256(bytes: Uint8Array): string;
  export function decodeIndexedPng(bytes: Buffer): {
    width: number;
    height: number;
    indices: Uint8Array;
    palette: Uint8Array;
  };
  export function encodePng(
    pixels: Uint8Array,
    width: number,
    height: number,
    channels: 3 | 4,
  ): Buffer;
  export function lampMaskBits(lamp: unknown): Uint8Array;
  export function composeBoardIndices(
    art: { width: number; height: number; indices: Uint8Array; palette: Uint8Array },
    lampsDoc: unknown,
    lit: boolean,
  ): Uint8Array;
  export function indicesToRgb(indices: Uint8Array, palette: Uint8Array): Uint8Array;
  export function deditherRgb(
    rgb: Uint8Array,
    width: number,
    height: number,
  ): { rgb: Uint8Array; stats: { checker1x1Px: number; checker2x2Px: number } };
  export function xbrzScaleRgba(rgba: Uint8Array, width: number, height: number): Uint8Array;
  export function xbrzScaleRgb(rgb: Uint8Array, width: number, height: number): Uint8Array;
  export function upscaleBoard(
    indices: Uint8Array,
    palette: Uint8Array,
  ): { rgb: Uint8Array; dedither: { checker1x1Px: number; checker2x2Px: number } };
  export function lampPatchRect(lamp: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): { x: number; y: number; width: number; height: number };
  export function cropPixels(
    pixels: Uint8Array,
    stride: number,
    channels: number,
    rect: { x: number; y: number; width: number; height: number },
  ): Uint8Array;
  export function packAtlas(
    cells: readonly { key: string; width: number; height: number }[],
    maxWidth?: number,
  ): { width: number; height: number; placed: Map<string, { x: number; y: number }> };
  export function ballRgba(ballDoc: unknown, palette: Uint8Array): Uint8Array;
  export function batPoseRgba(pose: unknown, plane2RowOffset: number, palette: Uint8Array): Uint8Array;
  // Phase 3, the shell's index-map recipes.
  export const SHELL_INK_RAMP: readonly number[];
  export const SHELL_RAMP_PALETTE: Uint8Array;
  export function encodeIndexedPng(
    indices: Uint8Array,
    width: number,
    height: number,
    paletteRgb: Uint8Array,
    transparentCount?: number,
  ): Buffer;
  export function agaPaletteRgb(aga: readonly number[], colours?: number): Uint8Array;
  export function paintIndices(indices: Uint8Array, paletteRgb: Uint8Array): Uint8Array;
  export function xbrzIndexVote(
    indices: Uint8Array,
    width: number,
    height: number,
    palettes: readonly Uint8Array[],
    colours: number,
  ): Uint8Array;
  export function xbrzRampMap(values: Uint8Array, width: number, height: number): Uint8Array;
  export function xbrzIndexedRgba(
    indices: Uint8Array,
    width: number,
    height: number,
    paletteRgb: Uint8Array,
  ): Uint8Array;
}

declare module "*export-shell-art-hd.mjs" {
  export const SHELL_ART_HD_SCHEMA: string;
  export const LOADING_LOGO_HD_SCHEMA: string;
  export const SHELL_BACKDROP_ROLES: readonly string[];
  export const VOTING_PALETTES: number;
  export function buildShellArtHd(): {
    files: Map<string, Buffer>;
    dither: Record<string, { checker1x1Px: number; checker2x2Px: number }>;
  };
}

declare module "*export-table-art-hd.mjs" {
  export function buildTableArtHd(
    tableId: string,
    artPng: Buffer,
    lampsJson: Buffer,
  ): {
    artHdPng: Buffer;
    artManifest: { image: { sha256: string } };
    lampsHdPng: Buffer;
    lampsManifest: { image: { sha256: string } };
    dimBoard: Uint8Array;
  };
}

declare module "*export-moving-sprites-hd.mjs" {
  export function buildMovingSpritesHd(
    tableId: string,
    artPng: Buffer,
    ballJson: Buffer,
    batsJson: Buffer,
  ): {
    ballHdPng: Buffer;
    ballManifest: { image: { sha256: string } };
    batsHdPng: Buffer;
    batsManifest: { image: { sha256: string } };
  };
}
