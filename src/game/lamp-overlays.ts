/**
 * LAMP OVERLAYS: the pixels that make a lit shot visible.
 *
 * ---------------------------------------------------------------------------
 * THE RENDER MODEL, AND WHY "OFF" IS THE STATE THAT DRAWS
 * ---------------------------------------------------------------------------
 * The shipped playfield artwork stores every insert LIT — verified by the lamp
 * exporter: all ~11,000 mask pixels per table sit on bit-7-clear palette
 * indices. The original's OFF blit (main.seg00 $753A, minterm $FC) SETS bit 7
 * of every masked pixel, moving the insert into the upper half of the 256-
 * colour palette where the artist painted the dim variants; the ON blit
 * ($74D8, minterm $0C) clears it again. So this module inverts the intuitive
 * layering: a LIT lamp draws nothing (the cached artwork already shows it
 * lit), and every lamp that is NOT lit composites its dim overlay — computed
 * as `artworkIndex | 0x80` through the artwork's own palette — over the
 * cached raster each frame. The six masked-image lamps (Extreme Sports) carry
 * explicit OFF and ON sprites instead and always draw one of the two.
 *
 * ---------------------------------------------------------------------------
 * WHAT DRIVES A LAMP
 * ---------------------------------------------------------------------------
 * Existing mode-VM state only, through the wiring the exporter decoded:
 *
 *   BLINKING — an element is ARMED and names this lamp on its START path
 *   (+$04). MEASURED: the START lamp handler sets the blink flag (`ori #2`)
 *   and writes 8 into the reload byte, so an armed shot blinks at 8 frames
 *   on, 8 frames off.
 *   STEADY — an element's AWARD relit this lamp through its +$08 path
 *   (`or.b d7,+5`, the always-on byte): the collected target stays lit.
 *   OFF — everything else. A lamp nothing drives shows its dim state, which
 *   is what an idle real machine shows too.
 *
 * The blink phase runs off the game's own tick counter rather than a private
 * one, so two runs of the same input render the same frames.
 *
 * ---------------------------------------------------------------------------
 * TESTABLE IN NODE, LIKE EVERYTHING ELSE THAT DRAWS
 * ---------------------------------------------------------------------------
 * Sprites are precomputed once per (artwork, lamps) pair into plain RGBA
 * buffers, and compositing writes into the renderer's `PixelTarget` — no
 * canvas anywhere. The browser layer (`src/browser/lamp-layer.ts`) wraps the
 * same sprites in small canvases; the pixels are decided here.
 */

import type { PixelTarget } from "../browser/playfield-renderer.js";
import type { ModeState } from "./mode-vm.js";
import type { TableArt } from "./table-art.js";
import type { TableLamp, TableLamps } from "./table-lamps.js";

/** RGBA, matching `ImageData` and `PixelTarget`. */
const BYTES_PER_PIXEL = 4;

/** A lamp's drawable states as RGBA sprites. Pixels off the mask have alpha 0. */
export interface LampSprite {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The dim state: drawn whenever the lamp is not visibly lit. Null for "none". */
  readonly off: Uint8ClampedArray | null;
  /**
   * The lit state, or null. Null for plane-7 lamps — the artwork under the
   * overlay IS the lit state, so lit draws nothing; the masked kind carries
   * its explicit lit sprite.
   */
  readonly on: Uint8ClampedArray | null;
}

/** How the mode VM is driving one lamp right now. */
export const LAMP_OFF = 0;
export const LAMP_BLINKING = 1;
export const LAMP_STEADY = 2;
export type LampMode = typeof LAMP_OFF | typeof LAMP_BLINKING | typeof LAMP_STEADY;

function maskBit(lamp: TableLamp, px: number, py: number): boolean {
  const rowBytes = lamp.width / 8;
  const byte = lamp.mask[py * rowBytes + (px >> 3)] ?? 0;
  return (byte & (0x80 >> (px & 7))) !== 0;
}

/** RGBA of one palette index out of the artwork's own palette. */
function paletteRgba(art: TableArt, index: number, out: Uint8ClampedArray, at: number): void {
  const entry = index * 3;
  out[at] = art.palette[entry] ?? 0;
  out[at + 1] = art.palette[entry + 1] ?? 0;
  out[at + 2] = art.palette[entry + 2] ?? 0;
  out[at + 3] = 255;
}

/**
 * Builds every lamp's sprites against one table's artwork.
 *
 * Pure and deterministic: the same artwork and the same lamp document produce
 * the same bytes. The plane-7 dim sprite is `artworkIndex | 0x80` through the
 * artwork palette on every mask pixel — the original's OFF blit, computed once
 * instead of per frame. Throws when the artwork and the lamp document are not
 * the same table, because a mask applied to the wrong picture would silently
 * dim the wrong pixels.
 */
