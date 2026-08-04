// Exports the HD (4x) SHELL presentation set — phase 3 of the HD pass.
//
// Reads only files this project already ships (`public/generated/shell/`); the
// disks are never re-read. Deterministic: same inputs, same bytes, no network,
// no clock. Run with `--check` to verify the shipped files are this code's
// output without writing anything.
//
//   node scripts/export-shell-art-hd.mjs [--check]
//
// ---------------------------------------------------------------------------
// WHY THE SHELL NEEDED ITS OWN EXPORTER
// ---------------------------------------------------------------------------
// The playfield exporter upscales RGB and ships RGB, because a board's palette
// never moves. The shell's does. `shell-skin.ts` repaints a backdrop strip
// every frame of a palette fade, and paints a font atlas in whatever ink a
// screen asks for. So both families ship as upscaled INDEX MAPS — the same
// shape of data `shell-art.ts` already loads — and every scrap of runtime
// colour arithmetic stays exactly where it is. The recipes and their
// measurements are in `hd-pipeline.mjs` (`xbrzIndexVote`, `xbrzRampMap`).
//
// The LOADING LOGO is the exception and gets the simple treatment: its 32
// colours come out of the loader's own copper list and are written once and
// never faded, so it can ship as finished RGBA with no quantisation loss at
// all.
//
// ---------------------------------------------------------------------------
// WHAT IT DELIBERATELY DOES NOT DO
// ---------------------------------------------------------------------------
// NO DE-DITHER PREPASS. The board recipe de-dithers first because 1995 AGA
// artwork is checkerboarded in places. These are not paintings: the strips are
// flat-shaded tumbling solids and the fonts are two-plane glyphs. The exporter
// COUNTS the checkerboard cells it would have merged and prints the count, so
// the claim is measured on every run rather than asserted here once.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HD_SCALE,
  SHELL_RAMP_PALETTE,
  agaPaletteRgb,
  decodeIndexedPng,
  deditherRgb,
  encodeIndexedPng,
  encodePng,
  paintIndices,
  sha256,
  xbrzIndexVote,
  xbrzIndexedRgba,
  xbrzRampMap,
  XBRZ_TOOL,
} from "./hd-pipeline.mjs";

const SHELL_DIR = fileURLToPath(new URL("../public/generated/shell/", import.meta.url));

export const SHELL_ART_HD_SCHEMA = "pinball-illusions/shell-art-hd/v1";
export const LOADING_LOGO_HD_SCHEMA = "pinball-illusions/loading-logo-hd/v1";

/** The three strips, in the order the backdrop selector's word table walks them. */
export const SHELL_BACKDROP_ROLES = Object.freeze(["attract", "menu", "select"]);

/**
 * Which palettes vote on an index map.
 *
 * Palettes 0..7 of the nine live ones. The ninth, palette 8, is the all-black
 * crossfade the service passes through to swap the strip: fifteen of its
 * sixteen entries are the same colour, so it can tell almost nothing apart and
 * would only add noise to the vote.
 */
export const VOTING_PALETTES = 8;

const read = (name) => readFileSync(`${SHELL_DIR}${name}`);
const readJson = (name) => JSON.parse(read(name).toString("utf8"));

/** How many exact-checkerboard pixels a de-dither prepass would have merged. */
function ditherCensus(indices, width, height, paletteRgb) {
  const { stats } = deditherRgb(paintIndices(indices, paletteRgb), width, height);
  return stats;
}

/**
 * Builds every HD shell file in memory: `{ name -> bytes }` plus the two
 * manifests. Exported so a test can regenerate the set in-process and compare
 * it byte for byte with what is shipped.
 */
