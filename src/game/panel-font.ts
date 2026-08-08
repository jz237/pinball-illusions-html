/**
 * THE SCORE PANEL'S OWN SIX BITMAP FONTS, and the printer that lays them out.
 *
 * The shell font this port drew captions in until now is the FRONT DOOR's font:
 * eight rows, its own metrics, and nothing to do with the machine's display. The
 * machine has SIX panel faces, in a table of `{bitmap.l, metrics.l}` at main
 * hunk 0 +0x7136 that both of its printers index by the print record's own
 * `font` word:
 *
 *     0071BC  movem.l (0x7136,PC,d5.w*8),a1-a2   ; the NUMBER printer, $71BA
 *     0073E4  movem.l (0x7136,PC,d5.w*8),a1-a2   ; the ASCIIZ printer, $73D0
 *
 * and FONT 4 IS FIVE ROWS TALL — its BLTSIZE word is 0x140, which is 5 << 6.
 * That is the face the mode corpus sets almost every caption in, and five rows
 * at the records' own row 2 is dot rows 2..6, which is where the HD round
 * counted the caption on native-resolution stills (research/hd/phase23). Two
 * instruments, one answer, and the reason a caption in this port used to sit two
 * rows high was only ever the font.
 *
 * ---------------------------------------------------------------------------
 * THE GLYPH STRIP
 * ---------------------------------------------------------------------------
 * One single-bitplane bitmap a face, `strideWords` words to a row, `height`
 * rows, with glyph `g` starting at WORD COLUMN g:
 *
 *     007474  lea     (4,a1,d0.w*2),a4    ; <- Capstone drops this `*2`; the
 *                                         ;    raw bytes are `49f1 0204`
 *     00747C  move.b  $60(a2,d0.w),d2     ; the glyph's width IN PIXELS
 *     007480  add.w   d2,d3               ; the pen advances by the width
 *     0074D4  addq.w  #$2,d3              ; and two more pixels of tracking
 *
 * A glyph may be wider than its own word — `M` and `W` are 22 px on font 0 —
 * and then the next column's width byte is zero and no character maps to it.
 *
 * ---------------------------------------------------------------------------
 * THE METRICS BLOCK
 * ---------------------------------------------------------------------------
 *     -$02   w   the BLANK advance, for a character the map refuses
 *     +$00.. b   ASCII $20..$7F -> glyph index; NEGATIVE means blank
 *     +$60.. b   glyph index -> width in pixels
 *
 * `move.b (a2,d0.w),d0` at 0x743C after `subi.w #$20,d0` is what makes the map
 * ASCII-relative, and that is also what identifies the number printer's group
 * separator: `move.b #$C,d0` at 0x72E4 is character $2C, a COMMA.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT DRAWN HERE
 * ---------------------------------------------------------------------------
 * The machine ORs the glyph into ONE bitplane of the three-plane panel — the
 * text plane at $6000A00, which `CLEAR_1` clears 640 bytes of — so a glyph is a
 * single-colour stencil and there is no outline pass. This port draws it as one
 * colour for the same reason. The shell font's two-plane fill-and-outline is
 * still what the bonus, the card and the idle score view use; those have their
 * own rows and their own round, and mixing is what the machine does too.
 */

/** One face of the six. `bits` is one byte a pixel, 0 or 1, row-major. */
export interface PanelFontFace {
  readonly index: number;
  readonly height: number;
  readonly strideWords: number;
  /** Pixels across one row of the strip: `strideWords * 16`. */
  readonly width: number;
  /** `-$2(a2)`: the advance for a character the map sends nowhere. */
  readonly blank: number;
  /** ASCII $20..$7F -> glyph index, or -1 for blank. 96 entries. */
  readonly map: Int8Array;
  /** Glyph index -> width in pixels. */
  readonly widths: Uint8Array;
  readonly bits: Uint8Array;
}

export interface PanelFont {
  readonly faces: readonly PanelFontFace[];
}

/** ASCII $20 is where the character map starts. See the header. */
const MAP_BASE = 0x20;
const MAP_ENTRIES = 0x60;
/** `addq.w #$2,d3` at 0x74D4, after every glyph the map does name. */
const TRACKING = 2;
/** The strip's own geometry, asserted against the manifest. */
export const PANEL_FONT_STRIP_WIDTH = 320;
export const PANEL_FONT_STRIP_ROWS = 16;

