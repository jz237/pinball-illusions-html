/**
 * THE GROWING JACKPOTS — the counter record's RUNNING STEP, and the ramps.
 *
 * A progress-counter record carries two independent values. One is the
 * ACCUMULATOR at +$38..$3F, which this port has run since the scoring round:
 * effects 11/16/18 add the step into it and effects 7/16 pay it. The other is
 * the RUNNING STEP itself at +$30..$37, and until this round nothing in the
 * port could move it or pay it — `ModeCounter.step` was immutable configuration.
 *
 * The consequence was measured and written down before it was fixed
 * (`research/MULTIBALL_PLAY.md` section 8): BabeWatch's "SHOW YOUR MUSCLES TO
 * SCORE JACKPOTS" waits on elements 84 and 85, both of which carry `score: 0`
 * and award effect 14, and effect 14 was not wired. A player who completed a
 * headline multiball objective was paid NOTHING.
 *
 * What is asserted here, and why each is here:
 *
 *   1. EFFECT 15 GROWS THE STEP by the element's own +$3A..$3F, and effect 14
 *      pays the grown step to the SCORE. That pair is the whole of BabeWatch's
 *      jackpot: eleven growers on counter 1 and twelve payers on the same
 *      record, whose master step is 20,000,000.
 *   2. THE STEP SURVIVES A BALL when the record's flags carry bit 0, because
 *      +0x004146's `btst.b #$0,(a1) / bne $417c` jumps past the restore at
 *      +0x00414C. BabeWatch's counter 1 is exactly that record, so its jackpot
 *      grows for the whole game.
 *   3. THE RAMPS TICK. Descriptor +$68 is a list of 42-byte records that
 *      +0x006334 moves one increment a frame toward a limit and then stops, and
 *      award effect 27 harvests the live value into the step. Extreme Sports'
 *      Iron Man multiball is built out of exactly that.
 *   4. THE FOUR OPCODES that write the step or the accumulator do what their
 *      handlers do, and no more.
 *   5. EFFECT 10 pays the accumulator min(ask, count) times and spends the
 *      count only when it was short.
 *
 * Every address is `main.seg00`; file offset = address + 4 in
 * `research/seg_clean/main.bin.seg00.bin`. Every one of the BCD instructions
 * involved — `abcd`, `sbcd` — is invisible to Capstone and was read as raw
 * words; see `research/BALL_SAVER_JACKPOTS.md`.
 */

import { describe, expect, it } from "vitest";
import { modesFor } from "./table-fixtures.js";
import {
  createModeState,
  queueScript,
  resetModesForNewBall,
  tickModes,
} from "../src/game/mode-vm.js";
import type { ModeState } from "../src/game/mode-vm.js";
import type { ModeInstruction, TableModes } from "../src/game/table-modes.js";
import { TABLE_IDS } from "../src/game/contracts.js";

const OP_AWARD = 5;
/** The opcodes that write a counter record's step or accumulator. */
const STEP_OPS = new Set([6, 7, 13, 18]);

/**
 * A shipped script that awards this element with NOTHING before it that could
 * move a counter record, and the opcode index the award sits at.
 *
 * The scan refuses a script whose earlier instructions include one of the four
 * step opcodes, so what the helper below measures is the award and not the
 * script's own bookkeeping.
 */
function scriptAwarding(modes: TableModes, element: number): number {
  for (const script of modes.scripts) {
    const at = script.ops.findIndex(
      (op: ModeInstruction) => op.op === OP_AWARD && op.args[0] === element,
    );
    if (at < 0) continue;
    if (script.ops.slice(0, at).some((op: ModeInstruction) => STEP_OPS.has(op.op))) continue;
    return script.index;
  }
  return -1;
}

/**
 * Arms an element and runs the shipped script that awards it, returning what
 * the machine paid ON THE TICK THAT AWARD FIRED.
 *
 * The award goes through the REAL path — `queueScript` into the background ring
 * and `tickModes` running one opcode a tick, exactly as a device hit does — so
 * nothing here reaches past the interpreter into the effect table. Only the
 * awarding tick's payment is returned, because a shipped script awards several
 * elements and this is a measurement of one.
 */
