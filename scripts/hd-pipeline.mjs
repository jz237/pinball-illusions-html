// The HD art pipeline: the pure functions behind export-table-art-hd.mjs and
// export-moving-sprites-hd.mjs, importable so a test can regenerate any HD
// asset in-process and prove the shipped bytes are this code's output.
//
// THE RECIPE IS THE MEASURED ONE, not a chosen one. research/hd/INDEX.txt is
// the experiment log: seven upscaler candidates were rendered and judged on all
// three playfields, and local xBRZ 4x with an exact-checkerboard de-dither
// prepass — the recipe Pinball Fantasies HD shipped — was the only candidate
// that (a) kept every letterform pixel-faithful, (b) confined the lit-vs-dim
// lamp divergence to lamp-rect + 12 HD px (the neural upscalers shimmer 42-79%
// of ALL pixels between the two states, which makes per-lamp dim patches
// impossible), and (c) is deterministic, local and free. The dim-patch
// composite was proven pixel-identical to a true all-dim upscale — zero seams,
// zero missed pixels — with patches cut at DILATION 12 (8 leaves ~10 stray
// pixels on Law 'n Justice).
//
// Everything here is deterministic: same inputs, same bytes, no network, no
// clock, no randomness. `xbrz-js@1.9.2` is Zenju's xBRZ v1.9 in pure JS with
// default config; the PNG writer always emits filter-0 rows through
// `deflateSync` at a fixed level. The exporters run with `--check` in CI
// fashion: re-running them against the shipped files must find them identical.

import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import xbrz from "xbrz-js";

const { xbrzScale, xbrzColorFormat, xbrzConfig } = xbrz;

/** Logical playfield size; the HD masters are exactly SCALE times this. */
export const NATIVE_WIDTH = 336;
export const NATIVE_HEIGHT = 600;
export const HD_SCALE = 4;

/**
 * How far a lamp's dim patch extends past its mask rectangle, in HD pixels.
 *
 * MEASURED, not chosen: lamp_diff.py swept the lit-vs-dim upscale divergence at
 * radii 0/4/8/12/16/24/32 and it reaches zero at 12 on all three tables (at 8,
 * Law 'n Justice still has 10 stray pixels). 12 HD px = 3 source px, which is
 * xBRZ's own neighborhood, so this is the algorithm's locality made visible.
 */
export const LAMP_PATCH_DILATION_HD = 12;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// PNG — read (8-bit indexed; the shipped art) and write (truecolor; the HD out)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Reverses PNG row filtering for `bpp` bytes per pixel. All five filters. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  if (raw.length !== height * (1 + stride)) {
    throw new Error(`inflated image data is ${raw.length} bytes, expected ${height * (1 + stride)}`);
  }
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (1 + stride)];
    const from = y * (1 + stride) + 1;
    const to = y * stride;
    const above = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[from + x];
      const a = x >= bpp ? out[to + x - bpp] : 0;
      const b = y > 0 ? out[above + x] : 0;
      const c = y > 0 && x >= bpp ? out[above + x - bpp] : 0;
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + a; break;
        case 2: restored = value + b; break;
        case 3: restored = value + ((a + b) >> 1); break;
        case 4: restored = value + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      out[to + x] = restored & 0xff;
    }
  }
  return out;
}

/**
 * Decodes the 8-bit indexed PNG our own art exporter writes.
 *
 * Same strictness as `src/game/table-art.ts` (which the browser uses): refuses
 * anything that is not 8-bit indexed non-interlaced, because an artwork file
 * this reader does not fully understand is an artwork file that should be
 * looked at, not approximated.
 */
export function decodeIndexedPng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let offset = 8;
  let header = null;
  let palette = null;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const tag = bytes.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    const payload = bytes.subarray(start, start + length);
    if (tag === "IHDR") {
      const depth = payload[8];
      const colour = payload[9];
      const interlace = payload[12];
      if (depth !== 8 || colour !== 3 || interlace !== 0) {
        throw new Error(`expected an 8-bit indexed non-interlaced PNG, got depth ${depth} colour ${colour}`);
      }
      header = { width: bytes.readUInt32BE(start), height: bytes.readUInt32BE(start + 4) };
    } else if (tag === "PLTE") {
      palette = Uint8Array.from(payload);
    } else if (tag === "IDAT") {
      idat.push(payload);
    } else if (tag === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  if (header === null || palette === null || idat.length === 0) {
    throw new Error("PNG is missing IHDR, PLTE or IDAT");
  }
  const indices = unfilter(inflateSync(Buffer.concat(idat)), header.width, header.height, 1);
  return { width: header.width, height: header.height, indices, palette };
}

let crcTable = null;

