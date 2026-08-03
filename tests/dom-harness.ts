/**
 * The smallest browser `src/browser/touch.ts` can actually run inside.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `touch-zones.ts` says of itself that "anything that touches an element cannot
 * be tested", and it is right about its own scope: the geometry was split out so
 * the arithmetic could be proved without a DOM. But the split left the OTHER
 * half — the twenty-odd lines that read the elements, rewrite the deck's labels
 * when the phase changes, and bind those buttons to the flippers — with nothing
 * asserting it at all. That half is glue, and glue is where this project's
 * failures have actually lived: a decoded, gated, shipped asset that was simply
 * never passed to the two functions that would draw it.
 *
 * A browser cannot watch it here. Every browser on this machine reports
 * `visibilityState: "hidden"` with `requestAnimationFrame` suspended, and
 * `refresh()` is called from the animation frame, so the one thing worth seeing
 * is the one thing that never runs. So the browser is built instead.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS AND IS NOT
 * ---------------------------------------------------------------------------
 * Not a DOM implementation, and deliberately not jsdom — which is not a
 * dependency of this project and would be 3 MB of node_modules to exercise nine
 * methods. It is exactly the surface `touch.ts` touches:
 *
 *   elements     addEventListener / removeEventListener, querySelector,
 *                textContent, hidden, setAttribute, classList, dataset,
 *                getBoundingClientRect, the three pointer-capture methods
 *   document     documentElement, defaultView, activeElement, getElementById
 *   window       matchMedia, navigator.wakeLock, the two listener methods
 *   events       a PointerEvent shim with an id and a type, and real capture /
 *                target / bubble propagation up the parent chain
 *
 * Three things are modelled properly rather than approximated, because the
 * behaviours under test depend on them:
 *
 *  1. PROPAGATION. `touch.ts` puts its release backstop on `window` in the
 *     CAPTURE phase precisely so it is seen first and seen wherever the finger
 *     ended. A harness that only fired listeners on the target element would
 *     make that backstop look like it works when it does not.
 *  2. POINTER CAPTURE, including the retarget: a captured pointer's later events
 *     go to the capturing element whatever is under the finger, and the capture
 *     is dropped — with a `lostpointercapture` — when the pointer ends. The
 *     "pointerleave releases only if NOT captured" rule is unprovable without
 *     this, and getting that rule backwards is the classic mobile pinball bug.
 *  3. WRITE COUNTING. `textContent`, `hidden` and `setAttribute` are accessors
 *     that count. "The relabel does not thrash the DOM" is otherwise not a
 *     statement anything can check.
 *
 * The fixture is built FROM `index.html`, not from a copy of it. If the shipped
 * markup renames a slot or drops the label span, these tests fail rather than
 * passing against a paraphrase — which is the same failure the Loading logo
 * demonstrated the hard way.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { InputRouter } from "../src/browser/input.js";
import type { ShellKey, ShellPhase } from "../src/browser/shell.js";
import { DECK_SLOTS } from "../src/browser/touch-zones.js";
import type { DeckSlot, ShellHitState } from "../src/browser/touch-zones.js";
import { attachTouch } from "../src/browser/touch.js";
import type { TouchHandle } from "../src/browser/touch.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface FakeEventInit {
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly inputType?: string;
  readonly data?: string | null;
  /** Overrides the per-type default in `BUBBLES`. */
  readonly bubbles?: boolean;
}

/**
 * One event, carrying the union of what a `PointerEvent` and an `InputEvent`
 * expose to `touch.ts`. One class rather than two because the module reads the
 * fields off a cast rather than through `instanceof`, so the distinction would
 * be ceremony.
 */
export class FakeEvent {
  readonly type: string;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly inputType: string;
  readonly data: string | null;
  readonly bubbles: boolean;
  target: unknown = null;
  currentTarget: unknown = null;
  defaultPrevented = false;
  stopped = false;

  constructor(type: string, init: FakeEventInit = {}) {
    this.type = type;
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "touch";
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.inputType = init.inputType ?? "insertText";
    this.data = init.data ?? null;
    this.bubbles = init.bubbles ?? BUBBLES.has(type);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.stopped = true;
  }
}

