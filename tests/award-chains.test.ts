/**
 * AWARD EFFECTS 17 AND 22 — the chain, and the mission-milestone ladders.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MISSING
 * ---------------------------------------------------------------------------
 * `research/audit/STATIC_AUDIT.md` walked the shipped documents against the VM's
 * dispatch and found two holes with one shape: an award effect the machine
 * implements and this port did not, each of them the ONLY feeder of a whole
 * progression.
 *
 *   EFFECT 17 (handler 0x613A) is `movea.l $34(a2),a0 / jsr $6C10 / rts` —
 *   twelve bytes. The element's +$34, which is a counter record for effects 6
 *   and 21 and an immediate multiplier for effect 5, is here a SCRIPT, posted
 *   to the background queue. Thirty-four elements across the three tables carry
 *   it. The exporter's own `counterList` comment had decoded it years of rounds
 *   ago and the field was still being dropped, so every one of those awards paid
 *   its score and dropped its follow-on.
 *
 *   EFFECT 22 (handler 0x6146) was UNDECODED. It is the count dispatch's tail
 *   without the count: read the counter's per-player total at +$16, walk the
 *   ladder inline at +$50, and queue the script of the entry whose id equals the
 *   total exactly. It sits on the mission ARM elements of all three tables,
 *   paired with effect 21 (which bumps and walks but launches nothing), and it
 *   is the only feeder the three MISSION-MILESTONE ladders have. With no case
 *   for it, Law 'n Justice ladder 8, BabeWatch ladder 10 and Extreme Sports
 *   ladder 8 could never fire an entry — which is also why BabeWatch's
 *   five-step feature chain (elements 21..25, 5M through 25M) was "awarded
 *   reachably but never armable".
 *
 * Both handlers are quoted instruction by instruction on `EFFECT_QUEUE_SCRIPT`
 * and `EFFECT_LAUNCH_AT_COUNT` in `src/game/mode-vm.ts`.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS FILE MEASURES THEM
 * ---------------------------------------------------------------------------
 * Through the REAL path and on the SHIPPED documents: an element is armed, the
 * shipped script that awards it is pushed into the background ring with
 * `queueScript`, and `tickModes` runs one opcode a frame exactly as a device hit
 * does. Nothing here reaches into the effect table by hand. The static half
 * asserts the export, because a field that is not carried cannot be dispatched
 * on — that was effect 17's whole failure mode.
 */

import { describe, expect, it } from "vitest";

import {
  createModeState,
  queueScript,
  signalMultiballEnded,
  tickModes,
} from "../src/game/mode-vm.js";
import type { ModeState } from "../src/game/mode-vm.js";
import type { ModeInstruction, TableModes } from "../src/game/table-modes.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableId } from "../src/game/contracts.js";
import { modesFor } from "./table-fixtures.js";

/** Opcode indices, identical on all three tables (asserted below). */
const OP_AWARD = 5;
const OP_START = 1;
const OP_MODE_START = 9;

/** The one effect that queues the element's own +$34. */
const EFFECT_QUEUE_SCRIPT = 17;
/** The one that fires the ladder entry the count is sitting on. */
const EFFECT_LAUNCH_AT_COUNT = 22;
/** Its partner on every arm pair: bump, walk, launch nothing. */
const EFFECT_ADVANCE_LADDER = 21;

/**
 * The SHORTEST shipped script whose body awards this element.
 *
 * Shortest so the measurement is of the award and not of a mission prologue: a
 * long script that happens to contain the `AWARD` would also run forty other
 * instructions, and a queue event fired by one of those would be indistinguishable
 * from the one the effect posts.
 */
function scriptAwarding(modes: TableModes, element: number): number {
  let best = -1;
  let bestLength = Number.POSITIVE_INFINITY;
  for (const script of modes.scripts) {
    if (!script.ops.some((op: ModeInstruction) => op.op === OP_AWARD && op.args[0] === element)) {
      continue;
    }
    if (script.ops.length < bestLength) {
      best = script.index;
      bestLength = script.ops.length;
    }
  }
  return best;
}

