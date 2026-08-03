/**
 * Where a finger landed, in the shell's own coordinates — and what the deck's
 * five buttons mean on the screen that is showing.
 *
 * Both sibling remakes get menu navigation by touch for free, because both draw
 * their menus as HTML `<button>`s. Illusions does not: its shell is a 320 x 256
 * page painted INTO the playfield canvas at `SHELL_ORIGIN_X = 8`
 * (`shell-screens.ts`), so there is nothing on the page to tap. That is the one
 * piece of net-new work the mobile round could not inherit, and this module is
 * all of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE HAS NO DOM IN IT
 * ---------------------------------------------------------------------------
 * The project's test environment is node — there is no jsdom anywhere — so
 * anything that touches an element cannot be tested. The geometry is therefore
 * separated from the wiring: this file is arithmetic over numbers a caller has
 * already measured, `touch.ts` is the twenty lines that measure them. The same
 * split is why `playfieldBlitGeometry` is not inside `drawPlayfield`.
 *
 * ---------------------------------------------------------------------------
 * WHY A HIT TEST RETURNS A LIST OF KEYS
 * ---------------------------------------------------------------------------
 * `ShellKey` is already a device-free abstraction and `shellKey(state, store,
 * key)` is the only way into the shell's state machine. Touch must not extend
 * that vocabulary — a new "tap the second menu item" key would be a second way
 * to do everything, and the shell tests would stop proving anything about the
 * touch path. But the shell has no absolute cursor move: selecting the item a
 * finger landed on means walking the cursor there first. So a tap resolves to a
 * SEQUENCE of ordinary keys — `down`, `select` — and the host feeds them one at
 * a time down exactly the path a keyboard takes. The shell state machine does
 * not change at all.
 */

import {
  MENU_RECTS,
  SELECT_INFO_BOX,
  SELECT_LIST_CLIP,
  SELECT_NAME_BOX,
  SELECT_ROW_PITCH,
  SELECT_ROW_Y,
  SHELL_HEIGHT,
  SHELL_ORIGIN_X,
  SHELL_WIDTH,
} from "./shell-screens.js";
import { MENU_ITEMS, SHELL_TABLES } from "./shell.js";
import type { ShellKey, ShellPhase, ShellState } from "./shell.js";
import type { Control } from "./input.js";

/** The canvas window, which the shell page is centred in. 320 + 8 + 8. */
export const WINDOW_WIDTH = SHELL_WIDTH + 2 * SHELL_ORIGIN_X;
export const WINDOW_HEIGHT = SHELL_HEIGHT;

/** A rectangle on the page, in the element's own client coordinates. */
export interface ClientRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A point in the shell's 320 x 256 page coordinates. `x` may be negative. */
export interface ShellPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Maps a page point onto the shell page.
 *
 * Against the ELEMENT's rectangle rather than the backing store, so the answer
 * is right in NATIVE mode, in HD mode, and at whatever render scale the cap
 * settled on — none of which the shell page's coordinates know or care about.
 *
 * `x` runs -8..327 rather than 0..319: the eight columns of surround each side
 * are part of the window and a finger can land on them. Callers get the honest
 * number and the hit tests below simply match nothing there.
 */
export function canvasPointToShell(clientX: number, clientY: number, rect: ClientRect): ShellPoint {
  const width = rect.width > 0 ? rect.width : 1;
  const height = rect.height > 0 ? rect.height : 1;
  return {
    x: ((clientX - rect.left) / width) * WINDOW_WIDTH - SHELL_ORIGIN_X,
    y: ((clientY - rect.top) / height) * WINDOW_HEIGHT,
  };
}

interface Rect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

function inside(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x1 && x <= rect.x2 && y >= rect.y1 && y <= rect.y2;
}

const SELECT: ShellKey = Object.freeze({ kind: "select", char: null, index: -1 });
const BACK: ShellKey = Object.freeze({ kind: "back", char: null, index: -1 });
const UP: ShellKey = Object.freeze({ kind: "up", char: null, index: -1 });
const DOWN: ShellKey = Object.freeze({ kind: "down", char: null, index: -1 });
const LEFT: ShellKey = Object.freeze({ kind: "left", char: null, index: -1 });
const RIGHT: ShellKey = Object.freeze({ kind: "right", char: null, index: -1 });
const ERASE: ShellKey = Object.freeze({ kind: "erase", char: null, index: -1 });
/**
 * The one key `quit-confirm` accepts. The shell tests `key.char === "Y"` and
 * treats everything else as "play on", which is the original's own 0x42A2
 * behaviour and is not relaxed here — the touch layer synthesises the letter
 * instead.
 */
const YES: ShellKey = Object.freeze({ kind: "text", char: "Y", index: -1 });

/**
 * The synthesised keys, named once.
 *
 * Exported so the DOM layer builds none of its own: every key the touch path
 * can produce is in this object, which makes "what can a finger do to the
 * shell?" a question with a written answer.
 */