/**
 * Which events bubble, per the UI Events and Pointer Events specs.
 *
 * `pointerleave` is the one that matters: it does NOT bubble, which is why
 * `touch.ts` has to bind it per button rather than once on the deck.
 */
const BUBBLES: ReadonlySet<string> = new Set([
  "pointerdown",
  "pointerup",
  "pointercancel",
  "pointermove",
  "gotpointercapture",
  "lostpointercapture",
  "contextmenu",
  "input",
  "change",
  "click",
]);

/** Events a captured pointer re-targets to its capturing element. */
const RETARGETED: ReadonlySet<string> = new Set(["pointerup", "pointercancel", "pointermove"]);

type FakeListener = (event: FakeEvent) => void;

interface Registration {
  readonly type: string;
  readonly listener: FakeListener;
  readonly capture: boolean;
}

function captureOf(options: unknown): boolean {
  if (typeof options === "boolean") return options;
  if (typeof options === "object" && options !== null) {
    return (options as { capture?: unknown }).capture === true;
  }
  return false;
}

export class FakeEventTarget {
  readonly registrations: Registration[] = [];

  addEventListener(type: string, listener: unknown, options?: unknown): void {
    this.registrations.push({
      type,
      listener: listener as FakeListener,
      capture: captureOf(options),
    });
  }

