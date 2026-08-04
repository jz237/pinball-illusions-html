/**
 * The score panel INTEGRATOR: the seam between the game's tick reports and the
 * panel data layer / renderer, which were built canvas-free and event-free on
 * purpose (`table-panel.ts` decodes, `panel-renderer.ts` sequences and
 * rasterises; neither knows what a tick report is).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS RECONSTRUCTS (docs/DISK_ANALYSIS.md, the panel decode)
 * ---------------------------------------------------------------------------
 * The original's $6C2C appends a display record to the 64-slot pointer ring at
 * $23A2/$239E/$23A0, consumed one at a time: queued animations play in order
 * and the panel shows the score between them. What gets appended is wired in
 * the data this project already ships:
 *
 *   - a mode element's +$14 display record on START,
 *   - its +$18 display record on AWARD,
 *   - a message record's own animation list when it is shown
 *     (mission starts arrive through exactly these: MODE_START runs the
 *     mission script, whose STARTs and MESSAGEs land here on the same tick),
 *
 * and the panel document's `references` carries the resolved object lists for
 * all three — chained objects already expanded by the exporter. This class
 * looks those indices up from the `GameTickReport`, queues the decoded
 * animations on the `panel-renderer` state machine (the reconstruction of the
 * 64-slot ring), and advances playback one step per report.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM AND ISOLATION
 * ---------------------------------------------------------------------------
 * State here advances ONLY in `observe`, which is called once per simulation
 * tick with that tick's report — so the panel is a pure function of the tick
 * stream, two identical runs show identical strips, and nothing under
 * `src/game` imports any of this. Decoding is lazy and cached: an object is
 * expanded to per-pixel frames the first time something queues it, never
 * before, and the cache is keyed by object id so replays cost nothing.
 *
 * Everything except `draw` runs headless; `draw` is the one canvas-touching
 * method, and node tests use `renderInto` instead.
 */

import type { GameTickReport, PanelCard, PanelPresenter } from "./game-loop.js";
import {
  PANEL_HEIGHT,
  PANEL_WIDTH,
  createPanelState,
  enqueuePanelAnimation,
  panelIsIdle,
  renderPanelInto,
  stepPanel,
} from "./panel-renderer.js";
import type { PanelAnimation, PanelBonusView, PanelCardView, PanelState } from "./panel-renderer.js";
import { createPixelTarget } from "./playfield-renderer.js";
import type { PixelTarget } from "./playfield-renderer.js";
import { PANEL_UNLIT } from "./palette.js";
import { decodePanelObjectFrames, panelFramePixels } from "../game/table-panel.js";
import type { TablePanel } from "../game/table-panel.js";
import type { ShellFont } from "../game/shell-art.js";

/** A canvas the blit path can draw to; injectable so nothing here assumes DOM. */
export type PanelSurfaceFactory = (
  width: number,
  height: number,
) => HTMLCanvasElement | OffscreenCanvas;

export class PanelDisplay implements PanelPresenter {
  readonly #panel: TablePanel;
  /**
   * The score font, polled per draw rather than captured: the shell art
   * arrives over the network after boot, and the panel switches from "not
   * ready" to drawing the moment it lands, with no callback plumbing.
   */
  readonly #font: () => ShellFont | null;
  readonly #startsByElement = new Map<number, readonly number[]>();
  readonly #awardsByElement = new Map<number, readonly number[]>();
  readonly #objectsByMessage = new Map<number, readonly number[]>();
  /** Decoded animations by object id. Immutable once built, shared by replays. */
  readonly #animations = new Map<number, PanelAnimation>();
  #state: PanelState = createPanelState();
  /**
   * The end-of-ball bonus panel, from the tick report.
   *
   * Held rather than passed to `draw`, so the panel stays what its header says
   * it is — a pure function of the tick stream — and so a caller that never
   * heard of the bonus gets it anyway.
   */
  #bonus: PanelBonusView | null = null;

  // The blit path, all lazy: nothing canvas-shaped exists until `draw` runs.
  readonly #createSurface: PanelSurfaceFactory;
  readonly #target: PixelTarget = createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT);
  #surface: HTMLCanvasElement | OffscreenCanvas | null = null;
  #surfaceContext: { putImageData(data: ImageData, x: number, y: number): void } | null = null;
  #image: ImageData | null = null;

  constructor(
    panel: TablePanel,
    font: () => ShellFont | null,
    createSurface?: PanelSurfaceFactory,
  ) {
    this.#panel = panel;
    this.#font = font;
    this.#createSurface =
      createSurface ??
      ((width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      });
    for (const wiring of panel.references.elements) {
      if (wiring.start.length > 0) this.#startsByElement.set(wiring.element, wiring.start);
      if (wiring.award.length > 0) this.#awardsByElement.set(wiring.element, wiring.award);
    }
    for (const wiring of panel.references.messages) {
      if (wiring.objects.length > 0) this.#objectsByMessage.set(wiring.message, wiring.objects);
    }
  }

