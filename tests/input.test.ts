import { describe, expect, it } from "vitest";

import {
  CONTROLS,
  GAMEPAD_AXIS_PRESS_THRESHOLD,
  GAMEPAD_AXIS_RELEASE_THRESHOLD,
  GAMEPAD_BUTTON_BINDINGS,
  IDLE_SNAPSHOT,
  InputRouter,
  KEY_CODE_BINDINGS,
  KEY_NAME_BINDINGS,
  attachKeyboard,
  controlForKeyEvent,
  edgesFor,
  isControl,
  isDown,
  plungerInputFrom,
  pressCount,
  releaseCount,
  wasPressed,
  wasReleased,
} from "../src/browser/input.js";
import type {
  Control,
  ControlSnapshot,
  GamepadLike,
  KeyEventLike,
  KeyEventSource,
} from "../src/browser/input.js";
import { DEFAULT_PLUNGER_CONFIG, tickLauncher } from "../src/game/plunger.js";

function key(code: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code, ...extra };
}

function pad(
  buttons: readonly number[],
  axes: readonly number[] = [0, 0],
  index = 0,
): GamepadLike {
  return {
    index,
    buttons: buttons.map((value) => ({ pressed: value !== 0 })),
    axes,
  };
}

/** A pad with only the listed standard button numbers held. */
function padWith(...pressedButtons: readonly number[]): GamepadLike {
  const buttons: number[] = new Array<number>(17).fill(0);
  for (const button of pressedButtons) buttons[button] = 1;
  return pad(buttons);
}

describe("the control vocabulary", () => {
  it("is the ten controls the game needs, and no more", () => {
    expect([...CONTROLS]).toEqual([
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
    ]);
    expect(new Set(CONTROLS).size).toBe(CONTROLS.length);
  });

  it("narrows arbitrary strings to controls", () => {
    expect(isControl("leftFlipper")).toBe(true);
    expect(isControl("nudgeBackward")).toBe(false);
    expect(isControl("toString")).toBe(false);
  });

  it("ships an idle snapshot with every control present and quiet", () => {
    for (const control of CONTROLS) {
      expect(edgesFor(IDLE_SNAPSHOT, control)).toEqual({
        down: false,
        pressed: false,
        released: false,
        pressCount: 0,
        releaseCount: 0,
      });
    }
  });
});