/**
 * Arms an element, runs the shipped script that awards it, and returns
 * everything the machine did between the queue push and the queue running dry.
 */
function award(
  modes: TableModes,
  state: ModeState,
  element: number,
  ticks = 400,
): { paid: number; bonus: number; awarded: number[]; started: number[]; missions: number[] } {
  const script = scriptAwarding(modes, element);
  expect(script, `no shipped script awards element ${element}`).toBeGreaterThanOrEqual(0);
  state.armed[element] = 1;
  state.done[element] = 0;
  queueScript(state, script);
  let paid = 0;
  let bonus = 0;
  const awarded: number[] = [];
  const started: number[] = [];
  const missions: number[] = [];
  for (let i = 0; i < ticks; i += 1) {
    const report = tickModes(modes, state);
    for (const one of report.awards) {
      awarded.push(one.element);
      paid += one.score;
      bonus += one.bonus;
    }
    for (const one of report.elementStarts) started.push(one);
    if (report.missionStarted >= 0) missions.push(report.missionStarted);
  }
  return { paid, bonus, awarded, started, missions };
}

/**
 * Runs a shipped STANDALONE multiball mission through to its epilogue.
 *
 * These four BabeWatch scripts (s179/s182/s188/s192) end in a shot loop that
 * only the multiball teardown latch can break: `0057B6 tst.b $d9d(a5)` is
 * tested before the clock and before the element, and it is NOT cleared until
 * the script ends, so every later WAIT aborts too and the wind-up runs to
 * `END`. That wind-up is where `AWARD 16` — the effect-21 bump of the mission
 * count — lives, which is the decoded rule: THE MILESTONE COUNT CLIMBS WHEN A
 * MISSION ENDS. `signalMultiballEnded` is the same call the game layer makes on
 * the tick the live-plus-queued ball count falls back to one.
 */
function windUp(modes: TableModes, state: ModeState, ticks = 3000): number[] {
  const awarded: number[] = [];
  if (state.mission < 0) return awarded;
  signalMultiballEnded(state);
  for (let i = 0; i < ticks; i += 1) {
    const report = tickModes(modes, state);
    for (const one of report.awards) awarded.push(one.element);
    if (report.missionEnded) return awarded;
  }
  throw new Error(`mission ${state.mission} never wound up`);
}

/**
 * Starts a standalone mission through its own LAUNCHER and winds it up.
 *
 * Through the launcher because `WAIT` is a mission-only opcode — a body pushed
 * straight onto the background ring would run its shot loop as a straight line
 * and prove nothing about the mission machine. `MODE_START` also refuses a
 * second mission while one is live, so whatever the previous rung's feature
 * shot started is wound up first.
 */
function finishStandalone(
  modes: TableModes,
  state: ModeState,
  launcher: number,
  body: number,
  ticks = 3000,
): number[] {
  windUp(modes, state);
  queueScript(state, launcher);
  const awarded: number[] = [];
  for (let i = 0; i < ticks; i += 1) {
    if (state.mission === body && state.suspended && state.waitElement >= 0) {
      return [...awarded, ...windUp(modes, state)];
    }
    const report = tickModes(modes, state);
    for (const one of report.awards) awarded.push(one.element);
  }
  throw new Error(`mission ${body} never parked on a shot`);
}

// ---------------------------------------------------------------------------
// 1. Effect 17 — the field the document could not express
// ---------------------------------------------------------------------------

