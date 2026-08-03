/**
 * The deck: the layer between a finger and a flipper.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `touch-zones.test.ts` proves the arithmetic — every phase's `deckPlanFor`,
 * every hit rectangle, every synthesised key. `input.test.ts` proves the router
 * — `pointerDown` to a held control to a `ControlSnapshot` edge. Between those
 * two well-tested halves sat `attachTouch`, its `refresh`, and the `applyPlan`
 * that rewrites the DOM, with NOTHING asserting any of it. That layer is where
 * the interesting failures are: the plan can be right and the buttons still say
 * the wrong thing, the labels can be right and the button still bound to
 * nothing, and neither is visible to a unit test of either half.
 *
 * It is also the layer no browser here can watch. `refresh()` is driven from the
 * animation frame and every browser available to this machine reports
 * `visibilityState: "hidden"` with `requestAnimationFrame` suspended — measured
 * at 0 frames in 5 s on a fresh tab — so the relabel-into-play is precisely the
 * claim that could not be seen working. `tests/dom-harness.ts` is the browser
 * instead, built to the shipped `index.html` rather than to a copy of it.
 *
 * The assertions below are deliberately LITERAL. Every expected label is written
 * out as a string rather than fetched from `deckPlanFor`, because driving the
 * real `attachTouch` code path and then comparing it against the same function
 * it calls would prove only that a function equals itself.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createTouchHarness, readDeckMarkup } from "./dom-harness.js";
import type { HarnessOptions, TouchHarness } from "./dom-harness.js";
import { DECK_SLOTS, TOUCH_KEYS, WINDOW_HEIGHT, WINDOW_WIDTH } from "../src/browser/touch-zones.js";
import type { DeckSlot } from "../src/browser/touch-zones.js";
import { MENU_RECTS, SHELL_ORIGIN_X } from "../src/browser/shell-screens.js";
import type { ShellPhase } from "../src/browser/shell.js";
import type { Control } from "../src/browser/input.js";
import type { TouchHandle } from "../src/browser/touch.js";

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

interface Fixture {
  readonly h: TouchHarness;
  readonly touch: TouchHandle;
}

let open: TouchHarness | null = null;
let attached: TouchHandle | null = null;

function fixture(options: HarnessOptions = {}): Fixture {
  const h = createTouchHarness(options);
  open = h;
  const touch = h.attach();
  attached = touch;
  return { h, touch };
}

afterEach(() => {
  attached?.detach();
  open?.dispose();
  attached = null;
  open = null;
});

/** One deck state, as the DOM reports it. */
type Shape = Record<DeckSlot, { label: string; hidden: boolean }>;

const BLANK = { label: "", hidden: true } as const;

function menuShape(action: string): Shape {
  return {
    left: { label: "◀", hidden: false },
    up: { label: "▲", hidden: false },
    down: { label: "▼", hidden: false },
    right: { label: "▶", hidden: false },
    action: { label: action, hidden: false },
  };
}

/**
 * What the five buttons must say on every screen in the union.
 *
 * A total `Record<ShellPhase, …>`, so a phase added to the shell is a TYPE
 * ERROR here rather than a screen whose deck nobody ever checked — the same
 * discipline `PHASE_HITS` uses in `touch-zones.ts`.
 */
const EXPECTED: Record<ShellPhase, Shape> = {
  attract: menuShape("OK"),
  menu: menuShape("OK"),
  select: menuShape("OK"),
  info: menuShape("OK"),
  failed: menuShape("OK"),
  "game-over": menuShape("OK"),
  fanfare: menuShape("OK"),
  ladder: menuShape("START"),
  loading: { left: BLANK, up: BLANK, down: BLANK, right: BLANK, action: BLANK },
  // The no-ball variant; the ball-in-lane one is asserted beside it below.
  play: {
    left: { label: "LEFT", hidden: false },
    up: { label: "UP", hidden: false },
    down: { label: "NUDGE", hidden: false },
    right: { label: "RIGHT", hidden: false },
    action: BLANK,
  },
  "quit-confirm": {
    left: { label: "PLAY ON", hidden: false },
    up: BLANK,
    down: BLANK,
    right: { label: "QUIT", hidden: false },
    action: BLANK,
  },
  initials: {
    left: { label: "DEL", hidden: false },
    up: BLANK,
    down: BLANK,
    right: { label: "OK", hidden: false },
    action: BLANK,
  },
};

const PHASES = Object.keys(EXPECTED) as ShellPhase[];

/** Whether a control is asserting, sampled the way the game loop samples it. */
function held(h: TouchHarness, control: Control): boolean {
  return h.router.isHeld(control);
}

// ---------------------------------------------------------------------------