describe("keyboard bindings", () => {
  it("binds the original's observed keys", () => {
    // Filmed under emulation with an input-mark log: SHIFTs are the flippers,
    // SPACE is the nudge (it shakes the view and feeds the tilt counter), and
    // RETURN launches — the attract DMD says "RETURN LAUNCHES BALL" outright.
    // Space used to be this port's invented plunger; that binding is gone.
    expect(controlForKeyEvent(key("KeyZ"))).toBe("leftFlipper");
    expect(controlForKeyEvent(key("Comma"))).toBe("leftFlipper");
    expect(controlForKeyEvent(key("ShiftLeft"))).toBe("leftFlipper");
    expect(controlForKeyEvent(key("Slash"))).toBe("rightFlipper");
    expect(controlForKeyEvent(key("Period"))).toBe("rightFlipper");
    expect(controlForKeyEvent(key("ShiftRight"))).toBe("rightFlipper");
    expect(controlForKeyEvent(key("Space"))).toBe("nudgeForward");
    expect(controlForKeyEvent(key("ArrowLeft"))).toBe("nudgeLeft");
    expect(controlForKeyEvent(key("ArrowRight"))).toBe("nudgeRight");
    expect(controlForKeyEvent(key("ArrowUp"))).toBe("nudgeForward");
    expect(controlForKeyEvent(key("Enter"))).toBe("start");
    expect(controlForKeyEvent(key("NumpadEnter"))).toBe("start");
    expect(controlForKeyEvent(key("Escape"))).toBe("pause");
    expect(controlForKeyEvent(key("F9"))).toBe("toggleWholeTableView");
    expect(controlForKeyEvent(key("F10"))).toBe("toggleWholeTableView");
  });

  it("gives the upper flipper a key under each hand", () => {
    expect(controlForKeyEvent(key("KeyX"))).toBe("upperFlipper");
    expect(controlForKeyEvent(key("Semicolon"))).toBe("upperFlipper");
  });

  it("keeps the shift keys on opposite flippers", () => {
    expect(KEY_CODE_BINDINGS["ShiftLeft"]).toBe("leftFlipper");
    expect(KEY_CODE_BINDINGS["ShiftRight"]).toBe("rightFlipper");
  });

  it("falls back to the key name when no code is supplied", () => {
    expect(controlForKeyEvent({ key: "z" })).toBe("leftFlipper");
    expect(controlForKeyEvent({ key: "Z" })).toBe("leftFlipper");
    expect(controlForKeyEvent({ key: "/" })).toBe("rightFlipper");
    expect(controlForKeyEvent({ key: " " })).toBe("nudgeForward");
    expect(controlForKeyEvent({ key: "ArrowLeft" })).toBe("nudgeLeft");
    expect(controlForKeyEvent({ key: "Escape" })).toBe("pause");
  });

  it("does not guess a flipper from an ambiguous shift key name", () => {
    // `key` reports both shifts as "Shift"; picking one would flip the wrong
    // flipper on exactly the devices that omit `code`.
    expect(controlForKeyEvent({ key: "Shift" })).toBeNull();
  });

  it("prefers the physical code over the layout-dependent name", () => {
    // A Dvorak layout reports code KeyZ with key ";" — the physical key wins.
    expect(controlForKeyEvent({ code: "KeyZ", key: ";" })).toBe("leftFlipper");
  });

  it("leaves unbound keys alone", () => {
    expect(controlForKeyEvent(key("KeyQ"))).toBeNull();
    expect(controlForKeyEvent({})).toBeNull();
    expect(controlForKeyEvent({ code: "", key: "" })).toBeNull();
  });

  it("binds every name binding to a real control", () => {
    for (const control of Object.values(KEY_NAME_BINDINGS)) {
      expect(isControl(control)).toBe(true);
    }
    for (const control of Object.values(KEY_CODE_BINDINGS)) {
      expect(isControl(control)).toBe(true);
    }
  });
});

