/**
 * The phone. Pointer plumbing, the button deck, and the handful of platform
 * manners a browser on a touchscreen expects.
 *
 * ---------------------------------------------------------------------------
 * POINTER EVENTS ONLY
 * ---------------------------------------------------------------------------
 * Not one `touchstart` anywhere. Both sibling remakes converged on this
 * independently and the reason is the same in both: a Touch Event carries a
 * list that has to be diffed against the previous list, while a Pointer Event
 * carries an id, and an id is exactly what the router already keys its holder
 * sets on (`pointer:<id>`, `src/browser/input.ts`). Mouse, pen and finger then
 * arrive through one code path and the simulation cannot tell which it was.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR THINGS THAT MAKE A FLIPPER HOLD
 * ---------------------------------------------------------------------------
 * A cradle is the whole game, and holding a bat down for three seconds while a
 * thumb rolls a couple of millimetres is where naive touch code fails. Four
 * things together, and all four are load-bearing:
 *
 *  1. `setPointerCapture` on the down edge, in a `try/catch`. Every later event
 *     for that pointer is routed to the button even once the finger has left it.
 *     The catch is not decoration: older mobile browsers reject capture for a
 *     pointer that has already ended, and the global release below still cleans
 *     up.
 *  2. `pointerleave` releases ONLY IF THE POINTER IS NOT CAPTURED. Getting this
 *     backwards — releasing whenever the finger leaves the rectangle — is the
 *     classic mobile pinball bug, and it presents as a flipper that drops for no
 *     reason mid-cradle.
 *  3. Capture-phase `pointerup` and `pointercancel` on `window`. `pointercancel`
 *     is what iOS fires when the system decides your touch was really a gesture,
 *     and it is the single most common cause of a flipper welded up.
 *  4. Release-everything when the page goes away — which lives in `main.ts`
 *     beside the scheduler pause and the music stop, because those three things
 *     are one event.
 *
 * Multi-touch needs no code at all: two fingers are two ids are two sources, and
 * the router's holder sets already do the rest.
 *
 * ---------------------------------------------------------------------------
 * NO USER-AGENT SNIFFING, NO ACCELEROMETER
 * ---------------------------------------------------------------------------
 * Touch presentation is chosen by `(hover: none) and (pointer: coarse)` and, as
 * a second and stricter signal, by having actually seen a pointer whose
 * `pointerType` is `"touch"` — an observation, not a guess about the device. A
 * laptop with a touchscreen therefore gets the deck the moment its owner uses
 * the screen, and never before.
 *
 * The nudge is a BUTTON. Neither sibling reads `devicemotion` and neither
 * should: iOS gates motion behind a permission prompt, a real shake is
 * indistinguishable from walking, and Illusions' tilt is a measured mechanism
 * with a per-table nudge allowance (`src/game/tilt.ts`). Feeding that a noisy
 * continuous signal would tilt players who did nothing.
 */

import type { InputRouter } from "./input.js";
import type { ShellKey, ShellPhase } from "./shell.js";
import { isInitialsCharacter } from "./shell.js";
import {
  DECK_SLOTS,
  TOUCH_KEYS,
  canvasPointToShell,
  deckPlanFor,
  shellHitTest,
} from "./touch-zones.js";
import type { DeckPlan, DeckSlot, ShellHitState } from "./touch-zones.js";

/** The media query both siblings use, and the only device test in the project. */
export const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";

/** What the host has to supply. Everything else is read off the document. */
export interface TouchHost {
  readonly router: InputRouter;
  readonly canvas: HTMLCanvasElement;
  /** The shell, as the hit test needs it. */
  shellState(): ShellHitState;
  /** True while a ball is on the plunger rod, for the LAUNCH button. */
  ballInLane(): boolean;
  /** Feeds one key down exactly the path a keyboard key takes. */
  shellKey(key: ShellKey): void;
  /** Runs first on every pointer down: the audio unlock rides the gesture. */
  gesture(): void;
  /** Toggles the music mute and returns the new state. */
  toggleMute(): boolean;
  muted(): boolean;
  /**
   * Flips the RENDER-LAYER framing (full table <-> Amiga view) and returns
   * the new one. A presentation hook, not a control: the view used to be the
   * sim-side `toggleWholeTableView` control tapped through the router, and
   * the Fantasies-parity round moved the whole framing out of the simulation
   * (research/FANTASIES_PARITY_BRIEF.md §2.4), so the button follows it.
   */
  toggleFraming(): "full-table" | "amiga";
  /** The framing currently showing, for the button's own label. */
  framing(): "full-table" | "amiga";
}

