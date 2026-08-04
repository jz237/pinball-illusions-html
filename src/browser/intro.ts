/**
 * THE INTRO — `intro.bin`'s 89-second cinematic, played on cold boot before
 * the front door, exactly where the original plays it before its shell.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * The last undecoded content in the game: the self-deprecating history lesson
 * ("wAY bACK IN tHE yEAR 1992...") that writes itself letter by letter over
 * purple clouds, cuts to the DREAMS / FANTASIES / 21st CENTURY / DIGITAL
 * ILLUSIONS cards, lands the "SUPER PINBALL FANTASIES TURBO EX II — M-BALL
 * EDITION... OR IN SHORT" gag on the ILLUSIONS logo, and rolls six crossfading
 * credit pages. research/INTRO_DECODE.md carries the complete derivation;
 * research/intro/render.py is the frame-accurate reference implementation,
 * film-verified against session 3's boot capture at t = film + 1067 within
 * ±2 frames — and THIS FILE IS A PORT OF IT, statement for statement, because
 * the pixel gate compares this player's canvas against that render's frames
 * byte for byte.
 *
 * The assets are `scripts/export-intro.mjs`'s three files: the data segment
 * verbatim (palettes + fourteen packed streams), the copper segment verbatim
 * (the eight display lists), and a manifest carrying the 193-entry timed
 * script and the twelve fade tables reduced to plain numbers. Nothing here
 * hard-codes an offset the manifest can carry; everything the manifest says is
 * re-checked before play, the `loading-logo.ts` argument.
 *
 * ---------------------------------------------------------------------------
 * HOW THE PORT STAYS HONEST: ONE GENERATOR, ONE YIELD PER PAL FRAME
 * ---------------------------------------------------------------------------
 * The original's main loop dispatches AT MOST ONE due script entry per frame,
 * and the blocking handlers (the 16-pass fades, the whole credits
 * choreography) burn frames internally. render.py mirrors that with ordinary
 * blocking calls because it renders offline; a browser player has to return
 * to the event loop fifty times a second. Rather than flattening the
 * choreography into a hand-built state machine — the classic way to introduce
 * an off-by-one the film gate would catch weeks later — the whole script
 * engine is ONE GENERATOR that yields exactly once per PAL frame, so the
 * control flow reads line for line like the reference and the 50 Hz driver
 * simply calls `next()` once per tick. Where render.py says
 * `self.frame(); apply the fade pass`, this file says `yield* this.#frame();
 * this.#fadePass(...)` — same order, same off-by-nothing.
 *
 * The display model is the machine's, not a re-projection: h2 (the copper
 * lists) is kept as mutable bytes and the fades step its palette words a
 * nibble per gun per frame in place; h4 (screen memory) is a flat 249,600-byte
 * buffer the unpacker and the double-buffer blit write into; and the
 * rasteriser walks the CURRENT list — palette banks, plane pointers, HAM8 —
 * every time something changed. HAM8's control bits are the two LOW planes on
 * AGA (the opposite end from HAM6); getting that backwards produces rainbow
 * soup, and the reference's diagnostic renders are the cautionary examples.
 *
 * The reference canvas is 640x240 (hires-width pixels, half height — lores
 * scenes double their columns into it, and every row is two square-pixel
 * rows). The browser presentation letterboxes that as 4:3 into whatever the
 * shell canvas currently is, smoothing on, which is the same supersample-
 * then-fit rule the HD playfield ships under. `fitCanvas` in main.ts already
 * letterboxes the canvas itself into a portrait phone; this only letterboxes
 * the picture into the canvas.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * AUDIO. The intro's tune is the SNT! bank in seg05 — the very front-end
 * module the shell already ships and plays. The original starts it with the
 * intro and lets it run into the shell; this build does the same by simply
 * leaving `main.ts`'s one `music.update(shell.phase)` call running (the phase
 * is `attract` throughout). A browser will not sound before the first user
 * gesture, and this file does not fight that: the show runs silent until the
 * shell's existing audio unlock fires, and if that lands mid-intro the tune
 * starts then. No new audio path exists here.
 *
 * SKIPPING is the host's job. The original polls fire on both joystick ports
 * (seg00+0x1A4) and exits; `main.ts` routes any fire input — flipper keys,
 * launch, Enter, click, tap, gamepad button — to `IntroHandle.skip`.
 * `introFireKey` below is the one shared definition of "fire input", built on
 * the router's own key tables so a rebinding cannot strand this list.
 */

import { FixedStepScheduler, millisecondsToNanos } from "../core/fixed-step-scheduler.js";
import { KEY_CODE_BINDINGS, KEY_NAME_BINDINGS } from "./input.js";
import type { Control, KeyEventLike } from "./input.js";
import type { TableArtFetch, TableArtResponse } from "../game/table-art.js";
import { SHELL_ART_BASE_PATH } from "../game/shell-art.js";