function crc32(buf) {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(tag, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(tag, "latin1"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Truecolor PNG: colour type 2 (RGB) for the opaque boards and atlases, 6
 * (RGBA) where sprites carry transparency. Filter 0 on every row and one fixed
 * deflate level, so identical pixels are identical bytes on every run.
 */
export function encodePng(pixels, width, height, channels) {
  if (channels !== 3 && channels !== 4) throw new Error(`channels must be 3 or 4, got ${channels}`);
  if (pixels.length !== width * height * channels) {
    throw new Error(`pixel buffer is ${pixels.length} bytes, expected ${width * height * channels}`);
  }
  const stride = width * channels;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Boards — the two lamp states, composited exactly as the runtime composites
// ---------------------------------------------------------------------------

const b64 = (text) => Uint8Array.from(Buffer.from(text, "base64"));

/** One lamp's 1-bit mask as a width*height Uint8Array of 0/1. */
export function lampMaskBits(lamp) {
  const rowBytes = lamp.width / 8;
  const raw = b64(lamp.mask);
  const bits = new Uint8Array(lamp.width * lamp.height);
  for (let y = 0; y < lamp.height; y += 1) {
    for (let x = 0; x < lamp.width; x += 1) {
      bits[y * lamp.width + x] = (raw[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
    }
  }
  return bits;
}

/**
 * The playfield's palette indices with every lamp forced LIT or forced DIM.
 *
 * The exact arithmetic of `src/game/lamp-overlays.ts` and of the original's
 * own blits: a plane-7 lamp's dim face is `index | 0x80` through the same
 * palette (the artist's dim variants live in the upper half), and a
 * masked-kind lamp substitutes its explicit `on`/`off` index array under its
 * mask. The shipped art stores plane-7 inserts lit, so LIT keeps their pixels;
 * masked lamps are forced to `on` because the runtime always draws one of
 * their two faces — the art's own pixels under them never show.
 */
export function composeBoardIndices(art, lampsDoc, lit) {
  const out = Uint8Array.from(art.indices);
  for (const lamp of lampsDoc.lamps) {
    if (lamp.kind === "none") continue;
    const mask = lampMaskBits(lamp);
    if (lamp.kind === "plane7") {
      if (lit) continue;
      for (let y = 0; y < lamp.height; y += 1) {
        for (let x = 0; x < lamp.width; x += 1) {
          if (mask[y * lamp.width + x] === 0) continue;
          const at = (lamp.y + y) * art.width + lamp.x + x;
          out[at] |= 0x80;
        }
      }
    } else if (lamp.kind === "masked") {
      const face = lit ? lamp.on : lamp.off;
      if (face === undefined || face === null) continue;
      const indices = b64(face);
      for (let y = 0; y < lamp.height; y += 1) {
        for (let x = 0; x < lamp.width; x += 1) {
          if (mask[y * lamp.width + x] === 0) continue;
          out[(lamp.y + y) * art.width + lamp.x + x] = indices[y * lamp.width + x];
        }
      }
    } else {
      throw new Error(`unknown lamp kind ${lamp.kind}`);
    }
  }
  return out;
}

/** Indices through the palette to packed RGB. */
export function indicesToRgb(indices, palette) {
  const rgb = new Uint8Array(indices.length * 3);
  for (let i = 0; i < indices.length; i += 1) {
    const entry = indices[i] * 3;
    rgb[i * 3] = palette[entry] ?? 0;
    rgb[i * 3 + 1] = palette[entry + 1] ?? 0;
    rgb[i * 3 + 2] = palette[entry + 2] ?? 0;
  }
  return rgb;
}

// ---------------------------------------------------------------------------
// De-dither — the exact-checkerboard prepass, port of research/hd/dedither.py
// ---------------------------------------------------------------------------

/**
 * Averages exact checkerboard dither before xBRZ traces it as edges.
 *
 * Two passes over EXACT colour equality only — which in indexed disk art means
 * deliberate dither, never a photograph's noise. Pass 1: a single pixel whose
 * four edge-neighbours all share one colour, whose four diagonal neighbours
 * share the pixel's own, and whose own colour differs from the neighbours' —
 * the classic 1x1 checker — becomes the average of the two. Pass 2: the same
 * pattern over uniform 2x2 blocks (implemented for fidelity to the measured
 * recipe; it fired zero times on all three tables — AGA art is lightly
 * dithered). Both passes read the ORIGINAL pixels and write a copy, exactly as
 * the numpy reference does. Averages round half up: `(a + b + 1) >> 1`.
 */
export function deditherRgb(rgb, width, height) {
  const out = Uint8Array.from(rgb);
  const same = (a, b) =>
    rgb[a] === rgb[b] && rgb[a + 1] === rgb[b + 1] && rgb[a + 2] === rgb[b + 2];
  let checker1 = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const c = (y * width + x) * 3;
      const l = c - 3;
      const r = c + 3;
      const u = c - width * 3;
      const d = c + width * 3;
      if (!(same(l, r) && same(u, d) && same(l, u))) continue;
      const ul = u - 3;
      const ur = u + 3;
      const dl = d - 3;
      const dr = d + 3;
      if (!(same(ul, c) && same(ur, c) && same(dl, c) && same(dr, c))) continue;
      if (same(l, c)) continue;
      out[c] = (rgb[c] + rgb[l] + 1) >> 1;
      out[c + 1] = (rgb[c + 1] + rgb[l + 1] + 1) >> 1;
      out[c + 2] = (rgb[c + 2] + rgb[l + 2] + 1) >> 1;
      checker1 += 1;
    }
  }

  // Pass 2: 2x2-block checkerboard, over the ORIGINAL pixels.
  const hh = Math.floor(height / 2);
  const ww = Math.floor(width / 2);
  const blockAt = (by, bx) => ((by * 2) * width + bx * 2) * 3;
  const blockUniform = (by, bx) => {
    const a = blockAt(by, bx);
    return same(a, a + 3) && same(a, a + width * 3) && same(a, a + width * 3 + 3);
  };
  const blocksSame = (a, b) => same(blockAt(a[0], a[1]), blockAt(b[0], b[1]));
  let checker2 = 0;
  for (let by = 1; by < hh - 1; by += 1) {
    for (let bx = 1; bx < ww - 1; bx += 1) {
      const here = [by, bx];
      const left = [by, bx - 1];
      const right = [by, bx + 1];
      const up = [by - 1, bx];
      const down = [by + 1, bx];
      if (!(blocksSame(left, right) && blocksSame(up, down) && blocksSame(left, up))) continue;
      if (!(blockUniform(by, bx) && blockUniform(by, bx - 1) && blockUniform(by, bx + 1) &&
            blockUniform(by - 1, bx) && blockUniform(by + 1, bx))) continue;
      if (blocksSame(left, here)) continue;
      const cAt = blockAt(by, bx);
      const lAt = blockAt(by, bx - 1);
      for (let ch = 0; ch < 3; ch += 1) {
        const avg = (rgb[cAt + ch] + rgb[lAt + ch] + 1) >> 1;
        for (const dy of [0, 1]) {
          for (const dx of [0, 1]) {
            out[((by * 2 + dy) * width + bx * 2 + dx) * 3 + ch] = avg;
          }
        }
      }
      checker2 += 4;
    }
  }
  return { rgb: out, stats: { checker1x1Px: checker1, checker2x2Px: checker2 } };
}

// ---------------------------------------------------------------------------
// xBRZ
// ---------------------------------------------------------------------------

export const XBRZ_TOOL = "xbrz-js@1.9.2 (xBRZ v1.9), format argb, default config";

/**
 * xBRZ at HD_SCALE over RGBA bytes.
 *
 * The bytes are viewed as little-endian Uint32 (0xAABBGGRR), which is exactly
 * what xbrz-js's "argb" in-memory format expects for RGBA byte order — the
 * same call the research pipeline made, so the pixels are the judged ones.
 */
export function xbrzScaleRgba(rgba, width, height) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgba buffer is ${rgba.length} bytes, expected ${width * height * 4}`);
  }
  const src = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const dst = new Uint32Array(width * HD_SCALE * height * HD_SCALE);
  xbrzScale(HD_SCALE, src, dst, width, height, xbrzColorFormat.argb, xbrzConfig({}));
  return new Uint8Array(dst.buffer, 0, dst.length * 4);
}

/** RGB in, RGB out: wraps the alpha channel handling for the opaque boards. */
export function xbrzScaleRgb(rgb, width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  const scaled = xbrzScaleRgba(rgba, width, height);
  const hdW = width * HD_SCALE;
  const hdH = height * HD_SCALE;
  const out = new Uint8Array(hdW * hdH * 3);
  for (let i = 0; i < hdW * hdH; i += 1) {
    out[i * 3] = scaled[i * 4];
    out[i * 3 + 1] = scaled[i * 4 + 1];
    out[i * 3 + 2] = scaled[i * 4 + 2];
  }
  return out;
}

/** The full board recipe: indices -> palette RGB -> de-dither -> xBRZ 4x. */
export function upscaleBoard(indices, palette) {
  const rgb = indicesToRgb(indices, palette);
  const { rgb: flat, stats } = deditherRgb(rgb, NATIVE_WIDTH, NATIVE_HEIGHT);
  return { rgb: xbrzScaleRgb(flat, NATIVE_WIDTH, NATIVE_HEIGHT), dedither: stats };
}

// ---------------------------------------------------------------------------
// Lamp patches
// ---------------------------------------------------------------------------

/**
 * The HD rectangle a lamp's dim patch covers: its mask rectangle at HD_SCALE,
 * dilated by LAMP_PATCH_DILATION_HD on every side, clamped to the board.
 */
export function lampPatchRect(lamp) {
  const x0 = Math.max(0, lamp.x * HD_SCALE - LAMP_PATCH_DILATION_HD);
  const y0 = Math.max(0, lamp.y * HD_SCALE - LAMP_PATCH_DILATION_HD);
  const x1 = Math.min(NATIVE_WIDTH * HD_SCALE, (lamp.x + lamp.width) * HD_SCALE + LAMP_PATCH_DILATION_HD);
  const y1 = Math.min(NATIVE_HEIGHT * HD_SCALE, (lamp.y + lamp.height) * HD_SCALE + LAMP_PATCH_DILATION_HD);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Crops `rect` out of a packed pixel buffer. */
export function cropPixels(pixels, stride, channels, rect) {
  const out = new Uint8Array(rect.width * rect.height * channels);
  for (let y = 0; y < rect.height; y += 1) {
    const from = ((rect.y + y) * stride + rect.x) * channels;
    out.set(pixels.subarray(from, from + rect.width * channels), y * rect.width * channels);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Atlas packing — deterministic shelf packing
// ---------------------------------------------------------------------------

/**
 * Packs cells onto shelves left-to-right, tallest shelf first.
 *
 * Deterministic by construction: the order is (height desc, key asc) and the
 * placement rule has no state beyond the cursor. Returns each cell's atlas
 * position plus the finished atlas size.
 */
export function packAtlas(cells, maxWidth = 1024) {
  const order = [...cells].sort((a, b) => b.height - a.height || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const placed = new Map();
  let x = 0;
  let y = 0;
  let shelf = 0;
  let width = 0;
  for (const cell of order) {
    if (x + cell.width > maxWidth && x > 0) {
      y += shelf;
      x = 0;
      shelf = 0;
    }
    placed.set(cell.key, { x, y });
    x += cell.width;
    if (cell.height > shelf) shelf = cell.height;
    if (x > width) width = x;
  }
  return { width, height: y + shelf, placed };
}

/** Blits a packed cell into an atlas pixel buffer. */
export function blitIntoAtlas(atlas, atlasWidth, channels, cell, at) {
  for (let y = 0; y < cell.height; y += 1) {
    const from = y * cell.width * channels;
    const to = ((at.y + y) * atlasWidth + at.x) * channels;
    atlas.set(cell.pixels.subarray(from, from + cell.width * channels), to);
  }
}

// ---------------------------------------------------------------------------
// Sprites — the ball and the bat poses as RGBA, the runtime's own composition
// ---------------------------------------------------------------------------

/** The ball document's palette indices + 1-bit mask as RGBA. */
export function ballRgba(ballDoc, palette) {
  const { width, height } = ballDoc;
  const indices = b64(ballDoc.pixels);
  const rowBytes = ballDoc.mask.rowBytes;
  const maskRows = b64(ballDoc.mask.rows);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bit = (maskRows[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (bit === 0) continue;
      const at = (y * width + x) * 4;
      const entry = indices[y * width + x] * 3;
      rgba[at] = palette[entry] ?? 0;
      rgba[at + 1] = palette[entry + 1] ?? 0;
      rgba[at + 2] = palette[entry + 2] ?? 0;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

/**
 * One bat pose as RGBA: `plane0 | plane1<<1 | plane2<<2` through the table
 * palette, index 0 transparent, plane 2 offset down by `plane2RowOffset` rows
 * — the same composition `src/game/moving-sprites.ts` draws at runtime.
 */
export function batPoseRgba(pose, plane2RowOffset, palette) {
  const { width, height } = pose;
  const rowBytes = Math.ceil(width / 8);
  const p0 = b64(pose.plane0);
  const p1 = b64(pose.plane1);
  const p2 = b64(pose.plane2);
  const plane2Rows = height - 2 * plane2RowOffset;
  const bit = (plane, y, x) => (plane[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let index = bit(p0, y, x) | (bit(p1, y, x) << 1);
      const body = y - plane2RowOffset;
      if (body >= 0 && body < plane2Rows && bit(p2, body, x) !== 0) index |= 4;
      if (index === 0) continue;
      const at = (y * width + x) * 4;
      const entry = index * 3;
      rgba[at] = palette[entry] ?? 0;
      rgba[at + 1] = palette[entry + 1] ?? 0;
      rgba[at + 2] = palette[entry + 2] ?? 0;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}