describe("edge detection", () => {
  it("reports a press and the held state that follows it", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));

    const first = router.sample();
    expect(isDown(first, "leftFlipper")).toBe(true);
    expect(wasPressed(first, "leftFlipper")).toBe(true);
    expect(wasReleased(first, "leftFlipper")).toBe(false);

    const second = router.sample();
    expect(isDown(second, "leftFlipper")).toBe(true);
    // The press is consumed: a flipper must fire once, not once per tick.
    expect(wasPressed(second, "leftFlipper")).toBe(false);
  });

  it("reports a release exactly once", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.sample();
    router.handleKeyUp(key("KeyZ"));

    const released = router.sample();
    expect(wasReleased(released, "leftFlipper")).toBe(true);
    expect(isDown(released, "leftFlipper")).toBe(false);

    const after = router.sample();
    expect(wasReleased(after, "leftFlipper")).toBe(false);
  });

  it("registers a tap that begins and ends inside one tick", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.handleKeyUp(key("KeyZ"));

    const snapshot = router.sample();
    // Down at neither sample point, yet both edges survive: this is the whole
    // reason the layer buffers rather than polling.
    expect(isDown(snapshot, "leftFlipper")).toBe(false);
    expect(wasPressed(snapshot, "leftFlipper")).toBe(true);
    expect(wasReleased(snapshot, "leftFlipper")).toBe(true);
    expect(pressCount(snapshot, "leftFlipper")).toBe(1);
  });

  it("counts every press when several land in one tick", () => {
    const router = new InputRouter();
    for (let taps = 0; taps < 3; taps += 1) {
      router.handleKeyDown(key("KeyZ"));
      router.handleKeyUp(key("KeyZ"));
    }

    const snapshot = router.sample();
    expect(pressCount(snapshot, "leftFlipper")).toBe(3);
    expect(releaseCount(snapshot, "leftFlipper")).toBe(3);
    expect(wasPressed(snapshot, "leftFlipper")).toBe(true);
    expect(wasReleased(snapshot, "leftFlipper")).toBe(true);
    expect(isDown(snapshot, "leftFlipper")).toBe(false);
  });

  it("ends a tick still down when the last event was a press", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.handleKeyUp(key("KeyZ"));
    router.handleKeyDown(key("KeyZ"));

    const snapshot = router.sample();
    expect(pressCount(snapshot, "leftFlipper")).toBe(2);
    expect(releaseCount(snapshot, "leftFlipper")).toBe(1);
    expect(isDown(snapshot, "leftFlipper")).toBe(true);
  });

  it("ignores OS auto-repeat, which is not a new press", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.sample();
    for (let repeat = 0; repeat < 20; repeat += 1) {
      expect(router.handleKeyDown(key("KeyZ", { repeat: true }))).toBe("leftFlipper");
    }

    const snapshot = router.sample();
    expect(pressCount(snapshot, "leftFlipper")).toBe(0);
    expect(isDown(snapshot, "leftFlipper")).toBe(true);
  });

  it("treats a repeated key-down from the same key as one press", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.handleKeyDown(key("KeyZ"));
    router.handleKeyDown(key("KeyZ"));
    expect(pressCount(router.sample(), "leftFlipper")).toBe(1);
  });

  it("numbers its snapshots so a replay log can be checked for gaps", () => {
    const router = new InputRouter();
    expect(router.sequence).toBe(0);
    expect(router.sample().sequence).toBe(1);
    expect(router.sample().sequence).toBe(2);
    expect(router.sequence).toBe(2);
  });

  it("hands out frozen snapshots, so a logged tick cannot be edited later", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    const snapshot = router.sample();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.controls)).toBe(true);
    router.sample();
    // The old snapshot still describes the tick it was taken on.
    expect(isDown(snapshot, "leftFlipper")).toBe(true);
    expect(wasPressed(snapshot, "leftFlipper")).toBe(true);
  });
});

describe("controls with several sources", () => {
  it("keeps the flipper down while any bound key is still held", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.handleKeyDown(key("ShiftLeft"));

    const both = router.sample();
    expect(isDown(both, "leftFlipper")).toBe(true);
    expect(pressCount(both, "leftFlipper")).toBe(1);

    router.handleKeyUp(key("ShiftLeft"));
    const one = router.sample();
    // Releasing the alternate must not drop a flipper the player is holding.
    expect(isDown(one, "leftFlipper")).toBe(true);
    expect(wasReleased(one, "leftFlipper")).toBe(false);

    router.handleKeyUp(key("KeyZ"));
    expect(wasReleased(router.sample(), "leftFlipper")).toBe(true);
  });

  it("ignores a release from a source that was never holding the control", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.sample();
    router.handleKeyUp(key("Comma"));
    const snapshot = router.sample();
    expect(isDown(snapshot, "leftFlipper")).toBe(true);
    expect(wasReleased(snapshot, "leftFlipper")).toBe(false);
  });

  it("lists its holders for diagnostics", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.press("leftFlipper", "touch:left");
    expect(router.holdersOf("leftFlipper")).toEqual(["key:KeyZ", "touch:left"]);
    expect(router.isHeld("leftFlipper")).toBe(true);
    expect(router.isHeld("rightFlipper")).toBe(false);
  });
});