function award(modes: TableModes, state: ModeState, element: number, ticks = 300): number {
  const script = scriptAwarding(modes, element);
  expect(script, `no script awards element ${element} before touching a counter`).toBeGreaterThanOrEqual(0);
  state.armed[element] = 1;
  state.done[element] = 0;
  queueScript(state, script);
  for (let i = 0; i < ticks; i += 1) {
    const report = tickModes(modes, state);
    if (report.awards.some((one) => one.element === element)) return report.comboPaid;
  }
  throw new Error(`element ${element} was never awarded by script ${script}`);
}

describe("the running-step jackpot", () => {
  it("BabeWatch's SCORE JACKPOTS pays its record's step, and paid nothing before", () => {
    // Script 179 is "SHOW YOUR MUSCLES TO SCORE JACKPOTS" and it waits on
    // elements 84 and 85; script 188 "HAVE A BURGER DUDE" waits on 94..99. All
    // of them are award effect 14 on counter 1 and all of them carry score 0,
    // so what they are worth is the RECORD's running step and nothing else.
    const modes = modesFor("babewatch");
    const jackpotShots = modes.elements.filter((one) => one.effect === 14 && one.counter === 1);
    expect(jackpotShots.length).toBe(11);
    expect(jackpotShots.every((one) => one.score === 0)).toBe(true);
    const counter = modes.counters[1]!;
    expect(counter.step).toBe(20_000_000);

    const state = createModeState(modes);
    expect(state.counterSteps[1]).toBe(20_000_000);
    // The base jackpot, with nothing grown: twenty million, where the element's
    // own score is zero.
    expect(award(modes, state, 84)).toBe(20_000_000);
  });

  it("the gym targets grow it, by their own six BCD bytes", () => {
    // Award effect 15, +0x0060DC: `lea $40(a2),a1 / movea.l $34(a2),a0 /
    // lea $38(a0),a2` then six backwards `abcd` — the counter's +$37..$32 gets
    // the element's +$3F..$3A. BabeWatch's eleven are elements 37..47.
    const modes = modesFor("babewatch");
    const growers = modes.elements.filter((one) => one.effect === 15 && one.counter === 1);
    expect(growers.map((one) => one.index)).toEqual([37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]);
    expect(growers.map((one) => one.stepAddend)).toEqual([
      5_000_000, 2_500_000, 2_500_000, 2_500_000, 5_000_000, 2_000_000, 5_000_000, 2_000_000,
      1_000_000, 1_000_000, 500_000,
    ]);

    const state = createModeState(modes);
    award(modes, state, 37);
    expect(state.counterSteps[1]).toBe(25_000_000);
    award(modes, state, 47);
    expect(state.counterSteps[1]).toBe(25_500_000);
    // And the jackpot is now worth what the shots built.
    expect(award(modes, state, 84)).toBe(25_500_000);
  });

  it("pays the step over and over without spending it — only a script puts it back", () => {
    // Effect 14 is `lea $38(a0),a3 / jsr $6BCC`: it ADDS six BCD bytes into the
    // player's score and writes nothing back, so the record keeps its value.
    // What resets it is opcode 6 (0x5C40, `move.l $28(a2),$30(a2)`), and every
    // one of BabeWatch's five jackpot missions opens with one.
    const modes = modesFor("babewatch");
    const state = createModeState(modes);
    award(modes, state, 37);
    expect(award(modes, state, 84)).toBe(25_000_000);
    expect(award(modes, state, 85)).toBe(25_000_000);
    expect(state.counterSteps[1]).toBe(25_000_000);

    // Opcode 6, run the way a mission runs it: script 120 pc 24 is BabeWatch's.
    const restore = modes.scripts.find((one) =>
      one.ops.some((op) => op.op === 6 && op.args[0] === 1),
    );
    expect(restore, "no BabeWatch script restores counter 1").toBeDefined();
    queueScript(state, restore!.index);
    for (let i = 0; i < 60 && state.counterSteps[1] !== 20_000_000; i += 1) tickModes(modes, state);
    expect(state.counterSteps[1]).toBe(20_000_000);
  });

  it("keeps the grown step across a ball, because counter 1's flags carry bit 0", () => {
    // +0x004146: `btst.b #$0,(a1) / bne $417c` jumps PAST the step restore at
    // +0x00414C as well as past the count reset. Counter 1's flags are $01.
    const modes = modesFor("babewatch");
    expect(modes.counters[1]!.flags & 0x01).toBe(0x01);
    const state = createModeState(modes);
    award(modes, state, 37);
    expect(state.counterSteps[1]).toBe(25_000_000);
    resetModesForNewBall(modes, state);
    expect(state.counterSteps[1]).toBe(25_000_000);

    // And a record WITHOUT bit 0 goes back to its master. BabeWatch's counter 3
    // is flags 0 with a 500,000 step and one effect-14 payer, element 35.
    expect(modes.counters[3]!.flags & 0x01).toBe(0);
    state.counterSteps[3] = 9_999_999;
    resetModesForNewBall(modes, state);
    expect(state.counterSteps[3]).toBe(modes.counters[3]!.step);
  });
});