export function buildLampSprites(art: TableArt, lamps: TableLamps): LampSprite[] {
  if (art.tableId !== lamps.tableId) {
    throw new Error(
      `lamp overlays for ${lamps.tableId} cannot be built against ${art.tableId} artwork`,
    );
  }
  return lamps.lamps.map((lamp) => {
    if (lamp.kind === "none") {
      return { index: lamp.index, x: 0, y: 0, width: 0, height: 0, off: null, on: null };
    }
    const size = lamp.width * lamp.height * BYTES_PER_PIXEL;
    const off = new Uint8ClampedArray(size);
    const on = lamp.kind === "masked" ? new Uint8ClampedArray(size) : null;
    for (let py = 0; py < lamp.height; py += 1) {
      for (let px = 0; px < lamp.width; px += 1) {
        if (!maskBit(lamp, px, py)) continue;
        const at = (py * lamp.width + px) * BYTES_PER_PIXEL;
        if (lamp.kind === "plane7") {
          const artIndex = art.indices[(lamp.y + py) * art.width + lamp.x + px] ?? 0;
          paletteRgba(art, artIndex | 0x80, off, at);
        } else {
          paletteRgba(art, lamp.off?.[py * lamp.width + px] ?? 0, off, at);
          if (on !== null) paletteRgba(art, lamp.on?.[py * lamp.width + px] ?? 0, on, at);
        }
      }
    }
    return { index: lamp.index, x: lamp.x, y: lamp.y, width: lamp.width, height: lamp.height, off, on };
  });
}

/**
 * How the mode VM is driving each lamp.
 *
 * READS the VM state, never writes it — the one-way street that keeps lamps
 * presentation. `state` may be null (a table with no mission layer): every
 * lamp is then off, which is the static dim table an unpowered machine shows.
 *
 * STEADY and BLINKING can both be asserted for one lamp (an element relit by
 * award while another arms the same insert); the original's scan computes
 * lit = (+0 OR +5) and then gates on the blink phase, so blinking wins the
 * gate and the same rule applies here: the mode is BLINKING, and the phase
 * decides visibility.
 */
/**
 * THE BALL-SAVE LAMP'S OWN BLINK, +0x004DEC..+0x004E20, which is not the
 * eight-frame group blink and is not anchored to the tick either — it is
 * anchored to the countdown itself:
 *
 *     004DEC  tst.w   $d8a(a5)
 *     004DF0  beq.b   $4e22             ; nothing armed -> leave the lamp alone
 *     004DF2  subq.w  #$1,$d8a(a5)
 *     004DF6  move.l  ([$2352,a5],$4),d0
 *     004DFE  beq.b   $4e22             ; no ball-save lamp on this table
 *     004E02  move.w  $d8a(a5),d0
 *     004E06  cmpi.w  #$64,d0 / bhi  $4e1c    ; > 100 frames
 *     004E0C  cmpi.w  #$32,d0 / bhi  $4e16    ; 51..100
 *     004E12  clr.b   (a1)                    ; <= 50: DARK
 *     004E16  andi.w  #$1,d0 / bra $4e20      ; 51..100: on every other frame
 *     004E1C  andi.w  #$4,d0                  ; > 100: four on, four off
 *     004E20  sne.b   (a1)
 *
 * So the lamp flashes slowly while more than two seconds remain, flashes at
 * 25 Hz through the last two, and goes OUT for the final second — a warning
 * that gets more urgent and then stops, which is why the byte is written with
 * `sne` off a mask of the countdown rather than off any clock.
 *
 * `ticks` is the value the countdown holds AFTER this frame's decrement, which
 * is what +0x004E02 re-reads. Returns null when nothing is armed, so the caller
 * leaves the lamp to whatever the mode layer wanted.
 */
export function ballSaveLampLit(ticks: number): boolean | null {
  if (ticks <= 0) return null;
  if (ticks > 100) return (ticks & 4) !== 0;
  if (ticks > 50) return (ticks & 1) !== 0;
  return false;
}

/** Descriptor +$64 slot 1. See `TableLamps.engine`. */
export const BALL_SAVE_ENGINE_SLOT = 1;
/**
 * Descriptor +$64 slot 0 — SHOOT AGAIN. See `TableLamps.engine`.
 *
 * Two instruction sites write it and they are the same sixteen bytes:
 * award effect 1's handler at +0x00606C, and the BALL-START RELIGHT at
 * +0x0050E0 whose guard two instructions earlier is `tst.b $10(a0)` on the
 * player record — *if this player still has an extra ball banked, light SHOOT
 * AGAIN*. Both do `st.b $5(a1)`, the whole byte rather than the player's bit,
 * because the engine lamps are machine-global. So the lamp is a plain readout
 * of the banked count, which is what this drives it from.
 */
export const SHOOT_AGAIN_ENGINE_SLOT = 0;

