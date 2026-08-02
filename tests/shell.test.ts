import { describe, expect, it } from "vitest";
import {
  ATTRACT_PAGES,
  ATTRACT_PAGE_TICKS,
  GAME_OVER_TICKS,
  HIGHSCORE_FANFARE_TICKS,
  INFO_LINE_CHARACTERS,
  INITIALS_ALPHABET,
  MENU_ITEMS,
  SHELL_TABLES,
  createScoreStore,
  createShell,
  highlightedTable,
  isInitialsCharacter,
  shellGameEnded,
  shellKey,
  shellKeyFor,
  shellPlayTable,
  shellTableFailed,
  shellTableLoaded,
  shellTick,
} from "../src/browser/shell.js";
import type { ScoreStore, ShellEffect, ShellKey, ShellState } from "../src/browser/shell.js";
import { formatScore } from "../src/browser/shell-screens.js";
import { FACTORY_HIGH_SCORES, HIGH_SCORE_SLOTS } from "../src/game/high-scores.js";
import type { HighScoreEntry } from "../src/game/high-scores.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableId } from "../src/game/contracts.js";

/**
 * The shell's flow, driven exactly the way `src/main.ts` drives it: keystrokes
 * in, effects out, and a score store that is a plain Map.
 *
 * There is no DOM anywhere in this file on purpose. Every transition below is
 * one the disk established — see the header of `src/browser/shell.ts` for which
 * address each one came off — and the point of keeping the machine free of the
 * browser is that those transitions can be asserted rather than clicked.
 */

function fakeStore(): ScoreStore & { saved: Map<TableId, readonly HighScoreEntry[]> } {
  const saved = new Map<TableId, readonly HighScoreEntry[]>();
  return {
    saved,
    load: (tableId) => {
      const held = saved.get(tableId);
      return held === undefined
        ? FACTORY_HIGH_SCORES.map((entry) => ({ ...entry }))
        : held.map((entry) => ({ ...entry }));
    },
    save: (tableId, entries) => void saved.set(tableId, entries.map((entry) => ({ ...entry }))),
  };
}

function key(kind: ShellKey["kind"], char: string | null = null, index = -1): ShellKey {
  return { kind, char, index };
}

const SELECT = key("select");
const SPACE = key("select", " ");
const BACK = key("back");
const UP = key("up");
const DOWN = key("down");
const LEFT = key("left");
const RIGHT = key("right");

/** Drives a run of keys and returns everything the host was told to do. */
function press(state: ShellState, store: ScoreStore, ...keys: readonly ShellKey[]): ShellEffect[] {
  const effects: ShellEffect[] = [];
  for (const item of keys) effects.push(...shellKey(state, store, item));
  return effects;
}

/** Walks the shell all the way to a running game on one table. */
function intoPlay(tableId: TableId): { state: ShellState; store: ReturnType<typeof fakeStore> } {
  const store = fakeStore();
  const state = createShell(store);
  shellPlayTable(state, store, tableId);
  shellTableLoaded(state);
  return { state, store };
}

describe("the table database", () => {
  it("is the three records of tables.bin, in order, with their stored names", () => {
    expect(SHELL_TABLES.map((table) => table.id)).toEqual([...TABLE_IDS]);
    expect(SHELL_TABLES.map((table) => table.name)).toEqual([
      "Law 'n Justice",
      "BabeWatch",
      "Extreme Sports",
    ]);
    expect(SHELL_TABLES.map((table) => table.slot)).toEqual([1, 2, 3]);
  });

  it("carries a description of its own rather than the .mnu paragraph", () => {
    // The rights line: the names are functional identifiers and ship; the
    // publisher's marketing prose does not. This asserts only that a blurb
    // exists and is short enough to be a caption rather than a paragraph.
    for (const table of SHELL_TABLES) {
      expect(table.blurb.length).toBeGreaterThan(0);
      expect(table.blurb.join(" ").length).toBeLessThan(120);
    }
  });

  it("keeps every info-screen line inside the column left of the artwork", () => {
    // The panel starts at x = 176; a longer line is printed under the picture.
    for (const table of SHELL_TABLES) {
      expect(table.name.length).toBeLessThanOrEqual(INFO_LINE_CHARACTERS);
      for (const line of table.blurb) {
        expect(line.length, `${table.id}: "${line}"`).toBeLessThanOrEqual(INFO_LINE_CHARACTERS);
      }
    }
  });
});