describe("the flippers are independent", () => {
  it("presses both flippers at once without either affecting the other", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.handleKeyDown(key("Slash"));
    router.handleKeyDown(key("KeyX"));

    const snapshot = router.sample();
    expect(wasPressed(snapshot, "leftFlipper")).toBe(true);
    expect(wasPressed(snapshot, "rightFlipper")).toBe(true);
    expect(wasPressed(snapshot, "upperFlipper")).toBe(true);
    expect(isDown(snapshot, "leftFlipper")).toBe(true);
    expect(isDown(snapshot, "rightFlipper")).toBe(true);
    expect(isDown(snapshot, "upperFlipper")).toBe(true);
  });

  it("releases one flipper without disturbing the other", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.handleKeyDown(key("Slash"));
    router.sample();

    router.handleKeyUp(key("KeyZ"));
    const snapshot = router.sample();
    expect(wasReleased(snapshot, "leftFlipper")).toBe(true);
    expect(isDown(snapshot, "leftFlipper")).toBe(false);
    expect(isDown(snapshot, "rightFlipper")).toBe(true);
    expect(wasReleased(snapshot, "rightFlipper")).toBe(false);
  });

  it("does not leak a press into any other control", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("Slash"));
    const snapshot = router.sample();
    for (const control of CONTROLS) {
      const expected = control === "rightFlipper";
      expect(isDown(snapshot, control)).toBe(expected);
      expect(wasPressed(snapshot, control)).toBe(expected);
    }
  });
});

