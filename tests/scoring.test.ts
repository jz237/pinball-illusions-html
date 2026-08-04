/**
 * Scoring: the packed-BCD arithmetic, and the three debounces that decide
 * whether a touch is worth anything.
 */

import { describe, expect, it } from "vitest";
import type { PlayfieldLevel } from "../src/game/contracts.js";
import { decodeBcd, encodeBcd } from "../src/game/high-scores.js";
import {
  HIT_TIMER_FRAMES,
  MAX_PLAYER_SCORE,
  PLAYER_BCD_BYTES,
  UNDEBOUNCED_DEVICE_INDEX,
  addPackedBcd,
  addToBcdField,
  applyAward,
  clearScoringFlags,
  createScoringState,
  formatBcdField,
  isPoweredSurfaceId,
  newBcdField,
  readBcdField,
  resetScoringForNewBall,
  scoreLock,
  scoreSurfaces,
  scoreZones,
  tickScoring,
  zoneKey,
} from "../src/game/scoring.js";
import type { ScoringState } from "../src/game/scoring.js";
import {
  GROUP_FLASH_FRAMES,
  createModeState,
  groupBackedFlagIds,
  lightGroupLampsForTrigger,
  tickModes,
} from "../src/game/mode-vm.js";
import type { TableDevices } from "../src/game/table-devices.js";
import { devicesFor, modesFor } from "./table-fixtures.js";

const LAW = devicesFor("law-n-justice");
const BABEWATCH = devicesFor("babewatch");

function ball(id: number, x: number, y: number, level: PlayfieldLevel = 0) {
  return { id, level, x, y };
}

/** Runs the whole tick's award pass and returns the awards, applying them. */
function tick(
  state: ScoringState,
  devices: TableDevices,
  surfaces: readonly number[],
  balls: readonly { id: number; level: PlayfieldLevel; x: number; y: number }[] = [],
) {
  tickScoring(state);
  const awards = [
    ...scoreSurfaces(state, devices, 0, surfaces),
    ...scoreZones(state, devices, balls),
  ];
  for (const award of awards) applyAward(state, award);
  return awards;
}