export interface TouchHandle {
  /** Once a frame: relabels the deck, follows the phase, holds the wake lock. */
  refresh(): void;
  /** True while the soft keyboard's hidden input has focus. */
  ownsKeyboard(target: EventTarget | null): boolean;
  /** Whether the touch presentation is showing. */
  active(): boolean;
  detach(): void;
}

interface Binding {
  readonly target: HTMLElement;
  readonly type: string;
  readonly listener: EventListener;
  readonly options?: AddEventListenerOptions;
}

function isCoarse(view: Window): boolean {
  try {
    return view.matchMedia(COARSE_POINTER_QUERY).matches;
  } catch {
    // A browser without `matchMedia` is a browser without a touchscreen.
    return false;
  }
}

/**
 * Wires the deck, the canvas and the global backstop to a router.
 *
 * Returns a handle rather than a bare detach function because the deck's labels
 * are a function of the shell's phase, and something has to drive that once a
 * frame. Nothing in here runs any game logic — the module resolves a press to a
 * `Control` or a `ShellKey` and hands it on, which is the same rule
 * `src/browser/input.ts` states for itself.
 */
export function attachTouch(host: TouchHost): TouchHandle {
  const canvas = host.canvas;
  const document = canvas.ownerDocument;
  const view = document.defaultView;
  if (view === null) {
    throw new Error("the playfield canvas is not in a window");
  }
  const root = document.documentElement;
  const listeners: Binding[] = [];
  const globals: { type: string; listener: EventListener; options: AddEventListenerOptions }[] = [];

  const on = (
    target: HTMLElement,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, listener, options);
    listeners.push(options === undefined ? { target, type, listener } : { target, type, listener, options });
  };

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  let touchActive = isCoarse(view);
  /** Latched: once a finger has been seen the deck stays, whatever CSS thinks. */
  let sawFinger = false;

  const applyPresentation = (): void => {
    root.dataset["touch"] = touchActive || sawFinger ? "on" : "off";
  };
  applyPresentation();

  let mediaList: MediaQueryList | null = null;
  const onMediaChange = (): void => {
    touchActive = isCoarse(view);
    applyPresentation();
  };
  try {
    mediaList = view.matchMedia(COARSE_POINTER_QUERY);
    mediaList.addEventListener("change", onMediaChange);
  } catch {
    mediaList = null;
  }

  const noteFinger = (event: Event): void => {
    if (sawFinger) return;
    const pointerType = (event as PointerEvent).pointerType;
    if (pointerType !== "touch" && pointerType !== "pen") return;
    sawFinger = true;
    applyPresentation();
  };

  const showing = (): boolean => touchActive || sawFinger;

  // -------------------------------------------------------------------------
  // The deck
  // -------------------------------------------------------------------------

  const slots = new Map<DeckSlot, HTMLButtonElement>();
  const captions = new Map<DeckSlot, HTMLElement>();
  for (const slot of DECK_SLOTS) {
    const button = document.querySelector(`[data-deck-slot="${slot}"]`);
    if (button instanceof HTMLButtonElement) {
      slots.set(slot, button);
      const caption = button.querySelector(".deck__label");
      if (caption instanceof HTMLElement) captions.set(slot, caption);
    }
  }

  let plan: DeckPlan = deckPlanFor("attract", false);
  /**
   * Whether the DOM has ever been written from a plan.
   *
   * The markup carries the play labels so the deck reads sensibly with
   * JavaScript still loading, which means the starting `plan` above is a
   * DESCRIPTION OF NOTHING: comparing against it on the first pass would find
   * every label already correct and write none of them, leaving the buttons
   * saying LEFT and NUDGE on the attract screen forever.
   */
  let painted = false;
  /** Which slot each live pointer is on, so a re-plan can release it honestly. */
  const pointerSlots = new Map<number, DeckSlot>();

  const applyPlan = (next: DeckPlan): void => {
    for (const slot of DECK_SLOTS) {
      const binding = next[slot];
      const previous = plan[slot];
      const button = slots.get(slot);
      if (button === undefined) continue;
      if (!painted || binding.label !== previous.label) {
        const caption = captions.get(slot);
        if (caption !== undefined) caption.textContent = binding.label;
        else button.textContent = binding.label;
        button.setAttribute("aria-label", binding.label);
      }
      if (!painted || binding.hidden !== previous.hidden) button.hidden = binding.hidden;
    }
    painted = true;
    // A finger already down on a button whose meaning just changed must not keep
    // asserting the control it used to be — a phase change mid-cradle would
    // otherwise weld the old flipper down.
    for (const [pointerId, slot] of [...pointerSlots]) {
      const before = plan[slot];
      const after = next[slot];
      if (before.control === after.control && before.key === after.key && !after.hidden) continue;
      host.router.pointerUp(pointerId);
      pointerSlots.delete(pointerId);
    }
    plan = next;
  };

  const pressBinding = (slot: DeckSlot, event: PointerEvent, button: HTMLElement): void => {
    const binding = plan[slot];
    if (binding.hidden) return;
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Capture can be refused for a pointer that has already ended. The global
      // release below still clears the source, so this is recoverable.
    }
    if (binding.control !== null) {
      pointerSlots.set(event.pointerId, slot);
      host.router.pointerDown(event.pointerId, binding.control);
      return;
    }
    if (binding.key !== null) host.shellKey(binding.key);
  };

  for (const [slot, button] of slots) {
    on(button, "pointerdown", (event) => {
      event.preventDefault();
      host.gesture();
      noteFinger(event);
      pressBinding(slot, event as PointerEvent, button);
    });
    on(button, "pointerleave", (event) => {
      const pointer = event as PointerEvent;
      // Captured pointers keep feeding this button wherever the finger goes, and
      // retaining the capture is what stops a slide-out from reading as a
      // release. Only an UNcaptured pointer has genuinely left.
      if (button.hasPointerCapture(pointer.pointerId)) return;
      pointerSlots.delete(pointer.pointerId);
      host.router.pointerUp(pointer.pointerId);
    });
    // Belt and braces beside the window listeners: the fastest possible release
    // for the common case, and idempotent, because `pointerUp` for an id that
    // holds nothing is a no-op.
    on(button, "pointerup", (event) => {
      const pointer = event as PointerEvent;
      pointerSlots.delete(pointer.pointerId);
      host.router.pointerUp(pointer.pointerId);
    });
    on(button, "pointercancel", (event) => {
      const pointer = event as PointerEvent;
      pointerSlots.delete(pointer.pointerId);
      host.router.pointerUp(pointer.pointerId);
    });
    // A long press is a cradle, not a request for the copy/paste bubble or the
    // Android context menu. `-webkit-touch-callout` covers iOS; this covers the
    // rest, and it is the same press that must go on holding the bat up.
    on(button, "contextmenu", (event) => event.preventDefault());
  }

  // -------------------------------------------------------------------------
  // The top bar
  // -------------------------------------------------------------------------

  const barButton = (action: string): HTMLButtonElement | null => {
    const element = document.querySelector(`[data-bar-action="${action}"]`);
    return element instanceof HTMLButtonElement ? element : null;
  };

  const back = barButton("back");
  if (back !== null) {
    on(back, "pointerdown", (event) => {
      event.preventDefault();
      host.gesture();
      noteFinger(event);
      host.shellKey(TOUCH_KEYS.back);
    });
  }

  const viewToggle = barButton("view");
  /** The framing the button is currently labelled with; null until painted. */
  let framingPainted: "full-table" | "amiga" | null = null;
  const paintFraming = (): void => {
    if (viewToggle === null) return;
    const framing = host.framing();
    if (framing === framingPainted) return;
    framingPainted = framing;
    // Labelled with the CURRENT framing, `aria-pressed` marking the Amiga
    // side — the exact convention of Fantasies HD's game-bar button
    // (`game-mode.ts` there): the label names what you are looking at, the
    // title says what a press does.
    viewToggle.textContent = framing === "full-table" ? "FULL TABLE" : "AMIGA VIEW";
    viewToggle.setAttribute("aria-pressed", framing === "amiga" ? "true" : "false");
    viewToggle.setAttribute(
      "title",
      framing === "full-table"
        ? "Showing the whole table. Press for the Amiga view: the original 336x256 scrolling window."
        : "Showing the Amiga view. Press to see the whole table at once.",
    );
  };
  if (viewToggle !== null) {
    on(viewToggle, "pointerdown", (event) => {
      event.preventDefault();
      host.gesture();
      noteFinger(event);
      // The render-layer framing, not a sim control: the router never hears
      // about the view any more (see TouchHost.toggleFraming).
      host.toggleFraming();
      paintFraming();
    });
    paintFraming();
  }

  const mute = barButton("mute");
  /** The mute state the button is currently showing; null until first painted. */
  let mutePainted: boolean | null = null;
  const paintMute = (): void => {
    if (mute === null) return;
    const off = host.muted();
    if (off === mutePainted) return;
    mutePainted = off;
    mute.textContent = off ? "SOUND OFF" : "SOUND ON";
    mute.setAttribute("aria-pressed", off ? "true" : "false");
  };
  if (mute !== null) {
    on(mute, "pointerdown", (event) => {
      event.preventDefault();
      host.gesture();
      noteFinger(event);
      host.toggleMute();
      paintMute();
    });
    paintMute();
  }

  // -------------------------------------------------------------------------
  // The canvas
  // -------------------------------------------------------------------------

  on(canvas, "pointerdown", (event) => {
    const pointer = event as PointerEvent;
    host.gesture();
    noteFinger(pointer);
    // Menu taps are a touch affordance only. On a mouse the shell already has a
    // keyboard, and silently adding a second way to steer it would be a change
    // to desktop behaviour nobody asked for.
    if (!showing()) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const point = canvasPointToShell(pointer.clientX, pointer.clientY, rect);
    for (const key of shellHitTest(host.shellState(), point.x, point.y)) {
      host.shellKey(key);
    }
  });

  // -------------------------------------------------------------------------
  // The backstop
  // -------------------------------------------------------------------------

  const releasePointer = (event: Event): void => {
    const pointer = event as PointerEvent;
    pointerSlots.delete(pointer.pointerId);
    host.router.pointerUp(pointer.pointerId);
  };

  const addGlobal = (type: string, listener: EventListener, capture: boolean): void => {
    const options: AddEventListenerOptions = { capture };
    view.addEventListener(type, listener, options);
    globals.push({ type, listener, options });
  };

  // Capture phase, so a release is seen even if something downstream stops the
  // event, and on `window`, so it is seen even when the finger ended somewhere
  // else entirely.
  addGlobal("pointerup", releasePointer, true);
  addGlobal("pointercancel", releasePointer, true);
  addGlobal("lostpointercapture", releasePointer, true);

  // -------------------------------------------------------------------------
  // Name entry
  // -------------------------------------------------------------------------

  /**
   * The initials box, which is the one screen that needs characters.
   *
   * A visually hidden `<input>` rather than an on-canvas A-Z picker: the phone
   * already has a keyboard and it is better than anything that could be drawn
   * here. It is focused only while the shell is on `initials` AND the touch
   * presentation is showing, so a desktop keyboard never loses an event to it.
   */
  const entry = document.getElementById("initials-entry");
  const initials = entry instanceof HTMLInputElement ? entry : null;
  if (initials !== null) {
    on(initials, "input", (event) => {
      const input = event as InputEvent;
      const type = input.inputType;
      if (type === "deleteContentBackward" || type === "deleteContentForward") {
        host.shellKey(TOUCH_KEYS.erase);
      } else {
        for (const character of input.data ?? "") {
          const upper = character.toUpperCase();
          if (isInitialsCharacter(upper)) host.shellKey({ kind: "text", char: upper, index: -1 });
        }
      }
      // The shell owns the three characters; this element is a keyboard, not a
      // buffer, and letting it accumulate would make backspace ambiguous.
      initials.value = "";
    });
  }

  // -------------------------------------------------------------------------
  // Wake lock
  // -------------------------------------------------------------------------

  interface WakeLockSentinelLike {
    release(): Promise<void>;
  }
  interface WakeLockLike {
    request(type: "screen"): Promise<WakeLockSentinelLike>;
  }
  const wakeLockApi = (view.navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
  let sentinel: WakeLockSentinelLike | null = null;
  let requesting = false;
  /**
   * Whether the lock is still WANTED, as opposed to already granted.
   *
   * The request is asynchronous and a ball can drain while it is in flight —
   * or the whole chrome can be detached. Without this the lock arrives after
   * the phase moved on, is stored, and nothing looks at it again until the next
   * time play ENDS, so the screen stays awake through the entire front end.
   */
  let wantScreen = false;

  const holdScreen = (wanted: boolean): void => {
    if (wakeLockApi === undefined) return;
    wantScreen = wanted;
    if (wanted) {
      if (sentinel !== null || requesting) return;
      requesting = true;
      void wakeLockApi
        .request("screen")
        .then((next) => {
          // Granted late, for a ball that is already over.
          if (!wantScreen) {
            void next.release().catch(() => undefined);
            return;
          }
          sentinel = next;
        })
        .catch(() => {
          // Denied, or the document was not visible. A phone that dims mid-ball
          // is a lost ball, but it is not a reason to stop the game.
        })
        .finally(() => {
          requesting = false;
        });
      return;
    }
    const held = sentinel;
    sentinel = null;
    if (held !== null) void held.release().catch(() => undefined);
  };

  // -------------------------------------------------------------------------
  // The per-frame follow-up
  // -------------------------------------------------------------------------

  let lastPhase: ShellPhase | null = null;
  let lastShowing: boolean | null = null;

  const refresh = (): void => {
    const state = host.shellState();
    const next = deckPlanFor(state.phase, host.ballInLane());
    applyPlan(next);
    const visible = showing();
    if (state.phase !== lastPhase || visible !== lastShowing) {
      lastPhase = state.phase;
      lastShowing = visible;
      if (initials !== null) {
        if (state.phase === "initials" && visible) {
          initials.value = "";
          try {
            initials.focus({ preventScroll: true });
          } catch {
            initials.focus();
          }
        } else if (document.activeElement === initials) {
          initials.blur();
        }
      }
      // A phone that dims and locks mid-ball is a lost ball. Feature-detected,
      // released the moment the ball is not the thing on screen.
      holdScreen(visible && state.phase === "play");
    }
    paintMute();
    // The framing can change under the button — F9/F10, pad button 3 — so the
    // label follows it here as well as on the button's own tap.
    paintFraming();
  };

  return {
    refresh,
    ownsKeyboard: (target) => initials !== null && target === initials,
    active: showing,
    detach: () => {
      for (const binding of listeners) {
        binding.target.removeEventListener(binding.type, binding.listener, binding.options);
      }
      listeners.length = 0;
      for (const binding of globals) {
        view.removeEventListener(binding.type, binding.listener, binding.options);
      }
      globals.length = 0;
      mediaList?.removeEventListener("change", onMediaChange);
      // A finger still down on a button asserts its control through the router,
      // and every listener that could have released it has just been removed —
      // so detaching mid-cradle would weld the bat up for good. Same eviction
      // `applyPlan` does when a button changes meaning under a finger.
      for (const pointerId of [...pointerSlots.keys()]) {
        host.router.pointerUp(pointerId);
      }
      pointerSlots.clear();
      holdScreen(false);
    },
  };
}