export const TOUCH_KEYS = Object.freeze({
  select: SELECT,
  back: BACK,
  up: UP,
  down: DOWN,
  left: LEFT,
  right: RIGHT,
  erase: ERASE,
  yes: YES,
});

const NOTHING: readonly ShellKey[] = Object.freeze([]);
const JUST_SELECT: readonly ShellKey[] = Object.freeze([SELECT]);

/** `count` presses of one key. */
function walk(key: ShellKey, count: number): readonly ShellKey[] {
  if (count <= 0) return NOTHING;
  return Object.freeze(new Array<ShellKey>(count).fill(key));
}

/**
 * Walks a wrapping cursor from `from` to `to` the short way round.
 *
 * On a tie — two items, where either direction is one press — it takes the
 * direction the eye expects, which is the one that does not wrap.
 */
function stepsTo(from: number, to: number, count: number): readonly ShellKey[] {
  if (count <= 1 || from === to) return NOTHING;
  const forward = (to - from + count) % count;
  const backward = (from - to + count) % count;
  if (forward === backward) return walk(to > from ? DOWN : UP, forward);
  return forward < backward ? walk(DOWN, forward) : walk(UP, backward);
}

/** The parts of the shell a hit test reads. A subset, so tests need no store. */
export type ShellHitState = Pick<ShellState, "phase" | "menuCursor" | "cursor" | "column">;

type PhaseHit = (state: ShellHitState, x: number, y: number) => readonly ShellKey[];

/**
 * What a tap does on each screen.
 *
 * Written as a total record over `ShellPhase` rather than a switch, so adding a
 * phase is a type error here rather than a screen that silently cannot be
 * tapped. The pattern the brief asks for, and the reason the union is imported.
 */
const PHASE_HITS: Record<ShellPhase, PhaseHit> = {
  // The credits roll. SPACE is the only way forward and any tap is that.
  attract: () => JUST_SELECT,

  // Two boxes, at the display list's own coordinates. A tap on the item the
  // cursor is not on walks the cursor there first.
  menu: (state, x, y) => {
    for (let i = 0; i < MENU_RECTS.length && i < MENU_ITEMS.length; i += 1) {
      const rect = MENU_RECTS[i];
      if (rect === undefined || !inside(rect, x, y)) continue;
      return Object.freeze([...stepsTo(state.menuCursor, i, MENU_ITEMS.length), SELECT]);
    }
    return NOTHING;
  },

  // The name box plays the table under the cursor; the Info box opens its
  // screen; and the scrolling strip either side of the pinned row moves the
  // cursor by whole rows, so a tap on a visible name goes to that name.
  select: (state, x, y) => {
    if (inside(SELECT_NAME_BOX, x, y)) {
      return state.column === 0 ? JUST_SELECT : Object.freeze([LEFT, SELECT]);
    }
    if (inside(SELECT_INFO_BOX, x, y)) {
      return state.column === 1 ? JUST_SELECT : Object.freeze([RIGHT, SELECT]);
    }
    if (!inside(SELECT_LIST_CLIP, x, y)) return NOTHING;
    const offset = Math.round((y - SELECT_ROW_Y) / SELECT_ROW_PITCH);
    if (offset === 0) return NOTHING;
    const target = state.cursor + offset;
    // Only names actually on screen are targets, and the walk goes the way the
    // finger pointed rather than the short way round: the list moves under the
    // thumb, so wrapping the other way would scroll it visibly backwards.
    if (target < 0 || target >= SHELL_TABLES.length) return NOTHING;
    return walk(offset > 0 ? DOWN : UP, Math.abs(offset));
  },

  // "Press ESC to exit", says the disk's own last line; the shell takes a
  // select for it too, and a tap is the friendliest select there is.
  info: () => JUST_SELECT,

  // Nothing to do but wait for the fetch.
  loading: () => NOTHING,

  // Any key leaves the failure card.
  failed: () => JUST_SELECT,

  // The playfield belongs to the game. Flippers are on the deck, and a tap on
  // the glass must never be an input the original does not have.
  play: () => NOTHING,

  // A tap is the SAFE answer, always. 'Y' quits and lives only on the deck,
  // where the button says QUIT in as many words; a stray tap on the card
  // resumes rather than throwing the ball away.
  "quit-confirm": () => JUST_SELECT,

  "game-over": () => JUST_SELECT,
  fanfare: () => JUST_SELECT,

  // Deliberately inert. A select here COMMITS the initials, and committing
  // blank ones because a thumb brushed the glass is a high score thrown away.
  // The soft keyboard and the deck's OK button are the ways out.
  initials: () => NOTHING,

  // The table's own attract screen: a tap starts a game, which is what the
  // original's keypad ENTER does here.
  ladder: () => JUST_SELECT,
};

/**
 * The keys a tap at shell coordinates `(x, y)` should produce, in order.
 *
 * Empty means the tap does nothing, which is a legitimate and common answer —
 * most of the field on most screens is not a target.
 */