describe("award effect 17 carries its chain script", () => {
  /** Law 'n Justice 5, BabeWatch 17, Extreme Sports 12 — thirty-four in all. */
  const EXPECTED: Record<TableId, number> = {
    "law-n-justice": 5,
    babewatch: 17,
    "extreme-sports": 12,
  };

  for (const tableId of TABLE_IDS) {
    it(`${tableId}: every effect-17 element resolves its +$34 to a script, and only those do`, () => {
      const modes = modesFor(tableId);
      const chained = modes.elements.filter((one) => one.chainScript >= 0);
      const seventeen = modes.elements.filter((one) => one.effect === EFFECT_QUEUE_SCRIPT);

      expect(seventeen.length, `${tableId}: effect-17 element count`).toBe(EXPECTED[tableId]);
      expect(chained.map((one) => one.index)).toEqual(seventeen.map((one) => one.index));

      for (const element of seventeen) {
        // The pointer is a SCRIPT, so it is not on the descriptor's counter
        // list and `counter` must be -1. This is the invariant that stopped the
        // old per-element reading filing Law 'n Justice element 11 as a counter
        // with a cap of nine.
        expect(element.counter, `${tableId} e${element.index} counter`).toBe(-1);
        expect(
          modes.scripts[element.chainScript],
          `${tableId} e${element.index} chain target`,
        ).toBeDefined();
      }
    });
  }

  it("the chain is what refers to the six unbound mode launchers", () => {
    // STATIC_AUDIT §H4: six launcher scripts nothing in any document queued —
    // Law 'n Justice s26 (SHOOT JAIL), BabeWatch s137 (TIME, the 46-op wizard
    // that runs BabeWatch's ONLY ramp), s153 (THE GAME IS ON), s226, Extreme
    // Sports s182 (EXTREMIST) and s65 (BUCKLE UP BUDDY). Every one of them is
    // an effect-17 target, which is the audit's own H1-explains-H4 prediction
    // and is the reason to trust the decode beyond its twelve bytes.
    const wanted: Record<TableId, readonly number[]> = {
      "law-n-justice": [26],
      babewatch: [137, 153, 226],
      "extreme-sports": [182, 65],
    };
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      const targets = new Set(
        modes.elements.filter((one) => one.chainScript >= 0).map((one) => one.chainScript),
      );
      for (const script of wanted[tableId]) {
        expect(targets.has(script), `${tableId}: nothing chains to launcher s${script}`).toBe(true);
      }
    }
  });
});

describe("award effect 17 queues the chain", () => {
  it("BabeWatch element 59's award starts the TIME wizard, and its ramp with it", () => {
    // e59 -> s137 -> `MODE_START(145)`. Script 145 is the standalone "TIME",
    // the only script on BabeWatch that carries `RESTORE_POS` on ramp 0 — so
    // before this decode BabeWatch's single ramp could never run. The award
    // itself is worth nothing; what it is for is the chain.
    const modes = modesFor("babewatch");
    const element = modes.elements[59]!;
    expect(element.effect).toBe(EFFECT_QUEUE_SCRIPT);
    expect(element.chainScript).toBe(137);
    const chain = modes.scripts[137]!;
    expect(chain.ops[0]!.op).toBe(OP_MODE_START);
    expect(chain.ops[0]!.args[0]).toBe(145);

    const state = createModeState(modes);
    expect(state.rampRunning[0]).toBe(0);
    const run = award(modes, state, 59, 600);
    expect(run.awarded).toContain(59);
    expect(state.mission, "the chained wizard never started").toBe(145);
    expect(state.rampRunning[0], "BabeWatch's only ramp still never runs").toBe(1);
  });

  it("an effect-17 award posts exactly one queue event and nothing else", () => {
    // The negative half: the handler is three instructions, so the award must
    // move NO count, NO accumulator and NO step. Extreme Sports element 43's
    // chain is s117; the element names no counter at all.
    const modes = modesFor("extreme-sports");
    const element = modes.elements[43]!;
    expect(element.effect).toBe(EFFECT_QUEUE_SCRIPT);
    expect(element.counter).toBe(-1);

    const state = createModeState(modes);
    const countsBefore = Array.from(state.counterCounts);
    const totalsBefore = Array.from(state.counterTotals);
    const accumulatorsBefore = Array.from(state.counterAccumulators);
    const stepsBefore = Array.from(state.counterSteps);

    state.armed[43] = 1;
    queueScript(state, scriptAwarding(modes, 43));
    // Stopped ON THE AWARD TICK. The chain it queues is a script like any
    // other and may of course move a counter of its own; what is measured here
    // is the twelve-byte handler, so the machine is read at the frame the
    // handler ran and before the queue takes the record it posted.
    let fired = false;
    for (let i = 0; i < 600 && !fired; i += 1) {
      const report = tickModes(modes, state);
      fired = report.awards.some((one) => one.element === 43);
    }
    expect(fired, "element 43 was never awarded").toBe(true);

    expect(Array.from(state.counterCounts)).toEqual(countsBefore);
    expect(Array.from(state.counterTotals)).toEqual(totalsBefore);
    expect(Array.from(state.counterAccumulators)).toEqual(accumulatorsBefore);
    expect(Array.from(state.counterSteps)).toEqual(stepsBefore);
    // And the chain IS on the ring, waiting its turn.
    expect(Array.from(state.queue)).toContain(element.chainScript);
  });
});