describe("the menu machine", () => {
  it("starts on the attract screen with nothing loaded", () => {
    const store = fakeStore();
    const state = createShell(store);
    expect(state.phase).toBe("attract");
    expect(state.tableId).toBeNull();
    expect(state.ladder).toHaveLength(HIGH_SCORE_SLOTS);
  });

  it("walks attract -> menu -> table select -> play, the original's states 0,1,2,3", () => {
    const store = fakeStore();
    const state = createShell(store);

    expect(press(state, store, SPACE)).toEqual([]);
    expect(state.phase).toBe("menu");
    expect(MENU_ITEMS[state.menuCursor]).toBe("Tables");

    expect(press(state, store, SELECT)).toEqual([]);
    expect(state.phase).toBe("select");
    expect(state.column).toBe(0);

    const effects = press(state, store, SELECT);
    expect(effects).toEqual([{ kind: "load-table", tableId: "law-n-justice" }]);
    expect(state.phase).toBe("loading");
  });

  it("has exactly two menu items, and Exit goes back to the attract screen", () => {
    expect([...MENU_ITEMS]).toEqual(["Tables", "Exit"]);
    const store = fakeStore();
    const state = createShell(store);
    press(state, store, SPACE, DOWN);
    expect(MENU_ITEMS[state.menuCursor]).toBe("Exit");
    press(state, store, SELECT);
    expect(state.phase).toBe("attract");
  });

  it("wraps the menu cursor at both ends", () => {
    const store = fakeStore();
    const state = createShell(store);
    press(state, store, SPACE, UP);
    expect(state.menuCursor).toBe(MENU_ITEMS.length - 1);
    press(state, store, DOWN);
    expect(state.menuCursor).toBe(0);
  });

  it("takes ESC back up one screen at a time", () => {
    const store = fakeStore();
    const state = createShell(store);
    press(state, store, SPACE, SELECT);
    expect(state.phase).toBe("select");
    press(state, store, BACK);
    // The original's table select goes to $EE=0, i.e. straight to attract.
    expect(state.phase).toBe("attract");
  });
});

describe("table select", () => {
  it("moves through all three tables and reloads each one's ladder", () => {
    const store = fakeStore();
    store.save("babewatch", [{ initials: "ZZZ", score: 1 }]);
    const state = createShell(store);
    press(state, store, SPACE, SELECT);

    expect(highlightedTable(state).id).toBe("law-n-justice");
    press(state, store, DOWN);
    expect(highlightedTable(state).id).toBe("babewatch");
    expect(state.ladder[0]?.initials).toBe("ZZZ");
    press(state, store, DOWN);
    expect(highlightedTable(state).id).toBe("extreme-sports");
    press(state, store, DOWN);
    expect(highlightedTable(state).id).toBe("law-n-justice");
  });

  it("has two boxes, and LEFT/RIGHT chooses between play and info", () => {
    const store = fakeStore();
    const state = createShell(store);
    press(state, store, SPACE, SELECT, RIGHT);
    expect(state.column).toBe(1);
    expect(press(state, store, SELECT)).toEqual([]);
    expect(state.phase).toBe("info");

    press(state, store, BACK);
    expect(state.phase).toBe("select");
    press(state, store, LEFT);
    expect(state.column).toBe(0);
  });

  it("loads whichever table the cursor is on", () => {
    const store = fakeStore();
    const state = createShell(store);
    press(state, store, SPACE, SELECT, DOWN, DOWN);
    expect(press(state, store, SELECT)).toEqual([
      { kind: "load-table", tableId: "extreme-sports" },
    ]);
    expect(state.tableId).toBe("extreme-sports");
  });

  it("reaches every shipped table", () => {
    for (const tableId of TABLE_IDS) {
      const { state } = intoPlay(tableId);
      expect(state.phase).toBe("play");
      expect(state.tableId).toBe(tableId);
    }
  });
});

