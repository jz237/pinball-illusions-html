/**
 * The front door: the HTML title screen of the Fantasies-parity round.
 *
 * Driven against the shipped `index.html` through `tests/dom-harness.ts` —
 * the fixture is built FROM the markup, so a renamed attribute fails here
 * rather than silently unhooking a card. What is pinned:
 *
 *  - the three cards exist, in table order, with `?table=` boot hrefs;
 *  - the card data is the SAME data the decoded screens print — names and
 *    blurbs from SHELL_TABLES, champion lines from the local five-slot
 *    ladder — not a second copy that can drift;
 *  - a card click books the table through the host (the decoded F-key path)
 *    and never navigates;
 *  - the idle handoff: thirty seconds without activity yields the screen to
 *    the canvas attract, activity brings the door back, and a running game
 *    puts the page in game mode with the table's name on the bar;
 *  - the key legend names the NEW primary bindings;
 *  - the shipped thumbnails match their manifests' digests byte for byte,
 *    and every manifest declares the gated class the build guard checks.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createTouchHarness, readDoorMarkup } from "./dom-harness.js";
import type { TouchHarness } from "./dom-harness.js";
import {
  ATTRACT_IDLE_MS,
  attachFrontDoor,
  championLine,
  doorThumbUrl,
} from "../src/browser/front-door.js";
import type { FrontDoor, FrontDoorHost } from "../src/browser/front-door.js";
import { SHELL_TABLES } from "../src/browser/shell.js";
import { FACTORY_HIGH_SCORES } from "../src/game/high-scores.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableId } from "../src/game/contracts.js";

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

interface Fixture {
  readonly h: TouchHarness;
  door: FrontDoor;
  readonly played: TableId[];
  gestures: number;
}

let open: TouchHarness | null = null;
let attached: FrontDoor | null = null;

function fixture(host: Partial<FrontDoorHost> = {}): Fixture {
  const h = createTouchHarness();
  open = h;
  const played: TableId[] = [];
  const record: Fixture = { h, door: null as unknown as FrontDoor, played, gestures: 0 };
  const door = attachFrontDoor(h.door as unknown as HTMLElement, {
    playTable: (tableId) => played.push(tableId),
    ladder: () => FACTORY_HIGH_SCORES,
    gesture: () => {
      record.gestures += 1;
    },
    version: () => "v9.9.9-test",
    ...host,
  });
  attached = door;
  record.door = door;
  return record;
}

afterEach(() => {
  attached?.detach();
  attached = null;
  open?.dispose();
  open = null;
});

function span(h: TouchHarness, attribute: string, tableId: string): string {
  const element = h.door.querySelector(`[${attribute}="${tableId}"]`);
  if (element === null) throw new Error(`no ${attribute} slot for ${tableId}`);
  return element.textContent;
}

// ---------------------------------------------------------------------------
// The shipped markup
// ---------------------------------------------------------------------------

describe("the shipped door markup", () => {
  it("carries one card per table, in table order, with ?table= boot links", () => {
    const markup = readDoorMarkup();
    expect(markup.cards).toEqual([...TABLE_IDS]);
    expect(markup.names).toEqual([...TABLE_IDS]);
    expect(markup.blurbs).toEqual([...TABLE_IDS]);
    expect(markup.champs).toEqual([...TABLE_IDS]);
    expect(markup.thumbs).toEqual([...TABLE_IDS]);
    for (const [tableId, href] of markup.hrefs) {
      expect(href).toBe(`?table=${tableId}`);
    }
    expect(markup.hasVersion).toBe(true);
    expect(markup.hasBarTitle).toBe(true);
  });

  it("prints the NEW key legend: Fantasies primary, the round's own words", () => {
    const legend = readDoorMarkup().keyLegend;
    expect(legend).toContain("Z/← left flipper");
    expect(legend).toContain("//→ right flipper");
    expect(legend).toContain("Space launch");
    expect(legend).toContain("X/↑ nudge");
    expect(legend).toContain("A/; upper flipper");
    expect(legend).toContain("F1–F3 tables");
    expect(legend).toContain("F9 view");
  });
});

// ---------------------------------------------------------------------------
// The card data
// ---------------------------------------------------------------------------

describe("the card data", () => {
  it("fills names and blurbs from SHELL_TABLES, the decoded screens' own records", () => {
    const { h } = fixture();
    for (const table of SHELL_TABLES) {
      expect(span(h, "data-door-name", table.id)).toBe(table.name);
      expect(span(h, "data-door-blurb", table.id)).toBe(table.blurb.join(" "));
    }
  });

  it("prints the champion line from the ladder's top slot", () => {
    const { h } = fixture();
    // The factory ladder's champion, exactly as high-scores.ts ships it.
    expect(span(h, "data-door-champ", "law-n-justice")).toBe("★ AXL · 1,000,000,000");
    expect(championLine([])).toBe("No score yet");
    expect(championLine([{ initials: "JEZ", score: 12_345 }])).toBe("★ JEZ · 12,345");
  });

  it("points every thumbnail at the gated shell asset", () => {
    const { h } = fixture();
    for (const tableId of TABLE_IDS) {
      const img = h.door.querySelector(`[data-door-thumb="${tableId}"]`);
      expect(img?.getAttribute("src")).toBe(doorThumbUrl(tableId));
      expect(doorThumbUrl(tableId)).toBe(`generated/shell/${tableId}-thumb.webp`);
    }
  });

  it("hides a thumbnail whose fetch fails, keeping the CSS placeholder", () => {
    const { h } = fixture();
    const img = h.door.querySelector('[data-door-thumb="babewatch"]');
    if (img === null) throw new Error("no babewatch thumb");
    expect(img.hidden).toBe(false);
    h.dispatch(img, "error");
    expect(img.hidden).toBe(true);
  });

  it("prints the version in the footer", () => {
    const { h } = fixture();
    const version = h.door.querySelector("[data-door-version]");
    expect(version?.textContent).toBe("v9.9.9-test");
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe("card navigation", () => {
  it("books the table through the host and never navigates", () => {
    const f = fixture();
    const card = f.h.door.querySelector('[data-door-table="extreme-sports"]');
    if (card === null) throw new Error("no extreme-sports card");
    const event = f.h.dispatch(card, "click");
    expect(f.played).toEqual(["extreme-sports"]);
    // preventDefault, or the href reloads the page out from under the click.
    expect(event.defaultPrevented).toBe(true);
    // The click is a gesture: the audio unlock rode it.
    expect(f.gestures).toBe(1);
  });

  it("each card books its own table", () => {
    const f = fixture();
    for (const tableId of TABLE_IDS) {
      const card = f.h.door.querySelector(`[data-door-table="${tableId}"]`);
      if (card === null) throw new Error(`no ${tableId} card`);
      f.h.dispatch(card, "click");
    }
    expect(f.played).toEqual([...TABLE_IDS]);
  });
});

// ---------------------------------------------------------------------------
// The idle handoff and the three-way mode
// ---------------------------------------------------------------------------

describe("the idle attract handoff", () => {
  it("shows the door on the attract phase, and yields it after the idle window", () => {
    const { h, door } = fixture();
    door.refresh("attract", null, 1_000);
    expect(door.showing()).toBe(true);
    expect(door.idling()).toBe(false);
    expect(h.door.hidden).toBe(false);
    expect(h.root.dataset["doorMode"]).toBe("door");

    // A frame just inside the window keeps the door.
    door.refresh("attract", null, 1_000 + ATTRACT_IDLE_MS - 1);
    expect(door.showing()).toBe(true);

    // The window elapses: the decoded credits attract takes the screen.
    door.refresh("attract", null, 1_000 + ATTRACT_IDLE_MS);
    expect(door.showing()).toBe(false);
    expect(door.idling()).toBe(true);
    expect(h.door.hidden).toBe(true);
    expect(h.root.dataset["doorMode"]).toBe("canvas");
  });

  it("comes back on activity", () => {
    const { h, door } = fixture();
    door.refresh("attract", null, 0);
    door.refresh("attract", null, ATTRACT_IDLE_MS);
    expect(door.idling()).toBe(true);

    door.noteActivity(ATTRACT_IDLE_MS + 500);
    door.refresh("attract", null, ATTRACT_IDLE_MS + 500);
    expect(door.showing()).toBe(true);
    expect(h.root.dataset["doorMode"]).toBe("door");
  });

  it("cedes the canvas to the decoded menus without idling", () => {
    const { h, door } = fixture();
    door.refresh("attract", null, 0);
    expect(door.showing()).toBe(true);
    // SPACE opened the decoded menu: the canvas owns the screen at once.
    door.refresh("menu", null, 100);
    expect(door.showing()).toBe(false);
    expect(door.idling()).toBe(false);
    expect(h.root.dataset["doorMode"]).toBe("canvas");
    // Walking back to attract brings the door straight back — the menu visit
    // was activity, so the idle window restarts rather than instantly firing.
    door.refresh("attract", null, 200);
    expect(door.showing()).toBe(true);
  });

  it("marks game mode over a table and names it on the bar", () => {
    const { h, door } = fixture();
    door.refresh("play", "babewatch", 0);
    expect(h.root.dataset["doorMode"]).toBe("game");
    expect(h.door.hidden).toBe(true);
    const title = h.document.querySelector("[data-bar-title]");
    expect(title?.textContent).toBe("BabeWatch");

    // Leaving the table clears the title and reopens the door.
    door.refresh("attract", null, 100);
    expect(h.root.dataset["doorMode"]).toBe("door");
    expect(title?.textContent).toBe("");
  });

  it("keeps the quit-confirm and score screens in game mode", () => {
    const { h, door } = fixture();
    for (const phase of ["quit-confirm", "game-over", "fanfare", "initials", "ladder", "loading"] as const) {
      door.refresh(phase, "law-n-justice", 0);
      expect(h.root.dataset["doorMode"]).toBe("game");
    }
  });
});

// ---------------------------------------------------------------------------
// The shipped thumbnails
// ---------------------------------------------------------------------------

describe("the shipped thumbnails", () => {
  const SHELL_DIR = fileURLToPath(new URL("../public/generated/shell/", import.meta.url));

  for (const tableId of TABLE_IDS) {
    it(`${tableId}: the webp matches its manifest's digest and gated class`, () => {
      const manifest = JSON.parse(
        readFileSync(`${SHELL_DIR}${tableId}-thumb.json`, "utf8"),
      ) as {
        tableId: string;
        image: { file: string; sha256: string; byteLength: number };
        provenance: { sourceClass: string };
      };
      expect(manifest.tableId).toBe(tableId);
      expect(manifest.image.file).toBe(`${tableId}-thumb.webp`);
      // The class the build guard gates and claims through its single-image
      // branch; a manifest without it would ship an unclaimed raster.
      expect(manifest.provenance.sourceClass).toBe("disk-derived-table-thumbnail");

      const bytes = readFileSync(`${SHELL_DIR}${manifest.image.file}`);
      expect(bytes.length).toBe(manifest.image.byteLength);
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest).toBe(manifest.image.sha256);
      // And it really is a WebP, not a renamed something else.
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
    });
  }
});