export const INTRO_SCHEMA = "pinball-illusions/intro/v1";
export const INTRO_MANIFEST = "intro.json";
export const INTRO_BASE_PATH = `${SHELL_ART_BASE_PATH}intro/`;

/** The reference canvas: hires width, PAL band height in half-height rows. */
export const INTRO_WIDTH = 640;
export const INTRO_ROWS = 240;

/**
 * Where playback starts: the frame whose dispatch is the backdrop fade-in.
 * Script time t=1..351 is BLACK — the original runs it while the floppies
 * load, with only the music up — and INTRO_DECODE.md §7 is explicit that the
 * lead-in is loader time, not art, and may be trimmed. A browser has no
 * loader time and autoplay policy holds the music anyway, so seven seconds of
 * dead screen would read as a hang; the show opens on the first visible
 * frame instead. The CORE still plays the whole script (the pixel gate
 * drives it from t=0); only `attachIntro`'s presentation pre-rolls.
 */
export const INTRO_PREROLL_T = 351;

/**
 * Hunk 4's base address under the research hunk-stitching convention
 * (hunk n at 0x0100_0000 * (n+1)). The copper plane-pointer slots hold
 * ADDRESSES, so the player pokes `base + offset` and the rasteriser subtracts
 * it back off — the same arithmetic as the original and the reference, kept
 * rather than normalised away so every intermediate value matches theirs.
 */
const H4_BASE = 0x0500_0000;

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

interface IntroFadeTable {
  readonly at: number;
  readonly repeats: number;
  readonly wait: number;
  /** [src (h1 offset), dst (h2 offset), step, count] per quad. */
  readonly quads: readonly (readonly [number, number, number, number])[];
}

interface IntroStream {
  readonly name: string;
  readonly at: number;
  readonly packedBytes: number;
  readonly frames?: number;
  readonly unpackedBytes?: number;
}

interface IntroList {
  readonly at: number;
  readonly kind: "blank" | "planar";
  readonly hires?: boolean;
  readonly ham?: boolean;
  readonly planes?: number;
  readonly y0?: number;
  readonly rows?: number;
}

interface IntroStill {
  readonly op: number;
  readonly stream: string;
  readonly slot: number;
  readonly stride: number;
  readonly fade: number;
  readonly list: number;
}

interface IntroOverlay {
  readonly dst: number;
  readonly slot: number;
  readonly planes: number;
  readonly planeStride: number;
}

export interface IntroManifest {
  readonly schema: string;
  readonly data: readonly { readonly file: string; readonly byteLength: number; readonly sha256: string }[];
  readonly screen: { readonly bytes: number };
  readonly script: readonly (readonly [number, number])[];
  readonly fades: readonly IntroFadeTable[];
  readonly streams: readonly IntroStream[];
  readonly lists: readonly IntroList[];
  readonly anim: {
    readonly bufA: number;
    readonly bufB: number;
    readonly size: number;
    readonly planeStride: number;
    readonly textSlot: number;
  };
  readonly backdrop: {
    readonly stream: string;
    readonly dst: number;
    readonly slot: number;
    readonly planes: number;
    readonly planeStride: number;
    readonly list: number;
  };
  readonly stillDst: number;
  readonly stills: readonly IntroStill[];
  readonly backdrops: readonly { readonly op: number; readonly fade: number }[];
  readonly textFades: readonly { readonly op: number; readonly fade: number; readonly set: boolean }[];
  readonly credits: {
    readonly clouds: IntroOverlay & { readonly stream: string };
    readonly overlayA: IntroOverlay;
    readonly overlayB: IntroOverlay;
    readonly pages: readonly string[];
    readonly list: number;
    readonly whiteSet: number;
    readonly cloudsFade: number;
    readonly showA: number;
    readonly showB: number;
    readonly blackFade: number;
    readonly firstWait: number;
    readonly pageWait: number;
  };
  readonly ops: {
    readonly intEnable: number;
    readonly anim: number;
    readonly credits: number;
    readonly exit: number;
  };
  readonly timing: { readonly tickHz: number; readonly endT: number };
  readonly paletteBlockEnd: number;
  readonly provenance?: {
    readonly sourceClass: string;
    readonly authorizationRequired: boolean;
  };
}

function fail(reason: string): never {
  throw new Error(`intro manifest: ${reason}`);
}

/**
 * Validates the parsed manifest far enough to trust its shape. Depth to match
 * what the core dereferences: every offset the player will read or write is
 * range-checked here or at use, so a truncated or edited manifest fails at
 * load rather than as a corrupt frame mid-show.
 */
