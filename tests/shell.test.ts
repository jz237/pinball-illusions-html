import { describe, expect, it } from "vitest";
import { attractEraseFront } from "../src/browser/shell-screens.js";
import {
  ATTRACT_ERASE_ROWS_PER_TICK,
  ATTRACT_LAP_TICKS,
  ATTRACT_PAGES,
  ATTRACT_PAGE_TICKS,
  ATTRACT_ROLL_PAGES,
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
  shellSetPlayers,
  shellTableFailed,
  shellTableLoaded,
  shellTick,
} from "../src/browser/shell.js";
import type { ScoreStore, ShellEffect, ShellKey, ShellState } from "../src/browser/shell.js";
import {
  MENU_RECTS,
  SELECT_INFO_BOX,
  SELECT_NAME_BOX,
  SELECT_ROW_PITCH,
  SELECT_ROW_Y,
  formatScore,
} from "../src/browser/shell-screens.js";
import { deckPlanFor, shellHitTest } from "../src/browser/touch-zones.js";
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
    expect(shellTableLoaded(state)).toEqual([{ kind: "start-game", players: 1 }]);
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
    expect(shellTableLoaded(state)).toEqual([{ kind: "start-game", players: 1 }]);
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
    expect(press(state, store, SELECT)).toEqual([{ kind: "start-game", players: 1 }]);
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
  it("turns the page every 176 frames and laps in 2112", () => {
    // MEASURED, not "one page every two seconds": every one of the 112
    // start-to-start intervals in the 399 s take and all 55 in an independent
    // cold boot measured 176 frames, with no variation and no dependence on how
    // much text the page carries.
    const store = fakeStore();
    const state = createShell(store);
    expect(ATTRACT_PAGE_TICKS).toBe(176);
    expect(ATTRACT_LAP_TICKS).toBe(2112);
    expect(state.attractPage).toBe(0);
    shellTick(state, store, ATTRACT_PAGE_TICKS - 1);
    expect(state.attractPage, "the 176th frame is still the first page").toBe(0);
    shellTick(state, store, 1);
    expect(state.attractPage).toBe(1);
    shellTick(state, store, ATTRACT_LAP_TICKS);
    expect(state.attractPage, "one full lap of twelve pages returns to page 1").toBe(1);
  });

  it("holds the text up for 101 frames, then erases it 4 rows a frame", () => {
    // MEASURED, `session3	elemetry\wipe-erase-front.csv`: the page appears
    // COMPLETE in one frame, is bit-identical for the whole hold, and the erase
    // front leaves zero on frame 101 and advances 8 rows every two frames. The
    // bracket the visible rows imply for the front collapses onto exactly this
    // value at every erase frame of all 113 filmed page instances.
    expect(attractEraseFront(0)).toBeNull();
    expect(attractEraseFront(100)).toBeNull();
    expect(attractEraseFront(101)).toBe(0);
    expect(attractEraseFront(102)).toBe(0);
    expect(attractEraseFront(103)).toBe(8);
    expect(attractEraseFront(125)).toBe(96);
    expect(attractEraseFront(169)).toBe(272);
    expect(ATTRACT_ERASE_ROWS_PER_TICK).toBe(4);
    // And the per-page hold really is 101 + 2*(K_min + 1) frames, which is what
    // makes the film's four different "full display" figures one law: K_min is
    // the smallest erase key K(y) = (y div 8) + (y mod 8) over the rows the
    // page's text actually occupies. The four row spans below are the film's
    // own, measured off the text mask.
    const holdOf = (from: number, to: number): number => {
      let kMin = Infinity;
      for (let y = from; y <= to; y += 1) kMin = Math.min(kMin, Math.floor(y / 8) + (y % 8));
      return 101 + 2 * (kMin + 1);
    };
    expect(holdOf(104, 122), "Pinball Illusions, K_min 13").toBe(129);
    expect(holdOf(88, 141), "the nine two-line pages, K_min 11").toBe(125);
    expect(holdOf(58, 171), "Game Testing, K_min 8").toBe(119);
    expect(holdOf(27, 201), "Thanx to, K_min 4").toBe(111);
    // Every one of those is inside the 176-frame cycle with frames to spare.
    for (const hold of [129, 125, 119, 111]) expect(hold).toBeLessThan(ATTRACT_PAGE_TICKS);
  });

  it("is the disk's twelve pages, verbatim, with the disk's own y ladder", () => {
    // Decoded from menudata h4+0x0B84 and film-confirmed: 221 page instances
    // across four cold boots hashed to exactly these twelve bitmaps in exactly
    // this order. The strings and the y words are pinned here as literals so a
    // re-decode that changed either has to say so.
    //
    // This replaces "fits the original's three-line page ladder", which allowed
    // at most three lines on a 30-px ladder anchored at 104. The disk has a
    // one-line page at 120 and a six-line page from 44 to 194; neither fits
    // that model, and the model was inferred from four filmed pages rather than
    // read off the display list.
    expect(ATTRACT_PAGES).toHaveLength(ATTRACT_ROLL_PAGES);
    expect(ATTRACT_ROLL_PAGES).toBe(12);
    const rendered = ATTRACT_PAGES.map((page) =>
      page.map((line) => `${line.align} ${line.x},${line.y} ${line.text}`),
    );
    expect(rendered).toEqual([
      ["center 160,120 Pinball Illusions"],
      ["center 160,104 Concept and Design by", "center 160,134 Digital Illusions"],
      ["center 160,104 Programming by", "center 160,134 Andreas Axelsson"],
      ["center 160,104 Graphics by", "center 160,134 Markus Nyström"],
      ["center 160,104 Music & Soundeffects by", "center 160,134 Olof Gustafsson"],
      ["center 160,104 Managing by", "center 160,134 Fredrik Liliegren"],
      ["center 160,104 Produced by", "center 160,134 Barry Simpson"],
      ["center 160,104 Additional Graphics by", "center 160,134 Patrik Bergdahl"],
      ["center 160,104 Intro Coding by", "center 160,134 Thomas Andersson"],
      ["center 160,104 Packing Algorithms by", "center 160,134 Stefan Boberg"],
      [
        "center 160,74 Game Testing by",
        "center 160,104 Digital Illusions",
        "center 160,134 &",
        "center 160,164 21st Century Entertainment",
      ],
      [
        "center 160,44 Thanx to (in no order)",
        "center 160,74 Lisa",
        "center 160,104 Nicho",
        "center 160,134 Skåning",
        "center 160,164 Tvilling",
        "center 160,194 Inga & Bosse",
      ],
    ]);
    // The y set is exactly the words in the data — no ladder reproduces it.
    const ys = new Set(ATTRACT_PAGES.flatMap((page) => page.map((line) => line.y)));
    expect([...ys].sort((a, b) => a - b)).toEqual([44, 74, 104, 120, 134, 164, 194]);
  });

  it("ships no HELP branch: the roll is the only thing reachable", () => {
    // The disk's page array is longer than the roll and the rest of it is
    // reached by holding HELP and typing a code word. The operator has decided
    // none of those pages ship, so there is no HELP key kind at all and no page
    // index outside 0..11 exists to reach. See ATTRACT_PAGES.
    const store = fakeStore();
    const state = createShell(store);
    for (let tick = 0; tick < ATTRACT_LAP_TICKS * 2; tick += 1) {
      shellTick(state, store, 1);
      expect(state.attractPage).toBeGreaterThanOrEqual(0);
      expect(state.attractPage).toBeLessThan(ATTRACT_ROLL_PAGES);
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
    // F5 stopped being "everything else" when the F-row grew to eight — the
    // in-game machine's player scan (main.seg00 +0x00446E) claims F1..F8, so
    // the first genuinely unmapped function key is now F9's row.
    expect(shellKeyFor({ code: "F12", key: "F12" })).toBeNull();
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

/**
 * The same flow, driven by fingers.
 *
 * The point of these cases is not that touch works — that is `touch-zones` —
 * but that touch changes NOTHING. Every key below is one `shellHitTest` or
 * `deckPlanFor` produced, fed down the identical `shellKey` path a keyboard
 * takes, and the assertion each time is that the state and the effects are the
 * ones the keyboard run produces. The shell state machine has no idea a
 * touchscreen exists, and if it ever acquires one, these fail.
 */
describe("the shell, driven entirely by touch", () => {
  /** The middle of a rectangle in the shell's page coordinates. */
  const middle = (rect: { x1: number; y1: number; x2: number; y2: number }) => ({
    x: (rect.x1 + rect.x2) / 2,
    y: (rect.y1 + rect.y2) / 2,
  });

  it("reaches a loading table from the credits roll with taps alone", () => {
    const store = fakeStore();
    const state = createShell(store);
    const effects: ShellEffect[] = [];
    const tap = (x: number, y: number): void => {
      for (const item of shellHitTest(state, x, y)) effects.push(...shellKey(state, store, item));
    };

    expect(state.phase).toBe("attract");
    tap(160, 128);
    expect(state.phase).toBe("menu");

    const tables = middle(MENU_RECTS[0]!);
    tap(tables.x, tables.y);
    expect(state.phase).toBe("select");

    // The second table, by tapping the name one row below the pinned entry.
    tap(SELECT_NAME_BOX.x1 + 4, SELECT_ROW_Y + SELECT_ROW_PITCH);
    expect(state.cursor).toBe(1);

    const name = middle(SELECT_NAME_BOX);
    tap(name.x, name.y);
    expect(state.phase).toBe("loading");
    expect(effects).toEqual([{ kind: "load-table", tableId: SHELL_TABLES[1]!.id }]);
  });

  it("produces exactly what the keyboard produces, key for key", () => {
    const byTouch = { store: fakeStore(), state: createShell(fakeStore()) };
    byTouch.state = createShell(byTouch.store);
    const byKey = { store: fakeStore(), state: createShell(fakeStore()) };
    byKey.state = createShell(byKey.store);

    const touched: ShellEffect[] = [];
    for (const [x, y] of [
      [160, 128],
      [middle(MENU_RECTS[0]!).x, middle(MENU_RECTS[0]!).y],
      [middle(SELECT_INFO_BOX).x, middle(SELECT_INFO_BOX).y],
    ] as const) {
      for (const item of shellHitTest(byTouch.state, x, y)) {
        touched.push(...shellKey(byTouch.state, byTouch.store, item));
      }
    }

    const typed = press(byKey.state, byKey.store, SPACE, SELECT, RIGHT, SELECT);

    expect(byTouch.state.phase).toBe("info");
    expect(byTouch.state.phase).toBe(byKey.state.phase);
    expect(byTouch.state.column).toBe(byKey.state.column);
    expect(byTouch.state.cursor).toBe(byKey.state.cursor);
    expect(touched).toEqual(typed);
  });

  it("navigates every menu from the deck, with no hit testing at all", () => {
    const store = fakeStore();
    const state = createShell(store);
    const deckTap = (slot: "left" | "up" | "down" | "right" | "action"): ShellEffect[] => {
      const binding = deckPlanFor(state.phase, false)[slot];
      if (binding.hidden || binding.key === null) return [];
      return shellKey(state, store, binding.key);
    };

    deckTap("action");
    expect(state.phase).toBe("menu");
    deckTap("action");
    expect(state.phase).toBe("select");
    deckTap("down");
    expect(state.cursor).toBe(1);
    deckTap("right");
    expect(state.column).toBe(1);
    deckTap("action");
    expect(state.phase).toBe("info");
    deckTap("action");
    expect(state.phase).toBe("select");
    const effects = deckTap("action");
    expect(state.phase).toBe("loading");
    expect(effects).toEqual([{ kind: "load-table", tableId: SHELL_TABLES[1]!.id }]);
  });

  it("quits the table from the deck's QUIT and only from it", () => {
    const quiet = intoPlay("babewatch");
    press(quiet.state, quiet.store, BACK);
    expect(quiet.state.phase).toBe("quit-confirm");

    // Every tap on the glass resumes; the shell never sees a 'Y' from one.
    for (const y of [40, 128, 220]) {
      for (const item of shellHitTest(quiet.state, 160, y)) {
        shellKey(quiet.state, quiet.store, item);
      }
      expect(quiet.state.phase).toBe("play");
      press(quiet.state, quiet.store, BACK);
    }

    const plan = deckPlanFor("quit-confirm", false);
    expect(plan.left.key).not.toBeNull();
    const resume = shellKey(quiet.state, quiet.store, plan.left.key!);
    expect(resume).toEqual([]);
    expect(quiet.state.phase).toBe("play");

    press(quiet.state, quiet.store, BACK);
    const left = shellKey(quiet.state, quiet.store, plan.right.key!);
    expect(left).toEqual([{ kind: "leave-table" }]);
    expect(quiet.state.phase).toBe("attract");
  });

  it("types and commits initials from the soft keyboard and the deck", () => {
    const { state, store } = intoPlay("law-n-justice");
    shellGameEnded(state, 2_000_000_000);
    shellTick(state, store, GAME_OVER_TICKS);
    shellTick(state, store, HIGHSCORE_FANFARE_TICKS);
    expect(state.phase).toBe("initials");

    // What `touch.ts` synthesises from an `input` event, character by character.
    press(state, store, key("text", "A"), key("text", "B"));
    expect(state.initials).toBe("AB");
    // What it synthesises from a backspace.
    press(state, store, key("erase"));
    expect(state.initials).toBe("A");

    // And the deck's OK, which is the floor: a player whose soft keyboard never
    // appears can still finish rather than being stuck on the card forever.
    const plan = deckPlanFor("initials", false);
    press(state, store, plan.right.key!);
    expect(state.phase).toBe("ladder");
    expect(store.saved.get("law-n-justice")?.map((entry) => entry.initials)).toContain("A");
  });

  it("starts a game from a tap on the table's own attract screen", () => {
    const { state, store } = intoPlay("extreme-sports");
    state.phase = "ladder";
    const effects: ShellEffect[] = [];
    for (const item of shellHitTest(state, 160, 128)) {
      effects.push(...shellKey(state, store, item));
    }
    expect(state.phase).toBe("play");
    expect(effects).toEqual([{ kind: "start-game", players: 1 }]);
  });
});

describe("the player count through the shell", () => {
  // The decoded split (research/MULTIPLAYER_DECODE.md §4): the SHELL machine's
  // F-keys pick tables; the IN-GAME machine's F1..F8, live on the table's own
  // attract, pick 1..8 PLAYERS (main.seg00 +0x00446E, `$dbc` := n, clamp 8).

  function intoLadder(tableId: TableId): { state: ShellState; store: ReturnType<typeof fakeStore> } {
    const fixture = intoPlay(tableId);
    shellGameEnded(fixture.state, 0); // no qualification: 0 beats nothing
    press(fixture.state, fixture.store, SELECT); // cut the card, run the check
    expect(fixture.state.phase).toBe("ladder");
    return fixture;
  }

  it("maps the whole F row: F1..F8 to indices 0..7", () => {
    for (let n = 1; n <= 8; n += 1) {
      const mapped = shellKeyFor({ code: `F${n}` });
      expect(mapped?.kind).toBe("table");
      expect(mapped?.index).toBe(n - 1);
    }
  });

  it("starts n players from the table attract on Fn", () => {
    const { state, store } = intoLadder("law-n-justice");
    const effects = press(state, store, key("table", null, 2)); // F3
    expect(state.phase).toBe("play");
    expect(state.players).toBe(3);
    expect(effects).toEqual([{ kind: "start-game", players: 3 }]);
  });

  it("clamps the ladder's F-keys at the machine's eight", () => {
    const { state, store } = intoLadder("law-n-justice");
    const effects = press(state, store, key("table", null, 7)); // F8
    expect(effects).toEqual([{ kind: "start-game", players: 8 }]);
  });

  it("keeps the selection sticky: ENTER restarts with the last chosen count", () => {
    const { state, store } = intoLadder("law-n-justice");
    press(state, store, key("table", null, 3)); // F4: four players
    shellGameEnded(state, [0, 0, 0, 0]);
    press(state, store, SELECT); // through the card to the ladder
    expect(state.phase).toBe("ladder");
    const effects = press(state, store, SELECT);
    expect(effects).toEqual([{ kind: "start-game", players: 4 }]);
  });

  it("still picks TABLES with the F keys in the shell's own menus", () => {
    const store = fakeStore();
    const state = createShell(store);
    // F5 in the attract names no table — three exist — and does nothing.
    expect(press(state, store, key("table", null, 4))).toEqual([]);
    expect(state.phase).toBe("attract");
    // F2 still boots BabeWatch, one player by default.
    const effects = press(state, store, key("table", null, 1));
    expect(effects).toEqual([{ kind: "load-table", tableId: "babewatch" }]);
    shellTableLoaded(state);
    expect(state.players).toBe(1);
  });

  it("shellSetPlayers clamps into 1..8 and shellPlayTable carries a requested count", () => {
    const store = fakeStore();
    const state = createShell(store);
    expect(shellSetPlayers(state, 12)).toBe(8);
    expect(shellSetPlayers(state, 0)).toBe(1);
    expect(shellSetPlayers(state, 2.5)).toBe(1);
    shellPlayTable(state, store, "babewatch", 5);
    expect(state.players).toBe(5);
    const effects = shellTableLoaded(state);
    expect(effects).toEqual([{ kind: "start-game", players: 5 }]);
  });
});

describe("the multi-player high-score walk", () => {
  // The original's state-2 loop (main.seg00 +0x00462E..+0x00484A): every
  // player IN ORDER, each qualifier through the fanfare and the name box,
  // inserted as the walk goes so a later player is placed against the ladder
  // an earlier one already moved.

  function type(state: ShellState, store: ScoreStore, initials: string): void {
    for (const character of initials) {
      shellKey(state, store, key("text", character));
    }
  }

  it("walks every qualifying player in order, naming each on the cards", () => {
    const { state, store } = intoPlay("law-n-justice");
    const top = state.ladder[0]?.score ?? 0;
    // Players 1 and 3 qualify — 3 against the ladder 1 already moved, so the
    // score must clear the factory table's upper slots too; player 2's zero
    // does not. (The factory ladder is the 20:10:5:2:1 ratio, so a score a
    // hair over the fifth slot stops qualifying the moment one insert shifts
    // the table — the sibling test below pins exactly that.)
    shellGameEnded(state, [top + 2_000_000, 0, top + 1_000_000]);
    press(state, store, SELECT); // cut the game-over card
    expect(state.phase).toBe("fanfare");
    expect(state.scoringPlayer).toBe(1);
    press(state, store, SELECT); // cut the fanfare
    expect(state.phase).toBe("initials");
    type(state, store, "ABC");
    // Player 2's zero is skipped; player 3 is next.
    expect(state.phase).toBe("fanfare");
    expect(state.scoringPlayer).toBe(3);
    press(state, store, SELECT);
    type(state, store, "DEF");
    expect(state.phase).toBe("ladder");
    // Both entries landed, higher score above.
    const initials = state.ladder.map((entry) => entry.initials);
    expect(initials).toContain("ABC");
    expect(initials).toContain("DEF");
    expect(initials.indexOf("ABC")).toBeLessThan(initials.indexOf("DEF"));
  });

  it("places a later player against the ladder an earlier one already moved", () => {
    const { state, store } = intoPlay("law-n-justice");
    const bar = state.ladder[HIGH_SCORE_SLOTS - 1]?.score ?? 0;
    // Both players beat only the fifth slot; the first player's entry then
    // occupies it, and the second must beat THE FIRST PLAYER'S score to get
    // in — it does not, so exactly one name is written. The machine's walk
    // compares against the updated table the same way.
    shellGameEnded(state, [bar + 2, bar + 1]);
    press(state, store, SELECT);
    expect(state.scoringPlayer).toBe(1);
    press(state, store, SELECT);
    type(state, store, "AAB");
    expect(state.phase).toBe("ladder");
    expect(state.ladder.map((entry) => entry.initials)).toContain("AAB");
    expect(state.ladder.filter((entry) => entry.initials === "AAB")).toHaveLength(1);
  });

  it("one player is the walk of one: the exact flow the shell always had", () => {
    const { state, store } = intoPlay("babewatch");
    const bar = state.ladder[HIGH_SCORE_SLOTS - 1]?.score ?? 0;
    shellGameEnded(state, bar + 500_000); // the scalar form every old caller uses
    press(state, store, SELECT);
    expect(state.phase).toBe("fanfare");
    expect(state.scoringPlayer).toBe(1);
    press(state, store, SELECT);
    type(state, store, "JEZ");
    expect(state.phase).toBe("ladder");
    expect(state.ladder.map((entry) => entry.initials)).toContain("JEZ");
  });

  it("no qualifier among four players drops straight to the ladder", () => {
    const { state, store } = intoPlay("extreme-sports");
    shellGameEnded(state, [0, 0, 0, 0]);
    press(state, store, SELECT);
    expect(state.phase).toBe("ladder");
  });
});