  removeEventListener(type: string, listener: unknown, options?: unknown): void {
    const capture = captureOf(options);
    // Matched on the triple the DOM matches on. A harness that ignored the
    // capture flag would let a detach that passed the wrong options look clean.
    const index = this.registrations.findIndex(
      (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
    );
    if (index >= 0) this.registrations.splice(index, 1);
  }

  /**
   * Present so a fake satisfies `EventTarget` structurally — `ownsKeyboard`
   * takes one — and deliberately loud rather than partial: a dispatch that
   * fired only at its target would make the window-level release backstops look
   * like they work when they do not.
   */
  dispatchEvent(_event: Event): boolean {
    throw new Error("use the harness's dispatch(), which walks the real capture/bubble path");
  }

  /** How many listeners are still attached. `detach()` has to bring this to 0. */
  get listenerCount(): number {
    return this.registrations.length;
  }

  listenersFor(type: string): number {
    return this.registrations.filter((entry) => entry.type === type).length;
  }

  fireHere(event: FakeEvent, phase: "capture" | "target" | "bubble"): void {
    if (event.stopped) return;
    // Copied, so a listener that detaches mid-dispatch does not shorten the list
    // being walked — which is what a real event dispatch does too.
    for (const entry of [...this.registrations]) {
      if (entry.type !== event.type) continue;
      if (phase === "capture" && !entry.capture) continue;
      if (phase === "bubble" && entry.capture) continue;
      event.currentTarget = this;
      entry.listener(event);
      if (event.stopped) return;
    }
  }
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

class FakeClassList {
  readonly #names = new Set<string>();

  constructor(initial = "") {
    for (const name of initial.split(/\s+/)) if (name !== "") this.#names.add(name);
  }

  add(...names: string[]): void {
    for (const name of names) this.#names.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.#names.delete(name);
  }

  contains(name: string): boolean {
    return this.#names.has(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.#names.has(name);
    if (on) this.#names.add(name);
    else this.#names.delete(name);
    return on;
  }

  get value(): string {
    return [...this.#names].join(" ");
  }
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Every write the deck could make, counted. */
export interface WriteCounts {
  text: number;
  hidden: number;
  attribute: number;
  focus: number;
  blur: number;
}

function noWrites(): WriteCounts {
  return { text: 0, hidden: 0, attribute: 0, focus: 0, blur: 0 };
}

export class FakeElement extends FakeEventTarget {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly writes: WriteCounts = noWrites();
  classList: FakeClassList;
  parentElement: FakeElement | null = null;
  ownerDocument: FakeDocument | null = null;
  rect: RectLike = { left: 0, top: 0, width: 0, height: 0 };
  /**
   * Makes `setPointerCapture` throw, which is what older mobile browsers do for
   * a pointer that has already ended. `touch.ts` catches it and leans on the
   * global release instead; that fallback is only reachable through this flag.
   */
  refusePointerCapture = false;
  #text = "";
  #hidden = false;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList();
  }

  append(child: FakeElement): FakeElement {
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  get textContent(): string {
    if (this.children.length === 0) return this.#text;
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.#text = value;
    // A real assignment drops every child. Counted whether or not the value
    // changed: an unchanged write is still a write, and detecting exactly that
    // is what "does not thrash the DOM" means.
    this.children.length = 0;
    this.writes.text += 1;
  }

  get hidden(): boolean {
    return this.#hidden;
  }

  set hidden(value: boolean) {
    this.#hidden = value;
    this.writes.hidden += 1;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.classList = new FakeClassList(value);
    this.writes.attribute += 1;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getBoundingClientRect(): RectLike & { right: number; bottom: number; x: number; y: number } {
    return {
      left: this.rect.left,
      top: this.rect.top,
      width: this.rect.width,
      height: this.rect.height,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
      x: this.rect.left,
      y: this.rect.top,
    };
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.descendants()) {
      if (matches(child, selector)) return child;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return [...this.descendants()].filter((child) => matches(child, selector));
  }

  *descendants(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  // -- pointer capture ------------------------------------------------------
  // The registry lives on the document because the DOM's does: one element at
  // most holds any given pointer, page-wide.

  setPointerCapture(pointerId: number): void {
    if (this.refusePointerCapture) {
      throw new Error(`InvalidPointerId: no active pointer ${pointerId}`);
    }
    this.ownerDocument?.captures.set(pointerId, this);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.ownerDocument?.captures.get(pointerId) === this;
  }

  releasePointerCapture(pointerId: number): void {
    if (this.hasPointerCapture(pointerId)) this.ownerDocument?.captures.delete(pointerId);
  }
}

export class FakeButtonElement extends FakeElement {
  constructor() {
    super("button");
  }
}

export class FakeInputElement extends FakeElement {
  value = "";

  constructor() {
    super("input");
  }

  focus(_options?: { preventScroll?: boolean }): void {
    this.writes.focus += 1;
    if (this.ownerDocument !== null) this.ownerDocument.activeElement = this;
  }

  blur(): void {
    this.writes.blur += 1;
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null;
  }
}

export class FakeCanvasElement extends FakeElement {
  width = 336;
  height = 256;

  constructor() {
    super("canvas");
  }
}

/**
 * The three selector forms `touch.ts` uses, and nothing else.
 *
 * Anything unrecognised THROWS rather than returning null. A harness that
 * quietly matched nothing would report "the deck has no buttons" as a clean
 * pass on the day someone renames an attribute — which is the exact shape of
 * silence these tests exist to remove.
 */
function matches(element: FakeElement, selector: string): boolean {
  const attribute = /^\[([-\w]+)="([^"]*)"\]$/.exec(selector);
  if (attribute !== null) return element.getAttribute(attribute[1] ?? "") === attribute[2];
  const className = /^\.([-\w]+)$/.exec(selector);
  if (className !== null) return element.classList.contains(className[1] ?? "");
  const id = /^#([-\w]+)$/.exec(selector);
  if (id !== null) return element.getAttribute("id") === id[1];
  throw new Error(`the DOM harness does not implement the selector ${selector}`);
}

// ---------------------------------------------------------------------------
// Document and window
// ---------------------------------------------------------------------------

export class FakeDocument extends FakeEventTarget {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  readonly captures = new Map<number, FakeElement>();
  defaultView: FakeWindow | null = null;
  activeElement: FakeElement | null = null;
  hidden = false;
  visibilityState: "visible" | "hidden" = "visible";

  constructor() {
    super();
    this.documentElement = new FakeElement("html");
    this.documentElement.ownerDocument = this;
    this.body = this.documentElement.append(new FakeElement("body"));
  }

  createElement(tagName: string): FakeElement {
    const element =
      tagName === "button"
        ? new FakeButtonElement()
        : tagName === "input"
          ? new FakeInputElement()
          : tagName === "canvas"
            ? new FakeCanvasElement()
            : new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  querySelector(selector: string): FakeElement | null {
    if (matches(this.documentElement, selector)) return this.documentElement;
    return this.documentElement.querySelector(selector);
  }

  getElementById(id: string): FakeElement | null {
    return this.querySelector(`#${id}`);
  }
}

export class FakeMediaQueryList extends FakeEventTarget {
  readonly media: string;
  matches = false;

  constructor(media: string) {
    super();
    this.media = media;
  }

  /** Flips the query and fires `change`, as a rotation or a docking would. */
  set(value: boolean): void {
    if (value === this.matches) return;
    this.matches = value;
    const event = new FakeEvent("change");
    event.target = this;
    this.fireHere(event, "target");
  }
}

export interface FakeWakeLockSentinel {
  release(): Promise<void>;
}

/**
 * `navigator.wakeLock`, with the resolution under the test's control.
 *
 * Deferred resolution is not gold-plating: the request is asynchronous and the
 * phase can leave `play` before it settles, which is a state the live code can
 * reach on any phone and which no synchronous double can produce.
 */
export class FakeWakeLock {
  requests = 0;
  releases = 0;
  held = 0;
  failNext = false;
  autoResolve = true;
  #pending: (() => void)[] = [];

  request(type: "screen"): Promise<FakeWakeLockSentinel> {
    if (type !== "screen") throw new Error(`unexpected wake lock type ${type}`);
    this.requests += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("NotAllowedError"));
    }
    const sentinel: FakeWakeLockSentinel = {
      release: () => {
        this.releases += 1;
        this.held -= 1;
        return Promise.resolve();
      },
    };
    if (this.autoResolve) {
      this.held += 1;
      return Promise.resolve(sentinel);
    }
    return new Promise<FakeWakeLockSentinel>((resolve) => {
      this.#pending.push(() => {
        this.held += 1;
        resolve(sentinel);
      });
    });
  }

  get pending(): number {
    return this.#pending.length;
  }

  /** Settles every deferred request. */
  flush(): void {
    const waiting = this.#pending;
    this.#pending = [];
    for (const resolve of waiting) resolve();
  }
}

export class FakeWindow extends FakeEventTarget {
  readonly document: FakeDocument;
  readonly navigator: { wakeLock?: FakeWakeLock } = {};
  /** Makes `matchMedia` throw, as a browser without the API would. */
  breakMatchMedia = false;
  readonly #queries = new Map<string, FakeMediaQueryList>();

  constructor(document: FakeDocument) {
    super();
    this.document = document;
  }

  matchMedia(query: string): FakeMediaQueryList {
    if (this.breakMatchMedia) throw new Error("matchMedia is not a function");
    // Cached per query, because `touch.ts` calls `matchMedia` twice for the same
    // string and listens on the second result — a fresh object each time would
    // silently disconnect the listener from the query the test flips.
    const existing = this.#queries.get(query);
    if (existing !== undefined) return existing;
    const created = new FakeMediaQueryList(query);
    this.#queries.set(query, created);
    return created;
  }
}

// ---------------------------------------------------------------------------
// The shipped markup
// ---------------------------------------------------------------------------

const INDEX_HTML = fileURLToPath(new URL("../index.html", import.meta.url));

export interface DeckMarkup {
  /** Slot name to the label the HTML ships, in document order. */
  readonly slots: readonly (readonly [string, string])[];
  readonly barActions: readonly (readonly [string, string])[];
  readonly hasInitialsInput: boolean;
  readonly hasCanvas: boolean;
}

/**
 * Reads the deck out of the real `index.html`.
 *
 * Regexes rather than a parser because the shape being read is four attributes
 * in a file this repo owns, and because a parser would hide the thing worth
 * knowing: if these patterns stop matching, the markup and `touch.ts` have
 * drifted apart and every test below should fail loudly.
 */
let cachedHtml: string | null = null;

function shippedHtml(): string {
  cachedHtml ??= readFileSync(INDEX_HTML, "utf8");
  return cachedHtml;
}

export function readDeckMarkup(html = shippedHtml()): DeckMarkup {
  const slots: [string, string][] = [];
  const deckButton = /<button\b[^>]*data-deck-slot="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g;
  for (const match of html.matchAll(deckButton)) {
    const slot = match[1] ?? "";
    const label = /<span class="deck__label">([^<]*)<\/span>/.exec(match[2] ?? "");
    slots.push([slot, (label?.[1] ?? "").trim()]);
  }
  const barActions: [string, string][] = [];
  const barButton = /<button\b[^>]*data-bar-action="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g;
  for (const match of html.matchAll(barButton)) {
    barActions.push([match[1] ?? "", (match[2] ?? "").trim()]);
  }
  return {
    slots,
    barActions,
    hasInitialsInput: /<input\b[^>]*\bid="initials-entry"/.test(html),
    hasCanvas: /<canvas\b[^>]*\bid="playfield"/.test(html),
  };
}

// ---------------------------------------------------------------------------
// The globals `touch.ts` narrows against
// ---------------------------------------------------------------------------

interface DomGlobals {
  HTMLElement?: unknown;
  HTMLButtonElement?: unknown;
  HTMLInputElement?: unknown;
  HTMLCanvasElement?: unknown;
}

/**
 * Installs the constructors `instanceof` needs, and hands back an undo.
 *
 * `touch.ts` narrows every element it finds with `instanceof`, which in node is
 * a bare `ReferenceError`. Removed again on teardown so nothing leaks into a
 * test file that shares this worker's globals.
 */
function installGlobals(): () => void {
  const globals = globalThis as DomGlobals;
  const before: DomGlobals = {
    HTMLElement: globals.HTMLElement,
    HTMLButtonElement: globals.HTMLButtonElement,
    HTMLInputElement: globals.HTMLInputElement,
    HTMLCanvasElement: globals.HTMLCanvasElement,
  };
  globals.HTMLElement = FakeElement;
  globals.HTMLButtonElement = FakeButtonElement;
  globals.HTMLInputElement = FakeInputElement;
  globals.HTMLCanvasElement = FakeCanvasElement;
  return () => {
    for (const name of ["HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLCanvasElement"] as const) {
      const original = before[name];
      if (original === undefined) delete globals[name];
      else globals[name] = original;
    }
  };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/** Everything a `TouchHost` call is recorded into. */
export interface HostLog {
  readonly keys: ShellKey[];
  gestures: number;
  muteToggles: number;
}

export interface TouchHarness {
  readonly window: FakeWindow;
  readonly document: FakeDocument;
  readonly root: FakeElement;
  readonly canvas: FakeCanvasElement;
  readonly initials: FakeInputElement;
  readonly router: InputRouter;
  readonly wakeLock: FakeWakeLock;
  readonly log: HostLog;
  /** The shell state the host reports. Mutate it, then `refresh()`. */
  readonly shell: { phase: ShellPhase; menuCursor: number; cursor: number; column: 0 | 1 };
  ballInLane: boolean;
  muted: boolean;

  deck(slot: DeckSlot): FakeButtonElement;
  bar(action: "back" | "view" | "mute"): FakeButtonElement;
  label(slot: DeckSlot): string;
  aria(slot: DeckSlot): string | null;
  isHidden(slot: DeckSlot): boolean;
  /** The deck as a plain object, for a whole-screen assertion in one `expect`. */
  deckShape(): Record<string, { label: string; hidden: boolean }>;

  /** Total writes across every deck button and caption. */
  deckWrites(): WriteCounts;
  resetWrites(): void;

  attach(): TouchHandle;
  /** Full capture / target / bubble dispatch, honouring pointer capture. */
  dispatch(target: FakeEventTarget, type: string, init?: FakeEventInit): FakeEvent;
  press(slot: DeckSlot, pointerId?: number, pointerType?: string): FakeEvent;
  lift(slot: DeckSlot, pointerId?: number): FakeEvent;
  setCoarse(value: boolean): void;
  media(): FakeMediaQueryList;
  dispose(): void;
}

export interface HarnessOptions {
  /** Starts with `(hover: none) and (pointer: coarse)` matching. */
  readonly coarse?: boolean;
  readonly phase?: ShellPhase;
  readonly ballInLane?: boolean;
  readonly muted?: boolean;
  /** Leaves `navigator.wakeLock` undefined, as a desktop Safari would. */
  readonly noWakeLock?: boolean;
}

const COARSE_QUERY = "(hover: none) and (pointer: coarse)";

export function createTouchHarness(options: HarnessOptions = {}): TouchHarness {
  const undoGlobals = installGlobals();
  const document = new FakeDocument();
  const window = new FakeWindow(document);
  document.defaultView = window;
  const wakeLock = new FakeWakeLock();
  if (options.noWakeLock !== true) window.navigator.wakeLock = wakeLock;

  const markup = readDeckMarkup();

  // -- the fixture, built from the shipped markup ---------------------------

  const cabinet = document.body.append(document.createElement("main"));
  cabinet.setAttribute("class", "cabinet");

  const topbar = cabinet.append(document.createElement("div"));
  topbar.setAttribute("class", "topbar");
  const bars = new Map<string, FakeButtonElement>();
  for (const [action, text] of markup.barActions) {
    const button = topbar.append(document.createElement("button")) as FakeButtonElement;
    button.setAttribute("data-bar-action", action);
    button.setAttribute("class", "topbar__button");
    button.textContent = text;
    bars.set(action, button);
  }

  const stage = cabinet.append(document.createElement("div"));
  stage.setAttribute("id", "stage");
  const canvas = stage.append(document.createElement("canvas")) as FakeCanvasElement;
  canvas.setAttribute("id", "playfield");
  // A plausible phone: the 336 x 256 window blown up to 390 wide.
  canvas.rect = { left: 0, top: 60, width: 390, height: 297 };

  const deck = cabinet.append(document.createElement("div"));
  deck.setAttribute("class", "deck");
  const buttons = new Map<string, FakeButtonElement>();
  for (const [slot, text] of markup.slots) {
    const button = deck.append(document.createElement("button")) as FakeButtonElement;
    button.setAttribute("data-deck-slot", slot);
    button.setAttribute("class", `deck__button deck__button--${slot}`);
    const caption = button.append(document.createElement("span"));
    caption.setAttribute("class", "deck__label");
    caption.textContent = text;
    buttons.set(slot, button);
  }

  const initials = cabinet.append(document.createElement("input")) as FakeInputElement;
  initials.setAttribute("id", "initials-entry");
  initials.setAttribute("class", "offscreen");

  // The fixture is built before any counter matters; start every test from zero.
  const allWritable: FakeElement[] = [];
  for (const button of buttons.values()) {
    allWritable.push(button);
    for (const child of button.descendants()) allWritable.push(child);
  }
  for (const button of bars.values()) allWritable.push(button);

  if (options.coarse === true) window.matchMedia(COARSE_QUERY).matches = true;

  // -- the host -------------------------------------------------------------

  const router = new InputRouter();
  const log: HostLog = { keys: [], gestures: 0, muteToggles: 0 };
  const shell = {
    phase: options.phase ?? "attract",
    menuCursor: 0,
    cursor: 0,
    column: 0 as 0 | 1,
  };

  const state = {
    ballInLane: options.ballInLane ?? false,
    muted: options.muted ?? false,
  };

  const requireSlot = (slot: DeckSlot): FakeButtonElement => {
    const button = buttons.get(slot);
    if (button === undefined) throw new Error(`index.html has no deck slot "${slot}"`);
    return button;
  };

  const captionOf = (slot: DeckSlot): FakeElement => {
    const caption = requireSlot(slot).querySelector(".deck__label");
    if (caption === null) throw new Error(`deck slot "${slot}" has no .deck__label`);
    return caption;
  };

  const dispatch = (target: FakeEventTarget, type: string, init: FakeEventInit = {}): FakeEvent => {
    const event = new FakeEvent(type, init);
    let node: FakeEventTarget = target;
    // A captured pointer's later events go to the capturing element wherever the
    // finger actually is. This is the whole reason a slide-out cradle works.
    if (RETARGETED.has(type)) {
      const holder = document.captures.get(event.pointerId);
      if (holder !== undefined) node = holder;
    }
    event.target = node;

    const path: FakeEventTarget[] = [];
    if (node instanceof FakeElement) {
      let element: FakeElement | null = node;
      while (element !== null) {
        path.push(element);
        element = element.parentElement;
      }
      path.push(document, window);
    } else if (node === document) {
      path.push(document, window);
    } else {
      path.push(window);
    }

    for (let i = path.length - 1; i > 0; i -= 1) path[i]?.fireHere(event, "capture");
    path[0]?.fireHere(event, "target");
    if (event.bubbles) {
      for (let i = 1; i < path.length; i += 1) path[i]?.fireHere(event, "bubble");
    }

    // A pointer that ended drops its capture, and the browser announces it.
    if (type === "pointerup" || type === "pointercancel") {
      const holder = document.captures.get(event.pointerId);
      if (holder !== undefined) {
        document.captures.delete(event.pointerId);
        dispatch(holder, "lostpointercapture", { pointerId: event.pointerId });
      }
    }
    return event;
  };

  return {
    window,
    document,
    root: document.documentElement,
    canvas,
    initials,
    router,
    wakeLock,
    log,
    shell,
    get ballInLane(): boolean {
      return state.ballInLane;
    },
    set ballInLane(value: boolean) {
      state.ballInLane = value;
    },
    get muted(): boolean {
      return state.muted;
    },
    set muted(value: boolean) {
      state.muted = value;
    },

    deck: requireSlot,
    bar: (action) => {
      const button = bars.get(action);
      if (button === undefined) throw new Error(`index.html has no bar action "${action}"`);
      return button;
    },
    label: (slot) => captionOf(slot).textContent,
    aria: (slot) => requireSlot(slot).getAttribute("aria-label"),
    isHidden: (slot) => requireSlot(slot).hidden,
    deckShape: () => {
      const shape: Record<string, { label: string; hidden: boolean }> = {};
      for (const slot of DECK_SLOTS) {
        shape[slot] = { label: captionOf(slot).textContent, hidden: requireSlot(slot).hidden };
      }
      return shape;
    },

    deckWrites: () => {
      const total = noWrites();
      for (const element of allWritable) {
        total.text += element.writes.text;
        total.hidden += element.writes.hidden;
        total.attribute += element.writes.attribute;
      }
      total.focus = initials.writes.focus;
      total.blur = initials.writes.blur;
      return total;
    },
    resetWrites: () => {
      for (const element of [...allWritable, initials]) {
        element.writes.text = 0;
        element.writes.hidden = 0;
        element.writes.attribute = 0;
        element.writes.focus = 0;
        element.writes.blur = 0;
      }
    },

    attach: () =>
      attachTouch({
        router,
        canvas: canvas as unknown as HTMLCanvasElement,
        shellState: (): ShellHitState => shell,
        ballInLane: () => state.ballInLane,
        shellKey: (key) => {
          log.keys.push(key);
        },
        gesture: () => {
          log.gestures += 1;
        },
        toggleMute: () => {
          state.muted = !state.muted;
          log.muteToggles += 1;
          return state.muted;
        },
        muted: () => state.muted,
      }),

    dispatch,
    press: (slot, pointerId = 1, pointerType = "touch") =>
      dispatch(requireSlot(slot), "pointerdown", { pointerId, pointerType }),
    lift: (slot, pointerId = 1) => dispatch(requireSlot(slot), "pointerup", { pointerId }),
    setCoarse: (value) => window.matchMedia(COARSE_QUERY).set(value),
    media: () => window.matchMedia(COARSE_QUERY),
    dispose: undoGlobals,
  };
}
