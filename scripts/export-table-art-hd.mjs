// No shebang: `tests/hd-assets.test.ts` imports this file as a module, and
// vite-node's vm wrapper rejects a hashbang that is no longer at byte 0 in a
// checkout it chooses to inline (a git worktree, CI). Run it as `node
// scripts/<name>.mjs`, which never needed the line - hd-pipeline.mjs, the
// library half of this pipeline, has always been shebang-free for the same
// reason.
// Exports the HD playfield masters and the per-lamp dim-patch atlases:
//
//   tables/<t>.art-hd.png    1344x2400 — the shipped 336x600 artwork, every
//                            lamp lit, de-dithered and xBRZ-4x upscaled
//   tables/<t>.art-hd.json   manifest: dims, sha256, full pipeline provenance
//   tables/<t>.lamps-hd.png  atlas of per-lamp DIM patches cut from the same
//                            upscale of the all-dim board
//   tables/<t>.lamps-hd.json patch geometry + manifest
//
// WHY PATCHES, AND WHY THEY ARE EXACT. Illusions' disk art stores every insert
// LIT; the original's off blit flips palette bit 7 to reveal the artist's dim
// variants. That palette trick has no truecolor equivalent, so the dim faces
// are precomputed: the all-dim board (every plane-7 lamp's mask re-indexed
// `index|0x80`, every masked-kind lamp on its off face — the runtime's own
// arithmetic) is upscaled with IDENTICAL settings, and each lamp's patch is
// the crop of that upscale at the lamp's rect + 12 HD px. xBRZ's divergence
// between the two boards is measurably confined to that dilation
// (research/hd/INDEX.txt section 4), so compositing a patch over the lit
// master reproduces the true all-dim upscale EXACTLY — zero seams, zero
// missed pixels, verified on all three tables and pinned by test.
//
// Deterministic: re-running writes byte-identical files. `--check` verifies
// the shipped files match a fresh run instead of writing.
//
// Usage:  node scripts/export-table-art-hd.mjs [--check]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  HD_SCALE,
  LAMP_PATCH_DILATION_HD,
  NATIVE_HEIGHT,
  NATIVE_WIDTH,
  XBRZ_TOOL,
  blitIntoAtlas,
  composeBoardIndices,
  cropPixels,
  decodeIndexedPng,
  encodePng,
  lampPatchRect,
  packAtlas,
  sha256,
  upscaleBoard,
} from "./hd-pipeline.mjs";

const TABLES = ["law-n-justice", "babewatch", "extreme-sports"];
const OUT_DIR = "public/generated/tables";
const HD_WIDTH = NATIVE_WIDTH * HD_SCALE;
const HD_HEIGHT = NATIVE_HEIGHT * HD_SCALE;