describe("the function keys", () => {
  it("go straight from the attract screen into a game, skipping the menu", () => {
    const store = fakeStore();
    const state = createShell(store);
    expect(press(state, store, key("table", null, 1))).toEqual([
      { kind: "load-table", tableId: "babewatch" },
    ]);
    expect(state.phase).toBe("loading");
    expect(shellTableLoaded(state)).toEqual([{ kind: "start-game" }]);
    expect(state.phase).toBe("play");
  });

  it("work from the menu and from table select too", () => {
    const store = fakeStore();
    const state = createShell(store);
    press(state, store, SPACE);
    expect(press(state, store, key("table", null, 2))).toEqual([
      { kind: "load-table", tableId: "extreme-sports" },
    ]);
  });

  it("do nothing once a ball is in play", () => {
    const { state, store } = intoPlay("law-n-justice");
    expect(press(state, store, key("table", null, 2))).toEqual([]);
    expect(state.phase).toBe("play");
    expect(state.tableId).toBe("law-n-justice");
  });
});

describe("loading", () => {
  it("starts the game when the host says the files are in", () => {
    const store = fakeStore();
    const state = createShell(store);
    press(state, store, key("table", null, 0));
    expect(shellTableLoaded(state)).toEqual([{ kind: "start-game" }]);
  });

  it("shows the failure and lets ESC out of it", () => {
    const store = fakeStore();
    const state = createShell(store);
    press(state, store, key("table", null, 0));
    shellTableFailed(state, "HTTP 404");
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("HTTP 404");
    press(state, store, BACK);
    expect(state.phase).toBe("attract");
  });

  it("ignores keys while it is loading", () => {
    const store = fakeStore();
    const state = createShell(store);
    press(state, store, key("table", null, 0));
    press(state, store, SELECT, BACK, UP, DOWN);
    expect(state.phase).toBe("loading");
  });
});

describe("quitting a table", () => {
  it("asks first, and only Y answers", () => {
    const { state, store } = intoPlay("law-n-justice");
    press(state, store, BACK);
    expect(state.phase).toBe("quit-confirm");

    press(state, store, key("text", "N"));
    expect(state.phase).toBe("play");

    press(state, store, BACK);
    expect(press(state, store, key("text", "Y"))).toEqual([{ kind: "leave-table" }]);
    expect(state.phase).toBe("attract");
    expect(state.tableId).toBeNull();
  });
});

describe("game over and the high-score check", () => {
  it("holds the card, then drops to the ladder when the score does not qualify", () => {
    const { state, store } = intoPlay("law-n-justice");
    shellGameEnded(state, 1_000);
    expect(state.phase).toBe("game-over");
    expect(state.holdTicks).toBe(GAME_OVER_TICKS);

    shellTick(state, store, GAME_OVER_TICKS);
    expect(state.phase).toBe("ladder");
    expect(state.place).toBe(-1);
    // Nothing written: a score that earns no place must not touch the ladder.
    expect(store.saved.has("law-n-justice")).toBe(false);
  });

  it("qualifies against that table's OWN ladder and nothing else", () => {
    const store = fakeStore();
    // A table whose fifth entry is trivial: anything beats it.
    store.save("babewatch", [{ initials: "AAA", score: 10 }]);
    const state = createShell(store);
    shellPlayTable(state, store, "babewatch");
    shellTableLoaded(state);

    // 100 would not get anywhere near the factory ladder's 50,000,000 bar.
    shellGameEnded(state, 100);
    shellTick(state, store, GAME_OVER_TICKS);
    expect(state.phase).toBe("fanfare");
    expect(state.place).toBe(0);
  });

  it("does not qualify a score under the factory ladder's fifth entry", () => {
    const { state, store } = intoPlay("law-n-justice");
    const fifth = FACTORY_HIGH_SCORES[HIGH_SCORE_SLOTS - 1];
    expect(fifth).toBeDefined();
    shellGameEnded(state, (fifth?.score ?? 0) - 1);
    shellTick(state, store, GAME_OVER_TICKS);
    expect(state.phase).toBe("ladder");
  });

  it("can be cut short with a key, and reaches the same place", () => {
    const { state, store } = intoPlay("law-n-justice");
    shellGameEnded(state, 2_000_000_000);
    press(state, store, SELECT);
    expect(state.phase).toBe("fanfare");
    expect(state.place).toBe(0);
  });
});

