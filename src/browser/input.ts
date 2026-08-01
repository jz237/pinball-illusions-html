/**
 * Player input, unified into one control state.
 *
 * Keyboard, gamepad and touch all end up as the same ten abstract controls, and
 * the simulation only ever sees the abstraction. That is not tidiness: it is
 * what keeps the physics deterministic. Devices deliver events whenever they
 * like — a keyboard at the OS repeat rate, a gamepad only when someone polls
 * it, a touchscreen at the panel's own rate — and none of those rates has
 * anything to do with the 50 Hz simulation step. So this module never runs any
 * game logic and never looks at a clock. It accumulates edges as they arrive
 * and hands the fixed-step loop one snapshot per tick.
 *
 * ---------------------------------------------------------------------------
 * WHY EDGES, NOT JUST "IS DOWN"
 * ---------------------------------------------------------------------------
 * Two of the game's controls are edge-triggered in opposite directions: a
 * flipper fires the instant the key goes down, and the plunger fires the instant
 * it comes up. Sampling only "is this key down right now" loses both. Worse, it
 * loses them silently and intermittently: a 15 ms tap between two 20 ms ticks
 * is down at no sample point at all, so the flipper simply never moves and the
 * player blames the game. Every press and release is therefore latched into the
 * next snapshot and survives until it is sampled.
 *
 * Counts as well as flags, because "pressed at least once" and "pressed twice"
 * are different things to a player drumming the flipper button, and collapsing
 * them would quietly cap the tap rate at 50 Hz.
 *
 * ---------------------------------------------------------------------------
 * WHY CONTROLS COUNT SOURCES INSTEAD OF HOLDING A BOOLEAN
 * ---------------------------------------------------------------------------
 * Several inputs are bound to the same control on purpose — Z and left Shift are
 * both the left flipper, and a gamepad shoulder button is a third. If `down`
 * were a boolean then releasing Shift while Z is still held would drop the
 * flipper mid-shot. Each control instead tracks the set of sources currently
 * asserting it, and the press and release edges fire only on the transitions
 * into and out of empty. That is also exactly the behaviour multitouch needs,
 * where two fingers may land on the same on-screen button.
 *
 * ---------------------------------------------------------------------------
 * ON FLOATING POINT
 * ---------------------------------------------------------------------------
 * Gamepad axes are floats and there is no avoiding that. They are thresholded
 * to booleans here and never reach the simulation as numbers, so the only thing
 * a differing last bit can change is whether a stick a hair either side of the
 * dead zone counted as a nudge — never the trajectory that follows one.
 */

import type { PlungerInput } from "../game/plunger.js";

/**
 * The abstract controls. Ten, and deliberately no more: anything the game needs
 * that is not in this list is a game rule, not an input.
 */
export const CONTROLS = [
  "leftFlipper",
  "rightFlipper",
  "upperFlipper",
  "plunger",
  "nudgeLeft",
  "nudgeRight",
  "nudgeForward",
  "start",
  "pause",
  "toggleWholeTableView",
] as const;

export type Control = (typeof CONTROLS)[number];

const CONTROL_SET: ReadonlySet<string> = new Set<string>(CONTROLS);

export function isControl(value: string): value is Control {
  return CONTROL_SET.has(value);
}

/** What one control did over one tick. */
export interface ControlEdges {
  /** State at the moment of sampling. */
  readonly down: boolean;
  /** True if the control went down at least once during the tick. */
  readonly pressed: boolean;
  /** True if it came up at least once during the tick. */
  readonly released: boolean;
  /** How many distinct presses the tick contained; never below `pressed`. */
  readonly pressCount: number;
  readonly releaseCount: number;
}

/** One tick's worth of input. Immutable, so it can be logged for a replay. */
export interface ControlSnapshot {
  /** Increments once per `sample`, so a replay log can be checked for gaps. */
  readonly sequence: number;
  readonly controls: Readonly<Record<Control, ControlEdges>>;
}

const IDLE_EDGES: ControlEdges = Object.freeze({
  down: false,
  pressed: false,
  released: false,
  pressCount: 0,
  releaseCount: 0,
});