export function introManifestFrom(parsed: unknown): IntroManifest {
  const doc = parsed as Partial<IntroManifest> | null;
  if (doc === null || typeof doc !== "object") fail("not an object");
  if (doc.schema !== INTRO_SCHEMA) fail(`schema is ${String(doc.schema)}`);
  if (!Array.isArray(doc.data) || doc.data.length !== 2) fail("data does not name two files");
  for (const entry of doc.data) {
    if (typeof entry?.file !== "string" || typeof entry.byteLength !== "number") fail("bad data entry");
  }
  if (!Array.isArray(doc.script) || doc.script.length === 0) fail("no script");
  for (const entry of doc.script) {
    if (!Array.isArray(entry) || typeof entry[0] !== "number" || typeof entry[1] !== "number") {
      fail("bad script entry");
    }
  }
  if (!Array.isArray(doc.fades) || doc.fades.length === 0) fail("no fade tables");
  for (const table of doc.fades) {
    if (typeof table?.at !== "number" || typeof table.repeats !== "number" || !Array.isArray(table.quads)) {
      fail("bad fade table");
    }
  }
  if (!Array.isArray(doc.streams) || !Array.isArray(doc.lists)) fail("no streams or lists");
  if (doc.screen?.bytes === undefined || doc.anim === undefined || doc.backdrop === undefined) {
    fail("no screen layout");
  }
  if (doc.stillDst === undefined || !Array.isArray(doc.stills) || !Array.isArray(doc.backdrops)) {
    fail("no still handlers");
  }
  if (!Array.isArray(doc.textFades) || doc.credits === undefined || doc.ops === undefined) {
    fail("no handler tables");
  }
  if (doc.timing?.tickHz !== 50) fail("tick rate is not 50 Hz");
  const last = doc.script[doc.script.length - 1];
  if (last === undefined || last[1] !== doc.ops.exit) fail("script does not end in the exit handler");
  return doc as IntroManifest;
}

// ---------------------------------------------------------------------------
// The assets, fetched
// ---------------------------------------------------------------------------

export interface IntroAssets {
  readonly manifest: IntroManifest;
  /** seg01 verbatim: the palette block and the packed streams. */
  readonly data: Uint8Array;
  /** seg02 verbatim: the eight copper lists. Copied per player, never shared. */
  readonly copper: Uint8Array;
}

const defaultFetch: TableArtFetch = (url) => fetch(url);

async function fetchBytes(url: string, fetchImpl: TableArtFetch): Promise<Uint8Array> {
  const response: TableArtResponse = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetches and validates the intro asset set: one manifest, two binaries. The
 * byte lengths are checked against the manifest's own claims — the digests are
 * the build guard's and the test suite's job — and a build without the gated
 * assets rejects on the first 404, which the boot path treats as "no intro".
 */
export async function loadIntroAssets(
  fetchImpl: TableArtFetch = defaultFetch,
  basePath: string = INTRO_BASE_PATH,
): Promise<IntroAssets> {
  const manifestBytes = await fetchBytes(`${basePath}${INTRO_MANIFEST}`, fetchImpl);
  const manifest = introManifestFrom(
    JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown,
  );
  const dataEntry = manifest.data[0];
  const copperEntry = manifest.data[1];
  if (dataEntry === undefined || copperEntry === undefined) throw new Error("intro manifest names no data");
  const [data, copper] = await Promise.all([
    fetchBytes(`${basePath}${dataEntry.file}`, fetchImpl),
    fetchBytes(`${basePath}${copperEntry.file}`, fetchImpl),
  ]);
  if (data.length !== dataEntry.byteLength) {
    throw new Error(`${dataEntry.file} is ${data.length} bytes, manifest says ${dataEntry.byteLength}`);
  }
  if (copper.length !== copperEntry.byteLength) {
    throw new Error(`${copperEntry.file} is ${copper.length} bytes, manifest says ${copperEntry.byteLength}`);
  }
  return { manifest, data, copper };
}

// ---------------------------------------------------------------------------
// The core: the script engine and the display model. Pure — no DOM, no clock.
// ---------------------------------------------------------------------------

function readU16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function writeU16(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >> 8) & 0xff;
  bytes[at + 1] = value & 0xff;
}

export class IntroCore {
  readonly #manifest: IntroManifest;
  readonly #h1: Uint8Array;
  readonly #h2: Uint8Array;
  readonly #h4: Uint8Array;
  readonly #fadeByAt: ReadonlyMap<number, IntroFadeTable>;
  readonly #streamByName: ReadonlyMap<string, IntroStream>;
  readonly #listByAt: ReadonlyMap<number, IntroList>;
  readonly #run: Generator<void, void, void>;

  /** The VBL counter (seg00+0x864): frames since interrupt enable. */
  #t = 0;
  /** Active copper list, as its h2 offset (COP1LC in list space). */
  #coplc = 0;
  /** The delta-animation stream pointer (seg00+0x85C). */
  #animAt: number;
  /** The text-animation double buffer (seg00+0x84C / 0x850). */
  #bufA: number;
  #bufB: number;
  #finished = false;

  /** Display state changed since the last rasterise. */
  #dirty = true;
  /** Increments per rasterise, so a presenter can skip unchanged frames. */
  #frameVersion = 0;
  readonly #pixels = new Uint8Array(INTRO_WIDTH * INTRO_ROWS * 3);
  // Rasteriser scratch, allocated once: palette words, combined RGB palette,
  // and the pixel-index plane composite for the largest band.
  readonly #palHi = new Uint16Array(256);
  readonly #palLo = new Int32Array(256);
  readonly #pal = new Uint8Array(256 * 3);
  readonly #planes = new Array<number>(8).fill(0);
  readonly #indices = new Uint8Array(INTRO_WIDTH * INTRO_ROWS);