export function buildShellArtHd() {
  const art = readJson("shell.art.json");
  const palettes = art.palettes.rows.map((row) => agaPaletteRgb(row.aga));
  const voters = palettes.slice(0, VOTING_PALETTES);
  const files = new Map();
  const images = [];
  const dither = {};

  for (const role of SHELL_BACKDROP_ROLES) {
    const source = decodeIndexedPng(read(`shell-backdrop-${role}.png`));
    dither[role] = ditherCensus(source.indices, source.width, source.height, palettes[0]);
    const hd = xbrzIndexVote(source.indices, source.width, source.height, voters, 16);
    const width = source.width * HD_SCALE;
    const height = source.height * HD_SCALE;
    // The PLTE carries page palette 0 so the file is viewable in any tool; the
    // runtime reads the INDICES and paints them through whatever the fade
    // service currently holds, exactly as it does the native strip.
    const bytes = encodeIndexedPng(hd, width, height, palettes[0]);
    const name = `shell-backdrop-${role}-hd.png`;
    files.set(name, bytes);
    images.push({
      file: name,
      role,
      kind: "index-map",
      width,
      height,
      colours: 16,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      source: { file: `shell-backdrop-${role}.png`, sha256: sha256(read(`shell-backdrop-${role}.png`)) },
    });
  }

  for (const role of ["font1", "font2"]) {
    const file = role === "font1" ? "shell-font1.png" : "shell-font2.png";
    const source = decodeIndexedPng(read(file));
    const hd = xbrzRampMap(source.indices, source.width, source.height);
    const width = source.width * HD_SCALE;
    const height = source.height * HD_SCALE;
    // tRNS on entry 0 alone: value 0 is "no ink", the backdrop shows through.
    const bytes = encodeIndexedPng(hd, width, height, SHELL_RAMP_PALETTE, 1);
    const name = `${file.slice(0, -4)}-hd.png`;
    files.set(name, bytes);
    images.push({
      file: name,
      role,
      kind: "plane-values",
      width,
      height,
      colours: 4,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      source: { file, sha256: sha256(read(file)) },
    });
  }

  const manifest = {
    schema: SHELL_ART_HD_SCHEMA,
    scale: HD_SCALE,
    images,
    provenance: {
      sourceClass: "disk-derived-shell-artwork-hd",
      description:
        `The shipped shell artwork at ${HD_SCALE}x. Backdrop strips are index maps ` +
        `upscaled by ${XBRZ_TOOL} through each of the first ${VOTING_PALETTES} live page ` +
        `palettes and reduced by per-pixel majority vote, so the runtime palette fade is ` +
        `unaffected; the two menu fonts are plane-value maps upscaled the same way against ` +
        `the original's own three-step ink ramp with alpha thresholded at half. No ` +
        `de-dither prepass: the exporter's own checkerboard census finds ` +
        `${SHELL_BACKDROP_ROLES.map((r) => `${r} ${dither[r].checker1x1Px}`).join(", ")} ` +
        `1x1 cells. Derived from disk artwork; still disk-derived.`,
      authorizationRequired: true,
    },
  };
  files.set("shell.art-hd.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));

  // ---------------------------------------------------------------------
  // The loading logo: a fixed palette, so finished RGBA rather than indices.
  // ---------------------------------------------------------------------
  const logoDoc = readJson("loading.art.json");
  const logoSource = decodeIndexedPng(read("loading-logo.png"));
  const logoRgba = xbrzIndexedRgba(
    logoSource.indices,
    logoSource.width,
    logoSource.height,
    logoSource.palette,
  );
  const logoWidth = logoSource.width * HD_SCALE;
  const logoHeight = logoSource.height * HD_SCALE;
  const logoBytes = encodePng(logoRgba, logoWidth, logoHeight, 4);
  files.set("loading-logo-hd.png", logoBytes);
  files.set(
    "loading.art-hd.json",
    Buffer.from(
      `${JSON.stringify(
        {
          schema: LOADING_LOGO_HD_SCHEMA,
          scale: HD_SCALE,
          placement: { top: logoDoc.placement.top },
          image: {
            file: "loading-logo-hd.png",
            width: logoWidth,
            height: logoHeight,
            byteLength: logoBytes.length,
            sha256: sha256(logoBytes),
          },
          source: { file: "loading-logo.png", sha256: sha256(read("loading-logo.png")) },
          provenance: {
            sourceClass: "disk-derived-loading-logo-hd",
            description:
              `The loader's own Loading strip at ${HD_SCALE}x, upscaled by ${XBRZ_TOOL} ` +
              `through its own fixed 32-colour copper palette with index 0 transparent. ` +
              `The palette never fades, so this ships as finished RGBA and loses nothing ` +
              `to quantisation. Derived from disk artwork; still disk-derived.`,
            authorizationRequired: true,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  );

  return { files, dither };
}

function main() {
  const check = process.argv.includes("--check");
  const { files, dither } = buildShellArtHd();
  let differed = 0;
  for (const [name, bytes] of files) {
    const path = `${SHELL_DIR}${name}`;
    let held = null;
    try {
      held = readFileSync(path);
    } catch {
      held = null;
    }
    const same = held !== null && held.length === bytes.length && held.equals(Buffer.from(bytes));
    if (check) {
      if (!same) {
        differed += 1;
        console.error(`  DIFFERS  ${name}${held === null ? " (missing)" : ""}`);
      }
      continue;
    }
    if (!same) writeFileSync(path, bytes);
    console.log(`  ${same ? "unchanged" : "written  "}  ${name}  ${bytes.length} bytes`);
  }
  for (const role of SHELL_BACKDROP_ROLES) {
    console.log(
      `  dither census ${role}: ${dither[role].checker1x1Px} 1x1 cells, ` +
        `${dither[role].checker2x2Px} 2x2 cells`,
    );
  }
  if (check) {
    if (differed > 0) {
      console.error(`export-shell-art-hd --check: ${differed} file(s) differ`);
      process.exit(1);
    }
    console.log("export-shell-art-hd --check: all shipped files match");
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main();
}