describe("the ramps", () => {
  it("are decoded off descriptor +$68, twelve of them across the three tables", () => {
    const counts = TABLE_IDS.map((id) => modesFor(id).ramps.length);
    expect(counts).toEqual([2, 1, 9]);
    // Extreme Sports' Iron Man trio: 50,000,000 falling to 10,000,000 at 20,000
    // a frame, which is 2,000 frames — forty seconds — of hurry-up.
    const es = modesFor("extreme-sports");
    for (const index of [5, 6, 7]) {
      const ramp = es.ramps[index]!;
      expect(ramp.up).toBe(false);
      expect(ramp.start).toBe(50_000_000);
      expect(ramp.limit).toBe(10_000_000);
      expect(ramp.increment).toBe(20_000);
    }
    // And its free-fall trio, which climb instead.
    expect(es.ramps.slice(1, 4).map((one) => [one.up, one.start, one.limit, one.increment])).toEqual(
      [
        [true, 1_000_000, 10_000_000, 5_140],
        [true, 5_000_000, 20_000_000, 12_310],
        [true, 10_000_000, 30_000_000, 26_780],
      ],
    );
  });

  it("start stopped and at zero, and nothing but opcode 15 seeds one", () => {
    // No reset walk touches this list: +0x0040CA and +0x00412C both walk
    // `$232e`, the counter list, and neither ever reaches `$2356`.
    const modes = modesFor("extreme-sports");
    const state = createModeState(modes);
    expect([...state.rampValues]).toEqual(modes.ramps.map(() => 0));
    expect([...state.rampRunning]).toEqual(modes.ramps.map(() => 0));
    tickModes(modes, state);
    expect([...state.rampValues]).toEqual(modes.ramps.map(() => 0));
  });

  it("climb one increment a frame and STOP at the limit", () => {
    const modes = modesFor("extreme-sports");
    const state = createModeState(modes);
    // Ramp 1, seeded by hand the way opcode 15 seeds it, then ticked.
    state.rampValues[1] = modes.ramps[1]!.start;
    state.rampRunning[1] = 1;
    tickModes(modes, state);
    expect(state.rampValues[1]).toBe(1_000_000 + 5_140);
    tickModes(modes, state);
    expect(state.rampValues[1]).toBe(1_000_000 + 2 * 5_140);
    // Run it out: 10,000,000 is 1,751 frames away and the clamp is exact.
    for (let i = 0; i < 4_000 && state.rampRunning[1] === 1; i += 1) tickModes(modes, state);
    expect(state.rampValues[1]).toBe(10_000_000);
    expect(state.rampRunning[1]).toBe(0);
  });

  it("fall to a floor the same way", () => {
    const modes = modesFor("extreme-sports");
    const state = createModeState(modes);
    state.rampValues[5] = modes.ramps[5]!.start;
    state.rampRunning[5] = 1;
    tickModes(modes, state);
    expect(state.rampValues[5]).toBe(50_000_000 - 20_000);
    for (let i = 0; i < 4_000 && state.rampRunning[5] === 1; i += 1) tickModes(modes, state);
    expect(state.rampValues[5]).toBe(10_000_000);
    expect(state.rampRunning[5]).toBe(0);
  });

  it("are started and stopped by the two opcodes the missions use", () => {
    // 15 = +0x005DDA `move.l $a(a2),$2(a2) / st.b (a2)`; 16 = +0x005DEE
    // `clr.b (a2)`, which leaves the value where it stands.
    const modes = modesFor("extreme-sports");
    const state = createModeState(modes);
    // Script 112 is IRON MAN and it starts ramps 4, 5, 6 and 7 in turn.
    const iron = modes.scripts[112]!;
    expect(iron.ops.filter((op) => op.op === 15).map((op) => op.args[0])).toEqual([4, 5, 4, 6, 4, 7]);
    expect(iron.ops.filter((op) => op.op === 16).map((op) => op.args[0])).toEqual([5, 6, 7]);

    const starter = modes.scripts.find((one) => one.ops.some((op) => op.op === 15));
    queueScript(state, starter!.index);
    for (let i = 0; i < 200 && !state.rampRunning.some((one) => one === 1); i += 1) {
      tickModes(modes, state);
    }
    const running = [...state.rampRunning].findIndex((one) => one === 1);
    expect(running, "no script ever started a ramp").toBeGreaterThanOrEqual(0);
    expect(state.rampValues[running]).toBeGreaterThan(0);
  });

  it("effect 27 harvests the ramp's LIVE value into the step", () => {
    // +0x0060FA: `movea.l $38(a2),a1 / addq.w #8,a1` and then a `bra` into
    // effect 15's `abcd` body, so the six source bytes are `ramp + 2` counted
    // back from +8 — the ramp's own +$04..$09.
    const modes = modesFor("extreme-sports");
    const harvest = modes.elements.filter((one) => one.effect === 27);
    expect(harvest.map((one) => [one.index, one.counter, one.stepRamp])).toEqual([
      [26, 7, 1],
      [27, 7, 2],
      [28, 7, 3],
      [48, 6, 5],
      [49, 6, 6],
      [50, 6, 7],
    ]);

    // IRON MAN, END TO END, out of its own script. 112 opens with
    // `RESET_GROUP 6` (so counter 6's step starts at its master, zero), starts
    // ramp 5 falling from 50,000,000 at pc 102, stops it again at pc 142 and
    // awards element 48 at pc 154 — the hurry-up's whole shape, the clock
    // freezes on the shot and the player is paid what it says.
    //
    // Run through the BACKGROUND ring, which executes one opcode a tick and
    // does not honour the mission's own WAITs, so the ramp had only a few
    // frames to fall here; in a real mission it falls for as long as the player
    // takes. Either way the value is below the start and above the floor, and
    // the step gains EXACTLY it, which is the instruction under test.
    const state = createModeState(modes);
    state.armed[48] = 1;
    queueScript(state, 112);
    let rampBefore = -1;
    let stepBefore = -1;
    let awarded = false;
    for (let i = 0; i < 400 && !awarded; i += 1) {
      rampBefore = state.rampValues[5]!;
      stepBefore = state.counterSteps[6]!;
      const report = tickModes(modes, state);
      awarded = report.awards.some((one) => one.element === 48);
    }
    expect(awarded, "Iron Man never awarded element 48").toBe(true);
    expect(rampBefore).toBeLessThan(50_000_000);
    expect(rampBefore).toBeGreaterThan(10_000_000);
    expect(state.counterSteps[6]).toBe(stepBefore + rampBefore);

    // And element 47's effect 14 pays whatever the step then holds.
    const collect = createModeState(modes);
    // Script 26's `JMP_IF_UNLIT 0, 78` at pc 44 skips past the collect unless
    // element 0 is lit, which is the shot's own gate.
    collect.armed[0] = 1;
    collect.counterSteps[6] = 37_500_000;
    expect(award(modes, collect, 47)).toBe(37_500_000);

    // A ramp nobody started is worth zero, which is what the machine's own
    // uninitialised +$04..$09 gives — and is what every one of these six shots
    // paid before this round, because effect 27 did not run at all.
    const fresh = createModeState(modes);
    expect(fresh.counterSteps[7]).toBe(0);
    award(modes, fresh, 26);
    expect(fresh.counterSteps[7]).toBe(0);
  });
});