  constructor(assets: IntroAssets) {
    this.#manifest = assets.manifest;
    this.#h1 = assets.data;
    // The fades mutate the copper palettes in place, so each core owns a copy
    // and a reload starts from the disk state, not from the last show's.
    this.#h2 = assets.copper.slice();
    this.#h4 = new Uint8Array(assets.manifest.screen.bytes);
    this.#animAt = assets.manifest.streams.find((s) => s.frames !== undefined)?.at ?? 0;
    this.#bufA = assets.manifest.anim.bufA;
    this.#bufB = assets.manifest.anim.bufB;
    this.#fadeByAt = new Map(assets.manifest.fades.map((table) => [table.at, table]));
    this.#streamByName = new Map(assets.manifest.streams.map((stream) => [stream.name, stream]));
    this.#listByAt = new Map(assets.manifest.lists.map((list) => [list.at, list]));
    this.#run = this.#script();
  }

  /** Frames since the interrupt enable; the script clock. */
  get t(): number {
    return this.#t;
  }

  get finished(): boolean {
    return this.#finished;
  }

  /** Bumps when the picture actually changed; holds cost nothing. */
  get frameVersion(): number {
    this.rgb();
    return this.#frameVersion;
  }

  /** Advances exactly one PAL frame. Returns false once the show has exited. */
  step(): boolean {
    if (this.#finished) return false;
    if (this.#run.next().done === true) this.#finished = true;
    return !this.#finished;
  }

  /**
   * The current 640x240 RGB frame, rasterised on demand. The buffer is owned
   * by the core and reused; callers copy if they keep it.
   */
  rgb(): Uint8Array {
    if (this.#dirty) {
      this.#rasterise();
      this.#dirty = false;
      this.#frameVersion += 1;
    }
    return this.#pixels;
  }

  // -- the script engine ----------------------------------------------------

  /** One PAL frame: the single point where time passes. */
  *#frame(): Generator<void, void, void> {
    this.#t += 1;
    yield;
  }

  /**
   * The main loop, a straight port of the reference's `run()`: frame first,
   * then dispatch at most one due entry; blocking handlers burn their own
   * frames, after which past-due entries fire on consecutive frames.
   */
  *#script(): Generator<void, void, void> {
    const { script, ops } = this.#manifest;
    const stillByOp = new Map(this.#manifest.stills.map((still) => [still.op, still]));
    const backdropByOp = new Map(this.#manifest.backdrops.map((entry) => [entry.op, entry]));
    const textFadeByOp = new Map(this.#manifest.textFades.map((entry) => [entry.op, entry]));
    let index = 0;
    while (index < script.length) {
      yield* this.#frame();
      const entry = script[index];
      if (entry === undefined) break;
      const [startT, op] = entry;
      if (this.#t < startT) continue;
      index += 1;
      if (op === ops.intEnable) {
        // Interrupts on; the counter is already running.
      } else if (op === ops.anim) {
        this.#animFrame();
      } else if (op === ops.credits) {
        yield* this.#credits();
      } else if (op === ops.exit) {
        return;
      } else if (backdropByOp.has(op)) {
        yield* this.#showBackdrop(backdropByOp.get(op)?.fade ?? 0);
      } else if (stillByOp.has(op)) {
        const still = stillByOp.get(op);
        if (still !== undefined) yield* this.#still(still);
      } else if (textFadeByOp.has(op)) {
        const textFade = textFadeByOp.get(op);
        if (textFade === undefined) continue;
        if (textFade.set) this.#pset(textFade.fade);
        else yield* this.#fade(textFade.fade);
      } else {
        throw new Error(`intro script names unknown handler 0x${op.toString(16)}`);
      }
    }
  }

  // -- the unpacker (seg00+0x770) -------------------------------------------

  /**
   * The whole "FreeAnim" format: `u16 N` then N+1 groups — 0x00: u16 skip;
   * 0x80|k: (k&0x7F)+1 literal bytes; 0x01..0x7F: repeat next byte c times.
   * Returns where the stream ended, which for the delta animation is the next
   * frame's start.
   */
  #unpack(srcAt: number, dstAt: number): number {
    const h1 = this.#h1;
    const h4 = this.#h4;
    let src = srcAt;
    let dst = dstAt;
    const groups = readU16(h1, src) + 1;
    src += 2;
    for (let group = 0; group < groups; group += 1) {
      const control = h1[src] ?? 0;
      src += 1;
      if (control === 0) {
        dst += readU16(h1, src);
        src += 2;
      } else if ((control & 0x80) !== 0) {
        const run = (control & 0x7f) + 1;
        h4.set(h1.subarray(src, src + run), dst);
        src += run;
        dst += run;
      } else {
        h4.fill(h1[src] ?? 0, dst, dst + control);
        src += 1;
        dst += control;
      }
    }
    this.#dirty = true;
    return src;
  }

  // -- the fade engine (seg00+0x7AE / 0x7D8) --------------------------------

  #requireFade(at: number): IntroFadeTable {
    const table = this.#fadeByAt.get(at);
    if (table === undefined) throw new Error(`intro manifest has no fade table 0x${at.toString(16)}`);
    return table;
  }

  /** One pass: every gun of every targeted palette word steps ONE nibble. */
  #fadePass(table: IntroFadeTable): void {
    for (const [src, dst, step, count] of table.quads) {
      for (let i = 0; i < count; i += 1) {
        const target = readU16(this.#h1, src + 2 * i);
        const current = readU16(this.#h2, dst + step * i);
        let out = 0;
        for (const shift of [0, 4, 8]) {
          const want = (target >> shift) & 0xf;
          let gun = (current >> shift) & 0xf;
          if (gun < want) gun += 1;
          else if (gun > want) gun -= 1;
          out |= gun << shift;
        }
        writeU16(this.#h2, dst + step * i, out);
      }
    }
    this.#dirty = true;
  }

  /** 16 passes, one per frame, the frame BEFORE the pass — the raster gate. */
  *#fade(at: number): Generator<void, void, void> {
    const table = this.#requireFade(at);
    for (let pass = 0; pass < table.repeats; pass += 1) {
      yield* this.#frame();
      this.#fadePass(table);
    }
  }

  /** The same table applied instantly (the credits' white flash). */
  #pset(at: number): void {
    const table = this.#requireFade(at);
    for (const [src, dst, step, count] of table.quads) {
      for (let i = 0; i < count; i += 1) {
        writeU16(this.#h2, dst + step * i, readU16(this.#h1, src + 2 * i));
      }
    }
    this.#dirty = true;
  }

  // -- copper pokes ---------------------------------------------------------

  /** Writes n plane pointers (as h4 addresses) into a list's MOVE slots. */
  #pokePlanes(slot: number, baseOffset: number, stride: number, planes: number): void {
    let at = slot;
    let address = H4_BASE + baseOffset;
    for (let plane = 0; plane < planes; plane += 1) {
      writeU16(this.#h2, at, (address >>> 16) & 0xffff);
      writeU16(this.#h2, at + 4, address & 0xffff);
      at += 8;
      address += stride;
    }
    this.#dirty = true;
  }

  #requireStream(name: string): IntroStream {
    const stream = this.#streamByName.get(name);
    if (stream === undefined) throw new Error(`intro manifest has no stream ${name}`);
    return stream;
  }

  // -- the handlers ---------------------------------------------------------

  /** seg00+0x274: copy shown over hidden, swap, unpack the delta, show. */
  #animFrame(): void {
    const { size, planeStride, textSlot } = this.#manifest.anim;
    this.#h4.copyWithin(this.#bufA, this.#bufB, this.#bufB + size);
    const shown = this.#bufA;
    this.#bufA = this.#bufB;
    this.#bufB = shown;
    this.#animAt = this.#unpack(this.#animAt, this.#bufB);
    this.#pokePlanes(textSlot, this.#bufB, planeStride, 2);
  }

  /** seg00+0x46A / 0x4D6 / 0x542: the purple-clouds text scene, faded in. */
  *#showBackdrop(fadeAt: number): Generator<void, void, void> {
    const backdrop = this.#manifest.backdrop;
    const { planeStride, textSlot } = this.#manifest.anim;
    this.#unpack(this.#requireStream(backdrop.stream).at, backdrop.dst);
    this.#pokePlanes(textSlot, this.#bufB, planeStride, 2);
    this.#pokePlanes(backdrop.slot, backdrop.dst, backdrop.planeStride, backdrop.planes);
    this.#coplc = backdrop.list;
    this.#dirty = true;
    yield* this.#fade(fadeAt);
  }

  /**
   * seg00+0x5AE..0x6CE: unpack the still, point its list's planes at it, fade
   * the CURRENT screen to white, and only then cut — which is why a still
   * appears complete at full palette out of a whiteout, exactly as filmed.
   */
  *#still(still: IntroStill): Generator<void, void, void> {
    this.#unpack(this.#requireStream(still.stream).at, this.#manifest.stillDst);
    this.#pokePlanes(still.slot, this.#manifest.stillDst, still.stride, 8);
    yield* this.#fade(still.fade);
    this.#coplc = still.list;
    this.#dirty = true;
  }