describe("entering three initials", () => {
  function toInitials(score = 2_000_000_000): {
    state: ShellState;
    store: ReturnType<typeof fakeStore>;
  } {
    const { state, store } = intoPlay("law-n-justice");
    shellGameEnded(state, score);
    shellTick(state, store, GAME_OVER_TICKS);
    shellTick(state, store, HIGHSCORE_FANFARE_TICKS);
    expect(state.phase).toBe("initials");
    return { state, store };
  }

  it("accepts on the third character without waiting for RETURN", () => {
    const { state, store } = toInitials();
    press(state, store, key("text", "J"));
    expect(state.phase).toBe("initials");
    press(state, store, key("text", "R"));
    expect(state.initials).toBe("JR");
    press(state, store, key("text", "B"));
    expect(state.phase).toBe("ladder");
    expect(state.ladder[0]).toEqual({ initials: "JRB", score: 2_000_000_000 });
  });

  it("deletes with BACKSPACE", () => {
    const { state, store } = toInitials();
    press(state, store, key("text", "A"), key("text", "B"), key("erase"));
    expect(state.initials).toBe("A");
    press(state, store, key("erase"), key("erase"));
    expect(state.initials).toBe("");
  });

  it("accepts early on RETURN", () => {
    const { state, store } = toInitials();
    press(state, store, key("text", "Q"), SELECT);
    expect(state.phase).toBe("ladder");
    expect(state.ladder[0]?.initials).toBe("Q");
  });

  it("takes a space from the SPACE key rather than treating it as select", () => {
    // Rawkey 0x40 is both the menu's select key and ASCII 0x20 in the name
    // table at 0x492E; the browser mapping keeps that dual role.
    const { state, store } = toInitials();
    press(state, store, key("text", "M"), SPACE, key("text", "N"));
    expect(state.ladder[0]?.initials).toBe("M N");
  });

  it("writes the ladder back where the table can find it", () => {
    const { state, store } = toInitials();
    press(state, store, key("text", "A"), key("text", "B"), key("text", "C"));
    const saved = store.saved.get("law-n-justice");
    expect(saved).toBeDefined();
    expect(saved).toHaveLength(HIGH_SCORE_SLOTS);
    expect(saved?.[0]).toEqual({ initials: "ABC", score: 2_000_000_000 });
    // The bottom entry falls off: five slots, and only five.
    expect(saved?.[4]?.initials).toBe("F L");
  });

  it("keeps each table's ladder separate", () => {
    const { state, store } = toInitials();
    press(state, store, key("text", "A"), key("text", "A"), key("text", "A"));
    expect(store.saved.has("law-n-justice")).toBe(true);
    expect(store.saved.has("babewatch")).toBe(false);
    expect(store.saved.has("extreme-sports")).toBe(false);
  });

  it("refuses characters outside its alphabet", () => {
    const { state, store } = toInitials();
    press(state, store, key("text", "!"), key("text", "Å"));
    expect(state.initials).toBe("");
  });
});

describe("the table's own attract screen", () => {
  it("starts another game on the same table", () => {
    const { state, store } = intoPlay("extreme-sports");
    shellGameEnded(state, 1);
    shellTick(state, store, GAME_OVER_TICKS);
    expect(state.phase).toBe("ladder");
    expect(press(state, store, SELECT)).toEqual([{ kind: "start-game" }]);
    expect(state.phase).toBe("play");
    expect(state.tableId).toBe("extreme-sports");
  });

  it("leaves the table through the same question the playfield asks", () => {
    const { state, store } = intoPlay("extreme-sports");
    shellGameEnded(state, 1);
    shellTick(state, store, GAME_OVER_TICKS);
    press(state, store, BACK);
    expect(state.phase).toBe("quit-confirm");
    expect(press(state, store, key("text", "Y"))).toEqual([{ kind: "leave-table" }]);
  });
});