// ---------------------------------------------------------------------------
// 2. Effect 22 — the mission-milestone ladders
// ---------------------------------------------------------------------------

describe("the mission-milestone ladders can fire", () => {
  /** table -> [arm element with effect 21, arm element with effect 22, counter, ladder]. */
  const MILESTONE: Record<TableId, { bump: number; fire: number; counter: number; ladder: number }> = {
    "law-n-justice": { bump: 9, fire: 10, counter: 13, ladder: 8 },
    babewatch: { bump: 16, fire: 15, counter: 5, ladder: 10 },
    "extreme-sports": { bump: 82, fire: 83, counter: 1, ladder: 8 },
  };

  for (const tableId of TABLE_IDS) {
    it(`${tableId}: the arm pair is effect 21 + effect 22 on one counter that hosts the ladder`, () => {
      const modes = modesFor(tableId);
      const wiring = MILESTONE[tableId];
      expect(modes.elements[wiring.bump]!.effect).toBe(EFFECT_ADVANCE_LADDER);
      expect(modes.elements[wiring.fire]!.effect).toBe(EFFECT_LAUNCH_AT_COUNT);
      expect(modes.elements[wiring.bump]!.counter).toBe(wiring.counter);
      expect(modes.elements[wiring.fire]!.counter).toBe(wiring.counter);
      const counter = modes.counters[wiring.counter]!;
      expect(counter.ladder).toBe(wiring.ladder);
      // The audit's argument that these records are MEANT to be walked: the
      // wrap word equals the number of rungs.
      const ladder = modes.ladders[wiring.ladder]!;
      expect(ladder.wrap).toBe(ladder.entries.length);
      // And no effect-6/16/18 element feeds the record — effect 22 is the only
      // thing that can ever launch one of these entries.
      const walkers = modes.elements.filter(
        (one) => one.counter === wiring.counter && [6, 16, 18].includes(one.effect),
      );
      expect(walkers, `${tableId}: an effect-6/16/18 feeder exists after all`).toEqual([]);
    });
  }

  it("BabeWatch: the count climbs and the five-step feature chain pays 5M through 25M", () => {
    // THE DEMONSTRATION. BabeWatch counter 5 resets to ONE, so the very first
    // effect-22 award sits on ladder 10 rung 1; each of s82..s86 STARTs one of
    // elements 21..25, and those five are exactly the "awarded reachably but
    // never armable" set the audit found. Element 16 (effect 21) is awarded by
    // the four standalone missions and bumps the count; s82..s85 hand element
    // 16 back with `CLEAR_DONE`, and the missions hand element 15 back, so the
    // chain sustains itself with no help from this test beyond re-arming the
    // shot each time — which is what the lock and the mission do in play.
    const modes = modesFor("babewatch");
    const state = createModeState(modes);
    expect(state.counterTotals[5], "counter 5 starts on rung one").toBe(1);
    // Both arm shots are lit from game start (flags bit 1), so nothing has to
    // be invented to reach them.
    expect(state.armed[15]).toBe(1);
    expect(state.armed[16]).toBe(1);

    const rungs = [
      { total: 1, entry: 82, element: 21, score: 5_000_000 },
      { total: 2, entry: 83, element: 22, score: 10_000_000 },
      { total: 3, entry: 84, element: 23, score: 15_000_000 },
      { total: 4, entry: 85, element: 24, score: 20_000_000 },
      { total: 5, entry: 86, element: 25, score: 25_000_000 },
    ];
    let paidByTheChain = 0;
    const climb: number[] = [];
    for (const rung of rungs) {
      climb.push(state.counterTotals[5]!);
      expect(state.counterTotals[5], `before rung ${rung.total}`).toBe(rung.total);
      expect(modes.ladders[10]!.entries[rung.total - 1]).toEqual({
        id: rung.total,
        script: rung.entry,
      });

      // The milestone shot. Its entry script arms the rung's feature element.
      const fired = award(modes, state, 15, 400);
      expect(fired.started, `rung ${rung.total} never armed element ${rung.element}`).toContain(
        rung.element,
      );
      expect(state.armed[rung.element]).toBe(1);

      // AND THE ENTRY PAYS. Before this round element 21..25 could not be
      // armed at all, so `awardElement`'s `armed === 0` guard refused every one
      // of them and the five shots were worth nothing.
      const stepped = state.counterTotals[4]!;
      const paid = award(modes, state, rung.element, 400);
      expect(paid.awarded, `element ${rung.element} refused its award`).toContain(rung.element);
      expect(paid.paid).toBeGreaterThanOrEqual(rung.score);
      paidByTheChain += rung.score;
      // Each feature shot is award effect 6 on counter 4, so paying it also
      // steps BabeWatch's other ladder — ladder 1, whose five rungs launch the
      // five SELECTED missions. The feature chain feeds the mission chain.
      expect(state.counterTotals[4], `rung ${rung.total} did not step counter 4`).toBe(stepped + 1);

      // The count climbs on the OTHER arm shot, and the only thing that awards
      // it is the epilogue of one of the four standalone multiball missions.
      // s179 is "SHOW YOUR MUSCLES TO SCORE JACKPOTS".
      const ending = finishStandalone(modes, state, 110, 179);
      expect(ending, `mission 179 did not award the bump on rung ${rung.total}`).toContain(16);
    }
    expect(climb, "the milestone count climbed one rung per mission").toEqual([1, 2, 3, 4, 5]);
    expect(paidByTheChain).toBe(75_000_000);
    // And the chain closes on itself: element 25's own effect-6 award is
    // counter 4's fifth step, ladder 1 rung 5, whose launcher s98 starts
    // "NOW IT IS TIME FOR BABE HUNT" — and script 200's `RESET_GROUP` puts the
    // milestone record back to its +$02 reset of one. So the count does NOT
    // stand at six at the end; the last feature mode starts the chain over,
    // which is the machine's rule and not this test's arithmetic.
    expect(state.counterTotals[5]).toBeLessThan(6);
  });

  for (const tableId of ["law-n-justice", "extreme-sports"] as const) {
    it(`${tableId}: every milestone rung launches its feature mode`, () => {
      // Both tables' rungs are bare `MODE_START` launchers — Law 'n Justice's
      // eight feature modes and Extreme Sports' six selector-1 missions — so
      // what "the entry paying" means here is that the mode actually starts.
      const modes = modesFor(tableId);
      const wiring = MILESTONE[tableId];
      const ladder = modes.ladders[wiring.ladder]!;
      for (const entry of ladder.entries) {
        const launcher = modes.scripts[entry.script]!;
        // Extreme Sports' last rung puts three `LAMP_OFF`s in front of its
        // `MODE_START`, so the test is that the rung LAUNCHES, not that it
        // opens with the launch.
        expect(
          launcher.ops.some((op: ModeInstruction) => op.op === OP_MODE_START),
          `${tableId} rung ${entry.id} is not a launcher`,
        ).toBe(true);
      }

      const seen: number[] = [];
      for (const entry of ladder.entries) {
        const state = createModeState(modes);
        // Walk the count up to this rung with the bump shot, exactly as the
        // mission epilogues do — every one of them awards it.
        for (let i = 0; i < entry.id; i += 1) award(modes, state, wiring.bump, 60);
        expect(state.counterTotals[wiring.counter]).toBe(entry.id);
        // Read the STARTS off the reports and not off `state.mission`: Law 'n
        // Justice rung 5 runs a mode short enough to have finished again
        // inside the window, which is a mode that ran and not a mode that
        // never started.
        const fired = award(modes, state, wiring.fire, 400);
        expect(fired.missions, `${tableId} rung ${entry.id} started no mission`).toHaveLength(1);
        seen.push(fired.missions[0]!);
      }
      expect(new Set(seen).size, `${tableId}: the rungs do not run distinct modes`).toBe(
        ladder.entries.length,
      );
    });
  }
});