export function lampModes(
  lamps: TableLamps,
  state: ModeState | null,
  ballSaveTicks = 0,
  extraBalls = 0,
): Uint8Array {
  const modes = new Uint8Array(lamps.lamps.length);
  applyBallSaveLamp(lamps, modes, ballSaveTicks);
  applyShootAgainLamp(lamps, modes, extraBalls);
  if (state === null) return modes;
  for (let lamp = 0; lamp < modes.length; lamp += 1) {
    let mode: LampMode = LAMP_OFF;
    for (const element of lamps.awardElementsByLamp[lamp] ?? []) {
      if (state.awardLit[element] === 1) {
        mode = LAMP_STEADY;
        break;
      }
    }
    for (const element of lamps.startElementsByLamp[lamp] ?? []) {
      if (state.armed[element] === 1) {
        mode = LAMP_BLINKING;
        break;
      }
    }
    modes[lamp] = mode;
  }
  // AFTER the mode walk as well as before it, because the engine writes the
  // lamp byte itself every frame and nothing in the mode layer can outvote it.
  applyBallSaveLamp(lamps, modes, ballSaveTicks);
  applyShootAgainLamp(lamps, modes, extraBalls);
  return modes;
}

/** Engine slot 1, when the table has one and something is armed. */
function applyBallSaveLamp(lamps: TableLamps, modes: Uint8Array, ballSaveTicks: number): void {
  const lamp = lamps.engine[BALL_SAVE_ENGINE_SLOT] ?? -1;
  if (lamp < 0 || lamp >= modes.length) return;
  const lit = ballSaveLampLit(ballSaveTicks);
  if (lit === null) return;
  modes[lamp] = lit ? LAMP_STEADY : LAMP_OFF;
}

/**
 * Engine slot 0 — SHOOT AGAIN, steady while the player has an extra ball banked.
 *
 * STEADY and not blinking: both writers are `st.b $5(a1)` into the always-on
 * byte, with no `ori #2` on the blink flag anywhere near either of them, which
 * is the same distinction the START (blinking) and AWARD (steady) paths make.
 * And unlike the ball saver's slot 1 this is applied on EVERY frame rather than
 * only while something is armed — the machine's award lights it and only the
 * per-game lamp clear puts it out, so `extraBalls === 0` is a real OFF and not
 * "leave it to the mode layer". All three tables ship the lamp (Law 'n Justice
 * 0, BabeWatch 41, Extreme Sports 0), so the `< 0` guard is defensive only.
 */
function applyShootAgainLamp(lamps: TableLamps, modes: Uint8Array, extraBalls: number): void {
  const lamp = lamps.engine[SHOOT_AGAIN_ENGINE_SLOT] ?? -1;
  if (lamp < 0 || lamp >= modes.length) return;
  modes[lamp] = extraBalls > 0 ? LAMP_STEADY : LAMP_OFF;
}

/**
 * Whether a lamp shows its LIT face this frame.
 *
 * The blink clock is the measured one: START writes 8 into the reload byte and
 * the servicer toggles the phase each time it runs out, so the lamp is
 * `halfPeriod` ticks on, `halfPeriod` ticks off. The phase is anchored to the
 * game tick rather than to the arming instant — the original anchors each
 * lamp's countdown to its own START, but that per-lamp phase is runtime state
 * this reconstruction has no need to carry; every blinking lamp here shares
 * one phase, which is also what the original's group refreshes converge to.
 */
export function lampVisible(mode: number, tick: number, halfPeriodFrames: number): boolean {
  if (mode === LAMP_STEADY) return true;
  if (mode !== LAMP_BLINKING) return false;
  const half = Math.max(1, halfPeriodFrames);
  return Math.floor(tick / half) % 2 === 0;
}

/**
 * Composites the frame's lamp overlays over a playfield-sized raster.
 *
 * `target` is the frame's own buffer (a copy of, or a canvas over, the cached
 * artwork raster) — this function draws the CURRENT state and assumes the
 * pixels under each overlay are the artwork's; handing it the shared cached
 * raster itself would bake one frame's lamp state into every later frame.
 *
 * A lit plane-7 lamp draws nothing; a dark one draws its dim sprite; a masked
 * lamp always draws exactly one of its two faces.
 */
export function compositeLampOverlays(
  target: PixelTarget,
  sprites: readonly LampSprite[],
  modes: Uint8Array,
  tick: number,
  halfPeriodFrames: number,
): void {
  for (const sprite of sprites) {
    const visible = lampVisible(modes[sprite.index] ?? LAMP_OFF, tick, halfPeriodFrames);
    const face = visible ? sprite.on : sprite.off;
    if (face === null) continue;
    blitRgba(target, sprite, face);
  }
}

function blitRgba(target: PixelTarget, sprite: LampSprite, face: Uint8ClampedArray): void {
  for (let py = 0; py < sprite.height; py += 1) {
    const from = py * sprite.width * BYTES_PER_PIXEL;
    const to = ((sprite.y + py) * target.width + sprite.x) * BYTES_PER_PIXEL;
    for (let px = 0; px < sprite.width; px += 1) {
      const source = from + px * BYTES_PER_PIXEL;
      if ((face[source + 3] ?? 0) === 0) continue;
      const dest = to + px * BYTES_PER_PIXEL;
      target.data[dest] = face[source] ?? 0;
      target.data[dest + 1] = face[source + 1] ?? 0;
      target.data[dest + 2] = face[source + 2] ?? 0;
      target.data[dest + 3] = 255;
    }
  }
}