describe("the four step and accumulator opcodes", () => {
  it("SET_VALUE (7) writes the step from the script's own eight bytes", () => {
    // +0x005C7E: `move.l $6(a1),$30(a2) / move.l $a(a1),$34(a2)`. Extreme
    // Sports' four TIME selectors set counter 10 to 5, 10, 25 and 50 million.
    const modes = modesFor("extreme-sports");
    const values: number[] = [];
    for (const index of [162, 163, 164, 165]) {
      const state = createModeState(modes);
      queueScript(state, index);
      for (let i = 0; i < 40; i += 1) tickModes(modes, state);
      values.push(state.counterSteps[10]!);
    }
    expect(values).toEqual([5_000_000, 10_000_000, 25_000_000, 50_000_000]);
  });

  it("RESET_GROUP (13) puts the step, both counts and the accumulator back", () => {
    // +0x0059BC, the per-ball walk's body without the flag tests.
    const modes = modesFor("babewatch");
    const state = createModeState(modes);
    const reset = modes.scripts.find((one) => one.ops.some((op) => op.op === 13 && op.args[0] === 3));
    expect(reset).toBeDefined();
    state.counterSteps[3] = 7_000_000;
    state.counterCounts[3] = 5;
    state.counterTotals[3] = 5;
    state.counterAccumulators[3] = 1_234_000;
    queueScript(state, reset!.index);
    for (let i = 0; i < 60 && state.counterSteps[3] !== modes.counters[3]!.step; i += 1) {
      tickModes(modes, state);
    }
    expect(state.counterSteps[3]).toBe(modes.counters[3]!.step);
    expect(state.counterCounts[3]).toBe(modes.counters[3]!.reset);
    expect(state.counterTotals[3]).toBe(modes.counters[3]!.reset);
    expect(state.counterAccumulators[3]).toBe(0);
  });

  it("SET_MAX (18) writes the ACCUMULATOR, not the step", () => {
    // +0x005C52 is SET_VALUE's shape eight bytes further along the record.
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);
    const script = modes.scripts.find((one) => one.ops.some((op) => op.op === 18));
    expect(script).toBeDefined();
    const op = script!.ops.find((one) => one.op === 18)!;
    const counter = op.args[0]!;
    const stepBefore = state.counterSteps[counter];
    queueScript(state, script!.index);
    for (let i = 0; i < 120 && state.counterAccumulators[counter] === 0; i += 1) {
      tickModes(modes, state);
    }
    expect(state.counterAccumulators[counter]).toBe(20_000_000);
    expect(state.counterSteps[counter]).toBe(stepBefore);
  });

  it("the window expiry puts the step back and clears the accumulator", () => {
    // +0x0056EA..+0x0056FA, the tick the +$26 countdown reaches zero.
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);
    state.counterSteps[12] = 9_000_000;
    state.counterAccumulators[12] = 3_000_000;
    state.counterWindows[12] = 3;
    tickModes(modes, state);
    tickModes(modes, state);
    expect(state.counterSteps[12]).toBe(9_000_000);
    tickModes(modes, state);
    expect(state.counterWindows[12]).toBe(0);
    expect(state.counterAccumulators[12]).toBe(0);
    expect(state.counterSteps[12]).toBe(modes.counters[12]!.step);
  });
});

