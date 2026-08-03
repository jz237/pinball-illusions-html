// No shebang: `tests/hd-assets.test.ts` imports this file as a module, and
// vite-node's vm wrapper rejects a hashbang that is no longer at byte 0 in a
// checkout it chooses to inline (a git worktree, CI). Run it as `node
// scripts/<name>.mjs`, which never needed the line - hd-pipeline.mjs, the
// library half of this pipeline, has always been shebang-free for the same
// reason.
// Exports the HD moving sprites — the two things on a table that move:
//
//   tables/<t>.ball-hd.png   68x68 RGBA — the 17x17 disk ball sprite through
//                            the table palette, xBRZ-4x with its mask carried
//                            through as alpha
//   tables/<t>.ball-hd.json  manifest
//   tables/<t>.bats-hd.png   atlas of all 64 flipper bat poses at 4x, each
//                            composed `p0 | p1<<1 | p2<<2` through the TABLE'S
//                            OWN palette exactly as the runtime composes them
//   tables/<t>.bats-hd.json  atlas geometry + manifest
//
// PER TABLE, including the bats. The pose bank raster is table-independent but
// the palette is not: entries 1..7 differ between the three tables (measured —
// Law and BabeWatch disagree on the body greys, Extreme Sports on the leading-
// edge red), and the runtime tints each table's bats through its own art
// palette. One shared HD atlas would ship somebody the wrong bat.
//
// xBRZ was the measured winner for both sprites (research/hd/INDEX.txt
// section 5): it keeps the ball's own mottled reflection pattern and exact
// silhouette where the neural upscalers invent a photographic pearl, and its
// bat edges match the xBRZ look of the board they sit on.
//
// Deterministic; `--check` verifies instead of writing.
//
// Usage:  node scripts/export-moving-sprites-hd.mjs [--check]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  HD_SCALE,
  XBRZ_TOOL,
  ballRgba,
  batPoseRgba,
  blitIntoAtlas,
  decodeIndexedPng,
  encodePng,
  packAtlas,
  sha256,
  xbrzScaleRgba,
} from "./hd-pipeline.mjs";

const TABLES = ["law-n-justice", "babewatch", "extreme-sports"];
const OUT_DIR = "public/generated/tables";
const BATS_PATH = "public/generated/flipper-bats.json";

/** Builds one table's HD ball and HD bat atlas, in memory. */
export function buildMovingSpritesHd(tableId, artPng, ballJson, batsJson) {
  const art = decodeIndexedPng(artPng);
  const ballDoc = JSON.parse(ballJson.toString("utf8"));
  const batsDoc = JSON.parse(batsJson.toString("utf8"));
  if (ballDoc.tableId !== tableId) {
    throw new Error(`ball document names ${ballDoc.tableId}, expected ${tableId}`);
  }

  const ballHd = xbrzScaleRgba(ballRgba(ballDoc, art.palette), ballDoc.width, ballDoc.height);
  const ballHdPng = encodePng(ballHd, ballDoc.width * HD_SCALE, ballDoc.height * HD_SCALE, 4);

  const cells = batsDoc.poses.map((pose) => {
    const rgba = batPoseRgba(pose, batsDoc.plane2RowOffset, art.palette);
    return {
      key: String(pose.pose).padStart(3, "0"),
      pose: pose.pose,
      width: pose.width * HD_SCALE,
      height: pose.height * HD_SCALE,
      pixels: xbrzScaleRgba(rgba, pose.width, pose.height),
    };
  });
  const atlas = packAtlas(cells);
  const atlasPixels = new Uint8Array(atlas.width * atlas.height * 4);
  for (const cell of cells) {
    blitIntoAtlas(atlasPixels, atlas.width, 4, cell, atlas.placed.get(cell.key));
  }
  const batsHdPng = encodePng(atlasPixels, atlas.width, atlas.height, 4);

  const sources = [
    { file: `${tableId}.art.png`, sha256: sha256(artPng) },
    { file: `${tableId}.ball.json`, sha256: sha256(ballJson) },
    { file: "flipper-bats.json", sha256: sha256(batsJson) },
  ];

  const ballManifest = {
    schema: "pinball-illusions/table-ball-hd/v1",
    tableId,
    displayName: ballDoc.displayName,
    width: ballDoc.width * HD_SCALE,
    height: ballDoc.height * HD_SCALE,
    scale: HD_SCALE,
    image: {
      file: `${tableId}.ball-hd.png`,
      format: "png-rgba-8bit",
      byteLength: ballHdPng.length,
      sha256: sha256(ballHdPng),
    },
    provenance: {
      sourceClass: "disk-derived-ball-sprite-hd",
      description:
        "HD (4x) ball sprite: the shipped 17x17 palette-index ball through the table's own " +
        "palette, xBRZ-4x with its 1-bit mask carried through as alpha. Still image only.",
      authorizationRequired: true,
      pipeline: { algorithm: "RGBA compose then xBRZ 4x", xbrz: XBRZ_TOOL, sources },
    },
  };

  const batsManifest = {
    schema: "pinball-illusions/flipper-bats-hd/v1",
    tableId,
    displayName: ballDoc.displayName,
    scale: HD_SCALE,
    image: {
      file: `${tableId}.bats-hd.png`,
      format: "png-rgba-8bit",
      byteLength: batsHdPng.length,
      sha256: sha256(batsHdPng),
    },
    atlas: { width: atlas.width, height: atlas.height },
    cells: cells.map((cell) => {
      const at = atlas.placed.get(cell.key);
      return { pose: cell.pose, x: at.x, y: at.y, width: cell.width, height: cell.height };
    }),
    provenance: {
      sourceClass: "disk-derived-flipper-sprites-hd",
      description:
        "HD (4x) flipper bat pose atlas: all 64 shipped poses composed plane0|plane1<<1|plane2<<2 " +
        "through this table's own palette (the runtime's composition), xBRZ-4x with index-0 " +
        "transparency carried through as alpha. Still image only.",
      authorizationRequired: true,
      pipeline: { algorithm: "RGBA compose then xBRZ 4x", xbrz: XBRZ_TOOL, sources },
    },
  };

  return { ballHdPng, ballManifest, batsHdPng, batsManifest };
}

function main(argv) {
  const check = argv.includes("--check");
  let failures = 0;
  console.log(`export-moving-sprites-hd — ${check ? "verifying" : "writing"} HD balls and bat atlases`);
  const batsJson = readFileSync(BATS_PATH);
  for (const tableId of TABLES) {
    const artPng = readFileSync(join(OUT_DIR, `${tableId}.art.png`));
    const ballJson = readFileSync(join(OUT_DIR, `${tableId}.ball.json`));
    const built = buildMovingSpritesHd(tableId, artPng, ballJson, batsJson);
    const files = [
      [`${tableId}.ball-hd.png`, built.ballHdPng],
      [`${tableId}.ball-hd.json`, Buffer.from(JSON.stringify(built.ballManifest), "utf8")],
      [`${tableId}.bats-hd.png`, built.batsHdPng],
      [`${tableId}.bats-hd.json`, Buffer.from(JSON.stringify(built.batsManifest), "utf8")],
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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  process.exit(main(process.argv.slice(2)));
}
