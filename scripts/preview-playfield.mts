#!/usr/bin/env node
// Renders the playfield the way the game does and writes it out as PNGs, so a
// human can LOOK at it.
//
// This exists because of a specific failure: the renderer shipped a procedural
// wireframe of the collision map to a live URL with twenty-six green tests
// behind it, every one of which asserted only that the output was the same on
// every run. Nothing in the loop ever compared the picture to the original, and
// nothing in the loop ever showed it to anybody. The unit tests now assert
// correctness, and this is the other half: an eye on the result.
//
// It drives the real modules — the real loader, the real registration, the real
// blit geometry — so what it writes is what the browser draws. Three files per
// table:
//
//   render_<id>.png    the whole 336x600 raster
//   overlay_<id>.png   the same, with the collision line the physics reads drawn
//                      over it (magenta lower, cyan upper). If the artwork and
//                      the map are registered, those lines sit on drawn edges.
//   viewport_<id>.png  the scrolling window at the game's own integer 2x
//
// Usage:  npx vite-node scripts/preview-playfield.mts -- <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import {
  playfieldBlitGeometry,
  playfieldRaster,
  setPlayfieldArtwork,
} from "../src/browser/playfield-renderer.js";
import { loadTableArt } from "../src/game/table-art.js";
import type { TableArtFetch } from "../src/game/table-art.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableId, TableMapDocument } from "../src/game/contracts.js";

const DIR = "public/generated/tables/";
const OUT = process.argv[2] ?? ".";
mkdirSync(OUT, { recursive: true });

const fileFetch: TableArtFetch = async (url) => {
  const bytes = readFileSync(DIR + url.slice(url.lastIndexOf("/") + 1));
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
};

let crcTable: Int32Array | null = null;

function crc32(buf: Buffer): number {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = (crcTable[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(tag: string, payload: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(tag, "latin1"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGB PNG, filter 0, optional integer magnification. */
function writePng(path: string, rgb: Uint8Array, width: number, height: number, zoom = 1): void {
  const w = width * zoom;
  const h = height * zoom;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const at = y * (1 + w * 3);
    raw[at] = 0;
    for (let x = 0; x < w; x += 1) {
      const from = (Math.floor(y / zoom) * width + Math.floor(x / zoom)) * 3;
      raw[at + 1 + x * 3] = rgb[from] ?? 0;
      raw[at + 2 + x * 3] = rgb[from + 1] ?? 0;
      raw[at + 3 + x * 3] = rgb[from + 2] ?? 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 6 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

for (const tableId of TABLE_IDS as readonly TableId[]) {
  const doc = JSON.parse(readFileSync(`${DIR}${tableId}.map.json`, "utf8")) as TableMapDocument;
  const map = parseTableMapDocument(doc);
  setPlayfieldArtwork(map, await loadTableArt(tableId, fileFetch, ""));
  const raster = playfieldRaster(map);

  const rgb = new Uint8Array(raster.width * raster.height * 3);
  for (let i = 0; i < raster.width * raster.height; i += 1) {
    rgb[i * 3] = raster.data[i * 4] ?? 0;
    rgb[i * 3 + 1] = raster.data[i * 4 + 1] ?? 0;
    rgb[i * 3 + 2] = raster.data[i * 4 + 2] ?? 0;
  }
  writePng(`${OUT}/render_${tableId}.png`, rgb, raster.width, raster.height);

  // The same pixels with the collision line the physics reads drawn over them,
  // so registration is judged by eye and not only by a correlation number.
  const overlay = Uint8Array.from(rgb);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const bits = map.materialAt(x, y);
      const at = (y * raster.width + x) * 3;
      if ((bits & 1) !== 0) {
        overlay[at] = 255;
        overlay[at + 1] = 0;
        overlay[at + 2] = 255;
      } else if ((bits & 2) !== 0) {
        overlay[at] = 0;
        overlay[at + 1] = 255;
        overlay[at + 2] = 255;
      }
    }
  }
  writePng(`${OUT}/overlay_${tableId}.png`, overlay, raster.width, raster.height);

  // What the player actually sees: the scrolling window, at the game's own 2x.
  const geometry = playfieldBlitGeometry(map, { scrollY: 344, mode: "scrolling" }, 2);
  const window = new Uint8Array(geometry.sourceWidth * geometry.sourceHeight * 3);
  for (let y = 0; y < geometry.sourceHeight; y += 1) {
    const from = ((geometry.sourceY + y) * raster.width + geometry.sourceX) * 3;
    window.set(rgb.subarray(from, from + geometry.sourceWidth * 3), y * geometry.sourceWidth * 3);
  }
  writePng(
    `${OUT}/viewport_${tableId}.png`,
    window,
    geometry.sourceWidth,
    geometry.sourceHeight,
    2,
  );
  console.log(`${tableId}: wrote render / overlay / viewport`);
}