interface RawFace {
  readonly index: number;
  readonly height: number;
  readonly strideWords: number;
  readonly glyphs: number;
  readonly blank: number;
  readonly at: number;
  readonly byteLength: number;
  readonly map: readonly number[];
  readonly widths: readonly number[];
}

export interface PanelFontDocument {
  readonly schema: number;
  readonly strip: { readonly width: number; readonly rows: number };
  readonly fonts: readonly RawFace[];
}

function fail(what: string): never {
  throw new Error(`panel font document: ${what}`);
}

/**
 * Builds the six faces from the manifest and the verbatim bitmap block.
 *
 * Every shape the printer depends on is checked rather than assumed, because a
 * font that is one word out draws a different alphabet and would look like a
 * rendering bug for the rest of the project's life.
 */
export function parsePanelFontDocument(raw: PanelFontDocument, data: Uint8Array): PanelFont {
  if (raw?.strip?.width !== PANEL_FONT_STRIP_WIDTH || raw?.strip?.rows !== PANEL_FONT_STRIP_ROWS) {
    fail(`declares a ${raw?.strip?.width}x${raw?.strip?.rows} strip; the panel is 320x16`);
  }
  if (!Array.isArray(raw.fonts) || raw.fonts.length !== 6) {
    fail(`carries ${raw?.fonts?.length} faces; the machine's table at h0+0x7136 has six`);
  }
  const faces: PanelFontFace[] = [];
  for (const [slot, font] of raw.fonts.entries()) {
    if (font.index !== slot) fail(`face ${slot} calls itself ${font.index}`);
    const { height, strideWords, at, byteLength } = font;
    if (!Number.isInteger(height) || height < 1 || height > PANEL_FONT_STRIP_ROWS) {
      fail(`face ${slot} is ${height} rows; the strip is ${PANEL_FONT_STRIP_ROWS}`);
    }
    if (!Number.isInteger(strideWords) || strideWords < 1 || strideWords > 64) {
      fail(`face ${slot} is ${strideWords} words a row`);
    }
    const rowBytes = strideWords * 2;
    if (byteLength !== 4 + rowBytes * height) {
      fail(`face ${slot} claims ${byteLength} bytes for ${strideWords}x${height}`);
    }
    if (at < 0 || at + byteLength > data.length) fail(`face ${slot} runs past the bitmap block`);
    // The two header words travel with the bitmap so the block stays a verbatim
    // copy of the machine's; re-reading them is a free cross-check.
    const view = new DataView(data.buffer, data.byteOffset + at, byteLength);
    if (view.getUint16(0) !== strideWords || view.getUint16(2) !== height * 64) {
      fail(`face ${slot}'s block header does not match its manifest entry`);
    }
    if (!Array.isArray(font.map) || font.map.length !== MAP_ENTRIES) {
      fail(`face ${slot} has a ${font.map?.length}-entry character map`);
    }
    if (!Array.isArray(font.widths) || font.widths.length !== font.glyphs) {
      fail(`face ${slot} has ${font.widths?.length} widths for ${font.glyphs} glyphs`);
    }

    const width = strideWords * 16;
    const bits = new Uint8Array(width * height);
    for (let row = 0; row < height; row += 1) {
      for (let word = 0; word < strideWords; word += 1) {
        const bitsOf = view.getUint16(4 + row * rowBytes + word * 2);
        for (let bit = 0; bit < 16; bit += 1) {
          bits[row * width + word * 16 + bit] = (bitsOf & (0x8000 >> bit)) === 0 ? 0 : 1;
        }
      }
    }
    const map = Int8Array.from(font.map as readonly number[], (glyph: number) =>
      glyph >= 0 && glyph < font.glyphs ? glyph : -1,
    );
    faces.push({
      index: slot,
      height,
      strideWords,
      width,
      blank: font.blank,
      map,
      widths: Uint8Array.from(font.widths),
      bits,
    });
  }
  return { faces };
}

/** The face a print record's `font` word names, clamped to the table. */
export function panelFace(font: PanelFont, index: number): PanelFontFace {
  return font.faces[index] ?? font.faces[0]!;
}

/**
 * The width `$73D0`'s own measure loop returns, 0x742E:
 *
 *     007430  moveq  #$FE,d1        ; the running width starts at MINUS TWO
 *     007442  addq.w #$2,d1         ; a glyph costs two of tracking
 *     007444  move.b $60(a2,d0.w),d2 / add.w d2,d1   ; plus its own width
 *     00744C  add.w  -$2(a2),d1     ; a blank costs the blank advance only
 *
 * so the trailing tracking of the last glyph is not counted, and a string of
 * blanks measures exactly `n * blank - 2`.
 */
