import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FACTORY_HIGH_SCORES,
  HIGH_SCORE_SLOTS,
  SCORE_BCD_BYTES,
  decodeBcd,
  encodeBcd,
  factoryLadder,
  insertScore,
  loadHighScores,
  parseScoreFile,
  placeFor,
  qualifies,
  saveHighScores,
  writeScoreFile,
} from "../src/game/high-scores.js";
import type { HighScoreEntry } from "../src/game/high-scores.js";

/**
 * The exact fifty bytes of the original's score file, as decoded from disk 1.
 * All three tables ship byte-identical copies of this.
 */
const ORIGINAL_SCORE_FILE = new Uint8Array([
  0x41, 0x58, 0x4c, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00,
  0x4d, 0x20, 0x4e, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00,
  0x4f, 0x52, 0x47, 0x00, 0x00, 0x02, 0x50, 0x00, 0x00, 0x00,
  0x46, 0x20, 0x4c, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x50, 0x20, 0x42, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00, 0x00,
]);

function fakeStorage(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("the original score file", () => {
  it("decodes to the factory ladder", () => {
    // This is the check that proves the BCD reading is right: arbitrary binary
    // would not yield five round numbers in descending order.
    const entries = parseScoreFile(ORIGINAL_SCORE_FILE);
    expect(entries.map((e) => e.score)).toEqual([
      1_000_000_000, 500_000_000, 250_000_000, 100_000_000, 50_000_000,
    ]);
  });

  it("has ratios of 20 : 10 : 5 : 2 : 1, which the stored digits fix exactly", () => {
    // The ratios hold whatever the true width of the score field is, so they are
    // the part of this reading that cannot be wrong. Asserted separately from the
    // absolute values for exactly that reason.
    const scores = parseScoreFile(ORIGINAL_SCORE_FILE).map((e) => e.score);
    const unit = scores[scores.length - 1] ?? 1;
    expect(scores.map((s) => s / unit)).toEqual([20, 10, 5, 2, 1]);
  });

  it("is strictly descending", () => {
    const scores = parseScoreFile(ORIGINAL_SCORE_FILE).map((e) => e.score);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]).toBeGreaterThan(scores[i] ?? Infinity);
    }
  });

  it("keeps interior spaces in initials but trims padding", () => {
    const entries = parseScoreFile(ORIGINAL_SCORE_FILE);
    expect(entries.map((e) => e.initials)).toEqual(["AXL", "M N", "ORG", "F L", "P B"]);
  });

  it("matches the constant the game ships with", () => {
    expect(parseScoreFile(ORIGINAL_SCORE_FILE)).toEqual([...FACTORY_HIGH_SCORES]);
  });

  it("round-trips back to the exact original bytes", () => {
    expect(writeScoreFile(parseScoreFile(ORIGINAL_SCORE_FILE))).toEqual(ORIGINAL_SCORE_FILE);
  });

  it("rejects a file that is not fifty bytes", () => {
    expect(() => parseScoreFile(new Uint8Array(49))).toThrow(RangeError);
    expect(() => parseScoreFile(new Uint8Array(51))).toThrow(RangeError);
  });

  it("agrees with the real files still on disk, when they are present", () => {
    // Reads the operator's local research copies if they exist, so the fixture
    // above can never silently drift from the actual disk contents. The research
    // tree is the repo's sibling (`../../research`), so this is resolved relative
    // to this file rather than through an absolute machine path. Skipped on any
    // machine without them rather than failing.
    for (const table of [1, 2, 3]) {
      const path = new URL(`../../research/meta/score00${table}.bin`, import.meta.url);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(path));
      } catch {
        continue;
      }
      expect(bytes).toEqual(ORIGINAL_SCORE_FILE);
    }
  });
});

describe("packed BCD", () => {
  it("reads each nibble as a decimal digit", () => {
    expect(decodeBcd(new Uint8Array([0x12, 0x34]), 0, 2)).toBe(1234);
    expect(decodeBcd(new Uint8Array([0x00, 0x00]), 0, 2)).toBe(0);
    expect(decodeBcd(new Uint8Array([0x99, 0x99]), 0, 2)).toBe(9999);
  });

  it("rejects a nibble that is not a decimal digit", () => {
    expect(() => decodeBcd(new Uint8Array([0xab]), 0, 1)).toThrow(RangeError);
    expect(() => decodeBcd(new Uint8Array([0x1f]), 0, 1)).toThrow(RangeError);
  });

  it("round-trips every factory score", () => {
    for (const entry of FACTORY_HIGH_SCORES) {
      const encoded = encodeBcd(entry.score, SCORE_BCD_BYTES);
      expect(decodeBcd(encoded, 0, SCORE_BCD_BYTES)).toBe(entry.score);
    }
  });

  it("refuses a score too large for the field instead of truncating", () => {
    expect(() => encodeBcd(1234, 1)).toThrow(RangeError);
    expect(() => encodeBcd(-1, SCORE_BCD_BYTES)).toThrow(RangeError);
  });

  it("reads past the end as an error rather than NaN", () => {
    expect(() => decodeBcd(new Uint8Array([0x12]), 0, 4)).toThrow(RangeError);
  });
});

