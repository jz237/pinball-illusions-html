/**
 * THE SHELL: everything around the ball.
 *
 * The original is two programs. `Pinball` (the 25 KB loader, `$VER:
 * Pinball_Illusions 1.6 (24.1.95)`) opens the libraries, validates the table
 * database and every `tableNNN.mnu`, plays `intro.bin` and then jumps into
 * `main.bin`; `main.bin` (`Pinball_Illusions 1.7`) is the shell proper. This
 * module is `main.bin`'s two state machines, and only those: the menu machine at
 * hunk-0 0x100E and the parts of the in-game machine at 0x3D3E that are not
 * gameplay — the table attract, the game-over roll and the high-score entry.
 *
 * It is deliberately free of the DOM, the canvas, the clock and the network.
 * The host (`src/main.ts`) supplies those and acts on the effects this module
 * returns; `src/browser/shell-screens.ts` draws it. That split is the whole
 * reason the flow is testable at all — `tests/shell.test.ts` drives every
 * transition below with plain objects and no browser.
 *
 * WHAT IS THE ORIGINAL'S AND WHAT IS RECONSTRUCTED
 * ---------------------------------------------------------------------------
 * From the disk, and reproduced exactly:
 *   - the six menu states and their transitions (`$EE(a5)`, jump table 0x1048):
 *     attract -> main menu -> table select -> play, with the info screen hanging
 *     off table select and ESC walking back up.
 *   - the main menu's two items and only two: "Tables" and "Exit" (display list
 *     0xCF3C). There is no options entry anywhere in the release.
 *   - table select's two boxes: the name on the left, "Info" on the right, moved
 *     between with LEFT and RIGHT (`$13C(a5)`).
 *   - the function keys picking a table straight out of the attract screen and
 *     going directly into the game, skipping the menu (0x1128, rawkeys
 *     0x50..0x59 -> `$138(a5)` = the table id, `$EE` = 3).
 *   - ESC on the playfield asking "REALLY QUIT TABLE?" and only 'Y' answering it
 *     (0x42A2; rawkey 0x15).
 *   - game over -> high-score check -> three initials typed on the keyboard ->
 *     back to the table's own attract screen (in-game states 4, 2 and 0).
 *   - three initials, BACKSPACE deleting, RETURN accepting early and the third
 *     character auto-accepting (`cmpi.w #3,$488A`).
 *   - the qualifying rule: beat the fifth entry of THAT TABLE's own ladder.
 *     There is no separate threshold constant in the binary.
 *
 * Reconstructed, because the disk did not settle it:
 *   - MULTIPLE PLAYERS. The original scans F1..F8 for one to eight players
 *     (0x42A2) and alternates them per ball. This reconstruction is one player:
 *     the simulation in `game-loop.ts` holds a single score, ball count and
 *     mission machine, and giving it eight would mean saving and restoring all
 *     of that across every ball end. That is a change to the game, not to the
 *     shell, and it is not one this brief asked for. ENTER starts a one-player
 *     game, which is exactly what the original's keypad ENTER does.
 *   - "Exit" returns to the attract screen. The original exits to Workbench;
 *     a browser tab has nowhere to go, and a page that blanks itself is worse
 *     than one that goes back to the title.
 *   - the timings of the game-over and ladder rolls are the original's 100
 *     frames and 3 seconds, at this reconstruction's 50 Hz tick against the
 *     Amiga's 50 Hz field. That is now the same number for the same reason:
 *     `ShellClock` gives the shell the simulation's own fixed-step accumulator,
 *     where this file's clocks used to be advanced once per animation frame and
 *     so ran at whatever the display refreshed at.
 *
 * The ATTRACT PAGES are the disk's own — see `ATTRACT_PAGES` below, which also
 * records what from that array deliberately does not ship. This header used to
 * say they were "written fresh"; that was true of an earlier round and stopped
 * being true when the page display lists were decoded out of `menudata.bin`
 * hunk 4 and confirmed against 221 filmed page instances.
 */

import { TABLE_IDS } from "../game/contracts.js";
import type { TableId } from "../game/contracts.js";
import {
  HIGH_SCORE_SLOTS,
  INITIALS_LENGTH,
  insertScore,
  loadHighScores,
  placeFor,
  saveHighScores,
} from "../game/high-scores.js";
import type { HighScoreEntry } from "../game/high-scores.js";

// ---------------------------------------------------------------------------
// The table database
// ---------------------------------------------------------------------------