describe("touch and pointers", () => {
  it("routes two fingers to two flippers independently", () => {
    const router = new InputRouter();
    router.pointerDown(1, "leftFlipper");
    router.pointerDown(2, "rightFlipper");

    const both = router.sample();
    expect(isDown(both, "leftFlipper")).toBe(true);
    expect(isDown(both, "rightFlipper")).toBe(true);

    expect(router.pointerUp(1)).toBe("leftFlipper");
    const one = router.sample();
    expect(wasReleased(one, "leftFlipper")).toBe(true);
    expect(isDown(one, "rightFlipper")).toBe(true);
  });

  it("holds a button down while two fingers share it", () => {
    const router = new InputRouter();
    router.pointerDown(1, "plunger");
    router.pointerDown(2, "plunger");
    expect(pressCount(router.sample(), "plunger")).toBe(1);

    router.pointerUp(1);
    expect(isDown(router.sample(), "plunger")).toBe(true);
    router.pointerUp(2);
    expect(wasReleased(router.sample(), "plunger")).toBe(true);
  });

  it("releases the old control when a pointer is re-bound mid-drag", () => {
    const router = new InputRouter();
    router.pointerDown(1, "leftFlipper");
    router.sample();
    router.pointerDown(1, "rightFlipper");

    const snapshot = router.sample();
    expect(wasReleased(snapshot, "leftFlipper")).toBe(true);
    expect(isDown(snapshot, "leftFlipper")).toBe(false);
    expect(isDown(snapshot, "rightFlipper")).toBe(true);
  });

  it("ignores a pointer-up for a pointer that was never down", () => {
    const router = new InputRouter();
    expect(router.pointerUp(99)).toBeNull();
    const snapshot = router.sample();
    for (const control of CONTROLS) {
      expect(edgesFor(snapshot, control).releaseCount).toBe(0);
    }
  });

  it("taps a control in one call for an on-screen button", () => {
    const router = new InputRouter();
    router.tap("start");
    const snapshot = router.sample();
    expect(wasPressed(snapshot, "start")).toBe(true);
    expect(wasReleased(snapshot, "start")).toBe(true);
    expect(isDown(snapshot, "start")).toBe(false);
  });

  /**
   * The cradle, at the level the simulation actually sees it.
   *
   * A held bat is not a repeated press: `flipperStroke` reads `isDown` every
   * tick and the stroke holds the bat up for as long as that is true, so what a
   * finger on the glass has to produce is one press edge and then `down` on
   * every tick until it lifts. Three seconds at 50 Hz is 150 ticks; ten is
   * enough to prove the shape and cheap enough to keep.
   */
  it("holds a flipper for as long as the finger is down, with one press edge", () => {
    const router = new InputRouter();
    router.pointerDown(7, "leftFlipper");

    let presses = 0;
    for (let tick = 0; tick < 150; tick += 1) {
      const snapshot = router.sample();
      expect(isDown(snapshot, "leftFlipper")).toBe(true);
      expect(wasReleased(snapshot, "leftFlipper")).toBe(false);
      if (wasPressed(snapshot, "leftFlipper")) presses += 1;
    }
    expect(presses).toBe(1);

    expect(router.pointerUp(7)).toBe("leftFlipper");
    const lifted = router.sample();
    expect(isDown(lifted, "leftFlipper")).toBe(false);
    expect(wasReleased(lifted, "leftFlipper")).toBe(true);
  });

  it("keeps three fingers on three controls independent", () => {
    const router = new InputRouter();
    router.pointerDown(1, "leftFlipper");
    router.pointerDown(2, "rightFlipper");
    router.pointerDown(3, "nudgeForward");

    const all = router.sample();
    expect(isDown(all, "leftFlipper")).toBe(true);
    expect(isDown(all, "rightFlipper")).toBe(true);
    expect(isDown(all, "nudgeForward")).toBe(true);
    expect(router.holdersOf("leftFlipper")).toEqual(["pointer:1"]);
    expect(router.holdersOf("rightFlipper")).toEqual(["pointer:2"]);
    expect(router.holdersOf("nudgeForward")).toEqual(["pointer:3"]);

    router.pointerUp(3);
    const bats = router.sample();
    expect(isDown(bats, "leftFlipper")).toBe(true);
    expect(isDown(bats, "rightFlipper")).toBe(true);
    expect(isDown(bats, "nudgeForward")).toBe(false);
  });

  /**
   * The stuck-flipper backstop, which is the whole reason `touch.ts` listens on
   * `window` in the capture phase and on `pagehide`. Whatever route the release
   * arrives by, it must leave the router with nothing held and no pointer
   * remembered — and a later pointer-up for the same id must then be inert
   * rather than a second, phantom release.
   */
  it("releases everything mid-hold and forgets the pointers", () => {
    const router = new InputRouter();
    router.pointerDown(1, "leftFlipper");
    router.pointerDown(2, "rightFlipper");
    router.sample();

    router.releaseAll();
    const cleared = router.sample();
    for (const control of ["leftFlipper", "rightFlipper"] as const) {
      expect(isDown(cleared, control)).toBe(false);
      expect(releaseCount(cleared, control)).toBe(1);
    }

    expect(router.pointerUp(1)).toBeNull();
    expect(router.pointerUp(2)).toBeNull();
    const after = router.sample();
    for (const control of CONTROLS) {
      expect(edgesFor(after, control).releaseCount).toBe(0);
    }
  });

  it("launches exactly once however long the launch button is held", () => {
    const router = new InputRouter();
    router.pointerDown(4, "plunger");

    let fired = 0;
    for (let tick = 0; tick < 40; tick += 1) {
      const snapshot = router.sample();
      if (tickLauncher(plungerInputFrom(snapshot), DEFAULT_PLUNGER_CONFIG).fired) fired += 1;
    }
    router.pointerUp(4);
    if (tickLauncher(plungerInputFrom(router.sample()), DEFAULT_PLUNGER_CONFIG).fired) fired += 1;

    expect(fired).toBe(1);
  });
});