  /** seg00+0x2B8: the whole credits choreography, one blocking handler. */
  *#credits(): Generator<void, void, void> {
    const credits = this.#manifest.credits;
    const pages = credits.pages;
    this.#unpack(this.#requireStream(credits.clouds.stream).at, credits.clouds.dst);
    this.#unpack(this.#requireStream(pages[0] ?? "").at, credits.overlayA.dst);
    this.#unpack(this.#requireStream(pages[1] ?? "").at, credits.overlayB.dst);
    this.#pokePlanes(credits.clouds.slot, credits.clouds.dst, credits.clouds.planeStride, credits.clouds.planes);
    this.#pokePlanes(credits.overlayA.slot, credits.overlayA.dst, credits.overlayA.planeStride, credits.overlayA.planes);
    this.#pokePlanes(credits.overlayB.slot, credits.overlayB.dst, credits.overlayB.planeStride, credits.overlayB.planes);
    this.#coplc = credits.list;
    this.#pset(credits.whiteSet); // every bank white in one frame: the flash
    yield* this.#fade(credits.cloudsFade);
    yield* this.#wait(credits.firstWait);
    yield* this.#fade(credits.showA); // page 1 in
    yield* this.#wait(credits.pageWait);
    yield* this.#fade(credits.showB); // crossfade to page 2...
    for (let page = 2; page < pages.length; page += 1) {
      // ...while the NEXT page unpacks into whichever overlay the palette is
      // currently hiding. The pixels change immediately; the bank painting
      // keeps them invisible until their crossfade arrives.
      const hidden = page % 2 === 0 ? credits.overlayA : credits.overlayB;
      this.#unpack(this.#requireStream(pages[page] ?? "").at, hidden.dst);
      yield* this.#wait(credits.pageWait);
      yield* this.#fade(page % 2 === 0 ? credits.showA : credits.showB);
    }
    yield* this.#wait(credits.pageWait);
    yield* this.#fade(credits.cloudsFade); // letters out, clouds alone
    yield* this.#wait(credits.pageWait);
    yield* this.#fade(credits.blackFade); // and to black
  }

  /** Burns frames until the counter reaches now + span. */
  *#wait(span: number): Generator<void, void, void> {
    const until = this.#t + span;
    while (this.#t < until) yield* this.#frame();
  }

  // -- the rasteriser -------------------------------------------------------

  /**
   * Walks the current copper list into a palette and plane pointers, then
   * composites the planes and maps them — through the palette, or through
   * HAM8 — into the 640x240 reference canvas. A port of the reference's
   * `walk_list` + `render` + `ham8`, byte for byte.
   */
  #rasterise(): void {
    this.#pixels.fill(0);
    const meta = this.#listByAt.get(this.#coplc);
    if (meta === undefined || meta.kind !== "planar") return;
    this.#walkList(this.#coplc);
    const planes = meta.planes ?? 0;
    const rows = meta.rows ?? 0;
    const hires = meta.hires === true;
    const width = hires ? 640 : 320;
    const rowBytes = width >> 3;
    const indices = this.#indices;
    indices.fill(0, 0, rows * width);
    for (let plane = 0; plane < planes; plane += 1) {
      const address = this.#planes[plane] ?? 0;
      if (address === 0) continue;
      const offset = address - H4_BASE;
      if (offset < 0 || offset + rowBytes * rows > this.#h4.length) continue;
      const bit = 1 << plane;
      for (let row = 0; row < rows; row += 1) {
        const rowAt = offset + row * rowBytes;
        const outAt = row * width;
        for (let byte = 0; byte < rowBytes; byte += 1) {
          const bits = this.#h4[rowAt + byte] ?? 0;
          if (bits === 0) continue;
          const pixelAt = outAt + (byte << 3);
          if ((bits & 0x80) !== 0) indices[pixelAt] = (indices[pixelAt] ?? 0) | bit;
          if ((bits & 0x40) !== 0) indices[pixelAt + 1] = (indices[pixelAt + 1] ?? 0) | bit;
          if ((bits & 0x20) !== 0) indices[pixelAt + 2] = (indices[pixelAt + 2] ?? 0) | bit;
          if ((bits & 0x10) !== 0) indices[pixelAt + 3] = (indices[pixelAt + 3] ?? 0) | bit;
          if ((bits & 0x08) !== 0) indices[pixelAt + 4] = (indices[pixelAt + 4] ?? 0) | bit;
          if ((bits & 0x04) !== 0) indices[pixelAt + 5] = (indices[pixelAt + 5] ?? 0) | bit;
          if ((bits & 0x02) !== 0) indices[pixelAt + 6] = (indices[pixelAt + 6] ?? 0) | bit;
          if ((bits & 0x01) !== 0) indices[pixelAt + 7] = (indices[pixelAt + 7] ?? 0) | bit;
        }
      }
    }
    const y0 = meta.y0 ?? 0;
    if (meta.ham === true) this.#blitHam8(width, rows, y0, hires);
    else this.#blitIndexed(width, rows, y0, hires);
  }

  /** Palette and plane pointers out of one list's MOVE words. */
  #walkList(startAt: number): void {
    const h2 = this.#h2;
    this.#palHi.fill(0);
    this.#palLo.fill(-1);
    this.#planes.fill(0);
    let bank = 0;
    let loct = false;
    let at = startAt;
    while (at + 4 <= h2.length) {
      const first = readU16(h2, at);
      const second = readU16(h2, at + 2);
      if (first === 0xffff && second === 0xfffe) break;
      if ((first & 1) === 0) {
        const register = first & 0x1fe;
        if (register === 0x106) {
          // BPLCON3: the AGA palette bank select and the low-nibble (LOCT)
          // flag, which is how a 24-bit palette rides a 12-bit register file.
          bank = (second >> 13) & 7;
          loct = (second & 0x200) !== 0;
        } else if (register >= 0x180 && register <= 0x1be) {
          const index = bank * 32 + ((register - 0x180) >> 1);
          if (loct) this.#palLo[index] = second;
          else this.#palHi[index] = second;
        } else if (register >= 0xe0 && register <= 0xfe) {
          const plane = (register - 0xe0) >> 2;
          const current = this.#planes[plane] ?? 0;
          if (register % 4 === 0) this.#planes[plane] = current | (second << 16);
          else this.#planes[plane] = current | second;
        }
      }
      at += 4;
    }
    for (let index = 0; index < 256; index += 1) {
      const hi = this.#palHi[index] ?? 0;
      const loWord = this.#palLo[index] ?? -1;
      const lo = loWord === -1 ? hi : loWord;
      this.#pal[index * 3] = (((hi >> 8) & 0xf) << 4) | ((lo >> 8) & 0xf);
      this.#pal[index * 3 + 1] = (((hi >> 4) & 0xf) << 4) | ((lo >> 4) & 0xf);
      this.#pal[index * 3 + 2] = ((hi & 0xf) << 4) | (lo & 0xf);
    }
  }

  #blitIndexed(width: number, rows: number, y0: number, hires: boolean): void {
    const pal = this.#pal;
    const indices = this.#indices;
    const out = this.#pixels;
    for (let row = 0; row < rows; row += 1) {
      let at = (y0 + row) * INTRO_WIDTH * 3;
      const rowStart = row * width;
      for (let x = 0; x < width; x += 1) {
        const palAt = (indices[rowStart + x] ?? 0) * 3;
        const r = pal[palAt] ?? 0;
        const g = pal[palAt + 1] ?? 0;
        const b = pal[palAt + 2] ?? 0;
        out[at] = r;
        out[at + 1] = g;
        out[at + 2] = b;
        at += 3;
        if (!hires) {
          out[at] = r;
          out[at + 1] = g;
          out[at + 2] = b;
          at += 3;
        }
      }
    }
  }

  /**
   * AGA HAM8: the control bits are the two LOW bitplanes and the six HIGH
   * planes carry the value — the OPPOSITE end from HAM6. ctrl 00 loads
   * palette[v]; 01/10/11 modify blue/red/green, the value into the gun's top
   * six bits with the held low bits kept; the held colour resets to colour 0
   * at each line start.
   */
  #blitHam8(width: number, rows: number, y0: number, hires: boolean): void {
    const pal = this.#pal;
    const indices = this.#indices;
    const out = this.#pixels;
    for (let row = 0; row < rows; row += 1) {
      let r = pal[0] ?? 0;
      let g = pal[1] ?? 0;
      let b = pal[2] ?? 0;
      let at = (y0 + row) * INTRO_WIDTH * 3;
      const rowStart = row * width;
      for (let x = 0; x < width; x += 1) {
        const index = indices[rowStart + x] ?? 0;
        const control = index & 3;
        const value = index >> 2;
        if (control === 0) {
          const palAt = value * 3;
          r = pal[palAt] ?? 0;
          g = pal[palAt + 1] ?? 0;
          b = pal[palAt + 2] ?? 0;
        } else if (control === 1) {
          b = (value << 2) | (b & 3);
        } else if (control === 2) {
          r = (value << 2) | (r & 3);
        } else {
          g = (value << 2) | (g & 3);
        }
        out[at] = r;
        out[at + 1] = g;
        out[at + 2] = b;
        at += 3;
        if (!hires) {
          out[at] = r;
          out[at + 1] = g;
          out[at + 2] = b;
          at += 3;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The fire-input contract the host routes to `skip`
// ---------------------------------------------------------------------------

/**
 * The controls whose keys count as FIRE for the skip, per the original's own
 * behaviour (fire on either joystick port exits the intro): the flippers, the
 * launch, and start/Enter. Pause, nudge and the mute key deliberately do not
 * skip — none of them is a fire input, and the mute must stay usable over the
 * show.
 */
const FIRE_CONTROLS: ReadonlySet<Control> = new Set([
  "leftFlipper",
  "rightFlipper",
  "upperFlipper",
  "plunger",
  "start",
]);

/** True when a key event is a fire input. Built on the router's own tables. */
export function introFireKey(event: KeyEventLike): boolean {
  const code = event.code;
  if (code !== undefined) {
    const control = KEY_CODE_BINDINGS[code];
    if (control !== undefined) return FIRE_CONTROLS.has(control);
  }
  const name = (event.key ?? "").toLowerCase();
  const control = KEY_NAME_BINDINGS[name];
  return control !== undefined && FIRE_CONTROLS.has(control);
}

// ---------------------------------------------------------------------------
// The browser handle
// ---------------------------------------------------------------------------

/** What the host supplies. Injected, so the DOM harness can drive all of it. */
export interface IntroHost {
  /** The shell canvas's 2d context; the intro letterboxes into it. */
  readonly context: CanvasRenderingContext2D;
  /** The canvas itself, read each draw for its CURRENT backing size. */
  readonly canvas: HTMLCanvasElement;
  /** Offscreen surface factory, exactly `createShellSkin`'s. */
  surface(width: number, height: number): HTMLCanvasElement;
  /** Fired exactly once, when the show ends or is skipped. */
  onDone(): void;
}

export interface IntroHandle {
  /**
   * One animation frame: converts elapsed real time into whole 50 Hz ticks on
   * the shell's own fixed-step discipline, steps the core, and redraws. Call
   * from the host's frame loop while the intro owns the screen.
   */
  frame(timeMs: number): void;
  /** The fire skip. Idempotent; lands on `onDone` exactly once. */
  skip(): void;
  /** True once the show has ended or been skipped. */
  done(): boolean;
  /** For the page-hidden path, mirroring the shell clock's pause/resume. */
  pause(): void;
  resume(): void;
  /** The script clock, for tests and the curious. */
  t(): number;
}

/**
 * Wires the intro player over the shell canvas.
 *
 * The core is pure and the clock is `FixedStepScheduler` at the PAL rate —
 * the same class, same catch-up clamp, as `ShellClock` — so a 144 Hz display
 * runs the show no faster and a stalled tab does not fast-forward it. The
 * presenter draws the core's frame into a 640x240 offscreen surface only when
 * the picture actually changed (`frameVersion`), then letterboxes it 4:3 into
 * whatever the canvas currently is, every frame, so a rotation or a refit
 * never shows a stale stretch.
 */
export function attachIntro(
  assets: IntroAssets,
  host: IntroHost,
  preRollT: number = INTRO_PREROLL_T,
): IntroHandle {
  const core = new IntroCore(assets);
  // The loader-time lead-in, stepped through before the first real frame.
  // See INTRO_PREROLL_T; a test passes 0 to watch the whole script.
  while (core.t < preRollT && core.step()) {
    // Advancing is the whole body.
  }
  const scheduler = new FixedStepScheduler();
  const surface = host.surface(INTRO_WIDTH, INTRO_ROWS);
  const surfaceContext = surface.getContext("2d");
  if (surfaceContext === null) throw new Error("the intro surface did not give a 2d context");
  const image = surfaceContext.createImageData(INTRO_WIDTH, INTRO_ROWS);
  // Opaque once: the RGB copies below never touch alpha again.
  for (let at = 3; at < image.data.length; at += 4) image.data[at] = 255;

  let presentedVersion = -1;
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    scheduler.pause();
    host.onDone();
  };

  const present = (): void => {
    if (core.frameVersion !== presentedVersion) {
      presentedVersion = core.frameVersion;
      const rgb = core.rgb();
      const data = image.data;
      for (let pixel = 0, from = 0, to = 0; pixel < INTRO_WIDTH * INTRO_ROWS; pixel += 1, from += 3, to += 4) {
        data[to] = rgb[from] ?? 0;
        data[to + 1] = rgb[from + 1] ?? 0;
        data[to + 2] = rgb[from + 2] ?? 0;
      }
      surfaceContext.putImageData(image, 0, 0);
    }
    const context = host.context;
    const width = host.canvas.width;
    const height = host.canvas.height;
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    // The 640x240 canvas is a 640x480 square-pixel picture (each row is two);
    // one drawImage both doubles the rows and fits the 4:3 frame.
    const scale = Math.min(width / INTRO_WIDTH, height / (INTRO_ROWS * 2));
    const drawWidth = Math.max(1, Math.round(INTRO_WIDTH * scale));
    const drawHeight = Math.max(1, Math.round(INTRO_ROWS * 2 * scale));
    context.imageSmoothingEnabled = true;
    context.drawImage(
      surface,
      0,
      0,
      INTRO_WIDTH,
      INTRO_ROWS,
      (width - drawWidth) >> 1,
      (height - drawHeight) >> 1,
      drawWidth,
      drawHeight,
    );
  };

  return {
    frame: (timeMs) => {
      if (finished) return;
      if (scheduler.paused) scheduler.resume();
      const batch = scheduler.advance(millisecondsToNanos(timeMs));
      for (let tick = 0; tick < batch.ticks; tick += 1) {
        if (!core.step()) break;
      }
      present();
      if (core.finished) finish();
    },
    skip: finish,
    done: () => finished,
    pause: () => scheduler.pause(),
    resume: () => scheduler.resume(),
    t: () => core.t,
  };
}
