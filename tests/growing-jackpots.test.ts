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
