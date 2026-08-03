#!/usr/bin/env node
// Card thumbnails for the front door: a top-of-table crop of each table's HD
// master, the way Pinball Fantasies HD ships `src/assets/shell/*-thumb.webp`
// as top-of-table crops for its shell cards.
//
// DERIVATION AND CUSTODY. The input is `public/generated/tables/<id>.art-hd.png`
// — itself derived from the disk artwork by the deterministic local upscale in
// `hd-pipeline.mjs` — and a crop of a derived picture is still disk-derived.
// Each thumbnail therefore ships exactly as every other derived raster does:
// behind the PINBALL_ILLUSIONS_DERIVED_AUTHORIZED gate, claimed by its own
// manifest (`sourceClass: "disk-derived-table-thumbnail"`, a SINGLE_IMAGE
// class in scripts/check-public-build.mjs) with the file's sha256, so
// `guard:public` refuses any build in which the pixels and the claim disagree.
//
// THE CROP. The top 40% of the 1344x2400 master — rows 0..959, the upper
// playfield, which is where all three tables carry their identity art — is
// 1344x960, exactly 7:5, and is downscaled to 420x300 (the card well's own
// aspect in styles.css). Encoded WebP via ffmpeg, the one external tool this
// script needs; it refuses loudly when ffmpeg is missing rather than shipping
// nothing silently.
//
// Usage: node scripts/export-shell-thumbs.mjs

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TABLES = join(root, "public", "generated", "tables");
const SHELL = join(root, "public", "generated", "shell");

const TABLE_IDS = ["law-n-justice", "babewatch", "extreme-sports"];

/** Source crop: the top 40% of the 1344x2400 master. 7:5 exactly. */
const CROP_WIDTH = 1344;
const CROP_HEIGHT = 960;
/** Card size: the same 7:5, small enough to be a thumbnail, sharp on 2x. */
const THUMB_WIDTH = 420;
const THUMB_HEIGHT = 300;

const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.error("export-shell-thumbs: ffmpeg not found on PATH; refusing to continue");
  process.exit(1);
}

mkdirSync(SHELL, { recursive: true });

for (const tableId of TABLE_IDS) {
  const source = join(TABLES, `${tableId}.art-hd.png`);
  if (!existsSync(source)) {
    console.error(`export-shell-thumbs: missing HD master ${source}`);
    process.exit(1);
  }
  const thumbName = `${tableId}-thumb.webp`;
  const thumbPath = join(SHELL, thumbName);
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", source,
      "-vf",
      `crop=${CROP_WIDTH}:${CROP_HEIGHT}:0:0,scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:flags=lanczos`,
      "-frames:v", "1",
      "-c:v", "libwebp",
      "-lossless", "0",
      "-quality", "82",
      thumbPath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(`export-shell-thumbs: ffmpeg failed for ${tableId}:\n${result.stderr}`);
    process.exit(1);
  }

  const bytes = readFileSync(thumbPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schema: "pinball-illusions/table-thumbnail/v1",
    tableId,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    image: {
      file: thumbName,
      format: "webp-lossy",
      byteLength: bytes.length,
      sha256,
    },
    provenance: {
      sourceClass: "disk-derived-table-thumbnail",
      description:
        `Front-door card thumbnail: the top ${CROP_HEIGHT} rows of the ` +
        `${tableId} HD playfield master (itself a deterministic local upscale ` +
        "of the shipped disk artwork), downscaled to card size. Still image " +
        "only; derived from the operator's own disks and shipped only behind " +
        "the authorization gate.",
      derivedFrom: `../tables/${tableId}.art-hd.png`,
      crop: { x: 0, y: 0, width: CROP_WIDTH, height: CROP_HEIGHT },
    },
  };
  writeFileSync(join(SHELL, `${tableId}-thumb.json`), `${JSON.stringify(manifest)}\n`);
  console.log(`export-shell-thumbs: ${thumbName} ${bytes.length} bytes sha256 ${sha256.slice(0, 16)}…`);
}

console.log("export-shell-thumbs: done");