/**
 * One row of `tables.bin`.
 *
 * The file is three 34-byte records — `u16 id, u16, u16 name_field_len (0x1C),
 * u16, char name[23], u8 trailer[3]` — and the names below are the ones stored
 * in it, character for character. They are functional identifiers: the shell
 * patches the record's index into `PROGDIR:table00N.bin`, `.mnu`, `.opt` and
 * into the nonvolatile item name `Table00N`, so the name and the slot are how
 * the machine refers to the table at all.
 *
 * `blurb` is NOT from the disk. The `.mnu` packages carry a descriptive
 * paragraph next to the artwork and that paragraph is the publisher's marketing
 * copy; it is not reproduced here. These lines are written fresh and say what
 * the table's own artwork shows, which is what a player choosing between three
 * thumbnails actually wants to know.
 *
 * Each line is at most `INFO_LINE_CHARACTERS` long, because the info screen's
 * text column is the width the original leaves to the left of the 128 x 128
 * artwork panel at x = 176. A longer line runs under the picture.
 */
export interface ShellTable {
  readonly id: TableId;
  /** 1-based, matching Table001 / Table002 / Table003 on the disk. */
  readonly slot: number;
  /** Exactly as stored in `tables.bin`. */
  readonly name: string;
  /** Freshly written. See above — the disk's paragraph does not ship. */
  readonly blurb: readonly string[];
}

/**
 * Characters that fit in the info screen's text column.
 *
 * The original types its text from x = 16 and puts the artwork panel at
 * x = 176..303, so the column is 160 pixels wide. Its small font's digit
 * advance is 7 px — that is readable straight off the ladder template at
 * hunk-0 0x1836, which computes its right-aligned score column as
 * `300 - (3*commas + 7*digits)` — which is about twenty-two characters. This
 * reconstruction draws with the browser's own monospace at a slightly smaller
 * advance and fits twenty-eight. Anything longer runs under the picture.
 */
export const INFO_LINE_CHARACTERS = 28;

export const SHELL_TABLES: readonly ShellTable[] = Object.freeze([
  Object.freeze({
    id: "law-n-justice" as TableId,
    slot: 1,
    name: "Law 'n Justice",
    blurb: Object.freeze([
      "A night city under neon,",
      "and the law losing an",
      "argument with it.",
    ]),
  }),
  Object.freeze({
    id: "babewatch" as TableId,
    slot: 2,
    name: "BabeWatch",
    blurb: Object.freeze([
      "Palms, surf, and a red '57",
      "Cadillac parked where the",
      "sand runs out.",
    ]),
  }),
  Object.freeze({
    id: "extreme-sports" as TableId,
    slot: 3,
    name: "Extreme Sports",
    blurb: Object.freeze([
      "A snowboarder and a",
      "mountain biker, both a long",
      "way off the ground.",
    ]),
  }),
]);

/** Guards the table list against `contracts.ts` drifting away from it. */
export function shellTableFor(tableId: TableId): ShellTable {
  const table = SHELL_TABLES.find((entry) => entry.id === tableId);
  if (table === undefined) throw new RangeError(`no shell table record for ${tableId}`);
  return table;
}

// The two lists must agree: the shell offers exactly the tables the rest of the
// project knows how to load, in the same order, or the function keys select the
// wrong one. Checked once at module load rather than trusted.
if (SHELL_TABLES.length !== TABLE_IDS.length) {
  throw new Error(
    `SHELL_TABLES has ${SHELL_TABLES.length} entries, TABLE_IDS has ${TABLE_IDS.length}`,
  );
}
for (let i = 0; i < TABLE_IDS.length; i += 1) {
  if (SHELL_TABLES[i]?.id !== TABLE_IDS[i]) {
    throw new Error(`SHELL_TABLES[${i}] does not match TABLE_IDS[${i}]`);
  }
}

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

/**
 * THE PAGE CYCLE, measured frame by frame off a continuous capture.
 *
 * `research\view\reference\session3` filmed the credits for 399.58 s without
 * touching the machine and measured every one of the 112 start-to-start
 * intervals in the main take and all 55 in an independent cold boot: EVERY ONE
 * IS 176 FRAMES. It does not vary with how much text the page carries.
 *
 * Inside those 176 frames the text appears COMPLETE IN ONE FRAME — the text
 * pixel count goes 0 -> full between two consecutive frames on all 113 filmed
 * instances, with no exception — is held bit-identical, and is then ERASED
 * downward. So the animation belongs to the page going away, not to the page
 * arriving, which is the opposite of what this shell used to do.
 *
 * The erase front starts on frame 101 of the page and advances 8 rows every
 * two frames:
 *
 *     F(t) = 8 * floor((t - 101) / 2)      t = frames since the page appeared
 *     row y is still visible  iff  y + 7*(y mod 8) >= F
 *
 * The visibility rule is `shellWipeShowsRow` in `shell-screens.ts`, unchanged
 * and now row-exact against the film. Because a row's erase key is
 * K(y) = (y div 8) + (y mod 8), a page is fully up for 101 + 2*(K_min + 1)
 * frames, where K_min is the smallest key over its text rows: 125 for the nine
 * two-line pages (K_min 11), 129 for "Pinball Illusions" (13), 119 for "Game
 * Testing" (8) and 111 for "Thanx to" (4). Verified on all 113 instances.
 */