describe("award effect 10", () => {
  it("pays the accumulator min(ask, count) times and spends the count only when short", () => {
    // +0x0061BA. Law 'n Justice's element 89 asks for 25 against counter 4.
    // `sub.w d0,d1 / bpl $61d2` skips the `clr.w $6(a0,d6.w*2)` when the count
    // could cover the ask, so a count that can pay in full is not spent at all.
    const modes = modesFor("law-n-justice");
    const element = modes.elements[89]!;
    expect(element.effect).toBe(10);
    expect(element.payCount).toBe(25);
    expect(element.counter).toBe(4);

    const short = createModeState(modes);
    short.counterAccumulators[4] = 1_000_000;
    short.counterCounts[4] = 3;
    expect(award(modes, short, 89)).toBe(3_000_000);
    expect(short.counterCounts[4]).toBe(0);

    const plenty = createModeState(modes);
    plenty.counterAccumulators[4] = 1_000_000;
    plenty.counterCounts[4] = 30;
    expect(award(modes, plenty, 89)).toBe(25_000_000);
    expect(plenty.counterCounts[4]).toBe(30);
  });
});

/**
 * AWARD EFFECT 19 - the COLLECT the twelve ramps were missing.
 *
 * The ramps have ticked in this port since the round above; nothing collected
 * six of them. +0x0061F6 is the harvester, and it is effect 27's sibling with
 * one field changed:
 *
 *     0061F6  206a 0034            movea.l $34(a2),a0   ; a RAMP RECORD, base
 *     0061FA  47e8 0002            lea     $2(a0),a3
 *     0061FE  215b 0022            move.l  (a3)+,$22(a0)
 *     006202  215b 0026            move.l  (a3)+,$26(a0)
 *     006206  4eb9 0000 6bcc       jsr     $6BCC
 *     00620C  4e75                 rts
 *
 * The two post-increments leave a3 at `ramp + $0A`, and $6BCC predecrements six
 * times from what it is handed, so the six bytes paid are the ramp's +$04..$09 -
 * the same field the service at +0x006334 accumulates into and the same field
 * effect 27 harvests. 27 adds it to a counter's running step; 19 adds it to the
 * SCORE. research/effects-tail/EFFECTS_TAIL.md section 3.
 */