/** Builds every HD artifact for one table, in memory. Pure given the inputs. */
export function buildTableArtHd(tableId, artPng, lampsJson) {
  const art = decodeIndexedPng(artPng);
  if (art.width !== NATIVE_WIDTH || art.height !== NATIVE_HEIGHT) {
    throw new Error(`${tableId} artwork is ${art.width}x${art.height}, expected ${NATIVE_WIDTH}x${NATIVE_HEIGHT}`);
  }
  const lampsDoc = JSON.parse(lampsJson.toString("utf8"));
  if (lampsDoc.tableId !== tableId) {
    throw new Error(`lamp document names ${lampsDoc.tableId}, expected ${tableId}`);
  }

  const lit = upscaleBoard(composeBoardIndices(art, lampsDoc, true), art.palette);
  const dim = upscaleBoard(composeBoardIndices(art, lampsDoc, false), art.palette);

  // Every lamp with pixels gets one dim patch. There are no lit patches: the
  // master already shows every lamp lit (masked kinds included — the lit
  // board is composed with their on faces), so a visibly lit lamp draws
  // nothing, which is the same polarity the native renderer has.
  const lamps = lampsDoc.lamps.filter((lamp) => lamp.kind !== "none");
  const cells = lamps.map((lamp) => {
    const rect = lampPatchRect(lamp);
    return {
      key: String(lamp.index).padStart(3, "0"),
      lamp,
      rect,
      width: rect.width,
      height: rect.height,
      pixels: cropPixels(dim.rgb, HD_WIDTH, 3, rect),
    };
  });
  const atlas = packAtlas(cells);
  const atlasPixels = new Uint8Array(atlas.width * atlas.height * 3);
  for (const cell of cells) {
    blitIntoAtlas(atlasPixels, atlas.width, 3, cell, atlas.placed.get(cell.key));
  }

  const artHdPng = encodePng(lit.rgb, HD_WIDTH, HD_HEIGHT, 3);
  const lampsHdPng = encodePng(atlasPixels, atlas.width, atlas.height, 3);

  const sources = [
    { file: `${tableId}.art.png`, sha256: sha256(artPng) },
    { file: `${tableId}.lamps.json`, sha256: sha256(lampsJson) },
  ];
  const pipeline = (board, dedither) => ({
    algorithm: "de-dither (exact 1x1/2x2 checkerboard averaging) then xBRZ 4x",
    xbrz: XBRZ_TOOL,
    board,
    dedither,
    sources,
  });

  const artManifest = {
    schema: "pinball-illusions/table-art-hd/v1",
    tableId,
    displayName: lampsDoc.displayName,
    width: HD_WIDTH,
    height: HD_HEIGHT,
    scale: HD_SCALE,
    image: {
      file: `${tableId}.art-hd.png`,
      format: "png-rgb-8bit",
      byteLength: artHdPng.length,
      sha256: sha256(artHdPng),
    },
    provenance: {
      sourceClass: "disk-derived-playfield-artwork-hd",
      description:
        "HD (4x) playfield master derived from the shipped disk artwork by a deterministic local " +
        "upscale. All-lit board: the shipped 336x600 picture with every masked-kind lamp on its " +
        "lit face. Still image only: no audio, no executable code.",
      authorizationRequired: true,
      pipeline: pipeline(
        "all-lit: shipped artwork indices; masked-kind lamps forced to their on faces",
        lit.dedither,
      ),
    },
  };

  const lampsManifest = {
    schema: "pinball-illusions/table-lamps-hd/v1",
    tableId,
    displayName: lampsDoc.displayName,
    scale: HD_SCALE,
    dilationHd: LAMP_PATCH_DILATION_HD,
    image: {
      file: `${tableId}.lamps-hd.png`,
      format: "png-rgb-8bit",
      byteLength: lampsHdPng.length,
      sha256: sha256(lampsHdPng),
    },
    atlas: { width: atlas.width, height: atlas.height },
    patches: cells.map((cell) => {
      const at = atlas.placed.get(cell.key);
      return {
        index: cell.lamp.index,
        kind: cell.lamp.kind,
        atlasX: at.x,
        atlasY: at.y,
        destX: cell.rect.x,
        destY: cell.rect.y,
        width: cell.rect.width,
        height: cell.rect.height,
      };
    }),
    provenance: {
      sourceClass: "disk-derived-lamp-overlays-hd",
      description:
        "HD (4x) per-lamp DIM patches, cut from an identical-settings upscale of the all-dim " +
        "board (plane-7 lamps re-indexed index|0x80, masked-kind lamps on their off faces — the " +
        "runtime's own dim arithmetic). Compositing a patch over the lit master reproduces the " +
        "all-dim upscale exactly. Still image only: no audio, no executable code.",
      authorizationRequired: true,
      pipeline: pipeline(
        "all-dim: plane-7 lamp mask pixels index|0x80; masked-kind lamps forced to their off faces",
        dim.dedither,
      ),
    },
  };

  return { artHdPng, artManifest, lampsHdPng, lampsManifest, dimBoard: dim.rgb };
}

function main(argv) {
  const check = argv.includes("--check");
  let failures = 0;
  console.log(`export-table-art-hd — ${check ? "verifying" : "writing"} HD masters and lamp atlases`);
  for (const tableId of TABLES) {
    const artPng = readFileSync(join(OUT_DIR, `${tableId}.art.png`));
    const lampsJson = readFileSync(join(OUT_DIR, `${tableId}.lamps.json`));
    const built = buildTableArtHd(tableId, artPng, lampsJson);
    const files = [
      [`${tableId}.art-hd.png`, built.artHdPng],
      [`${tableId}.art-hd.json`, Buffer.from(JSON.stringify(built.artManifest), "utf8")],
      [`${tableId}.lamps-hd.png`, built.lampsHdPng],
      [`${tableId}.lamps-hd.json`, Buffer.from(JSON.stringify(built.lampsManifest), "utf8")],
    ];
    for (const [name, bytes] of files) {
      const path = join(OUT_DIR, name);
      if (check) {
        const existing = existsSync(path) ? readFileSync(path) : null;
        if (existing !== null && existing.equals(bytes)) {
          console.log(`  ${name.padStart(28)}: identical (${bytes.length.toLocaleString()} bytes)`);
        } else {
          console.error(`  ${name.padStart(28)}: DIFFERS${existing === null ? " (missing)" : ""}`);
          failures += 1;
        }
      } else {
        writeFileSync(path, bytes);
        console.log(`  ${name.padStart(28)}: ${bytes.length.toLocaleString()} bytes`);
      }
    }
  }
  if (failures > 0) {
    console.error(`${failures} file(s) differ from a fresh deterministic run`);
    return 1;
  }
  return 0;
}

// Importable for tests; a direct run executes.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  process.exit(main(process.argv.slice(2)));
}