export const ATTRACT_PAGE_TICKS = 176;

/** The frame of the page cycle on which the erase front leaves zero: F(101) = 0. */
export const ATTRACT_ERASE_START_TICK = 101;

/** Rows the erase front advances per frame — 8 every two frames. */
export const ATTRACT_ERASE_ROWS_PER_TICK = 4;

/**
 * Pages in the default roll: indices 0..11, wrapping at the NULL in slot 12.
 * The array on disk is longer; the rest of it is the HELP branch and does not
 * ship. See `ATTRACT_PAGES`.
 */
export const ATTRACT_ROLL_PAGES = 12;

/** Frames in one full lap of the roll: 12 * 176. Filmed at 42.24 s. */
export const ATTRACT_LAP_TICKS = ATTRACT_PAGE_TICKS * ATTRACT_ROLL_PAGES;

/** Ticks the GAME OVER card is held before the high-score check. 100 frames. */
export const GAME_OVER_TICKS = 100;

/**
 * Ticks the "PLAYER 1 GOT A / HIGHSCORE" card is held before the name box
 * appears. The original holds it for three seconds (0x48DB).
 */
export const HIGHSCORE_FANFARE_TICKS = 150;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Where the shell is.
 *
 * The first five are the original's menu states `$EE(a5)` = 0, 1, 2, 4 plus a
 * loading state the Amiga did not need a screen for (it had a copper-driven
 * LOADING display in the loader instead, and the disk access was the wait).
 * `play`, `quit-confirm`, `game-over`, `fanfare`, `initials` and `ladder` are
 * the in-game machine's states 3, 0 and 2.
 */
export type ShellPhase =
  | "attract"
  | "menu"
  | "select"
  | "info"
  | "loading"
  | "play"
  | "quit-confirm"
  | "game-over"
  | "fanfare"
  | "initials"
  | "ladder"
  | "failed";

/** The main menu's two items, in display-list order (0xCF3C). */
export const MENU_ITEMS = Object.freeze(["Tables", "Exit"] as const);

/** Which of table select's two boxes has focus. `$13C(a5)`. */
export type SelectColumn = 0 | 1;

export interface ShellState {
  phase: ShellPhase;
  /** Cursor into `SHELL_TABLES`, shared by table select and the info screen. */
  cursor: number;
  /** Cursor into `MENU_ITEMS`. `$F0(a5)`, max `$F2(a5)` = 1. */
  menuCursor: number;
  column: SelectColumn;
  /** Which attract page is showing, and how long it has been up. */
  attractPage: number;
  attractTicks: number;
  /** Ticks left on whatever card the current phase is holding. */
  holdTicks: number;
  /**
   * Ticks since the phase last changed, and the phase that count belongs to.
   *
   * The presentation's clock, not the flow's: the info screen's typewriter and
   * its block dissolve both run off it, and both are decoded behaviours (4
   * characters a frame, 4 dissolve units a frame). Kept here rather than in the
   * renderer so that drawing stays a pure function of the state — two hosts
   * given the same state draw the same frame.
   */
  frameTicks: number;
  phaseMark: ShellPhase;
  /**
   * Ticks since the shell was created, reset by nothing.
   *
   * The original's backdrop service — the eight-tint palette cycle and the strip
   * swap at h0+0x10AA, and the band scroll under it — is a background job called
   * once per field in EVERY menu state, and moving between screens does not
   * restart it. It therefore needs a clock that outlives `frameTicks`, which
   * belongs to the current screen.
   */
  ticks: number;
  /** The table the host has loaded or is loading, or null. `$138(a5)`. */
  tableId: TableId | null;
  /** The ladder of whichever table the current screen is about. */
  ladder: readonly HighScoreEntry[];
  /** The score the finished game ended on. */
  finalScore: number;
  /** Zero-based place that score earns, or -1 when it earns none. */
  place: number;
  /** The initials typed so far, at most three. The original's 0x4929 buffer. */
  initials: string;
  /** Why the table would not load, for the failed screen. */
  error: string | null;
}

/**
 * Something the host has to do. The shell never does any of it itself.
 *
 * Three, and no more: fetching a table, starting a game on one, and throwing one
 * away. Everything else the shell decides it can also carry out, because it is
 * only ever moving its own cursor.
 */
export type ShellEffect =
  | { readonly kind: "load-table"; readonly tableId: TableId }
  | { readonly kind: "start-game" }
  | { readonly kind: "leave-table" };