describe("packed BCD, as the ABCD chain does it", () => {
  it("is six bytes, twelve digits, like the player record", () => {
    expect(PLAYER_BCD_BYTES).toBe(6);
    expect(newBcdField()).toHaveLength(6);
    expect(MAX_PLAYER_SCORE).toBe(999_999_999_999);
  });

  it("adds with decimal carry across every nibble", () => {
    const field = newBcdField();
    addToBcdField(field, 999_999);
    addToBcdField(field, 1);
    expect(readBcdField(field)).toBe(1_000_000);
    // And the stored bytes really are digits, not a binary number.
    // Twelve digits, most significant byte first: 00 00 01 00 00 00.
    expect([...field]).toEqual([0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
  });

  it("keeps the digits displayed the digits stored", () => {
    const field = newBcdField();
    addToBcdField(field, 250_000);
    addToBcdField(field, 500_000);
    expect(decodeBcd(field, 0, 6)).toBe(750_000);
    expect(formatBcdField(field)).toBe("750,000");
  });

  it("wraps at twelve digits and says that it did, as the sixth ABCD does", () => {
    // The original has nowhere to put the carry either: the X flag out of the
    // last ABCD falls on the floor and a twelve-digit score rolls over.
    const field = encodeBcd(MAX_PLAYER_SCORE, 6);
    expect(addPackedBcd(field, encodeBcd(1, 6))).toBe(true);
    expect(readBcdField(field)).toBe(0);
    expect(addPackedBcd(newBcdField(), encodeBcd(1, 6))).toBe(false);
  });

  it("refuses a negative or fractional award rather than corrupting a field", () => {
    expect(() => addToBcdField(newBcdField(), -1)).toThrow(RangeError);
    expect(() => addToBcdField(newBcdField(), 1.5)).toThrow(RangeError);
    // Zero is a real award value — Extreme Sports' aeroplane wing is worth 0 —
    // and must be free rather than an error.
    expect(addToBcdField(newBcdField(), 0)).toBe(false);
  });

  it("survives a million random awards without leaving a non-decimal nibble", () => {
    const field = newBcdField();
    let expected = 0;
    let value = 12345;
    for (let i = 0; i < 20_000; i += 1) {
      value = (value * 1103515245 + 12345) % 2147483648;
      const award = value % 1_000_000;
      addToBcdField(field, award);
      expected = (expected + award) % 1_000_000_000_000;
    }
    expect(readBcdField(field)).toBe(expected);
  });
});

describe("surface awards", () => {
  it("scores a drop target once and then holds it off for six frames", () => {
    const state = createScoringState();
    expect(tick(state, LAW, [32]).map((a) => a.score)).toEqual([50000]);
    // The record has a flag byte, so the second hit is a REPEAT — and Law 'n
    // Justice's repeat field is zero, so a repeat is worth nothing.
    for (let frame = 1; frame < HIT_TIMER_FRAMES; frame += 1) {
      expect(tick(state, LAW, [32])).toEqual([]);
    }
    expect(tick(state, LAW, [32]).map((a) => a.repeat)).toEqual([true]);
    expect(readBcdField(state.score)).toBe(50000);
  });

  it("takes the repeat award where one is reachable", () => {
    // BabeWatch's top rollovers are the only records in the game whose repeat
    // field is both non-zero and reachable: 50,000 then 5,000 for ever after.
    const state = createScoringState();
    const rollover = BABEWATCH.zones.find((z) => z.repeatable && z.repeatScore > 0);
    expect(rollover).toBeDefined();
    if (rollover === undefined) return;
    const at = ball(0, rollover.minX + 1, rollover.minY + 1, rollover.level);

    expect(tick(state, BABEWATCH, [], [at]).map((a) => a.score)).toEqual([50000]);
    // Leave and come back: the occupancy debounce releases and it scores again.
    tick(state, BABEWATCH, [], []);
    expect(tick(state, BABEWATCH, [], [at]).map((a) => [a.score, a.repeat])).toEqual([[5000, true]]);
  });

  it("gives a device with no flag byte its first-hit award every single time", () => {
    // Extreme Sports' id 32 has no flag pointer, so `bset` never runs and the
    // repeat path is unreachable: 50,000 on every hit the timer lets through.
    const extreme = devicesFor("extreme-sports");
    const state = createScoringState();
    for (let hit = 0; hit < 3; hit += 1) {
      const awards = tick(state, extreme, [32]);
      expect(awards.map((a) => [a.score, a.repeat])).toEqual([[50000, false]]);
      for (let frame = 1; frame < HIT_TIMER_FRAMES; frame += 1) tick(state, extreme, []);
    }
    expect(readBcdField(state.score)).toBe(150000);
  });

  it("skips the debounce for a device index of 32 or more, as cmpi.w #$20 does", () => {
    // BabeWatch's kicker is surface id 64, array index 32. It scores nothing, so
    // the observable is that it is dispatched at all — which is what the index
    // exemption governs.
    expect(UNDEBOUNCED_DEVICE_INDEX).toBe(32);
    const kicker = BABEWATCH.deviceFor(0, 64);
    expect(kicker?.index).toBe(32);
    expect(kicker?.kind).toBe("kicker");
  });

  it("scores bumpers and slingshots, and debounces each FACE on its own", () => {
    const state = createScoringState();
    // Law 'n Justice bumper 1 is id 16, and its two neighbours are separate
    // devices with their own timers.
    expect(tick(state, LAW, [16, 17]).map((a) => a.score)).toEqual([50000, 50000]);
    expect(tick(state, LAW, [16, 17])).toEqual([]);
    // The two faces of slingshot 1 are ids 22 and 23 and share one score, but a
    // hit on one does not silence the other.
    const faces = tick(state, LAW, [22, 23]);
    expect(faces.map((a) => a.score)).toEqual([25000, 25000]);
    expect(faces.map((a) => a.source)).toEqual(["slingshot", "slingshot"]);
    expect(readBcdField(state.score)).toBe(150000);
  });

  it("ignores every id below the device base that is not powered", () => {
    const state = createScoringState();
    expect(tick(state, LAW, [0, 1, 4, 9, 10, 11, 13, 14, 15])).toEqual([]);
    expect(readBcdField(state.score)).toBe(0);
    expect(isPoweredSurfaceId(15)).toBe(false);
    expect(isPoweredSurfaceId(16)).toBe(true);
    expect(isPoweredSurfaceId(31)).toBe(true);
  });

  it("does not fire a device filed under the other level", () => {
    const state = createScoringState();
    tickScoring(state);
    expect(scoreSurfaces(state, BABEWATCH, 1, [41])).toEqual([]);
    expect(scoreSurfaces(state, BABEWATCH, 0, [41]).map((a) => a.score)).toEqual([75000]);
  });
});

describe("zone awards", () => {
  // The left outlane. Found by kind as well as by value, because Law 'n Justice
  // also has a LOCK worth 100,000 and it comes first in the list.
  const outlane = LAW.zones.find(
    (z) => z.level === 0 && z.kind === "trigger-b" && z.score === 100000,
  );

  it("scores a rectangle on entry and not once a tick", () => {
    expect(outlane).toBeDefined();
    if (outlane === undefined) return;
    const state = createScoringState();
    const at = ball(0, outlane.minX + 2, outlane.minY + 2);
    expect(tick(state, LAW, [], [at]).map((a) => a.score)).toEqual([100000]);
    expect(tick(state, LAW, [], [at])).toEqual([]);
    expect(tick(state, LAW, [], [at])).toEqual([]);
    expect(readBcdField(state.score)).toBe(100000);
  });

  it("does not let a second ball score a rectangle the first is sitting in", () => {
    // The engine's `+$00 = occupying ball id`, with its "0 means empty": one
    // ball at a time.
    expect(outlane).toBeDefined();
    if (outlane === undefined) return;
    const state = createScoringState();
    const one = ball(0, outlane.minX + 2, outlane.minY + 2);
    const two = ball(1, outlane.minX + 3, outlane.minY + 3);
    expect(tick(state, LAW, [], [one, two])).toHaveLength(1);
    expect(tick(state, LAW, [], [one, two])).toEqual([]);
    // And the order the balls happen to be scanned in must not change it: ball
    // one is still in the box, so ball two takes nothing whichever comes first.
    expect(tick(state, LAW, [], [two, one])).toEqual([]);
    // The first ball leaves; the second is now the occupant and scores.
    expect(tick(state, LAW, [], [two]).map((a) => a.score)).toEqual([100000]);
  });

  it("releases a rectangle when the ball in it drains", () => {
    expect(outlane).toBeDefined();
    if (outlane === undefined) return;
    const state = createScoringState();
    const at = ball(0, outlane.minX + 2, outlane.minY + 2);
    tick(state, LAW, [], [at]);
    tick(state, LAW, [], []);
    expect(state.occupants.has(zoneKey(outlane))).toBe(false);
    expect(tick(state, LAW, [], [at]).map((a) => a.score)).toEqual([100000]);
  });

  it("never awards a hand-off box, because routing is not scoring", () => {
    const state = createScoringState();
    for (const zone of LAW.zones) {
      if (zone.kind !== "to-upper" && zone.kind !== "to-lower") continue;
      const at = ball(0, zone.minX + 1, zone.minY + 1, zone.level);
      expect(tick(state, LAW, [], [at])).toEqual([]);
    }
    expect(readBcdField(state.score)).toBe(0);
  });

  it("scores a lock from the saucer that swallowed the ball, matched by rectangle", () => {
    const state = createScoringState();
    const jail = LAW.zones.find((z) => z.kind === "lock" && z.score === 250000);
    expect(jail).toBeDefined();
    if (jail === undefined) return;
    const award = scoreLock(state, LAW, 0, jail.minX + 5, jail.minY + 5);
    expect(award?.score).toBe(250000);
    expect(award?.source).toBe("lock");
    expect(scoreLock(state, LAW, 0, 1, 1)).toBeNull();
    expect(scoreLock(state, LAW, 1, jail.minX + 5, jail.minY + 5)).toBeNull();
  });
});

describe("what a new ball clears and what it does not", () => {
  it("clears the debounces and keeps the score and the bonus", () => {
    const state = createScoringState();
    tick(state, LAW, [32]);
    expect(state.timers.size).toBeGreaterThan(0);
    expect(state.flags.size).toBeGreaterThan(0);

    resetScoringForNewBall(state, groupBackedFlagIds(modesFor("law-n-justice")));
    expect(state.timers.size).toBe(0);
    expect(state.occupants.size).toBe(0);
    expect(readBcdField(state.score)).toBe(50000);
  });

  it("re-arms a group-backed first hit, so the award pays again on ball 2", () => {
    // Law 'n Justice standup 32: 50,000 first, 0 on a repeat. The machine's
    // $3F10 `clr.b (a0)` at +0x003F56 clears the lamp byte the +0x0055F0 `bset`
    // tests, so the SECOND ball's first hit is a first hit again.
    const rearm = groupBackedFlagIds(modesFor("law-n-justice"));
    const state = createScoringState();
    expect(tick(state, LAW, [32]).map((a) => [a.repeat, a.score])).toEqual([[false, 50000]]);
    tickScoring(state); // let the six-frame debounce expire before re-hitting
    for (let i = 0; i < HIT_TIMER_FRAMES; i += 1) tickScoring(state);
    expect(tick(state, LAW, [32]).map((a) => [a.repeat, a.score])).toEqual([[true, 0]]);
    expect(readBcdField(state.score)).toBe(50000);

    resetScoringForNewBall(state, rearm);
    expect(state.flags.has("device-32")).toBe(false);
    expect(tick(state, LAW, [32]).map((a) => [a.repeat, a.score])).toEqual([[false, 50000]]);
    expect(readBcdField(state.score)).toBe(100000);

    // And again on ball 3 — the walk is per ball, not once per game. (An EXTRA
    // ball takes the same path: +0x005068 sets state 7 and branches into the
    // chain two instructions above the `jsr $3F10` at +0x0050B6.)
    resetScoringForNewBall(state, rearm);
    expect(tick(state, LAW, [32]).map((a) => [a.repeat, a.score])).toEqual([[false, 50000]]);
    expect(readBcdField(state.score)).toBe(150000);
  });

  it("re-arms a group-backed ZONE, the BabeWatch top lane the pin's window re-hits", () => {
    // zone-0-7: 50,000 first, 5,000 repeat, and one of the two ids whose
    // re-hits across ball boundaries moved the pinned hashes.
    const rearm = groupBackedFlagIds(modesFor("babewatch"));
    expect(rearm.has("zone-0-7")).toBe(true);
    const state = createScoringState();
    const inLane = [ball(1, 206, 90)];
    const away = [ball(1, 5, 5)];
    expect(tick(state, BABEWATCH, [], inLane).map((a) => [a.id, a.score])).toEqual([
      ["zone-0-7", 50000],
    ]);
    tick(state, BABEWATCH, [], away); // leave the rectangle: release the occupancy
    expect(tick(state, BABEWATCH, [], inLane).map((a) => [a.id, a.score])).toEqual([
      ["zone-0-7", 5000],
    ]);

    tick(state, BABEWATCH, [], away);
    resetScoringForNewBall(state, rearm);
    expect(tick(state, BABEWATCH, [], inLane).map((a) => [a.id, a.score])).toEqual([
      ["zone-0-7", 50000],
    ]);
  });

  it("keeps a flag byte that is NOT in a lamp group — the walk never reaches it", () => {
    // $3F10 only ever follows the chains hanging off the group table at $2326,
    // so a flag byte outside every group is per GAME. Nothing on the three
    // shipped tables is in that class (the next test proves the set is empty),
    // so the rule is exercised here with the id held back from the re-arm set.
    const state = createScoringState();
    tick(state, LAW, [32]);
    resetScoringForNewBall(state, new Set<string>());
    expect(state.flags.has("device-32")).toBe(true);
    expect(tick(state, LAW, [32]).map((a) => a.repeat)).toEqual([true]);
  });

  it("has no per-game flag class left on the shipped data: repeatable IS group-backed", () => {
    // The census behind the rule. On all three documents the set of records
    // with a flag byte (`repeatable`, a non-NULL pointer at device +$04 or zone
    // +$0A) and the set of records whose flag byte is a group-chained lamp are
    // the SAME SET — so every first-hit award that exists re-arms every ball,
    // and a future data change that broke that symmetry would fail here.
    for (const tableId of ["law-n-justice", "babewatch", "extreme-sports"] as const) {
      const devices = devicesFor(tableId);
      const rearm = groupBackedFlagIds(modesFor(tableId));
      const repeatable = new Set<string>();
      for (const device of devices.devices) {
        if (device.repeatable) repeatable.add(`device-${device.surfaceId}`);
      }
      for (const zone of devices.zones) {
        if (zone.repeatable) repeatable.add(zoneKey(zone));
      }
      expect([...rearm].sort()).toEqual([...repeatable].sort());
      expect(repeatable.size).toBeGreaterThan(0);
    }
  });

  it("re-arms exactly the decoded ids, per table", () => {
    const ids = (tableId: "law-n-justice" | "babewatch" | "extreme-sports") =>
      [...groupBackedFlagIds(modesFor(tableId))].sort();
    expect(ids("law-n-justice")).toEqual([
      "device-32",
      "device-33",
      "device-34",
      "device-35",
      "device-36",
    ]);
    expect(ids("babewatch")).toEqual([
      "device-32",
      "device-33",
      "device-34",
      "device-35",
      "device-36",
      "device-37",
      "device-38",
      "device-39",
      "device-40",
      "zone-0-7",
      "zone-0-8",
      "zone-0-9",
    ]);
    expect(ids("extreme-sports")).toEqual([
      "device-33",
      "device-34",
      "device-35",
      "zone-1-7",
      "zone-1-8",
      "zone-1-9",
    ]);
  });
});

describe("the completion clear: a group that fires puts its own lamps out", () => {
  // The other writer of the flag byte, and the one the film caught. The
  // lamp-group scan's tail takes `jsr $64AA` unconditionally (+0x0065A4),
  // which queues a sixteen-frame flash; the service at +0x006430 ends it with
  // `bclr.b #0,$04(group)` and `and.b ~$dc0(a5)` on every lamp of the chain —
  // the FIRED latch released and this player's bit cleared in the very byte the
  // first-hit `bset` tests. See `serviceGroupFlash` in mode-vm.ts.

  function lnj() {
    const modes = modesFor("law-n-justice");
    return { modes, state: createModeState(modes) };
  }

  it("clears the flag ids of a completed group, sixteen frames later", () => {
    const { modes, state } = lnj();
    // Law 'n Justice group 14 is ONE lamp with ONE device on it — drop target
    // 35 — and no event script, so a single hit completes it.
    lightGroupLampsForTrigger(modes, state, "device", -1, 35);
    let cleared: readonly string[] = [];
    let firedOnceAtLeast = false;
    for (let tick = 0; tick < 32; tick += 1) {
      const report = tickModes(modes, state);
      if (state.groupFired[14] === 1) firedOnceAtLeast = true;
      if (report.clearedFlagIds.length > 0) {
        cleared = report.clearedFlagIds;
        expect(tick).toBeGreaterThanOrEqual(GROUP_FLASH_FRAMES);
        break;
      }
    }
    expect(firedOnceAtLeast).toBe(true);
    expect(cleared).toEqual(["device-35"]);
    // And the group is back the way it was: lamp out, latch released.
    expect(state.groupFired[14]).toBe(0);
  });

  it("pays drop target 35 its full 75,000 twice in one ball, as the film does", () => {
    // THE FILMED CASE. In `lawnjustice-fullgame-3balls-...mkv` the ball contacts
    // surface 35 at f2017 and again at f2175 on BALL 2, and the score goes
    // 1,200,000 -> 1,275,000 and 1,350,000 -> 1,425,000: 75,000 both times,
    // where the record's repeat award is zero. 158 frames apart, so the flash
    // has long since ended. research/SCORING_LEDGER.md carries the ledger.
    const { modes, state } = lnj();
    const scoring = createScoringState();

    const hit = () => {
      const awards = scoreSurfaces(scoring, LAW, 0, [35]);
      for (const award of awards) applyAward(scoring, award);
      if (awards.length > 0) lightGroupLampsForTrigger(modes, state, "device", -1, 35);
      const report = tickModes(modes, state);
      clearScoringFlags(scoring, report.clearedFlagIds);
      return awards;
    };
    const idle = (frames: number) => {
      for (let i = 0; i < frames; i += 1) {
        tickScoring(scoring);
        clearScoringFlags(scoring, tickModes(modes, state).clearedFlagIds);
      }
    };

    expect(hit().map((a) => [a.repeat, a.score])).toEqual([[false, 75000]]);
    idle(158);
    expect(hit().map((a) => [a.repeat, a.score])).toEqual([[false, 75000]]);
    expect(readBcdField(scoring.score)).toBe(150000);
  });

  it("still pays nothing for a re-hit DURING the flash", () => {
    // The clear is deferred, not immediate: for the sixteen frames the group is
    // flashing the bit is still set, so a target the ball is resting against
    // does not pay on every debounce window.
    const { modes, state } = lnj();
    const scoring = createScoringState();
    const hit = () => {
      const awards = scoreSurfaces(scoring, LAW, 0, [35]);
      for (const award of awards) applyAward(scoring, award);
      if (awards.length > 0) lightGroupLampsForTrigger(modes, state, "device", -1, 35);
      clearScoringFlags(scoring, tickModes(modes, state).clearedFlagIds);
      return awards;
    };
    expect(hit().map((a) => a.score)).toEqual([75000]);
    for (let i = 0; i < HIT_TIMER_FRAMES + 1; i += 1) {
      tickScoring(scoring);
      clearScoringFlags(scoring, tickModes(modes, state).clearedFlagIds);
    }
    expect(hit().map((a) => [a.repeat, a.score])).toEqual([[true, 0]]);
  });

  it("leaves a SUPPRESSED group alone — the multiplier ladder never completes", () => {
    // Law 'n Justice's X2..X10 chain is group 1 and it carries flags bit 1
    // (`btst #1,$4(a4)` at +0x006582), so the scan never fires it and the clear
    // never reaches it. A ladder that reset itself would un-earn the multiplier.
    const modes = modesFor("law-n-justice");
    const ladder = modes.lampGroups[1];
    expect(ladder?.index).toBe(1);
    expect((ladder?.flags ?? 0) & 2).toBe(2);
    expect(modes.multiplierRestore?.group).toBe(1);
    // And the only groups on this table that can fire AND carry a scoring flag
    // byte are the two standups and the three drop targets — group 12 (32, 33)
    // and the one-lamp groups 13, 14, 15 — which is why nothing else moved.
    const scoringGroups = modes.lampGroups
      .filter((g) => (g.flags & 2) === 0)
      .filter((g) => g.lamps.some((l) => l.devices.length > 0 || l.zones.length > 0))
      .map((g) => g.index);
    expect(scoringGroups).toEqual([12, 13, 14, 15]);
  });

  it("clearScoringFlags is a bclr: deleting a bit that is not set is a no-op", () => {
    const state = createScoringState();
    clearScoringFlags(state, ["device-35"]);
    expect(state.flags.size).toBe(0);
    tick(state, LAW, [35]);
    expect(state.flags.has("device-35")).toBe(true);
    clearScoringFlags(state, ["device-34"]);
    expect(state.flags.has("device-35")).toBe(true);
    clearScoringFlags(state, ["device-35"]);
    expect(state.flags.has("device-35")).toBe(false);
    // The debounce is a different field and the clear must not touch it.
    expect(state.timers.size).toBeGreaterThan(0);
  });
});
