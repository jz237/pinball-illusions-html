/**
 * The global-scores client: the shared site-wide worker's adapter.
 *
 * Everything here drives a FAKE fetch — no test in this suite may ever reach
 * the real worker, because a POST to a production key is permanent (the
 * worker has no delete API; a sibling abandoned a whole board slug over test
 * pollution). The garbage the normalizer is fed below is not invented: every
 * shape — score-0 rows, duplicate bot floods, unsorted bodies, limit-ignored
 * 39-row responses — was observed live on sibling boards on 2026-08-16.
 *
 * The KEY PIN is the one that looks paranoid and is not: the worker answers
 * `200 []` for ANY key, so a typo'd key would not fail — it would quietly
 * start a second, invisible board, forever. These three strings are the
 * production boards, verbatim, and nothing else may mint them.
 */

import { describe, expect, it } from "vitest";

import {
  GLOBAL_SCORES_BASE_URL,
  GLOBAL_SCORE_KEY_PREFIX,
  GLOBAL_TOP_LIMIT,
  createGlobalScores,
  globalChampionLine,
  globalScoreKey,
  normalizeGlobalInitials,
  normalizeGlobalRows,
} from "../src/browser/global-scores.js";
import type {
  GlobalScoresFetch,
  GlobalScoresRequestInit,
  GlobalScoresResponseLike,
} from "../src/browser/global-scores.js";
import { MAX_BCD_SCORE } from "../src/game/high-scores.js";
import { TABLE_IDS } from "../src/game/contracts.js";

// ---------------------------------------------------------------------------
// THE PRODUCTION KEYS, pinned verbatim
// ---------------------------------------------------------------------------

describe("the production board keys", () => {
  it("are exactly the three shipped strings — a typo is an invisible split board", () => {
    expect(TABLE_IDS.map((tableId) => globalScoreKey(tableId))).toEqual([
      "pinball-illusions-law-n-justice",
      "pinball-illusions-babewatch",
      "pinball-illusions-extreme-sports",
    ]);
  });

  it("derive from the shell's own table ids under the one shipped prefix", () => {
    expect(GLOBAL_SCORE_KEY_PREFIX).toBe("pinball-illusions-");
    for (const tableId of TABLE_IDS) {
      expect(globalScoreKey(tableId)).toBe(`${GLOBAL_SCORE_KEY_PREFIX}${tableId}`);
    }
  });

  it("aim at the shared worker every sibling uses", () => {
    expect(GLOBAL_SCORES_BASE_URL).toBe("https://game-scores.jez237.workers.dev/scores");
  });
});

// ---------------------------------------------------------------------------
// The normalizer, against the garbage the live boards actually carry
// ---------------------------------------------------------------------------

describe("normalizeGlobalRows", () => {
  it("drops non-finite, zero and negative scores — all observed live", () => {
    const rows = normalizeGlobalRows([
      { initials: "AAA", score: Number.NaN },
      { initials: "BBB", score: Number.POSITIVE_INFINITY },
      { initials: "CCC", score: "not a number" },
      { initials: "DDD", score: 0 },
      { initials: "EEE", score: -500 },
      { initials: "JEZ", score: 1_000 },
    ]);
    expect(rows).toEqual([{ initials: "JEZ", score: 1_000 }]);
  });

  it("drops scores past MAX_BCD_SCORE, which no game of this machine can produce", () => {
    const rows = normalizeGlobalRows([
      { initials: "BOT", score: MAX_BCD_SCORE + 1 },
      { initials: "TOP", score: MAX_BCD_SCORE },
    ]);
    expect(rows).toEqual([{ initials: "TOP", score: MAX_BCD_SCORE }]);
  });

  it("sorts descending and slices to the top ten itself — the worker ignores ?limit=", () => {
    // A 39-duplicate flood is the live shape of the lumen-td board.
    const flood = Array.from({ length: 39 }, (_, index) => ({
      initials: "BOT",
      score: 100 + (index % 3),
    }));
    const rows = normalizeGlobalRows([{ initials: "JEZ", score: 50 }, ...flood]);
    expect(rows).toHaveLength(GLOBAL_TOP_LIMIT);
    expect(rows[0]?.score).toBe(102);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index]!.score).toBeLessThanOrEqual(rows[index - 1]!.score);
    }
    // JEZ's 50 is below the flood's floor and outside the ten.
    expect(rows.some((row) => row.initials === "JEZ")).toBe(false);
  });

  it("clamps initials to the boards' three-character A-Z0-9 alphabet", () => {
    const rows = normalizeGlobalRows([
      { initials: "jez", score: 5 },
      { initials: "A B C D", score: 4 },
      { initials: 123, score: 3 },
      { initials: "!!!", score: 2 },
      { score: 1 },
    ]);
    expect(rows.map((row) => row.initials)).toEqual(["JEZ", "ABC", "123", "---", "---"]);
  });

  it("returns nothing for every non-array payload rather than throwing", () => {
    for (const payload of [null, undefined, 42, "[]", { scores: [{ initials: "X", score: 1 }] }, {}]) {
      expect(normalizeGlobalRows(payload)).toEqual([]);
    }
    expect(normalizeGlobalRows(["junk", null, 7])).toEqual([]);
  });
});