  /** The playback state, for tests and instrumentation. Never mutate it. */
  get state(): PanelState {
    return this.#state;
  }

  /** True when nothing is queued and the strip is on the score view. */
  get idle(): boolean {
    return panelIsIdle(this.#state);
  }

  /**
   * Consumes one tick's report: advance playback one tick, then append what
   * the tick queued. Step BEFORE enqueue so a newly queued animation is on its
   * frame 0 for the render that follows this tick — stepping after would eat
   * the first frame of every speed-1 object.
   */
  observe(report: GameTickReport): void {
    this.#bonus = report.bonus;
    this.#state = stepPanel(this.#state, 1);
    for (const element of report.elementStarts) {
      this.#enqueue(this.#startsByElement.get(element));
    }
    for (const element of report.elementAwards) {
      this.#enqueue(this.#awardsByElement.get(element));
    }
    for (const message of report.messagesShown) {
      this.#enqueue(this.#objectsByMessage.get(message));
    }
  }

  /**
   * Back to the idle score view. Called on game start: the ring's contents
   * belong to the game that queued them, and a fresh game opening on the last
   * one's leftover prize art would be showing a lie.
   */
  reset(): void {
    this.#state = createPanelState();
    this.#bonus = null;
  }

  #enqueue(objects: readonly number[] | undefined): void {
    if (objects === undefined) return;
    for (const id of objects) {
      this.#state = enqueuePanelAnimation(this.#state, this.#animationFor(id));
    }
  }

  /**
   * One object's decoded, per-pixel animation, cached.
   *
   * `holdLastFrame` for the single-frame objects: those are the prize-art and
   * indicator stills, and the renderer's documented model is that a still sits
   * on screen until something is queued behind it rather than flashing for one
   * divider period and vanishing.
   */
  #animationFor(id: number): PanelAnimation {
    const cached = this.#animations.get(id);
    if (cached !== undefined) return cached;
    const object = this.#panel.objects[id];
    if (object === undefined) {
      throw new RangeError(`panel reference names object ${id}, which the heap does not hold`);
    }
    const frames = decodePanelObjectFrames(object).map((frame) => ({
      width: object.pixelWidth,
      height: object.height,
      pixels: panelFramePixels(object, frame),
    }));
    const animation: PanelAnimation =
      frames.length === 1
        ? { frames, speedDivider: object.speed, holdLastFrame: true }
        : { frames, speedDivider: object.speed };
    this.#animations.set(id, animation);
    return animation;
  }

  /**
   * Rasterises the current strip into a caller-supplied 320 x 16 target with
   * the caller's font. The headless entry point — everything `draw` shows, a
   * node test can assert byte for byte through here. `card` is the
   * PLAYER/BALL announcement, when one is up.
   */
  renderInto(
    target: PixelTarget,
    score: number,
    font: ShellFont,
    card?: PanelCardView | null,
  ): PixelTarget {
    return renderPanelInto(this.#state, score, font, target, this.#bonus, card);
  }

  /**
   * Draws the panel band across the top of a `viewWidth`-wide view: unlit
   * glass across the full width, the 320-px strip centred in it (the view is
   * 336 source pixels wide; the original's display, and the strip, are 320).
   * Returns false — drawing nothing — until the shell font has arrived.
   */
  draw(
    context: CanvasRenderingContext2D,
    score: number,
    scale: number,
    viewWidth: number,
    card?: PanelCard | null,
  ): boolean {
    const font = this.#font();
    if (font === null) return false;

    renderPanelInto(this.#state, score, font, this.#target, this.#bonus, card);

    if (this.#surface === null) {
      this.#surface = this.#createSurface(PANEL_WIDTH, PANEL_HEIGHT);
      const surfaceContext = this.#surface.getContext("2d");
      if (surfaceContext === null) return false;
      this.#surfaceContext = surfaceContext as unknown as {
        putImageData(data: ImageData, x: number, y: number): void;
      };
      this.#image = new ImageData(PANEL_WIDTH, PANEL_HEIGHT);
    }
    if (this.#surfaceContext === null || this.#image === null) return false;
    this.#image.data.set(this.#target.data);
    this.#surfaceContext.putImageData(this.#image, 0, 0);

    const [r, g, b] = PANEL_UNLIT;
    context.fillStyle = `rgb(${r},${g},${b})`;
    context.fillRect(0, 0, viewWidth * scale, PANEL_HEIGHT * scale);
    const left = Math.floor((viewWidth - PANEL_WIDTH) / 2) * scale;
    context.imageSmoothingEnabled = false;
    context.drawImage(
      this.#surface as CanvasImageSource,
      left,
      0,
      PANEL_WIDTH * scale,
      PANEL_HEIGHT * scale,
    );
    return true;
  }
}