function buildControlRecord<T>(make: (control: Control) => T): Record<Control, T> {
  // Built by iterating CONTROLS rather than written out as a literal, so adding
  // a control cannot leave a hole that only shows up as an undefined at runtime.
  const record = {} as Record<Control, T>;
  for (const control of CONTROLS) {
    record[control] = make(control);
  }
  return record;
}

/** A snapshot in which nothing happened; useful as a loop's starting value. */
export const IDLE_SNAPSHOT: ControlSnapshot = Object.freeze({
  sequence: 0,
  controls: Object.freeze(buildControlRecord(() => IDLE_EDGES)),
});

export function edgesFor(snapshot: ControlSnapshot, control: Control): ControlEdges {
  return snapshot.controls[control];
}

export function isDown(snapshot: ControlSnapshot, control: Control): boolean {
  return snapshot.controls[control].down;
}

export function wasPressed(snapshot: ControlSnapshot, control: Control): boolean {
  return snapshot.controls[control].pressed;
}

export function wasReleased(snapshot: ControlSnapshot, control: Control): boolean {
  return snapshot.controls[control].released;
}

export function pressCount(snapshot: ControlSnapshot, control: Control): number {
  return snapshot.controls[control].pressCount;
}

export function releaseCount(snapshot: ControlSnapshot, control: Control): number {
  return snapshot.controls[control].releaseCount;
}