describe("the attract roll", () => {
  it("turns the page every two seconds and wraps", () => {
    const store = fakeStore();
    const state = createShell(store);
    expect(state.attractPage).toBe(0);
    shellTick(state, store, ATTRACT_PAGE_TICKS);
    expect(state.attractPage).toBe(1);
    shellTick(state, store, ATTRACT_PAGE_TICKS * (ATTRACT_PAGES.length - 1));
    expect(state.attractPage).toBe(0);
  });

  it("fits the original's three-line page ladder", () => {
    // The film pins the credits block to y = 104, 134, 164, top-anchored — three
    // slots and no more. (This used to allow six, from a reading of the display
    // list before the pages themselves had been seen.)
    for (const page of ATTRACT_PAGES) {
      expect(page.length).toBeGreaterThan(0);
      expect(page.length).toBeLessThanOrEqual(3);
    }
  });

  it("gives the renderer a clock that restarts on every screen change", () => {
    const store = fakeStore();
    const state = createShell(store);
    // `createShell` already marks the attract screen, so the first tick counts
    // rather than resetting.
    shellTick(state, store, 10);
    expect(state.frameTicks).toBe(10);
    press(state, store, SPACE);
    shellTick(state, store, 1);
    expect(state.frameTicks).toBe(0);
    shellTick(state, store, 3);
    expect(state.frameTicks).toBe(3);
  });

  it("refuses a negative tick count rather than running backwards", () => {
    const store = fakeStore();
    const state = createShell(store);
    expect(() => shellTick(state, store, -1)).toThrow(RangeError);
  });
});

describe("the key map", () => {
  it("reads the navigation keys off `code`, so a non-US layout still steers", () => {
    expect(shellKeyFor({ code: "ArrowUp" })?.kind).toBe("up");
    expect(shellKeyFor({ code: "ArrowDown" })?.kind).toBe("down");
    expect(shellKeyFor({ code: "ArrowLeft" })?.kind).toBe("left");
    expect(shellKeyFor({ code: "ArrowRight" })?.kind).toBe("right");
    expect(shellKeyFor({ code: "Escape" })?.kind).toBe("back");
    expect(shellKeyFor({ code: "Backspace" })?.kind).toBe("erase");
  });

  it("makes SPACE both a select and a character, as rawkey 0x40 is", () => {
    const space = shellKeyFor({ code: "Space", key: " " });
    expect(space?.kind).toBe("select");
    expect(space?.char).toBe(" ");
    const enter = shellKeyFor({ code: "Enter", key: "Enter" });
    expect(enter?.kind).toBe("select");
    expect(enter?.char).toBeNull();
  });

  it("maps F1..F3 to the three table slots", () => {
    expect(shellKeyFor({ code: "F1" })).toEqual({ kind: "table", char: null, index: 0 });
    expect(shellKeyFor({ code: "F2" })?.index).toBe(1);
    expect(shellKeyFor({ code: "F3" })?.index).toBe(2);
  });

  it("takes printable characters off `key`, so the player's own layout types", () => {
    expect(shellKeyFor({ code: "KeyQ", key: "a" })).toEqual({
      kind: "text",
      char: "A",
      index: -1,
    });
    expect(shellKeyFor({ code: "Digit7", key: "7" })?.char).toBe("7");
    expect(shellKeyFor({ code: "KeyQ", key: "å" })).toBeNull();
  });

  it("ignores everything else", () => {
    expect(shellKeyFor({ code: "F5", key: "F5" })).toBeNull();
    expect(shellKeyFor({})).toBeNull();
  });

  it("accepts exactly the alphabet the original's tables between them allow", () => {
    expect(INITIALS_ALPHABET).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.- ");
    expect(isInitialsCharacter("A")).toBe(true);
    expect(isInitialsCharacter("-")).toBe(true);
    expect(isInitialsCharacter(" ")).toBe(true);
    expect(isInitialsCharacter("*")).toBe(false);
    expect(isInitialsCharacter("AB")).toBe(false);
  });
});

describe("the score store", () => {
  it("falls back to the factory ladder when nothing is stored", () => {
    const store = createScoreStore(null);
    expect(store.load("law-n-justice")).toEqual(FACTORY_HIGH_SCORES.map((e) => ({ ...e })));
    // A null storage must swallow the write rather than throw.
    expect(() => store.save("law-n-justice", [])).not.toThrow();
  });
});

describe("the ladder block's formatting", () => {
  it("groups in threes, which is what the original's template prints", () => {
    expect(formatScore(0)).toBe("0");
    expect(formatScore(999)).toBe("999");
    expect(formatScore(1_000)).toBe("1,000");
    expect(formatScore(1_000_000_000)).toBe("1,000,000,000");
    expect(formatScore(20_900_000)).toBe("20,900,000");
  });
});