/**
 * Where the ladders live.
 *
 * Injected rather than reached for, so the whole flow can be driven in a test
 * with a plain object and so `high-scores.ts` stays the only module that knows
 * what a stored ladder looks like.
 */
export interface ScoreStore {
  load(tableId: TableId): HighScoreEntry[];
  save(tableId: TableId, entries: readonly HighScoreEntry[]): void;
}

/** A store backed by `localStorage`, or by nothing when there is none. */
export function createScoreStore(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
): ScoreStore {
  return {
    load: (tableId) => loadHighScores(tableId, storage),
    save: (tableId, entries) => saveHighScores(tableId, entries, storage),
  };
}

/**
 * The shell, sitting where the original sits after `init2`: attract page zero,
 * cursor on the first table, nothing loaded.
 */
export function createShell(store: ScoreStore): ShellState {
  const first = SHELL_TABLES[0];
  if (first === undefined) throw new Error("SHELL_TABLES is empty");
  return {
    phase: "attract",
    cursor: 0,
    menuCursor: 0,
    column: 0,
    attractPage: 0,
    attractTicks: 0,
    holdTicks: 0,
    frameTicks: 0,
    phaseMark: "attract",
    ticks: 0,
    tableId: null,
    ladder: store.load(first.id),
    finalScore: 0,
    place: -1,
    initials: "",
    error: null,
  };
}

/** The table the cursor is on. Never undefined: the cursor is always clamped. */
export function highlightedTable(state: ShellState): ShellTable {
  const table = SHELL_TABLES[state.cursor];
  if (table === undefined) throw new RangeError(`shell cursor out of range: ${state.cursor}`);
  return table;
}

// ---------------------------------------------------------------------------
// Attract pages
// ---------------------------------------------------------------------------

/** A centred line at x = 160, which is opcode 0x0002 and every line in the roll. */
function c(text: string, y: number): AttractLine {
  return Object.freeze({ text, x: 160, y, align: "center" as const });
}

/** One line of an attract page: the display list's own record, verbatim. */
export interface AttractLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly align: "left" | "center" | "right";
}

/**
 * THE CREDIT ROLL — the original's own twelve pages, decoded from the disk.
 *
 * ---------------------------------------------------------------------------
 * WHERE THEY COME FROM
 * ---------------------------------------------------------------------------
 * `menudata.bin` hunk 4 holds an array of page pointers at h4+0x0B84 and the
 * page display lists after it. The interpreter is `main.seg00 +0x1CB8`: it
 * reads a big-endian word, `cmpi.w #3` ends the page, and anything else indexes
 * the jump table at `+0x1CB2`, word-aligning `a0` after each record
 * (`+0x1CCA..+0x1CD4`). FOUR OPCODES, and none of them is a line or a rule:
 *
 *     0x0000  `+0x1CDA`  TEXT left-aligned    u16 x, u16 y, asciiz
 *     0x0001  `+0x1CEA`  TEXT right-aligned   (`+0x1CF8 sub.w d4,d0`)
 *     0x0002  `+0x1D04`  TEXT centred         (`+0x1D12 lsr.w #1,d4`, sub)
 *     0x0003  `+0x1CD8`  end of page
 *
 * The array has nineteen slots plus a NULL terminator, two of the slots are
 * embedded NULLs, and an eighteenth page sits at h4+0x0B80 reached as index -1
 * (the read at `+0x1174` is `movea.l ([$dc,a5],d0.w*4),a0` with d0.w SIGN
 * EXTENDED). THE DEFAULT ROLL IS INDICES 0..11, wrapping at the NULL in slot
 * 12 — not the array length. Both the disassembly and a continuous capture say
 * twelve: `research\view\reference\session3` filmed 221 page instances over
 * four cold boots and hashed exactly twelve distinct text bitmaps, in this
 * order, with no exception, starting on "Pinball Illusions" from a cold boot.
 *
 * ---------------------------------------------------------------------------
 * WHAT DELIBERATELY DOES NOT SHIP
 * ---------------------------------------------------------------------------
 * The disk also carries pages reachable only by holding HELP and typing a code
 * word: two personal greeting sets, a piracy scold, and a page of partisan
 * political jokes. THE OPERATOR HAS DECIDED NONE OF THEM SHIP. There is no HELP
 * code path in this shell, on purpose — the omission is a decision, not an
 * oversight, and this comment is where it is recorded so nobody "restores" it
 * later as a missing feature. The index -1 version page (`Pinball_Illusions
 * 1.6 / (24.1.95)`) is part of the same HELP branch and is out with the rest.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COORDINATES ARE LITERALS AND NOT A LADDER
 * ---------------------------------------------------------------------------
 * Every y below is the word in the page record. The set is exactly
 * {44, 74, 104, 134, 164, 194} for the roll — a 30-px pitch, but ANCHORED
 * DIFFERENTLY PER PAGE: a two-line page is 104/134, "Pinball Illusions" alone
 * is 120, "Game Testing" runs 74/104/134/164 and "Thanx to" 44/74/104/134/164/
 * 194. No formula reproduces that, and the previous model — at most three
 * lines, all centred on 160, top-anchored at 104 on a 30-px pitch — could not
 * represent it at all.
 *
 * `Fredrik Liliegren` is the disk's spelling (`4c 69 6c 69 65 67 72 65 6e`).
 * The person is Fredrik Liljegren; the page is attribution and the disk is the
 * source, so it is reproduced as the machine prints it.
 *
 * The Swedish letters are written here in readable Unicode and translated to
 * the font's own slots by `shellCharCode` in `shell-art.ts` — see the table
 * there. A literal 'ö' would measure 0 and draw nothing.
 */