export function measurePanelText(face: PanelFontFace, text: string): number {
  let width = -TRACKING;
  for (let i = 0; i < text.length; i += 1) {
    const glyph = face.map[text.charCodeAt(i) - MAP_BASE] ?? -1;
    if (glyph < 0) {
      width += face.blank;
      continue;
    }
    width += TRACKING + (face.widths[glyph] ?? 0);
  }
  return width;
}

/**
 * The pen column `$73D0` starts at, 0x7404-0x742C:
 *
 *     00740A  cmpi.b #$0,d0 / beq   ; 0 -> the pen IS x                 LEFT
 *     007410  cmpi.b #$1,d0 / beq   ; 1 -> x - width                    RIGHT
 *     007416  bsr measure / lsr.w #1 / addq.w #1 / andi.w #$FFFE
 *     007420  sub.w d1,d3           ; else x - (width/2 rounded up even) CENTRE
 *
 * and 0x7422 / 0x742A bail on a NEGATIVE pen, drawing nothing at all — which is
 * why this answers null rather than clamping.
 */
export function panelTextPen(face: PanelFontFace, text: string, x: number, align: number): number | null {
  if (align === 0) return x;
  const width = measurePanelText(face, text);
  if (align === 1) {
    const pen = x - width;
    return pen < 0 ? null : pen;
  }
  const half = ((width >> 1) + 1) & 0xfffe;
  const pen = x - half;
  return pen < 0 ? null : pen;
}

/** One glyph's pixels, for a caller that rasterises. `null` for a blank. */
export interface PanelGlyphRun {
  readonly glyph: number;
  readonly pen: number;
  readonly width: number;
}

/**
 * Walks a string the way the draw loop at 0x7454 does: each mapped character
 * blits at the pen and advances it by `width + 2`, each unmapped one advances by
 * the blank and draws nothing.
 */
export function panelTextRun(face: PanelFontFace, text: string, pen: number): PanelGlyphRun[] {
  const out: PanelGlyphRun[] = [];
  let at = pen;
  for (let i = 0; i < text.length; i += 1) {
    const glyph = face.map[text.charCodeAt(i) - MAP_BASE] ?? -1;
    if (glyph < 0) {
      at += face.blank;
      continue;
    }
    const width = face.widths[glyph] ?? 0;
    out.push({ glyph, pen: at, width });
    at += width + TRACKING;
  }
  return out;
}

/** Where the exported asset lives, beside the tables' own generated documents. */
export const PANEL_FONT_BASE_PATH = "generated/";
export const PANEL_FONT_MANIFEST = "panel-font.json";

/**
 * Fetches the manifest and its verbatim bitmap block.
 *
 * Answers null on any failure rather than throwing: a build that ships no
 * derived assets has no panel font, and the panel's fallback to the shell font
 * is a working panel and not an error.
 */
export async function loadPanelFont(
  fetchImpl: (url: string) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }> = (
    url,
  ) => fetch(url),
  basePath: string = PANEL_FONT_BASE_PATH,
): Promise<PanelFont | null> {
  try {
    const manifestResponse = await fetchImpl(`${basePath}${PANEL_FONT_MANIFEST}`);
    if (!manifestResponse.ok) return null;
    const raw = JSON.parse(
      new TextDecoder().decode(new Uint8Array(await manifestResponse.arrayBuffer())),
    ) as PanelFontDocument & { data?: readonly { file: string }[] };
    const file = raw.data?.[0]?.file;
    if (typeof file !== "string") return null;
    const dataResponse = await fetchImpl(`${basePath}${file}`);
    if (!dataResponse.ok) return null;
    return parsePanelFontDocument(raw, new Uint8Array(await dataResponse.arrayBuffer()));
  } catch {
    return null;
  }
}

/** True where glyph `g`'s column `column` of row `row` is set. */
export function panelGlyphPixel(
  face: PanelFontFace,
  glyph: number,
  column: number,
  row: number,
): boolean {
  const x = glyph * 16 + column;
  if (x < 0 || x >= face.width || row < 0 || row >= face.height) return false;
  return face.bits[row * face.width + x] === 1;
}