describe("award effect 22 is a launch and not a count", () => {
  it("it does not bump: the same rung fires twice on an unmoved count", () => {
    // 0x6146 has no `addq` in it. The handler reads +$16 and never writes it,
    // so two awards with no effect-21 between them sit on the same rung.
    const modes = modesFor("babewatch");
    const state = createModeState(modes);
    const first = award(modes, state, 15, 400);
    expect(first.started).toContain(21);
    expect(state.counterTotals[5]).toBe(1);
    expect(state.counterCounts[5]).toBe(1);

    // The rung's own script `COMPLETE`d element 21; clear that so the second
    // firing is visible as an arming rather than as a refused START.
    state.done[21] = 0;
    state.armed[21] = 0;
    const second = award(modes, state, 15, 400);
    expect(second.started, "the second award moved off rung one").toContain(21);
    expect(state.counterTotals[5], "effect 22 moved the count").toBe(1);
  });

  it("it does not wrap: a count past the last rung fires nothing", () => {
    // The shared walk at 0x5EAA subtracts the wrap word when it runs off the
    // 0xFFFE terminator and walks again. Effect 22's own loop ends on a plain
    // `bmi.s` to `rts`, so a total above the last id is silence — NOT rung one
    // a second time, which is what reusing `walkLadder` here would have given.
    const modes = modesFor("babewatch");
    const state = createModeState(modes);
    const last = modes.ladders[10]!.entries[modes.ladders[10]!.entries.length - 1]!.id;
    state.counterTotals[5] = last + 1;
    state.counterCounts[5] = last + 1;
    const run = award(modes, state, 15, 400);
    expect(run.awarded, "the award itself should still fire").toContain(15);
    expect(run.started, "a rung fired past the end of the ladder").toEqual([]);
    expect(state.counterTotals[5], "effect 22 wrapped the count").toBe(last + 1);
  });

  it("effect 21 still launches nothing of its own", () => {
    // 0x5FDE calls the walk and throws the result away; only 0x5E9E and 0x6192
    // reach `$6C10` with the entry's +$04. A bump that also launched would make
    // the arm pair fire twice per milestone.
    const modes = modesFor("babewatch");
    const state = createModeState(modes);
    // Element 25 is rung five's feature shot; if effect 21 launched, the
    // count's own rung would arm one of elements 21..25 on the way past.
    const before = Array.from(state.armed);
    const awarded = finishStandalone(modes, state, 110, 179);
    expect(awarded).toContain(16);
    expect(state.counterTotals[5], "the bump did not count").toBe(2);
    for (const element of [21, 22, 23, 24, 25]) {
      expect(state.armed[element], `effect 21 launched rung ${element - 20}`).toBe(before[element]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The opcode label the document had stale
// ---------------------------------------------------------------------------

describe("the shipped documents name opcode 25 by its measurement", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId}: opcode 25 is VIEW_WIDE`, () => {
      // +0x005A26 tests `$e90(a5)` — OPTION RECORD 6, the view mode — and calls
      // the wide-screen setup at $3C52. `mode-vm.ts` renamed it on that
      // measurement and the documents had kept the old IF_TWO_PLAYER label.
      // Dispatch is by number, so this was only ever a stale word; it is the
      // same class as the SET_INTRO name that was fixed before it.
      const modes = modesFor(tableId);
      expect(modes.opcodes[25]!.name).toBe("VIEW_WIDE");
      expect(modes.opcodes[OP_AWARD]!.name).toBe("AWARD");
      expect(modes.opcodes[OP_START]!.name).toBe("START");
      expect(modes.opcodes[OP_MODE_START]!.name).toBe("MODE_START");
    });
  }
});