/** Adapts a snapshot to the shape the plunger expects. */
export function plungerInputFrom(snapshot: ControlSnapshot): PlungerInput {
  const edges = snapshot.controls.plunger;
  return { pressed: edges.pressed, released: edges.released, held: edges.down };
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/**
 * Keyboard defaults, by `KeyboardEvent.code` so they follow the physical key
 * rather than the layout. The original played with the shift keys as flippers
 * and space as the plunger; Z and / are the same fingers on a keyboard that
 * has no shift keys where an arcade cabinet would want them, and the comma and
 * full stop are there for the many Amiga ports that used them.
 *
 * The upper flipper gets one key per hand — X under the left flipper key, the
 * semicolon beside the right — because which hand is free depends on the table.
 */
export const KEY_CODE_BINDINGS: Readonly<Record<string, Control>> = Object.freeze({
  KeyZ: "leftFlipper",
  Comma: "leftFlipper",
  ShiftLeft: "leftFlipper",
  Slash: "rightFlipper",
  Period: "rightFlipper",
  ShiftRight: "rightFlipper",
  KeyX: "upperFlipper",
  Semicolon: "upperFlipper",
  Space: "plunger",
  ArrowLeft: "nudgeLeft",
  ArrowRight: "nudgeRight",
  ArrowUp: "nudgeForward",
  Enter: "start",
  NumpadEnter: "start",
  Escape: "pause",
  KeyP: "pause",
  F9: "toggleWholeTableView",
  F10: "toggleWholeTableView",
});

/**
 * Fallback bindings by `KeyboardEvent.key`, lower-cased, for events that carry
 * no `code` — synthetic events, some mobile keyboards, and older browsers.
 *
 * The shift keys are absent on purpose: `key` reports both of them as "Shift",
 * so honouring it here would make the left shift flip the right flipper on
 * exactly the devices least able to tell the difference.
 */
export const KEY_NAME_BINDINGS: Readonly<Record<string, Control>> = Object.freeze({
  z: "leftFlipper",
  ",": "leftFlipper",
  "/": "rightFlipper",
  ".": "rightFlipper",
  x: "upperFlipper",
  ";": "upperFlipper",
  " ": "plunger",
  spacebar: "plunger",
  arrowleft: "nudgeLeft",
  arrowright: "nudgeRight",
  arrowup: "nudgeForward",
  enter: "start",
  escape: "pause",
  esc: "pause",
  p: "pause",
  f9: "toggleWholeTableView",
  f10: "toggleWholeTableView",
});

/**
 * Standard-gamepad button numbers. Shoulders flip, because that is where a
 * pinball player's fingers already are, and the face button plunges.
 */
export const GAMEPAD_BUTTON_BINDINGS: Readonly<Record<number, Control>> = Object.freeze({
  0: "plunger",
  3: "toggleWholeTableView",
  4: "leftFlipper",
  5: "rightFlipper",
  6: "upperFlipper",
  7: "upperFlipper",
  8: "pause",
  9: "start",
  12: "nudgeForward",
  14: "nudgeLeft",
  15: "nudgeRight",
});

export interface GamepadAxisBinding {
  readonly axis: number;
  /** Which end of the axis triggers: -1 for negative, +1 for positive. */
  readonly direction: -1 | 1;
  readonly control: Control;
}

/** Left stick, mapped to the nudges. Pushing the table is a shove, not a steer. */
export const GAMEPAD_AXIS_BINDINGS: readonly GamepadAxisBinding[] = Object.freeze([
  Object.freeze({ axis: 0, direction: -1 as const, control: "nudgeLeft" as const }),
  Object.freeze({ axis: 0, direction: 1 as const, control: "nudgeRight" as const }),
  Object.freeze({ axis: 1, direction: -1 as const, control: "nudgeForward" as const }),
]);

/**
 * Stick thresholds, with the release point below the press point.
 *
 * A single threshold makes a stick resting near it chatter, emitting a press and
 * a release every poll; against a control with a cooldown, like the nudge, that
 * runs the tilt counter straight to its threshold without them moving a thumb.
 */
export const GAMEPAD_AXIS_PRESS_THRESHOLD = 0.5;
export const GAMEPAD_AXIS_RELEASE_THRESHOLD = 0.3;

/** Resolves a key event to a control, preferring `code` over `key`. */
export function controlForKeyEvent(event: KeyEventLike): Control | null {
  const code = event.code;
  if (code !== undefined && code !== "") {
    const byCode = KEY_CODE_BINDINGS[code];
    if (byCode !== undefined) return byCode;
  }
  const key = event.key;
  if (key !== undefined && key !== "") {
    const byName = KEY_NAME_BINDINGS[key.toLowerCase()];
    if (byName !== undefined) return byName;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event shapes
// ---------------------------------------------------------------------------

/**
 * The parts of a `KeyboardEvent` this module reads.
 *
 * Structural rather than the DOM type so the whole router can be exercised in
 * node with plain object literals — the tests that matter here are about edge
 * bookkeeping, and none of them should need a browser to run.
 */
export interface KeyEventLike {
  readonly code?: string | undefined;
  readonly key?: string | undefined;
  /** True for OS auto-repeat, which must not look like a new press. */
  readonly repeat?: boolean | undefined;
  preventDefault?: () => void;
}

export interface GamepadButtonLike {
  readonly pressed: boolean;
}

/** The parts of a `Gamepad` this module reads. */
export interface GamepadLike {
  readonly index?: number | undefined;
  readonly buttons: readonly GamepadButtonLike[];
  readonly axes: readonly number[];
}

interface MutableEdges {
  pressed: boolean;
  released: boolean;
  pressCount: number;
  releaseCount: number;
}

function freshEdges(): MutableEdges {
  return { pressed: false, released: false, pressCount: 0, releaseCount: 0 };
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * Collects device events and hands out one snapshot per simulation tick.
 *
 * Everything here is bookkeeping. The router has no notion of time, of ticks,
 * or of the game; `sample` is the only thing that advances it, and the
 * fixed-step loop is the only thing that should call it.
 */
export class InputRouter {
  readonly #holders: Map<Control, Set<string>>;
  readonly #edges: Record<Control, MutableEdges>;
  /** Which control each active pointer landed on, so pointer-up knows what to release. */
  readonly #pointers = new Map<number, Control>();
  #sequence = 0;

  constructor() {
    this.#holders = new Map(CONTROLS.map((control) => [control, new Set<string>()]));
    this.#edges = buildControlRecord(freshEdges);
  }

  /** Snapshots taken so far. */
  get sequence(): number {
    return this.#sequence;
  }

  #holdersFor(control: Control): Set<string> {
    const holders = this.#holders.get(control);
    if (holders === undefined) {
      throw new RangeError(`unknown control: ${control}`);
    }
    return holders;
  }

  /** True while any source is asserting the control. */
  isHeld(control: Control): boolean {
    return this.#holdersFor(control).size > 0;
  }

  /** Sources currently asserting a control, sorted, for diagnostics. */
  holdersOf(control: Control): readonly string[] {
    return [...this.#holdersFor(control)].sort();
  }

  /**
   * Asserts a control from a named source.
   *
   * Idempotent per source: a repeated press from the same source is not a new
   * edge, which is what makes key auto-repeat and gamepad polling harmless.
   */
  press(control: Control, source = "manual"): void {
    const holders = this.#holdersFor(control);
    if (holders.has(source)) return;
    const wasDown = holders.size > 0;
    holders.add(source);
    if (wasDown) return;
    const edges = this.#edges[control];
    edges.pressed = true;
    edges.pressCount += 1;
  }

  /** Drops one source's claim. The release edge fires only when the last one goes. */
  release(control: Control, source = "manual"): void {
    const holders = this.#holdersFor(control);
    if (!holders.delete(source)) return;
    if (holders.size > 0) return;
    const edges = this.#edges[control];
    edges.released = true;
    edges.releaseCount += 1;
  }

  /** Press and release in one call: a tap that need not span a tick. */
  tap(control: Control, source = "manual"): void {
    this.press(control, source);
    this.release(control, source);
  }

  /**
   * Handles a key-down. Returns the control it mapped to, or null if unbound,
   * so the caller can decide whether to swallow the browser's default.
   */
  handleKeyDown(event: KeyEventLike): Control | null {
    const control = controlForKeyEvent(event);
    if (control === null) return null;
    // Auto-repeat still resolves to a control — the caller must keep swallowing
    // the default for a held key — but it is not a new press.
    if (event.repeat !== true) {
      this.press(control, keySourceFor(event));
    }
    return control;
  }

  handleKeyUp(event: KeyEventLike): Control | null {
    const control = controlForKeyEvent(event);
    if (control === null) return null;
    this.release(control, keySourceFor(event));
    return control;
  }

  /**
   * Folds one polled gamepad into the control state.
   *
   * Gamepads are polled rather than evented, so this reconciles instead of
   * reacting: every control the pad asserts is pressed and every control it
   * does not is released, which means a pad that vanishes mid-frame simply
   * stops asserting and its controls come up cleanly on the next poll.
   */
  pollGamepad(pad: GamepadLike, index = pad.index ?? 0): void {
    const source = `pad:${index}`;
    const asserted = new Set<Control>();

    for (let button = 0; button < pad.buttons.length; button += 1) {
      const control = GAMEPAD_BUTTON_BINDINGS[button];
      if (control === undefined) continue;
      if (pad.buttons[button]?.pressed === true) asserted.add(control);
    }

    for (const binding of GAMEPAD_AXIS_BINDINGS) {
      const value = pad.axes[binding.axis];
      if (value === undefined || !Number.isFinite(value)) continue;
      const magnitude = value * binding.direction;
      // Hysteresis reads the current hold rather than a stored latch: the hold
      // set is already the authority on whether this pad has the control down.
      const threshold = this.#holdersFor(binding.control).has(source)
        ? GAMEPAD_AXIS_RELEASE_THRESHOLD
        : GAMEPAD_AXIS_PRESS_THRESHOLD;
      if (magnitude >= threshold) asserted.add(binding.control);
    }

    for (const control of CONTROLS) {
      if (asserted.has(control)) {
        this.press(control, source);
      } else {
        this.release(control, source);
      }
    }
  }

  /** Removes every claim a gamepad holds, for a disconnect. */
  dropGamepad(index: number): void {
    this.releaseSource(`pad:${index}`);
  }

  /**
   * A finger or mouse landing on an on-screen control.
   *
   * Keyed by pointer id so two fingers on the two flipper buttons are genuinely
   * independent, and so a finger that slides off still releases the control it
   * started on rather than sticking down forever.
   */
  pointerDown(pointerId: number, control: Control): void {
    const existing = this.#pointers.get(pointerId);
    if (existing !== undefined && existing !== control) {
      this.release(existing, pointerSourceFor(pointerId));
    }
    this.#pointers.set(pointerId, control);
    this.press(control, pointerSourceFor(pointerId));
  }

  /** Lifts a pointer. Returns the control it was on, or null if it held none. */
  pointerUp(pointerId: number): Control | null {
    const control = this.#pointers.get(pointerId);
    if (control === undefined) return null;
    this.#pointers.delete(pointerId);
    this.release(control, pointerSourceFor(pointerId));
    return control;
  }

  /** Releases every control a named source holds. */
  releaseSource(source: string): void {
    for (const control of CONTROLS) {
      this.release(control, source);
    }
  }

  /**
   * Releases everything, as on losing focus.
   *
   * The release edges are kept rather than discarded: a plunger wound up when
   * the player alt-tabbed should fire, not stay armed until they come back and
   * are surprised by a ball leaving the lane on its own.
   */
  releaseAll(): void {
    for (const control of CONTROLS) {
      const holders = this.#holdersFor(control);
      if (holders.size === 0) continue;
      holders.clear();
      const edges = this.#edges[control];
      edges.released = true;
      edges.releaseCount += 1;
    }
    this.#pointers.clear();
  }

  /**
   * Takes the tick's snapshot and clears the edge buffers.
   *
   * Held state survives; edges do not. Call exactly once per simulation tick —
   * calling it twice would hand the second caller a tick with no edges in it,
   * and calling it less often than the loop steps would let a tap be sampled
   * two ticks after it happened.
   */
  sample(): ControlSnapshot {
    this.#sequence += 1;
    const controls = buildControlRecord<ControlEdges>((control) => {
      const edges = this.#edges[control];
      const snapshot: ControlEdges = Object.freeze({
        down: this.#holdersFor(control).size > 0,
        pressed: edges.pressed,
        released: edges.released,
        pressCount: edges.pressCount,
        releaseCount: edges.releaseCount,
      });
      edges.pressed = false;
      edges.released = false;
      edges.pressCount = 0;
      edges.releaseCount = 0;
      return snapshot;
    });
    return Object.freeze({ sequence: this.#sequence, controls: Object.freeze(controls) });
  }

  /**
   * Clears held state, buffered edges and the sample counter.
   *
   * Unlike `releaseAll` this emits no release edges — it is for starting a new
   * game or a replay from a known state, where a phantom release would be an
   * input the recording does not contain.
   */
  reset(): void {
    for (const control of CONTROLS) {
      this.#holdersFor(control).clear();
      const edges = this.#edges[control];
      edges.pressed = false;
      edges.released = false;
      edges.pressCount = 0;
      edges.releaseCount = 0;
    }
    this.#pointers.clear();
    this.#sequence = 0;
  }
}

/**
 * Identity of a key as an input source.
 *
 * `code` when there is one, so the two shift keys are distinct sources; falling
 * back to `key` keeps the up event matching the down event on devices that send
 * neither consistently.
 */
function keySourceFor(event: KeyEventLike): string {
  const code = event.code;
  if (code !== undefined && code !== "") return `key:${code}`;
  const key = event.key;
  return `key:${key === undefined ? "" : key.toLowerCase()}`;
}

function pointerSourceFor(pointerId: number): string {
  return `pointer:${pointerId}`;
}

// ---------------------------------------------------------------------------
// Optional DOM wiring
// ---------------------------------------------------------------------------

/**
 * The slice of `EventTarget` needed to listen for keys.
 *
 * Taken from the DOM type rather than hand-written, so `window` satisfies it
 * without a cast at the call site and a test double is held to the same
 * signature the browser actually uses. Only the two methods are borrowed: the
 * router itself has no DOM dependency and is exercised against plain objects.
 */
export type KeyEventSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Wires a router to a keyboard source. Returns the detach function.
 *
 * Bound keys get their default swallowed — space scrolls the page and the
 * function keys open browser menus, either of which ends a ball — while
 * unbound keys are left entirely alone so the page stays usable.
 *
 * The cast to `KeyEventLike` is the one place the DOM meets this module: a
 * `KeyboardEvent` carries the three fields the bindings read, and narrowing
 * here keeps every other function in the file testable without one.
 */
export function attachKeyboard(router: InputRouter, target: KeyEventSource): () => void {
  const onKeyDown = (event: Event): void => {
    const keyEvent = event as KeyEventLike;
    if (router.handleKeyDown(keyEvent) !== null) keyEvent.preventDefault?.();
  };
  const onKeyUp = (event: Event): void => {
    const keyEvent = event as KeyEventLike;
    if (router.handleKeyUp(keyEvent) !== null) keyEvent.preventDefault?.();
  };
  // A window that loses focus never delivers the matching key-ups, so without
  // this a flipper held during an alt-tab stays down when the player returns.
  const onBlur = (): void => router.releaseAll();

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);

  return () => {
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("keyup", onKeyUp);
    target.removeEventListener("blur", onBlur);
  };
}