describe("the ladder", () => {
  const ladder = (): HighScoreEntry[] => factoryLadder();

  // Expressed relative to the factory ladder rather than in absolute figures.
  // The score field's true width is not fully settled — the trailing bytes are
  // all zero, so four, five or seven BCD bytes all read the same digits — and
  // ladder behaviour has nothing to do with the magnitude anyway. Anchoring to
  // TOP and BOTTOM means a later correction to the field width cannot turn
  // these into false failures.
  const TOP = FACTORY_HIGH_SCORES[0]?.score ?? 0;
  const BOTTOM = FACTORY_HIGH_SCORES[HIGH_SCORE_SLOTS - 1]?.score ?? 0;
  const SECOND = FACTORY_HIGH_SCORES[1]?.score ?? 0;
  const THIRD = FACTORY_HIGH_SCORES[2]?.score ?? 0;

  it("takes a score that beats the lowest place", () => {
    expect(qualifies(ladder(), BOTTOM + 1)).toBe(true);
    expect(qualifies(ladder(), BOTTOM)).toBe(false);
    expect(qualifies(ladder(), 0)).toBe(false);
  });

  it("puts a new best at the top and drops the last place", () => {
    const next = insertScore(ladder(), "ZZZ", TOP * 2);
    expect(next).toHaveLength(HIGH_SCORE_SLOTS);
    expect(next[0]).toEqual({ initials: "ZZZ", score: TOP * 2 });
    expect(next.map((e) => e.score)).not.toContain(BOTTOM);
  });

  it("places a middling score in the middle", () => {
    // Between the second and third factory places, so it must land at index 2.
    const middling = Math.floor((SECOND + THIRD) / 2);
    expect(placeFor(ladder(), middling)).toBe(2);
    const next = insertScore(ladder(), "MID", middling);
    expect(next[2]).toEqual({ initials: "MID", score: middling });
    expect(next.map((e) => e.score)).toEqual([TOP, SECOND, middling, THIRD, FACTORY_HIGH_SCORES[3]?.score]);
  });

  it("ranks an equal score below the incumbent, so ties go to whoever was first", () => {
    const next = insertScore(ladder(), "TIE", SECOND);
    expect(next[1]?.initials).toBe(FACTORY_HIGH_SCORES[1]?.initials);
    expect(next[2]?.initials).toBe("TIE");
  });

  it("leaves the ladder untouched when the score does not qualify", () => {
    const before = ladder();
    expect(insertScore(before, "LOW", 1_000)).toEqual(before);
    expect(placeFor(before, 1_000)).toBe(-1);
  });

  it("normalises initials to three upper-case characters", () => {
    const next = insertScore(ladder(), "ab", TOP * 2);
    expect(next[0]?.initials).toBe("AB");
    const long = insertScore(ladder(), "TOOLONG", TOP * 2);
    expect(long[0]?.initials).toHaveLength(3);
  });

  it("never grows past the slot count, however many are inserted", () => {
    let entries = ladder();
    for (let i = 0; i < 20; i += 1) entries = insertScore(entries, "AAA", TOP * 2 + i);
    expect(entries).toHaveLength(HIGH_SCORE_SLOTS);
  });

  it("hands out a copy, so the frozen factory ladder cannot be mutated", () => {
    const first = factoryLadder();
    expect(() => {
      const entry = first[0];
      if (entry !== undefined) (entry as { score: number }).score = 1;
    }).not.toThrow();
    expect(factoryLadder()[0]?.score).toBe(TOP);
  });
});

describe("persistence", () => {
  it("starts from the factory ladder when nothing is saved", () => {
    expect(loadHighScores("law-n-justice", fakeStorage())).toEqual([...FACTORY_HIGH_SCORES]);
    expect(loadHighScores("law-n-justice", null)).toEqual([...FACTORY_HIGH_SCORES]);
  });

  it("round-trips a saved ladder", () => {
    const storage = fakeStorage();
    const saved = insertScore(factoryLadder(), "NEW", 12_000_000);
    saveHighScores("babewatch", saved, storage);
    expect(loadHighScores("babewatch", storage)).toEqual(saved);
  });

  it("keeps each table's ladder separate", () => {
    const storage = fakeStorage();
    saveHighScores("law-n-justice", insertScore(factoryLadder(), "AAA", 99_000_000), storage);
    expect(loadHighScores("babewatch", storage)).toEqual([...FACTORY_HIGH_SCORES]);
  });

  it("falls back to factory rather than throwing on corrupt data", () => {
    const storage = fakeStorage();
    storage.map.set("pinball-illusions/high-scores/law-n-justice", "{not json");
    expect(loadHighScores("law-n-justice", storage)).toEqual([...FACTORY_HIGH_SCORES]);
    storage.map.set("pinball-illusions/high-scores/law-n-justice", '{"nope":1}');
    expect(loadHighScores("law-n-justice", storage)).toEqual([...FACTORY_HIGH_SCORES]);
  });

  it("survives storage that refuses to write", () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => saveHighScores("extreme-sports", factoryLadder(), hostile)).not.toThrow();
  });
});