describe("the shipped markup carries the deck the module reads", () => {
  const markup = readDeckMarkup();

  it("names every slot `DECK_SLOTS` expects, and no others", () => {
    const names = markup.slots.map(([slot]) => slot);
    expect([...names].sort()).toEqual([...DECK_SLOTS].sort());
  });

  it("gives every deck button a label span for the relabel to write into", () => {
    for (const [slot, label] of markup.slots) {
      expect(label, `${slot} has no .deck__label`).not.toBe("");
    }
  });

  it("ships the PLAY labels, which is why the first paint cannot be skipped", () => {
    // The markup reads sensibly with JavaScript still loading, and that is
    // exactly what makes the starting plan inside `attachTouch` a description of
    // nothing. Written down here because the `painted` guard below depends on it.
    expect(Object.fromEntries(markup.slots)).toEqual({
      up: "UP",
      down: "NUDGE",
      action: "LAUNCH",
      left: "LEFT",
      right: "RIGHT",
    });
  });

  it("carries the three top-bar actions and the hidden name box", () => {
    expect(markup.barActions.map(([action]) => action)).toEqual(["back", "view", "mute"]);
    expect(markup.hasInitialsInput).toBe(true);
    expect(markup.hasCanvas).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("refresh() rewrites the deck for the screen that is showing", () => {
  it.each(PHASES)("%s", (phase) => {
    const { h, touch } = fixture({ coarse: true, phase });
    touch.refresh();
    expect(h.deckShape()).toEqual(EXPECTED[phase]);
  });

  it("labels the LAUNCH button when a ball is on the rod", () => {
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: true });
    touch.refresh();
    expect(h.deckShape()).toEqual({
      left: { label: "LEFT", hidden: false },
      up: { label: "UP", hidden: false },
      down: { label: "NUDGE", hidden: false },
      right: { label: "RIGHT", hidden: false },
      action: { label: "LAUNCH", hidden: false },
    });
  });

  it("mirrors every label into aria-label, so the buttons are readable aloud", () => {
    const { h, touch } = fixture({ coarse: true, phase: "quit-confirm" });
    touch.refresh();
    for (const slot of DECK_SLOTS) {
      expect(h.aria(slot), slot).toBe(EXPECTED["quit-confirm"][slot].label);
    }
  });

  it("follows a phase change from the menu into play and back out", () => {
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    touch.refresh();
    expect(h.label("left")).toBe("◀");

    h.shell.phase = "play";
    h.ballInLane = true;
    touch.refresh();
    expect(h.deckShape()).toEqual({
      left: { label: "LEFT", hidden: false },
      up: { label: "UP", hidden: false },
      down: { label: "NUDGE", hidden: false },
      right: { label: "RIGHT", hidden: false },
      action: { label: "LAUNCH", hidden: false },
    });

    h.shell.phase = "quit-confirm";
    touch.refresh();
    expect(h.label("left")).toBe("PLAY ON");
    expect(h.label("right")).toBe("QUIT");

    h.shell.phase = "menu";
    touch.refresh();
    expect(h.deckShape()).toEqual(menuShape("OK"));
  });

  it("paints on the FIRST refresh even though the plan matches its starting value", () => {
    // The regression the `painted` flag exists for. `attachTouch` starts holding
    // `deckPlanFor("attract", false)`, so on the attract screen the first
    // refresh computes a plan EQUAL to the one it is holding; a plain
    // difference check would write nothing and leave the buttons saying LEFT and
    // NUDGE — the markup's play labels — on the attract screen forever.
    const { h, touch } = fixture({ coarse: true, phase: "attract" });
    expect(h.label("left")).toBe("LEFT");
    expect(h.label("down")).toBe("NUDGE");
    h.resetWrites();

    touch.refresh();

    expect(h.deckShape()).toEqual(menuShape("OK"));
    const writes = h.deckWrites();
    expect(writes.text).toBe(5);
    expect(writes.attribute).toBe(5);
    expect(writes.hidden).toBe(5);
  });

  it("does not need a coarse pointer to keep the deck honest", () => {
    // The deck is hidden by CSS on a desktop, but it is still relabelled: a
    // laptop with a touchscreen gets the presentation the moment a finger
    // arrives, and it must not arrive to a screen's worth of stale labels.
    const { h, touch } = fixture({ coarse: false, phase: "select" });
    touch.refresh();
    expect(h.deckShape()).toEqual(menuShape("OK"));
  });
});

// ---------------------------------------------------------------------------

describe("in play the deck is the cabinet", () => {
  function playing(): Fixture {
    const f = fixture({ coarse: true, phase: "play", ballInLane: true });
    f.touch.refresh();
    return f;
  }

  it("puts a leftFlipper down edge in the snapshot on a pointerdown", () => {
    // The one assertion the QA sweep could not make in a browser.
    const { h } = playing();
    h.press("left", 4);

    const snapshot = h.router.sample();
    expect(snapshot.controls.leftFlipper.down).toBe(true);
    expect(snapshot.controls.leftFlipper.pressed).toBe(true);
    expect(snapshot.controls.leftFlipper.pressCount).toBe(1);
    expect(snapshot.controls.rightFlipper.pressed).toBe(false);
  });

  it.each([
    ["left", "leftFlipper"],
    ["right", "rightFlipper"],
    ["up", "upperFlipper"],
    ["down", "nudgeForward"],
    ["action", "plunger"],
  ] as const)("binds the %s button to %s", (slot, control) => {
    const { h } = playing();
    h.press(slot, 9);
    expect(h.router.holdersOf(control)).toEqual(["pointer:9"]);
    const down = h.router.sample();
    expect(down.controls[control].pressed).toBe(true);
    expect(down.controls[control].down).toBe(true);

    h.lift(slot, 9);
    const up = h.router.sample();
    expect(up.controls[control].released).toBe(true);
    expect(up.controls[control].down).toBe(false);
  });

  it("holds the bat for a cradle: one press edge, many ticks down", () => {
    const { h } = playing();
    h.press("left", 1);
    const first = h.router.sample();
    expect(first.controls.leftFlipper.pressed).toBe(true);

    for (let tick = 0; tick < 150; tick += 1) {
      const snapshot = h.router.sample();
      expect(snapshot.controls.leftFlipper.down).toBe(true);
      expect(snapshot.controls.leftFlipper.pressed).toBe(false);
      expect(snapshot.controls.leftFlipper.released).toBe(false);
    }

    h.lift("left", 1);
    expect(h.router.sample().controls.leftFlipper.released).toBe(true);
  });

  it("routes two fingers to two bats independently", () => {
    const { h } = playing();
    h.press("left", 1);
    h.press("right", 2);
    expect(held(h, "leftFlipper")).toBe(true);
    expect(held(h, "rightFlipper")).toBe(true);

    h.lift("left", 1);
    expect(held(h, "leftFlipper")).toBe(false);
    expect(held(h, "rightFlipper")).toBe(true);
  });

  it("runs the audio unlock on every press, because a tap is the only gesture", () => {
    const { h } = playing();
    h.press("left", 1);
    h.press("right", 2);
    expect(h.log.gestures).toBe(2);
  });

  it("swallows the default, so a press is not also a scroll or a zoom", () => {
    const { h } = playing();
    expect(h.press("left", 1).defaultPrevented).toBe(true);
  });

  it("refuses the browser's long-press menu, which a cradle would otherwise open", () => {
    const { h } = playing();
    expect(h.dispatch(h.deck("left"), "contextmenu").defaultPrevented).toBe(true);
  });

  it("presses no control at all on a menu screen", () => {
    // The same physical button, a different meaning. Proving the binding follows
    // the plan and not the markup.
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    touch.refresh();
    h.press("left", 1);
    expect(h.router.holdersOf("leftFlipper")).toEqual([]);
    expect(h.log.keys).toEqual([TOUCH_KEYS.left]);
  });

  it("taps a shell key rather than holding it, so a held button repeats nothing", () => {
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    touch.refresh();
    h.press("action", 1);
    h.lift("action", 1);
    expect(h.log.keys).toEqual([TOUCH_KEYS.select]);
  });

  it("does nothing when a hidden button is pressed", () => {
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: false });
    touch.refresh();
    expect(h.isHidden("action")).toBe(true);
    h.press("action", 1);
    expect(held(h, "plunger")).toBe(false);
    expect(h.log.keys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the relabel is idempotent and does not thrash the DOM", () => {
  it("writes nothing on a second refresh in the same phase", () => {
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    touch.refresh();
    h.resetWrites();
    touch.refresh();
    expect(h.deckWrites()).toEqual({ text: 0, hidden: 0, attribute: 0, focus: 0, blur: 0 });
  });

  it("writes nothing across a second of frames", () => {
    // 60 frames is a second on a phone, and this runs once per frame from the
    // animation callback. A single unguarded write here is a layout thrash per
    // frame for the whole game.
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: true });
    touch.refresh();
    h.resetWrites();
    for (let frame = 0; frame < 60; frame += 1) touch.refresh();
    expect(h.deckWrites()).toEqual({ text: 0, hidden: 0, attribute: 0, focus: 0, blur: 0 });
  });

  it("writes only the labels that actually changed", () => {
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    touch.refresh();
    h.resetWrites();

    // Menu to ladder differs in exactly one label: OK becomes START.
    h.shell.phase = "ladder";
    touch.refresh();
    const writes = h.deckWrites();
    expect(writes.text).toBe(1);
    expect(writes.attribute).toBe(1);
    expect(writes.hidden).toBe(0);
    expect(h.label("action")).toBe("START");
  });

  it("touches only the LAUNCH button when the ball arrives on the rod", () => {
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: false });
    touch.refresh();
    h.resetWrites();

    h.ballInLane = true;
    touch.refresh();
    const writes = h.deckWrites();
    expect(writes.text).toBe(1);
    expect(writes.attribute).toBe(1);
    expect(writes.hidden).toBe(1);
    expect(h.label("action")).toBe("LAUNCH");
    expect(h.isHidden("action")).toBe(false);
  });

  it("paints the mute button once and then leaves it alone", () => {
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    // Painted during `attachTouch`, so the label is right before the first frame.
    expect(h.bar("mute").textContent).toBe("SOUND ON");
    expect(h.bar("mute").getAttribute("aria-pressed")).toBe("false");

    h.resetWrites();
    for (let frame = 0; frame < 30; frame += 1) touch.refresh();
    expect(h.bar("mute").writes.text).toBe(0);
    expect(h.bar("mute").writes.attribute).toBe(0);
  });

  it("repaints the mute button exactly once when the state changes", () => {
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    h.resetWrites();

    h.dispatch(h.bar("mute"), "pointerdown", { pointerId: 3 });
    expect(h.log.muteToggles).toBe(1);
    expect(h.bar("mute").textContent).toBe("SOUND OFF");
    expect(h.bar("mute").getAttribute("aria-pressed")).toBe("true");
    expect(h.bar("mute").writes.text).toBe(1);

    for (let frame = 0; frame < 10; frame += 1) touch.refresh();
    expect(h.bar("mute").writes.text).toBe(1);
  });

  it("follows a mute change made somewhere other than the button", () => {
    // The `mutePainted` write guard must not become a write BLOCK: the keyboard
    // and the console can both flip the music, and the next frame has to notice.
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    h.resetWrites();
    h.muted = true;
    touch.refresh();
    expect(h.bar("mute").textContent).toBe("SOUND OFF");
    expect(h.bar("mute").writes.text).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("LAUNCH follows the ball", () => {
  it("is hidden while the rod is empty", () => {
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: false });
    touch.refresh();
    expect(h.isHidden("action")).toBe(true);
    expect(h.label("action")).toBe("");
  });

  it("appears when a ball arrives and goes again when it leaves", () => {
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: false });
    touch.refresh();

    h.ballInLane = true;
    touch.refresh();
    expect(h.isHidden("action")).toBe(false);
    expect(h.label("action")).toBe("LAUNCH");

    h.ballInLane = false;
    touch.refresh();
    expect(h.isHidden("action")).toBe(true);
  });

  it("releases the plunger if the button vanishes under the finger", () => {
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: true });
    touch.refresh();
    h.press("action", 5);
    expect(held(h, "plunger")).toBe(true);

    h.ballInLane = false;
    touch.refresh();

    expect(held(h, "plunger")).toBe(false);
    expect(h.router.sample().controls.plunger.released).toBe(true);
  });

  it("leaves the other four bound while LAUNCH comes and goes", () => {
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: true });
    touch.refresh();
    h.press("left", 1);

    h.ballInLane = false;
    touch.refresh();

    expect(held(h, "leftFlipper")).toBe(true);
    expect(h.router.holdersOf("leftFlipper")).toEqual(["pointer:1"]);
  });
});