describe("gamepads", () => {
  it("binds the shoulders to the flippers and a face button to the plunger", () => {
    expect(GAMEPAD_BUTTON_BINDINGS[4]).toBe("leftFlipper");
    expect(GAMEPAD_BUTTON_BINDINGS[5]).toBe("rightFlipper");
    expect(GAMEPAD_BUTTON_BINDINGS[0]).toBe("plunger");

    const router = new InputRouter();
    router.pollGamepad(padWith(4, 5, 0));
    const snapshot = router.sample();
    expect(isDown(snapshot, "leftFlipper")).toBe(true);
    expect(isDown(snapshot, "rightFlipper")).toBe(true);
    expect(isDown(snapshot, "plunger")).toBe(true);
  });

  it("emits one press however many times it is polled", () => {
    const router = new InputRouter();
    for (let poll = 0; poll < 5; poll += 1) router.pollGamepad(padWith(4));
    expect(pressCount(router.sample(), "leftFlipper")).toBe(1);
  });

  it("releases a button the pad stops reporting", () => {
    const router = new InputRouter();
    router.pollGamepad(padWith(4));
    router.sample();
    router.pollGamepad(padWith());
    expect(wasReleased(router.sample(), "leftFlipper")).toBe(true);
  });

  it("nudges from the stick past the threshold", () => {
    const router = new InputRouter();
    router.pollGamepad(pad([], [-0.9, 0]));
    expect(isDown(router.sample(), "nudgeLeft")).toBe(true);

    router.pollGamepad(pad([], [0.9, 0]));
    const right = router.sample();
    expect(isDown(right, "nudgeRight")).toBe(true);
    expect(isDown(right, "nudgeLeft")).toBe(false);

    router.pollGamepad(pad([], [0, -0.9]));
    expect(isDown(router.sample(), "nudgeForward")).toBe(true);
  });

  it("does not nudge from a stick inside the dead zone", () => {
    const router = new InputRouter();
    router.pollGamepad(pad([], [-0.4, -0.4]));
    const snapshot = router.sample();
    expect(isDown(snapshot, "nudgeLeft")).toBe(false);
    expect(isDown(snapshot, "nudgeForward")).toBe(false);
  });

  it("does not chatter when the stick rests between the two thresholds", () => {
    expect(GAMEPAD_AXIS_RELEASE_THRESHOLD).toBeLessThan(GAMEPAD_AXIS_PRESS_THRESHOLD);
    const between = -(GAMEPAD_AXIS_PRESS_THRESHOLD + GAMEPAD_AXIS_RELEASE_THRESHOLD) / 2;

    const router = new InputRouter();
    // Never crossing the press threshold: the control never comes on.
    for (let poll = 0; poll < 10; poll += 1) router.pollGamepad(pad([], [between, 0]));
    let snapshot = router.sample();
    expect(pressCount(snapshot, "nudgeLeft")).toBe(0);

    // Once past the press threshold it stays on while the stick eases back into
    // the band, instead of emitting a press and release on every poll.
    router.pollGamepad(pad([], [-0.9, 0]));
    router.sample();
    for (let poll = 0; poll < 10; poll += 1) router.pollGamepad(pad([], [between, 0]));
    snapshot = router.sample();
    expect(isDown(snapshot, "nudgeLeft")).toBe(true);
    expect(releaseCount(snapshot, "nudgeLeft")).toBe(0);
    expect(pressCount(snapshot, "nudgeLeft")).toBe(0);
  });

  it("keeps two pads independent, and releases one cleanly on unplug", () => {
    const router = new InputRouter();
    router.pollGamepad(padWith(4), 0);
    router.pollGamepad(padWith(4), 1);
    router.sample();

    router.dropGamepad(1);
    const snapshot = router.sample();
    expect(isDown(snapshot, "leftFlipper")).toBe(true);
    expect(wasReleased(snapshot, "leftFlipper")).toBe(false);

    router.dropGamepad(0);
    expect(wasReleased(router.sample(), "leftFlipper")).toBe(true);
  });

  it("survives a pad with missing axes or a short button array", () => {
    const router = new InputRouter();
    expect(() => router.pollGamepad({ buttons: [], axes: [] })).not.toThrow();
    expect(() => router.pollGamepad({ buttons: [{ pressed: true }], axes: [Number.NaN] })).not.toThrow();
    const snapshot = router.sample();
    expect(isDown(snapshot, "plunger")).toBe(true);
    expect(isDown(snapshot, "nudgeLeft")).toBe(false);
  });

  it("does not fight the keyboard for the same control", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.sample();
    // A poll of an idle pad releases only the pad's own claim.
    router.pollGamepad(padWith());
    const snapshot = router.sample();
    expect(isDown(snapshot, "leftFlipper")).toBe(true);
    expect(wasReleased(snapshot, "leftFlipper")).toBe(false);
  });
});