export function shellHitTest(state: ShellHitState, x: number, y: number): readonly ShellKey[] {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return NOTHING;
  if (x < -SHELL_ORIGIN_X || x > SHELL_WIDTH + SHELL_ORIGIN_X) return NOTHING;
  if (y < 0 || y > SHELL_HEIGHT) return NOTHING;
  return PHASE_HITS[state.phase](state, x, y);
}

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

/**
 * The five buttons under the picture.
 *
 * Five and not four, because Illusions has an upper flipper that neither
 * sibling does, and because the fifth slot has to double as the shell's select
 * — the deck is what makes every screen reachable without any hit testing at
 * all, which is what de-risks the whole of the section above.
 */
export const DECK_SLOTS = ["left", "up", "down", "right", "action"] as const;
export type DeckSlot = (typeof DECK_SLOTS)[number];

export interface DeckBinding {
  /** What the button says. It changes with the screen; that is the point. */
  readonly label: string;
  /**
   * The control the button HOLDS while a finger is on it, or null.
   *
   * Held controls go through `InputRouter.pointerDown` / `pointerUp` and reach
   * the simulation as an ordinary `ControlSnapshot`, indistinguishable from a
   * key. That is what makes hold-to-cradle work with no special case.
   */
  readonly control: Control | null;
  /** The shell key the button TAPS on its down edge, or null. */
  readonly key: ShellKey | null;
  /** Buttons with nothing to do are hidden rather than shown dead. */
  readonly hidden: boolean;
}

export type DeckPlan = Readonly<Record<DeckSlot, DeckBinding>>;

const BLANK: DeckBinding = Object.freeze({ label: "", control: null, key: null, hidden: true });

function held(label: string, control: Control): DeckBinding {
  return Object.freeze({ label, control, key: null, hidden: false });
}

function taps(label: string, key: ShellKey): DeckBinding {
  return Object.freeze({ label, control: null, key, hidden: false });
}

/** In play the deck is the cabinet: two bats, the upper bat, a shove, a launch. */
const PLAY_DECK: DeckPlan = Object.freeze({
  left: held("LEFT", "leftFlipper"),
  up: held("UP", "upperFlipper"),
  down: held("NUDGE", "nudgeForward"),
  right: held("RIGHT", "rightFlipper"),
  action: held("LAUNCH", "plunger"),
});

const PLAY_DECK_NO_BALL: DeckPlan = Object.freeze({ ...PLAY_DECK, action: BLANK });

/**
 * Everywhere else the deck is a d-pad.
 *
 * Arrows rather than words because the labels have to survive a 60 px button on
 * a 390 px phone, and because they say the same thing as the hint line the
 * shell already prints ("UP/DOWN CHOOSE   SPACE SELECTS   ESC BACK").
 */
function menuDeck(action: string): DeckPlan {
  return Object.freeze({
    left: taps("◀", LEFT),
    up: taps("▲", UP),
    down: taps("▼", DOWN),
    right: taps("▶", RIGHT),
    action: taps(action, SELECT),
  });
}

const MENU_DECK = menuDeck("OK");
const LADDER_DECK = menuDeck("START");
const LOADING_DECK: DeckPlan = Object.freeze({
  left: BLANK,
  up: BLANK,
  down: BLANK,
  right: BLANK,
  action: BLANK,
});

/**
 * The quit card, which is the one screen whose two answers are not a cursor.
 *
 * The shell accepts the literal 'Y' and nothing else, so the deck offers the
 * two outcomes by name and the canvas offers only the safe one.
 */
const QUIT_DECK: DeckPlan = Object.freeze({
  left: taps("PLAY ON", SELECT),
  up: BLANK,
  down: BLANK,
  right: taps("QUIT", YES),
  action: BLANK,
});

/**
 * Name entry. The characters come from a real soft keyboard (`touch.ts` focuses
 * a hidden input), so the deck carries only the two keys that keyboard cannot
 * send reliably: a delete and an accept.
 */
const INITIALS_DECK: DeckPlan = Object.freeze({
  left: taps("DEL", ERASE),
  up: BLANK,
  down: BLANK,
  right: taps("OK", SELECT),
  action: BLANK,
});

/**
 * What the five buttons are on the screen that is showing.
 *
 * `ballInLane` hides LAUNCH when there is nothing to launch, which is Dreams'
 * rule for the same button (`hidden` unless `snapshot.ballInChute`) and stops a
 * player wearing the button out while the table is mid-multiball.
 */
export function deckPlanFor(phase: ShellPhase, ballInLane: boolean): DeckPlan {
  switch (phase) {
    case "play":
      return ballInLane ? PLAY_DECK : PLAY_DECK_NO_BALL;
    case "quit-confirm":
      return QUIT_DECK;
    case "initials":
      return INITIALS_DECK;
    case "ladder":
      return LADDER_DECK;
    case "loading":
      return LOADING_DECK;
    case "attract":
    case "menu":
    case "select":
    case "info":
    case "failed":
    case "game-over":
    case "fanfare":
      return MENU_DECK;
  }
}