export const ATTRACT_PAGES: readonly (readonly AttractLine[])[] = Object.freeze([
  Object.freeze([c("Pinball Illusions", 120)]),
  Object.freeze([c("Concept and Design by", 104), c("Digital Illusions", 134)]),
  Object.freeze([c("Programming by", 104), c("Andreas Axelsson", 134)]),
  Object.freeze([c("Graphics by", 104), c("Markus Nyström", 134)]),
  Object.freeze([c("Music & Soundeffects by", 104), c("Olof Gustafsson", 134)]),
  Object.freeze([c("Managing by", 104), c("Fredrik Liliegren", 134)]),
  Object.freeze([c("Produced by", 104), c("Barry Simpson", 134)]),
  Object.freeze([c("Additional Graphics by", 104), c("Patrik Bergdahl", 134)]),
  Object.freeze([c("Intro Coding by", 104), c("Thomas Andersson", 134)]),
  Object.freeze([c("Packing Algorithms by", 104), c("Stefan Boberg", 134)]),
  Object.freeze([
    c("Game Testing by", 74),
    c("Digital Illusions", 104),
    c("&", 134),
    c("21st Century Entertainment", 164),
  ]),
  Object.freeze([
    c("Thanx to (in no order)", 44),
    c("Lisa", 74),
    c("Nicho", 104),
    c("Skåning", 134),
    c("Tvilling", 164),
    c("Inga & Bosse", 194),
  ]),
]);

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * One keystroke, already reduced to what the shell cares about.
 *
 * The original indexes a 128-byte rawkey table at `$E92(a5)` and, for the name
 * entry, a second 128-byte rawkey-to-ASCII table at 0x492E. A browser has
 * neither, so the host maps its own events into this shape and the shell stays
 * ignorant of keyboards. `char` carries the printable character when the key has
 * one, which is how SPACE manages to be both "select" in a menu and a legal
 * character in an initials box — exactly as it is on the Amiga, where rawkey
 * 0x40 selects a menu item and also maps to ASCII 0x20.
 */
export interface ShellKey {
  readonly kind: "up" | "down" | "left" | "right" | "select" | "back" | "erase" | "table" | "text";
  /** Uppercase printable character, or null. */
  readonly char: string | null;
  /** Zero-based table index for `table` keys (F1..F3), else -1. */
  readonly index: number;
}

/**
 * Characters the name box accepts.
 *
 * The union of what the original can actually produce and what it says it
 * allows. Its rawkey-to-ASCII table at 0x492E yields the digits, the letters,
 * '.' and space; the 39-character string at 0x4778,
 * "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.- ", is a dead alphabet with no
 * reference anywhere in the code — a leftover from a flipper-cycled entry that
 * was replaced by keyboard entry — and it adds the hyphen. Taking the union
 * costs nothing and means a player who types a hyphen gets one.
 */
export const INITIALS_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.- ";

export function isInitialsCharacter(value: string): boolean {
  return value.length === 1 && INITIALS_ALPHABET.includes(value);
}

/** Direct-to-table function keys: F1..F3, the original's 0x50..0x59 range. */
const TABLE_KEYS: Readonly<Record<string, number>> = Object.freeze({
  F1: 0,
  F2: 1,
  F3: 2,
});

const NAVIGATION_KEYS: Readonly<Record<string, ShellKey["kind"]>> = Object.freeze({
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "back",
  Backspace: "erase",
});

/**
 * Reduces a browser key event to a `ShellKey`, or null when the shell has no
 * use for it.
 *
 * Deliberately reading `code` rather than `key` for the navigation and function
 * keys, the way `input.ts` does, so a non-US layout still steers the menu; and
 * `key` for the printable characters, because that is the whole point of a
 * layout — a player typing their initials should get the letters on their own
 * keyboard, not the ones a US keyboard would have had there.
 *
 * SPACE arrives as a `select` that also carries a character, which is what lets
 * one key both choose a menu item and type a space into a name. That is not a
 * convenience: the Amiga does exactly the same thing, since rawkey 0x40 is the
 * menu's select key AND maps to ASCII 0x20 in the name-entry table at 0x492E.
 */