// ---------------------------------------------------------------------------

describe("nothing sticks: every way a press can end", () => {
  function playing(options: HarnessOptions = {}): Fixture {
    const f = fixture({ coarse: true, phase: "play", ballInLane: true, ...options });
    f.touch.refresh();
    return f;
  }

  it("releases on a pointerup on the button", () => {
    const { h } = playing();
    h.press("left", 1);
    h.lift("left", 1);
    expect(held(h, "leftFlipper")).toBe(false);
  });

  it("releases on pointercancel, which is what iOS sends for a stolen touch", () => {
    // The single most common cause of a flipper welded up, per the module's own
    // header, and the reason the window listener is in the capture phase.
    const { h } = playing();
    h.press("left", 1);
    h.dispatch(h.deck("left"), "pointercancel", { pointerId: 1 });
    expect(held(h, "leftFlipper")).toBe(false);
    expect(h.router.sample().controls.leftFlipper.released).toBe(true);
  });

  it("releases on a pointercancel that never reaches the button", () => {
    const { h } = playing();
    h.deck("left").refusePointerCapture = true;
    h.press("left", 1);
    // Straight at the window, as a system gesture takeover delivers it.
    h.dispatch(h.window, "pointercancel", { pointerId: 1 });
    expect(held(h, "leftFlipper")).toBe(false);
  });

  it("releases when the finger lifts somewhere else entirely", () => {
    // Capture refused — an older mobile browser rejecting a pointer it thinks has
    // ended — so nothing re-targets and only the global backstop can save this.
    const { h } = playing();
    h.deck("left").refusePointerCapture = true;
    h.press("left", 1);
    expect(h.deck("left").hasPointerCapture(1)).toBe(false);

    h.dispatch(h.document.body, "pointerup", { pointerId: 1 });
    expect(held(h, "leftFlipper")).toBe(false);
  });

  it("releases on lostpointercapture", () => {
    const { h } = playing();
    h.press("left", 1);
    h.dispatch(h.deck("left"), "lostpointercapture", { pointerId: 1 });
    expect(held(h, "leftFlipper")).toBe(false);
  });

  it("KEEPS the bat down when a captured finger slides off the button", () => {
    // Getting this backwards is the classic mobile pinball bug: the flipper
    // drops mid-cradle because a thumb rolled two millimetres.
    const { h } = playing();
    h.press("left", 1);
    expect(h.deck("left").hasPointerCapture(1)).toBe(true);

    h.dispatch(h.deck("left"), "pointerleave", { pointerId: 1 });

    expect(held(h, "leftFlipper")).toBe(true);
    const snapshot = h.router.sample();
    expect(snapshot.controls.leftFlipper.down).toBe(true);
    expect(snapshot.controls.leftFlipper.released).toBe(false);
  });

  it("releases on a leave when the pointer was never captured", () => {
    const { h } = playing();
    h.deck("left").refusePointerCapture = true;
    h.press("left", 1);
    h.dispatch(h.deck("left"), "pointerleave", { pointerId: 1 });
    expect(held(h, "leftFlipper")).toBe(false);
  });

  it("releases a bat whose button changes meaning under the finger", () => {
    // A phase change mid-cradle. Without the eviction in `applyPlan` the old
    // control would go on being asserted by a button that is now a d-pad arrow.
    const { h, touch } = playing();
    h.press("left", 1);
    expect(held(h, "leftFlipper")).toBe(true);

    h.shell.phase = "quit-confirm";
    touch.refresh();

    expect(held(h, "leftFlipper")).toBe(false);
    expect(h.router.sample().controls.leftFlipper.released).toBe(true);
  });

  it("keeps a bat that means the same thing across a re-plan", () => {
    const { h, touch } = playing();
    h.press("left", 1);
    for (let frame = 0; frame < 20; frame += 1) touch.refresh();
    expect(held(h, "leftFlipper")).toBe(true);
  });

  it("gives up a deck-held bat to releaseAll, the page-level backstop's action", () => {
    // `blur`, `pagehide`, `visibilitychange` and `orientationchange` all end in
    // `router.releaseAll()` (see the wiring pin below). What matters here is
    // that a control held through the DECK — a `pointer:<id>` source, not a key
    // — is genuinely dropped by it, edge and all.
    const { h } = playing();
    h.press("left", 1);
    h.press("right", 2);

    h.router.releaseAll();

    expect(held(h, "leftFlipper")).toBe(false);
    expect(held(h, "rightFlipper")).toBe(false);
    const snapshot = h.router.sample();
    expect(snapshot.controls.leftFlipper.released).toBe(true);
    expect(snapshot.controls.rightFlipper.released).toBe(true);
  });

  it("survives a pointerup for a finger that was never down", () => {
    const { h } = playing();
    h.dispatch(h.window, "pointerup", { pointerId: 77 });
    expect(h.router.sample().controls.leftFlipper.releaseCount).toBe(0);
  });

  it("releases only the finger that ended", () => {
    const { h } = playing();
    h.press("left", 1);
    h.press("right", 2);
    h.dispatch(h.deck("left"), "pointercancel", { pointerId: 1 });
    expect(held(h, "leftFlipper")).toBe(false);
    expect(held(h, "rightFlipper")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the page-level backstops main.ts owns", () => {
  /**
   * A source pin, and honestly labelled as one.
   *
   * `blur`, `pagehide`, `visibilitychange` and `orientationchange` are wired
   * inside `boot()`, which fetches assets and builds an audio graph and cannot
   * be called from a test. The behaviour they invoke IS asserted above, against
   * a control genuinely held through the deck; what is left to lose is the
   * wiring — a line deleted in a refactor — and this is what can be checked.
   */
  const source = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

  /** The balanced text starting at `open`, which must index a bracket. */
  function balanced(text: string, open: number): string {
    const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
    const stack: string[] = [];
    let quote: string | null = null;
    for (let i = open; i < text.length; i += 1) {
      const ch = text[i] ?? "";
      if (quote !== null) {
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      const close = pairs[ch];
      if (close !== undefined) {
        stack.push(close);
        continue;
      }
      if (stack.length > 0 && ch === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) return text.slice(open, i + 1);
      }
    }
    throw new Error("unbalanced source");
  }

  /** The body of the listener `target.addEventListener("<event>", …)` runs. */
  function handlerFor(target: string, event: string): string {
    const needle = `${target}.addEventListener("${event}",`;
    const at = source.indexOf(needle);
    expect(at, `main.ts does not register ${event} on ${target}`).toBeGreaterThan(-1);
    const call = balanced(source, source.indexOf("(", at));
    const args = call.slice(1, -1);
    const rest = args.slice(args.indexOf(",") + 1).trim();
    const named = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(rest);
    if (named === null) return rest;
    // A named handler: resolve the declaration and take its body.
    const declared = source.indexOf(`const ${named[1] ?? ""} = `);
    expect(declared, `main.ts has no handler named ${named[1]}`).toBeGreaterThan(-1);
    return balanced(source, source.indexOf("{", declared));
  }

  it.each([
    ["window", "blur"],
    ["window", "orientationchange"],
    ["window", "pagehide"],
    ["document", "visibilitychange"],
  ] as const)("%s %s releases every held control", (target, event) => {
    expect(handlerFor(target, event)).toContain("router.releaseAll()");
  });

  it("releases again on the way back in, for a bfcache restore", () => {
    expect(handlerFor("window", "pageshow")).toContain("router.releaseAll()");
  });

  it("drives the deck from the animation frame", () => {
    // If this call went missing the deck would freeze on whatever screen it was
    // last painted for, which is the failure this whole file exists to catch.
    expect(source).toContain("touch?.refresh()");
  });
});

// ---------------------------------------------------------------------------

describe("detach", () => {
  it("removes every listener it added", () => {
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: true });
    const windowBefore = h.window.listenerCount;
    const buttonBefore = h.deck("left").listenerCount;
    expect(windowBefore).toBeGreaterThan(0);
    expect(buttonBefore).toBeGreaterThan(0);

    touch.detach();

    expect(h.window.listenerCount).toBe(0);
    for (const slot of DECK_SLOTS) expect(h.deck(slot).listenerCount, slot).toBe(0);
    expect(h.canvas.listenerCount).toBe(0);
    expect(h.initials.listenerCount).toBe(0);
    expect(h.media().listenerCount).toBe(0);
  });

  it("is deaf afterwards", () => {
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: true });
    touch.refresh();
    touch.detach();

    h.press("left", 1);
    expect(held(h, "leftFlipper")).toBe(false);
    expect(h.log.gestures).toBe(0);
  });

  it("leaves no held control behind", () => {
    // A finger still down when the chrome goes away would otherwise assert its
    // control forever: every listener that could have released it has just been
    // removed, and the router has no idea the button is gone.
    const { h, touch } = fixture({ coarse: true, phase: "play", ballInLane: true });
    touch.refresh();
    h.press("left", 1);
    h.press("right", 2);
    expect(held(h, "leftFlipper")).toBe(true);

    touch.detach();

    expect(held(h, "leftFlipper")).toBe(false);
    expect(held(h, "rightFlipper")).toBe(false);
    const snapshot = h.router.sample();
    expect(snapshot.controls.leftFlipper.released).toBe(true);
    expect(snapshot.controls.rightFlipper.released).toBe(true);
  });

  it("is safe to call twice", () => {
    const { touch } = fixture({ coarse: true });
    touch.detach();
    expect(() => touch.detach()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("the touch presentation", () => {
  it("is off on a fine pointer that has never been touched", () => {
    const { h, touch } = fixture({ coarse: false });
    expect(h.root.dataset["touch"]).toBe("off");
    expect(touch.active()).toBe(false);
  });

  it("is on from the first frame on a coarse pointer", () => {
    const { h, touch } = fixture({ coarse: true });
    expect(h.root.dataset["touch"]).toBe("on");
    expect(touch.active()).toBe(true);
  });

  it("follows the media query when a device changes its mind", () => {
    const { h, touch } = fixture({ coarse: false });
    h.setCoarse(true);
    expect(h.root.dataset["touch"]).toBe("on");
    expect(touch.active()).toBe(true);
    h.setCoarse(false);
    expect(h.root.dataset["touch"]).toBe("off");
  });

  it("latches on the first finger and never lets go", () => {
    // A laptop with a touchscreen: coarse never matches, but a finger was seen.
    const { h, touch } = fixture({ coarse: false, phase: "menu" });
    h.press("left", 1, "touch");
    expect(touch.active()).toBe(true);
    expect(h.root.dataset["touch"]).toBe("on");

    h.setCoarse(false);
    expect(h.root.dataset["touch"]).toBe("on");
  });

  it("does not take a mouse for a finger", () => {
    const { h, touch } = fixture({ coarse: false, phase: "menu" });
    h.press("left", 1, "mouse");
    expect(touch.active()).toBe(false);
    expect(h.root.dataset["touch"]).toBe("off");
  });

  it("takes a pen for a finger, because a stylus has no hover either", () => {
    const { h, touch } = fixture({ coarse: false, phase: "menu" });
    h.press("left", 1, "pen");
    expect(touch.active()).toBe(true);
  });

  it("survives a browser with no matchMedia at all", () => {
    const h = createTouchHarness({ coarse: false });
    open = h;
    h.window.breakMatchMedia = true;
    const touch = h.attach();
    attached = touch;
    expect(touch.active()).toBe(false);
    expect(() => touch.refresh()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("the screen wake lock", () => {
  it("is taken on entering play and given back on leaving it", async () => {
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    touch.refresh();
    expect(h.wakeLock.requests).toBe(0);

    h.shell.phase = "play";
    touch.refresh();
    await Promise.resolve();
    expect(h.wakeLock.requests).toBe(1);
    expect(h.wakeLock.held).toBe(1);

    h.shell.phase = "game-over";
    touch.refresh();
    expect(h.wakeLock.releases).toBe(1);
    expect(h.wakeLock.held).toBe(0);
  });

  it("is asked for once, not once a frame", async () => {
    const { h, touch } = fixture({ coarse: true, phase: "play" });
    for (let frame = 0; frame < 30; frame += 1) {
      touch.refresh();
      await Promise.resolve();
    }
    expect(h.wakeLock.requests).toBe(1);
  });

  it("is not taken while the touch presentation is not showing", async () => {
    const { h, touch } = fixture({ coarse: false, phase: "play" });
    touch.refresh();
    await Promise.resolve();
    expect(h.wakeLock.requests).toBe(0);
  });

  it("shrugs off a browser that refuses it", async () => {
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    touch.refresh();
    h.wakeLock.failNext = true;
    h.shell.phase = "play";
    expect(() => touch.refresh()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.wakeLock.held).toBe(0);
  });

  it("shrugs off a browser with no wake lock API", () => {
    const h = createTouchHarness({ coarse: true, phase: "play", noWakeLock: true });
    open = h;
    const touch = h.attach();
    attached = touch;
    expect(() => touch.refresh()).not.toThrow();
  });

  it("does not keep the screen awake for a ball that ended before it was granted", async () => {
    // The request is asynchronous, and a ball can drain while it is in flight.
    // Nothing later re-checks, so a lock granted after the phase moved on would
    // hold the screen awake through the whole front end.
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    touch.refresh();
    h.wakeLock.autoResolve = false;

    h.shell.phase = "play";
    touch.refresh();
    expect(h.wakeLock.requests).toBe(1);
    expect(h.wakeLock.pending).toBe(1);

    h.shell.phase = "game-over";
    touch.refresh();

    h.wakeLock.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.wakeLock.held).toBe(0);
  });

  it("gives the screen back on detach", async () => {
    const { h, touch } = fixture({ coarse: true, phase: "play" });
    touch.refresh();
    await Promise.resolve();
    expect(h.wakeLock.held).toBe(1);

    touch.detach();
    expect(h.wakeLock.held).toBe(0);
    expect(h.wakeLock.releases).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("the top bar", () => {
  it("sends the shell's back key", () => {
    const { h } = fixture({ coarse: true, phase: "select" });
    h.dispatch(h.bar("back"), "pointerdown", { pointerId: 1 });
    expect(h.log.keys).toEqual([TOUCH_KEYS.back]);
  });

  it("flips the render-layer framing, and the router never hears about it", () => {
    // The view used to be the sim-side `toggleWholeTableView` control tapped
    // through the router. The Fantasies-parity round moved the framing out of
    // the simulation entirely, so the button now goes through the host's
    // presentation hook and the router's snapshot must stay silent.
    const { h } = fixture({ coarse: true, phase: "play" });
    expect(h.framing).toBe("full-table");
    h.dispatch(h.bar("view"), "pointerdown", { pointerId: 6 });
    expect(h.log.framingToggles).toBe(1);
    expect(h.framing).toBe("amiga");
    const snapshot = h.router.sample();
    expect(snapshot.controls.toggleWholeTableView.pressed).toBe(false);
    expect(snapshot.controls.toggleWholeTableView.released).toBe(false);
    expect(snapshot.controls.toggleWholeTableView.down).toBe(false);
  });

  it("labels the view button with the CURRENT framing, Fantasies' convention", () => {
    const { h, touch } = fixture({ coarse: true, phase: "play" });
    touch.refresh();
    expect(h.bar("view").textContent).toBe("FULL TABLE");
    expect(h.bar("view").getAttribute("aria-pressed")).toBe("false");

    h.dispatch(h.bar("view"), "pointerdown", { pointerId: 6 });
    expect(h.bar("view").textContent).toBe("AMIGA VIEW");
    expect(h.bar("view").getAttribute("aria-pressed")).toBe("true");

    // A framing change from elsewhere — F9, the pad — relabels on refresh.
    h.framing = "full-table";
    touch.refresh();
    expect(h.bar("view").textContent).toBe("FULL TABLE");
  });

  it("runs the audio unlock from the bar too", () => {
    const { h } = fixture({ coarse: true, phase: "menu" });
    h.dispatch(h.bar("back"), "pointerdown", { pointerId: 1 });
    h.dispatch(h.bar("view"), "pointerdown", { pointerId: 1 });
    h.dispatch(h.bar("mute"), "pointerdown", { pointerId: 1 });
    expect(h.log.gestures).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe("name entry on a phone", () => {
  it("focuses the hidden input when the initials screen arrives", () => {
    const { h, touch } = fixture({ coarse: true, phase: "menu" });
    touch.refresh();
    expect(h.initials.writes.focus).toBe(0);

    h.shell.phase = "initials";
    touch.refresh();
    expect(h.initials.writes.focus).toBe(1);
    expect(h.document.activeElement).toBe(h.initials);
  });

  it("focuses it once, not once a frame", () => {
    const { h, touch } = fixture({ coarse: true, phase: "initials" });
    for (let frame = 0; frame < 20; frame += 1) touch.refresh();
    expect(h.initials.writes.focus).toBe(1);
  });

  it("never focuses it on a desktop, where it would eat every keystroke", () => {
    const { h, touch } = fixture({ coarse: false, phase: "initials" });
    touch.refresh();
    expect(h.initials.writes.focus).toBe(0);
    expect(h.document.activeElement).toBeNull();
  });

  it("lets the keyboard go when the screen does", () => {
    const { h, touch } = fixture({ coarse: true, phase: "initials" });
    touch.refresh();
    h.shell.phase = "fanfare";
    touch.refresh();
    expect(h.initials.writes.blur).toBe(1);
    expect(h.document.activeElement).toBeNull();
  });

  it("turns typed characters into shell text keys, upper-cased", () => {
    const { h, touch } = fixture({ coarse: true, phase: "initials" });
    touch.refresh();
    h.dispatch(h.initials, "input", { inputType: "insertText", data: "a" });
    expect(h.log.keys).toEqual([{ kind: "text", char: "A", index: -1 }]);
  });

  it("turns a backspace into the shell's erase", () => {
    const { h, touch } = fixture({ coarse: true, phase: "initials" });
    touch.refresh();
    h.dispatch(h.initials, "input", { inputType: "deleteContentBackward", data: null });
    expect(h.log.keys).toEqual([TOUCH_KEYS.erase]);
  });

  it("drops characters the name box does not accept", () => {
    const { h, touch } = fixture({ coarse: true, phase: "initials" });
    touch.refresh();
    h.dispatch(h.initials, "input", { inputType: "insertText", data: "!" });
    expect(h.log.keys).toEqual([]);
  });

  it("keeps no buffer of its own, so the shell owns the three characters", () => {
    const { h, touch } = fixture({ coarse: true, phase: "initials" });
    touch.refresh();
    h.initials.value = "AB";
    h.dispatch(h.initials, "input", { inputType: "insertText", data: "B" });
    expect(h.initials.value).toBe("");
  });

  it("declares the input as its own, so the page's keydown handler skips it", () => {
    const { h, touch } = fixture({ coarse: true, phase: "initials" });
    expect(touch.ownsKeyboard(h.initials)).toBe(true);
    expect(touch.ownsKeyboard(h.deck("left"))).toBe(false);
    expect(touch.ownsKeyboard(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("a tap on the glass", () => {
  /** The client point that lands on shell page coordinates (x, y). */
  function at(h: TouchHarness, x: number, y: number): { clientX: number; clientY: number } {
    const rect = h.canvas.getBoundingClientRect();
    return {
      clientX: rect.left + ((x + SHELL_ORIGIN_X) / WINDOW_WIDTH) * rect.width,
      clientY: rect.top + (y / WINDOW_HEIGHT) * rect.height,
    };
  }

  it("walks the menu cursor to the item under the finger and selects it", () => {
    // Measured against the ELEMENT's rectangle, which is the wiring that could
    // not be checked without one: the shell's own coordinates know nothing about
    // the 390 x 297 box the canvas ended up in.
    const { h } = fixture({ coarse: true, phase: "menu" });
    const exit = MENU_RECTS[1];
    if (exit === undefined) throw new Error("the menu has no second item");
    const point = at(h, (exit.x1 + exit.x2) / 2, (exit.y1 + exit.y2) / 2);

    h.dispatch(h.canvas, "pointerdown", { pointerId: 1, ...point });

    expect(h.log.keys).toEqual([TOUCH_KEYS.down, TOUCH_KEYS.select]);
  });

  it("acts on the very first touch, which is the only one there may be", () => {
    const { h } = fixture({ coarse: false, phase: "attract" });
    h.dispatch(h.canvas, "pointerdown", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 150 });
    expect(h.log.keys).toEqual([TOUCH_KEYS.select]);
  });

  it("is inert under a mouse, where the shell already has a keyboard", () => {
    const { h } = fixture({ coarse: false, phase: "attract" });
    h.dispatch(h.canvas, "pointerdown", { pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 150 });
    expect(h.log.keys).toEqual([]);
    // The gesture still runs: a click is a user gesture and the audio wants it.
    expect(h.log.gestures).toBe(1);
  });

  it("does nothing on the playfield, where the deck owns the controls", () => {
    const { h } = fixture({ coarse: true, phase: "play" });
    h.dispatch(h.canvas, "pointerdown", { pointerId: 1, clientX: 195, clientY: 200 });
    expect(h.log.keys).toEqual([]);
    expect(h.router.holdersOf("leftFlipper")).toEqual([]);
  });

  it("swallows the default only when it is going to act on it", () => {
    const touched = fixture({ coarse: true, phase: "attract" });
    const event = touched.h.dispatch(touched.h.canvas, "pointerdown", { pointerId: 1, clientX: 100, clientY: 150 });
    expect(event.defaultPrevented).toBe(true);
    touched.touch.detach();
    touched.h.dispose();

    const mouse = createTouchHarness({ coarse: false, phase: "attract" });
    open = mouse;
    attached = mouse.attach();
    const plain = mouse.dispatch(mouse.canvas, "pointerdown", {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 100,
      clientY: 150,
    });
    expect(plain.defaultPrevented).toBe(false);
  });
});