describe("award effect 19", () => {
  it("is the missing harvester, and the two harvest families partition the twelve ramps", () => {
    // THE DECISIVE MEASUREMENT, and the one that says the +$34 really is a ramp
    // base rather than something ramp-shaped: across three tables the effect-19
    // elements and the effect-27 elements between them name every one of the
    // twelve shipped ramps, once. If this wiring were wrong the two sets would
    // overlap or leave a gap.
    const partition: Record<string, [number[], number[], number]> = {
      "law-n-justice": [[0, 1], [], 2],
      babewatch: [[0], [], 1],
      "extreme-sports": [
        [0, 4, 8],
        [1, 2, 3, 5, 6, 7],
        9,
      ],
    };
    let total = 0;
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      const [collect, harvest, count] = partition[tableId]!;
      expect(modes.ramps.length).toBe(count);
      const byNineteen = modes.elements.filter((one) => one.effect === 19);
      const bySeven = modes.elements.filter((one) => one.effect === 27);
      total += byNineteen.length;
      // Every effect-19 element resolves to a ramp - the exporter throws rather
      // than dropping one, so a -1 here would mean the field is unread.
      expect(byNineteen.every((one) => one.rampCollect >= 0)).toBe(true);
      expect([...new Set(byNineteen.map((one) => one.rampCollect))].sort((a, b) => a - b)).toEqual(
        collect,
      );
      expect([...new Set(bySeven.map((one) => one.stepRamp))].sort((a, b) => a - b)).toEqual(harvest);
      expect(collect.filter((one) => harvest.includes(one))).toEqual([]);
      expect([...collect, ...harvest].sort((a, b) => a - b)).toEqual(
        modes.ramps.map((one) => one.index),
      );
      // And nothing else carries the field: it is read for effect 19 alone.
      expect(modes.elements.filter((one) => one.effect !== 19 && one.rampCollect >= 0)).toEqual([]);
    }
    expect(total).toBe(18);
  });

  it("pays the ramp's LIVE value into the score, where the element's own score is zero", () => {
    // Law 'n Justice's hostage mission: elements 113..117 on ramp 0, which runs
    // 20,000,000 down to 5,000,000 at 12,340 a frame. All six of the table's
    // effect-19 elements carry score 0 AND bonus 0, so before this round every
    // one of these shots paid NOTHING AT ALL.
    const modes = modesFor("law-n-justice");
    const hostages = modes.elements.filter((one) => one.effect === 19);
    expect(hostages.map((one) => one.index)).toEqual([100, 113, 114, 115, 116, 117]);
    expect(hostages.every((one) => one.score === 0 && one.bonus === 0)).toBe(true);
    const ramp = modes.ramps[0]!;
    expect([ramp.up, ramp.start, ramp.limit, ramp.increment]).toEqual([
      false, 20_000_000, 5_000_000, 12_340,
    ]);

    // A STOPPED ramp holds its value, so this measures the award and not the
    // service: the payment is the value, exactly, on the awarding tick.
    const state = createModeState(modes);
    state.rampValues[0] = 20_000_000;
    state.rampRunning[0] = 0;
    expect(award(modes, state, 113)).toBe(20_000_000);
    // NOTHING IS SPENT. The handler writes nothing back to +$04..$09, so a
    // second collect inside one countdown pays again - what puts the value back
    // is opcode 15, and what stops the clock is opcode 16.
    expect(state.rampValues[0]).toBe(20_000_000);
    expect(award(modes, state, 114)).toBe(20_000_000);

    // Half way down the countdown it is worth half way down the countdown.
    state.rampValues[0] = 11_357_000;
    expect(award(modes, state, 115)).toBe(11_357_000);

    // AND A RAMP NOBODY STARTED IS WORTH ZERO - the machine's own uninitialised
    // +$04..$09, and the same answer effect 27 gives on an unstarted ramp.
    const fresh = createModeState(modes);
    expect(fresh.rampValues[0]).toBe(0);
    expect(award(modes, fresh, 113)).toBe(0);
  });

  it("leaves the paid value in the ramp's tail, which the display prints", () => {
    // THE OTHER HALF OF 0x61F6, and it is not decoration:
    //
    //     0061FA  lea     $2(a0),a3      ; the ramp's eight-byte value slot
    //     0061FE  move.l  (a3)+,$22(a0)  ; +$02..$05 -> +$22..$25
    //     006202  move.l  (a3)+,$26(a0)  ; +$06..$09 -> +$26..$29
    //     006206  jsr     $6BCC          ; and pay the same six bytes
    //
    // EFFECTS_TAIL.md section 9 listed the copy under "what is NOT established"
    // and was right on both halves: no relocated pointer in any package lands on
    // ramp +$22, and it left open whether something read it anyway - "e.g. to
    // print LAST JACKPOT on the panel". It does. The display's number printer
    // reads BACKWARDS from its pointer, so what reads the copy is a pointer to
    // +$2A, one past the 42-byte record, and there are seventeen of them.
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);
    // Nothing has been paid, so the tail holds the machine's own zero.
    expect([...state.rampPaid]).toEqual(modes.ramps.map(() => 0));

    state.rampValues[0] = 20_000_000;
    state.rampRunning[0] = 0;
    expect(award(modes, state, 113)).toBe(20_000_000);
    expect(state.rampPaid[0], "the tail carries what was just paid").toBe(20_000_000);

    // It is the value at the moment of the AWARD and not the ramp's live value:
    // the countdown goes on falling and the copy does not follow it.
    state.rampValues[0] = 11_357_000;
    expect(state.rampPaid[0], "and does not follow the ramp down").toBe(20_000_000);
    expect(award(modes, state, 115)).toBe(11_357_000);
    expect(state.rampPaid[0], "until the next collect overwrites it").toBe(11_357_000);

    // Only effect 19 writes it. The ramp SERVICE moves +$04..$09 and never
    // +$22..$29 (0x634C's `lea $A(a1),a2` is the value slot's end, not the
    // tail's), so a hundred ticks of countdown leave the copy alone.
    state.rampRunning[0] = 1;
    for (let tick = 0; tick < 100; tick += 1) tickModes(modes, state);
    expect(state.rampValues[0], "the ramp has moved").not.toBe(11_357_000);
    expect(state.rampPaid[0], "the copy has not").toBe(11_357_000);

    // AND THE SHIPPED DOCUMENTS ASK FOR IT: seventeen live-value sites across
    // the three tables name `rampPaid`, and every one of them names a ramp the
    // table actually has. Law 'n Justice's are the six on its two ramps.
    let sites = 0;
    for (const tableId of TABLE_IDS) {
      const table = modesFor(tableId);
      for (const record of table.messages) {
        for (const value of record.values) {
          if (value.source !== "rampPaid") continue;
          sites += 1;
          expect(table.ramps[value.index], `${tableId} message ${record.index}`).toBeDefined();
        }
      }
    }
    expect(sites).toBe(17);
  });

  it("collects the hostage mission's own countdown, driven out of script 194", () => {
    // THE SHIPPED MISSION, END TO END. Script 194 is "SHOOT ALL TERRORISTS TO
    // FREE HOSTAGES", selector 0 entry 7 - a SELECTED mission, so it is a mode
    // a player picks - and its shape is the growing jackpot's: `RESTORE_POS 0`
    // (opcode 15, +0x005DDA: reload the start value and start the clock),
    // `START 113`, `WAIT 113`, then the same four more times for 114..117.
    // Each shot is collected at whatever the falling clock has reached.
    const modes = modesFor("law-n-justice");
    const mission = modes.scripts[194]!;
    // FIVE restarts for five hostages (113..117) and two stops. The sixth
    // `START 112` at pc184 is the mission's own finisher and gets no fresh
    // countdown, which is why the restarts are five and not six.
    expect(mission.ops.filter((op) => op.op === 15).map((op) => op.args[0])).toEqual([0, 0, 0, 0, 0]);
    expect(mission.ops.filter((op) => op.op === 16).map((op) => op.args[0])).toEqual([0, 0]);

    // Run the mission on the background ring, which executes one opcode a tick
    // and does not honour its WAITs, so the ramp falls only for the handful of
    // frames between the `RESTORE_POS` and the shot; a real mission gives it as
    // long as the player takes. Either way the payment is the LIVE value on the
    // awarding tick, which is what is under test.
    const state = createModeState(modes);
    state.armed[113] = 1;
    queueScript(state, 194);
    for (let i = 0; i < 40 && state.rampRunning[0] !== 1; i += 1) tickModes(modes, state);
    expect(state.rampRunning[0]).toBe(1);
    // Seeded at 20,000,000 and already one increment down: the ramp service is
    // the tail of the same tick the opcode ran on, exactly as +0x006334's slot
    // in the frame chain at +0x004B70 sits after the interpreters.
    expect(state.rampValues[0]).toBe(20_000_000 - 12_340);

    // Let the clock run a while, then take the shot through its own script.
    for (let i = 0; i < 200; i += 1) tickModes(modes, state);
    const live = state.rampValues[0]!;
    expect(live).toBeLessThan(20_000_000);
    expect(live).toBeGreaterThan(5_000_000);

    const paid = award(modes, state, 113);
    // The ramp is still falling while script 52 walks to its `AWARD 113`, so
    // the payment is the value on the awarding tick - below where the clock was
    // when the shot started and still above the floor. What matters is that it
    // is MILLIONS: this shot paid 0 before.
    expect(paid).toBeLessThanOrEqual(live);
    expect(paid).toBeGreaterThan(5_000_000);
    expect(paid).toBe(state.rampValues[0]);
  });

  it("pays Extreme Sports' rock climb and mission 166 too, where the port paid a token bonus", () => {
    // ES elements 53..56 are "TIME TO SCALE THE ROCK" on ramp 0 (20,000,000 ->
    // 5,000,000) and element 81 is mission 166's on ramp 8 (100,000,000 ->
    // 10,000,000). They ship score 0 with a 100,000 / 250,000 BONUS, which is
    // the consolation the port paid where the machine pays tens of millions.
    const modes = modesFor("extreme-sports");
    const climb = [53, 54, 55, 56].map((index) => modes.elements[index]!);
    expect(climb.every((one) => one.effect === 19 && one.rampCollect === 0)).toBe(true);
    expect(climb.every((one) => one.score === 0 && one.bonus === 100_000)).toBe(true);
    const mission166 = modes.elements[81]!;
    expect([mission166.effect, mission166.rampCollect, mission166.score, mission166.bonus]).toEqual([
      19, 8, 0, 250_000,
    ]);
    expect(modes.ramps[8]!.start).toBe(100_000_000);

    const state = createModeState(modes);
    state.rampValues[0] = 20_000_000;
    expect(award(modes, state, 53)).toBe(20_000_000);
    state.rampValues[8] = 100_000_000;
    expect(award(modes, state, 81)).toBe(100_000_000);
  });
});