export function shellKeyFor(event: {
  readonly code?: string | undefined;
  readonly key?: string | undefined;
}): ShellKey | null {
  const code = event.code ?? "";
  const table = TABLE_KEYS[code];
  if (table !== undefined) return { kind: "table", char: null, index: table };

  const navigation = NAVIGATION_KEYS[code];
  if (navigation !== undefined) return { kind: navigation, char: null, index: -1 };

  if (code === "Space") return { kind: "select", char: " ", index: -1 };
  if (code === "Enter" || code === "NumpadEnter") return { kind: "select", char: null, index: -1 };

  const key = event.key ?? "";
  // Fall back to `key` for the same set, for events that carry no `code`.
  if (key === "Escape") return { kind: "back", char: null, index: -1 };
  if (key === "Backspace") return { kind: "erase", char: null, index: -1 };
  if (key === "Enter") return { kind: "select", char: null, index: -1 };
  if (key === " ") return { kind: "select", char: " ", index: -1 };

  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (isInitialsCharacter(upper)) return { kind: "text", char: upper, index: -1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function clampCursor(value: number, count: number): number {
  if (count <= 0) return 0;
  if (value < 0) return count - 1;
  if (value >= count) return 0;
  return value;
}

/** Moves to the table-select screen with the ladder for the cursor's table. */
function enterSelect(state: ShellState, store: ScoreStore): void {
  state.phase = "select";
  state.column = 0;
  state.ladder = store.load(highlightedTable(state).id);
}

/** Starts loading a table. The original patches the digits and LoadSegs. */
function beginLoad(state: ShellState, store: ScoreStore, index: number): ShellEffect[] {
  const table = SHELL_TABLES[index];
  if (table === undefined) return [];
  state.cursor = index;
  state.phase = "loading";
  state.tableId = table.id;
  state.ladder = store.load(table.id);
  state.error = null;
  return [{ kind: "load-table", tableId: table.id }];
}

/** Back to the shell attract screen, giving the table back. */
function leaveTable(state: ShellState, store: ScoreStore): ShellEffect[] {
  const had = state.tableId !== null;
  state.phase = "attract";
  state.attractPage = 0;
  state.attractTicks = 0;
  state.tableId = null;
  state.finalScore = 0;
  state.place = -1;
  state.initials = "";
  state.ladder = store.load(highlightedTable(state).id);
  // The original frees the whole table and every menu allocation on the way
  // back and re-reads them next time round the outer loop at 0x00..0xE8.
  return had ? [{ kind: "leave-table" }] : [];
}

/**
 * Feeds one keystroke to the shell.
 *
 * Returns what the host must do about it. A key the current phase has no use
 * for returns nothing and changes nothing — the caller decides separately
 * whether to swallow the browser's default.
 */
export function shellKey(state: ShellState, store: ScoreStore, key: ShellKey): ShellEffect[] {
  // The function keys pick a table and go straight into the game from anywhere
  // the shell is showing a menu, which is what 0x1128 does: it is wired into the
  // attract state AND the main menu, and it skips table select entirely.
  if (
    key.kind === "table" &&
    (state.phase === "attract" || state.phase === "menu" || state.phase === "select")
  ) {
    return beginLoad(state, store, key.index);
  }

  switch (state.phase) {
    case "attract":
      // SPACE (rawkey 0x40) is the only way forward out of the credits roll.
      if (key.kind === "select") {
        state.phase = "menu";
        state.menuCursor = 0;
      }
      return [];

    case "menu":
      if (key.kind === "up") state.menuCursor = clampCursor(state.menuCursor - 1, MENU_ITEMS.length);
      else if (key.kind === "down") {
        state.menuCursor = clampCursor(state.menuCursor + 1, MENU_ITEMS.length);
      } else if (key.kind === "back") {
        state.phase = "attract";
        state.attractTicks = 0;
      } else if (key.kind === "select") {
        // The word table at 0x13C6 is {2, 5}: "Tables" goes to table select,
        // "Exit" goes to the state that sets the quit flag. See the header for
        // why quitting lands on the attract screen here.
        if (state.menuCursor === 0) enterSelect(state, store);
        else {
          state.phase = "attract";
          state.attractPage = 0;
          state.attractTicks = 0;
        }
      }
      return [];

    case "select":
      if (key.kind === "up" || key.kind === "down") {
        const step = key.kind === "up" ? -1 : 1;
        state.cursor = clampCursor(state.cursor + step, SHELL_TABLES.length);
        state.ladder = store.load(highlightedTable(state).id);
      } else if (key.kind === "left") state.column = 0;
      else if (key.kind === "right") state.column = 1;
      else if (key.kind === "back") {
        state.phase = "attract";
        state.attractTicks = 0;
      } else if (key.kind === "select") {
        if (state.column === 0) return beginLoad(state, store, state.cursor);
        state.phase = "info";
      }
      return [];

    case "info":
      // ESC is the way out, and the screen says so itself: all three `.mnu`
      // text blocks end with the line "Press ESC to exit." SPACE is taken as
      // well, because a screen with one printed exit and a second silent one is
      // strictly kinder than a screen with one exit the player has to find.
      if (key.kind === "back" || key.kind === "select") enterSelect(state, store);
      return [];

    case "loading":
    case "failed":
      if (state.phase === "failed" && (key.kind === "back" || key.kind === "select")) {
        return leaveTable(state, store);
      }
      return [];

    case "play":
      // ESC on the playfield. The original draws "REALLY QUIT TABLE?" and waits.
      if (key.kind === "back") state.phase = "quit-confirm";
      return [];

    case "quit-confirm":
      // 'Y' and nothing else. Any other key resumes, which is what 0x42A2 does.
      if (key.char === "Y") return leaveTable(state, store);
      state.phase = "play";
      return [];

    case "game-over":
      // The card can be cut short; the check underneath it happens either way.
      if (key.kind === "select" || key.kind === "back") return finishGameOver(state, store);
      return [];

    case "fanfare":
      if (key.kind === "select" || key.kind === "back") {
        state.phase = "initials";
        state.initials = "";
      }
      return [];

    case "initials": {
      if (key.kind === "erase") {
        state.initials = state.initials.slice(0, -1);
        return [];
      }
      // RETURN accepts early ($ED6 at 0x4920's loop), and so does ESC here:
      // there is no way to refuse a high score on the original either.
      if ((key.kind === "select" && key.char === null) || key.kind === "back") {
        return commitInitials(state, store);
      }
      const char = key.char;
      if (char !== null && isInitialsCharacter(char) && state.initials.length < INITIALS_LENGTH) {
        state.initials += char;
        // Typing the third character accepts on its own: `cmpi.w #3,$488A` and
        // the loop falls out rather than waiting for RETURN.
        if (state.initials.length >= INITIALS_LENGTH) return commitInitials(state, store);
      }
      return [];
    }

    case "ladder":
      // The table's own attract screen. The original starts a game here on
      // F1..F8 (players) or keypad ENTER (one player), and leaves the table on
      // ESC -> "REALLY QUIT TABLE?".
      if (key.kind === "select") {
        state.phase = "play";
        return [{ kind: "start-game" }];
      }
      if (key.kind === "back") state.phase = "quit-confirm";
      return [];
  }
}

/**
 * Marks the presentation clock against the phase, resetting it on a change.
 *
 * Returns true when it reset, so the caller can leave the tick that discovered
 * the change at zero rather than immediately counting it — the screen has been
 * up for no whole ticks at all at the moment it is entered.
 */
function markPhase(state: ShellState): boolean {
  if (state.phaseMark === state.phase) return false;
  state.phaseMark = state.phase;
  state.frameTicks = 0;
  return true;
}

/**
 * Advances the shell's own clocks by `ticks`.
 *
 * Only the screens that roll have one. Called every animation frame by the host
 * with the number of ticks that frame was WORTH — the simulation's own count
 * while a ball is in play, and `ShellClock`'s otherwise, which is a fixed 50 Hz
 * accumulator over the same `FixedStepScheduler`. It used to be called with a
 * literal 1 every animation frame in the menus, which ran the whole front end at
 * the display's refresh rate: 2.88x too fast on a 144 Hz screen, against a page
 * cycle the film measures as a hard 176 frames.
 *
 * A FRAME MAY THEREFORE BE WORTH ZERO TICKS, and that is the reason the phase
 * mark is taken before the loop as well as inside it. `frameTicks` is not
 * elapsed time — it is bookkeeping about WHICH SCREEN IS SHOWING, read by the
 * renderer for the info screen's typewriter and its picture dissolve — so a
 * screen entered by a keystroke must start at zero on the very next frame
 * DRAWN, not on the next frame that happens to owe a tick. Without it a 144 Hz
 * display opens the info screen for two frames with the previous screen's count,
 * i.e. with the typewriter already finished, and then restarts it.
 *
 * For any `ticks >= 1` this is exactly what it always did: the tick that
 * discovers the change leaves the clock at zero and the next one counts 1.
 */
export function shellTick(state: ShellState, store: ScoreStore, ticks = 1): ShellEffect[] {
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new RangeError(`ticks must be a non-negative whole number: ${ticks}`);
  }
  const effects: ShellEffect[] = [];
  let entered = markPhase(state);
  for (let i = 0; i < ticks; i += 1) {
    // The backdrop service's clock: free-running, ahead of everything else,
    // because it belongs to no screen.
    state.ticks += 1;
    // The presentation clock. A phase this loop itself moved to — game-over ->
    // fanfare -> initials — is marked here instead.
    if (markPhase(state)) entered = true;
    if (entered) entered = false;
    else state.frameTicks += 1;
    if (state.phase === "attract") {
      state.attractTicks += 1;
      if (state.attractTicks >= ATTRACT_PAGE_TICKS) {
        state.attractTicks = 0;
        // The NULL in slot 12 of the original's array wraps the roll back to
        // page 0. Twelve, not `ATTRACT_PAGES.length` by accident: the array on
        // disk is longer and the rest of it is the HELP branch, which does not
        // ship (see ATTRACT_PAGES).
        state.attractPage = (state.attractPage + 1) % ATTRACT_ROLL_PAGES;
      }
      continue;
    }
    if (state.holdTicks > 0) {
      state.holdTicks -= 1;
      if (state.holdTicks > 0) continue;
      if (state.phase === "game-over") effects.push(...finishGameOver(state, store));
      else if (state.phase === "fanfare") {
        state.phase = "initials";
        state.initials = "";
      }
    }
  }
  return effects;
}

/**
 * Jumps straight to a named table from wherever the shell is.
 *
 * What the attract screen's function keys do (0x1128), exposed by name so the
 * debug handle and an automated check take the same path a player does rather
 * than reaching past the shell into the game.
 */
export function shellPlayTable(
  state: ShellState,
  store: ScoreStore,
  tableId: TableId,
): ShellEffect[] {
  const index = SHELL_TABLES.findIndex((table) => table.id === tableId);
  if (index < 0) throw new RangeError(`unknown table: ${tableId}`);
  const leaving = state.tableId !== null && state.tableId !== tableId ? [leaveEffect()] : [];
  return [...leaving, ...beginLoad(state, store, index)];
}

function leaveEffect(): ShellEffect {
  return { kind: "leave-table" };
}

/** The host reporting that every file for `state.tableId` is in. */
export function shellTableLoaded(state: ShellState): ShellEffect[] {
  if (state.phase !== "loading") return [];
  state.phase = "play";
  return [{ kind: "start-game" }];
}

/** The host reporting that a table would not load. */
export function shellTableFailed(state: ShellState, message: string): void {
  state.phase = "failed";
  state.error = message;
  state.tableId = null;
}

/**
 * The host reporting that the game just ended.
 *
 * `game-loop.ts` raises `gameOver` on the tick the last ball drains and puts the
 * game into its own `game-over` phase; the shell takes it from there and the
 * host stops ticking, so the simulation never sees the start press that would
 * otherwise restart it behind the shell's back.
 */
export function shellGameEnded(state: ShellState, score: number): void {
  state.phase = "game-over";
  state.finalScore = score;
  state.holdTicks = GAME_OVER_TICKS;
  state.initials = "";
  state.place = -1;
}

/**
 * The high-score check: in-game state 2, at 0x45FE.
 *
 * The rule is the whole of it — the player's score is compared against this
 * table's own five entries and the first one it beats is the insertion rank.
 * There is no threshold constant anywhere in the binary; on a virgin install the
 * bar is simply the factory ladder's fifth entry.
 */
function finishGameOver(state: ShellState, store: ScoreStore): ShellEffect[] {
  const tableId = state.tableId;
  state.ladder = tableId === null ? state.ladder : store.load(tableId);
  state.place = placeFor(state.ladder, state.finalScore);
  state.holdTicks = 0;
  if (state.place < 0) {
    state.phase = "ladder";
    return [];
  }
  // "PLAYER 1 GOT A / HIGHSCORE" for three seconds, then the name box.
  state.phase = "fanfare";
  state.holdTicks = HIGHSCORE_FANFARE_TICKS;
  return [];
}

/** Writes the typed initials into the ladder and persists it. */
function commitInitials(state: ShellState, store: ScoreStore): ShellEffect[] {
  const tableId = state.tableId;
  const initials = state.initials.trim().length === 0 ? "AAA" : state.initials;
  state.ladder = insertScore(state.ladder, initials, state.finalScore).slice(0, HIGH_SCORE_SLOTS);
  if (tableId !== null) {
    // The original stores the ladder back through nonvolatile.library at 0x3438
    // when the table is torn down. Saving at the moment the name is accepted is
    // the same ladder written a few seconds earlier, and it survives a browser
    // tab closed on the score screen — which the Amiga's teardown would not.
    store.save(tableId, state.ladder);
  }
  state.phase = "ladder";
  state.holdTicks = 0;
  return [];
}