describe("normalizeGlobalInitials", () => {
  it("uppercases, strips the non-alphabet, and caps at three", () => {
    expect(normalizeGlobalInitials("jez")).toBe("JEZ");
    expect(normalizeGlobalInitials(" a-b-c-d ")).toBe("ABC");
    expect(normalizeGlobalInitials("★★★")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The door's line
// ---------------------------------------------------------------------------

describe("globalChampionLine", () => {
  it("prints the champion in the Fantasies card manner", () => {
    expect(globalChampionLine("ready", [{ initials: "JEZ", score: 20_088_580 }])).toBe(
      "Global ★ JEZ · 20,088,580",
    );
  });

  it("invites on a truly empty board, and shows NOTHING while unknown or offline", () => {
    expect(globalChampionLine("ready", [])).toBe("No global score yet");
    expect(globalChampionLine("idle", [])).toBe("");
    expect(globalChampionLine("loading", [])).toBe("");
    expect(globalChampionLine("offline", [])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The client, over a fake fetch
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly url: string;
  readonly init: GlobalScoresRequestInit;
}

function fakeFetch(
  respond: (url: string, init: GlobalScoresRequestInit) => Promise<GlobalScoresResponseLike>,
): GlobalScoresFetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (url: string, init: GlobalScoresRequestInit): Promise<GlobalScoresResponseLike> => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return Object.assign(impl, { calls });
}

function okJson(payload: unknown): Promise<GlobalScoresResponseLike> {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
}

describe("fetchTop", () => {
  it("GETs the table's own key with no-store, and normalizes what comes back", async () => {
    const fetch = fakeFetch(() => okJson([{ initials: "abc", score: 2 }, { initials: "DEF", score: 9 }]));
    const client = createGlobalScores(fetch);
    const rows = await client.fetchTop("babewatch");
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe(
      "https://game-scores.jez237.workers.dev/scores/pinball-illusions-babewatch",
    );
    expect(fetch.calls[0]?.init.method).toBe("GET");
    expect(fetch.calls[0]?.init.cache).toBe("no-store");
    expect(rows).toEqual([
      { initials: "DEF", score: 9 },
      { initials: "ABC", score: 2 },
    ]);
    expect(client.status("babewatch")).toBe("ready");
  });

  it("caches per table, coalesces concurrent calls, and refetches on force", async () => {
    const fetch = fakeFetch(() => okJson([]));
    const client = createGlobalScores(fetch);
    const [first, second] = await Promise.all([
      client.fetchTop("law-n-justice"),
      client.fetchTop("law-n-justice"),
    ]);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(fetch.calls).toHaveLength(1); // coalesced
    await client.fetchTop("law-n-justice");
    expect(fetch.calls).toHaveLength(1); // cached
    await client.fetchTop("extreme-sports");
    expect(fetch.calls).toHaveLength(2); // a different table is a different board
    await client.fetchTop("law-n-justice", true);
    expect(fetch.calls).toHaveLength(3); // forced
  });

  it("swallows a rejection into offline and keeps whatever it last had", async () => {
    let fail = false;
    const fetch = fakeFetch(() =>
      fail ? Promise.reject(new Error("down")) : okJson([{ initials: "JEZ", score: 7 }]),
    );
    const client = createGlobalScores(fetch);
    await client.fetchTop("babewatch");
    fail = true;
    const rows = await client.fetchTop("babewatch", true);
    expect(rows).toEqual([{ initials: "JEZ", score: 7 }]); // the cache survives
    expect(client.status("babewatch")).toBe("offline");
  });

  it("treats a non-ok response as offline, with no rows invented", async () => {
    const fetch = fakeFetch(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve([]) }),
    );
    const client = createGlobalScores(fetch);
    expect(await client.fetchTop("extreme-sports")).toEqual([]);
    expect(client.status("extreme-sports")).toBe("offline");
  });

  it("a runtime with no fetch at all is simply an offline board", async () => {
    // The global fetch is hidden for the duration, so the un-injected client
    // finds nothing — and must degrade to offline, never throw. (No real
    // request can leave this suite either way.)
    const globals = globalThis as { fetch?: typeof fetch };
    const held = globals.fetch;
    delete globals.fetch;
    try {
      const bare = createGlobalScores();
      const rows = await bare.fetchTop("babewatch");
      expect(rows).toEqual([]);
      expect(bare.status("babewatch")).toBe("offline");
    } finally {
      if (held !== undefined) globals.fetch = held;
    }
  });
});

describe("submit", () => {
  it("POSTs one {initials, score} row — and nothing else — to the table's own key", async () => {
    const fetch = fakeFetch(() => okJson({}));
    const client = createGlobalScores(fetch);
    const sent = await client.submit("law-n-justice", "JEZ", 123_456);
    expect(sent).toBe(true);
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    expect(call.url).toBe(
      "https://game-scores.jez237.workers.dev/scores/pinball-illusions-law-n-justice",
    );
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({ "Content-Type": "application/json" });
    // The worker persists only {initials, score, ts}; extra fields would be
    // a silent lie, so the body carries exactly the two.
    expect(JSON.parse(call.init.body ?? "")).toEqual({ initials: "JEZ", score: 123_456 });
  });

  it("normalizes initials and rounds the score on the way out", async () => {
    const fetch = fakeFetch(() => okJson({}));
    const client = createGlobalScores(fetch);
    await client.submit("babewatch", "a b", 999.6);
    expect(JSON.parse(fetch.calls[0]?.init.body ?? "")).toEqual({ initials: "AB", score: 1000 });
  });

  it("refuses garbage without touching the network at all", async () => {
    const fetch = fakeFetch(() => okJson({}));
    const client = createGlobalScores(fetch);
    expect(await client.submit("babewatch", "", 100)).toBe(false);
    expect(await client.submit("babewatch", "★", 100)).toBe(false);
    expect(await client.submit("babewatch", "JEZ", 0)).toBe(false);
    expect(await client.submit("babewatch", "JEZ", -5)).toBe(false);
    expect(await client.submit("babewatch", "JEZ", Number.NaN)).toBe(false);
    expect(await client.submit("babewatch", "JEZ", MAX_BCD_SCORE + 1)).toBe(false);
    expect(fetch.calls).toHaveLength(0);
  });

  it("resolves false on rejection or a non-ok response — it never rejects", async () => {
    const dead = createGlobalScores(fakeFetch(() => Promise.reject(new Error("down"))));
    expect(await dead.submit("law-n-justice", "JEZ", 100)).toBe(false);
    expect(dead.status("law-n-justice")).toBe("offline");
    const refused = createGlobalScores(
      fakeFetch(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })),
    );
    expect(await refused.submit("law-n-justice", "JEZ", 100)).toBe(false);
  });

  it("fires exactly one POST even when the response never settles", () => {
    const fetch = fakeFetch(() => new Promise<GlobalScoresResponseLike>(() => undefined));
    const client = createGlobalScores(fetch);
    void client.submit("extreme-sports", "JEZ", 500);
    expect(fetch.calls).toHaveLength(1);
  });

  it("invalidates the table's cache on success, so the next door visit refetches", async () => {
    let board: unknown = [];
    const fetch = fakeFetch((_url, init) =>
      init.method === "GET" ? okJson(board) : okJson({}),
    );
    const client = createGlobalScores(fetch);
    expect(await client.fetchTop("babewatch")).toEqual([]);
    board = [{ initials: "JEZ", score: 9 }];
    await client.submit("babewatch", "JEZ", 9);
    expect(await client.fetchTop("babewatch")).toEqual([{ initials: "JEZ", score: 9 }]);
    // GET, POST, GET: the second GET happened because the submit dropped the cache.
    expect(fetch.calls.map((call) => call.init.method)).toEqual(["GET", "POST", "GET"]);
  });
});

describe("topLine", () => {
  it("is empty before anything is known, the champion once fetched, the invitation when empty", async () => {
    const fetch = fakeFetch((url) =>
      url.endsWith("pinball-illusions-babewatch")
        ? okJson([{ initials: "JEZ", score: 12_345 }])
        : okJson([]),
    );
    const client = createGlobalScores(fetch);
    expect(client.topLine("babewatch")).toBe("");
    await client.fetchTop("babewatch");
    await client.fetchTop("law-n-justice");
    expect(client.topLine("babewatch")).toBe("Global ★ JEZ · 12,345");
    expect(client.topLine("law-n-justice")).toBe("No global score yet");
  });

  it("shows nothing — never an error — when the worker is down", async () => {
    const client = createGlobalScores(fakeFetch(() => Promise.reject(new Error("down"))));
    await client.fetchTop("extreme-sports");
    expect(client.topLine("extreme-sports")).toBe("");
  });
});