describe("losing and regaining focus", () => {
  it("releases everything on blur, and says so", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.handleKeyDown(key("Space"));
    router.pointerDown(1, "rightFlipper");
    router.sample();

    router.releaseAll();
    const snapshot = router.sample();
    expect(isDown(snapshot, "leftFlipper")).toBe(false);
    // Every held control must SEE the release, or it stays asserted while the
    // player is looking at another window.
    expect(wasReleased(snapshot, "nudgeForward")).toBe(true);
    expect(wasReleased(snapshot, "rightFlipper")).toBe(true);
  });

  it("emits nothing on blur when nothing was held", () => {
    const router = new InputRouter();
    router.releaseAll();
    const snapshot = router.sample();
    for (const control of CONTROLS) {
      expect(edgesFor(snapshot, control).releaseCount).toBe(0);
    }
  });

  it("forgets a pointer after blur, so a stale up is a no-op", () => {
    const router = new InputRouter();
    router.pointerDown(1, "leftFlipper");
    router.releaseAll();
    router.sample();
    expect(router.pointerUp(1)).toBeNull();
    expect(releaseCount(router.sample(), "leftFlipper")).toBe(0);
  });

  it("resets to a known state with no phantom edges, for a replay", () => {
    const router = new InputRouter();
    router.handleKeyDown(key("KeyZ"));
    router.sample();

    router.reset();
    const snapshot = router.sample();
    expect(snapshot.sequence).toBe(1);
    for (const control of CONTROLS) {
      expect(edgesFor(snapshot, control)).toEqual({
        down: false,
        pressed: false,
        released: false,
        pressCount: 0,
        releaseCount: 0,
      });
    }
  });
});

describe("attaching to a DOM-like target", () => {
  /**
   * A stand-in for `window`, held to the real `EventTarget` signature so the
   * test cannot pass against a shape the browser would reject.
   */
  interface Recorder extends KeyEventSource {
    fire(type: string, event: KeyEventLike): void;
    readonly counts: Map<string, number>;
  }

  type Listener = EventListenerOrEventListenerObject | null;

  function recorder(): Recorder {
    const listeners = new Map<string, Listener[]>();
    const counts = new Map<string, number>();
    return {
      counts,
      addEventListener(type: string, listener: Listener) {
        const list = listeners.get(type) ?? [];
        list.push(listener);
        listeners.set(type, list);
        counts.set(type, (counts.get(type) ?? 0) + 1);
      },
      removeEventListener(type: string, listener: Listener) {
        const list = listeners.get(type) ?? [];
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
        counts.set(type, (counts.get(type) ?? 0) - 1);
      },
      fire(type: string, event: KeyEventLike) {
        const dispatched = event as unknown as Event;
        for (const listener of [...(listeners.get(type) ?? [])]) {
          if (typeof listener === "function") listener(dispatched);
          else listener?.handleEvent(dispatched);
        }
      },
    };
  }

  it("routes key events and swallows the default for bound keys only", () => {
    const router = new InputRouter();
    const target = recorder();
    const detach = attachKeyboard(router, target);

    let prevented = 0;
    const bound: KeyEventLike = { code: "Space", preventDefault: () => (prevented += 1) };
    const unbound: KeyEventLike = { code: "KeyQ", preventDefault: () => (prevented += 1) };

    target.fire("keydown", bound);
    target.fire("keydown", unbound);
    expect(prevented).toBe(1);
    expect(isDown(router.sample(), "nudgeForward")).toBe(true);

    target.fire("keyup", bound);
    expect(prevented).toBe(2);
    expect(wasReleased(router.sample(), "nudgeForward")).toBe(true);

    detach();
    expect(target.counts.get("keydown")).toBe(0);
    target.fire("keydown", bound);
    expect(pressCount(router.sample(), "nudgeForward")).toBe(0);
  });

  it("drops held controls when the target reports blur", () => {
    const router = new InputRouter();
    const target = recorder();
    attachKeyboard(router, target);

    target.fire("keydown", { code: "KeyZ" });
    router.sample();
    target.fire("blur", {});
    expect(wasReleased(router.sample(), "leftFlipper")).toBe(true);
  });

  it("tolerates an event with no preventDefault at all", () => {
    const router = new InputRouter();
    const target = recorder();
    attachKeyboard(router, target);
    expect(() => target.fire("keydown", { code: "KeyZ" })).not.toThrow();
    expect(isDown(router.sample(), "leftFlipper")).toBe(true);
  });
});

describe("feeding the launcher", () => {
  // The launch key on the keyboard is Enter, which the router files under
  // `start`; the game loop treats a start press in play as the launch edge.
  // The `plunger` control itself remains for the gamepad face button and the
  // touch overlay, so the adapter is exercised through a manual press here.

  it("translates a snapshot into the launcher's input", () => {
    const router = new InputRouter();
    router.press("plunger");
    expect(plungerInputFrom(router.sample())).toEqual({
      pressed: true,
      released: false,
      held: true,
    });

    router.release("plunger");
    expect(plungerInputFrom(router.sample())).toEqual({
      pressed: false,
      released: true,
      held: false,
    });

    expect(plungerInputFrom(router.sample())).toEqual({
      pressed: false,
      released: false,
      held: false,
    });
  });

  it("fires exactly once from a hold that spans several ticks", () => {
    // The original's RETURN byte is edge-consumed: a hold is one launch,
    // however long it lasts, and the film's 2500 ms hold fired exactly one.
    const router = new InputRouter();
    let fired = 0;
    const step = (): void => {
      if (tickLauncher(plungerInputFrom(router.sample()), DEFAULT_PLUNGER_CONFIG).fired) {
        fired += 1;
      }
    };

    router.press("plunger");
    step();
    expect(fired).toBe(1);
    for (let tick = 0; tick < 20; tick += 1) step();
    expect(fired).toBe(1);

    router.release("plunger");
    for (let tick = 0; tick < 20; tick += 1) step();
    expect(fired).toBe(1);
  });

  it("fires from a tap that never spans a tick", () => {
    const router = new InputRouter();
    router.press("plunger");
    router.release("plunger");

    const outcome = tickLauncher(plungerInputFrom(router.sample()));
    expect(outcome.fired).toBe(true);
    expect(outcome.launchVelocityY).toBeLessThan(0);
  });
});

describe("determinism", () => {
  it("gives identical snapshots for identical event sequences", () => {
    const script: readonly (readonly [string, string])[] = [
      ["down", "KeyZ"],
      ["down", "Slash"],
      ["up", "KeyZ"],
      ["down", "Space"],
      ["down", "KeyZ"],
      ["up", "Slash"],
      ["up", "Space"],
      ["up", "KeyZ"],
    ];

    const run = (): ControlSnapshot[] => {
      const router = new InputRouter();
      const snapshots: ControlSnapshot[] = [];
      for (const [kind, code] of script) {
        if (kind === "down") router.handleKeyDown(key(code));
        else router.handleKeyUp(key(code));
        snapshots.push(router.sample());
      }
      return snapshots;
    };

    expect(run()).toEqual(run());
  });

  it("does not depend on the order controls happen to be pressed in", () => {
    const order: readonly Control[] = ["rightFlipper", "leftFlipper", "plunger"];
    const forward = new InputRouter();
    const backward = new InputRouter();
    for (const control of order) forward.press(control);
    for (const control of [...order].reverse()) backward.press(control);
    expect(forward.sample().controls).toEqual(backward.sample().controls);
  });
});

